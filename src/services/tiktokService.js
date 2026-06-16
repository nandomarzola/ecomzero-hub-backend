const https  = require('https');
const crypto = require('crypto');

// Lendo em runtime (não no import) para garantir que dotenv já carregou
const getAppKey     = () => process.env.TIKTOK_APP_KEY;
const getAppSecret  = () => process.env.TIKTOK_APP_SECRET;

const TT_AUTH_BASE = 'https://auth.tiktok-shops.com';
const TT_API_BASE  = 'https://open-api.tiktokglobal.com';

const { r2 } = require('../lib/utils');

// ── Assinatura HMAC-SHA256 (obrigatória em todas as chamadas) ─────────────────
function sign(path, params) {
  const timestamp  = Math.floor(Date.now() / 1000);
  const secret     = getAppSecret();
  const allParams  = { ...params, timestamp };
  const sortedKeys = Object.keys(allParams)
    .filter(k => k !== 'sign' && k !== 'access_token')
    .sort();

  let paramStr = path;
  for (const k of sortedKeys) paramStr += k + allParams[k];

  const signStr  = secret + paramStr + secret;
  const signature = crypto.createHmac('sha256', secret).update(signStr).digest('hex');
  return { signature, timestamp };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject); req.end();
  });
}

function httpPost(hostname, path, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function ttRequest(method, apiPath, params = {}, body = null, accessToken = null) {
  return new Promise((resolve, reject) => {
    const { signature, timestamp } = sign(apiPath, params);
    const qp = new URLSearchParams({
      ...params,
      app_key:   getAppKey(),
      sign:      signature,
      timestamp: String(timestamp),
      ...(accessToken ? { access_token: accessToken } : {}),
    }).toString();

    const url = new URL(TT_API_BASE + apiPath + '?' + qp);
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'x-tts-access-token': accessToken ?? '' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method, headers }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ code: -1, message: d }); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function ttAuthGet(path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = new URL(TT_AUTH_BASE + path + '?' + qs);
  return httpGet(url.hostname, url.pathname + url.search);
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
function getAuthUrl(storeId) {
  const params = new URLSearchParams({ app_key: getAppKey(), state: storeId });
  // TikTok Shop OAuth URL para sellers
  return `${TT_AUTH_BASE}/oauth/authorize/seller?${params}`;
}

async function exchangeCode(code) {
  const res = await ttAuthGet('/api/v2/token/get', {
    app_key:    getAppKey(),
    app_secret: getAppSecret(),
    auth_code:  code,
    grant_type: 'authorized_code',
  });
  if (res.code !== 0) throw new Error(`TikTok OAuth erro ${res.code}: ${res.message}`);
  return res.data;
}

async function refreshAccessToken(refreshToken) {
  const res = await ttAuthGet('/api/v2/token/refresh', {
    app_key:       getAppKey(),
    app_secret:    getAppSecret(),
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
  return res.data?.shops?.[0] ?? null;
}

// ── Pedidos ───────────────────────────────────────────────────────────────────
async function fetchOrders(accessToken, shopId, dateFrom, dateTo) {
  const orders = [];
  let pageToken = '';

  while (true) {
    const params = {
      shop_id:          shopId,
      create_time_from: Math.floor(new Date(dateFrom).getTime() / 1000),
      create_time_to:   Math.floor(new Date(dateTo).getTime()   / 1000),
      page_size:        50,
      sort_field:       'CREATE_TIME',
      sort_order:       'ASC',
      ...(pageToken ? { page_token: pageToken } : {}),
    };
    const res = await ttRequest('GET', '/order/202309/orders', params, null, accessToken);
    if (res.code !== 0) { console.error('[TikTok] fetchOrders:', res.message); break; }

    const list = res.data?.orders ?? [];
    orders.push(...list);
    const next = res.data?.next_page_token;
    if (!next || list.length === 0) break;
    pageToken = next;
  }
  return orders;
}

async function fetchOrderDetails(accessToken, shopId, orderIds) {
  const map = {};
  for (let i = 0; i < orderIds.length; i += 50) {
    const chunk = orderIds.slice(i, i + 50);
    const res   = await ttRequest('POST', '/order/202309/orders/detail/query',
      { shop_id: shopId }, { order_id_list: chunk }, accessToken);
    if (res.code !== 0) continue;
    for (const o of res.data?.order_list ?? []) map[o.id] = o;
  }
  return map;
}

// ── Status ────────────────────────────────────────────────────────────────────
function classifyTTOrder(status) {
  const map = {
    UNPAID: 'cancelled_unpaid', AWAITING_SHIPMENT: 'pending',
    AWAITING_COLLECTION: 'pending', IN_TRANSIT: 'pending',
    DELIVERED: 'valid', COMPLETED: 'valid',
    CANCELLED: 'cancelled_other', PARTIALLY_RETURNED: 'returned_partial',
    RETURNED: 'returned_full',
  };
  return map[status] ?? 'pending';
}

function categoryToStatus(cat) {
  if (cat === 'returned_full') return 'returned';
  if (cat.startsWith('cancelled')) return 'cancelled';
  return 'paid';
}

// ── Converter pedido TikTok → nosso modelo ────────────────────────────────────
function convertTTOrder(ttOrder, detail, storeId, importId, store) {
  const item    = ttOrder.line_items?.[0] ?? detail?.line_items?.[0] ?? {};
  const payment = detail?.payment ?? {};

  const agreedPrice = r2(parseFloat(item.sale_price ?? item.original_price ?? 0));
  const quantity    = parseInt(item.quantity ?? 1);
  const gmv         = r2(agreedPrice * quantity);
  const ttFee          = r2(parseFloat(payment.commission_fee ?? 0));
  const affiliateComm  = r2(parseFloat(payment.affiliate_commission ?? 0));
  const taxRate        = store.taxRate ?? 0;
  const taxAmount      = r2(gmv * (taxRate / 100));
  const netRevenue     = r2(gmv - ttFee - affiliateComm);
  const grossProfit    = r2(netRevenue - taxAmount);
  const margin      = gmv > 0 ? r2((grossProfit / gmv) * 100) : 0;

  const orderCategory = classifyTTOrder(ttOrder.status);
  const isRevenue     = ['valid', 'pending', 'returned_partial'].includes(orderCategory);
  const sku           = item.seller_sku ?? null;
  const createdAt     = ttOrder.create_time ? new Date(ttOrder.create_time * 1000) : null;
  const paidAt        = ttOrder.paid_time   ? new Date(ttOrder.paid_time   * 1000) : null;
  const soldAt        = paidAt ?? createdAt ?? new Date();

  return {
    storeId, importId,
    orderId:       String(ttOrder.id),
    orderStatus:   ttOrder.status,
    orderCategory,
    cancelReason:  ttOrder.cancel_reason ?? null,
    returnStatus:  null,
    skuPrincipal:  sku, skuVariacao: sku,
    productName:   item.product_name ?? '',
    variationName: item.sku_name ?? null,
    productId:     null,
    originalPrice: agreedPrice, agreedPrice, quantity,
    platformCommission: ttFee, platformServiceFee: 0,
    affiliateCommission: affiliateComm,
    sellerCoupon: r2(parseFloat(payment.seller_discount ?? 0)),
    sellerDiscount: 0, lmmDiscount: 0,
    globalTotal:  r2(parseFloat(payment.total_amount ?? gmv)),
    orderTotal:   r2(parseFloat(payment.sub_total ?? gmv)),
    trackingNumber: ttOrder.tracking_number ?? null,
    shippingOption: ttOrder.shipping_provider ?? null,
    orderCreatedAt: createdAt, orderPaidAt: paidAt, orderDeliveredAt: null,
    calcGmv:          isRevenue ? gmv : 0,
    calcShopeeFee:    isRevenue ? ttFee : 0,
    calcNetRevenue:   isRevenue ? netRevenue : 0,
    calcTax:          isRevenue ? taxAmount : 0,
    calcProductCost:  0, calcPackaging: 0,
    calcGrossProfit:  isRevenue ? grossProfit : 0,
    calcMargin:       isRevenue ? margin : 0,
    hasCost: false,
    status:  categoryToStatus(orderCategory),
    soldAt, salePrice: isRevenue ? gmv : 0,
    profit: isRevenue ? grossProfit : 0, margin: isRevenue ? margin : 0,
    snapshotTaxRate: taxRate,
    mlShippingCost: 0, mlInstallmentFee: 0,
  };
}

module.exports = { getAuthUrl, exchangeCode, refreshAccessToken, getShopInfo, fetchOrders, fetchOrderDetails, convertTTOrder };
