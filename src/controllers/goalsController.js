const prisma = require('../lib/prisma');
const { parseYearMonth, r2 } = require('../lib/utils');
const { REVENUE_ORDER_CATEGORIES: REVENUE_CATEGORIES, calcOrderFinancials } = require('../services/profitCalculator');

const APP_TIMEZONE = 'America/Sao_Paulo';

function spToUtc(y, m, d, h = 0, min = 0, sec = 0, ms = 0) {
  return new Date(Date.UTC(y, m - 1, d, h + 3, min, sec, ms));
}

function getZonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== 'literal') out[part.type] = Number(part.value);
  return out;
}

function formatSaoPauloMonth(date) {
  if (!date) return null;
  const parts = getZonedParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
}

// Competência de caixa — alinha com closingController.buildClosingData:
// pedidos confirmados filtrados por orderPaidAt, pendentes por soldAt (fallback)
function paidPeriodWhere(start, end) {
  return {
    OR: [
      { orderPaidAt: { gte: start, lte: end } },
      { orderPaidAt: null, soldAt: { gte: start, lte: end } },
    ],
  };
}

// Fórmula canônica compartilhada — services/profitCalculator.js.
// Metas usa o mesmo lucro por pedido que dashboard/fechamento/pedidos.
function calcLineProfit(order, taxRate, marketplace) {
  return calcOrderFinancials(order, taxRate, marketplace).profit;
}

// Agrega pedidos por orderId — revenue e profit calculados do raw, sem snapshots
function summarizeOrders(orders, storeMetaById) {
  const byOrder = new Map();
  for (const order of orders) {
    if (!REVENUE_CATEGORIES.includes(order.orderCategory)) continue;
    if (String(order.orderStatus ?? '').toUpperCase() === 'CANCELLED') continue;
    const key = order.orderId || order.id;
    if (!key) continue;

    const storeMeta = storeMetaById?.[order.storeId] ?? {};
    const taxRate = storeMeta.taxRate ?? 0;
    const marketplace = storeMeta.marketplace;

    if (!byOrder.has(key)) byOrder.set(key, { revenue: 0, profit: 0 });
    const bucket = byOrder.get(key);

    // Mesmo GMV exibido no dashboard: pedido único, preferindo globalTotal quando existe.
    bucket.revenue = Math.max(bucket.revenue, order.globalTotal ?? order.calcGmv ?? order.salePrice ?? 0);

    // Mesmo lucro do dashboard: repasse real quando existe; previsão só com base líquida confiável.
    const profit = calcLineProfit(order, taxRate, marketplace);
    if (profit !== null && profit !== undefined) bucket.profit += profit;
  }
  const values = [...byOrder.values()];
  return {
    revenue: r2(values.reduce((s, v) => s + v.revenue, 0)),
    profit:  r2(values.reduce((s, v) => s + v.profit, 0)),
    orders:  byOrder.size,
  };
}

