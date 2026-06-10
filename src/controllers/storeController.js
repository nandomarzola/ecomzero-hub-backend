const { z } = require('zod');
const prisma = require('../lib/prisma');
const { recalculateStoreRates } = require('../services/storeRatesService');

const storeSchema = z.object({
  name: z.string().min(1, 'Nome obrigatório'),
  marketplace: z.enum(['shopee', 'mercadolivre', 'tiktok', 'shein'], {
    errorMap: () => ({ message: 'Marketplace deve ser: shopee, mercadolivre, tiktok ou shein' }),
  }),
  taxType: z.enum(['mei', 'simples', 'lucro_presumido']).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  fixedMonthlyTax: z.number().min(0).optional(),
});

async function list(req, res) {
  const stores = await prisma.store.findMany({
    where: { userId: req.userId },
    orderBy: { createdAt: 'desc' },
  });

  const lastImports = await prisma.import.groupBy({
    by: ['storeId'],
    where: { storeId: { in: stores.map((s) => s.id) } },
    _max: { importedAt: true },
  });
  const lastSyncMap = new Map(lastImports.map((i) => [i.storeId, i._max.importedAt]));

  const result = stores.map((s) => ({ ...s, lastSyncAt: lastSyncMap.get(s.id) ?? null }));
  return res.json({ stores: result });
}

async function get(req, res) {
  const store = await prisma.store.findFirst({
    where: { id: req.params.id, userId: req.userId },
  });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
  return res.json({ store });
}

async function create(req, res) {
  const parsed = storeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });
  }

  const store = await prisma.store.create({
    data: { ...parsed.data, userId: req.userId },
  });

  return res.status(201).json({ store });
}

async function update(req, res) {
  const existing = await prisma.store.findFirst({
    where: { id: req.params.id, userId: req.userId },
  });
  if (!existing) return res.status(404).json({ error: 'Loja não encontrada' });

  const parsed = storeSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });
  }

  const store = await prisma.store.update({
    where: { id: req.params.id },
    data: parsed.data,
  });

  return res.json({ store });
}

async function remove(req, res) {
  const existing = await prisma.store.findFirst({
    where: { id: req.params.id, userId: req.userId },
  });
  if (!existing) return res.status(404).json({ error: 'Loja não encontrada' });

  await prisma.store.delete({ where: { id: req.params.id } });

  return res.json({ message: 'Loja removida' });
}

async function getRates(req, res) {
  const store = await prisma.store.findFirst({
    where: { id: req.params.id, userId: req.userId },
  });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  const rates = await prisma.storeRate.findMany({
    where:   { storeId: req.params.id },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    take:    6,
  });
  return res.json({ rates });
}

module.exports = { list, get, create, update, remove, getRates };
