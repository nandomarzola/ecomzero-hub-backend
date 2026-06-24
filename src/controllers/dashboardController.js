const prisma = require('../lib/prisma');
const { generateMonthlyReport } = require('../services/reportService');
const { parseYearMonth, r2 } = require('../lib/utils');

const APP_TIMEZONE = 'America/Sao_Paulo';
const REVENUE_ORDER_CATEGORIES = ['valid', 'pending', 'returned_partial'];
const UPSELLER_VALID_CATEGORIES = ['valid', 'pending', 'returned_partial'];

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
  // Shopee BR e os exports diários usam o dia local. O servidor pode estar em UTC.
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute, second, millisecond));
}

function parseYmd(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const [year, month, day] = String(value).split('-').map(Number);
  return { year, month, day };
}

function buildDateRange(startDate, endDate) {
  if (!startDate && !endDate) return null;
  const startParts = parseYmd(startDate) ?? parseYmd(endDate);
  const endParts = parseYmd(endDate) ?? parseYmd(startDate);
  if (!startParts || !endParts) return null;
  return {
    start: saoPauloDateToUtc(startParts.year, startParts.month, startParts.day),
    end: saoPauloDateToUtc(endParts.year, endParts.month, endParts.day, 23, 59, 59, 999),
    startDate: `${startParts.year}-${String(startParts.month).padStart(2, '0')}-${String(startParts.day).padStart(2, '0')}`,
    endDate: `${endParts.year}-${String(endParts.month).padStart(2, '0')}-${String(endParts.day).padStart(2, '0')}`,
    timezone: APP_TIMEZONE,
  };
}

function buildDateFilter(startDate, endDate) {
  const range = buildDateRange(startDate, endDate);
  if (!range) return undefined;
  return { gte: range.start, lte: range.end };
}

// Calcula o período anterior com a mesma duração fechada.
function buildPrevDateRange(range) {
  if (!range) return null;
  const durationMs = range.end.getTime() - range.start.getTime();
  const prevEnd = new Date(range.start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - durationMs);
  return { start: prevStart, end: prevEnd, timezone: APP_TIMEZONE };
}

function orderPeriodWhere(range) {
  if (!range) return {};
  return {
    OR: [
      { orderCreatedAt: { gte: range.start, lte: range.end } },
      { orderCreatedAt: null, soldAt: { gte: range.start, lte: range.end } },
    ],
  };
}

function paidPeriodWhere(range) {
  if (!range) return {};
  return { orderPaidAt: { gte: range.start, lte: range.end } };
}

