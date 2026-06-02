const prisma = require('../lib/prisma');
const { getAuthUrl, exchangeCode, refreshAccessToken, getSellerInfo, fetchOrders, convertMlOrder, fetchItemIds, fetchItemDetails, fetchItemFees } = require('../services/mlService');

const FRONTEND_URL = process.env.ML_FRONTEND_URL || 'http://localhost:5173';

function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// GET /api/ml/auth?storeId=xxx — gera URL de autorização
async function getAuth(req, res) {
  const { storeId } = req.query;
  if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });

  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  const url = getAuthUrl(storeId);
  return res.json({ url });
}

// GET /api/ml/callback?code=xxx&state=storeId — troca code por token
async function handleCallback(req, res) {
  const { code, state: storeId, error } = req.query;

  if (error) {
    return res.redirect(`${FRONTEND_URL}/settings?ml_error=${encodeURIComponent(error)}`);
  }
  if (!code || !storeId) {
    return res.redirect(`${FRONTEND_URL}/settings?ml_error=missing_params`);
  }

  try {
    const tokens = await exchangeCode(code);
    const seller = await getSellerInfo(tokens.access_token);

    const expiresAt = new Date(Date.now() + (tokens.expires_in * 1000));

    await prisma.store.updateMany({
      where: { id: storeId },
      data: {
        mlAccessToken:    tokens.access_token,
        mlRefreshToken:   tokens.refresh_token,
        mlSellerId:       String(seller.id),
        mlTokenExpiresAt: expiresAt,
      },
    });

    console.log(`[ML] Loja ${storeId} conectada — seller ${seller.nickname} (${seller.id})`);
    return res.redirect(`${FRONTEND_URL}/settings?ml_connected=1&store=${storeId}`);
  } catch (err) {
    console.error('[ML] callback erro:', err.message);
    return res.redirect(`${FRONTEND_URL}/settings?ml_error=${encodeURIComponent(err.message)}`);
  }
}

// GET /api/ml/status?storeId=xxx — verifica se loja está conectada
async function getStatus(req, res) {
  const { storeId } = req.query;
  const store = await prisma.store.findFirst({
    where: { id: storeId, userId: req.userId },
    select: { id: true, mlSellerId: true, mlAccessToken: true, mlTokenExpiresAt: true },
  });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  const connected = !!store.mlAccessToken && !!store.mlSellerId;
  const expired   = store.mlTokenExpiresAt ? new Date(store.mlTokenExpiresAt) < new Date() : false;

  return res.json({ connected, expired, sellerId: store.mlSellerId });
}

// POST /api/ml/disconnect?storeId=xxx — desconectar
async function disconnect(req, res) {
  const { storeId } = req.body;
  await prisma.store.updateMany({
    where: { id: storeId, userId: req.userId },
    data: { mlAccessToken: null, mlRefreshToken: null, mlSellerId: null, mlTokenExpiresAt: null },
  });
  return res.json({ success: true });
}

// POST /api/ml/sync — importa pedidos do ML para o período
async function syncOrders(req, res) {
  const { storeId, dateFrom, dateTo } = req.body;
  if (!storeId || !dateFrom || !dateTo) return res.status(400).json({ error: 'storeId, dateFrom e dateTo são obrigatórios' });

  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
  if (!store.mlAccessToken) return res.status(400).json({ error: 'Loja não conectada ao Mercado Livre' });

  let accessToken = store.mlAccessToken;

  // Refresh token se expirado
  if (store.mlTokenExpiresAt && new Date(store.mlTokenExpiresAt) < new Date()) {
    try {
      const newTokens = await refreshAccessToken(store.mlRefreshToken);
      accessToken = newTokens.access_token;
      await prisma.store.update({
        where: { id: storeId },
        data: {
          mlAccessToken:    newTokens.access_token,
          mlRefreshToken:   newTokens.refresh_token ?? store.mlRefreshToken,
          mlTokenExpiresAt: new Date(Date.now() + (newTokens.expires_in * 1000)),
        },
      });
    } catch (err) {
      return res.status(401).json({ error: 'Token expirado — reconecte o Mercado Livre' });
    }
  }

  try {
    // Criar registro de import
    const periodMonth = dateFrom.substring(0, 7);
    const imp = await prisma.import.create({
      data: { storeId, filename: `ml-sync-${periodMonth}`, periodMonth, totalRows: 0, status: 'processing' },
    });

    // Buscar pedidos na API ML
    const mlOrders = await fetchOrders(accessToken, store.mlSellerId, dateFrom, dateTo);
    console.log(`[ML] ${mlOrders.length} pedidos encontrados para ${periodMonth}`);

    if (mlOrders.length === 0) {
      await prisma.import.update({ where: { id: imp.id }, data: { status: 'done', totalRows: 0 } });
      return res.json({ imported: 0, message: 'Nenhum pedido encontrado no período' });
    }

    // Converter e salvar
    const ordersData = mlOrders.map(o => convertMlOrder(o, storeId, imp.id, store));

    let saved = 0;
    for (const batch of chunkArr(ordersData, 200)) {
      const result = await prisma.order.createMany({ data: batch, skipDuplicates: true });
      saved += result.count;
    }

    // Vincular pedidos a produtos por SKU
    await prisma.$executeRaw`
      UPDATE \`Order\` o
      INNER JOIN Product p
        ON p.storeId = o.storeId
        AND p.sku IS NOT NULL
        AND p.sku = o.skuVariacao
      SET o.productId = p.id
      WHERE o.importId = ${imp.id} AND o.productId IS NULL
    `;

    // Totais para o Import record
    const valid     = ordersData.filter(o => o.orderCategory === 'valid').length;
    const pending   = ordersData.filter(o => o.orderCategory === 'pending').length;
    const cancelled = ordersData.filter(o => o.orderCategory.startsWith('cancelled')).length;
    const gmv       = ordersData.filter(o => ['valid','pending'].includes(o.orderCategory)).reduce((s, o) => s + o.calcGmv, 0);

    await prisma.import.update({
      where: { id: imp.id },
      data: {
        status: 'done',
        totalRows: mlOrders.length,
        validCount: valid,
        pendingCount: pending,
        cancelledCount: cancelled,
        gmv: Math.round(gmv * 100) / 100,
      },
    });

    return res.json({ imported: saved, total: mlOrders.length, valid, pending, cancelled, periodMonth });
  } catch (err) {
    console.error('[ML] sync erro:', err.message);
    return res.status(500).json({ error: 'Erro ao sincronizar pedidos: ' + err.message });
  }
}

