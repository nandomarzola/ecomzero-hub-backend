const { z } = require('zod');
const prisma = require('../lib/prisma');

const productSchema = z.object({
  storeId:    z.string().uuid('storeId inválido'),
  name:       z.string().min(1, 'Nome obrigatório'),
  externalId: z.string().nullish(),
  sku:        z.string().nullish(),
  barcode:    z.string().nullish(),
  costPrice:  z.number().min(0, 'Custo deve ser positivo'),
  listPrice:  z.number().min(0).optional(),
  packaging:  z.number().min(0).optional(),
  supplies:   z.number().min(0).optional(),
  stock:      z.number().int().min(0).optional(),
  minStock:   z.number().int().min(0).optional(),
});

const variantSchema = z.object({
  name:      z.string().min(1, 'Nome da variação obrigatório'),
  sku:       z.string().nullish(),
  barcode:   z.string().nullish(),
  costPrice: z.number().min(0).optional(),
  listPrice: z.number().min(0).optional(),
  packaging: z.number().min(0).optional(),
  supplies:  z.number().min(0).optional(),
  stock:     z.number().int().min(0).optional(),
  minStock:  z.number().int().min(0).optional(),
});

async function verifyStoreOwnership(storeId, userId) {
  return prisma.store.findFirst({ where: { id: storeId, userId } });
}

function withAlerts(p) {
  return {
    ...p,
    lowStock: p.stock <= p.minStock,
    variants: p.variants?.map((v) => ({ ...v, lowStock: v.stock <= v.minStock })) ?? [],
  };
}

// GET /api/products — produtos raiz com paginação e busca
async function list(req, res) {
  const { storeId, search, page = 1, limit = 20 } = req.query;

  const where = {
    parentId: null,
    ...(storeId ? { storeId, store: { userId: req.userId } } : { store: { userId: req.userId } }),
    ...(search ? { OR: [
      { name: { contains: search } },
      { sku:  { contains: search } },
    ]} : {}),
  };

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        store:    { select: { name: true, marketplace: true } },
        variants: { orderBy: { name: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.product.count({ where }),
  ]);

  return res.json({ products: products.map(withAlerts), total, page: parseInt(page), limit: take });
}

// GET /api/products/:id
async function get(req, res) {
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
    include: {
      store:    { select: { name: true, marketplace: true } },
      variants: { orderBy: { name: 'asc' } },
    },
  });
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
  return res.json({ product: withAlerts(product) });
}

// POST /api/products — cria produto; aceita campo `variants` para criar variações junto
async function create(req, res) {
  const { variants, ...rest } = req.body;
  const parsed = productSchema.safeParse(rest);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });

  const store = await verifyStoreOwnership(parsed.data.storeId, req.userId);
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  const product = await prisma.product.create({ data: parsed.data });

  if (Array.isArray(variants) && variants.length > 0) {
    const parsedVariants = variants.map((v) => variantSchema.parse(v));
    await prisma.product.createMany({
      data: parsedVariants.map((v) => ({
        storeId:   product.storeId,
        parentId:  product.id,
        name:      v.name,
        sku:       v.sku       ?? null,
        barcode:   v.barcode   ?? null,
        costPrice: v.costPrice ?? 0,
        listPrice: v.listPrice ?? 0,
        packaging: v.packaging ?? 0,
        supplies:  v.supplies  ?? 0,
        stock:     v.stock     ?? 0,
        minStock:  v.minStock  ?? 5,
      })),
    });
  }

  const full = await prisma.product.findUnique({
    where: { id: product.id },
    include: { variants: { orderBy: { name: 'asc' } } },
  });
  return res.status(201).json({ product: withAlerts(full) });
}

// PUT /api/products/:id
async function update(req, res) {
  const existing = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
  });
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

  const parsed = productSchema.omit({ storeId: true }).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });

  const product = await prisma.product.update({
    where:   { id: req.params.id },
    data:    parsed.data,
    include: { variants: { orderBy: { name: 'asc' } } },
  });
  return res.json({ product: withAlerts(product) });
}

// DELETE /api/products/:id
async function remove(req, res) {
  const existing = await prisma.product.findFirst({
    where:   { id: req.params.id, store: { userId: req.userId } },
    include: { variants: { select: { id: true } } },
  });
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

  const ids = [existing.id, ...existing.variants.map((v) => v.id)];
  const orderCount = await prisma.orderItem.count({ where: { productId: { in: ids }, order: { status: 'paid' } } });
  if (orderCount > 0) {
    return res.status(409).json({
      error: `Este produto possui ${orderCount} item(ns) vinculado(s) a pedidos pagos e não pode ser removido.`,
    });
  }

  await prisma.product.delete({ where: { id: req.params.id } });
  return res.json({ message: 'Produto removido' });
}

// PATCH /api/products/:id/stock
async function adjustStock(req, res) {
  const { quantity, operation } = req.body;
  if (!['add', 'subtract', 'set'].includes(operation))
    return res.status(400).json({ error: 'operation deve ser: add, subtract ou set' });
  if (typeof quantity !== 'number' || quantity < 0)
    return res.status(400).json({ error: 'quantity deve ser um número positivo' });

  const existing = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
  });
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

  let newStock;
  if (operation === 'set') newStock = quantity;
  else if (operation === 'add') newStock = existing.stock + quantity;
  else newStock = Math.max(0, existing.stock - quantity);

  const product = await prisma.product.update({
    where: { id: req.params.id },
    data:  { stock: newStock },
  });
  return res.json({ product, lowStock: product.stock <= product.minStock });
}

