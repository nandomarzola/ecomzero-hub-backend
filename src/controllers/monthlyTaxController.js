const prisma = require('../lib/prisma');

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

// Soma o GMV (valid+pending) de cada loja do usuário no mês,
// usando apenas meses já fechados (MonthlyClosing.status === 'closed')
async function computeRevenueByStore(userId, month) {
  const stores = await prisma.store.findMany({
    where: { userId },
    select: { id: true, name: true, marketplace: true },
  });

  const revenueByStore = {};
  let totalRevenue = 0;

  for (const store of stores) {
    const closing = await prisma.monthlyClosing.findFirst({
      where: { storeId: store.id, periodMonth: month, status: 'closed' },
      select: { gmvTotal: true },
    });
    if (!closing) continue;

    revenueByStore[store.id] = {
      storeName: store.name,
      marketplace: store.marketplace,
      revenue: closing.gmvTotal,
    };
    totalRevenue += closing.gmvTotal;
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
