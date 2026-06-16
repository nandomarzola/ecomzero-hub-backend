const prisma = require('../lib/prisma');
const {
  getAuthUrl, exchangeCode, refreshAccessToken,
  getShopInfo, fetchOrders, fetchOrderDetails, convertTTOrder,
} = require('../services/tiktokService');

const FRONTEND_URL = process.env.ML_FRONTEND_URL || 'http://localhost:5173';

function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// GET /api/tiktok/auth?storeId=xxx
async function getAuth(req, res) {
  const { storeId } = req.query;
  if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });
  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
  return res.json({ url: getAuthUrl(storeId) });
}

// GET /api/tiktok/callback?code=xxx&state=storeId
async function handleCallback(req, res) {
  const { code, state: storeId, errcode, errmsg } = req.query;
  if (errcode) return res.redirect(`${FRONTEND_URL}/integracoes?tt_error=${encodeURIComponent(errmsg ?? errcode)}`);
  if (!code || !storeId) return res.redirect(`${FRONTEND_URL}/integracoes?tt_error=missing_params`);

  try {
    const tokens = await exchangeCode(code);
    const shopInfo = await getShopInfo(tokens.access_token);
    const expiresAt = new Date(Date.now() + (tokens.expires_in * 1000));

    await prisma.store.updateMany({
      where: { id: storeId },
      data: {
        ttAccessToken:    tokens.access_token,
        ttRefreshToken:   tokens.refresh_token,
        ttShopId:         shopInfo?.shop_id ?? tokens.open_id,
        ttTokenExpiresAt: expiresAt,
      },
    });

    console.log(`[TikTok] Loja ${storeId} conectada — shop ${shopInfo?.shop_name ?? tokens.open_id}`);
    return res.redirect(`${FRONTEND_URL}/integracoes?tt_connected=1&store=${storeId}`);
  } catch (err) {
    console.error('[TikTok] callback erro:', err.message);
    return res.redirect(`${FRONTEND_URL}/integracoes?tt_error=${encodeURIComponent(err.message)}`);
  }
}

// GET /api/tiktok/status?storeId=xxx
async function getStatus(req, res) {
  const { storeId } = req.query;
  const store = await prisma.store.findFirst({
    where: { id: storeId, userId: req.userId },
    select: { id: true, ttAccessToken: true, ttShopId: true, ttTokenExpiresAt: true },
  });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
  return res.json({
    connected: !!store.ttAccessToken && !!store.ttShopId,
    shopId:    store.ttShopId,
    expired:   store.ttTokenExpiresAt ? new Date(store.ttTokenExpiresAt) < new Date() : false,
  });
}

// POST /api/tiktok/disconnect
async function disconnect(req, res) {
  const { storeId } = req.body;
  await prisma.store.updateMany({
    where: { id: storeId, userId: req.userId },
    data: { ttAccessToken: null, ttRefreshToken: null, ttShopId: null, ttTokenExpiresAt: null },
  });
  return res.json({ success: true });
}

