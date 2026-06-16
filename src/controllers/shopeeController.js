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
  convertMultiItemShopeeOrder,
  fetchItemList,
  fetchItemBaseInfo,
  fetchModelList,
} = require('../services/shopeeService');
const { recalculateOrdersForStore } = require('../services/recalculateService');
const { importProgress } = require('../lib/importProgress');

const { r2 } = require('../lib/utils');

const FRONTEND_URL = process.env.SHOPEE_FRONTEND_URL || 'https://profittrack.ecomzero.com.br';

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

  const periodMonth = dateFrom.substring(0, 7);
  const imp = await prisma.import.create({
    data: { storeId, filename: `shopee-sync-${periodMonth}`, periodMonth, totalRows: 0, status: 'processing' },
  });

  importProgress.set(imp.id, { pct: 2, message: 'Iniciando sincronização Shopee...' });

  // Disparar em background — sem await
  setImmediate(async () => {
  try {
    // 1. Listar order_sn do período
    importProgress.set(imp.id, { pct: 10, message: 'Buscando lista de pedidos...' });
    const orderSns = await fetchOrderList(accessToken, store.spShopId, dateFrom, dateTo);
    console.log(`[Shopee] ${orderSns.length} pedidos encontrados para ${periodMonth}`);

    if (orderSns.length === 0) {
      await prisma.import.update({ where: { id: imp.id }, data: { status: 'done', totalRows: 0 } });
      return;
    }

    // 2-3. Detalhes dos pedidos + repasses (escrow) em paralelo — get_escrow_detail
    // não depende dos detalhes do pedido, então buscamos para todos os order_sn e
    // descartamos UNPAID depois (Shopee não retorna escrow para eles de qualquer forma)
    importProgress.set(imp.id, { pct: 25, message: 'Buscando detalhes e repasses...' });
    const [details, escrowMapRaw] = await Promise.all([
      fetchOrderDetails(accessToken, store.spShopId, orderSns),
      fetchEscrowDetails(accessToken, store.spShopId, orderSns,
        (done, total) => importProgress.set(imp.id, { pct: 25 + Math.round((done / total) * 40), message: `Buscando repasses (${done}/${total})...` })),
    ]);
    const unpaidSns = new Set(details.filter(d => d.order_status === 'UNPAID').map(d => d.order_sn));
    const escrowMap = Object.fromEntries(Object.entries(escrowMapRaw).filter(([sn]) => !unpaidSns.has(sn)));

    // 4. Upsert produtos a partir dos itens dos pedidos
    importProgress.set(imp.id, { pct: 65, message: 'Vinculando produtos...' });
    // Cada anúncio (item_id) vira 1 único Product, com variações guardadas em `variations`
    const itemMap    = {}; // `${item_id}_${model_id}` → productId
    const variantMap = {}; // `${item_id}_${model_id}` → ProductVariant.id

    // Carrega 1x produtos com variations para fallback de matching legado (exibição)
    let withVariations = await prisma.product.findMany({
      where: { storeId, variations: { not: null } },
      select: { id: true, variations: true },
    });

    // Pré-carrega produtos/variantes em lote — evita 1 findFirst por chave única (item_id/model_id)
    const allExternalIds = [...new Set(details.flatMap(d => (d.item_list ?? []).map(it => String(it.item_id))))];
    const allRootSkus    = [...new Set(details.flatMap(d => (d.item_list ?? []).map(it => it.item_sku).filter(Boolean)))];
    const allModelSkus   = [...new Set(details.flatMap(d => (d.item_list ?? []).map(it => it.model_sku).filter(Boolean)))];

    const [productsByExternalId, productsBySku, variantsByModelSku] = await Promise.all([
      prisma.product.findMany({ where: { storeId, externalId: { in: allExternalIds } }, include: { productVariants: true } }),
      allRootSkus.length  ? prisma.product.findMany({ where: { storeId, sku: { in: allRootSkus } }, include: { productVariants: true } }) : Promise.resolve([]),
      allModelSkus.length ? prisma.productVariant.findMany({ where: { sku: { in: allModelSkus }, product: { storeId } }, include: { product: { include: { productVariants: true } } } }) : Promise.resolve([]),
    ]);

    const productMapByExternalId = new Map(productsByExternalId.map(p => [p.externalId, p]));
    const productMapBySku        = new Map(productsBySku.map(p => [p.sku, p]));
    const variantMapByModelSku   = new Map(variantsByModelSku.map(v => [v.sku, v]));

    for (const detail of details) {
      for (const item of detail.item_list ?? []) {
        const key = `${item.item_id}_${item.model_id ?? 0}`;
        if (itemMap[key]) continue;

        const externalId = String(item.item_id); // sempre o anúncio pai
        const rootSku    = item.item_sku || null;
        const modelId    = String(item.model_id ?? 0);
        const modelSku   = item.model_sku || null;

        let product = productMapByExternalId.get(externalId);

        if (!product && rootSku) {
          product = productMapBySku.get(rootSku);
        }
        if (!product && modelSku) {
          const variant = variantMapByModelSku.get(modelSku);
          if (variant) {
            product = variant.product;
            variantMap[key] = variant.id;
          }
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
          product.productVariants = [];
          withVariations.push({ id: product.id, variations: product.variations });
          productMapByExternalId.set(externalId, product);
        } else {
          const existingVariations = Array.isArray(product.variations) ? product.variations : [];
          if (!existingVariations.some(v => v.modelId === modelId)) {
            const merged = [...existingVariations, newVariation];
            await prisma.product.update({ where: { id: product.id }, data: { variations: merged } });
            product.variations = merged;
            const cached = withVariations.find(p => p.id === product.id);
            if (cached) cached.variations = merged; else withVariations.push({ id: product.id, variations: merged });
          }
        }
        itemMap[key] = product.id;

        // Resolve ProductVariant pelo model_id (se ainda não resolvido pelo fallback de SKU acima)
        if (!variantMap[key]) {
          const variant = (product.productVariants ?? []).find(v => v.marketplaceVariantId === modelId);
          if (variant) variantMap[key] = variant.id;
        }

        // Pedido referencia uma variação real (modelId != '0') mas ainda não
        // sincronizamos o catálogo de variações deste produto — busca agora
        // via get_model_list e cria os ProductVariant, para já habilitar
        // custo por variação a partir deste pedido.
        if (!variantMap[key] && modelId !== '0') {
          const existingCount = (product.productVariants ?? []).length;
          if (existingCount === 0) {
            const models = await fetchModelList(accessToken, store.spShopId, item.item_id);
            const createdVariants = [];
            for (const model of models) {
              const variant = await prisma.productVariant.create({
                data: {
                  productId: product.id,
                  marketplaceVariantId: String(model.model_id),
                  name: model.model_name,
                  sku: model.model_sku,
                  price: r2(model.price_info?.[0]?.current_price ?? 0),
                  stock: model.stock_info_v2?.summary_info?.total_available_stock ?? 0,
                },
              });
              createdVariants.push(variant);
              if (String(model.model_id) === modelId) variantMap[key] = variant.id;
            }
            product.productVariants = createdVariants;
          }
        }
      }
    }
    console.log(`[Shopee] ${Object.keys(itemMap).length} produtos vinculados/criados`);

    // 5. Converter pedidos — agrupa item_list por variação (variantId resolvido,
    //    com fallback para productId+model_id).
    //    1 grupo → 1 Order (lineItemKey="0", comportamento atual preservado).
    //    >1 grupo (pedido multi-anúncio ou multi-variação) → 1 Order por grupo,
    //    com taxas/escrow rateados proporcionalmente ao GMV de cada grupo.
    importProgress.set(imp.id, { pct: 80, message: 'Convertendo pedidos...' });
    const ordersData = details.flatMap(detail => {
      const items = detail.item_list ?? [];
      if (items.length === 0) return [];

      const groups = new Map();
      for (const it of items) {
        const key       = `${it.item_id}_${it.model_id ?? 0}`;
        const productId = itemMap[key] ?? null;
        const variantId = variantMap[key] ?? null;
        const modelId   = it.model_id ?? 0;
        const groupKey  = variantId
          ? `variant_${variantId}`
          : (productId ? `product_${productId}_${modelId}` : `__noproduct_${key}`);
        if (!groups.has(groupKey)) {
          groups.set(groupKey, { items: [], productId, variantId, modelId, firstItemId: it.item_id });
        }
        groups.get(groupKey).items.push(it);
      }
      const groupList = [...groups.values()];
      const escrow    = escrowMap[detail.order_sn];

      if (groupList.length === 1) {
        const g = groupList[0];
        return [convertShopeeOrder(detail, escrow, storeId, imp.id, store, g.productId, g.items, g.variantId, '0')];
      }
      return convertMultiItemShopeeOrder(detail, escrow, storeId, imp.id, store, groupList);
    });

    // 6. Salvar pedidos
    importProgress.set(imp.id, { pct: 85, message: 'Salvando pedidos...' });
    let saved = 0;
    for (const batch of chunkArr(ordersData, 200)) {
      const result = await prisma.order.createMany({ data: batch, skipDuplicates: true });
      saved += result.count;
    }

    // Aplica costPrice dos produtos vinculados nos pedidos recém-importados
    importProgress.set(imp.id, { pct: 95, message: 'Recalculando custos...' });
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
  } catch (err) {
    console.error('[Shopee] sync erro:', err.message);
    await prisma.import.update({
      where: { id: imp.id },
      data: { status: 'error', errorMessage: err.message },
    }).catch(() => {});
  } finally {
    importProgress.delete(imp.id);
  }
  });

  return res.status(202).json({ jobId: imp.id });
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

    // Pré-busca model_list real (get_item_base_info não retorna) em lotes de 10,
    // respeitando rate limit da Shopee
    const modelListMap = new Map(); // item_id → models[]
    for (let i = 0; i < details.length; i += 10) {
      const batch = details.slice(i, i + 10);
      const results = await Promise.all(batch.map(item =>
        item.has_model
          ? fetchModelList(accessToken, store.spShopId, item.item_id)
          : Promise.resolve([])
      ));
      batch.forEach((item, idx) => modelListMap.set(item.item_id, results[idx]));
    }

    let synced = 0, created = 0, updated = 0, migratedOrphans = 0;
    let needsRecalc = false;

    for (const item of details) {
      let models = modelListMap.get(item.item_id) ?? [];
      if (!models.length) {
        models = [{ model_id: 0, model_sku: null, model_name: null, price_info: item.price_info, stock_info_v2: item.stock_info_v2 }];
      }

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

      // Upsert ProductVariant para anúncios com variações reais (custo independente por variação)
      // Nunca sobrescreve costPrice — preserva o que o usuário cadastrou na tela.
      const hasRealVariations = variations.length >= 2 || (variations.length === 1 && variations[0].modelId !== '0');
      if (hasRealVariations) {
        for (const v of variations) {
          await prisma.productVariant.upsert({
            where: { productId_marketplaceVariantId: { productId: parent.id, marketplaceVariantId: v.modelId } },
            create: { productId: parent.id, marketplaceVariantId: v.modelId, name: v.name, sku: v.sku, price: v.price, stock: v.stock },
            update: { name: v.name, sku: v.sku, price: v.price, stock: v.stock },
          });
        }
      }

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
