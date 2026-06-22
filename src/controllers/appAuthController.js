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

async function getAppDashboard(req, res) {
  const { storeId } = req.query;
  const userId = req.userId;

  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Buscar lojas do usuário
  const stores = await prisma.store.findMany({
    where: { userId, ...(storeId ? { id: storeId } : {}) },
    select: { id: true, name: true, marketplace: true, taxRate: true },
  });
  const storeIds = stores.map(s => s.id);
  const taxRateMap = Object.fromEntries(stores.map(s => [s.id, s.taxRate ?? 0]));

  if (storeIds.length === 0) return res.json({ stores: [], summary: null });

  // GMV do ano (1° de janeiro até agora)
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const yearOrders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      soldAt: { gte: startOfYear },
      orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
      calcGmv: { gt: 0 },
    },
    select: { calcGmv: true },
  });
  const yearGmv = r2(yearOrders.reduce((s, o) => s + (o.calcGmv ?? 0), 0));

  // Devoluções e cancelamentos do dia
  const todayReturns = await prisma.order.count({
    where: {
      storeId: { in: storeIds },
      soldAt: { gte: startOfDay },
      orderCategory: { in: ['returned_full', 'returned_partial', 'cancelled_other', 'cancelled_unpaid'] },
    },
  });

  // Pedidos do mês com receita
  const orders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      soldAt: { gte: startOfMonth },
      orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
    },
    select: {
      id: true, storeId: true, soldAt: true, quantity: true,
      orderId: true, // para contar pedidos únicos (1 pedido multi-item = N linhas com mesmo orderId)
      calcGmv: true, platformCommission: true, platformServiceFee: true,
      sellerCoupon: true, lmmDiscount: true, escrowAmount: true,
      calcProductCost: true, calcPackaging: true, orderCategory: true,
      productId: true,
    },
  });

  // Calcular por loja (recompute do raw)
  const byStore = {};
  for (const s of stores) byStore[s.id] = { storeId: s.id, name: s.name, marketplace: s.marketplace, gmv: 0, profit: 0, orders: 0, items: 0 };

  let totalGmv = 0, totalProfit = 0, totalItems = 0;
  let todayGmv = 0, todayProfit = 0, todayItems = 0;

  // Sets para contar pedidos únicos por orderId
  const uniqueOrderIds      = new Set();
  const uniqueOrderIdsToday = new Set();
  const uniqueByStore       = {}; // storeId → Set de orderIds únicos
  for (const s of stores) uniqueByStore[s.id] = new Set();

  for (const o of orders) {
    const taxRate = taxRateMap[o.storeId] ?? 0;
    const fee   = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
    const disc  = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
    const repasse = o.orderCategory === 'valid' && o.escrowAmount != null
      ? r2(o.escrowAmount)
      : r2(o.calcGmv - fee - disc);
    const tax    = r2(o.calcGmv * (taxRate / 100));
    const profit = r2(repasse - tax - (o.calcProductCost ?? 0) - (o.calcPackaging ?? 0));

    byStore[o.storeId].gmv    += o.calcGmv;
    byStore[o.storeId].profit += profit;
    byStore[o.storeId].items  += 1;
    uniqueByStore[o.storeId].add(o.orderId);
    totalGmv    += o.calcGmv;
    totalProfit += profit;
    totalItems  += 1;
    uniqueOrderIds.add(o.orderId);

    const orderDate = new Date(o.soldAt);
    if (orderDate >= startOfDay) {
      todayGmv    += o.calcGmv;
      todayProfit += profit;
      todayItems  += 1;
      uniqueOrderIdsToday.add(o.orderId);
    }
  }

  // Contar pedidos únicos por loja
  for (const s of stores) {
    byStore[s.id].orders = uniqueByStore[s.id].size;
  }

  // Projeção do mês
  const daysElapsed = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projectedGmv    = daysElapsed > 0 ? r2(totalGmv    / daysElapsed * daysInMonth) : 0;
  const projectedProfit = daysElapsed > 0 ? r2(totalProfit / daysElapsed * daysInMonth) : 0;

  return res.json({
    month,
    summary: {
      gmv:    r2(totalGmv),
      profit: r2(totalProfit),
      orders: uniqueOrderIds.size,  // pedidos únicos (order_sn distintos)
      items:  totalItems,           // linhas totais (itens — 1 pedido multi-produto = N itens)
      margin: totalGmv > 0 ? r2((totalProfit / totalGmv) * 100) : 0,
    },
    yearGmv,
    today: {
      gmv:     r2(todayGmv),
      profit:  r2(todayProfit),
      orders:  uniqueOrderIdsToday.size, // pedidos únicos hoje
      items:   todayItems,               // itens hoje
      returns: todayReturns,
    },
    projection: {
      gmv: projectedGmv, profit: projectedProfit,
      daysElapsed, daysInMonth,
    },
    stores: Object.values(byStore).map(s => ({
      ...s,
      gmv: r2(s.gmv),
      profit: r2(s.profit),
      margin: s.gmv > 0 ? r2((s.profit / s.gmv) * 100) : 0,
    })).sort((a, b) => b.gmv - a.gmv),
  });
}

async function getAppTrends(req, res) {
  const { storeId, period = '7d' } = req.query;
  const userId = req.userId;
  const { r2 } = require('../lib/utils');

  const stores = await prisma.store.findMany({
    where: { userId, ...(storeId ? { id: storeId } : {}) },
    select: { id: true, taxRate: true },
  });
  const storeIds = stores.map(s => s.id);
  const taxRateMap = Object.fromEntries(stores.map(s => [s.id, s.taxRate ?? 0]));

  const now = new Date();
  const days = period === '30d' ? 30 : period === 'mes' ? now.getDate() : 7;
  const since = new Date(now); since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const orders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      soldAt: { gte: since },
      orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
    },
    select: {
      storeId: true, soldAt: true, calcGmv: true,
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
    const day = o.soldAt.toISOString().substring(0, 10);
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
    chart, // [{ date, gmv, profit, orders }]
    summary: { gmv: totalGmv, profit: totalProfit, orders: totalOrders, margin: avgMargin, avgTicket },
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

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week  = new Date(today); week.setDate(week.getDate() - 7);

  const [todayOrders, weekOrders, noCostCount] = await Promise.all([
    prisma.order.findMany({
      where: { storeId: { in: storeIds }, soldAt: { gte: today }, orderCategory: { in: ['valid', 'pending', 'returned_partial'] } },
      select: { calcGmv: true, platformCommission: true, platformServiceFee: true, sellerCoupon: true, lmmDiscount: true, escrowAmount: true, calcProductCost: true, calcPackaging: true, orderCategory: true, storeId: true, productName: true, orderId: true },
    }),
    prisma.order.findMany({
      where: { storeId: { in: storeIds }, soldAt: { gte: week }, orderCategory: { in: ['valid', 'pending', 'returned_partial'] } },
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
  const returns = await prisma.order.count({ where: { storeId: { in: storeIds }, soldAt: { gte: today }, orderCategory: { in: ['returned_full', 'returned_partial'] } } });
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

module.exports = { generateCode, verifyCode, getAppDashboard, getAppTrends, getAppAlerts, getAppOrderDetail };