// Campos necessários para o cálculo canônico (raw fields apenas)
const ORDER_SELECT = {
  id: true, orderId: true, storeId: true,
  orderStatus: true, orderCategory: true,
  status: true,
  calcGmv: true, globalTotal: true, salePrice: true,
  calcNetRevenue: true,
  platformCommission: true, platformServiceFee: true,
  sellerCoupon: true, lmmDiscount: true,
  escrowAmount: true,
  calcProductCost: true, calcPackaging: true,
  soldAt: true, orderCreatedAt: true, orderPaidAt: true,
};

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
      where:  { userId: req.userId, ...(storeId ? { id: storeId } : {}) },
      select: { id: true, taxRate: true, marketplace: true },
    }),
  ]);

  const storeIds      = stores.map((s) => s.id);
  const storeMetaById = Object.fromEntries(stores.map((s) => [s.id, { taxRate: s.taxRate ?? 0, marketplace: s.marketplace }]));

  const { year: y, month: mo } = parseYearMonth(month);
  const startDate = spToUtc(y, mo, 1);
  const lastDay   = new Date(Date.UTC(y, mo, 0)).getUTCDate();

  const nowParts       = getZonedParts(new Date());
  const isCurrentMonth = nowParts.year === y && nowParts.month === mo;

  // Para mês corrente, espelha o preset "Mês" do dashboard/Upseller:
  // inclui o dia atual.
  // Para meses passados: endDate = fim do último dia do mês em SP
  const currentMonthCutoffDay = isCurrentMonth
    ? Math.max(1, Math.min(nowParts.day, lastDay))
    : lastDay;
  const endDate = isCurrentMonth
    ? spToUtc(y, mo, currentMonthCutoffDay, 23, 59, 59, 999)
    : spToUtc(y, mo, lastDay, 23, 59, 59, 999);

  const orders = await prisma.order.findMany({
    where:  { storeId: { in: storeIds }, ...paidPeriodWhere(startDate, endDate) },
    select: ORDER_SELECT,
  });

  const actual = summarizeOrders(orders, storeMetaById);

  let projection = null;
  if (isCurrentMonth) {
    const daysPassed  = currentMonthCutoffDay;
    const daysInMonth = lastDay;
    const daysLeft    = daysInMonth - daysPassed;
    const projRevenue = daysPassed > 0 ? r2((actual.revenue / daysPassed) * daysInMonth) : 0;
    const projProfit  = daysPassed > 0 ? r2((actual.profit  / daysPassed) * daysInMonth) : 0;
    const projOrders  = daysPassed > 0 ? Math.round((actual.orders / daysPassed) * daysInMonth) : 0;
    projection = {
      revenue:        projRevenue,
      profit:         projProfit,
      orders:         projOrders,
      revenueGoalPct: goal?.revenue > 0 ? parseFloat(((projRevenue / goal.revenue) * 100).toFixed(1)) : null,
      profitGoalPct:  goal?.profit  > 0 ? parseFloat(((projProfit  / goal.profit)  * 100).toFixed(1)) : null,
      daysPassed,
      daysInMonth,
      daysLeft,
    };
  }

  return res.json({
    goal,
    actual: {
      revenue:    actual.revenue,
      profit:     actual.profit,
      orders:     actual.orders,
      revenuePct: goal?.revenue > 0 ? parseFloat(((actual.revenue / goal.revenue) * 100).toFixed(1)) : null,
      profitPct:  goal?.profit  > 0 ? parseFloat(((actual.profit  / goal.profit)  * 100).toFixed(1)) : null,
      ordersPct:  goal?.orders  > 0 ? parseFloat(((actual.orders  / goal.orders)  * 100).toFixed(1)) : null,
    },
    projection,
  });
}

async function getGoalsHistory(req, res) {
  const { storeId } = req.query;

  const goals = await prisma.goal.findMany({
    where:   { userId: req.userId },
    orderBy: { month: 'desc' },
    take:    12,
  });
  if (!goals.length) return res.json({ history: [] });

  const stores = await prisma.store.findMany({
    where:  { userId: req.userId, ...(storeId ? { id: storeId } : {}) },
    select: { id: true, taxRate: true, marketplace: true },
  });
  const storeIds       = stores.map((s) => s.id);
  const storeMetaById = Object.fromEntries(stores.map((s) => [s.id, { taxRate: s.taxRate ?? 0, marketplace: s.marketplace }]));

  const oldest = goals[goals.length - 1].month;
  const [oy, om] = oldest.split('-').map(Number);

  // Bug fix: chamada correta com dois argumentos separados (era um objeto único)
  const rangeStart = spToUtc(oy, om, 1);
  const rangeEnd   = new Date();

  const orders = await prisma.order.findMany({
    where:  { storeId: { in: storeIds }, ...paidPeriodWhere(rangeStart, rangeEnd) },
    select: ORDER_SELECT,
  });

  // Agrupar por mês SP da data de pagamento (competência de caixa)
  // Bug fix: era orderCreatedAt ?? soldAt — agora usa orderPaidAt ?? soldAt
  const ordersByMonth = {};
  for (const o of orders) {
    const monthKey = formatSaoPauloMonth(o.orderPaidAt ?? o.soldAt);
    if (!monthKey) continue;
    if (!ordersByMonth[monthKey]) ordersByMonth[monthKey] = [];
    ordersByMonth[monthKey].push(o);
  }

  const history = goals.map((goal) => {
    const a = summarizeOrders(ordersByMonth[goal.month] ?? [], storeMetaById);
    return {
      month:  goal.month,
      goal:   { revenue: goal.revenue, profit: goal.profit, orders: goal.orders },
      actual: { revenue: a.revenue, profit: a.profit, orders: a.orders },
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
