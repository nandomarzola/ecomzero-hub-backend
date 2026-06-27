const prisma = require('../lib/prisma');
const { calcOrderProfit } = require('./calculatorService');
const { r2, parseYearMonth } = require('../lib/utils');

// Recalculates all orders for a specific store.
// periodMonth: 'YYYY-MM' to filter by month, null to recalculate all periods.
//
// IDEMPOTÊNCIA: esta função é segura para rodar N vezes sobre os mesmos pedidos.
// Todos os campos calc* são DERIVADOS dos campos raw (agreedPrice, quantity,
// escrowAmount, platformCommission, platformServiceFee, sellerCoupon, lmmDiscount)
// e do custo cadastrado (variant/sku/product) — e gravados via prisma.order.update
// (substituição, NUNCA increment). Logo, rodar duas vezes produz exatamente o mesmo
// resultado; não há acúmulo nem double-count. O único efeito colateral mutável do
// sistema (estoque) NÃO ocorre aqui — fica isolado em stockHelper::applyStockFromOrder,
// protegido pela flag Order.stockDeducted contra dedução dupla em re-sync.
async function recalculateOrdersForStore(storeId, periodMonth = null, options = {}) {
  const where = { storeId };

  if (options.importId) where.importId = options.importId;

  if (periodMonth && !options.importId) {
    const { year: y, month: mo } = parseYearMonth(periodMonth);
    // São Paulo UTC-3 fixo — mesmo critério do closingController e dashboard
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const range = {
      gte: new Date(Date.UTC(y, mo - 1, 1,  3, 0, 0, 0)),   // dia 1 00:00 SP
      lte: new Date(Date.UTC(y, mo - 1, lastDay, 26, 59, 59, 999)), // último dia 23:59 SP
    };
    if (options.dateBasis === 'paidOrSold') {
      where.OR = [{ soldAt: range }, { orderPaidAt: range }];
    } else {
      where.soldAt = range;
    }
  }

  const orders = await prisma.order.findMany({
    where,
    include: {
      store:   { select: { taxRate: true, marketplace: true } },
      product: { select: { costPrice: true, packaging: true, category: true, shopeeShippingCost: true, parent: { select: { costPrice: true, packaging: true } } } },
      variant: { select: { costPrice: true } },
    },
  });

  if (!orders.length) return 0;

  // Pré-carrega ProductVariant da store p/ fallback de custo por SKU ou nome da variação
  // (cobre pedidos cujo variantId não foi resolvido no momento da importação)
  const variants = await prisma.productVariant.findMany({
    where: { product: { storeId } },
    select: { id: true, productId: true, sku: true, name: true, costPrice: true },
  });
  const variantBySku  = new Map(variants.filter(v => v.sku).map(v => [`${v.productId}|${v.sku}`, v]));
  // Fallback por nome da variação — cobre sellers sem SKU no Shopee:
  // o variationName do pedido bate com o ProductVariant.name cadastrado.
  const variantByName = new Map(variants.filter(v => v.name).map(v => [`${v.productId}|${v.name.trim()}`, v]));

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
        // Pedido pendente ou sem escrow: usa taxa real quando a API/export trouxe
        // comissão/serviço. Quando esses campos vêm zerados, deixa o calculator
        // estimar a taxa Shopee pela categoria/preço em vez de assumir taxa zero.
        const rawShopeeFee = r2((order.platformCommission ?? 0) + (order.platformServiceFee ?? 0));
        platformNetRevenue = rawShopeeFee > 0
          ? r2(
              (order.calcGmv ?? 0)
              - rawShopeeFee
              - (order.sellerCoupon ?? 0)
              - (order.lmmDiscount ?? 0)
            )
          : null;
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

    const skuMatch  = order.skuVariacao
      ? variantBySku.get(`${order.productId}|${order.skuVariacao}`)
      : null;
    const nameMatch = (!order.variantId && order.variationName)
      ? variantByName.get(`${order.productId}|${order.variationName.trim()}`)
      : null;
    const effectiveCostPrice = [
      order.variant?.costPrice,
      skuMatch?.costPrice,
      nameMatch?.costPrice,
      order.product?.costPrice,
      order.product?.parent?.costPrice,
    ].find((value) => value != null && Number(value) > 0) ?? 0;
    const effectivePackaging = Number(order.product?.packaging ?? 0) > 0
      ? order.product.packaging
      : (order.product?.parent?.packaging ?? 0);

    const calc = calcOrderProfit({
      agreedPrice:        order.agreedPrice,
      quantity:           order.quantity,
      sellerCoupon:       order.sellerCoupon,
      lmmDiscount:        order.lmmDiscount,
      costPrice:          effectiveCostPrice,
      packagingCost:      effectivePackaging,
      taxRate,
      marketplace,
      precomputedFee,
      platformNetRevenue,
      listingType:        order.listingType,
      category:           order.product?.category ?? null,
      // order-level shipping (importado da API) tem prioridade; produto define o default
      shopeeShippingCost: order.shopeeShippingCost > 0
        ? order.shopeeShippingCost
        : (order.product?.shopeeShippingCost ?? 0),
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