// POST /api/ml/sync-items — sincroniza anúncios ML → Products
async function syncItems(req, res) {
  const { storeId } = req.body;
  if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });

  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store?.mlAccessToken) return res.status(400).json({ error: 'Loja não conectada ao Mercado Livre' });

  let accessToken = store.mlAccessToken;

  // Refresh se necessário
  if (store.mlTokenExpiresAt && new Date(store.mlTokenExpiresAt) < new Date()) {
    try {
      const { refreshAccessToken } = require('../services/mlService');
      const newT = await refreshAccessToken(store.mlRefreshToken);
      accessToken = newT.access_token;
      await prisma.store.update({ where: { id: storeId }, data: { mlAccessToken: newT.access_token, mlRefreshToken: newT.refresh_token ?? store.mlRefreshToken, mlTokenExpiresAt: new Date(Date.now() + newT.expires_in * 1000) } });
    } catch { return res.status(401).json({ error: 'Token expirado — reconecte o ML' }); }
  }

  try {
    // 1. Buscar todos os IDs de anúncios ativos
    const itemIds = await fetchItemIds(accessToken, store.mlSellerId);
    if (!itemIds.length) return res.json({ synced: 0, message: 'Nenhum anúncio ativo encontrado' });

    // 2. Detalhes em lotes de 20
    const items = await fetchItemDetails(accessToken, itemIds);

    // 3. Taxas reais por item
    const feesMap = await fetchItemFees(accessToken, itemIds);

    let synced = 0;
    let created = 0;
    let updated = 0;

    for (const item of items) {
      if (!item?.id) continue;

      const fees        = feesMap[item.id] ?? {};
      const listingType = item.listing_type_id ?? null;
      const feeRate     = fees.saleFeeRate ?? null;
      const mlStatus    = item.status ?? null;
      const skuFromAttr = item.attributes?.find(a => a.id === 'SELLER_SKU')?.value_name ?? null;
      const sku = item.seller_sku ?? item.seller_custom_field ?? skuFromAttr ?? null;

      const data = {
        storeId,
        externalId:    item.id,
        mlListingType: listingType,
        mlFeeRate:     feeRate,
        mlStatus,
        name:          item.title ?? 'Sem título',
        sku:           sku,
        listPrice:     item.price ?? 0,
        stock:         item.available_quantity ?? 0,
      };

      const existing = await prisma.product.findFirst({ where: { storeId, externalId: item.id } });

      if (existing) {
        await prisma.product.update({
          where: { id: existing.id },
          data: { mlListingType: data.mlListingType, mlFeeRate: data.mlFeeRate, mlStatus, listPrice: data.listPrice, stock: data.stock, name: data.name, sku: data.sku ?? existing.sku },
        });
        updated++;
      } else {
        await prisma.product.create({ data: { ...data, costPrice: 0, packaging: 0, supplies: 0, minStock: 5 } });
        created++;
      }
      synced++;
    }

    // Contagem por status
    const statusCount = {};
    for (const item of items) {
      const s = item?.status ?? 'unknown';
      statusCount[s] = (statusCount[s] || 0) + 1;
    }

    return res.json({ synced, created, updated, total: itemIds.length, byStatus: statusCount });
  } catch (err) {
    console.error('[ML] sync-items erro:', err.message);
    return res.status(500).json({ error: 'Erro ao sincronizar anúncios: ' + err.message });
  }
}

module.exports = { getAuth, handleCallback, getStatus, disconnect, syncOrders, syncItems };
