const { z } = require('zod');
const prisma = require('../lib/prisma');

const productSchema = z.object({
  storeId: z.string().uuid('storeId inválido'),
  name: z.string().min(1, 'Nome obrigatório'),
  externalId: z.string().optional(),
  sku: z.string().optional(),
  costPrice: z.number().min(0, 'Custo deve ser positivo'),
  listPrice: z.number().min(0).optional(),
  packaging: z.number().min(0).optional(),
  supplies:  z.number().min(0).optional(),
  stock: z.number().int().min(0).optional(),
  minStock: z.number().int().min(0).optional(),
});

async function verifyStoreOwnership(storeId, userId) {
  return prisma.store.findFirst({ where: { id: storeId, userId } });
}

async function list(req, res) {
  const { storeId } = req.query;
  const where = storeId ? { storeId, store: { userId: req.userId } } : { store: { userId: req.userId } };

  const products = await prisma.product.findMany({
    where,
    include: { store: { select: { name: true, marketplace: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const withAlerts = products.map((p) => ({
    ...p,
    lowStock: p.stock <= p.minStock,
  }));

  return res.json({ products: withAlerts });
}

async function get(req, res) {
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
    include: { store: { select: { name: true, marketplace: true } } },
  });
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

  return res.json({ product: { ...product, lowStock: product.stock <= product.minStock } });
}

async function create(req, res) {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });
  }

  const store = await verifyStoreOwnership(parsed.data.storeId, req.userId);
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  const product = await prisma.product.create({ data: parsed.data });

  return res.status(201).json({ product });
}

async function update(req, res) {
  const existing = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
  });
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

  const parsed = productSchema.omit({ storeId: true }).partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });
  }

  const product = await prisma.product.update({
    where: { id: req.params.id },
    data: parsed.data,
  });

  return res.json({ product });
}

async function remove(req, res) {
  const existing = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
  });
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

  await prisma.product.delete({ where: { id: req.params.id } });

  return res.json({ message: 'Produto removido' });
}

async function adjustStock(req, res) {
  const { quantity, operation } = req.body;

  if (!['add', 'subtract', 'set'].includes(operation)) {
    return res.status(400).json({ error: 'operation deve ser: add, subtract ou set' });
  }
  if (typeof quantity !== 'number' || quantity < 0) {
    return res.status(400).json({ error: 'quantity deve ser um número positivo' });
  }

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
    data: { stock: newStock },
  });

  return res.json({ product, lowStock: product.stock <= product.minStock });
}

module.exports = { list, get, create, update, remove, adjustStock };
