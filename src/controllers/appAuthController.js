const { randomInt } = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { r2 } = require('../lib/utils');

async function generateCode(req, res) {
  // Invalidar códigos anteriores não usados deste usuário
  await prisma.appAccessCode.deleteMany({
    where: { userId: req.userId, usedAt: null },
  });

  // Gerar código único de 6 dígitos
  let code, exists;
  do {
    code = String(randomInt(100000, 999999));
    exists = await prisma.appAccessCode.findUnique({ where: { code } });
  } while (exists);

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias

  const record = await prisma.appAccessCode.create({
    data: { userId: req.userId, code, expiresAt },
  });

  return res.json({
    code: record.code,
    expiresAt: record.expiresAt,
  });
}

async function verifyCode(req, res) {
  const { code } = req.body;
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Código inválido — deve ter 6 dígitos.' });
  }

  const record = await prisma.appAccessCode.findUnique({
    where: { code },
    include: { user: { select: { id: true, name: true, email: true, plan: true, role: true, cnpj: true } } },
  });

  if (!record)                        return res.status(401).json({ error: 'Código não encontrado.' });
  if (record.usedAt)                  return res.status(401).json({ error: 'Código já utilizado.' });
  if (new Date() > record.expiresAt)  return res.status(401).json({ error: 'Código expirado.' });

  // Marcar como usado
  await prisma.appAccessCode.update({
    where: { code },
    data: { usedAt: new Date() },
  });

  // JWT com prazo de 90 dias (app mobile)
  const token = jwt.sign(
    { userId: record.userId, source: 'mobile' },
    process.env.JWT_SECRET,
    { expiresIn: '90d' }
  );

  return res.json({
    token,
    user: record.user,
  });
}

const APP_TIMEZONE = 'America/Sao_Paulo';

function getZonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

function saoPauloDateToUtc(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  // Brasil não usa horário de verão desde 2019. A Shopee BR e o export diário
  // seguem o dia local; no Render o Node roda em UTC, então fixamos UTC-03.
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute, second, millisecond));
}

function addDaysToParts(parts, days) {
  const date = saoPauloDateToUtc(parts.year, parts.month, parts.day + days);
  return getZonedParts(date);
}

function getPeriodRange(period = 'today') {
  const now = new Date();
  const today = getZonedParts(now);
  let startParts = { ...today };
  let endParts = { ...today };

  if (period === 'yesterday' || period === 'ontem') {
    startParts = addDaysToParts(today, -1);
    endParts = { ...startParts };
    return {
      start: saoPauloDateToUtc(startParts.year, startParts.month, startParts.day),
      end: saoPauloDateToUtc(endParts.year, endParts.month, endParts.day, 23, 59, 59, 999),
      label: 'Ontem',
      timezone: APP_TIMEZONE,
    };
  }

  if (period === '7d') {
    startParts = addDaysToParts(today, -7);
    endParts   = addDaysToParts(today, -1);
    return {
      start: saoPauloDateToUtc(startParts.year, startParts.month, startParts.day),
      end: saoPauloDateToUtc(endParts.year, endParts.month, endParts.day, 23, 59, 59, 999),
      label: '7 dias',
      timezone: APP_TIMEZONE,
    };
  }

  if (period === '30d') {
    startParts = addDaysToParts(today, -30);
    endParts   = addDaysToParts(today, -1);
    return {
      start: saoPauloDateToUtc(startParts.year, startParts.month, startParts.day),
      end: saoPauloDateToUtc(endParts.year, endParts.month, endParts.day, 23, 59, 59, 999),
      label: '30 dias',
      timezone: APP_TIMEZONE,
    };
  }

  if (period === 'month' || period === 'mes') {
    startParts = { ...today, day: 1 };
    endParts = today.day === 1 ? { ...today } : addDaysToParts(today, -1);
    return {
      start: saoPauloDateToUtc(startParts.year, startParts.month, startParts.day),
      end: saoPauloDateToUtc(endParts.year, endParts.month, endParts.day, 23, 59, 59, 999),
      label: 'Mês',
      timezone: APP_TIMEZONE,
    };
  }

  return {
    start: saoPauloDateToUtc(startParts.year, startParts.month, startParts.day),
    end: saoPauloDateToUtc(endParts.year, endParts.month, endParts.day, 23, 59, 59, 999),
    label: 'Hoje',
    timezone: APP_TIMEZONE,
  };
}

function orderPeriodWhere(range) {
  return {
    OR: [
      { orderCreatedAt: { gte: range.start, lte: range.end } },
      { orderCreatedAt: null, soldAt: { gte: range.start, lte: range.end } },
    ],
  };
}

