const prisma = require('../lib/prisma');
const { parseYearMonth } = require('../lib/utils');

const APP_TIMEZONE = 'America/Sao_Paulo';
const VALID_CATEGORIES = ['valid', 'pending'];

function saoPauloDateToUtc(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute, second, millisecond));
}

function getZonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== 'literal') out[part.type] = Number(part.value);
  return out;
}

function formatSaoPauloMonth(date) {
  const parts = getZonedParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
}

function orderPeriodWhere(start, end) {
  return {
    OR: [
      { orderCreatedAt: { gte: start, lte: end } },
      { orderCreatedAt: null, soldAt: { gte: start, lte: end } },
    ],
  };
}

function summarizeValidOrders(orders) {
  const byOrder = new Map();
  for (const order of orders) {
    if (!VALID_CATEGORIES.includes(order.orderCategory)) continue;
    if (String(order.orderStatus ?? '').toUpperCase() === 'CANCELLED') continue;
    const key = order.orderId || order.id;
    if (!key) continue;
    if (!byOrder.has(key)) byOrder.set(key, { revenue: 0, profit: 0 });
    const bucket = byOrder.get(key);
    bucket.revenue = Math.max(bucket.revenue, order.globalTotal ?? order.calcGmv ?? order.salePrice ?? 0);
    bucket.profit += order.calcGrossProfit ?? order.profit ?? 0;
  }
  const values = [...byOrder.values()];
  return {
    revenue: values.reduce((sum, item) => sum + item.revenue, 0),
    profit: values.reduce((sum, item) => sum + item.profit, 0),
    orders: byOrder.size,
  };
}

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
  const { year: y, month: mo } = parseYearMonth(month);
  const startDate  = saoPauloDateToUtc(y, mo, 1);
  const today      = new Date();
  const todayParts = getZonedParts(today);
  const isCurrentMonth = todayParts.year === y && todayParts.month === mo;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const endDate = isCurrentMonth ? today : saoPauloDateToUtc(y, mo, lastDay, 23, 59, 59, 999);

  const orders = await prisma.order.findMany({
    where: { storeId: { in: storeIds }, ...orderPeriodWhere(startDate, endDate) },
    select: { id: true, orderId: true, orderStatus: true, orderCategory: true, salePrice: true, calcGmv: true, globalTotal: true, profit: true, calcGrossProfit: true },
  });

  const actual = summarizeValidOrders(orders);
  const actualRevenue = actual.revenue;
  const actualProfit  = actual.profit;
  const actualOrders  = actual.orders;

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
      ...orderPeriodWhere({ start: saoPauloDateToUtc(oy, om, 1), end: new Date() }),
    },
    select: { id: true, orderId: true, orderStatus: true, orderCategory: true, salePrice: true, calcGmv: true, globalTotal: true, profit: true, calcGrossProfit: true, soldAt: true, orderCreatedAt: true },
  });

  const ordersByMonthRows = {};
  for (const o of orders) {
    const key = formatSaoPauloMonth(o.orderCreatedAt ?? o.soldAt);
    if (!ordersByMonthRows[key]) ordersByMonthRows[key] = [];
    ordersByMonthRows[key].push(o);
  }

  const history = goals.map((goal) => {
    const a = summarizeValidOrders(ordersByMonthRows[goal.month] ?? []);
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