function formatSaoPauloDay(date) {
  const parts = getZonedParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function getOrderUniqueKey(order) {
  return order.orderId || order.id;
}

function addUnique(bucket, order) {
  const key = getOrderUniqueKey(order);
  if (key) bucket.orderIds.add(key);
  bucket.lines += 1;
  bucket.units += order.quantity ?? 0;
}

function summarizeOrderBreakdown(orders) {
  const makeBucket = () => ({ orderIds: new Set(), lines: 0, units: 0 });
  const cancelledUnpaidOrderIds = new Set(
    orders
      .filter((order) => order.orderCategory === 'cancelled_unpaid')
      .map(getOrderUniqueKey)
      .filter(Boolean)
  );
  const buckets = {
    created: makeBucket(),
    paid: makeBucket(),
    valid: makeBucket(),
    pending: makeBucket(),
    unpaid: makeBucket(),
    cancelled: makeBucket(),
    paidCancelled: makeBucket(),
    returned: makeBucket(),
  };

  for (const order of orders) {
    const rawStatus = String(order.orderStatus ?? '').toUpperCase();
    const hasPayment = !!order.orderPaidAt || (
      order.orderCategory !== 'cancelled_unpaid' && REVENUE_ORDER_CATEGORIES.includes(order.orderCategory)
    );
    const isOpenUnpaid = !hasPayment && rawStatus === 'UNPAID';
    const isCancelled = order.orderCategory?.startsWith('cancelled') || rawStatus === 'CANCELLED';
    const isCancelledWithoutPayment = !hasPayment && isCancelled;
    const orderKey = getOrderUniqueKey(order);
    const hasUnpaidCancellationLine = orderKey && cancelledUnpaidOrderIds.has(orderKey);
    const hasRealBuyer = !!order.buyerUsername && order.buyerUsername !== '-';

    addUnique(buckets.created, order);
    if (hasPayment) addUnique(buckets.paid, order);
    if (order.orderCategory === 'valid') addUnique(buckets.valid, order);
    if (order.orderCategory === 'pending') addUnique(buckets.pending, order);
    if (isOpenUnpaid) addUnique(buckets.unpaid, order);
    if (isCancelledWithoutPayment) addUnique(buckets.cancelled, order);
    if (hasPayment && isCancelled && hasRealBuyer && !hasUnpaidCancellationLine) addUnique(buckets.paidCancelled, order);
    if (['returned_full', 'returned_partial'].includes(order.orderCategory)) addUnique(buckets.returned, order);
  }

  return Object.fromEntries(Object.entries(buckets).map(([key, bucket]) => [
    key,
    { orders: bucket.orderIds.size, lines: bucket.lines, units: bucket.units },
  ]));
}

function summarizeUniqueOrders(orders, predicate, valueSelector) {
  const byOrder = new Map();
  for (const order of orders) {
    if (predicate && !predicate(order)) continue;
    const key = getOrderUniqueKey(order);
    if (!key) continue;
    if (!byOrder.has(key)) byOrder.set(key, { units: 0, value: 0 });
    const bucket = byOrder.get(key);
    bucket.units += order.quantity ?? 0;
    bucket.value = Math.max(bucket.value, valueSelector(order) ?? 0);
  }
  const values = [...byOrder.values()];
  return {
    orders: byOrder.size,
    units: values.reduce((sum, item) => sum + item.units, 0),
    value: values.reduce((sum, item) => sum + item.value, 0),
  };
}

function countUniqueOrders(orders) {
  return new Set(orders.map(getOrderUniqueKey).filter(Boolean)).size;
}

function isUpsellerValidOrder(order) {
  const rawStatus = String(order.orderStatus ?? '').toUpperCase();
  return UPSELLER_VALID_CATEGORIES.includes(order.orderCategory) && rawStatus !== 'CANCELLED';
}

function isConfirmedPaidOrder(order, marketplace) {
  const rawStatus = String(order.orderStatus ?? '').toUpperCase();
  if (rawStatus === 'CANCELLED') return false;
  if (!['valid', 'returned_partial'].includes(order.orderCategory)) return false;
  if (String(marketplace ?? '').toLowerCase() === 'shopee') {
    return order.escrowAmount !== null && order.escrowAmount !== undefined;
  }
  return !!order.orderPaidAt || order.status === 'paid';
}

function confirmedProfit(order, marketplace, taxRate = 0) {
  if (!isConfirmedPaidOrder(order, marketplace)) return 0;
  // Cadeia canônica — idêntica ao closingController.buildClosingData linhas 180-192.
  // Nunca lê calcShopeeFee, calcNetRevenue ou calcTax como entrada do cálculo.
  const fee     = r2((order.platformCommission ?? 0) + (order.platformServiceFee ?? 0));
  const disc    = r2((order.sellerCoupon ?? 0) + (order.lmmDiscount ?? 0));
  const net     = r2((order.calcGmv ?? 0) - fee - disc);
  const hasEscrow = order.escrowAmount !== null && order.escrowAmount !== undefined;
  const repasse = hasEscrow ? r2(order.escrowAmount) : net;
  const tax     = r2((order.calcGmv ?? 0) * taxRate / 100);
  return r2(repasse - tax - (order.calcProductCost ?? 0) - (order.calcPackaging ?? 0));
}

function expectedRepasse(order, marketplace) {
  if (isConfirmedPaidOrder(order, marketplace)) {
    return String(marketplace ?? '').toLowerCase() === 'shopee'
      ? (order.escrowAmount ?? 0)
      : (order.calcNetRevenue ?? order.escrowAmount ?? 0);
  }
  if (!REVENUE_ORDER_CATEGORIES.includes(order.orderCategory)) return 0;
  return order.calcNetRevenue > 0 ? order.calcNetRevenue : null;
}

function expectedProfit(order, marketplace) {
  if (!REVENUE_ORDER_CATEGORIES.includes(order.orderCategory)) return 0;
  const repasse = expectedRepasse(order, marketplace);
  if (repasse === null || repasse === undefined) return null;
  return repasse - (order.calcProductCost ?? 0) - (order.calcTax ?? 0);
}

// GET /api/dashboard/summary
async function getSummary(req, res) {
  const { storeId, startDate, endDate, periodKey } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;

  const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true, name: true, marketplace: true, taxRate: true } });
  const storeIds           = stores.map((s) => s.id);
  const marketplaceByStore = Object.fromEntries(stores.map((s) => [s.id, s.marketplace]));
  const storeNameByStore   = Object.fromEntries(stores.map((s) => [s.id, s.name]));
  const taxRateByStore     = Object.fromEntries(stores.map((s) => [s.id, s.taxRate ?? 0]));

  if (!storeIds.length) {
    return res.json({
      totalRevenue: 0, totalProfit: 0, avgMargin: 0, totalOrders: 0, avgTicket: 0,
      confirmedRepasse: 0, confirmedNetRevenue: 0, confirmedProfit: 0, confirmedRepasseOrders: 0,
      estimatedRepasse: 0, estimatedNetRevenue: 0, estimatedProfit: 0, awaitingRepasseOrders: 0,
      projectedRepasse: 0, projectedProfit: 0, projectedMargin: 0, projectedGmv: 0,
      negativeMargin: 0, topProducts: [], worstProducts: [], monthlyChart: [],
      costsBreakdown: {}, prevKPIs: null, sparkline: [], channelBreakdown: [], dailyHeatmap: [],
      closedRevenue: { total: 0, months: [] },
    });
  }

  const dateRange = buildDateRange(startDate, endDate);
  const rangeDays = dateRange
    ? Math.max(1, Math.round((dateRange.end.getTime() - dateRange.start.getTime() + 1) / 86400000))
    : null;
  const periodWhere = orderPeriodWhere(dateRange);
  const paidWhere = paidPeriodWhere(dateRange);
  const allOrderWhere = {
    storeId: { in: storeIds },
    ...periodWhere,
  };
  const revenueOrderWhere = {
    storeId: { in: storeIds },
    ...paidWhere,
    orderCategory: { in: REVENUE_ORDER_CATEGORIES },
  };

  // Período anterior para comparação
  const prevRange = buildPrevDateRange(dateRange);

  // Sparkline: últimos 6 meses
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setUTCHours(0, 0, 0, 0);

  // Busca paralela: todos os dados de uma vez
  const [orders, prevOrdersRaw, prevRevenueOrdersRaw, sparkOrdersRaw, itemsRaw, singleStore, closedClosingsRaw, allPeriodRaw] = await Promise.all([
    prisma.order.findMany({
      where:  revenueOrderWhere,
      select: {
        id: true, salePrice: true, profit: true, calcGrossProfit: true, margin: true, soldAt: true,
        orderCreatedAt: true, orderPaidAt: true, orderStatus: true, quantity: true, calcGmv: true,
        storeId: true, orderId: true, orderCategory: true, buyerUsername: true, globalTotal: true,
        status: true, escrowAmount: true, calcNetRevenue: true, calcProductCost: true, calcTax: true,
        platformCommission: true, platformServiceFee: true, sellerCoupon: true, lmmDiscount: true, calcPackaging: true,
      },
    }),
    prevRange
      ? prisma.order.findMany({
          where:  { storeId: { in: storeIds }, ...orderPeriodWhere(prevRange) },
          select: {
            id: true, salePrice: true, profit: true, calcGrossProfit: true, calcGmv: true, margin: true, orderId: true,
            orderCategory: true, buyerUsername: true, globalTotal: true, quantity: true,
            orderStatus: true, orderPaidAt: true, orderCreatedAt: true, soldAt: true,
            status: true, escrowAmount: true, calcNetRevenue: true, calcProductCost: true, calcTax: true, storeId: true,
            platformCommission: true, platformServiceFee: true, sellerCoupon: true, lmmDiscount: true, calcPackaging: true,
          },
        })
      : Promise.resolve([]),
    prevRange
      ? prisma.order.findMany({
          where:  { storeId: { in: storeIds }, ...paidPeriodWhere(prevRange), orderCategory: { in: REVENUE_ORDER_CATEGORIES } },
          select: {
            id: true, salePrice: true, profit: true, calcGrossProfit: true, calcGmv: true, margin: true, orderId: true,
            orderCategory: true, buyerUsername: true, globalTotal: true, quantity: true,
            orderStatus: true, orderPaidAt: true, orderCreatedAt: true, soldAt: true,
            status: true, escrowAmount: true, calcNetRevenue: true, calcProductCost: true, calcTax: true, storeId: true,
            platformCommission: true, platformServiceFee: true, sellerCoupon: true, lmmDiscount: true, calcPackaging: true,
          },
        })
      : Promise.resolve([]),
    prisma.order.findMany({
      where:  { storeId: { in: storeIds }, orderCategory: { in: REVENUE_ORDER_CATEGORIES }, orderPaidAt: { gte: sixMonthsAgo } },
      select: {
        salePrice: true, profit: true, calcGrossProfit: true, margin: true, soldAt: true, orderCreatedAt: true, orderId: true,
        storeId: true, orderCategory: true, orderStatus: true, orderPaidAt: true, status: true,
        escrowAmount: true, calcNetRevenue: true, calcProductCost: true, calcTax: true, calcGmv: true,
      },
    }),
    prisma.order.findMany({
      where:   { ...revenueOrderWhere, productId: { not: null } },
      select: {
        productId:          true,
        storeId:            true,
        quantity:           true,
        calcGmv:            true,
        calcGrossProfit:    true,
        calcProductCost:    true,
        calcShopeeFee:      true,
        calcTax:            true,
        platformServiceFee: true,
        shopeeShippingCost: true,
        profit:             true,
        margin:             true,
        orderCategory:      true,
        orderStatus:        true,
        orderPaidAt:        true,
        status:             true,
        escrowAmount:       true,
        calcNetRevenue:     true,
        product: { select: { id: true, name: true, costPrice: true, packaging: true } },
      },
    }),
    storeIds.length === 1
      ? prisma.store.findUnique({ where: { id: storeIds[0] } })
      : Promise.resolve(null),
    prisma.monthlyClosing.findMany({
      where:  { storeId: { in: storeIds }, status: 'closed' },
      select: { periodMonth: true, gmvTotal: true },
    }),
    // Todos os pedidos do período por data de criação — base Shopee/Upseller.
    prisma.order.findMany({
      where:  allOrderWhere,
      select: {
        id: true, storeId: true, orderId: true, orderCategory: true, orderStatus: true,
        orderPaidAt: true, orderCreatedAt: true, soldAt: true, globalTotal: true,
        calcGmv: true, salePrice: true, status: true, escrowAmount: true,
        calcNetRevenue: true, calcProductCost: true, calcTax: true,
        buyerUsername: true, quantity: true,
      },
    }),
  ]);

  const orderProfit = (o) => confirmedProfit(o, marketplaceByStore[o.storeId], taxRateByStore[o.storeId]);

  // ── KPIs do período atual ──────────────────────────────────────────────────
  const breakdown = summarizeOrderBreakdown(allPeriodRaw);
  const upsellerValid = summarizeUniqueOrders(
    orders,
    isUpsellerValidOrder,
    (order) => order.globalTotal ?? order.calcGmv ?? order.salePrice ?? 0
  );
  const allGenerated = summarizeUniqueOrders(
    allPeriodRaw,
    null,
    (order) => order.globalTotal ?? order.calcGmv ?? order.salePrice ?? 0
  );
  const createdOrders = breakdown.created.orders;
  const createdUnits = breakdown.created.units;
  const paidOrders = upsellerValid.orders;
  const paidUnits = upsellerValid.units;
  const validOrders = upsellerValid.orders;
  const unpaidOrders = breakdown.unpaid.orders;
  const unpaidUnits = breakdown.unpaid.units;
  const cancelledOrders = breakdown.cancelled.orders;
  const cancelledUnits = breakdown.cancelled.units;
  const paidCancelledOrders = breakdown.paidCancelled.orders;
  const paidCancelledUnits = breakdown.paidCancelled.units;

  const totalOrders = paidOrders;
  const allClientsSet  = new Set(allPeriodRaw.map(o => o.buyerUsername).filter(Boolean));
  const totalSales = allGenerated.value;
  const validSales = upsellerValid.value;
  const allClientsCount = allClientsSet.size;

  // Clientes únicos (buyerUsername distinto) — fallback para orders (status=paid) se allPeriodRaw vazio
  const clientsSet    = allClientsCount > 0 ? allClientsSet : new Set(orders.map(o => o.buyerUsername).filter(Boolean));
  const clientsCount  = clientsSet.size;

  const totalItems    = paidUnits;
  const totalRevenue  = validSales;
  const confirmedOrders = orders.filter((o) => isConfirmedPaidOrder(o, marketplaceByStore[o.storeId]));
  const profitRevenueBase = confirmedOrders
    .reduce((s, o) => s + (o.calcGmv ?? o.salePrice ?? 0), 0);
  const totalProfit   = confirmedOrders.reduce((s, o) => s + orderProfit(o), 0);
  const avgMargin     = profitRevenueBase > 0 ? (totalProfit / profitRevenueBase) * 100 : 0;
  const confirmedRepasse = confirmedOrders.reduce((s, o) => s + expectedRepasse(o, marketplaceByStore[o.storeId]), 0);
  const confirmedRepasseOrders = countUniqueOrders(confirmedOrders);
  const estimatedOrders = orders.filter((o) => (
    REVENUE_ORDER_CATEGORIES.includes(o.orderCategory)
    && !isConfirmedPaidOrder(o, marketplaceByStore[o.storeId])
  ));
  const estimatedOrdersReliable = estimatedOrders.filter((o) => expectedRepasse(o, marketplaceByStore[o.storeId]) !== null);
  const estimatedOrdersUnreliable = estimatedOrders.length - estimatedOrdersReliable.length;
  const awaitingRepasseOrders = countUniqueOrders(estimatedOrders);
  const estimatedProfitOrders = countUniqueOrders(estimatedOrdersReliable);
  const estimatedProfitOrdersUnreliable = Math.max(0, awaitingRepasseOrders - estimatedProfitOrders);
  const estimatedRepasse = estimatedOrdersReliable.reduce((s, o) => s + expectedRepasse(o, marketplaceByStore[o.storeId]), 0);
  const estimatedProfit = estimatedOrdersReliable.reduce((s, o) => s + expectedProfit(o, marketplaceByStore[o.storeId]), 0);
  const projectedProfit = totalProfit + estimatedProfit;
  const estimatedReliableIds = new Set(estimatedOrdersReliable.map((o) => o.id));
  const projectedGmv = orders
    .filter((o) => isConfirmedPaidOrder(o, marketplaceByStore[o.storeId]) || estimatedReliableIds.has(o.id))
    .reduce((s, o) => s + (o.calcGmv ?? o.salePrice ?? 0), 0);
  const projectedMargin = projectedGmv > 0 ? (projectedProfit / projectedGmv) * 100 : 0;
  const avgTicket     = paidOrders ? totalRevenue / paidOrders : 0;
  const salesPerClient = clientsCount > 0 ? totalRevenue / clientsCount : 0;
  const negativeMargin = orders.filter((o) => orderProfit(o) < 0).length;

  // ── Faturamento consolidado (apenas meses fechados) ────────────────────────
  const closedByMonth = {};
  for (const c of closedClosingsRaw) {
    closedByMonth[c.periodMonth] = (closedByMonth[c.periodMonth] ?? 0) + c.gmvTotal;
  }
  const closedRevenue = {
    total: parseFloat(Object.values(closedByMonth).reduce((s, v) => s + v, 0).toFixed(2)),
    months: Object.entries(closedByMonth)
      .map(([month, revenue]) => ({ month, revenue: parseFloat(revenue.toFixed(2)) }))
      .sort((a, b) => b.month.localeCompare(a.month)),
  };

  // ── KPIs do período anterior ───────────────────────────────────────────────
  let prevKPIs = null;
  if (prevRange) {
    const prevBreakdown = summarizeOrderBreakdown(prevOrdersRaw);
    const prevUpsellerValid = summarizeUniqueOrders(
      prevRevenueOrdersRaw,
      isUpsellerValidOrder,
      (order) => order.globalTotal ?? order.calcGmv ?? order.salePrice ?? 0
    );
    const prevGenerated = summarizeUniqueOrders(
      prevOrdersRaw,
      null,
      (order) => order.globalTotal ?? order.calcGmv ?? order.salePrice ?? 0
    );
    const prevRevenueOrders = prevRevenueOrdersRaw.filter(o => REVENUE_ORDER_CATEGORIES.includes(o.orderCategory));
    const prevProfitRevenueBase = prevRevenueOrders
      .filter((o) => isConfirmedPaidOrder(o, marketplaceByStore[o.storeId]))
      .reduce((s, o) => s + (o.calcGmv ?? o.salePrice ?? 0), 0);
    const prevClients    = new Set(prevOrdersRaw.map(o => o.buyerUsername).filter(Boolean));
    const prevPaidCount  = prevUpsellerValid.orders;
    const prevRevenue    = prevUpsellerValid.value;
    const prevProfit     = prevRevenueOrders.reduce((s, o) => s + orderProfit(o), 0);
    const prevClientsCount = prevClients.size;
    prevKPIs = {
      totalRevenue:  parseFloat(prevRevenue.toFixed(2)),
      totalProfit:   parseFloat(prevProfit.toFixed(2)),
      avgMargin:     prevProfitRevenueBase > 0 ? parseFloat(((prevProfit / prevProfitRevenueBase) * 100).toFixed(2)) : 0,
      totalOrders:   prevPaidCount,
      paidOrders:    prevPaidCount,
      paidUnits:     prevUpsellerValid.units,
      createdOrders: prevBreakdown.created.orders,
      createdUnits:  prevBreakdown.created.units,
      unpaidOrders:  prevBreakdown.unpaid.orders,
      cancelledOrders: prevBreakdown.cancelled.orders,
      validOrders:   prevUpsellerValid.orders,
      upsellerValidOrders: prevUpsellerValid.orders,
      upsellerValidUnits: prevUpsellerValid.units,
      upsellerValidRevenue: parseFloat(prevRevenue.toFixed(2)),
      clientsCount:  prevClientsCount,
      salesPerClient: prevClientsCount > 0 ? parseFloat((prevRevenue / prevClientsCount).toFixed(2)) : 0,
      totalSales:    parseFloat(prevGenerated.value.toFixed(2)),
      validRevenue:  parseFloat(prevRevenue.toFixed(2)),
      totalPeriodOrders: prevBreakdown.created.orders,
      avgTicket:     prevPaidCount ? parseFloat((prevRevenue / prevPaidCount).toFixed(2)) : 0,
    };
  }

  // ── Sparkline últimos 6 meses ──────────────────────────────────────────────
  const sparkMap = {};
  for (const o of sparkOrdersRaw) {
    if (!o.orderPaidAt) continue;
    const key = o.orderPaidAt.toISOString().substring(0, 7);
    if (!sparkMap[key]) sparkMap[key] = { revenue: 0, profit: 0, margin: 0, count: 0 };
    sparkMap[key].revenue += o.salePrice;
    sparkMap[key].profit  += orderProfit(o);
    sparkMap[key].margin  += o.margin ?? 0;
    sparkMap[key].count++;
  }
  const nowD = new Date();
  const sparkline = [];
  for (let i = 5; i >= 0; i--) {
    const d   = new Date(nowD.getFullYear(), nowD.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const m   = sparkMap[key] ?? { revenue: 0, profit: 0, margin: 0, count: 0 };
    sparkline.push({
      month:     key,
      revenue:   parseFloat(m.revenue.toFixed(2)),
      profit:    parseFloat(m.profit.toFixed(2)),
      avgMargin: m.count ? parseFloat((m.margin / m.count).toFixed(2)) : 0,
      avgTicket: m.count ? parseFloat((m.revenue / m.count).toFixed(2)) : 0,
      orders:    m.count,
    });
  }

  // ── Top / worst products + costs breakdown ─────────────────────────────────
  const productMap = {};
  const costsAcc   = { commission: 0, serviceFee: 0, tax: 0, cogs: 0, packaging: 0, freight: 0 };

  for (const o of itemsRaw) {
    const pid = o.product?.id ?? o.productId;
    if (!pid) continue;
    if (!productMap[pid]) {
      productMap[pid] = {
        productId:   pid,
        name:        o.product?.name ?? '',
        storeName:   storeNameByStore[o.storeId] ?? '',
        marketplace: marketplaceByStore[o.storeId] ?? 'outros',
        profit: 0, margin: 0, quantity: 0, count: 0, revenue: 0, cogs: 0,
      };
    }
    productMap[pid].profit   += orderProfit(o);
    productMap[pid].margin   += o.margin          ?? 0;
    productMap[pid].quantity += o.quantity;
    productMap[pid].revenue  += o.calcGmv;
    productMap[pid].cogs     += o.calcProductCost;
    productMap[pid].count++;

    costsAcc.commission += o.calcShopeeFee;
    costsAcc.serviceFee += o.platformServiceFee ?? 0;
    costsAcc.tax        += o.calcTax            ?? 0;
    costsAcc.cogs       += o.calcProductCost;
    costsAcc.packaging  += o.product ? (o.product.packaging ?? 0) * o.quantity : 0;
    costsAcc.freight    += o.shopeeShippingCost  ?? 0;
  }

  const costsBreakdown = {
    commission: parseFloat(costsAcc.commission.toFixed(2)),
    serviceFee: parseFloat(costsAcc.serviceFee.toFixed(2)),
    tax:        parseFloat(costsAcc.tax.toFixed(2)),
    cogs:       parseFloat(costsAcc.cogs.toFixed(2)),
    packaging:  parseFloat(costsAcc.packaging.toFixed(2)),
    freight:    parseFloat(costsAcc.freight.toFixed(2)),
  };

  const productList = Object.values(productMap).map((p) => ({
    ...p,
    profit:  parseFloat(p.profit.toFixed(2)),
    margin:  parseFloat((p.count ? p.margin / p.count : 0).toFixed(2)),
    revenue: parseFloat(p.revenue.toFixed(2)),
    cogs:    parseFloat(p.cogs.toFixed(2)),
  }));

  productList.sort((a, b) => b.profit - a.profit);
  const topProducts   = productList.slice(0, 10);
  const worstProducts = [...productList].sort((a, b) => a.profit - b.profit).slice(0, 10);

  // ── Gráfico mensal ─────────────────────────────────────────────────────────
  const monthlyMap = {};
  for (const o of orders) {
    const sourceDate = o.orderPaidAt;
    if (!sourceDate) continue;
    const key = formatSaoPauloDay(sourceDate).substring(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { month: key, revenue: 0, profit: 0 };
    monthlyMap[key].revenue += (o.calcGmv ?? o.salePrice ?? 0);
    monthlyMap[key].profit  += orderProfit(o);
  }
  const monthlyChart = Object.values(monthlyMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, revenue: parseFloat(m.revenue.toFixed(2)), profit: parseFloat(m.profit.toFixed(2)) }));

  // ── Breakdown por canal ────────────────────────────────────────────────────
  const channelMap = {};
  const channelOrderIds = {};
  for (const o of orders) {
    if (!isUpsellerValidOrder(o)) continue;
    const ch = marketplaceByStore[o.storeId] ?? 'outros';
    if (!channelMap[ch]) channelMap[ch] = { channel: ch, revenue: 0, profit: 0, orders: 0 };
    if (!channelOrderIds[ch]) channelOrderIds[ch] = new Set();
    const orderKey = getOrderUniqueKey(o);
    if (channelOrderIds[ch].has(orderKey)) continue;
    channelMap[ch].revenue += (o.globalTotal ?? o.calcGmv ?? o.salePrice ?? 0);
    channelMap[ch].profit  += orderProfit(o);
    channelOrderIds[ch].add(orderKey);
    channelMap[ch].orders = channelOrderIds[ch].size;
  }
  const channelBreakdown = Object.values(channelMap).map((c) => ({
    ...c,
    revenue: parseFloat(c.revenue.toFixed(2)),
    profit:  parseFloat(c.profit.toFixed(2)),
    // share de faturamento (GMV) — vaidade
    share:   totalRevenue > 0 ? parseFloat(((c.revenue / totalRevenue) * 100).toFixed(1)) : 0,
    // share de lucro — realidade; usado para eleger o canal campeão
    profitShare: totalProfit > 0 ? parseFloat(((c.profit / totalProfit) * 100).toFixed(1)) : 0,
  })).sort((a, b) => b.profit - a.profit);

  // ── Heatmap diário (total + por loja) ─────────────────────────────────────
  const dailyMap      = {};
  const dailyByStore  = {}; // storeId → { date → { revenue, orders } }
  const dailyOrderIds = {};
  const dailyStoreOrderIds = {};
  const storeNameMap  = Object.fromEntries(stores.map((s) => [s.id, { name: s.name, marketplace: s.marketplace }]));

  for (const o of orders) {
    if (!isUpsellerValidOrder(o)) continue;
    const sourceDate = o.orderPaidAt;
    if (!sourceDate) continue;
    const day = formatSaoPauloDay(sourceDate);
    const orderKey = getOrderUniqueKey(o);
    // Total
    if (!dailyMap[day]) dailyMap[day] = { date: day, revenue: 0, orders: 0 };
    if (!dailyOrderIds[day]) dailyOrderIds[day] = new Set();
    if (!dailyOrderIds[day].has(orderKey)) {
      dailyMap[day].revenue += (o.globalTotal ?? o.calcGmv ?? o.salePrice ?? 0);
      dailyOrderIds[day].add(orderKey);
      dailyMap[day].orders = dailyOrderIds[day].size;
    }
    // Por loja
    if (!dailyByStore[o.storeId]) dailyByStore[o.storeId] = {};
    if (!dailyByStore[o.storeId][day]) dailyByStore[o.storeId][day] = { date: day, revenue: 0, orders: 0 };
    if (!dailyStoreOrderIds[o.storeId]) dailyStoreOrderIds[o.storeId] = {};
    if (!dailyStoreOrderIds[o.storeId][day]) dailyStoreOrderIds[o.storeId][day] = new Set();
    if (!dailyStoreOrderIds[o.storeId][day].has(orderKey)) {
      dailyByStore[o.storeId][day].revenue += (o.globalTotal ?? o.calcGmv ?? o.salePrice ?? 0);
      dailyStoreOrderIds[o.storeId][day].add(orderKey);
      dailyByStore[o.storeId][day].orders = dailyStoreOrderIds[o.storeId][day].size;
    }
  }

  const dailyHeatmap = Object.values(dailyMap).map((d) => ({
    ...d, revenue: parseFloat(d.revenue.toFixed(2)),
  }));

  // Heatmap por loja: só inclui se há mais de 1 loja com pedidos
  const heatmapByStore = Object.entries(dailyByStore).map(([sid, dayMap]) => ({
    storeId:     sid,
    storeName:   storeNameMap[sid]?.name ?? sid,
    marketplace: storeNameMap[sid]?.marketplace ?? 'outros',
    days: Object.values(dayMap).map((d) => ({ ...d, revenue: parseFloat(d.revenue.toFixed(2)) })),
  }));

  // ── Projeção de fechamento: só faz sentido na visão "Mês" do mês corrente.
  let projection = null;
  if (periodKey === 'month' && dateRange) {
    const startParts = parseYmd(dateRange.startDate);
    const endParts = parseYmd(dateRange.endDate);
    const todayParts = getZonedParts(new Date());
    const isCurrentMonth = startParts
      && endParts
      && startParts.day === 1
      && startParts.year === todayParts.year
      && startParts.month === todayParts.month
      && endParts.year === todayParts.year
      && endParts.month === todayParts.month;
    if (isCurrentMonth) {
      const daysInMonth = new Date(Date.UTC(todayParts.year, todayParts.month, 0)).getUTCDate();
      const daysElapsed = Math.min(endParts.day, todayParts.day, daysInMonth);
      if (daysElapsed > 0 && daysElapsed < daysInMonth) {
        const factor = daysInMonth / daysElapsed;
        const dailyRevenue = totalRevenue / daysElapsed;
        const dailyProfit = projectedProfit / daysElapsed;
        projection = {
          revenue: parseFloat((totalRevenue * factor).toFixed(2)),
          profit: parseFloat((projectedProfit * factor).toFixed(2)),
          confirmedProfit: parseFloat((totalProfit * factor).toFixed(2)),
          estimatedProfit: parseFloat((estimatedProfit * factor).toFixed(2)),
          dailyRevenue: parseFloat(dailyRevenue.toFixed(2)),
          dailyProfit: parseFloat(dailyProfit.toFixed(2)),
          daysElapsed,
          daysInMonth,
        };
      }
    }
  }

  // ── Taxa de devolução do período ───────────────────────────────────────────
  // (returned_full + returned_partial) / total de pedidos gerados no período × 100.
  // Base = TODOS os pedidos (qualquer status), pois cancelados/devolvidos também
  // contam como pedidos gerados. Alta taxa destrói a margem real (frete + embalagem).
  const returnedFullCount = summarizeOrderBreakdown(
    allPeriodRaw.filter(o => o.orderCategory === 'returned_full')
  ).created.orders;
  const returnedPartialCount = summarizeOrderBreakdown(
    allPeriodRaw.filter(o => o.orderCategory === 'returned_partial')
  ).created.orders;
  const returnedCount = returnedFullCount + returnedPartialCount;
  const canShowReturnRate = !['today', 'yesterday'].includes(String(periodKey || ''))
    && (rangeDays ?? 0) >= 7
    && createdOrders > 0;
  const returnRate = canShowReturnRate ? {
    rate: createdOrders > 0 ? parseFloat(((returnedCount / createdOrders) * 100).toFixed(1)) : 0,
    returnedCount,
    returnedFullCount,
    returnedPartialCount,
    totalGenerated: createdOrders,
    periodDays: rangeDays,
  } : null;

  return res.json({
    totalRevenue:   parseFloat(totalRevenue.toFixed(2)),
    totalProfit:    parseFloat(totalProfit.toFixed(2)),
    avgMargin:      parseFloat(avgMargin.toFixed(2)),
    confirmedRepasse: parseFloat(confirmedRepasse.toFixed(2)),
    confirmedNetRevenue: parseFloat(confirmedRepasse.toFixed(2)),
    confirmedProfit: parseFloat(totalProfit.toFixed(2)),
    confirmedRepasseOrders,
    estimatedRepasse: parseFloat(estimatedRepasse.toFixed(2)),
    estimatedNetRevenue: parseFloat(estimatedRepasse.toFixed(2)),
    projectedRepasse: parseFloat((confirmedRepasse + estimatedRepasse).toFixed(2)),
    estimatedProfit:  parseFloat(estimatedProfit.toFixed(2)),
    projectedProfit:  parseFloat(projectedProfit.toFixed(2)),
    projectedMargin:  parseFloat(projectedMargin.toFixed(2)),
    projectedGmv:     parseFloat(projectedGmv.toFixed(2)),
    awaitingRepasseOrders,
    estimatedProfitOrders,
    estimatedProfitOrderLines: estimatedOrdersReliable.length,
    estimatedProfitOrdersUnreliable,
    estimatedProfitOrderLinesUnreliable: estimatedOrdersUnreliable,
    totalOrders,
    paidOrders,
    paidUnits,
    createdOrders,
    createdUnits,
    unpaidOrders,
    unpaidUnits,
    cancelledOrders,
    cancelledUnits,
    paidCancelledOrders,
    paidCancelledUnits,
    orderBreakdown: breakdown,
    upsellerValidOrders: validOrders,
    upsellerValidUnits: paidUnits,
    upsellerValidRevenue: parseFloat(validSales.toFixed(2)),
    validOrders,
    totalSales:    parseFloat(totalSales.toFixed(2)),  // "Valor Total de Vendas" Upseller
    validRevenue:  parseFloat(validSales.toFixed(2)),  // "Valor de Vendas Válidas" Upseller
    totalPeriodOrders: createdOrders,
    clientsCount,         // "Clientes" Upseller (buyerUsername únicos)
    salesPerClient: allClientsCount > 0 ? parseFloat((totalSales / allClientsCount).toFixed(2)) : parseFloat(salesPerClient.toFixed(2)),
    totalItems,    // itens totais (linhas — inclui multi-produto)
    avgTicket:      parseFloat(avgTicket.toFixed(2)),
    negativeMargin,
    topProducts,
    worstProducts,
    monthlyChart,
    costsBreakdown,
    prevKPIs,
    sparkline,
    channelBreakdown,
    dailyHeatmap,
    heatmapByStore,
    closedRevenue,
    projection,
    returnRate,
    periodRange: dateRange ? {
      start: dateRange.startDate,
      end: dateRange.endDate,
      timezone: dateRange.timezone,
    } : null,
  });
}

