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
        salePrice:          true,
        freight:            true,
        discount:           true,
        soldAt:             true,
        snapshotCommission: true,
        snapshotServiceFee: true,
        snapshotTaxRate:    true,
        snapshotFixedFee:   true,
        items: {
          select: {
            quantity:         true,
            snapshotCostPrice:true,
            snapshotPackaging:true,
            snapshotSupplies: true,
          },
        },
      },
    }),
    prisma.bill.findMany({ where: billWhere }),
  ]);

  // Aggregate DRE from orders
  let totalRevenue    = 0;
  let totalCmv        = 0;
  let totalPackaging  = 0;
  let totalSupplies   = 0;
  let totalFreight    = 0;
  let totalCommission = 0;
  let totalServiceFee = 0;
  let totalFixedFee   = 0;
  let totalTaxProv    = 0;

  const monthlyMap = {};

  for (const o of orders) {
    const effective = (o.salePrice ?? 0) - (o.discount ?? 0);
    totalRevenue    += effective;
    totalCommission += effective * ((o.snapshotCommission ?? 0) / 100);
    totalServiceFee += effective * ((o.snapshotServiceFee ?? 0) / 100);
    totalTaxProv    += effective * ((o.snapshotTaxRate    ?? 0) / 100);
    totalFreight    += o.freight ?? 0;

    const key = o.soldAt.toISOString().substring(0, 7);
    if (!monthlyMap[key]) {
      monthlyMap[key] = { month: key, revenue: 0, cmv: 0, fees: 0, operational: 0, bills: 0, taxProvision: 0 };
    }
    const m = monthlyMap[key];
    m.revenue    += effective;
    m.fees       += effective * (((o.snapshotCommission ?? 0) + (o.snapshotServiceFee ?? 0)) / 100);
    m.taxProvision += effective * ((o.snapshotTaxRate ?? 0) / 100);
    m.operational  += o.freight ?? 0;

    for (const item of o.items) {
      const qty  = item.quantity ?? 0;
      const cost = (item.snapshotCostPrice ?? 0) * qty;
      const pack = (item.snapshotPackaging  ?? 0) * qty;
      const supp = (item.snapshotSupplies   ?? 0) * qty;
      const fixd = (o.snapshotFixedFee      ?? 0) * qty;

      totalCmv       += cost;
      totalPackaging += pack;
      totalSupplies  += supp;
      totalFixedFee  += fixd;

      m.cmv         += cost;
      m.operational += pack + supp;
      m.fees        += fixd;
    }
  }

  const totalMarketplaceFees   = totalCommission + totalServiceFee + totalFixedFee;
  const totalOperationalCosts  = totalPackaging  + totalSupplies   + totalFreight;

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
        serviceFee: r(totalServiceFee),
        fixedFee:   r(totalFixedFee),
      },
      operationalCosts: r(totalOperationalCosts),
      operationalCostsBreakdown: {
        packaging: r(totalPackaging),
        supplies:  r(totalSupplies),
        freight:   r(totalFreight),
      },
      billsPaid:       r(totalPaid),
      operatingProfit: r(operatingProfit),
      taxProvision:    r(totalTaxProv),
      netProfit:       r(netProfit),
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