// POST /api/tiktok/sync — importa pedidos TikTok Shop
async function syncOrders(req, res) {
  const { storeId, dateFrom, dateTo } = req.body;
  if (!storeId || !dateFrom || !dateTo) return res.status(400).json({ error: 'storeId, dateFrom e dateTo obrigatórios' });

  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store?.ttAccessToken) return res.status(400).json({ error: 'Loja não conectada ao TikTok Shop' });

  let accessToken = store.ttAccessToken;

  // Refresh se expirado
  if (store.ttTokenExpiresAt && new Date(store.ttTokenExpiresAt) < new Date()) {
    try {
      const newT = await refreshAccessToken(store.ttRefreshToken);
      accessToken = newT.access_token;
      await prisma.store.update({
        where: { id: storeId },
        data: {
          ttAccessToken:    newT.access_token,
          ttRefreshToken:   newT.refresh_token ?? store.ttRefreshToken,
          ttTokenExpiresAt: new Date(Date.now() + newT.expires_in * 1000),
        },
      });
    } catch { return res.status(401).json({ error: 'Token expirado — reconecte o TikTok Shop' }); }
  }

  try {
    const periodMonth = dateFrom.substring(0, 7);
    const imp = await prisma.import.create({
      data: { storeId, filename: `tiktok-sync-${periodMonth}`, periodMonth, totalRows: 0, status: 'processing' },
    });

    // 1. Buscar pedidos
    const ttOrders = await fetchOrders(accessToken, store.ttShopId, dateFrom, dateTo);
    console.log(`[TikTok] ${ttOrders.length} pedidos encontrados`);

    if (ttOrders.length === 0) {
      await prisma.import.update({ where: { id: imp.id }, data: { status: 'done', totalRows: 0 } });
      return res.json({ imported: 0, message: 'Nenhum pedido encontrado no período' });
    }

    // 2. Buscar detalhes (taxas reais)
    const orderIds    = ttOrders.map(o => o.id);
    const detailsMap  = await fetchOrderDetails(accessToken, store.ttShopId, orderIds);

    // 3. Upsert produtos dos itens dos pedidos
    // Pré-carrega produtos existentes para evitar N+1 (1 query no lugar de 1 por produto)
    const itemMap = {};
    const ttProductIds = [
      ...new Set(
        ttOrders.flatMap(o => {
          const detail = detailsMap[o.id];
          return (o.line_items ?? detail?.line_items ?? []).map(i => i.product_id).filter(Boolean);
        })
      ),
    ];
    const existingTtProducts = ttProductIds.length > 0
      ? await prisma.product.findMany({
          where: { storeId, externalId: { in: ttProductIds.map(String) } },
          select: { id: true, externalId: true },
        })
      : [];
    const existingTtMap = new Map(existingTtProducts.map(p => [p.externalId, p.id]));

    for (const order of ttOrders) {
      const detail = detailsMap[order.id];
      const items  = order.line_items ?? detail?.line_items ?? [];
      for (const item of items) {
        const productId = item.product_id;
        if (!productId || itemMap[productId]) continue;

        const existingId = existingTtMap.get(String(productId));
        if (existingId) {
          itemMap[productId] = existingId;
        } else {
          const created = await prisma.product.create({
            data: {
              storeId,
              externalId: String(productId),
              name:       item.product_name ?? 'Produto TikTok',
              sku:        item.seller_sku ?? null,
              listPrice:  parseFloat(item.sale_price ?? item.original_price ?? 0),
              costPrice:  0, packaging: 0, supplies: 0, stock: 0, minStock: 5,
            },
          });
          itemMap[productId] = created.id;
          existingTtMap.set(String(productId), created.id);
        }
      }
    }

    // 4. Converter e salvar pedidos
    const ordersData = ttOrders.map(o => {
      const detail    = detailsMap[o.id];
      const item      = o.line_items?.[0] ?? detail?.line_items?.[0] ?? {};
      const productId = item.product_id ? (itemMap[item.product_id] ?? null) : null;
      const converted = convertTTOrder(o, detail, storeId, imp.id, store);
      return { ...converted, productId };
    });

    let saved = 0;
    for (const batch of chunkArr(ordersData, 200)) {
      const r = await prisma.order.createMany({ data: batch, skipDuplicates: true });
      saved += r.count;
    }

    const valid     = ordersData.filter(o => o.orderCategory === 'valid').length;
    const pending   = ordersData.filter(o => o.orderCategory === 'pending').length;
    const cancelled = ordersData.filter(o => o.orderCategory.startsWith('cancelled')).length;
    const gmv       = ordersData.filter(o => ['valid','pending'].includes(o.orderCategory)).reduce((s,o) => s + o.calcGmv, 0);

    await prisma.import.update({
      where: { id: imp.id },
      data: { status: 'done', totalRows: ttOrders.length, validCount: valid, pendingCount: pending, cancelledCount: cancelled, gmv: Math.round(gmv*100)/100 },
    });

    return res.json({ imported: saved, total: ttOrders.length, valid, pending, cancelled, periodMonth });
  } catch (err) {
    console.error('[TikTok] sync erro:', err.message);
    return res.status(500).json({ error: 'Erro ao sincronizar: ' + err.message });
  }
}

module.exports = { getAuth, handleCallback, getStatus, disconnect, syncOrders };
