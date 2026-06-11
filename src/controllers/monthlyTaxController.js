const prisma = require('../lib/prisma');

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

// Soma o GMV (valid+pending) de cada loja do usuário no mês,
// direto dos pedidos (Order), independente do mês estar fechado
async function computeRevenueByStore(userId, month) {
  const stores = await prisma.store.findMany({
    where: { userId },
    select: { id: true, name: true, marketplace: true },
  });
  if (!stores.length) return { revenueByStore: {}, totalRevenue: 0 };

  const [y, mo] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, mo - 1, 1));
  const end   = new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999));

  const grouped = await prisma.order.groupBy({
    by: ['storeId'],
    where: {
      storeId: { in: stores.map((s) => s.id) },
      soldAt: { gte: start, lte: end },
      orderCategory: { in: ['valid', 'pending'] },
    },
    _sum: { calcGmv: true },
  });
  const revenueByStoreId = new Map(grouped.map((g) => [g.storeId, r2(g._sum.calcGmv)]));

  const revenueByStore = {};
  let totalRevenue = 0;

  for (const store of stores) {
    const revenue = revenueByStoreId.get(store.id);
    if (!revenue) continue;

    revenueByStore[store.id] = {
      storeName: store.name,
      marketplace: store.marketplace,
      revenue,
    };
    totalRevenue += revenue;
  }

  return { revenueByStore, totalRevenue: r2(totalRevenue) };
}

// ── GET /api/monthly-tax/:month ──────────────────────────────────────────────
async function getMonthlyTax(req, res) {
  try {
    const { month } = req.params;

    const existing = await prisma.monthlyTax.findUnique({
      where: { userId_month: { userId: req.userId, month } },
    });

    if (existing) {
      return res.json({
        exists: true,
        revenueByStore: existing.revenueByStore,
        totalRevenue: existing.totalRevenue,
        dasAmount: existing.dasAmount,
        effectiveRate: existing.effectiveRate,
      });
    }

    const { revenueByStore, totalRevenue } = await computeRevenueByStore(req.userId, month);

    return res.json({
      exists: false,
      revenueByStore,
      totalRevenue,
      dasAmount: null,
      effectiveRate: null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar imposto mensal' });
  }
}

// ── POST /api/monthly-tax/:month ─────────────────────────────────────────────
async function saveMonthlyTax(req, res) {
  try {
    const { month } = req.params;
    const { dasAmount } = req.body;

    if (dasAmount == null || isNaN(dasAmount) || dasAmount < 0) {
      return res.status(400).json({ error: 'dasAmount inválido' });
    }

    const { revenueByStore, totalRevenue } = await computeRevenueByStore(req.userId, month);
    const effectiveRate = totalRevenue > 0 ? r2((dasAmount / totalRevenue) * 100) : null;

    const saved = await prisma.monthlyTax.upsert({
      where: { userId_month: { userId: req.userId, month } },
      create: {
        userId: req.userId, month,
        revenueByStore, totalRevenue,
        dasAmount: r2(dasAmount), effectiveRate,
      },
      update: {
        revenueByStore, totalRevenue,
        dasAmount: r2(dasAmount), effectiveRate,
      },
    });

    return res.json({
      exists: true,
      revenueByStore: saved.revenueByStore,
      totalRevenue: saved.totalRevenue,
      dasAmount: saved.dasAmount,
      effectiveRate: saved.effectiveRate,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao salvar imposto mensal' });
  }
}

module.exports = { getMonthlyTax, saveMonthlyTax };
