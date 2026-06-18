const prisma        = require('../lib/prisma');
const { r2 }        = require('../lib/utils');

function computeBillStatus(bill) {
  if (bill.status === 'paid') return 'paid';
  return new Date(bill.dueDate) < new Date() ? 'overdue' : 'pending';
}

async function getSummary(req, res) {
  const { storeId, startDate, endDate } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores = await prisma.store.findMany({
    where:  storeWhere,
    select: { id: true, taxRate: true, taxType: true, fixedMonthlyTax: true },
  });
  const storeIds = stores.map((s) => s.id);

  // Mapa de alíquota por loja — imposto sempre sobre GMV bruto (Simples Nacional)
  const storeTaxRateMap = new Map(stores.map((s) => [s.id, s.taxRate ?? 0]));

  // DAS MEI: soma o valor fixo mensal de cada loja MEI (cobrado uma vez, não por pedido)
  const fixedTaxAmount = r2(
    stores
      .filter((s) => s.taxType === 'mei')
      .reduce((sum, s) => sum + (s.fixedMonthlyTax ?? 0), 0),
  );

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

  const billWhere = {
    userId: req.userId,
    ...(storeId ? { storeId } : {}),
    ...(Object.keys(dateFilter).length ? { dueDate: dateFilter } : {}),
  };

  const [orders, bills] = await Promise.all([
    prisma.order.findMany({
      where:  orderWhere,
      select: {
        storeId:            true,
        orderCategory:      true,
        calcGmv:            true,
        calcProductCost:    true,
        calcPackaging:      true,
        soldAt:             true,
        platformCommission: true,
        platformServiceFee: true,
        sellerCoupon:       true,
        lmmDiscount:        true,
        escrowAmount:       true,
        shopeeShippingCost: true,
        quantity:           true,
      },
    }),
    prisma.bill.findMany({ where: billWhere }),
  ]);

  // Aggregate DRE recomputando do RAW — nunca usar calcShopeeFee/calcNetRevenue/calcTax armazenados
  let totalRevenueConfirmed = 0;
  let totalRevenuePending   = 0;
  let totalCommission       = 0;
  let totalServiceFee       = 0;
  let totalFreight          = 0;
  let totalCmv              = 0;
  let totalPackaging        = 0;
  let totalTaxProv          = 0;
  let repasseConfirmed      = 0;
  let repassePending        = 0;
  let confirmedOrderCount   = 0;
  let pendingOrderCount     = 0;

  const monthlyMap = {};

  for (const o of orders) {
    const isConfirmed = o.orderCategory === 'valid';
    const aliquota    = storeTaxRateMap.get(o.storeId) ?? 0;

    const orderFee    = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
    const orderDisc   = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
    const orderNet    = r2((o.calcGmv ?? 0) - orderFee - orderDisc);
    const orderRepasse = isConfirmed ? r2(o.escrowAmount ?? orderNet) : orderNet;
    const orderTax    = r2((o.calcGmv ?? 0) * aliquota / 100);
    const freight     = o.shopeeShippingCost ?? 0;

    if (isConfirmed) {
      totalRevenueConfirmed += o.calcGmv ?? 0;
      repasseConfirmed      += orderRepasse;
      confirmedOrderCount   += 1;
    } else {
      totalRevenuePending += o.calcGmv ?? 0;
      repassePending      += orderRepasse;
      pendingOrderCount   += 1;
    }

    totalCommission += o.platformCommission ?? 0;
    totalServiceFee += o.platformServiceFee ?? 0;
    totalFreight    += freight;
    totalTaxProv    += orderTax;
    totalCmv        += o.calcProductCost ?? 0;
    totalPackaging  += o.calcPackaging ?? 0;

    // monthlyMap: usa GMV de ambas categorias (visão de caixa do mês)
    const key = o.soldAt ? o.soldAt.toISOString().substring(0, 7) : 'unknown';
    if (!monthlyMap[key]) {
      monthlyMap[key] = { month: key, revenue: 0, cmv: 0, fees: 0, operational: 0, bills: 0, taxProvision: 0 };
    }
    const m = monthlyMap[key];
    m.revenue      += o.calcGmv ?? 0;
    m.fees         += orderFee;
    m.taxProvision += orderTax;
    m.cmv          += o.calcProductCost ?? 0;
    m.operational  += (o.calcPackaging ?? 0) + freight;
  }

  const totalMarketplaceFees  = r2(totalCommission + totalServiceFee);
  const totalOperationalCosts = r2(totalPackaging + totalFreight);

  // Bills
  const enrichedBills  = bills.map((b) => ({ ...b, computedStatus: computeBillStatus(b) }));
  const totalPaid      = enrichedBills.filter((b) => b.computedStatus === 'paid').reduce((s, b) => s + b.amount, 0);
  const totalPending   = enrichedBills.filter((b) => b.computedStatus === 'pending').reduce((s, b) => s + b.amount, 0);
  const totalOverdue   = enrichedBills.filter((b) => b.computedStatus === 'overdue').reduce((s, b) => s + b.amount, 0);

  const byCategory = {};
  for (const b of enrichedBills) {
    if (!byCategory[b.category]) byCategory[b.category] = 0;
    byCategory[b.category] += b.amount;
  }

  // DRE — Receita Bruta = confirmada; estimado é campo separado
  const grossProfit             = r2(totalRevenueConfirmed - totalCmv);
  const operatingProfit         = r2(grossProfit - totalMarketplaceFees - totalOperationalCosts - totalPaid);
  const operatingProfitProjected = r2(operatingProfit - totalPending);
  // netProfit desconta imposto proporcional + DAS MEI fixo (uma vez no período)
  const netProfit               = r2(operatingProfit - totalTaxProv - fixedTaxAmount);
  const netProfitProjected      = r2(operatingProfitProjected - totalTaxProv - fixedTaxAmount);

  // Bills into monthly map
  for (const b of enrichedBills) {
    const key = new Date(b.dueDate).toISOString().substring(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { month: key, revenue: 0, cmv: 0, fees: 0, operational: 0, bills: 0, taxProvision: 0 };
    monthlyMap[key].bills += b.amount;
  }

  const r = (v) => parseFloat(v.toFixed(2));

  const monthlyChart = Object.values(monthlyMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const np = m.revenue - m.cmv - m.fees - m.operational - m.bills - m.taxProvision;
      return {
        month:        m.month,
        revenue:      r(m.revenue),
        cmv:          r(m.cmv),
        fees:         r(m.fees),
        operational:  r(m.operational),
        bills:        r(m.bills),
        taxProvision: r(m.taxProvision),
        netProfit:    r(np),
      };
    });

  // Upcoming bills (next 30 days)
  const soonLimit = new Date();
  soonLimit.setDate(soonLimit.getDate() + 30);
  const upcoming = enrichedBills
    .filter((b) => b.computedStatus === 'pending' && new Date(b.dueDate) <= soonLimit)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
    .slice(0, 10);

  return res.json({
    orderCount: orders.length,
    dre: {
      grossRevenue:   r2(totalRevenueConfirmed),
      // Campos adicionados — receita estimada (pending) separada da confirmada
      estimatedRevenue:    r2(totalRevenuePending),
      repasseConfirmed:    r2(repasseConfirmed),
      repassePending:      r2(repassePending),
      confirmedOrderCount,
      pendingOrderCount,
      cmv:            r2(totalCmv),
      grossProfit:    r2(grossProfit),
      marketplaceFees: r2(totalMarketplaceFees),
      marketplaceFeesBreakdown: {
        commission: r2(totalCommission),
        serviceFee: r2(totalServiceFee),
        fixedFee:   0, // taxa fixa por item não rastreada no escrow — exibida só quando disponível
      },
      operationalCosts: r2(totalOperationalCosts),
      operationalCostsBreakdown: {
        packaging: r2(totalPackaging),
        supplies:  0,
        freight:   r2(totalFreight),
      },
      billsPaid:                  r2(totalPaid),
      billsPending:               r2(totalPending),
      billsOverdue:               r2(totalOverdue),
      operatingProfit:            r2(operatingProfit),
      operatingProfitProjected:   r2(operatingProfitProjected),
      taxProvision:               r2(totalTaxProv),
      fixedTax:                   r2(fixedTaxAmount),
      netProfit:                  r2(netProfit),
      netProfitProjected:         r2(netProfitProjected),
    },
    bills: {
      totalPaid:    r2(totalPaid),
      totalPending: r2(totalPending),
      totalOverdue: r2(totalOverdue),
      byCategory:   Object.entries(byCategory).map(([cat, val]) => ({ category: cat, amount: r2(val) })),
    },
    monthlyChart,
    upcoming,
  });
}

module.exports = { getSummary };
