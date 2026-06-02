const https = require('https');

const ML_API    = 'https://api.mercadolibre.com';
const ML_AUTH   = 'https://auth.mercadolivre.com.br';
const CLIENT_ID     = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI  = process.env.ML_REDIRECT_URI;

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

// ── HTTP helper ────────────────────────────────────────────────────────────────
function mlGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(ML_API + path);
    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function mlPost(path, body) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams(body).toString();
    const options = {
      hostname: 'api.mercadolibre.com',
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── OAuth ──────────────────────────────────────────────────────────────────────
function getAuthUrl(storeId) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    state:         storeId,
  });
  return `${ML_AUTH}/authorization?${params}`;
}

async function exchangeCode(code) {
  const res = await mlPost('/oauth/token', {
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri:  REDIRECT_URI,
  });
  if (res.status !== 200) throw new Error(`ML OAuth erro ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body; // { access_token, refresh_token, expires_in, user_id }
}

async function refreshAccessToken(refreshToken) {
  const res = await mlPost('/oauth/token', {
    grant_type:    'refresh_token',
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  if (res.status !== 200) throw new Error(`ML refresh erro ${res.status}`);
  return res.body;
}

// ── Dados do seller ────────────────────────────────────────────────────────────
async function getSellerInfo(accessToken) {
  const res = await mlGet('/users/me', accessToken);
  if (res.status !== 200) throw new Error('Erro ao buscar dados do seller ML');
  return res.body; // { id, nickname, ... }
}

// ── Pedidos ────────────────────────────────────────────────────────────────────
// Busca todos os pedidos do período em lotes de 50
async function fetchOrders(accessToken, sellerId, dateFrom, dateTo) {
  const orders = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const params = new URLSearchParams({
      seller: sellerId,
      'order.date_created.from': new Date(dateFrom).toISOString(),
      'order.date_created.to':   new Date(dateTo).toISOString(),
      sort:   'date_asc',
      offset: String(offset),
      limit:  String(limit),
    });

    const res = await mlGet(`/orders/search?${params}`, accessToken);
    if (res.status !== 200) {
      console.error('[ML] fetchOrders erro:', res.body);
      break;
    }

    const results = res.body.results ?? [];
    orders.push(...results);

    const total = res.body.paging?.total ?? 0;
    offset += limit;
    if (offset >= total || results.length === 0) break;
  }

  return orders;
}

// ── Mapeamento de status ML → nosso modelo ────────────────────────────────────
function classifyMlOrder(mlStatus, returnReason) {
  switch (mlStatus) {
    case 'paid':
    case 'delivered':
      return 'valid';
    case 'confirmed':
    case 'payment_in_process':
    case 'in_process':
    case 'shipped':
      return 'pending';
    case 'cancelled':
      return 'cancelled_other';
    case 'refunded':
      return 'returned_full';
    case 'partially_refunded':
      return 'returned_partial';
    default:
      return 'pending';
  }
}

function categoryToStatus(cat) {
  if (cat === 'returned_full') return 'returned';
  if (cat.startsWith('cancelled')) return 'cancelled';
  return 'paid';
}

// ── Converter pedido ML para nosso formato ─────────────────────────────────────
// productId: já resolvido pelo controller via itemMap (externalId → product.id)
// sellerShippingCost: frete que o VENDEDOR paga = ratio - gap_discount - buyer_shipping
function convertMlOrder(mlOrder, storeId, importId, store, productId = null, sellerShippingCost = 0) {
  const item       = mlOrder.order_items?.[0];
  const payment    = mlOrder.payments?.[0];
  const shipping   = mlOrder.shipping;

  const agreedPrice  = r2(item?.unit_price ?? 0);
  const quantity     = item?.quantity ?? 1;
  const gmv          = r2(agreedPrice * quantity);

  // ML fornece o valor real da taxa no campo sale_fee
  const saleFee      = r2(item?.sale_fee ?? 0);
  const freight      = r2(sellerShippingCost ?? 0); // frete que o VENDEDOR paga
  const netRevenue   = r2(gmv - saleFee - freight);
  const taxRate      = store.taxRate ?? 0;
  const taxAmount    = r2(gmv * (taxRate / 100));
  const grossProfit  = r2(netRevenue - taxAmount); // sem custo de produto ainda
  const margin       = gmv > 0 ? r2((grossProfit / gmv) * 100) : 0;

  const orderCategory = classifyMlOrder(mlOrder.status);
  const isRevenue     = ['valid', 'pending', 'returned_partial'].includes(orderCategory);

  const sku         = item?.item?.seller_sku ?? null;
  const itemId      = item?.item?.id ?? null;
  const title       = item?.item?.title ?? '';
  const listingType = item?.listing_type_id ?? item?.item?.listing_type_id ?? null;

  const createdAt   = mlOrder.date_created   ? new Date(mlOrder.date_created)   : null;
  const paidAt      = payment?.date_approved  ? new Date(payment.date_approved)  : null;
  const deliveredAt = mlOrder.date_last_updated ? new Date(mlOrder.date_last_updated) : null;
  const soldAt      = paidAt ?? createdAt ?? new Date();

  return {
    storeId,
    importId,
    orderId:       String(mlOrder.id),
    orderStatus:   mlOrder.status,
    orderCategory,
    cancelReason:  null,
    returnStatus:  null,
    skuPrincipal:  sku,
    skuVariacao:   sku,
    productName:   title,
    variationName: item?.item?.variation_attributes?.map(a => a.value_name).join(' ') || null,
    productId,
    originalPrice: agreedPrice,
    agreedPrice,
    quantity,
    shopeeCommission: saleFee,
    shopeeServiceFee: 0,
    sellerCoupon:     0,
    sellerDiscount:   0,
    lmmDiscount:      0,
    globalTotal:      r2(mlOrder.total_amount ?? 0),
    orderTotal:       r2(mlOrder.paid_amount ?? 0),
    listingType:      listingType,
    trackingNumber:   String(shipping?.id ?? '') || null,
    shippingOption:   shipping?.shipping_mode ?? null,
    orderCreatedAt:   createdAt,
    orderPaidAt:      paidAt,
    orderDeliveredAt: deliveredAt,
    mlShippingCost:   freight,
    calcGmv:          isRevenue ? gmv : 0,
    calcShopeeFee:    isRevenue ? r2(saleFee + freight) : 0, // taxa total = comissão + frete vendedor
    calcNetRevenue:   isRevenue ? netRevenue : 0,
    calcTax:          isRevenue ? taxAmount : 0,
    calcProductCost:  0,
    calcPackaging:    0,
    calcGrossProfit:  isRevenue ? grossProfit : 0,
    calcMargin:       isRevenue ? margin : 0,
    hasCost:          false,
    status:           categoryToStatus(orderCategory),
    soldAt,
    salePrice:        isRevenue ? gmv : 0,
    profit:           isRevenue ? grossProfit : 0,
    margin:           isRevenue ? margin : 0,
    snapshotTaxRate:  taxRate,
  };
}

// ── Buscar custo de frete do VENDEDOR via /shipments/:id/costs ───────────────────
// senders[0].cost = valor exato que o vendedor paga (mesmo mostrado no painel ML)
// Ex: canivete R$22,99 → senders[0].cost = R$12,35 ✓
async function fetchShippingCosts(accessToken, shipmentIds) {
  const costsMap = {};

  const chunks = [];
  for (let i = 0; i < shipmentIds.length; i += 10) chunks.push(shipmentIds.slice(i, i + 10));

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (id) => {
      try {
        const res  = await mlGet('/shipments/' + id + '/costs', accessToken);
        const data = res?.body ?? res;
        const sellerCost = data?.senders?.[0]?.cost ?? 0;
        costsMap[id] = { sellerCost };
      } catch {
        costsMap[id] = { sellerCost: 0 };
      }
    }));
  }
  return costsMap;
}

// ── Buscar IDs de todos os anúncios ativos do seller ──────────────────────────
async function fetchItemIds(accessToken, sellerId) {
  const ids = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    // Sem filtro de status — busca todos os anúncios (ativos, pausados, etc.)
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    const res = await mlGet(`/users/${sellerId}/items/search?${params}`, accessToken);
    if (res.status !== 200) break;

    const results = res.body.results ?? [];
    ids.push(...results);

    const paging = res.body.paging ?? {};
    offset += limit;
    if (offset >= (paging.total ?? 0) || results.length === 0) break;
  }
  return ids;
}

// ── Buscar detalhes de itens em lotes de 20 ────────────────────────────────────
async function fetchItemDetails(accessToken, itemIds) {
  const attrs = 'id,title,price,listing_type_id,seller_sku,seller_custom_field,available_quantity,thumbnail,permalink,variations,category_id,status,attributes';
  const items = [];

  for (let i = 0; i < itemIds.length; i += 20) {
    const batch = itemIds.slice(i, i + 20);
    const params = new URLSearchParams({ ids: batch.join(','), attributes: attrs });
    const res = await mlGet(`/items?${params}`, accessToken);
    if (res.status !== 200) continue;

    const results = Array.isArray(res.body) ? res.body : [res.body];
    for (const r of results) {
      if (r.code === 200 || r.body) items.push(r.body ?? r);
      else if (r.id) items.push(r);
    }
  }
  return items;
}

// ── Buscar taxas reais por item ────────────────────────────────────────────────
// Retorna { itemId: { saleFeeRate, listingFeeAmount, ... } }
async function fetchItemFees(accessToken, itemIds) {
  const feesMap = {};

  for (let i = 0; i < itemIds.length; i += 20) {
    const batch = itemIds.slice(i, i + 20);
    const params = new URLSearchParams({ ids: batch.join(',') });
    const res = await mlGet(`/items/fees?${params}`, accessToken);
    if (res.status !== 200) continue;

    const results = Array.isArray(res.body) ? res.body : [res.body];
    for (const r of results) {
      const id = r.id ?? r.item_id;
      if (!id) continue;

      // ML retorna sale_fee como percentual (ex: 11.0) ou valor fixo dependendo do endpoint
      const saleFee   = r.sale_fee?.value ?? r.sale_fee_amount ?? 0;
      const listFee   = r.listing_fee?.amount ?? r.listing_fee_amount ?? 0;
      const freeShip  = r.free_shipping ?? false;

      feesMap[id] = {
        saleFeeRate:    typeof saleFee === 'number' && saleFee <= 100 ? saleFee : null,
        listingFee:     listFee,
        freeShipping:   freeShip,
        raw:            r,
      };
    }
  }
  return feesMap;
}

// ── Label legível do tipo de anúncio ──────────────────────────────────────────
function listingTypeLabel(id) {
  const map = {
    gold_pro:     { label: 'Premium',  feeRate: 16, color: 'yellow' },
    gold_special: { label: 'Clássico', feeRate: 11, color: 'gray'   },
    gold_premium: { label: 'Premium',  feeRate: 16, color: 'yellow' },
    free:         { label: 'Grátis',   feeRate: 0,  color: 'green'  },
  };
  return map[(id ?? '').toLowerCase()] ?? { label: id ?? 'Desconhecido', feeRate: null, color: 'gray' };
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getSellerInfo,
  fetchOrders,
  convertMlOrder,
  classifyMlOrder,
  fetchItemIds,
  fetchItemDetails,
  fetchItemFees,
  fetchShippingCosts,
  listingTypeLabel,
};
