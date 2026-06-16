const prisma = require('../lib/prisma');
const { r2 } = require('../lib/utils');

function r4(n) { return Math.round(n * 10000) / 10000; }

async function recalculateStoreRates(storeId, month, year) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end   = new Date(Date.UTC(year, month,     1));

  const orders = await prisma.order.findMany({
    where: {
      storeId,
      orderCategory: { notIn: ['cancelled_unpaid', 'cancelled_other', 'returned_full'] },
      soldAt: { gte: start, lt: end },
    },
    select: {
      calcGmv:         true,
      calcNetRevenue:  true,
      calcShopeeFee:   true,
      platformServiceFee: true,
    },
  });

  const totalOrders = orders.length;
  if (totalOrders === 0) return null;

  const totalGmv        = orders.reduce((s, o) => s + (o.calcGmv        ?? 0), 0);
  const totalNetRevenue = orders.reduce((s, o) => s + (o.calcNetRevenue  ?? 0), 0);
  const totalFee        = orders.reduce((s, o) => s + (o.calcShopeeFee   ?? 0), 0);
  const totalSvcFee     = orders.reduce((s, o) => s + (o.platformServiceFee ?? 0), 0);

  const avgCommissionRate = totalGmv > 0 ? r4((totalFee    / totalGmv) * 100) : 0;
  const avgServiceFeeRate = totalGmv > 0 ? r4((totalSvcFee / totalGmv) * 100) : 0;
  const effectiveRate     = totalGmv > 0 ? r4(((totalGmv - totalNetRevenue) / totalGmv) * 100) : 0;

  return prisma.storeRate.upsert({
    where:  { storeId_month_year: { storeId, month, year } },
    create: {
      storeId, month, year, totalOrders,
      avgCommissionRate, avgServiceFeeRate, avgShippingFee: 0,
      effectiveRate, totalGmv: r2(totalGmv), totalNetRevenue: r2(totalNetRevenue),
    },
    update: {
      totalOrders,
      avgCommissionRate, avgServiceFeeRate,
      effectiveRate, totalGmv: r2(totalGmv), totalNetRevenue: r2(totalNetRevenue),
    },
  });
}

module.exports = { recalculateStoreRates };
