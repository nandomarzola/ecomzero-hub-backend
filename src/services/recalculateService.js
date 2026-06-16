const prisma = require('../lib/prisma');
const { calcOrderProfit } = require('./calculatorService');
const { r2, parseYearMonth } = require('../lib/utils');

// Recalculates all orders for a specific store.
// periodMonth: 'YYYY-MM' to filter by month, null to recalculate all periods.
async function recalculateOrdersForStore(storeId, periodMonth = null) {
  const where = { storeId };

  if (periodMonth) {
    const { year: y, month: mo } = parseYearMonth(periodMonth);
    where.soldAt = {
      gte: new Date(Date.UTC(y, mo - 1, 1)),
      lte: new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999)),
    };
  }

  const orders = await prisma.order.findMany({
    where,
    include: {
      store:   { select: { taxRate: true, marketplace: true } },
      product: { select: { costPrice: true, packaging: true, category: true } },
      variant: { select: { costPrice: true } },
    },
  });

  if (!orders.length) return 0;

  // Pré-carrega ProductVariant da store p/ fallback de custo por SKU da variação
  // (cobre pedidos cujo variantId não foi resolvido no momento da importação)
  const variants = await prisma.productVariant.findMany({
    where: { product: { storeId } },
    select: { productId: true, sku: true, costPrice: true },
  });
  const variantBySku = new Map(variants.map(v => [`${v.productId}|${v.sku}`, v]));

  const BATCH = 100;
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
    if (marketplace === 'shopee') {
      if (order.orderCategory === 'valid' && order.escrowAmount != null) {
        // Pedido confirmado: usa o repasse real depositado pela Shopee
        platformNetRevenue = r2(order.escrowAmount);
      } else {
        // Pedido pendente ou sem escrow: estima a partir dos campos de taxa
        platformNetRevenue = r2(
          (order.calcGmv ?? 0)
          - (order.platformCommission ?? 0)
          - (order.platformServiceFee ?? 0)
          - (order.sellerCoupon ?? 0)
          - (order.lmmDiscount ?? 0)
        );
      }
    } else if (marketplace === 'shein' && (order.orderTotal ?? 0) > 0) {
      platformNetRevenue = r2(order.orderTotal);
    } else if (marketplace === 'tiktok' && (order.orderTotal ?? 0) > 0) {
      // orderTotal = subtotalAfterDiscount; platformCommission = commission+paymentFee; mlShippingCost = shippingSellerCost
      platformNetRevenue = r2(
        (order.orderTotal ?? 0)
        - (order.platformCommission ?? 0)
        - mlFrete
        - (order.sellerDiscount ?? 0)
        - (order.affiliateCommission ?? 0)
      );
    }

    const skuMatch = order.skuVariacao
      ? variantBySku.get(`${order.productId}|${order.skuVariacao}`)
      : null;

    const calc = calcOrderProfit({
      agreedPrice:        order.agreedPrice,
      quantity:           order.quantity,
      sellerCoupon:       order.sellerCoupon,
      lmmDiscount:        order.lmmDiscount,
      costPrice:          order.variant?.costPrice ?? skuMatch?.costPrice ?? order.product?.costPrice ?? 0,
      packagingCost:      order.product?.packaging ?? 0,
      taxRate,
      marketplace,
      precomputedFee,
      platformNetRevenue,
      listingType:        order.listingType,
      category:           order.product?.category ?? null,
      shopeeShippingCost: order.shopeeShippingCost ?? 0,
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