function formatSaoPauloDay(date) {
  const parts = getZonedParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function calcOrderProfit(order, taxRateMap) {
  const taxRate = taxRateMap[order.storeId] ?? 0;
  const fee = r2((order.platformCommission ?? 0) + (order.platformServiceFee ?? 0));
  const disc = r2((order.sellerCoupon ?? 0) + (order.lmmDiscount ?? 0));
  const repasse = order.orderCategory === 'valid' && order.escrowAmount != null
    ? r2(order.escrowAmount)
    : r2((order.calcGmv ?? 0) - fee - disc);
  const tax = r2((order.calcGmv ?? 0) * (taxRate / 100));
  const profit = r2(repasse - tax - (order.calcProductCost ?? 0) - (order.calcPackaging ?? 0));
  return { fee, discount: disc, netRevenue: repasse, tax, profit };
}

function normalizeProductName(name = '') {
  return String(name)
    .replace(/\s+—\s+.+$/g, '')
    .replace(/\s+-\s+.+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function estimateBreakRisk(product) {
  const haystack = `${product?.name ?? ''} ${product?.category ?? ''}`.toLowerCase();
  const highRisk = ['vidro', 'glass', 'ceram', 'porcel', 'espelho', 'fragil', 'frágil', 'quebra'];
  const mediumRisk = ['liquido', 'líquido', 'aroma', 'difusor', 'refil', 'frasco', 'oleo', 'óleo'];
  if (highRisk.some((term) => haystack.includes(term))) return 3;
  if (mediumRisk.some((term) => haystack.includes(term))) return 2;
  return 1;
}

function buildChampionScore(item) {
  const riskScore = item.breakRisk ?? 1;
  const reorderCost = item.costPrice != null && item.costPrice > 0 ? item.costPrice : item.avgUnitCost;
  const reorderScore = reorderCost > 0 ? Math.max(0, 100 - reorderCost) : 50;

  return {
    score: r2(
      (item.units * 1000) +
      ((4 - riskScore) * 180) +
      (reorderScore * 4) +
      Math.max(0, item.profit)
    ),
    quantityWeight: item.units,
    breakRisk: riskScore,
    reorderCost: reorderCost ? r2(reorderCost) : null,
    reorderScore: r2(reorderScore),
    profitWeight: r2(item.profit),
    source: 'units_then_estimated_risk_reorder_profit',
    preciseSignals: {
      quantity: true,
      profit: true,
      breakRisk: false,
      reorderCost: item.costPrice != null && item.costPrice > 0,
    },
  };
}

const REVENUE_ORDER_CATEGORIES = ['valid', 'pending', 'returned_partial'];

function addUnique(bucket, order) {
  bucket.orderIds.add(order.orderId);
  bucket.lines += 1;
  bucket.units += order.quantity ?? 0;
}

function summarizeOrderBreakdown(orders) {
  const makeBucket = () => ({ orderIds: new Set(), lines: 0, units: 0 });
  const buckets = {
    created: makeBucket(),
    paid: makeBucket(),
    valid: makeBucket(),
    pending: makeBucket(),
    unpaid: makeBucket(),
    cancelled: makeBucket(),
    returned: makeBucket(),
  };

  for (const order of orders) {
    const hasPayment = !!order.orderPaidAt || (order.orderCategory !== 'cancelled_unpaid' && REVENUE_ORDER_CATEGORIES.includes(order.orderCategory));
    const rawStatus = String(order.orderStatus ?? '').toUpperCase();
    const isOpenUnpaid = !hasPayment && rawStatus === 'UNPAID';
    const isCancelledWithoutPayment = !hasPayment && (order.orderCategory?.startsWith('cancelled') || rawStatus === 'CANCELLED');

    addUnique(buckets.created, order);
    if (hasPayment) addUnique(buckets.paid, order);
    if (order.orderCategory === 'valid') addUnique(buckets.valid, order);
    if (order.orderCategory === 'pending') addUnique(buckets.pending, order);
    if (isOpenUnpaid) addUnique(buckets.unpaid, order);
    if (isCancelledWithoutPayment) addUnique(buckets.cancelled, order);
    if (['returned_full', 'returned_partial'].includes(order.orderCategory)) addUnique(buckets.returned, order);
  }

  return Object.fromEntries(Object.entries(buckets).map(([key, bucket]) => [
    key,
    { orders: bucket.orderIds.size, lines: bucket.lines, units: bucket.units },
  ]));
}

async function getAppDashboard(req, res) {
  const { storeId, period = 'today' } = req.query;
  const userId = req.userId;

  const now   = new Date();
  const range = getPeriodRange(period);
  const todayRange = getPeriodRange('today');
  const monthRange = getPeriodRange('month');
  const nowParts = getZonedParts(now);
  const month = `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}`;
  const startOfYear = saoPauloDateToUtc(nowParts.year, 1, 1);

  // Buscar lojas do usuário
  const stores = await prisma.store.findMany({
    where: { userId, ...(storeId ? { id: storeId } : {}) },
    select: { id: true, name: true, marketplace: true, taxRate: true },
  });
  const storeIds = stores.map(s => s.id);
  const taxRateMap = Object.fromEntries(stores.map(s => [s.id, s.taxRate ?? 0]));

  if (storeIds.length === 0) return res.json({ stores: [], summary: null });

  const yearOrders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      ...orderPeriodWhere({ start: startOfYear, end: now }),
      orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
      calcGmv: { gt: 0 },
    },
    select: { calcGmv: true },
  });
  const yearGmv = r2(yearOrders.reduce((s, o) => s + (o.calcGmv ?? 0), 0));

  // Todos os pedidos do período, incluindo não pagos/cancelados. O financeiro
  // usa só categorias com receita, mas os contadores precisam bater com a Shopee.
  const allPeriodOrders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      ...orderPeriodWhere(range),
    },
    select: {
      id: true, storeId: true, soldAt: true, orderCreatedAt: true, quantity: true,
      orderId: true, // para contar pedidos únicos (1 pedido multi-item = N linhas com mesmo orderId)
      calcGmv: true, platformCommission: true, platformServiceFee: true,
      sellerCoupon: true, lmmDiscount: true, escrowAmount: true,
      calcProductCost: true, calcPackaging: true, orderCategory: true,
      orderStatus: true, orderPaidAt: true, cancelReason: true,
      productId: true,
    },
  });
  const orders = allPeriodOrders.filter((order) => REVENUE_ORDER_CATEGORIES.includes(order.orderCategory));
  const breakdown = summarizeOrderBreakdown(allPeriodOrders);

  const monthOrders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      ...orderPeriodWhere(monthRange),
      orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
    },
    select: {
      storeId: true, calcGmv: true, platformCommission: true, platformServiceFee: true,
      sellerCoupon: true, lmmDiscount: true, escrowAmount: true, calcProductCost: true,
      calcPackaging: true, orderCategory: true,
    },
  });

  // Calcular por loja (recompute do raw)
  const byStore = {};
  for (const s of stores) byStore[s.id] = { storeId: s.id, name: s.name, marketplace: s.marketplace, gmv: 0, netRevenue: 0, profit: 0, orders: 0, items: 0 };

  let totalGmv = 0, totalNetRevenue = 0, totalProfit = 0, totalItems = 0;
  let todayGmv = 0, todayProfit = 0, todayItems = 0;

  // Sets para contar pedidos únicos por orderId
  const uniqueOrderIds      = new Set();
  const uniqueOrderIdsToday = new Set();
  const uniqueByStore       = {}; // storeId → Set de orderIds únicos
  const unitsByStore        = {};
  for (const s of stores) uniqueByStore[s.id] = new Set();
  for (const s of stores) unitsByStore[s.id] = 0;

  for (const o of orders) {
    const calc = calcOrderProfit(o, taxRateMap);

    byStore[o.storeId].gmv    += o.calcGmv;
    byStore[o.storeId].netRevenue += calc.netRevenue;
    byStore[o.storeId].profit += calc.profit;
    byStore[o.storeId].items  += 1;
    unitsByStore[o.storeId] += o.quantity ?? 0;
    uniqueByStore[o.storeId].add(o.orderId);
    totalGmv    += o.calcGmv;
    totalNetRevenue += calc.netRevenue;
    totalProfit += calc.profit;
    totalItems  += 1;
    uniqueOrderIds.add(o.orderId);

    const orderDate = new Date(o.orderCreatedAt ?? o.soldAt);
    if (orderDate >= todayRange.start && orderDate <= todayRange.end) {
      todayGmv    += o.calcGmv;
      todayProfit += calc.profit;
      todayItems  += 1;
      uniqueOrderIdsToday.add(o.orderId);
    }
  }

  // Contar pedidos únicos por loja
  for (const s of stores) {
    byStore[s.id].orders = uniqueByStore[s.id].size;
    byStore[s.id].units = unitsByStore[s.id] ?? 0;
  }

  // Projeção do mês
  const daysElapsed = nowParts.day;
  const daysInMonth = new Date(Date.UTC(nowParts.year, nowParts.month, 0)).getUTCDate();
  const monthGmv = r2(monthOrders.reduce((sum, order) => sum + (order.calcGmv ?? 0), 0));
  const monthProfit = r2(monthOrders.reduce((sum, order) => sum + calcOrderProfit(order, taxRateMap).profit, 0));
  const projectedGmv    = daysElapsed > 0 ? r2(monthGmv    / daysElapsed * daysInMonth) : 0;
  const projectedProfit = daysElapsed > 0 ? r2(monthProfit / daysElapsed * daysInMonth) : 0;

  // ── Comparação com período anterior ─────────────────────────────────────────
  const periodMs = range.end.getTime() - range.start.getTime();
  const prevRange = {
    start: new Date(range.start.getTime() - periodMs - 1000),
    end:   new Date(range.start.getTime() - 1000),
  };
  const prevOrds = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      orderPaidAt: { gte: prevRange.start, lte: prevRange.end },
      orderCategory: { in: REVENUE_ORDER_CATEGORIES },
    },
    select: {
      orderId: true, calcGmv: true, platformCommission: true, platformServiceFee: true,
      sellerCoupon: true, lmmDiscount: true, escrowAmount: true,
      calcProductCost: true, calcPackaging: true, orderCategory: true,
    },
  });
  let prevGmv = 0, prevProfit = 0;
  const prevIds = new Set();
  for (const o of prevOrds) {
    const c = calcOrderProfit(o, taxRateMap);
    prevGmv   += o.calcGmv ?? 0;
    prevProfit += c.profit;
    prevIds.add(o.orderId);
  }

  // "Mesmo período de Ontem" — só para today: ontem 00:00 até exatamente 24h atrás
  let spGmv = null, spProfit = null, spOrders = null;
  if (period === 'today') {
    const spRange = {
      start: new Date(todayRange.start.getTime() - 86400000),
      end:   new Date(now.getTime()           - 86400000),
    };
    const spOrds = await prisma.order.findMany({
      where: {
        storeId: { in: storeIds },
        orderPaidAt: { gte: spRange.start, lte: spRange.end },
        orderCategory: { in: REVENUE_ORDER_CATEGORIES },
      },
      select: {
        orderId: true, calcGmv: true, platformCommission: true, platformServiceFee: true,
        sellerCoupon: true, lmmDiscount: true, escrowAmount: true,
        calcProductCost: true, calcPackaging: true, orderCategory: true,
      },
    });
    let _g = 0, _p = 0;
    const spIds = new Set();
    for (const o of spOrds) {
      const c = calcOrderProfit(o, taxRateMap);
      _g += o.calcGmv ?? 0;
      _p += c.profit;
      spIds.add(o.orderId);
    }
    spGmv    = r2(_g);
    spProfit = r2(_p);
    spOrders = spIds.size;
  }

  return res.json({
    month,
    period,
    periodLabel: range.label,
    periodRange: { start: range.start, end: range.end, timezone: range.timezone },
    summary: {
      gmv:    r2(totalGmv),
      netRevenue: r2(totalNetRevenue),
      profit: r2(totalProfit),
      orders: uniqueOrderIds.size,  // pedidos únicos (order_sn distintos)
      items:  totalItems,           // linhas totais com receita
      units:  breakdown.paid.units, // unidades pagas/vendidas
      paidOrders: breakdown.paid.orders,
      paidUnits: breakdown.paid.units,
      createdOrders: breakdown.created.orders,
      createdUnits: breakdown.created.units,
      unpaidOrders: breakdown.unpaid.orders,
      unpaidUnits: breakdown.unpaid.units,
      cancelledOrders: breakdown.cancelled.orders,
      cancelledUnits: breakdown.cancelled.units,
      returnedOrders: breakdown.returned.orders,
      returnedUnits: breakdown.returned.units,
      margin: totalGmv > 0 ? r2((totalProfit / totalGmv) * 100) : 0,
      returns: breakdown.returned.orders + breakdown.cancelled.orders + breakdown.unpaid.orders,
      orderBreakdown: breakdown,
    },
    yearGmv,
    today: {
      gmv:     r2(todayGmv),
      profit:  r2(todayProfit),
      orders:  uniqueOrderIdsToday.size, // pedidos únicos hoje
      items:   todayItems,               // linhas hoje
      returns: breakdown.returned.orders + breakdown.cancelled.orders + breakdown.unpaid.orders,
    },
    projection: {
      gmv: projectedGmv, profit: projectedProfit,
      daysElapsed, daysInMonth,
    },
    stores: Object.values(byStore).map(s => ({
      ...s,
      gmv: r2(s.gmv),
      netRevenue: r2(s.netRevenue),
      profit: r2(s.profit),
      margin: s.gmv > 0 ? r2((s.profit / s.gmv) * 100) : 0,
    })).sort((a, b) => b.gmv - a.gmv),
    comparison: {
      previousPeriod: {
        gmv:    r2(prevGmv),
        orders: prevIds.size,
        profit: r2(prevProfit),
      },
      samePeriodYesterday: period === 'today'
        ? { gmv: spGmv, orders: spOrders, profit: spProfit }
        : null,
    },
  });
}

