const { shopApiGet } = require('./shopeeAuthService');
const { calcOrderProfit } = require('./calculatorService');

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

// API Shopee v2 limita o intervalo de get_order_list a 15 dias por chamada
const MAX_RANGE_SECONDS = 15 * 24 * 60 * 60;

// ── Lista de order_sn no período (com paginação por cursor + janelas de 15 dias) ──
async function fetchOrderList(accessToken, shopId, dateFrom, dateTo) {
  const orderSns = [];
  let from = Math.floor(new Date(dateFrom).getTime() / 1000);
  const to = Math.floor(new Date(dateTo).getTime() / 1000);

  while (from < to) {
    const chunkTo = Math.min(from + MAX_RANGE_SECONDS, to);
    let cursor = '';

    while (true) {
      const res = await shopApiGet('/api/v2/order/get_order_list', accessToken, shopId, {
        time_range_field: 'create_time',
        time_from:        from,
        time_to:          chunkTo,
        page_size:        100,
        ...(cursor ? { cursor } : {}),
      });

      if (res.error) {
        console.error('[Shopee] get_order_list erro:', res.error, res.message);
        break;
      }

      const list = res.response?.order_list ?? [];
      orderSns.push(...list.map((o) => o.order_sn));

      if (!res.response?.more || list.length === 0) break;
      cursor = res.response.next_cursor;
    }

    from = chunkTo;
  }

  return [...new Set(orderSns)];
}

// ── Detalhes dos pedidos em lotes de 50 ────────────────────────────────────────
async function fetchOrderDetails(accessToken, shopId, orderSnList) {
  const details = [];

  for (let i = 0; i < orderSnList.length; i += 50) {
    const batch = orderSnList.slice(i, i + 50);
    const res = await shopApiGet('/api/v2/order/get_order_detail', accessToken, shopId, {
      order_sn_list:            batch.join(','),
      response_optional_fields: 'item_list,total_amount,actual_shipping_fee,payment_method,buyer_username',
    });

    if (res.error) {
      console.error('[Shopee] get_order_detail erro:', res.error, res.message);
      continue;
    }
    details.push(...(res.response?.order_list ?? []));
  }

  return details;
}

// ── Detalhe de repasse (escrow) por pedido — disponível após pagamento ────────
// Retorna { [order_sn]: order_income }
async function fetchEscrowDetails(accessToken, shopId, orderSnList, onProgress) {
  const map = {};
  const chunks = [];
  for (let i = 0; i < orderSnList.length; i += 10) chunks.push(orderSnList.slice(i, i + 10));

  let done = 0;
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (orderSn) => {
      try {
        const res = await shopApiGet('/api/v2/payment/get_escrow_detail', accessToken, shopId, { order_sn: orderSn });
        if (!res.error && res.response?.order_income) map[orderSn] = res.response.order_income;
      } catch {
        // sem escrow disponível ainda — convertShopeeOrder usa fallback estimado
      }
    }));
    done += chunk.length;
    onProgress?.(done, orderSnList.length);
  }

  return map;
}

// ── Mapeamento de status Shopee → nosso modelo ────────────────────────────────
function classifyShopeeOrder(status) {
  const map = {
    UNPAID:             'cancelled_unpaid',
    READY_TO_SHIP:      'pending',
    PROCESSED:          'pending',
    RETRY_SHIP:         'pending',
    SHIPPED:            'pending',
    TO_CONFIRM_RECEIVE: 'pending',
    INVOICE_PENDING:    'pending',
    TO_RETURN:          'returned_partial',
    IN_CANCEL:          'cancelled_other',
    CANCELLED:          'cancelled_other',
    COMPLETED:          'valid',
  };
  return map[status] ?? 'pending';
}

function categoryToStatus(cat) {
  if (cat === 'returned_full') return 'returned';
  if (cat.startsWith('cancelled')) return 'cancelled';
  return 'paid';
}