// GET /api/dashboard/alerts
async function getAlerts(req, res) {
  const { storeId } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;

  const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true, name: true } });
  const storeIds = stores.map((s) => s.id);

  if (!storeIds.length) return res.json({ alerts: [], total: 0 });

  const alerts = [];

  const since = new Date();
  since.setDate(since.getDate() - 30);

  const negOrders = await prisma.order.findMany({
    where: { storeId: { in: storeIds }, status: 'paid', profit: { lt: 0 }, soldAt: { gte: since } },
    include: { product: { select: { name: true } } },
    orderBy: { profit: 'asc' },
    take: 20,
  });

  for (const o of negOrders) {
    const productName = o.product?.name ?? o.productName ?? '—';
    alerts.push({
      type:     'negative_margin',
      severity: o.profit < -50 ? 'high' : 'medium',
      orderId:  o.id,
      message:  `Pedido ${o.orderId || o.id} com margem negativa: R$ ${(o.profit ?? 0).toFixed(2)}`,
      products: productName,
      soldAt:   o.soldAt,
    });
  }

  const allProducts = await prisma.product.findMany({
    where:  { storeId: { in: storeIds } },
    select: { id: true, name: true, stock: true, minStock: true, storeId: true },
  });

  for (const p of allProducts) {
    if (p.stock <= p.minStock) {
      alerts.push({
        type:      'low_stock',
        severity:  p.stock === 0 ? 'high' : 'medium',
        productId: p.id,
        message:   `Estoque baixo: "${p.name}" — ${p.stock} unidade(s) restantes (mínimo: ${p.minStock})`,
      });
    }
  }

  alerts.sort((a, b) => (b.severity === 'high' ? 1 : 0) - (a.severity === 'high' ? 1 : 0));

  return res.json({ alerts, total: alerts.length });
}