async function getAppTrends(req, res) {
  const { storeId, period = '7d' } = req.query;
  const userId = req.userId;
  const range = getPeriodRange(period);

  const stores = await prisma.store.findMany({
    where: { userId, ...(storeId ? { id: storeId } : {}) },
    select: { id: true, taxRate: true },
  });
  const storeIds = stores.map(s => s.id);
  const taxRateMap = Object.fromEntries(stores.map(s => [s.id, s.taxRate ?? 0]));

  const orders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      ...orderPeriodWhere(range),
      orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
    },
    select: {
      storeId: true, soldAt: true, orderCreatedAt: true, calcGmv: true,
      platformCommission: true, platformServiceFee: true,
      sellerCoupon: true, lmmDiscount: true, escrowAmount: true,
      calcProductCost: true, calcPackaging: true, orderCategory: true,
      orderId: true,
    },
    orderBy: { soldAt: 'asc' },
  });

  // Agrupar por dia
  const byDay = {};
  const uniqueOrders = new Set();

  for (const o of orders) {
    const day = formatSaoPauloDay(o.orderCreatedAt ?? o.soldAt);
    if (!byDay[day]) byDay[day] = { date: day, gmv: 0, profit: 0, orders: 0 };

    const taxRate = taxRateMap[o.storeId] ?? 0;
    const fee = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
    const disc = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
    const repasse = o.orderCategory === 'valid' && o.escrowAmount != null
      ? r2(o.escrowAmount) : r2(o.calcGmv - fee - disc);
    const tax = r2(o.calcGmv * (taxRate / 100));
    const profit = r2(repasse - tax - (o.calcProductCost ?? 0) - (o.calcPackaging ?? 0));

    byDay[day].gmv    += o.calcGmv;
    byDay[day].profit += profit;
    if (!uniqueOrders.has(o.orderId)) { byDay[day].orders += 1; uniqueOrders.add(o.orderId); }
  }

  const chart = Object.values(byDay);
  const totalGmv    = r2(chart.reduce((s, d) => s + d.gmv, 0));
  const totalProfit = r2(chart.reduce((s, d) => s + d.profit, 0));
  const totalOrders = uniqueOrders.size;
  const avgMargin   = totalGmv > 0 ? r2((totalProfit / totalGmv) * 100) : 0;
  const avgTicket   = totalOrders > 0 ? r2(totalGmv / totalOrders) : 0;

  return res.json({
    period,
    periodLabel: range.label,
    periodRange: { start: range.start, end: range.end, timezone: range.timezone },
    chart, // [{ date, gmv, profit, orders }]
    summary: { gmv: totalGmv, profit: totalProfit, orders: totalOrders, margin: avgMargin, avgTicket },
  });
}

