const prisma = require('../lib/prisma');
const { recalculateQueue } = require('../services/recalculateQueue');

// Extrai o "listing ID" do Shopee do SKU (ex: SHOPEE-22394219146-229424811441 → 22394219146)
function extractShopeeListingId(sku) {
  if (!sku) return null;
  const match = sku.match(/^SHOPEE-(\d+)/i);
  return match ? match[1] : null;
}

// Similaridade simples entre dois strings (bi-gram overlap, 0-1)
function similarity(a, b) {
  if (!a || !b) return 0;
  const s1 = a.toLowerCase();
  const s2 = b.toLowerCase();
  if (s1 === s2) return 1;
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const bg1 = bigrams(s1);
  const bg2 = bigrams(s2);
  let inter = 0;
  bg1.forEach((g) => { if (bg2.has(g)) inter++; });
  return (2 * inter) / (bg1.size + bg2.size);
}

// GET /api/product-aliases/suggest?storeId=&sku=&name=
async function suggestProducts(req, res) {
  try {
    const { sku, name } = req.query;
    const userId = req.userId;

    const products = await prisma.product.findMany({
      where:  { store: { userId }, parentId: null },
      select: { id: true, name: true, sku: true, costPrice: true, packaging: true, variants: { select: { id: true, name: true, sku: true, costPrice: true, packaging: true } } },
    });

    // Score each product
    const listingId = extractShopeeListingId(sku);
    const scored = [];

    for (const p of products) {
      let score = 0;

      // Match by Shopee listing ID in SKU
      if (listingId && p.sku) {
        const pListingId = extractShopeeListingId(p.sku);
        if (pListingId === listingId) score += 0.9;
      }
      // Match by variant SKU
      for (const v of (p.variants ?? [])) {
        if (listingId && v.sku) {
          const vListingId = extractShopeeListingId(v.sku);
          if (vListingId === listingId) { score = Math.max(score, 0.95); break; }
        }
      }

      // Name similarity (ignoring variation suffix)
      const productBaseName = p.name.split(' — ')[0];
      const orphanBaseName  = (name ?? '').split(' — ')[0];
      const nameSim = similarity(productBaseName, orphanBaseName);
      score = Math.max(score, nameSim);

      if (score >= 0.3) {
        scored.push({ score, product: p });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    res.json({
      suggestions: scored.slice(0, 5).map(({ score, product: p }) => ({
        id:        p.id,
        name:      p.name,
        sku:       p.sku,
        costPrice: p.costPrice,
        packaging: p.packaging,
        score:     parseFloat(score.toFixed(2)),
        variants:  p.variants,
      })),
    });
  } catch (err) {
    console.error('[productAliasController] suggestProducts:', err.message);
    res.status(500).json({ error: err.message });
  }
}

// POST /api/product-aliases/resolve
// body: { orderIds[], productSku?, rawName?, action: 'link'|'create', existingProductId?, costPrice?, packaging? }
async function resolveOrphan(req, res) {
  try {
    const userId = req.userId;
    const { orderIds, productSku, rawName, action, existingProductId, costPrice, packaging } = req.body;

    if (!orderIds?.length && !productSku && !rawName) {
      return res.status(400).json({ error: 'orderIds, productSku ou rawName obrigatório' });
    }

    // Verifica que a loja pertence ao usuário
    const store = await prisma.store.findFirst({ where: { userId }, select: { id: true } });
    if (!store) return res.status(403).json({ error: 'Loja não encontrada' });

    let targetProduct;

    if (action === 'link') {
      if (!existingProductId) return res.status(400).json({ error: 'existingProductId obrigatório para link' });
      targetProduct = await prisma.product.findFirst({
        where:  { id: existingProductId, store: { userId } },
        select: { id: true, name: true, costPrice: true, packaging: true, supplies: true },
      });
      if (!targetProduct) return res.status(404).json({ error: 'Produto não encontrado' });

    } else if (action === 'create') {
      const cp = parseFloat(costPrice ?? 0);
      const pk = parseFloat(packaging ?? 0);
      const productName = rawName ?? productSku ?? 'Produto sem nome';

      targetProduct = await prisma.product.create({
        data: {
          storeId:   store.id,
          name:      productName,
          sku:       productSku ?? null,
          costPrice: cp,
          packaging: pk,
          supplies:  0,
          stock:     0,
          minStock:  5,
        },
      });
    } else {
      return res.status(400).json({ error: 'action deve ser "link" ou "create"' });
    }

    // Cria o alias pelo SKU (para reconhecimento automático em futuras importações)
    if (productSku) {
      await prisma.productAlias.upsert({
        where:  { storeId_rawSku: { storeId: store.id, rawSku: productSku } },
        create: { storeId: store.id, rawSku: productSku, rawName: rawName ?? null, productId: targetProduct.id, source: 'manual' },
        update: { productId: targetProduct.id },
      });
    }

    // Atualiza OrderItems usando orderIds fornecidos pelo frontend (mais confiável que filtrar por nome/sku)
    let itemWhere;
    if (orderIds?.length) {
      // Garante que os pedidos pertencem à loja do usuário
      const validOrders = await prisma.order.findMany({
        where: { id: { in: orderIds }, storeId: store.id },
        select: { id: true },
      });
      const validIds = validOrders.map((o) => o.id);
      itemWhere = { orderId: { in: validIds }, productId: null };
    } else if (productSku) {
      itemWhere = { order: { storeId: store.id, productSku }, productId: null };
    } else {
      itemWhere = { order: { storeId: store.id, productNameRaw: rawName }, productId: null };
    }

    const updated = await prisma.orderItem.updateMany({
      where: itemWhere,
      data:  {
        productId:         targetProduct.id,
        snapshotCostPrice: targetProduct.costPrice,
        snapshotPackaging: targetProduct.packaging ?? 0,
        snapshotSupplies:  targetProduct.supplies  ?? 0,
      },
    });

    // Dispara recalculate e retorna jobId para polling
    const jobId = `recalc-alias-${userId}-${Date.now()}`;
    await recalculateQueue.add('recalculate', { userId, all: true }, { jobId });

    res.json({ ok: true, productId: targetProduct.id, productName: targetProduct.name, jobId, updatedItems: updated.count });
  } catch (err) {
    console.error('[productAliasController] resolveOrphan:', err.message);
    res.status(500).json({ error: err.message });
  }
}

module.exports = { suggestProducts, resolveOrphan };
