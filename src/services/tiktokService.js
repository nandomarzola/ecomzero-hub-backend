const https  = require('https');
const crypto = require('crypto');

const APP_KEY     = process.env.TIKTOK_APP_KEY;
const APP_SECRET  = process.env.TIKTOK_APP_SECRET;
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;

const TT_AUTH_BASE = 'https://auth.tiktok-shops.com';
const TT_API_BASE  = 'https://open-api.tiktokglobal.com';

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

// ── Assinatura HMAC-SHA256 (obrigatória em todas as chamadas) ─────────────────
function sign(path, params, body = {}) {
  const timestamp = Math.floor(Date.now() / 1000);

  // Juntar query params + body params, excluir 'sign' e 'access_token'
  const allParams = { ...params, timestamp };
  const sortedKeys = Object.keys(allParams)
    .filter(k => k !== 'sign' && k !== 'access_token')
    .sort();

  let paramStr = path;
  for (const k of sortedKeys) {
    paramStr += k + allParams[k];
  }
  if (Object.keys(body).length > 0) {
    paramStr += JSON.stringify(body);
  }

  const signStr = APP_SECRET + paramStr + APP_SECRET;
  const signature = crypto.createHmac('sha256', APP_SECRET).update(signStr).digest('hex');

  return { signature, timestamp };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function ttRequest(method, path, params = {}, body = null, accessToken = null) {
  return new Promise((resolve, reject) => {
    const { signature, timestamp } = sign(path, params, body ?? {});

    const queryParams = {
      ...params,
      app_key:   APP_KEY,
      sign:      signature,
      timestamp: String(timestamp),
      ...(accessToken ? { access_token: accessToken } : {}),
    };

    const qs = new URLSearchParams(queryParams).toString();
    const url = new URL(TT_API_BASE + path + '?' + qs);

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers:  {
        'Content-Type': 'application/json',
        'x-tts-access-token': accessToken ?? '',
      },
    };

    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({ code: -1, message: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function ttAuthRequest(method, path, params = {}, body = null) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = new URL(TT_AUTH_BASE + path + '?' + qs);

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers:  { 'Content-Type': 'application/json' },
    };

    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
function getAuthUrl(storeId) {
  const params = new URLSearchParams({
    app_key:      APP_KEY,
    state:        storeId,
  });
  return `${TT_AUTH_BASE}/oauth/authorize?${params}`;
}

async function exchangeCode(code) {
  const res = await ttAuthRequest('GET', '/api/v2/token/get', {
    app_key:    APP_KEY,
    app_secret: APP_SECRET,
    auth_code:  code,
    grant_type: 'authorized_code',
  });

  if (res.code !== 0) throw new Error(`TikTok OAuth erro: ${res.message ?? JSON.stringify(res)}`);
  return res.data; // { access_token, refresh_token, expires_in, open_id, seller_name, ... }
}

async function refreshAccessToken(refreshToken) {
  const res = await ttAuthRequest('GET', '/api/v2/token/refresh', {
    app_key:       APP_KEY,
    app_secret:    APP_SECRET,
    refresh_token: refreshToken,
    grant_type:    'refresh_token',
  });
  if (res.code !== 0) throw new Error(`TikTok refresh erro: ${res.message}`);
  return res.data;
}

// ── Dados da loja ─────────────────────────────────────────────────────────────
async function getShopInfo(accessToken) {
  const res = await ttRequest('GET', '/authorization/202309/shops', {}, null, accessToken);
  if (res.code !== 0) throw new Error(`TikTok shop info erro: ${res.message}`);
  const shops = res.data?.shops ?? [];
  return shops[0] ?? null; // { shop_id, shop_name, region, ... }
}

// ── Pedidos ───────────────────────────────────────────────────────────────────
async function fetchOrders(accessToken, shopId, dateFrom, dateTo) {
  const orders = [];
  let pageToken = '';

  while (true) {
    const params = {
      shop_id:          shopId,
      create_time_from: Math.floor(new Date(dateFrom).getTime() / 1000),
      create_time_to:   Math.floor(new Date(dateTo).getTime() / 1000),
      page_size:        50,
      sort_field:       'CREATE_TIME',
      sort_order:       'ASC',
      ...(pageToken ? { page_token: pageToken } : {}),
    };

    const res = await ttRequest('GET', '/order/202309/orders', params, null, accessToken);
    if (res.code !== 0) {
      console.error('[TikTok] fetchOrders erro:', res.message);
      break;
    }

    const list = res.data?.orders ?? [];
    orders.push(...list);

    const nextToken = res.data?.next_page_token;
    if (!nextToken || list.length === 0) break;
    pageToken = nextToken;
  }

  return orders;
}

// ── Detalhes de pedidos (taxas reais) ─────────────────────────────────────────
async function fetchOrderDetails(accessToken, shopId, orderIds) {
  const detailsMap = {};
  const CHUNK = 50;

  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const chunk = orderIds.slice(i, i + CHUNK);
    const res = await ttRequest('POST', '/order/202309/orders/detail/query',
      { shop_id: shopId },
      { order_id_list: chunk },
      accessToken
    );
    if (res.code !== 0) continue;
    const orders = res.data?.order_list ?? [];
    for (const o of orders) {
      detailsMap[o.id] = o;
    }
  }

  return detailsMap;
}

// ── Mapeamento status TikTok → nosso modelo ────────────────────────────────────
function classifyTTOrder(status) {
  const map = {
    UNPAID:             'cancelled_unpaid',
    AWAITING_SHIPMENT:  'pending',
    AWAITING_COLLECTION:'pending',
    IN_TRANSIT:         'pending',
    DELIVERED:          'valid',
    COMPLETED:          'valid',
    CANCELLED:          'cancelled_other',
    PARTIALLY_RETURNED: 'returned_partial',
    RETURNED:           'returned_full',
  };
  return map[status] ?? 'pending';
}

function categoryToStatus(cat) {
  if (cat === 'returned_full') return 'returned';
  if (cat.startsWith('cancelled')) return 'cancelled';
  return 'paid';
}

// ── Converter pedido TikTok para nosso modelo ─────────────────────────────────
function convertTTOrder(ttOrder, detail, storeId, importId, store) {
  const item     = ttOrder.line_items?.[0] ?? detail?.line_items?.[0] ?? {};
  const payment  = detail?.payment ?? {};

  const agreedPrice  = r2(parseFloat(item.sale_price ?? item.original_price ?? 0));
  const quantity     = parseInt(item.quantity ?? 1);
  const gmv          = r2(agreedPrice * quantity);

  // TikTok: platform_discount = taxa da plataforma
  const platformDiscount = r2(parseFloat(payment.platform_discount ?? 0));
  const sellerDiscount   = r2(parseFloat(payment.seller_discount ?? 0));
  const shippingFee      = r2(parseFloat(payment.shipping_fee ?? 0));
  const shippingFeeSellerDiscount = r2(parseFloat(payment.shipping_fee_seller_discount ?? 0));

  // Taxa efetiva = quanto TikTok cobra do vendedor (comissão + taxas)
  const ttFee = r2(parseFloat(payment.commission_fee ?? payment.tax ?? 0));

  const taxRate     = store.taxRate ?? 0;
  const taxAmount   = r2(gmv * (taxRate / 100));
  const netRevenue  = r2(gmv - ttFee);
  const grossProfit = r2(netRevenue - taxAmount);
  const margin      = gmv > 0 ? r2((grossProfit / gmv) * 100) : 0;

  const orderCategory = classifyTTOrder(ttOrder.status);
  const isRevenue     = ['valid', 'pending', 'returned_partial'].includes(orderCategory);

  const sku      = item.seller_sku ?? null;
  const title    = item.product_name ?? '';
  const varName  = item.sku_name ?? null;

  const createdAt = ttOrder.create_time ? new Date(ttOrder.create_time * 1000) : null;
  const paidAt    = ttOrder.paid_time   ? new Date(ttOrder.paid_time   * 1000) : null;
  const soldAt    = paidAt ?? createdAt ?? new Date();

  return {
    storeId,
    importId,
    orderId:       String(ttOrder.id),
    orderStatus:   ttOrder.status,
    orderCategory,
    cancelReason:  ttOrder.cancel_reason ?? null,
    returnStatus:  null,
    skuPrincipal:  sku,
    skuVariacao:   sku,
    productName:   title,
    variationName: varName,
    productId:     null,
    originalPrice: agreedPrice,
    agreedPrice,
    quantity,
    shopeeCommission: ttFee,
    shopeeServiceFee: 0,
    sellerCoupon:     sellerDiscount,
    sellerDiscount:   0,
    lmmDiscount:      0,
    globalTotal:      r2(parseFloat(payment.total_amount ?? gmv)),
    orderTotal:       r2(parseFloat(payment.sub_total ?? gmv)),
    trackingNumber:   ttOrder.tracking_number ?? null,
    shippingOption:   ttOrder.shipping_provider ?? null,
    orderCreatedAt:   createdAt,
    orderPaidAt:      paidAt,
    orderDeliveredAt: null,
    calcGmv:          isRevenue ? gmv : 0,
    calcShopeeFee:    isRevenue ? ttFee : 0,
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
    mlShippingCost:   0,
    mlInstallmentFee: 0,
  };
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getShopInfo,
  fetchOrders,
  fetchOrderDetails,
  convertTTOrder,
};
