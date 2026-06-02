const prisma = require('../lib/prisma');

const fmtBRL = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v ?? 0);
const DAYS_PT = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

async function getInsights(req, res) {
  const { storeId, startDate, endDate } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return res.json({ insights: [] });

  const dateFilter = {};
  if (startDate) dateFilter.gte = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);
    dateFilter.lte = end;
  }

  const orderWhere = {
    storeId: { in: storeIds },
    status:  'paid',
    ...(Object.keys(dateFilter).length ? { soldAt: dateFilter } : {}),
  };

  const [orders, products, recentItems] = await Promise.all([
    prisma.order.findMany({
      where:  { ...orderWhere, productId: { not: null } },
      select: {
        profit:          true,
        soldAt:          true,
        productId:       true,
        quantity:        true,
        calcGmv:         true,
        calcGrossProfit: true,
        product: { select: { name: true } },
      },
    }),
    prisma.product.findMany({
      where:  { storeId: { in: storeIds } },
      select: { id: true, name: true, stock: true, costPrice: true },
    }),
    prisma.order.findMany({
      where: {
        storeId: { in: storeIds },
        status:  'paid',
        productId: { not: null },
        soldAt:  { gte: new Date(Date.now() - 30 * 86400000) },
      },
      select: { productId: true, quantity: true },
    }),
  ]);

  const insights = [];

  // ─── Per-product profitability (proportional allocation) ──────────────────
  const prodProfit  = {};
  const prodRevenue = {};
  const prodQty     = {};
  const prodNames   = {};

  for (const order of orders) {
    if (!order.productId) continue;
    prodProfit[order.productId]  = (prodProfit[order.productId]  ?? 0) + (order.calcGrossProfit ?? 0);
    prodRevenue[order.productId] = (prodRevenue[order.productId] ?? 0) + order.calcGmv;
    prodQty[order.productId]     = (prodQty[order.productId]     ?? 0) + order.quantity;
    if (order.product?.name) prodNames[order.productId] = order.product.name;
  }

  // 1. Most profitable product
  const sortedByProfit = Object.entries(prodProfit).sort((a, b) => b[1] - a[1]);
  if (sortedByProfit.length > 0) {
    const [topId, topProfit] = sortedByProfit[0];
    const rev    = prodRevenue[topId] ?? 0;
    const margin = rev > 0 ? (topProfit / rev) * 100 : 0;
    insights.push({
      type:     'top_product',
      priority: 40,
      icon:     '🏆',
      title:    'Produto mais lucrativo',
      message:  `${prodNames[topId] ?? 'Produto'} com ${fmtBRL(topProfit)} de lucro (margem ${margin.toFixed(1)}%)`,
      action:   { label: 'Ver produtos', href: '/products' },
    });
  }

  // 2. Low-margin products
  const lowMarginCount = Object.entries(prodProfit).filter(([id, profit]) => {
    const rev = prodRevenue[id] ?? 0;
    return rev > 0 && (profit / rev) * 100 < 20;
  }).length;
  if (lowMarginCount > 0) {
    insights.push({
      type:     'low_margin',
      priority: 20,
      icon:     '🔴',
      title:    'Margem baixa',
      message:  `${lowMarginCount} produto${lowMarginCount > 1 ? 's' : ''} com margem abaixo de 20% — verifique a precificação`,
      action:   { label: 'Ver Rel. SKU', href: '/sku-report' },
    });
  }

  // 3. Best day of week
  const dayRevArr   = Array(7).fill(0);
  const dayCountArr = Array(7).fill(0);
  for (const order of orders) {
    const dow = new Date(order.soldAt).getDay();
    dayRevArr[dow]   += order.profit ?? 0;
    dayCountArr[dow]++;
  }
  if (orders.length >= 7) {
    const dayAvg  = dayRevArr.map((r, i) => ({ dow: i, avg: dayCountArr[i] > 0 ? r / dayCountArr[i] : 0 }));
    const bestDay = dayAvg.reduce((b, c) => c.avg > b.avg ? c : b, dayAvg[0]);
    if (bestDay && bestDay.avg > 0) {
      insights.push({
        type:     'best_day',
        priority: 50,
        icon:     '📈',
        title:    'Melhor dia da semana',
        message:  `${DAYS_PT[bestDay.dow]} é seu melhor dia (média ${fmtBRL(bestDay.avg)} de lucro)`,
        action:   null,
      });
    }
  }

  // 4. Critical stock + lost potential
  const salesVelocity = {};
  for (const item of recentItems) {
    if (!item.productId) continue;
    salesVelocity[item.productId] = (salesVelocity[item.productId] ?? 0) + item.quantity;
  }
  for (const id of Object.keys(salesVelocity)) {
    salesVelocity[id] = salesVelocity[id] / 30;
  }

  const now = new Date();
  const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();

  for (const prod of products) {
    const velocity = salesVelocity[prod.id] ?? 0;
    if (velocity <= 0) continue;
    const daysRemaining = prod.stock / velocity;

    if (daysRemaining < 10) {
      insights.push({
        type:     'critical_stock',
        priority: 10,
        icon:     '⚠️',
        title:    'Estoque crítico',
        message:  `${prod.name} com estoque para apenas ${Math.round(daysRemaining)} dia${Math.round(daysRemaining) !== 1 ? 's' : ''}`,
        action:   { label: 'Ver estoque', href: '/estoque' },
      });
    }

    if (daysRemaining < daysLeft) {
      const profitPerUnit = prodProfit[prod.id] && prodQty[prod.id] > 0
        ? prodProfit[prod.id] / prodQty[prod.id]
        : prod.costPrice * 0.25;
      const potentialUnits  = Math.ceil((daysLeft - Math.max(0, daysRemaining)) * velocity);
      const potentialProfit = potentialUnits * profitPerUnit;
      if (potentialProfit > 50) {
        insights.push({
          type:     'lost_potential',
          priority: 15,
          icon:     '💡',
          title:    'Potencial perdido',
          message:  `Repondo ${prod.name} agora, potencial de ${fmtBRL(potentialProfit)} adicionais este mês`,
          action:   { label: 'Criar pedido', href: '/purchase-orders' },
        });
      }
    }
  }

  insights.sort((a, b) => a.priority - b.priority);
  return res.json({ insights: insights.slice(0, 7) });
}

module.exports = { getInsights };
