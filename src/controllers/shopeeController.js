const prisma = require('../lib/prisma');
const {
  isConfigured,
  getAuthUrl,
  exchangeToken,
  refreshShopeeToken,
  getShopInfo,
} = require('../services/shopeeAuthService');
const {
  fetchOrderList,
  fetchOrderDetails,
  fetchEscrowDetails,
  convertShopeeOrder,
  fetchItemList,
  fetchItemBaseInfo,
} = require('../services/shopeeService');
const { recalculateOrdersForStore } = require('../services/recalculateService');

const FRONTEND_URL = process.env.SHOPEE_FRONTEND_URL || 'https://profittrack.ecomzero.com.br';

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Garante access_token válido — renova se expirado, atualiza loja
async function ensureFreshToken(store) {
  if (!store.spTokenExpiresAt || new Date(store.spTokenExpiresAt) >= new Date()) {
    return store.spAccessToken;
  }
  const newT = await refreshShopeeToken(store.spRefreshToken, store.spShopId);
  await prisma.store.update({
    where: { id: store.id },
    data: {
      spAccessToken:    newT.access_token,
      spRefreshToken:   newT.refresh_token ?? store.spRefreshToken,
      spTokenExpiresAt: new Date(Date.now() + ((newT.expire_in ?? 14400) * 1000)),
    },
  });
  return newT.access_token;
}

// GET /api/shopee/auth?storeId=xxx — gera URL de autorização Shopee
async function getAuth(req, res) {
  const { storeId } = req.query;
  if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });

  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  if (!isConfigured()) {
    return res.status(503).json({ error: 'Integração Shopee ainda não configurada — aguardando aprovação do Partner ID' });
  }

  const url = getAuthUrl(storeId);
  return res.json({ url });
}

// GET /api/shopee/callback?code=xxx&shop_id=xxx&storeId=xxx
// Endpoint público — chamado pelo redirect da Shopee
async function handleCallback(req, res) {
  const { code, shop_id, storeId, error: spError } = req.query;

  if (spError) {
    return res.redirect(`${FRONTEND_URL}/integracoes?sp_error=${encodeURIComponent(spError)}`);
  }
  if (!code || !shop_id) {
    return res.redirect(`${FRONTEND_URL}/integracoes?sp_error=missing_params`);
  }

  try {
    // Trocar code por tokens
    const tokens = await exchangeToken(code, shop_id);
    const expiresAt = new Date(Date.now() + ((tokens.expire_in ?? 14400) * 1000));

    // Tentar buscar nome da loja
    let shopName = null;
    try {
      const info = await getShopInfo(tokens.access_token, shop_id);
      shopName = info?.shop_name ?? info?.name ?? null;
    } catch {}

    // Se storeId foi passado via redirect, usa ele; senão tenta pelo spShopId existente
    let targetStoreId = storeId ?? null;
    if (!targetStoreId) {
      const existing = await prisma.store.findFirst({
        where: { spShopId: String(shop_id) },
        select: { id: true },
      });
      targetStoreId = existing?.id ?? null;
    }

    if (targetStoreId) {
      await prisma.store.update({
        where: { id: targetStoreId },
        data: {
          spAccessToken:    tokens.access_token,
          spRefreshToken:   tokens.refresh_token,
          spShopId:         String(shop_id),
          spShopName:       shopName,
          spTokenExpiresAt: expiresAt,
        },
      });
      console.log(`[Shopee] Loja ${targetStoreId} conectada — shop_id ${shop_id} (${shopName ?? 'sem nome'})`);
      return res.redirect(`${FRONTEND_URL}/integracoes?sp_connected=1&store=${targetStoreId}`);
    }

    // Sem storeId: loja não identificada — salva shop_id em qualquer loja Shopee sem conexão
    const unlinked = await prisma.store.findFirst({
      where: { marketplace: 'shopee', spShopId: null },
      orderBy: { createdAt: 'asc' },
    });
    if (unlinked) {
      await prisma.store.update({
        where: { id: unlinked.id },
        data: {
          spAccessToken:    tokens.access_token,
          spRefreshToken:   tokens.refresh_token,
          spShopId:         String(shop_id),
          spShopName:       shopName,
          spTokenExpiresAt: expiresAt,
        },
      });
      return res.redirect(`${FRONTEND_URL}/integracoes?sp_connected=1&store=${unlinked.id}`);
    }

    return res.redirect(`${FRONTEND_URL}/integracoes?sp_error=loja_nao_encontrada`);
  } catch (err) {
    console.error('[Shopee] callback erro:', err.message);
    return res.redirect(`${FRONTEND_URL}/integracoes?sp_error=${encodeURIComponent(err.message)}`);
  }
}