async function getAppProducts(req, res) {
  const { storeId, period = 'today' } = req.query;
  const userId = req.userId;
  const range = getPeriodRange(period);

  const stores = await prisma.store.findMany({
    where: { userId, ...(storeId ? { id: storeId } : {}) },
    select: { id: true, taxRate: true, name: true, marketplace: true },
  });
  const storeIds = stores.map(s => s.id);
  const taxRateMap = Object.fromEntries(stores.map(s => [s.id, s.taxRate ?? 0]));

  if (!storeIds.length) {
    return res.json({
      period,
      periodLabel: range.label,
      trafficAvailable: false,
      summary: { products: 0, units: 0, gmv: 0, profit: 0, margin: 0 },
      champions: [],
      opportunities: [],
      attention: [],
      traffic: [],
    });
  }

  const orders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      ...orderPeriodWhere(range),
      orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
    },
    select: {
      storeId: true, orderId: true, productId: true, productName: true, quantity: true,
      calcGmv: true, platformCommission: true, platformServiceFee: true,
      sellerCoupon: true, lmmDiscount: true, escrowAmount: true, calcProductCost: true,
      calcPackaging: true, orderCategory: true,
      product: {
        select: {
          id: true, parentId: true, name: true, sku: true, stock: true, minStock: true,
          listPrice: true, costPrice: true, category: true,
          parent: { select: { id: true, name: true, sku: true, stock: true, minStock: true, listPrice: true, costPrice: true, category: true } },
        },
      },
      store: { select: { name: true, marketplace: true } },
    },
  });

  const products = new Map();
  const uniqueOrders = new Set();
  let totalGmv = 0;
  let totalProfit = 0;
  let totalUnits = 0;

  for (const order of orders) {
    const calc = calcOrderProfit(order, taxRateMap);
    const baseProduct = order.product?.parent ?? order.product;
    const baseName = normalizeProductName(baseProduct?.name ?? order.productName ?? 'Produto sem nome');
    const key = baseProduct?.id ?? `name:${baseName.toLowerCase()}`;
    if (!products.has(key)) {
      products.set(key, {
        id: key,
        name: baseName,
        sku: baseProduct?.sku ?? null,
        marketplace: order.store?.marketplace ?? null,
        storeName: order.store?.name ?? null,
        stock: baseProduct?.stock ?? null,
        minStock: baseProduct?.minStock ?? null,
        listPrice: baseProduct?.listPrice ?? null,
        costPrice: baseProduct?.costPrice ?? null,
        category: baseProduct?.category ?? null,
        breakRisk: estimateBreakRisk(baseProduct ?? { name: baseName }),
        variants: new Set(),
        ordersSet: new Set(),
        orders: 0,
        units: 0,
        gmv: 0,
        netRevenue: 0,
        profit: 0,
        productCost: 0,
        margin: 0,
        avgTicket: 0,
        visits: null,
        conversion: null,
      });
    }

    const item = products.get(key);
    item.ordersSet.add(order.orderId);
    if (order.product?.id && order.product.id !== key) item.variants.add(order.product.id);
    item.units += order.quantity ?? 0;
    item.gmv += order.calcGmv ?? 0;
    item.netRevenue += calc.netRevenue;
    item.profit += calc.profit;
    item.productCost += order.calcProductCost ?? 0;

    uniqueOrders.add(order.orderId);
    totalUnits += order.quantity ?? 0;
    totalGmv += order.calcGmv ?? 0;
    totalProfit += calc.profit;
  }

  let metricRows = [];
  try {
    metricRows = await prisma.productMetricDaily.findMany({
      where: {
        storeId: { in: storeIds },
        metricDate: { gte: range.start, lte: range.end },
      },
      select: {
        productId: true, externalId: true, marketplace: true, visits: true, clicks: true,
        impressions: true, conversion: true, adSpend: true, adRevenue: true, adOrders: true,
        product: { select: { id: true, parentId: true, name: true, sku: true, stock: true, minStock: true, listPrice: true, costPrice: true, category: true, parent: { select: { id: true, name: true, sku: true, stock: true, minStock: true, listPrice: true, costPrice: true, category: true } } } },
        store: { select: { name: true, marketplace: true } },
      },
    });
  } catch (err) {
    console.warn('[AppProducts] métricas indisponíveis:', err.message);
  }

  for (const metric of metricRows) {
    const baseProduct = metric.product?.parent ?? metric.product;
    const baseName = normalizeProductName(baseProduct?.name ?? `Anúncio ${metric.externalId ?? ''}`.trim());
    const key = baseProduct?.id ?? `external:${metric.externalId}`;

    if (!products.has(key)) {
      products.set(key, {
        id: key,
        name: baseName || 'Produto sem nome',
        sku: baseProduct?.sku ?? null,
        marketplace: metric.store?.marketplace ?? metric.marketplace,
        storeName: metric.store?.name ?? null,
        stock: baseProduct?.stock ?? null,
        minStock: baseProduct?.minStock ?? null,
        listPrice: baseProduct?.listPrice ?? null,
        costPrice: baseProduct?.costPrice ?? null,
        category: baseProduct?.category ?? null,
        breakRisk: estimateBreakRisk(baseProduct ?? { name: baseName }),
        variants: new Set(),
        ordersSet: new Set(),
        orders: 0,
        units: 0,
        gmv: 0,
        netRevenue: 0,
        profit: 0,
        productCost: 0,
        margin: 0,
        avgTicket: 0,
        visits: 0,
        clicks: 0,
        impressions: 0,
        adSpend: 0,
        adRevenue: 0,
        adOrders: 0,
        conversion: null,
      });
    }

    const item = products.get(key);
    item.visits = (item.visits ?? 0) + (metric.visits ?? 0);
    item.clicks = (item.clicks ?? 0) + (metric.clicks ?? 0);
    item.impressions = (item.impressions ?? 0) + (metric.impressions ?? 0);
    item.adSpend = (item.adSpend ?? 0) + (metric.adSpend ?? 0);
    item.adRevenue = (item.adRevenue ?? 0) + (metric.adRevenue ?? 0);
    item.adOrders = (item.adOrders ?? 0) + (metric.adOrders ?? 0);
    if (metric.conversion != null) item.conversion = metric.conversion;
  }

  const productList = Array.from(products.values()).map((item) => {
    const ordersCount = item.ordersSet.size;
    const margin = item.gmv > 0 ? r2((item.profit / item.gmv) * 100) : 0;
    const avgTicket = ordersCount > 0 ? r2(item.gmv / ordersCount) : 0;
    const conversion = item.visits > 0 ? r2((ordersCount / item.visits) * 100) : item.conversion;
    const adsRoi = item.adSpend > 0 ? r2((item.adRevenue ?? 0) / item.adSpend) : null;
    const acos = item.adRevenue > 0 ? r2(((item.adSpend ?? 0) / item.adRevenue) * 100) : null;
    const stockRisk = item.stock != null && item.minStock != null && item.stock <= item.minStock;
    const avgUnitCost = item.units > 0 ? r2((item.productCost ?? 0) / item.units) : 0;
    item.avgUnitCost = avgUnitCost;
    const championScore = buildChampionScore(item);
    const investScore = r2(
      Math.max(0, item.profit) * 0.55 +
      Math.max(0, margin) * 8 +
      Math.max(0, item.units) * 3 +
      (adsRoi != null && adsRoi > 1 ? adsRoi * 25 : 0) -
      (item.adSpend > 0 && (!item.adRevenue || item.adRevenue <= item.adSpend) ? item.adSpend * 0.2 : 0)
    );

    const { ordersSet, variants, ...clean } = item;
    return {
      ...clean,
      orders: ordersCount,
      variantCount: variants.size,
      gmv: r2(item.gmv),
      netRevenue: r2(item.netRevenue),
      profit: r2(item.profit),
      margin,
      avgTicket,
      visits: item.visits ?? 0,
      clicks: item.clicks ?? null,
      impressions: item.impressions ?? null,
      adSpend: r2(item.adSpend ?? 0),
      adRevenue: r2(item.adRevenue ?? 0),
      adOrders: item.adOrders ?? 0,
      adsRoi,
      acos,
      conversion,
      avgUnitCost,
      stockRisk,
      championScore: championScore.score,
      scoreBreakdown: championScore,
      investScore,
      recommendation:
        item.profit < 0 ? 'Rever preço/custo antes de escalar' :
        stockRisk ? 'Vende bem, mas estoque pede atenção' :
        item.adSpend > 0 && item.adRevenue > item.adSpend ? 'Ads com retorno: bom candidato para investir' :
        item.adSpend > 0 && (!item.adRevenue || item.adRevenue <= item.adSpend) ? 'Ads consome verba sem retorno suficiente' :
        item.visits > 0 && conversion != null && conversion < 1 ? 'Tem visita, mas converte pouco' :
        margin >= 15 && item.units >= 2 ? 'Bom candidato para investir' :
        'Acompanhar desempenho',
    };
  });

  const champions = [...productList]
    .sort((a, b) => b.championScore - a.championScore || b.units - a.units || b.profit - a.profit)
    .slice(0, 8);

  const opportunities = [...productList]
    .filter((item) => item.profit > 0 && item.margin > 0)
    .sort((a, b) => b.investScore - a.investScore)
    .slice(0, 8);

  const attention = [...productList]
    .filter((item) => item.profit < 0 || item.margin < 5 || item.stockRisk || (item.visits > 0 && item.conversion != null && item.conversion < 1))
    .sort((a, b) => a.profit - b.profit || a.margin - b.margin)
    .slice(0, 8);

  const traffic = [...productList]
    .filter((item) => item.visits > 0 || item.clicks > 0 || item.impressions > 0 || item.adSpend > 0)
    .sort((a, b) => (b.visits ?? 0) - (a.visits ?? 0) || (b.clicks ?? 0) - (a.clicks ?? 0))
    .slice(0, 12);

  return res.json({
    period,
    periodLabel: range.label,
    periodRange: { start: range.start, end: range.end, timezone: range.timezone },
    trafficAvailable: traffic.length > 0,
    championFormula: {
      label: 'Quantidade vendida, menor risco estimado, recompra/custo baixo e lucro',
      preciseSignals: { quantity: true, profit: true, breakRisk: false, reorderCost: false },
    },
    summary: {
      products: productList.length,
      orders: uniqueOrders.size,
      units: totalUnits,
      gmv: r2(totalGmv),
      profit: r2(totalProfit),
      margin: totalGmv > 0 ? r2((totalProfit / totalGmv) * 100) : 0,
    },
    champions,
    opportunities,
    attention,
    traffic,
  });
}

