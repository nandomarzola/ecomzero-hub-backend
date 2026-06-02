const prisma = require('../lib/prisma');

function computeBillStatus(bill) {
  if (bill.status === 'paid') return 'paid';
  return new Date(bill.dueDate) < new Date() ? 'overdue' : 'pending';
}

async function getSummary(req, res) {
  const { storeId, startDate, endDate } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);

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
        calcGmv:         true,
        calcShopeeFee:   true,
        calcNetRevenue:  true,
        calcTax:         true,
        calcProductCost: true,
        calcPackaging:   true,
        calcGrossProfit: true,
        soldAt:          true,
      },
    }),
    prisma.bill.findMany({ where: billWhere }),
  ]);

  // Aggregate DRE from orders
  let totalRevenue    = 0;
  let totalCmv        = 0;
  let totalPackaging  = 0;
  let totalCommission = 0;
  let totalTaxProv    = 0;

  const monthlyMap = {};

  for (const o of orders) {
    totalRevenue    += o.calcGmv;
    totalCommission += o.calcShopeeFee;
    totalTaxProv    += o.calcTax;
    totalCmv        += o.calcProductCost;
    totalPackaging  += o.calcPackaging;

    const key = o.soldAt ? o.soldAt.toISOString().substring(0, 7) : 'unknown';
    if (!monthlyMap[key]) {
      monthlyMap[key] = { month: key, revenue: 0, cmv: 0, fees: 0, operational: 0, bills: 0, taxProvision: 0 };
    }
    const m = monthlyMap[key];
    m.revenue     += o.calcGmv;
    m.fees        += o.calcShopeeFee;
    m.taxProvision += o.calcTax;
    m.cmv         += o.calcProductCost;
    m.operational += o.calcPackaging;
  }

  const totalMarketplaceFees  = totalCommission;
  const totalOperationalCosts = totalPackaging;

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

  // DRE
  const grossProfit      = totalRevenue - totalCmv;
  const operatingProfit  = grossProfit - totalMarketplaceFees - totalOperationalCosts - totalPaid;
  const netProfit        = operatingProfit - totalTaxProv;
  // Projeção incluindo contas pendentes do período
  const operatingProfitProjected = operatingProfit - totalPending;
  const netProfitProjected       = operatingProfitProjected - totalTaxProv;

  // Bills into monthly map
  for (const b of enrichedBills) {
    const key = new Date(b.dueDate).toISOString().substring(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { month: key, revenue: 0, cmv: 0, fees: 0, operational: 0, bills: 0, taxProvision: 0 };
    monthlyMap[key].bills += b.amount;
  }

  const monthlyChart = Object.values(monthlyMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const np = m.revenue - m.cmv - m.fees - m.operational - m.bills - m.taxProvision;
      return {
        month:        m.month,
        revenue:      parseFloat(m.revenue.toFixed(2)),
        cmv:          parseFloat(m.cmv.toFixed(2)),
        fees:         parseFloat(m.fees.toFixed(2)),
        operational:  parseFloat(m.operational.toFixed(2)),
        bills:        parseFloat(m.bills.toFixed(2)),
        taxProvision: parseFloat(m.taxProvision.toFixed(2)),
        netProfit:    parseFloat(np.toFixed(2)),
      };
    });

  // Upcoming bills (next 30 days)
  const soonLimit = new Date();
  soonLimit.setDate(soonLimit.getDate() + 30);
  const upcoming = enrichedBills
    .filter((b) => b.computedStatus === 'pending' && new Date(b.dueDate) <= soonLimit)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
    .slice(0, 10);

  const r = (v) => parseFloat(v.toFixed(2));

  return res.json({
    orderCount: orders.length,
    dre: {
      grossRevenue:   r(totalRevenue),
      cmv:            r(totalCmv),
      grossProfit:    r(grossProfit),
      marketplaceFees: r(totalMarketplaceFees),
      marketplaceFeesBreakdown: {
        commission: r(totalCommission),
        serviceFee: 0,
        fixedFee:   0,
      },
      operationalCosts: r(totalOperationalCosts),
      operationalCostsBreakdown: {
        packaging: r(totalPackaging),
        supplies:  0,
        freight:   0,
      },
      billsPaid:                  r(totalPaid),
      billsPending:               r(totalPending),
      billsOverdue:               r(totalOverdue),
      operatingProfit:            r(operatingProfit),
      operatingProfitProjected:   r(operatingProfitProjected),
      taxProvision:               r(totalTaxProv),
      netProfit:                  r(netProfit),
      netProfitProjected:         r(netProfitProjected),
    },
    bills: {
      totalPaid:    r(totalPaid),
      totalPending: r(totalPending),
      totalOverdue: r(totalOverdue),
      byCategory:   Object.entries(byCategory).map(([cat, val]) => ({ category: cat, amount: r(val) })),
    },
    monthlyChart,
    upcoming,
  });
}

module.exports = { getSummary };
