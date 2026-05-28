const prisma = require('../lib/prisma');

async function upsertGoal(req, res) {
  const { month, revenue = 0, profit = 0, orders = 0 } = req.body;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month obrigatório (formato: 2026-04)' });
  }
  const goal = await prisma.goal.upsert({
    where:  { userId_month: { userId: req.userId, month } },
    update: { revenue: Number(revenue), profit: Number(profit), orders: Number(orders) },
    create: { userId: req.userId, month, revenue: Number(revenue), profit: Number(profit), orders: Number(orders) },
  });
  return res.json(goal);
}

async function deleteGoal(req, res) {
  const { month } = req.params;
  try {
    await prisma.goal.delete({ where: { userId_month: { userId: req.userId, month } } });
    return res.json({ ok: true });
  } catch {
    return res.status(404).json({ error: 'Meta não encontrada' });
  }
}

async function getGoalWithProgress(req, res) {
  const { month } = req.params;
  const { storeId } = req.query;

  const [goal, stores] = await Promise.all([
    prisma.goal.findUnique({ where: { userId_month: { userId: req.userId, month } } }),
    prisma.store.findMany({
      where: { userId: req.userId, ...(storeId ? { id: storeId } : {}) },
      select: { id: true },
    }),
  ]);

  const storeIds = stores.map((s) => s.id);
  const [y, mo]  = month.split('-').map(Number);
  const startDate  = new Date(y, mo - 1, 1);
  const today      = new Date();
  const isCurrentMonth = today.getFullYear() === y && today.getMonth() + 1 === mo;
  const endDate    = isCurrentMonth ? today : new Date(y, mo, 0, 23, 59, 59, 999);

  const orders = await prisma.order.findMany({
    where: { storeId: { in: storeIds }, status: 'paid', soldAt: { gte: startDate, lte: endDate } },
    select: { salePrice: true, profit: true },
  });

  const actualRevenue = orders.reduce((s, o) => s + o.salePrice, 0);
  const actualProfit  = orders.reduce((s, o) => s + (o.profit ?? 0), 0);
  const actualOrders  = orders.length;

  let projection = null;
  if (isCurrentMonth) {
    const daysPassed = today.getDate();
    const daysInMonth = new Date(y, mo, 0).getDate();
    const projRevenue = daysPassed > 0 ? (actualRevenue / daysPassed) * daysInMonth : 0;
    const projProfit  = daysPassed > 0 ? (actualProfit  / daysPassed) * daysInMonth : 0;
    const projOrders  = daysPassed > 0 ? Math.round((actualOrders / daysPassed) * daysInMonth) : 0;
    projection = {
      revenue:        parseFloat(projRevenue.toFixed(2)),
      profit:         parseFloat(projProfit.toFixed(2)),
      orders:         projOrders,
      revenueGoalPct: goal?.revenue > 0 ? parseFloat(((projRevenue / goal.revenue) * 100).toFixed(1)) : null,
      profitGoalPct:  goal?.profit  > 0 ? parseFloat(((projProfit  / goal.profit)  * 100).toFixed(1)) : null,
      daysPassed,
      daysInMonth,
      daysLeft: daysInMonth - daysPassed,
    };
  }

  return res.json({
    goal,
    actual: {
      revenue:    parseFloat(actualRevenue.toFixed(2)),
      profit:     parseFloat(actualProfit.toFixed(2)),
      orders:     actualOrders,
      revenuePct: goal?.revenue > 0 ? parseFloat(((actualRevenue / goal.revenue) * 100).toFixed(1)) : null,
      profitPct:  goal?.profit  > 0 ? parseFloat(((actualProfit  / goal.profit)  * 100).toFixed(1)) : null,
      ordersPct:  goal?.orders  > 0 ? parseFloat(((actualOrders  / goal.orders)  * 100).toFixed(1)) : null,
    },
    projection,
  });
}

async function getGoalsHistory(req, res) {
  const { storeId } = req.query;

  const goals = await prisma.goal.findMany({
    where: { userId: req.userId },
    orderBy: { month: 'desc' },
    take: 12,
  });
  if (!goals.length) return res.json({ history: [] });

  const stores = await prisma.store.findMany({
    where: { userId: req.userId, ...(storeId ? { id: storeId } : {}) },
    select: { id: true },
  });
  const storeIds = stores.map((s) => s.id);

  const oldest = goals[goals.length - 1].month;
  const [oy, om] = oldest.split('-').map(Number);

  const orders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      status:  'paid',
      soldAt:  { gte: new Date(oy, om - 1, 1) },
    },
    select: { salePrice: true, profit: true, soldAt: true },
  });

  const ordersByMonth = {};
  for (const o of orders) {
    const key = o.soldAt.toISOString().substring(0, 7);
    if (!ordersByMonth[key]) ordersByMonth[key] = { revenue: 0, profit: 0, orders: 0 };
    ordersByMonth[key].revenue += o.salePrice;
    ordersByMonth[key].profit  += o.profit ?? 0;
    ordersByMonth[key].orders++;
  }

  const history = goals.map((goal) => {
    const a = ordersByMonth[goal.month] ?? { revenue: 0, profit: 0, orders: 0 };
    return {
      month:  goal.month,
      goal:   { revenue: goal.revenue, profit: goal.profit, orders: goal.orders },
      actual: {
        revenue: parseFloat(a.revenue.toFixed(2)),
        profit:  parseFloat(a.profit.toFixed(2)),
        orders:  a.orders,
      },
      pct: {
        revenue: goal.revenue > 0 ? parseFloat(((a.revenue / goal.revenue) * 100).toFixed(1)) : null,
        profit:  goal.profit  > 0 ? parseFloat(((a.profit  / goal.profit)  * 100).toFixed(1)) : null,
        orders:  goal.orders  > 0 ? parseFloat(((a.orders  / goal.orders)  * 100).toFixed(1)) : null,
      },
    };
  });

  return res.json({ history });
}

module.exports = { upsertGoal, deleteGoal, getGoalWithProgress, getGoalsHistory };
