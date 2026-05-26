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

// GET /api/dashboard/summary
async function getSummary(req, res) {
  const { storeId, startDate, endDate } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;

  const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);

  if (!storeIds.length) {
    return res.json({ totalRevenue: 0, totalProfit: 0, avgMargin: 0, totalOrders: 0, avgTicket: 0, negativeMargin: 0, topProducts: [], worstProducts: [], monthlyChart: [] });
  }

  const dateFilter = buildDateFilter(startDate, endDate);
  const orderWhere = {
    storeId: { in: storeIds },
    status:  'paid',
    ...(dateFilter ? { soldAt: dateFilter } : {}),
  };

  const orders = await prisma.order.findMany({
    where:   orderWhere,
    select:  { salePrice: true, profit: true, margin: true, soldAt: true },
  });

  const totalOrders  = orders.length;
  const totalRevenue = orders.reduce((s, o) => s + o.salePrice, 0);
  const totalProfit  = orders.reduce((s, o) => s + (o.profit ?? 0), 0);
  const avgMargin    = totalOrders ? orders.reduce((s, o) => s + (o.margin ?? 0), 0) / totalOrders : 0;
  const avgTicket    = totalOrders ? totalRevenue / totalOrders : 0;
  const negativeMargin = orders.filter((o) => (o.profit ?? 0) < 0).length;

  // Top / worst products + costs breakdown
  const itemsRaw = await prisma.orderItem.findMany({
    where: { order: orderWhere },
    include: {
      product: { select: { id: true, name: true, costPrice: true, packaging: true, supplies: true } },
      order:   { select: { profit: true, margin: true, salePrice: true, freight: true, discount: true } },
    },
  });

  const store = storeIds.length === 1
    ? await prisma.store.findUnique({ where: { id: storeIds[0] } })
    : null;

  const productMap = {};
  const costsAcc   = { commission: 0, serviceFee: 0, tax: 0, cogs: 0, packaging: 0, freight: 0 };

  for (const item of itemsRaw) {
    const pid = item.product.id;
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

    if (store) {
      costsAcc.commission += effectivePrice * (store.commission / 100);
      costsAcc.serviceFee += effectivePrice * (store.serviceFee / 100);
      costsAcc.tax        += effectivePrice * (store.taxRate    / 100);
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

  // Gráfico mensal
  const monthlyMap = {};
  for (const o of orders) {
    const key = o.soldAt.toISOString().substring(0, 7); // "2025-01"
    if (!monthlyMap[key]) monthlyMap[key] = { month: key, revenue: 0, profit: 0 };
    monthlyMap[key].revenue += o.salePrice;
    monthlyMap[key].profit  += o.profit ?? 0;
  }
  const monthlyChart = Object.values(monthlyMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, revenue: parseFloat(m.revenue.toFixed(2)), profit: parseFloat(m.profit.toFixed(2)) }));

  return res.json({
    totalRevenue:  parseFloat(totalRevenue.toFixed(2)),
    totalProfit:   parseFloat(totalProfit.toFixed(2)),
    avgMargin:     parseFloat(avgMargin.toFixed(2)),
    totalOrders,
    avgTicket:     parseFloat(avgTicket.toFixed(2)),
    negativeMargin,
    topProducts,
    worstProducts,
    monthlyChart,
    costsBreakdown,
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

  // Pedidos com margem negativa (últimos 30 dias)
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const negOrders = await prisma.order.findMany({
    where: { storeId: { in: storeIds }, status: 'paid', profit: { lt: 0 }, soldAt: { gte: since } },
    include: { items: { include: { product: { select: { name: true } } } } },
    orderBy: { profit: 'asc' },
    take: 20,
  });

  for (const o of negOrders) {
    const productNames = o.items.map((i) => i.product.name).join(', ');
    alerts.push({
      type:     'negative_margin',
      severity: o.profit < -50 ? 'high' : 'medium',
      orderId:  o.id,
      message:  `Pedido ${o.externalId || o.id} com margem negativa: R$ ${o.profit.toFixed(2)}`,
      products: productNames,
      soldAt:   o.soldAt,
    });
  }

  // Prisma não suporta comparação coluna vs coluna diretamente — busca tudo e filtra em memória
  const allProducts = await prisma.product.findMany({
    where: { storeId: { in: storeIds } },
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

  // Intervalo do mês inteiro
  const [year, mon] = month.split('-').map(Number);
  const startDate = new Date(year, mon - 1, 1);
  const endDate   = new Date(year, mon, 0, 23, 59, 59); // último dia do mês

  const orderWhere = { storeId, status: 'paid', soldAt: { gte: startDate, lte: endDate } };

  const orders = await prisma.order.findMany({
    where:  orderWhere,
    select: { salePrice: true, profit: true, margin: true, soldAt: true },
  });

  const totalOrders  = orders.length;
  const totalRevenue = orders.reduce((s, o) => s + o.salePrice, 0);
  const totalProfit  = orders.reduce((s, o) => s + (o.profit ?? 0), 0);
  const avgMargin    = totalOrders ? orders.reduce((s, o) => s + (o.margin ?? 0), 0) / totalOrders : 0;

  // Items para products + costs
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
    const pid = item.product.id;
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

module.exports = { getSummary, getAlerts, getMonthlyReport };
