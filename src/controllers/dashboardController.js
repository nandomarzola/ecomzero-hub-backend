const prisma = require('../lib/prisma');
const { generateMonthlyReport } = require('../services/reportService');

function buildDateFilter(startDate, endDate) {
  if (!startDate && !endDate) return undefined;
  const filter = {};
  if (startDate) filter.gte = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);
    filter.lte = end;
  }
  return filter;
}

// Calcula o período anterior com a mesma duração
function buildPrevDateFilter(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate);
  const end   = new Date(endDate);
  end.setUTCHours(23, 59, 59, 999);
  const durationMs = end.getTime() - start.getTime();
  const prevEnd   = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - durationMs);
  return { gte: prevStart, lte: prevEnd };
}

// GET /api/dashboard/summary
async function getSummary(req, res) {
  const { storeId, startDate, endDate } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;

  const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true, marketplace: true } });
  const storeIds          = stores.map((s) => s.id);
  const marketplaceByStore = Object.fromEntries(stores.map((s) => [s.id, s.marketplace]));

  if (!storeIds.length) {
    return res.json({
      totalRevenue: 0, totalProfit: 0, avgMargin: 0, totalOrders: 0, avgTicket: 0,
      negativeMargin: 0, topProducts: [], worstProducts: [], monthlyChart: [],
      costsBreakdown: {}, prevKPIs: null, sparkline: [], channelBreakdown: [], dailyHeatmap: [],
    });
  }

  const dateFilter = buildDateFilter(startDate, endDate);
  const orderWhere = {
    storeId: { in: storeIds },
    status:  'paid',
    ...(dateFilter ? { soldAt: dateFilter } : {}),
  };

  // Período anterior para comparação
  const prevFilter = buildPrevDateFilter(startDate, endDate);

  // Sparkline: últimos 6 meses
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setDate(1);
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
  sixMonthsAgo.setUTCHours(0, 0, 0, 0);

  // Busca paralela: todos os dados de uma vez
  const [orders, prevOrdersRaw, sparkOrdersRaw, itemsRaw, singleStore] = await Promise.all([
    prisma.order.findMany({
      where:  orderWhere,
      select: { salePrice: true, profit: true, margin: true, soldAt: true, storeId: true },
    }),
    prevFilter
      ? prisma.order.findMany({
          where:  { storeId: { in: storeIds }, status: 'paid', soldAt: prevFilter },
          select: { salePrice: true, profit: true, margin: true },
        })
      : Promise.resolve([]),
    prisma.order.findMany({
      where:  { storeId: { in: storeIds }, status: 'paid', soldAt: { gte: sixMonthsAgo } },
      select: { salePrice: true, profit: true, margin: true, soldAt: true },
    }),
    prisma.orderItem.findMany({
      where: { order: orderWhere },
      include: {
        product: { select: { id: true, name: true, costPrice: true, packaging: true, supplies: true } },
        order:   { select: { profit: true, margin: true, salePrice: true, freight: true, discount: true } },
      },
    }),
    storeIds.length === 1
      ? prisma.store.findUnique({ where: { id: storeIds[0] } })
      : Promise.resolve(null),
  ]);

  // ── KPIs do período atual ──────────────────────────────────────────────────
  const totalOrders   = orders.length;
  const totalRevenue  = orders.reduce((s, o) => s + o.salePrice, 0);
  const totalProfit   = orders.reduce((s, o) => s + (o.profit ?? 0), 0);
  const avgMargin     = totalOrders ? orders.reduce((s, o) => s + (o.margin ?? 0), 0) / totalOrders : 0;
  const avgTicket     = totalOrders ? totalRevenue / totalOrders : 0;
  const negativeMargin = orders.filter((o) => (o.profit ?? 0) < 0).length;

  // ── KPIs do período anterior ───────────────────────────────────────────────
  let prevKPIs = null;
  if (prevFilter) {
    const prevCount   = prevOrdersRaw.length;
    const prevRevenue = prevOrdersRaw.reduce((s, o) => s + o.salePrice, 0);
    prevKPIs = {
      totalRevenue: parseFloat(prevRevenue.toFixed(2)),
      totalProfit:  parseFloat(prevOrdersRaw.reduce((s, o) => s + (o.profit ?? 0), 0).toFixed(2)),
      avgMargin:    prevCount ? parseFloat((prevOrdersRaw.reduce((s, o) => s + (o.margin ?? 0), 0) / prevCount).toFixed(2)) : 0,
      totalOrders:  prevCount,
      avgTicket:    prevCount ? parseFloat((prevRevenue / prevCount).toFixed(2)) : 0,
    };
  }

  // ── Sparkline últimos 6 meses ──────────────────────────────────────────────
  const sparkMap = {};
  for (const o of sparkOrdersRaw) {
    const key = o.soldAt.toISOString().substring(0, 7);
    if (!sparkMap[key]) sparkMap[key] = { revenue: 0, profit: 0, margin: 0, count: 0 };
    sparkMap[key].revenue += o.salePrice;
    sparkMap[key].profit  += o.profit ?? 0;
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

  for (const item of itemsRaw) {
    const pid = item.product?.id;
    if (!pid) continue;
    if (!productMap[pid]) {
      productMap[pid] = { productId: pid, name: item.product.name, profit: 0, margin: 0, quantity: 0, count: 0, revenue: 0, cogs: 0 };
    }
    const effectivePrice = item.order.salePrice - (item.order.discount ?? 0);
    productMap[pid].profit   += item.order.profit ?? 0;
    productMap[pid].margin   += item.order.margin ?? 0;
    productMap[pid].quantity += item.quantity;
    productMap[pid].revenue  += item.order.salePrice;
    productMap[pid].cogs     += item.product.costPrice * item.quantity;
    productMap[pid].count++;

    if (singleStore) {
      costsAcc.commission += effectivePrice * (singleStore.commission / 100);
      costsAcc.serviceFee += effectivePrice * (singleStore.serviceFee / 100);
      costsAcc.tax        += effectivePrice * (singleStore.taxRate    / 100);
    }
    costsAcc.cogs      += item.product.costPrice * item.quantity;
    costsAcc.packaging += (item.product.packaging + item.product.supplies) * item.quantity;
    costsAcc.freight   += item.order.freight ?? 0;
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
    const key = o.soldAt.toISOString().substring(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { month: key, revenue: 0, profit: 0 };
    monthlyMap[key].revenue += o.salePrice;
    monthlyMap[key].profit  += o.profit ?? 0;
  }
  const monthlyChart = Object.values(monthlyMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, revenue: parseFloat(m.revenue.toFixed(2)), profit: parseFloat(m.profit.toFixed(2)) }));

  // ── Breakdown por canal ────────────────────────────────────────────────────
  const channelMap = {};
  for (const o of orders) {
    const ch = marketplaceByStore[o.storeId] ?? 'outros';
    if (!channelMap[ch]) channelMap[ch] = { channel: ch, revenue: 0, profit: 0, orders: 0 };
    channelMap[ch].revenue += o.salePrice;
    channelMap[ch].profit  += o.profit ?? 0;
    channelMap[ch].orders++;
  }
  const channelBreakdown = Object.values(channelMap).map((c) => ({
    ...c,
    revenue: parseFloat(c.revenue.toFixed(2)),
    profit:  parseFloat(c.profit.toFixed(2)),
    share:   totalRevenue > 0 ? parseFloat(((c.revenue / totalRevenue) * 100).toFixed(1)) : 0,
  })).sort((a, b) => b.revenue - a.revenue);

  // ── Heatmap diário ─────────────────────────────────────────────────────────
  const dailyMap = {};
  for (const o of orders) {
    const day = o.soldAt.toISOString().substring(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { date: day, revenue: 0, orders: 0 };
    dailyMap[day].revenue += o.salePrice;
    dailyMap[day].orders++;
  }
  const dailyHeatmap = Object.values(dailyMap).map((d) => ({
    ...d,
    revenue: parseFloat(d.revenue.toFixed(2)),
  }));

  return res.json({
    totalRevenue:   parseFloat(totalRevenue.toFixed(2)),
    totalProfit:    parseFloat(totalProfit.toFixed(2)),
    avgMargin:      parseFloat(avgMargin.toFixed(2)),
    totalOrders,
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
    include: { items: { include: { product: { select: { name: true } } } } },
    orderBy: { profit: 'asc' },
    take: 20,
  });

  for (const o of negOrders) {
    const productNames = o.items.map((i) => i.product?.name ?? '—').join(', ');
    alerts.push({
      type:     'negative_margin',
      severity: o.profit < -50 ? 'high' : 'medium',
      orderId:  o.id,
      message:  `Pedido ${o.externalId || o.id} com margem negativa: R$ ${o.profit.toFixed(2)}`,
      products: productNames,
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

  const [year, mon] = month.split('-').map(Number);
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
  const avgMargin    = totalOrders ? orders.reduce((s, o) => s + (o.margin ?? 0), 0) / totalOrders : 0;

  const itemsRaw = await prisma.orderItem.findMany({
    where: { order: orderWhere },
    include: {
      product: { select: { id: true, name: true, costPrice: true, packaging: true, supplies: true } },
      order:   { select: { profit: true, margin: true, salePrice: true, freight: true, discount: true } },
    },
  });

  const productMap = {};
  const costsAcc   = { commission: 0, serviceFee: 0, tax: 0, cogs: 0, packaging: 0, freight: 0 };

  for (const item of itemsRaw) {
    const pid = item.product?.id;
    if (!pid) continue;
    if (!productMap[pid]) {
      productMap[pid] = { productId: pid, name: item.product.name, profit: 0, margin: 0, quantity: 0, count: 0, revenue: 0, cogs: 0 };
    }
    const effectivePrice = item.order.salePrice - (item.order.discount ?? 0);
    productMap[pid].profit   += item.order.profit ?? 0;
    productMap[pid].margin   += item.order.margin ?? 0;
    productMap[pid].quantity += item.quantity;
    productMap[pid].revenue  += item.order.salePrice;
    productMap[pid].cogs     += item.product.costPrice * item.quantity;
    productMap[pid].count++;

    costsAcc.commission += effectivePrice * (store.commission / 100);
    costsAcc.serviceFee += effectivePrice * (store.serviceFee / 100);
    costsAcc.tax        += effectivePrice * (store.taxRate    / 100);
    costsAcc.cogs       += item.product.costPrice * item.quantity;
    costsAcc.packaging  += (item.product.packaging + item.product.supplies) * item.quantity;
    costsAcc.freight    += item.order.freight ?? 0;
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
    serviceFee: parseFloat(costsAcc.serviceFee.toFixed(2)),
    tax:        parseFloat(costsAcc.tax.toFixed(2)),
    cogs:       parseFloat(costsAcc.cogs.toFixed(2)),
    packaging:  parseFloat(costsAcc.packaging.toFixed(2)),
    freight:    parseFloat(costsAcc.freight.toFixed(2)),
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

module.exports = { getSummary, getAlerts, getMonthlyReport, getMonthlyComparison };