// GET /api/dashboard/report?storeId=X&month=2025-05
async function getMonthlyReport(req, res) {
  const { storeId, month } = req.query;
  if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });
  if (!month)   return res.status(400).json({ error: 'month obrigatório (ex: 2025-05)' });

  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  const { year, month: mon } = parseYearMonth(month);
  const startDate = new Date(year, mon - 1, 1);
  const endDate   = new Date(year, mon, 0, 23, 59, 59);

  const orderWhere = { storeId, status: 'paid', soldAt: { gte: startDate, lte: endDate } };

  const orders = await prisma.order.findMany({
    where:  orderWhere,
    select: { salePrice: true, profit: true, margin: true, soldAt: true },
  });

  const totalOrders  = orders.length;
  const totalRevenue = orders.reduce((s, o) => s + o.salePrice, 0);
  const totalProfit  = orders.reduce((s, o) => s + (o.profit ?? 0), 0);
  // Margem ponderada (lucro ÷ faturamento) — consistente com getSummary; não média aritmética
  const avgMargin    = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

  const ordersWithProducts = await prisma.order.findMany({
    where:  { ...orderWhere, productId: { not: null } },
    select: {
      productId:       true,
      quantity:        true,
      calcGmv:         true,
      calcGrossProfit: true,
      calcProductCost: true,
      calcShopeeFee:   true,
      profit:          true,
      margin:          true,
      product: { select: { id: true, name: true, packaging: true } },
    },
  });

  const productMap = {};
  const costsAcc   = { commission: 0, cogs: 0, packaging: 0 };

  for (const o of ordersWithProducts) {
    const pid = o.productId;
    if (!productMap[pid]) {
      productMap[pid] = { productId: pid, name: o.product?.name ?? '', profit: 0, margin: 0, quantity: 0, count: 0, revenue: 0, cogs: 0 };
    }
    productMap[pid].profit   += o.calcGrossProfit ?? 0;
    productMap[pid].margin   += o.margin ?? 0;
    productMap[pid].quantity += o.quantity;
    productMap[pid].revenue  += o.calcGmv;
    productMap[pid].cogs     += o.calcProductCost;
    productMap[pid].count++;

    costsAcc.commission += o.calcShopeeFee;
    costsAcc.cogs       += o.calcProductCost;
    costsAcc.packaging  += (o.product?.packaging ?? 0) * o.quantity;
  }

  const topProducts = Object.values(productMap)
    .map((p) => ({
      ...p,
      profit:  parseFloat(p.profit.toFixed(2)),
      margin:  parseFloat((p.count ? p.margin / p.count : 0).toFixed(2)),
      revenue: parseFloat(p.revenue.toFixed(2)),
      cogs:    parseFloat(p.cogs.toFixed(2)),
    }))
    .sort((a, b) => b.profit - a.profit);

  const costsBreakdown = {
    commission: parseFloat(costsAcc.commission.toFixed(2)),
    serviceFee: 0,
    tax:        0,
    cogs:       parseFloat(costsAcc.cogs.toFixed(2)),
    packaging:  parseFloat(costsAcc.packaging.toFixed(2)),
    freight:    0,
  };

  const summary = {
    totalRevenue:  parseFloat(totalRevenue.toFixed(2)),
    totalProfit:   parseFloat(totalProfit.toFixed(2)),
    avgMargin:     parseFloat(avgMargin.toFixed(2)),
    totalOrders,
    topProducts,
    costsBreakdown,
  };

  const monthLabel = startDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  let pdfBuffer;
  try {
    pdfBuffer = await generateMonthlyReport(store, summary, monthLabel);
  } catch (err) {
    console.error('Erro ao gerar PDF:', err);
    return res.status(500).json({ error: 'Erro ao gerar PDF' });
  }

  const filename = `profittrack-${month}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  return res.send(pdfBuffer);
}

// GET /api/dashboard/monthly-comparison — últimos 6 meses
async function getMonthlyComparison(req, res) {
  const { storeId } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return res.json({ months: [] });

  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  start.setUTCHours(0, 0, 0, 0);

  const orders = await prisma.order.findMany({
    where:  { storeId: { in: storeIds }, status: 'paid', soldAt: { gte: start } },
    select: { salePrice: true, profit: true, margin: true, soldAt: true },
  });

  const monthMap = {};
  for (const o of orders) {
    const key = o.soldAt.toISOString().substring(0, 7);
    if (!monthMap[key]) monthMap[key] = { revenue: 0, profit: 0, marginSum: 0, orders: 0 };
    monthMap[key].revenue   += o.salePrice;
    monthMap[key].profit    += o.profit   ?? 0;
    monthMap[key].marginSum += o.margin   ?? 0;
    monthMap[key].orders++;
  }

  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const m   = monthMap[key] ?? { revenue: 0, profit: 0, marginSum: 0, orders: 0 };
    months.push({ key, ...m });
  }

  const result = months.map((m, i) => {
    const prev      = i > 0 ? months[i - 1] : null;
    const margin    = m.orders > 0 ? m.marginSum / m.orders : 0;
    const avgTicket = m.orders > 0 ? m.revenue   / m.orders : 0;
    return {
      month:     m.key,
      revenue:   parseFloat(m.revenue.toFixed(2)),
      profit:    parseFloat(m.profit.toFixed(2)),
      orders:    m.orders,
      margin:    parseFloat(margin.toFixed(1)),
      avgTicket: parseFloat(avgTicket.toFixed(2)),
      vsRevenue: prev && prev.revenue !== 0
        ? parseFloat(((m.revenue - prev.revenue) / Math.abs(prev.revenue) * 100).toFixed(1))
        : null,
      vsProfit:  prev && prev.profit !== 0
        ? parseFloat(((m.profit - prev.profit) / Math.abs(prev.profit) * 100).toFixed(1))
        : null,
    };
  });

  return res.json({ months: result });
}

// GET /api/dashboard/shopee-summary?storeId=&month=2026-04
async function getShopeeSummary(req, res) {
  const { storeId, month } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;

  const stores          = await prisma.store.findMany({ where: storeWhere, select: { id: true, marketplace: true, taxRate: true } });
  const storeIds        = stores.map((s) => s.id);
  const taxRateByStoreSP = Object.fromEntries(stores.map((s) => [s.id, s.taxRate ?? 0]));
  if (!storeIds.length) return res.json({ summaries: [], totals: null });

  const where = { storeId: { in: storeIds } };
  if (month) where.month = month;

  const summaries = await prisma.shopeePeriodSummary.findMany({
    where,
    orderBy: { month: 'desc' },
  });

  const monthRange = month && /^\d{4}-\d{2}$/.test(String(month))
    ? buildDateRange(`${month}-01`, (() => {
        const [y, m] = String(month).split('-').map(Number);
        return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
      })())
    : null;

  const liveOrders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      ...orderPeriodWhere(monthRange),
    },
    select: {
      id: true, orderId: true, orderCategory: true, orderStatus: true, orderPaidAt: true, storeId: true,
      status: true, escrowAmount: true, calcNetRevenue: true, calcProductCost: true,
      calcTax: true, calcGmv: true, salePrice: true, quantity: true, cancelReason: true,
      platformCommission: true, platformServiceFee: true, sellerCoupon: true, lmmDiscount: true, calcPackaging: true,
    },
  });

  const breakdown = summarizeOrderBreakdown(liveOrders);
  const confirmed = liveOrders.filter((o) => isConfirmedPaidOrder(o, 'shopee'));
  const uniqueCountBy = (orders, predicate) => orders
    .filter(predicate)
    .reduce((set, o) => set.add(getOrderUniqueKey(o)), new Set()).size;

  const totals = {
    gmv: confirmed.reduce((s, o) => s + (o.calcGmv ?? o.salePrice ?? 0), 0),
    netRevenue: confirmed.reduce((s, o) => s + (o.escrowAmount ?? 0), 0),
    tax: confirmed.reduce((s, o) => s + (o.calcTax ?? 0), 0),
    grossProfit: confirmed.reduce((s, o) => s + confirmedProfit(o, 'shopee', taxRateByStoreSP[o.storeId]), 0),
    validCount: breakdown.valid.orders,
    unitCount: breakdown.valid.units,
    cancelledCount: breakdown.cancelled.orders,
    cancelledGmv: liveOrders
      .filter((o) => o.orderCategory === 'cancelled_other')
      .reduce((s, o) => s + (o.calcGmv ?? o.salePrice ?? 0), 0),
    unpaidCount: breakdown.unpaid.orders,
    unpaidGmv: liveOrders
      .filter((o) => o.orderCategory === 'cancelled_unpaid' || String(o.orderStatus ?? '').toUpperCase() === 'UNPAID')
      .reduce((s, o) => s + (o.calcGmv ?? o.salePrice ?? 0), 0),
    returnedFullCount: uniqueCountBy(liveOrders, (o) => o.orderCategory === 'returned_full'),
    returnedFullValue: liveOrders
      .filter((o) => o.orderCategory === 'returned_full')
      .reduce((s, o) => s + (o.calcGmv ?? o.salePrice ?? 0), 0),
    returnedPartialCount: uniqueCountBy(liveOrders, (o) => o.orderCategory === 'returned_partial'),
    returnedPartialValue: liveOrders
      .filter((o) => o.orderCategory === 'returned_partial')
      .reduce((s, o) => s + (o.calcGmv ?? o.salePrice ?? 0), 0),
  };

  totals.gmv = r2(totals.gmv);
  totals.netRevenue = r2(totals.netRevenue);
  totals.tax = r2(totals.tax);
  totals.grossProfit = r2(totals.grossProfit);
  totals.cancelledGmv = r2(totals.cancelledGmv);
  totals.unpaidGmv = r2(totals.unpaidGmv);
  totals.returnedFullValue = r2(totals.returnedFullValue);
  totals.returnedPartialValue = r2(totals.returnedPartialValue);
  totals.shopeeDeductions = r2(totals.gmv - totals.netRevenue);
  totals.margin = totals.gmv > 0 ? parseFloat(((totals.grossProfit / totals.gmv) * 100).toFixed(2)) : 0;
  totals.returnedCount = totals.returnedFullCount + totals.returnedPartialCount;
  totals.returnedValue = parseFloat((totals.returnedFullValue + totals.returnedPartialValue).toFixed(2));
  totals.cancellationRate = totals.validCount + totals.cancelledCount + totals.unpaidCount > 0
    ? parseFloat(((totals.cancelledCount + totals.unpaidCount) / (totals.validCount + totals.cancelledCount + totals.unpaidCount + totals.returnedFullCount + totals.returnedPartialCount) * 100).toFixed(1))
    : 0;

  // Parse cancel reason breakdowns
  const cancelReasonMap = {};
  const reasonOrderIds = new Set();
  for (const o of liveOrders) {
    if (!String(o.orderCategory ?? '').startsWith('cancelled')) continue;
    const key = getOrderUniqueKey(o);
    if (reasonOrderIds.has(key)) continue;
    reasonOrderIds.add(key);
    const reason = o.cancelReason || 'Motivo não informado';
    cancelReasonMap[reason] = (cancelReasonMap[reason] || 0) + 1;
  }

  return res.json({
    summaries: summaries.map((s) => ({
      ...s,
      cancelReasonBreakdown: undefined,
      cancelReasons: (() => { try { return JSON.parse(s.cancelReasonBreakdown || '{}'); } catch { return {}; } })(),
    })),
    totals,
    cancelReasons: cancelReasonMap,
  });
}

// GET /api/dashboard/shopee-losses?storeId=&startDate=&endDate=
// Lê diretamente da tabela Order — disponível logo após o import, sem precisar de recalculate
async function getShopeeLosses(req, res) {
  const { storeId, startDate, endDate } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;

  const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return res.json({ losses: null });

  const dateFilter = buildDateFilter(startDate, endDate);
  const where = {
    storeId: { in: storeIds },
    ...(dateFilter ? { soldAt: dateFilter } : {}),
  };

  // Todos os pedidos do período (todos os status)
  const orders = await prisma.order.findMany({
    where,
    select: {
      id:            true,
      orderCategory: true,
      cancelReason:  true,
      salePrice:     true,
      agreedPrice:   true,
      returnStatus:  true,
      globalTotal:   true,
      productName:   true,
      variationName: true,
    },
  });

  if (!orders.length) return res.json({ losses: null });

  // ── Categorias ────────────────────────────────────────────────────────────
  const byCategory = { valid: [], returned_full: [], returned_partial: [], cancelled_unpaid: [], cancelled_other: [] };
  for (const o of orders) {
    const cat = o.orderCategory || 'valid';
    if (byCategory[cat]) byCategory[cat].push(o);
    else byCategory.valid.push(o);
  }

  const totalGenerated = orders.length;
  const validCount     = byCategory.valid.length + byCategory.returned_partial.length;

  // ── Cancelamentos ─────────────────────────────────────────────────────────
  const allCancelled   = [...byCategory.cancelled_unpaid, ...byCategory.cancelled_other];
  const cancelledCount = allCancelled.length;
  const cancelledGmv   = allCancelled.reduce((s, o) => s + (o.salePrice || 0), 0);
  const cancelledRate  = totalGenerated > 0 ? parseFloat(((cancelledCount / totalGenerated) * 100).toFixed(1)) : 0;

  // Não pagos
  const unpaidCount = byCategory.cancelled_unpaid.length;
  const unpaidGmv   = byCategory.cancelled_unpaid.reduce((s, o) => s + (o.salePrice || 0), 0);

  // Fora de estoque (em cancelled_other)
  const outOfStock = byCategory.cancelled_other.filter(
    (o) => String(o.cancelReason || '').toLowerCase().includes('fora de estoque')
  );
  const outOfStockCount   = outOfStock.length;
  const outOfStockRate    = cancelledCount > 0 ? parseFloat(((outOfStockCount / cancelledCount) * 100).toFixed(1)) : 0;
  const outOfStockProducts = [...new Set(outOfStock.map((o) => o.productName).filter(Boolean))].slice(0, 10);

  // ── Devoluções ─────────────────────────────────────────────────────────────
  const returnedFull    = byCategory.returned_full;
  const returnedPartial = byCategory.returned_partial;
  const returnedCount   = returnedFull.length + returnedPartial.length;
  const returnedFullGmv = returnedFull.reduce((s, o) => s + (o.salePrice || 0), 0);
  const returnedLost    = returnedFullGmv + returnedPartial.reduce((s, o) => s + Math.max(0, (o.salePrice || 0) - (o.globalTotal || 0)), 0);
  const returnedRate    = validCount > 0 ? parseFloat(((returnedCount / (validCount + returnedCount)) * 100).toFixed(1)) : 0;

  // ── Breakdown de motivos ───────────────────────────────────────────────────
  const reasonMap = {};
  for (const o of allCancelled) {
    const reason = o.cancelReason || 'Motivo não informado';
    reasonMap[reason] = (reasonMap[reason] || 0) + 1;
  }
  const cancelReasons = Object.entries(reasonMap)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({
      reason,
      count,
      pct: cancelledCount > 0 ? parseFloat(((count / cancelledCount) * 100).toFixed(1)) : 0,
    }));

  return res.json({
    losses: {
      totalGenerated,
      validCount,
      // Cancelamentos
      cancelledCount,
      cancelledGmv:  parseFloat(cancelledGmv.toFixed(2)),
      cancelledRate,
      unpaidCount,
      unpaidGmv:     parseFloat(unpaidGmv.toFixed(2)),
      unpaidPct:     cancelledCount > 0 ? parseFloat(((unpaidCount / cancelledCount) * 100).toFixed(1)) : 0,
      // Fora de estoque
      outOfStockCount,
      outOfStockRate,
      outOfStockProducts,
      // Devoluções
      returnedCount,
      returnedFullCount:    returnedFull.length,
      returnedPartialCount: returnedPartial.length,
      returnedLost:         parseFloat(returnedLost.toFixed(2)),
      returnedRate,
      // Breakdown
      cancelReasons,
    },
  });
}

// GET /api/dashboard/stores-comparison
// Comparativo de lucro real por loja, usando o mesmo período e a mesma cadeia canônica do dashboard.
async function getStoresComparison(req, res) {
  const { storeId, startDate, endDate } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;

  const stores = await prisma.store.findMany({
    where:  storeWhere,
    select: { id: true, name: true, marketplace: true, taxRate: true },
  });

  if (!stores.length) {
    const now = new Date();
    let y = now.getUTCFullYear(), m = now.getUTCMonth();
    if (now.getUTCDate() < 5) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
    const periodKey = `${y}-${String(m + 1).padStart(2, '0')}`;
    return res.json({ period: { month: periodKey, start: null, end: null }, stores: [], crossStoreProducts: [] });
  }

  const requestedRange = buildDateRange(startDate, endDate);
  const now = new Date();
  let y = now.getUTCFullYear(), m = now.getUTCMonth(); // 0-indexed
  if (now.getUTCDate() < 5) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const fallbackRange = {
    start: saoPauloDateToUtc(y, m + 1, 1),
    end:   saoPauloDateToUtc(y, m + 1, new Date(Date.UTC(y, m + 1, 0)).getUTCDate(), 23, 59, 59, 999),
    startDate: `${y}-${String(m + 1).padStart(2, '0')}-01`,
    endDate:   `${y}-${String(m + 1).padStart(2, '0')}-${String(new Date(Date.UTC(y, m + 1, 0)).getUTCDate()).padStart(2, '0')}`,
    timezone: APP_TIMEZONE,
  };
  const periodRange = requestedRange ?? fallbackRange;
  const periodKey   = periodRange.startDate.substring(0, 7);

  const storeIds         = stores.map((s) => s.id);
  const storeTaxRateMap  = new Map(stores.map((s) => [s.id, s.taxRate ?? 0]));
  const storeMetaMap     = new Map(stores.map((s) => [s.id, s]));

  // Mesmo recorte financeiro do dashboard principal: período por pagamento/repasse.
  const orders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      ...paidPeriodWhere(periodRange),
      orderCategory: { in: REVENUE_ORDER_CATEGORIES },
    },
    select: {
      storeId:            true,
      orderId:            true,
      orderCategory:      true,
      orderStatus:        true,
      orderPaidAt:        true,
      status:             true,
      calcGmv:            true,
      platformCommission: true,
      platformServiceFee: true,
      sellerCoupon:       true,
      lmmDiscount:        true,
      escrowAmount:       true,
      calcProductCost:    true,
      calcPackaging:      true,
      productId:          true,
      quantity:           true,
      soldAt:             true,
      product: { select: { id: true, name: true } },
    },
  });

  // Acumuladores por loja
  const storeAcc = {}; // storeId → { gmv, netRevenue, profit, orderIds }
  for (const s of stores) {
    storeAcc[s.id] = { gmv: 0, netRevenue: 0, profit: 0, orderIds: new Set() };
  }

  // Map para topProduct por loja: storeId → { productId → { name, profit, netRevenue } }
  const productByStore = {};

  // Map para crossStoreProducts: normalizedName → { name (original), storeId → { profit, gmv, orderIds } }
  const crossMap = {};

  for (const o of orders) {
    const storeMeta = storeMetaMap.get(o.storeId);
    const marketplace = storeMeta?.marketplace;
    if (!isConfirmedPaidOrder(o, marketplace)) continue;

    const aliquota     = storeTaxRateMap.get(o.storeId) ?? 0;
    const orderGmv     = r2(o.calcGmv ?? 0);
    const orderRepasse = r2(expectedRepasse(o, marketplace) ?? 0);
    const orderProfit  = confirmedProfit(o, marketplace, aliquota);
    const orderKey     = getOrderUniqueKey(o);

    // Acumular por loja
    const acc = storeAcc[o.storeId];
    acc.gmv        += orderGmv;
    acc.netRevenue += orderRepasse;
    acc.profit     += orderProfit;
    if (orderKey) acc.orderIds.add(orderKey);

    // Acumular por produto na loja (topProduct)
    if (o.productId) {
      if (!productByStore[o.storeId]) productByStore[o.storeId] = {};
      const pm = productByStore[o.storeId];
      if (!pm[o.productId]) {
        pm[o.productId] = { name: o.product?.name ?? '', profit: 0, netRevenue: 0 };
      }
      pm[o.productId].profit     += orderProfit;
      pm[o.productId].netRevenue += orderRepasse;
    }

    // Acumular para crossStoreProducts
    if (o.productId && o.product?.name) {
      const normName = o.product.name.toLowerCase().trim();
      if (!crossMap[normName]) {
        crossMap[normName] = { name: o.product.name, stores: {} };
      }
      if (!crossMap[normName].stores[o.storeId]) {
        crossMap[normName].stores[o.storeId] = { profit: 0, gmv: 0, orderIds: new Set() };
      }
      crossMap[normName].stores[o.storeId].profit += orderProfit;
      crossMap[normName].stores[o.storeId].gmv    += orderGmv;
      if (orderKey) crossMap[normName].stores[o.storeId].orderIds.add(orderKey);
    }
  }

  // Montar array de lojas com topProduct
  const storesResult = stores.map((s) => {
    const acc    = storeAcc[s.id];
    const gmv    = r2(acc.gmv);
    const net    = r2(acc.netRevenue);
    const profit = r2(acc.profit);
    const margin = gmv > 0 ? r2(profit / gmv * 100) : 0;
    const orders = acc.orderIds.size;
    const avgTicket = orders > 0 ? r2(gmv / orders) : 0;

    // topProduct da loja: produto com maior profit acumulado
    let topProduct = null;
    const pm = productByStore[s.id];
    if (pm) {
      const best = Object.values(pm).reduce((a, b) => (b.profit > a.profit ? b : a), { profit: -Infinity, name: '', netRevenue: 0 });
      if (best.name) {
        topProduct = { name: best.name, profit: r2(best.profit) };
      }
    }

    return {
      storeId:    s.id,
      storeName:  s.name,
      marketplace: s.marketplace,
      gmv,
      netRevenue: net,
      profit,
      margin,
      orders,
      avgTicket,
      topProduct,
    };
  }).sort((a, b) => b.profit - a.profit);

  // Montar crossStoreProducts: apenas produtos em >= 2 lojas distintas
  const crossStoreProducts = [];
  for (const [normName, data] of Object.entries(crossMap)) {
    const storeEntries = Object.entries(data.stores); // [storeId, { profit, gmv, orderIds }]
    if (storeEntries.length < 2) continue;

    const channels = storeEntries.map(([sid, vals]) => {
      const meta   = storeMetaMap.get(sid);
      const margin = vals.gmv > 0 ? r2(vals.profit / vals.gmv * 100) : 0;
      return {
        storeId:    sid,
        storeName:  meta?.name ?? sid,
        marketplace: meta?.marketplace ?? 'outros',
        margin,
        profit:  r2(vals.profit),
        orders:  vals.orderIds.size,
      };
    });

    const bestChannel = channels.reduce((a, b) => (b.margin > a.margin ? b : a));
    const totalProfit = channels.reduce((s, c) => s + c.profit, 0);

    crossStoreProducts.push({
      name: data.name,
      channels,
      bestChannel: {
        marketplace: bestChannel.marketplace,
        storeName:   bestChannel.storeName,
        margin:      bestChannel.margin,
      },
      _totalProfit: totalProfit, // campo auxiliar para ordenação, removido abaixo
    });
  }

  crossStoreProducts.sort((a, b) => b._totalProfit - a._totalProfit);
  const crossTop8 = crossStoreProducts.slice(0, 8).map(({ _totalProfit, ...rest }) => rest);

  return res.json({
    period: {
      month: periodKey,
      start: periodRange.start.toISOString(),
      end:   periodRange.end.toISOString(),
      startDate: periodRange.startDate,
      endDate:   periodRange.endDate,
      timezone:  periodRange.timezone,
    },
    stores:              storesResult,
    crossStoreProducts:  crossTop8,
  });
}

module.exports = { getSummary, getAlerts, getMonthlyReport, getMonthlyComparison, getShopeeSummary, getShopeeLosses, getStoresComparison };
