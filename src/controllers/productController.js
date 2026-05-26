const { z } = require('zod');
const prisma = require('../lib/prisma');

const productSchema = z.object({
  storeId:   z.string().uuid('storeId inválido'),
  name:      z.string().min(1, 'Nome obrigatório'),
  externalId: z.string().optional(),
  sku:       z.string().optional(),
  barcode:   z.string().optional(),
  costPrice: z.number().min(0, 'Custo deve ser positivo'),
  listPrice: z.number().min(0).optional(),
  packaging: z.number().min(0).optional(),
  supplies:  z.number().min(0).optional(),
  stock:     z.number().int().min(0).optional(),
  minStock:  z.number().int().min(0).optional(),
});

const variantSchema = z.object({
  name:      z.string().min(1, 'Nome da variação obrigatório'),
  sku:       z.string().optional(),
  barcode:   z.string().optional(),
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

// GET /api/products — retorna apenas produtos raiz (sem pai) com variações incluídas
async function list(req, res) {
  const { storeId } = req.query;
  const where = {
    parentId: null,
    ...(storeId ? { storeId, store: { userId: req.userId } } : { store: { userId: req.userId } }),
  };

  const products = await prisma.product.findMany({
    where,
    include: {
      store: { select: { name: true, marketplace: true } },
      variants: { orderBy: { name: 'asc' } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({ products: products.map(withAlerts) });
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
    where: { id: req.params.id, store: { userId: req.userId } },
  });
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });
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
  await prisma.product.delete({ where: { id: variant.id } });
  return res.json({ message: 'Variação removida' });
}

module.exports = { list, get, create, update, remove, adjustStock, addVariant, removeVariant };