// GET /api/shopee/status?storeId=xxx
async function getStatus(req, res) {
  const { storeId } = req.query;
  const store = await prisma.store.findFirst({
    where: { id: storeId, userId: req.userId },
    select: { id: true, spAccessToken: true, spShopId: true, spShopName: true, spTokenExpiresAt: true },
  });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  const connected  = !!store.spAccessToken && !!store.spShopId;
  const expired    = store.spTokenExpiresAt ? new Date(store.spTokenExpiresAt) < new Date() : false;
  const configured = isConfigured();

  return res.json({
    connected,
    expired,
    configured,
    shopId:   store.spShopId,
    shopName: store.spShopName,
  });
}

// POST /api/shopee/disconnect
async function disconnect(req, res) {
  const { storeId } = req.body;
  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  await prisma.store.update({
    where: { id: storeId },
    data: { spAccessToken: null, spRefreshToken: null, spShopId: null, spShopName: null, spTokenExpiresAt: null },
  });
  return res.json({ success: true });
}

// POST /api/shopee/refresh-token
async function refreshToken(req, res) {
  const { storeId } = req.body;
  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store?.spRefreshToken) return res.status(400).json({ error: 'Token não disponível — reconecte a loja' });

  try {
    const tokens    = await refreshShopeeToken(store.spRefreshToken, store.spShopId);
    const expiresAt = new Date(Date.now() + ((tokens.expire_in ?? 14400) * 1000));
    await prisma.store.update({
      where: { id: storeId },
      data: {
        spAccessToken:    tokens.access_token,
        spRefreshToken:   tokens.refresh_token ?? store.spRefreshToken,
        spTokenExpiresAt: expiresAt,
      },
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao renovar token: ' + err.message });
  }
}

// POST /api/shopee/sync — importa pedidos da Shopee via API para o período
async function syncOrders(req, res) {
  const { storeId, dateFrom, dateTo } = req.body;
  if (!storeId || !dateFrom || !dateTo) return res.status(400).json({ error: 'storeId, dateFrom e dateTo são obrigatórios' });

  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
  if (!store.spAccessToken || !store.spShopId) return res.status(400).json({ error: 'Loja não conectada à Shopee' });

  let accessToken;
  try {
    accessToken = await ensureFreshToken(store);
  } catch {
    return res.status(401).json({ error: 'Token expirado — reconecte a Shopee' });
  }

  try {
    const periodMonth = dateFrom.substring(0, 7);
    const imp = await prisma.import.create({
      data: { storeId, filename: `shopee-sync-${periodMonth}`, periodMonth, totalRows: 0, status: 'processing' },
    });

    // 1. Listar order_sn do período
    const orderSns = await fetchOrderList(accessToken, store.spShopId, dateFrom, dateTo);
    console.log(`[Shopee] ${orderSns.length} pedidos encontrados para ${periodMonth}`);

    if (orderSns.length === 0) {
      await prisma.import.update({ where: { id: imp.id }, data: { status: 'done', totalRows: 0 } });
      return res.json({ imported: 0, message: 'Nenhum pedido encontrado no período' });
    }

    // 2. Detalhes dos pedidos
    const details = await fetchOrderDetails(accessToken, store.spShopId, orderSns);

    // 3. Repasse (escrow) — só para pedidos pagos/processados (UNPAID não tem escrow)
    const escrowEligible = details.filter(d => d.order_status !== 'UNPAID').map(d => d.order_sn);
    const escrowMap = await fetchEscrowDetails(accessToken, store.spShopId, escrowEligible);

    // 4. Upsert produtos a partir dos itens dos pedidos
    // Cada anúncio (item_id) vira 1 único Product, com variações guardadas em `variations`
    const itemMap = {}; // `${item_id}_${model_id}` → productId

    // Carrega 1x produtos com variations para fallback de matching por model_sku
    let withVariations = await prisma.product.findMany({
      where: { storeId, variations: { not: null } },
      select: { id: true, variations: true },
    });

    for (const detail of details) {
      for (const item of detail.item_list ?? []) {
        const key = `${item.item_id}_${item.model_id ?? 0}`;
        if (itemMap[key]) continue;

        const externalId = String(item.item_id); // sempre o anúncio pai
        const rootSku    = item.item_sku || null;
        const modelId    = String(item.model_id ?? 0);
        const modelSku   = item.model_sku || null;

        let product = await prisma.product.findFirst({ where: { storeId, externalId } });

        if (!product && rootSku) {
          product = await prisma.product.findFirst({ where: { storeId, sku: rootSku } });
        }
        if (!product && modelSku) {
          const match = withVariations.find(p =>
            Array.isArray(p.variations) && p.variations.some(v => v.sku === modelSku)
          );
          if (match) product = await prisma.product.findUnique({ where: { id: match.id } });
        }

        const newVariation = {
          modelId, sku: modelSku, name: item.model_name || null,
          price: r2(item.model_discounted_price ?? item.model_original_price ?? 0),
          stock: 0,
        };

        if (!product) {
          product = await prisma.product.create({
            data: {
              storeId,
              externalId,
              name:      item.item_name || 'Produto Shopee',
              sku:       rootSku,
              listPrice: newVariation.price,
              variations: [newVariation],
              costPrice: 0, packaging: 0, supplies: 0, stock: 0, minStock: 5,
            },
          });
          withVariations.push({ id: product.id, variations: product.variations });
        } else {
          const existingVariations = Array.isArray(product.variations) ? product.variations : [];
          if (!existingVariations.some(v => v.modelId === modelId)) {
            const merged = [...existingVariations, newVariation];
            await prisma.product.update({ where: { id: product.id }, data: { variations: merged } });
            const cached = withVariations.find(p => p.id === product.id);
            if (cached) cached.variations = merged; else withVariations.push({ id: product.id, variations: merged });
          }
        }
        itemMap[key] = product.id;
      }
    }
    console.log(`[Shopee] ${Object.keys(itemMap).length} produtos vinculados/criados`);

    // 5. Converter pedidos
    const ordersData = details.map(detail => {
      const item     = detail.item_list?.[0];
      const key       = item ? `${item.item_id}_${item.model_id ?? 0}` : null;
      const productId = key ? (itemMap[key] ?? null) : null;
      return convertShopeeOrder(detail, escrowMap[detail.order_sn], storeId, imp.id, store, productId);
    });

    // 6. Salvar pedidos
    let saved = 0;
    for (const batch of chunkArr(ordersData, 200)) {
      const result = await prisma.order.createMany({ data: batch, skipDuplicates: true });
      saved += result.count;
    }

    // Aplica costPrice dos produtos vinculados nos pedidos recém-importados
    await recalculateOrdersForStore(storeId, periodMonth).catch(() => {});

    // 7. Totais
    const valid     = ordersData.filter(o => o.orderCategory === 'valid').length;
    const pending   = ordersData.filter(o => o.orderCategory === 'pending').length;
    const cancelled = ordersData.filter(o => o.orderCategory.startsWith('cancelled')).length;
    const linked    = ordersData.filter(o => o.productId !== null).length;
    const gmv       = ordersData.filter(o => ['valid','pending'].includes(o.orderCategory)).reduce((s,o) => s + o.calcGmv, 0);

    await prisma.import.update({
      where: { id: imp.id },
      data: { status: 'done', totalRows: details.length, validCount: valid, pendingCount: pending, cancelledCount: cancelled, gmv: r2(gmv) },
    });

    console.log(`[Shopee] ${saved} pedidos salvos, ${linked} vinculados a produtos`);
    return res.json({ imported: saved, total: details.length, valid, pending, cancelled, linked, products: Object.keys(itemMap).length, periodMonth });
  } catch (err) {
    console.error('[Shopee] sync erro:', err.message);
    return res.status(500).json({ error: 'Erro ao sincronizar pedidos: ' + err.message });
  }
}

// POST /api/shopee/sync-items — sincroniza catálogo de produtos Shopee → Products
async function syncItems(req, res) {
  const { storeId } = req.body;
  if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });

  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
  if (!store.spAccessToken || !store.spShopId) return res.status(400).json({ error: 'Loja não conectada à Shopee' });

  let accessToken;
  try {
    accessToken = await ensureFreshToken(store);
  } catch {
    return res.status(401).json({ error: 'Token expirado — reconecte a Shopee' });
  }

  try {
    // 1. Listar item_ids do catálogo
    const items = await fetchItemList(accessToken, store.spShopId);
    if (!items.length) return res.json({ synced: 0, message: 'Nenhum produto encontrado' });

    // 2. Detalhes (preço, estoque, variações)
    const itemIds = items.map(i => i.item_id);
    const details = await fetchItemBaseInfo(accessToken, store.spShopId, itemIds);

    let synced = 0, created = 0, updated = 0, migratedOrphans = 0;
    let needsRecalc = false;

    for (const item of details) {
      const models = item.model_list?.length
        ? item.model_list
        : [{ model_id: 0, model_sku: null, model_name: null, price_info: item.price_info, stock_info_v2: item.stock_info_v2 }];

      // Variações do anúncio, guardadas como metadado para matching/exibição
      const variations = models.map(model => ({
        modelId: String(model.model_id ?? 0),
        sku:     model.model_sku || null,
        name:    model.model_name || null,
        price:   r2(model.price_info?.[0]?.current_price ?? item.price_info?.[0]?.current_price ?? 0),
        stock:   model.stock_info_v2?.summary_info?.total_available_stock
                 ?? item.stock_info_v2?.summary_info?.total_available_stock ?? 0,
      }));

      const externalId = String(item.item_id);
      const sku        = item.item_sku || null;
      const name       = item.item_name || 'Produto Shopee';
      const prices     = variations.map(v => v.price).filter(p => p > 0);
      const listPrice  = prices.length ? Math.min(...prices) : 0;
      const stock      = variations.reduce((s, v) => s + (v.stock || 0), 0);

      const existing = await prisma.product.findFirst({ where: { storeId, externalId } });
      let parent;
      if (existing) {
        parent = await prisma.product.update({
          where: { id: existing.id },
          data: { name, sku: sku ?? existing.sku, listPrice, stock, variations, mlStatus: item.item_status ?? null },
        });
        updated++;
      } else {
        parent = await prisma.product.create({
          data: { storeId, externalId, name, sku, listPrice, stock, variations,
                  costPrice: 0, packaging: 0, supplies: 0, minStock: 5, mlStatus: item.item_status ?? null },
        });
        created++;
      }
      synced++;

      // Migração de órfãos da versão antiga (1 produto por model_id)
      for (const model of models) {
        const orphanExternalId = String(model.model_id || item.item_id);
        if (orphanExternalId === externalId) continue;

        const orphan = await prisma.product.findFirst({ where: { storeId, externalId: orphanExternalId } });
        if (!orphan || orphan.id === parent.id) continue;

        const moved = await prisma.order.updateMany({ where: { productId: orphan.id }, data: { productId: parent.id } });
        await prisma.purchaseOrderItem.updateMany({ where: { productId: orphan.id }, data: { productId: parent.id } });

        if ((orphan.costPrice ?? 0) > 0 && (parent.costPrice ?? 0) === 0) {
          parent = await prisma.product.update({
            where: { id: parent.id },
            data: { costPrice: orphan.costPrice, packaging: orphan.packaging ?? 0, supplies: orphan.supplies ?? 0 },
          });
        }

        console.log(`[Shopee] Migrando órfão ${orphan.id} (${orphan.name}, sku=${orphan.sku}, cost=${orphan.costPrice}) → pai ${parent.id}`);
        await prisma.product.delete({ where: { id: orphan.id } });
        migratedOrphans++;
        if (moved.count > 0) needsRecalc = true;
      }
    }

    if (needsRecalc) {
      await recalculateOrdersForStore(storeId).catch(err => console.error('[Shopee] recalc pós-migração erro:', err.message));
    }

    return res.json({ synced, created, updated, total: itemIds.length, migratedOrphans });
  } catch (err) {
    console.error('[Shopee] sync-items erro:', err.message);
    return res.status(500).json({ error: 'Erro ao sincronizar produtos: ' + err.message });
  }
}

module.exports = { getAuth, handleCallback, getStatus, disconnect, refreshToken, syncOrders, syncItems };