// ── Converter pedido Shopee → nosso formato ────────────────────────────────────
// escrow: order_income (get_escrow_detail) — null se ainda não disponível
// productId: já resolvido pelo controller via itemMap (item_id/model_id → product.id)
function convertShopeeOrder(detail, escrow, storeId, importId, store, productId = null, items = null, variantId = null, lineItemKey = '0') {
  const allItems = (items && items.length) ? items : (detail.item_list?.slice(0, 1) ?? []);
  const item = allItems[0] ?? {};

  // Soma quantidade/GMV de todos os itens do pedido que pertencem ao mesmo anúncio
  // (variações diferentes do mesmo item_id viram 1 só Order — ver syncOrders)
  const quantity = allItems.reduce((s, it) => s + (it.model_quantity_purchased ?? 1), 0);
  const gmv = r2(allItems.reduce((s, it) => {
    const price = r2(it.model_discounted_price ?? it.model_original_price ?? 0);
    return s + price * (it.model_quantity_purchased ?? 1);
  }, 0));
  const agreedPrice   = quantity > 0 ? r2(gmv / quantity) : 0;
  const originalPrice = quantity > 0
    ? r2(allItems.reduce((s, it) => s + r2(it.model_original_price ?? 0) * (it.model_quantity_purchased ?? 1), 0) / quantity)
    : agreedPrice;

  const orderCategory = classifyShopeeOrder(detail.order_status);
  const isRevenue     = ['valid', 'pending', 'returned_partial'].includes(orderCategory);
  const taxRate       = store.taxRate ?? 0;

  let platformCommission = 0;
  let platformServiceFee = 0;
  let sellerCoupon       = 0;
  let sellerDiscount     = 0;
  let calcShopeeFeeVal;
  let calcNetRevenue;

  if (escrow) {
    // Repasse real informado pela Shopee (get_escrow_detail)
    platformCommission = r2(escrow.commission_fee ?? 0);
    platformServiceFee = r2((escrow.service_fee ?? 0) + (escrow.seller_transaction_fee ?? 0));
    sellerCoupon       = r2(escrow.voucher_from_seller ?? 0);
    sellerDiscount     = r2(escrow.seller_discount ?? 0);
    calcShopeeFeeVal   = r2(platformCommission + platformServiceFee);
    calcNetRevenue     = r2(escrow.escrow_amount ?? (gmv - calcShopeeFeeVal - sellerCoupon - sellerDiscount));
  } else {
    // Sem escrow ainda (pedido recente/pendente) — estimativa pela tabela de taxas Shopee
    const calc = calcOrderProfit({
      agreedPrice, quantity, costPrice: 0, packagingCost: 0, taxRate, marketplace: 'shopee',
    });
    calcShopeeFeeVal = calc.shopeeFee;
    calcNetRevenue   = calc.netRevenue;
  }

  const taxAmount   = r2(gmv * (taxRate / 100));
  const grossProfit = r2(calcNetRevenue - taxAmount);
  const margin      = gmv > 0 ? r2((grossProfit / gmv) * 100) : 0;

  const createdAt = detail.create_time ? new Date(detail.create_time * 1000) : null;
  const updatedAt = detail.update_time ? new Date(detail.update_time * 1000) : null;
  const soldAt    = createdAt ?? new Date();

  return {
    storeId,
    importId,
    orderId:       String(detail.order_sn),
    lineItemKey,
    orderStatus:   detail.order_status,
    orderCategory,
    cancelReason:  detail.cancel_reason || null,
    returnStatus:  orderCategory === 'returned_partial' ? detail.order_status : null,
    skuPrincipal:  item.item_sku || null,
    skuVariacao:   item.model_sku || item.item_sku || null,
    productName:   item.item_name || '',
    variationName: item.model_name || null,
    productId,
    variantId,
    originalPrice,
    agreedPrice,
    quantity,
    platformCommission,
    platformServiceFee,
    sellerCoupon,
    sellerDiscount,
    lmmDiscount:   0,
    escrowAmount:  (escrow && escrow.escrow_amount != null) ? r2(escrow.escrow_amount) : null,
    shopeeVoucher: escrow ? r2(escrow.voucher_from_shopee ?? 0) : null,
    globalTotal:   r2(detail.total_amount ?? gmv),
    orderTotal:    r2(detail.total_amount ?? gmv),
    listingType:   null,
    trackingNumber: null,
    shippingOption: detail.shipping_carrier ?? null,
    orderCreatedAt:   createdAt,
    orderPaidAt:      createdAt,
    orderDeliveredAt: orderCategory === 'valid' ? updatedAt : null,
    mlShippingCost:   0,
    mlInstallmentFee: 0,
    calcGmv:         isRevenue ? gmv : 0,
    calcShopeeFee:   isRevenue ? calcShopeeFeeVal : 0,
    calcNetRevenue:  isRevenue ? calcNetRevenue : 0,
    calcTax:         isRevenue ? taxAmount : 0,
    calcProductCost: 0,
    calcPackaging:   0,
    calcGrossProfit: isRevenue ? grossProfit : 0,
    calcMargin:      isRevenue ? margin : 0,
    hasCost:         false,
    status:          categoryToStatus(orderCategory),
    soldAt,
    salePrice: isRevenue ? gmv : 0,
    profit:    isRevenue ? grossProfit : 0,
    margin:    isRevenue ? margin : 0,
    snapshotTaxRate: taxRate,
  };
}