// POST /api/products/:id/variants — adiciona variação a produto existente
async function addVariant(req, res) {
  const parent = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId }, parentId: null },
  });
  if (!parent) return res.status(404).json({ error: 'Produto pai não encontrado' });

  const parsed = variantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });

  const variant = await prisma.product.create({
    data: {
      storeId:   parent.storeId,
      parentId:  parent.id,
      name:      parsed.data.name,
      sku:       parsed.data.sku       ?? null,
      barcode:   parsed.data.barcode   ?? null,
      costPrice: parsed.data.costPrice ?? 0,
      listPrice: parsed.data.listPrice ?? parent.listPrice,
      packaging: parsed.data.packaging ?? parent.packaging,
      supplies:  parsed.data.supplies  ?? parent.supplies,
      stock:     parsed.data.stock     ?? 0,
      minStock:  parsed.data.minStock  ?? 5,
    },
  });
  return res.status(201).json({ variant: withAlerts(variant) });
}

// DELETE /api/products/:id/variants/:variantId — remove uma variação
async function removeVariant(req, res) {
  const variant = await prisma.product.findFirst({
    where: {
      id:       req.params.variantId,
      parentId: req.params.id,
      store:    { userId: req.userId },
    },
  });
  if (!variant) return res.status(404).json({ error: 'Variação não encontrada' });

  const orderCount = await prisma.orderItem.count({ where: { productId: variant.id, order: { status: 'paid' } } });
  if (orderCount > 0) {
    return res.status(409).json({
      error: `Esta variação possui ${orderCount} item(ns) vinculado(s) a pedidos pagos e não pode ser removida.`,
    });
  }

  await prisma.product.delete({ where: { id: variant.id } });
  return res.json({ message: 'Variação removida' });
}

// GET /api/products/stock-report — inteligência de estoque por produto
async function stockReport(req, res) {
  const { storeId } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;

  const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true, name: true, marketplace: true } });
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return res.json({ products: [] });

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [allProducts, items30, lastPurchases] = await Promise.all([
    prisma.product.findMany({
      where:   { storeId: { in: storeIds } },
      select:  { id: true, name: true, sku: true, stock: true, minStock: true, costPrice: true, storeId: true, parentId: true, createdAt: true },
      orderBy: { name: 'asc' },
    }),
    prisma.orderItem.findMany({
      where:  { order: { storeId: { in: storeIds }, status: { not: 'cancelled' }, soldAt: { gte: thirtyDaysAgo } } },
      select: { productId: true, quantity: true },
    }),
    prisma.purchaseOrderItem.findMany({
      where:   { purchaseOrder: { userId: req.userId, status: 'received' } },
      select:  { productId: true, purchaseOrder: { select: { receivedAt: true } } },
      orderBy: { purchaseOrder: { receivedAt: 'desc' } },
    }),
  ]);

  const sales30ByPid   = {};
  for (const it of items30) {
    sales30ByPid[it.productId] = (sales30ByPid[it.productId] ?? 0) + it.quantity;
  }

  const lastReceiptByPid = {};
  for (const it of lastPurchases) {
    if (!lastReceiptByPid[it.productId]) {
      lastReceiptByPid[it.productId] = it.purchaseOrder.receivedAt;
    }
  }

  const storeById = Object.fromEntries(stores.map((s) => [s.id, s]));

  const products = allProducts.map((p) => {
    const sales30     = sales30ByPid[p.id] ?? 0;
    const salesPerDay = sales30 / 30;
    const daysRem     = salesPerDay > 0 ? p.stock / salesPerDay : null;
    const suggested   = salesPerDay > 0 ? Math.max(0, Math.round(salesPerDay * 60 - p.stock)) : 0;
    const store       = storeById[p.storeId];
    return {
      id:              p.id,
      name:            p.name,
      sku:             p.sku ?? '',
      stock:           p.stock,
      minStock:        p.minStock,
      costPrice:       p.costPrice,
      storeId:         p.storeId,
      storeName:       store?.name ?? '',
      marketplace:     store?.marketplace ?? '',
      isVariant:       !!p.parentId,
      salesLast30:     sales30,
      salesPerDay:     parseFloat(salesPerDay.toFixed(3)),
      daysRemaining:   daysRem !== null ? parseFloat(daysRem.toFixed(1)) : null,
      suggestedReorder: suggested,
      lastReceivedAt:  lastReceiptByPid[p.id] ?? null,
      createdAt:       p.createdAt,
    };
  });

  // Ordena: críticos (< 15 dias) → atenção (15-30) → ok → sem movimento → sem estoque/venda
  products.sort((a, b) => {
    const urgA = a.daysRemaining !== null ? a.daysRemaining : 9999;
    const urgB = b.daysRemaining !== null ? b.daysRemaining : 9999;
    return urgA - urgB;
  });

  const totals = {
    total:      products.length,
    critical:   products.filter((p) => p.daysRemaining !== null && p.daysRemaining < 15).length,
    warning:    products.filter((p) => p.daysRemaining !== null && p.daysRemaining >= 15 && p.daysRemaining < 30).length,
    ok:         products.filter((p) => p.daysRemaining !== null && p.daysRemaining >= 30).length,
    noMovement: products.filter((p) => p.daysRemaining === null).length,
  };

  return res.json({ products, totals });
}

module.exports = { list, get, create, update, remove, adjustStock, addVariant, removeVariant, stockReport };
