const prisma = require('../lib/prisma');
const { generateMonthlyReport } = require('../services/reportService');
const { parseYearMonth, r2 } = require('../lib/utils');

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

  const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true, name: true, marketplace: true } });
  const storeIds           = stores.map((s) => s.id);
  const marketplaceByStore = Object.fromEntries(stores.map((s) => [s.id, s.marketplace]));
  const storeNameByStore   = Object.fromEntries(stores.map((s) => [s.id, s.name]));

  if (!storeIds.length) {
    return res.json({
      totalRevenue: 0, totalProfit: 0, avgMargin: 0, totalOrders: 0, avgTicket: 0,
      negativeMargin: 0, topProducts: [], worstProducts: [], monthlyChart: [],
      costsBreakdown: {}, prevKPIs: null, sparkline: [], channelBreakdown: [], dailyHeatmap: [],
      closedRevenue: { total: 0, months: [] },
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
  const [orders, prevOrdersRaw, sparkOrdersRaw, itemsRaw, singleStore, closedClosingsRaw, categoryGroups] = await Promise.all([
    prisma.order.findMany({
      where:  orderWhere,
      select: { salePrice: true, profit: true, calcGrossProfit: true, margin: true, soldAt: true, storeId: true, orderId: true, orderCategory: true },
    }),
    prevFilter
      ? prisma.order.findMany({
          where:  { storeId: { in: storeIds }, status: 'paid', soldAt: prevFilter },
          select: { salePrice: true, profit: true, calcGrossProfit: true, margin: true },
        })
      : Promise.resolve([]),
    prisma.order.findMany({
      where:  { storeId: { in: storeIds }, status: 'paid', soldAt: { gte: sixMonthsAgo } },
      select: { salePrice: true, profit: true, calcGrossProfit: true, margin: true, soldAt: true },
    }),
    prisma.order.findMany({
      where:   { ...orderWhere, productId: { not: null } },
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
    // Contagem por categoria no período (TODOS os status) para a taxa de devolução
    prisma.order.groupBy({
      by:     ['orderCategory'],
      where:  { storeId: { in: storeIds }, ...(dateFilter ? { soldAt: dateFilter } : {}) },
      _count: { _all: true },
    }),
  ]);

  // Lucro robusto por pedido: calcGrossProfit é a fonte da verdade (recomputado do raw
  // no recalculateService). Fallback para o campo legado `profit` quando calc* ausente
  // — assim o número não depende de o recalculate ter rodado.
  const orderProfit = (o) => o.calcGrossProfit ?? o.profit ?? 0;

  // ── KPIs do período atual ──────────────────────────────────────────────────
  // Pedidos únicos: conta orderId distintos (1 pedido multi-produto = N linhas, 1 order_sn)
  const uniqueOrderIds = new Set(orders.map(o => o.orderId).filter(Boolean));
  const totalOrders   = uniqueOrderIds.size || orders.length; // inclui valid+pending+returned_partial

  // Pedidos pagos = valid + pending (exclui returned_partial — alinha com Shopee Seller)
  const paidOrderIds  = new Set(orders.filter(o => o.orderCategory === 'valid' || o.orderCategory === 'pending').map(o => o.orderId).filter(Boolean));
  const paidOrders    = paidOrderIds.size;

  // Pedidos válidos = apenas COMPLETED (valid)
  const validOrderIds = new Set(orders.filter(o => o.orderCategory === 'valid').map(o => o.orderId).filter(Boolean));
  const validOrders   = validOrderIds.size;

  // Valor de vendas válidas = GMV apenas de pedidos COMPLETED
  const validRevenue  = orders.filter(o => o.orderCategory === 'valid').reduce((s, o) => s + o.salePrice, 0);

  const totalItems    = orders.length; // itens totais (linhas)
  const totalRevenue  = orders.reduce((s, o) => s + o.salePrice, 0);
  const totalProfit   = orders.reduce((s, o) => s + orderProfit(o), 0);
  const avgMargin     = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;
  const avgTicket     = paidOrders ? totalRevenue / paidOrders : 0;
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
  if (prevFilter) {
    const prevCount   = prevOrdersRaw.length;
    const prevRevenue = prevOrdersRaw.reduce((s, o) => s + o.salePrice, 0);
    const prevProfit  = prevOrdersRaw.reduce((s, o) => s + orderProfit(o), 0);
    prevKPIs = {
      totalRevenue: parseFloat(prevRevenue.toFixed(2)),
      totalProfit:  parseFloat(prevProfit.toFixed(2)),
      avgMargin:    prevRevenue > 0 ? parseFloat(((prevProfit / prevRevenue) * 100).toFixed(2)) : 0,
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
    const key = o.soldAt.toISOString().substring(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { month: key, revenue: 0, profit: 0 };
    monthlyMap[key].revenue += o.salePrice;
    monthlyMap[key].profit  += orderProfit(o);
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
    channelMap[ch].profit  += orderProfit(o);
    channelMap[ch].orders++;
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
  const storeNameMap  = Object.fromEntries(stores.map((s) => [s.id, { name: s.name, marketplace: s.marketplace }]));

  for (const o of orders) {
    const day = o.soldAt.toISOString().substring(0, 10);
    // Total
    if (!dailyMap[day]) dailyMap[day] = { date: day, revenue: 0, orders: 0 };
    dailyMap[day].revenue += o.salePrice;
    dailyMap[day].orders++;
    // Por loja
    if (!dailyByStore[o.storeId]) dailyByStore[o.storeId] = {};
    if (!dailyByStore[o.storeId][day]) dailyByStore[o.storeId][day] = { date: day, revenue: 0, orders: 0 };
    dailyByStore[o.storeId][day].revenue += o.salePrice;
    dailyByStore[o.storeId][day].orders++;
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

  // ── Projeção de fechamento (só para o mês corrente em andamento) ──
  let projection = null;
  if (startDate && endDate) {
    const sd = new Date(startDate);
    const now = new Date();
    const isCurrentMonth = sd.getUTCFullYear() === now.getUTCFullYear() && sd.getUTCMonth() === now.getUTCMonth();
    if (isCurrentMonth) {
      const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
      const dayOfMonth  = now.getUTCDate();
      if (dayOfMonth > 0 && dayOfMonth < daysInMonth) {
        const factor = daysInMonth / dayOfMonth;
        projection = {
          revenue:     parseFloat((totalRevenue * factor).toFixed(2)),
          profit:      parseFloat((totalProfit  * factor).toFixed(2)),
          daysElapsed: dayOfMonth,
          daysInMonth,
        };
      }
    }
  }

  // ── Taxa de devolução do período ───────────────────────────────────────────
  // (returned_full + returned_partial) / total de pedidos gerados no período × 100.
  // Base = TODOS os pedidos (qualquer status), pois cancelados/devolvidos também
  // contam como pedidos gerados. Alta taxa destrói a margem real (frete + embalagem).
  const catCount = {};
  let totalGenerated = 0;
  for (const g of categoryGroups) {
    const n = g._count._all;
    catCount[g.orderCategory ?? 'valid'] = (catCount[g.orderCategory ?? 'valid'] ?? 0) + n;
    totalGenerated += n;
  }
  const returnedFullCount    = catCount.returned_full ?? 0;
  const returnedPartialCount = catCount.returned_partial ?? 0;
  const returnedCount        = returnedFullCount + returnedPartialCount;
  const returnRate = {
    rate:                 totalGenerated > 0 ? parseFloat(((returnedCount / totalGenerated) * 100).toFixed(1)) : 0,
    returnedCount,
    returnedFullCount,
    returnedPartialCount,
    totalGenerated,
  };

  return res.json({
    totalRevenue:   parseFloat(totalRevenue.toFixed(2)),
    totalProfit:    parseFloat(totalProfit.toFixed(2)),
    avgMargin:      parseFloat(avgMargin.toFixed(2)),
    totalOrders,   // todos os pedidos com receita (valid+pending+returned_partial)
    paidOrders,    // valid + pending — alinha com "pedidos" do Shopee Seller App
    validOrders,   // apenas COMPLETED (valid)
    validRevenue:   parseFloat(validRevenue.toFixed(2)),
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

  const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return res.json({ summaries: [], totals: null });

  const where = { storeId: { in: storeIds } };
  if (month) where.month = month;

  const summaries = await prisma.shopeePeriodSummary.findMany({
    where,
    orderBy: { month: 'desc' },
  });

  // Aggregate across stores/months if no filter
  const totals = summaries.reduce(
    (acc, s) => ({
      gmv:                  acc.gmv              + s.gmv,
      shopeeDeductions:     acc.shopeeDeductions + s.shopeeDeductions,
      netRevenue:           acc.netRevenue        + s.netRevenue,
      tax:                  acc.tax              + (s.tax ?? 0),
      grossProfit:          acc.grossProfit       + s.grossProfit,
      validCount:           acc.validCount        + s.validCount,
      unitCount:            acc.unitCount         + s.unitCount,
      cancelledCount:       acc.cancelledCount    + s.cancelledCount,
      cancelledGmv:         acc.cancelledGmv      + s.cancelledGmv,
      unpaidCount:          acc.unpaidCount       + s.unpaidCount,
      unpaidGmv:            acc.unpaidGmv         + s.unpaidGmv,
      returnedFullCount:    acc.returnedFullCount + s.returnedFullCount,
      returnedFullValue:    acc.returnedFullValue + s.returnedFullValue,
      returnedPartialCount: acc.returnedPartialCount + s.returnedPartialCount,
      returnedPartialValue: acc.returnedPartialValue + s.returnedPartialValue,
    }),
    {
      gmv: 0, shopeeDeductions: 0, netRevenue: 0, tax: 0, grossProfit: 0,
      validCount: 0, unitCount: 0,
      cancelledCount: 0, cancelledGmv: 0,
      unpaidCount: 0, unpaidGmv: 0,
      returnedFullCount: 0, returnedFullValue: 0,
      returnedPartialCount: 0, returnedPartialValue: 0,
    }
  );

  totals.margin = totals.gmv > 0 ? parseFloat(((totals.grossProfit / totals.gmv) * 100).toFixed(2)) : 0;
  totals.returnedCount = totals.returnedFullCount + totals.returnedPartialCount;
  totals.returnedValue = parseFloat((totals.returnedFullValue + totals.returnedPartialValue).toFixed(2));
  totals.cancellationRate = totals.validCount + totals.cancelledCount + totals.unpaidCount > 0
    ? parseFloat(((totals.cancelledCount + totals.unpaidCount) / (totals.validCount + totals.cancelledCount + totals.unpaidCount + totals.returnedFullCount + totals.returnedPartialCount) * 100).toFixed(1))
    : 0;

  // Parse cancel reason breakdowns
  const cancelReasonMap = {};
  for (const s of summaries) {
    try {
      const reasons = JSON.parse(s.cancelReasonBreakdown || '{}');
      for (const [reason, count] of Object.entries(reasons)) {
        cancelReasonMap[reason] = (cancelReasonMap[reason] || 0) + count;
      }
    } catch {}
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
// Comparativo de rentabilidade por loja + produtos campeões cross-loja.
// Recomputa SEMPRE do raw — nunca usa calc* armazenados (regras invioláveis 1/2/3).
async function getStoresComparison(req, res) {
  const { storeId } = req.query;

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

  // Período: mês atual, ou anterior se dia < 5
  const now = new Date();
  let y = now.getUTCFullYear(), m = now.getUTCMonth(); // 0-indexed
  if (now.getUTCDate() < 5) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const periodStart = new Date(Date.UTC(y, m, 1));
  const periodEnd   = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
  const periodKey   = `${y}-${String(m + 1).padStart(2, '0')}`;

  const storeIds         = stores.map((s) => s.id);
  const storeTaxRateMap  = new Map(stores.map((s) => [s.id, s.taxRate ?? 0]));
  const storeMetaMap     = new Map(stores.map((s) => [s.id, s]));

  // Buscar todos os pedidos do período (sem filtro de status — classificar por orderCategory)
  const orders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      soldAt:  { gte: periodStart, lte: periodEnd },
    },
    select: {
      storeId:            true,
      orderCategory:      true,
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
  const storeAcc = {}; // storeId → { gmv, netRevenue, profit, orders }
  for (const s of stores) {
    storeAcc[s.id] = { gmv: 0, netRevenue: 0, profit: 0, orders: 0 };
  }

  // Map para topProduct por loja: storeId → { productId → { name, profit, netRevenue } }
  const productByStore = {};

  // Map para crossStoreProducts: normalizedName → { name (original), storeId → { profit, netRevenue, orders } }
  const crossMap = {};

  for (const o of orders) {
    const isConfirmed = o.orderCategory === 'valid';
    const isPending   = o.orderCategory === 'pending';
    const isRevenue   = isConfirmed || isPending;

    if (!isRevenue) continue;

    const aliquota    = storeTaxRateMap.get(o.storeId) ?? 0;
    const orderFee    = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
    const orderDisc   = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
    const orderNet    = r2((o.calcGmv ?? 0) - orderFee - orderDisc);
    const orderRepasse = isConfirmed ? r2(o.escrowAmount ?? orderNet) : orderNet;
    const orderTax    = r2((o.calcGmv ?? 0) * aliquota / 100);
    const orderProfit = r2(orderRepasse - orderTax - (o.calcProductCost ?? 0) - (o.calcPackaging ?? 0));

    // Acumular por loja
    const acc = storeAcc[o.storeId];
    acc.gmv        += o.calcGmv ?? 0;
    acc.netRevenue += orderRepasse;
    acc.profit     += orderProfit;
    acc.orders++;

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
        crossMap[normName].stores[o.storeId] = { profit: 0, netRevenue: 0, orders: 0 };
      }
      crossMap[normName].stores[o.storeId].profit     += orderProfit;
      crossMap[normName].stores[o.storeId].netRevenue += orderRepasse;
      crossMap[normName].stores[o.storeId].orders++;
    }
  }

  // Montar array de lojas com topProduct
  const storesResult = stores.map((s) => {
    const acc    = storeAcc[s.id];
    const gmv    = r2(acc.gmv);
    const net    = r2(acc.netRevenue);
    const profit = r2(acc.profit);
    const margin = net > 0 ? r2(profit / net * 100) : 0;
    const avgTicket = acc.orders > 0 ? r2(gmv / acc.orders) : 0;

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
      orders:     acc.orders,
      avgTicket,
      topProduct,
    };
  }).sort((a, b) => b.profit - a.profit);

  // Montar crossStoreProducts: apenas produtos em >= 2 lojas distintas
  const crossStoreProducts = [];
  for (const [normName, data] of Object.entries(crossMap)) {
    const storeEntries = Object.entries(data.stores); // [storeId, { profit, netRevenue, orders }]
    if (storeEntries.length < 2) continue;

    const channels = storeEntries.map(([sid, vals]) => {
      const meta   = storeMetaMap.get(sid);
      const margin = vals.netRevenue > 0 ? r2(vals.profit / vals.netRevenue * 100) : 0;
      return {
        storeId:    sid,
        storeName:  meta?.name ?? sid,
        marketplace: meta?.marketplace ?? 'outros',
        margin,
        profit:  r2(vals.profit),
        orders:  vals.orders,
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
      start: periodStart.toISOString(),
      end:   periodEnd.toISOString(),
    },
    stores:              storesResult,
    crossStoreProducts:  crossTop8,
  });
}

module.exports = { getSummary, getAlerts, getMonthlyReport, getMonthlyComparison, getShopeeSummary, getShopeeLosses, getStoresComparison };