async function getAppProductMetrics(req, res) {
  const { storeId, period = 'today' } = req.query;
  const userId = req.userId;
  const range = getPeriodRange(period);

  const stores = await prisma.store.findMany({
    where: { userId, ...(storeId ? { id: storeId } : {}) },
    select: { id: true },
  });
  const storeIds = stores.map((store) => store.id);

  let rows = [];
  try {
    rows = await prisma.productMetricDaily.findMany({
      where: {
        storeId: { in: storeIds },
        metricDate: { gte: range.start, lte: range.end },
      },
      select: {
        storeId: true, productId: true, externalId: true, marketplace: true, metricDate: true,
        visits: true, clicks: true, impressions: true, conversion: true,
        adSpend: true, adRevenue: true, adOrders: true, source: true,
        product: { select: { id: true, parentId: true, name: true, sku: true, parent: { select: { id: true, name: true, sku: true } } } },
        store: { select: { name: true, marketplace: true } },
      },
      orderBy: [{ metricDate: 'desc' }, { visits: 'desc' }],
    });
  } catch (err) {
    console.warn('[AppProductMetrics] métricas indisponíveis:', err.message);
  }

  const byProduct = new Map();
  for (const row of rows) {
    const baseProduct = row.product?.parent ?? row.product;
    const key = baseProduct?.id ?? `external:${row.externalId}`;
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        id: key,
        name: baseProduct?.name ?? `Anúncio ${row.externalId}`,
        sku: baseProduct?.sku ?? null,
        marketplace: row.store?.marketplace ?? row.marketplace,
        storeName: row.store?.name ?? null,
        visits: 0,
        clicks: 0,
        impressions: 0,
        adSpend: 0,
        adRevenue: 0,
        adOrders: 0,
        conversion: null,
        days: [],
      });
    }

    const item = byProduct.get(key);
    item.visits += row.visits ?? 0;
    item.clicks += row.clicks ?? 0;
    item.impressions += row.impressions ?? 0;
    item.adSpend += row.adSpend ?? 0;
    item.adRevenue += row.adRevenue ?? 0;
    item.adOrders += row.adOrders ?? 0;
    if (row.conversion != null) item.conversion = row.conversion;
    item.days.push({
      date: row.metricDate,
      visits: row.visits,
      clicks: row.clicks,
      impressions: row.impressions,
      conversion: row.conversion,
      adSpend: row.adSpend,
      adRevenue: row.adRevenue,
      adOrders: row.adOrders,
      source: row.source,
    });
  }

  const products = Array.from(byProduct.values()).sort((a, b) => b.visits - a.visits);
  return res.json({
    period,
    periodLabel: range.label,
    periodRange: { start: range.start, end: range.end, timezone: range.timezone },
    summary: {
      products: products.length,
      visits: products.reduce((sum, item) => sum + item.visits, 0),
      clicks: products.reduce((sum, item) => sum + (item.clicks ?? 0), 0),
      impressions: products.reduce((sum, item) => sum + (item.impressions ?? 0), 0),
      adSpend: r2(products.reduce((sum, item) => sum + (item.adSpend ?? 0), 0)),
      adRevenue: r2(products.reduce((sum, item) => sum + (item.adRevenue ?? 0), 0)),
      adOrders: products.reduce((sum, item) => sum + (item.adOrders ?? 0), 0),
    },
    products,
  });
}

