const { r2 } = require('../lib/utils');

// ── Fórmula canônica de lucro por pedido — FONTE ÚNICA ────────────────────────
// Usada por: orderController (lista/CSV), closingController (Fechamento),
// dashboardController, goalsController e cashflowController.
//
// Cadeia: orderFee → orderDisc → orderNet → orderRepasse → orderTax → orderProfit
//   fee     = platformCommission + platformServiceFee (raw; fallback de exibição: calcShopeeFee)
//   disc    = sellerCoupon + lmmDiscount
//   net     = calcGmv - fee - disc
//   repasse = escrow real quando confirmado; senão estimativa (calcNetRevenue → net)
//   tax     = calcGmv × taxRate/100 (Simples Nacional sobre GMV bruto)
//   profit  = repasse - tax - custo   (null = sem estimativa confiável)

const REVENUE_ORDER_CATEGORIES = ['valid', 'pending', 'returned_partial'];

function isConfirmedRepasse(order, marketplace) {
  const rawStatus = String(order.orderStatus ?? '').toUpperCase();
  if (rawStatus === 'CANCELLED') return false;
  if (!['valid', 'returned_partial'].includes(order.orderCategory)) return false;
  if (String(marketplace ?? '').toLowerCase() === 'shopee') {
    return order.escrowAmount !== null && order.escrowAmount !== undefined;
  }
  return !!order.orderPaidAt || order.status === 'paid';
}

function expectedRepasse(order, marketplace) {
  if (isConfirmedRepasse(order, marketplace)) {
    return String(marketplace ?? '').toLowerCase() === 'shopee'
      ? (order.escrowAmount ?? 0)
      : (order.calcNetRevenue ?? order.escrowAmount ?? 0);
  }
  if (!REVENUE_ORDER_CATEGORIES.includes(order.orderCategory)) return 0;
  if (order.calcNetRevenue > 0) return order.calcNetRevenue;

  const gmv = r2(order.calcGmv ?? order.salePrice ?? 0);
  const fee = r2((order.platformCommission ?? 0) + (order.platformServiceFee ?? 0));
  const discount = r2((order.sellerCoupon ?? 0) + (order.lmmDiscount ?? 0));
  if (fee <= 0 && discount <= 0) return null;
  const estimatedNet = r2(gmv - fee - discount);
  return gmv > 0 && estimatedNet > 0 ? estimatedNet : null;
}

function calcOrderFinancials(order, taxRate = 0, marketplace = 'shopee') {
  const gmv = r2(order.calcGmv ?? order.salePrice ?? 0);
  const rawFee = r2((order.platformCommission ?? 0) + (order.platformServiceFee ?? 0));
  // Para pedidos pendentes sem escrow, platformCommission/platformServiceFee são 0.
  // Usa calcShopeeFee (taxa estimada já salva pelo recalculate) como fallback de exibição.
  const fee = rawFee > 0 ? rawFee : r2(order.calcShopeeFee ?? 0);
  const disc = r2((order.sellerCoupon ?? 0) + (order.lmmDiscount ?? 0));
  const net = r2(gmv - rawFee - disc);
  const confirmed = isConfirmedRepasse(order, marketplace);
  const netRevenueRaw = expectedRepasse(order, marketplace);
  const netRevenue = netRevenueRaw === null || netRevenueRaw === undefined ? null : r2(netRevenueRaw);
  const tax = r2(gmv * taxRate / 100);
  const cost = r2((order.calcProductCost ?? 0) + (order.calcPackaging ?? 0));
  const profit = netRevenue === null ? null : r2(netRevenue - tax - cost);
  const margin = gmv > 0 && profit !== null ? r2((profit / gmv) * 100) : 0;

  return { gmv, fee, disc, net, netRevenue, repasse: netRevenue, tax, cost, profit, margin, confirmed };
}

module.exports = { REVENUE_ORDER_CATEGORIES, isConfirmedRepasse, expectedRepasse, calcOrderFinancials };
