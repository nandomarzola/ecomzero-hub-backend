const prisma = require('../lib/prisma');
const { calcOrderProfit } = require('./calculatorService');

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

// Recalculates all orders for a specific store.
// periodMonth: 'YYYY-MM' to filter by month, null to recalculate all periods.
async function recalculateOrdersForStore(storeId, periodMonth = null) {
  const where = { storeId };

  if (periodMonth) {
    const [y, mo] = periodMonth.split('-').map(Number);
    where.soldAt = {
      gte: new Date(Date.UTC(y, mo - 1, 1)),
      lte: new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999)),
    };
  }

  const orders = await prisma.order.findMany({
    where,
    include: {
      store:   { select: { taxRate: true, marketplace: true } },
      product: { select: { costPrice: true, packaging: true } },
    },
  });

  if (!orders.length) return 0;

  const BATCH = 200;
  const updates = [];

  for (const order of orders) {
    const marketplace    = (order.store?.marketplace ?? 'shopee').toLowerCase();
    const taxRate        = order.store?.taxRate ?? 0;
    const mlFrete        = order.mlShippingCost   ?? 0;
    const mlParcelamento = order.mlInstallmentFee ?? 0;

    const precomputedFee = marketplace === 'mercadolivre'
      ? r2((order.platformCommission ?? 0) + mlFrete + mlParcelamento)
      : null;

    let platformNetRevenue = null;
    if (marketplace === 'shopee' && (order.globalTotal ?? 0) > 0) {
      platformNetRevenue = r2((order.globalTotal ?? 0) - (order.platformCommission ?? 0) - (order.platformServiceFee ?? 0));
    } else if (marketplace === 'shein' && (order.orderTotal ?? 0) > 0) {
      platformNetRevenue = r2(order.orderTotal);
    } else if (marketplace === 'tiktok' && (order.orderTotal ?? 0) > 0) {
      // orderTotal = subtotalAfterDiscount; platformCommission = commission+paymentFee; mlShippingCost = shippingSellerCost
      platformNetRevenue = r2(
        (order.orderTotal ?? 0)
        - (order.platformCommission ?? 0)
        - mlFrete
        - (order.sellerDiscount ?? 0)
      );
    }

    const calc = calcOrderProfit({
      agreedPrice:       order.agreedPrice,
      quantity:          order.quantity,
      sellerCoupon:      order.sellerCoupon,
      lmmDiscount:       order.lmmDiscount,
      costPrice:         order.product?.costPrice ?? 0,
      packagingCost:     order.product?.packaging ?? 0,
      taxRate,
      marketplace,
      precomputedFee,
      platformNetRevenue,
      listingType:       order.listingType,
    });

    const isRevenue   = ['valid', 'pending', 'returned_partial'].includes(order.orderCategory);
    const finalProfit = isRevenue ? calc.grossProfit : 0;
    const finalMargin = isRevenue ? calc.margin      : 0;

    updates.push(prisma.order.update({
      where: { id: order.id },
      data: {
        calcGmv:         calc.gmv,
        calcShopeeFee:   calc.marketplaceFee,
        calcNetRevenue:  calc.netRevenue,
        calcTax:         calc.taxAmount,
        calcProductCost: calc.productCost,
        calcPackaging:   calc.packaging,
        calcGrossProfit: finalProfit,
        calcMargin:      finalMargin,
        hasCost:         calc.hasCost,
        profit:          finalProfit,
        margin:          finalMargin,
        snapshotTaxRate: taxRate,
      },
    }));
  }

  for (let i = 0; i < updates.length; i += BATCH) {
    await Promise.all(updates.slice(i, i + BATCH));
  }

  return updates.length;
}

module.exports = { recalculateOrdersForStore };