async function getAppAlerts(req, res) {
  const { storeId } = req.query;
  const userId = req.userId;
  const { r2 } = require('../lib/utils');

  const stores = await prisma.store.findMany({
    where: { userId, ...(storeId ? { id: storeId } : {}) },
    select: { id: true, taxRate: true, name: true, marketplace: true },
  });
  const storeIds = stores.map(s => s.id);
  const taxRateMap = Object.fromEntries(stores.map(s => [s.id, s.taxRate ?? 0]));

  const todayRange = getPeriodRange('today');
  const weekRange = getPeriodRange('7d');

  const [todayOrders, weekOrders, noCostCount] = await Promise.all([
    prisma.order.findMany({
      where: { storeId: { in: storeIds }, ...orderPeriodWhere(todayRange), orderCategory: { in: ['valid', 'pending', 'returned_partial'] } },
      select: { calcGmv: true, platformCommission: true, platformServiceFee: true, sellerCoupon: true, lmmDiscount: true, escrowAmount: true, calcProductCost: true, calcPackaging: true, orderCategory: true, storeId: true, productName: true, orderId: true },
    }),
    prisma.order.findMany({
      where: { storeId: { in: storeIds }, ...orderPeriodWhere(weekRange), orderCategory: { in: ['valid', 'pending', 'returned_partial'] } },
      select: { calcGmv: true, platformCommission: true, platformServiceFee: true, sellerCoupon: true, lmmDiscount: true, escrowAmount: true, calcProductCost: true, calcPackaging: true, orderCategory: true, storeId: true },
    }),
    prisma.product.count({ where: { storeId: { in: storeIds }, costPrice: 0 } }),
  ]);

  const calcProfit = (o) => {
    const taxRate = taxRateMap[o.storeId] ?? 0;
    const fee = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
    const disc = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
    const repasse = o.orderCategory === 'valid' && o.escrowAmount != null ? r2(o.escrowAmount) : r2(o.calcGmv - fee - disc);
    return r2(repasse - r2(o.calcGmv * (taxRate / 100)) - (o.calcProductCost ?? 0) - (o.calcPackaging ?? 0));
  };

  const alerts = [];

  // Pedidos com prejuízo hoje
  const lossOrders = todayOrders.filter(o => calcProfit(o) < 0);
  if (lossOrders.length > 0) {
    const totalLoss = r2(lossOrders.reduce((s, o) => s + calcProfit(o), 0));
    alerts.push({ type: 'loss', priority: 'high', title: `${lossOrders.length} pedido${lossOrders.length > 1 ? 's' : ''} com prejuízo`, subtitle: `Total de R$ ${Math.abs(totalLoss).toFixed(2)} hoje`, time: new Date().toISOString() });
  }

  // Devoluções aguardando
  const returns = await prisma.order.count({ where: { storeId: { in: storeIds }, ...orderPeriodWhere(todayRange), orderCategory: { in: ['returned_full', 'returned_partial'] } } });
  if (returns > 0) {
    alerts.push({ type: 'return', priority: 'high', title: `${returns} devolução${returns > 1 ? 'ões' : ''} aguardando`, subtitle: `Verifique os pedidos devolvidos hoje`, time: new Date().toISOString() });
  }

  // Produtos sem custo
  if (noCostCount > 0) {
    alerts.push({ type: 'no_cost', priority: 'medium', title: `${noCostCount} produto${noCostCount > 1 ? 's' : ''} sem custo`, subtitle: `Cadastre o custo para cálculo correto do lucro`, time: new Date().toISOString() });
  }

  // Margem caindo
  const todayProfit = r2(todayOrders.reduce((s, o) => s + calcProfit(o), 0));
  const todayGmv    = r2(todayOrders.reduce((s, o) => s + o.calcGmv, 0));
  const weekProfit  = r2(weekOrders.reduce((s, o) => s + calcProfit(o), 0));
  const weekGmv     = r2(weekOrders.reduce((s, o) => s + o.calcGmv, 0));
  const todayMargin = todayGmv > 0 ? (todayProfit / todayGmv) * 100 : 0;
  const weekMargin  = weekGmv  > 0 ? (weekProfit  / weekGmv)  * 100 : 0;
  const marginDiff  = todayMargin - weekMargin;
  if (marginDiff < -3 && weekMargin > 0) {
    alerts.push({ type: 'margin', priority: 'medium', title: `Margem caiu ${Math.abs(marginDiff).toFixed(1)}%`, subtitle: `Comparado à média dos últimos 7 dias`, time: new Date().toISOString() });
  }

  // Canal dominante
  const byChannel = {};
  for (const o of weekOrders) {
    const store = stores.find(s => s.id === o.storeId);
    const mp = store?.marketplace ?? 'outro';
    byChannel[mp] = (byChannel[mp] ?? 0) + o.calcGmv;
  }
  const topChannel = Object.entries(byChannel).sort((a, b) => b[1] - a[1])[0];
  if (topChannel && weekGmv > 0) {
    const pct = Math.round((topChannel[1] / weekGmv) * 100);
    if (pct > 80) {
      const label = { shopee: 'Shopee', mercadolivre: 'Mercado Livre', tiktok: 'TikTok', shein: 'Shein' }[topChannel[0]] ?? topChannel[0];
      alerts.push({ type: 'channel', priority: 'info', title: `${label} representa ${pct}%`, subtitle: `Do faturamento total dos últimos 7 dias`, time: new Date().toISOString() });
    }
  }

  return res.json({ alerts });
}