// ── Pedido multi-anúncio/multi-variação: 1 Order por grupo (variantId ou
// item_id+model_id), taxas/escrow rateados proporcionalmente ao GMV de cada
// grupo. seller_discount e voucher_from_shopee usam escrow.items[] quando
// disponível (valor exato por item).
function convertMultiItemShopeeOrder(detail, escrow, storeId, importId, store, groupList) {
  const allItems = detail.item_list ?? [];
  const orderGmv = r2(allItems.reduce((s, it) => {
    const price = r2(it.model_discounted_price ?? it.model_original_price ?? 0);
    return s + price * (it.model_quantity_purchased ?? 1);
  }, 0));

  const totalCommission    = r2(escrow?.commission_fee ?? 0);
  const totalServiceFee    = r2((escrow?.service_fee ?? 0) + (escrow?.seller_transaction_fee ?? 0));
  const totalEscrow        = escrow?.escrow_amount != null ? r2(escrow.escrow_amount) : null;
  const totalSellerVoucher = r2(escrow?.voucher_from_seller ?? 0);
  const escrowItems        = escrow?.items ?? [];

  return groupList.map(g => {
    const groupGmv = r2(g.items.reduce((s, it) => {
      const price = r2(it.model_discounted_price ?? it.model_original_price ?? 0);
      return s + price * (it.model_quantity_purchased ?? 1);
    }, 0));
    const proportion = orderGmv > 0 ? groupGmv / orderGmv : 0;

    const matched = g.items
      .map(it => escrowItems.find(ei => ei.item_id === it.item_id && ei.model_id === (it.model_id ?? 0)))
      .filter(Boolean);
    const groupSellerDiscount = r2(matched.reduce((s, ei) => s + (ei.seller_discount ?? 0), 0));
    const groupShopeeVoucher  = r2(matched.reduce((s, ei) => s + (ei.discount_from_voucher_shopee ?? 0), 0));

    const groupEscrow = escrow ? {
      ...escrow,
      commission_fee:         r2(totalCommission * proportion),
      service_fee:            r2(totalServiceFee * proportion),
      seller_transaction_fee: 0, // já incluído acima em service_fee
      escrow_amount:          totalEscrow != null ? r2(totalEscrow * proportion) : null,
      seller_discount:        groupSellerDiscount,
      voucher_from_shopee:    groupShopeeVoucher,
      voucher_from_seller:    r2(totalSellerVoucher * proportion),
    } : null;

    // lineItemKey por model_id (variação) — exceto quando model_id=0 (anúncio
    // sem variação), onde usamos item_id para evitar colisão entre grupos
    // distintos que também teriam model_id=0.
    const lineItemKey = g.modelId ? String(g.modelId) : String(g.firstItemId);

    return convertShopeeOrder(detail, groupEscrow, storeId, importId, store, g.productId, g.items, g.variantId, lineItemKey);
  });
}

// ── Catálogo: lista de item_ids ativos do shop ────────────────────────────────
async function fetchItemList(accessToken, shopId) {
  const items = [];
  let offset = 0;

  while (true) {
    const res = await shopApiGet('/api/v2/product/get_item_list', accessToken, shopId, {
      offset, page_size: 100, item_status: 'NORMAL',
    });
    if (res.error) {
      console.error('[Shopee] get_item_list erro:', res.error, res.message);
      break;
    }

    const list = res.response?.item ?? [];
    items.push(...list);

    if (!res.response?.has_next_page || list.length === 0) break;
    offset = res.response.next_offset ?? (offset + list.length);
  }

  return items; // [{ item_id, item_status, ... }]
}

// ── Detalhes de itens (preço, estoque, variações) em lotes de 50 ──────────────
async function fetchItemBaseInfo(accessToken, shopId, itemIds) {
  const items = [];

  for (let i = 0; i < itemIds.length; i += 50) {
    const batch = itemIds.slice(i, i + 50);
    const res = await shopApiGet('/api/v2/product/get_item_base_info', accessToken, shopId, {
      item_id_list: batch.join(','),
    });
    if (res.error) {
      console.error('[Shopee] get_item_base_info erro:', res.error, res.message);
      continue;
    }
    items.push(...(res.response?.item_list ?? []));
  }

  return items;
}

// ── Variações (models) reais de um item — get_item_base_info não retorna model_list ──
// Retorna [{ model_id, model_sku, model_name, price_info, stock_info_v2 }]
async function fetchModelList(accessToken, shopId, itemId) {
  const res = await shopApiGet('/api/v2/product/get_model_list', accessToken, shopId, {
    item_id: itemId,
  });

  if (res.error) {
    console.error('[Shopee] get_model_list erro:', res.error, res.message, 'item_id=', itemId);
    return [];
  }

  const tierVariation = res.response?.tier_variation ?? [];
  const models        = res.response?.model ?? [];

  return models.map((model) => {
    const name = (model.tier_index ?? [])
      .map((optIdx, tierIdx) => tierVariation[tierIdx]?.option_list?.[optIdx]?.option)
      .filter(Boolean)
      .join(', ');

    return {
      model_id:      model.model_id,
      model_sku:     model.model_sku || null,
      model_name:    name || null,
      price_info:    model.price_info,
      stock_info_v2: model.stock_info_v2,
    };
  });
}

module.exports = {
  fetchOrderList,
  fetchOrderDetails,
  fetchEscrowDetails,
  classifyShopeeOrder,
  convertShopeeOrder,
  convertMultiItemShopeeOrder,
  fetchItemList,
  fetchItemBaseInfo,
  fetchModelList,
};