async function getAppOrderDetail(req, res) {
  const { orderId } = req.params;
  const userId = req.userId;
  const { r2 } = require('../lib/utils');

  const stores = await prisma.store.findMany({
    where: { userId },
    select: { id: true, taxRate: true, marketplace: true },
  });
  const storeIds = stores.map(s => s.id);
  const taxRateMap = Object.fromEntries(stores.map(s => [s.id, s.taxRate ?? 0]));

  const orders = await prisma.order.findMany({
    where: { orderId, storeId: { in: storeIds } },
    select: {
      id: true, orderId: true, lineItemKey: true, storeId: true, soldAt: true,
      productName: true, quantity: true, agreedPrice: true,
      calcGmv: true, platformCommission: true, platformServiceFee: true,
      sellerCoupon: true, lmmDiscount: true, escrowAmount: true,
      calcProductCost: true, calcPackaging: true, orderCategory: true,
      product: { select: { name: true, sku: true } },
    },
  });

  if (!orders.length) return res.status(404).json({ error: 'Pedido não encontrado' });

  const store = stores.find(s => s.id === orders[0].storeId);
  const taxRate = taxRateMap[orders[0].storeId] ?? 0;

  const items = orders.map(o => {
    const fee  = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
    const disc = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
    const repasse = o.orderCategory === 'valid' && o.escrowAmount != null ? r2(o.escrowAmount) : r2(o.calcGmv - fee - disc);
    const tax    = r2(o.calcGmv * (taxRate / 100));
    const cost   = o.calcProductCost ?? 0;
    const pkg    = o.calcPackaging   ?? 0;
    const profit = r2(repasse - tax - cost - pkg);
    return {
      productName: o.product?.name ?? o.productName,
      sku: o.product?.sku,
      quantity: o.quantity,
      gmv: o.calcGmv,
      marketplaceFee: fee,
      discount: disc,
      tax, cost, packaging: pkg, profit,
      margin: o.calcGmv > 0 ? r2((profit / o.calcGmv) * 100) : 0,
    };
  });

  const totals = {
    gmv:          r2(items.reduce((s, i) => s + i.gmv, 0)),
    marketplaceFee: r2(items.reduce((s, i) => s + i.marketplaceFee, 0)),
    tax:          r2(items.reduce((s, i) => s + i.tax, 0)),
    cost:         r2(items.reduce((s, i) => s + i.cost, 0)),
    packaging:    r2(items.reduce((s, i) => s + i.packaging, 0)),
    profit:       r2(items.reduce((s, i) => s + i.profit, 0)),
  };

  return res.json({
    orderId,
    marketplace: store?.marketplace,
    soldAt: orders[0].soldAt,
    status: orders[0].orderCategory,
    items,
    totals,
  });
}

module.exports = { generateCode, verifyCode, getAppDashboard, getAppTrends, getAppProducts, getAppProductMetrics, getAppAlerts, getAppOrderDetail };
