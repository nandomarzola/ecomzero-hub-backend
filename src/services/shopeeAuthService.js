const crypto = require('crypto');
const https  = require('https');

// Auth redirect URL host (onde o usuário faz login)
const AUTH_HOST = process.env.SHOPEE_ENV === 'sandbox'
  ? 'partner.test-stable.shopeemobile.com'
  : 'partner.shopeemobile.com';

// API calls host (chamadas backend: token, refresh, shop info)
const API_HOST = process.env.SHOPEE_ENV === 'sandbox'
  ? 'openplatform.sandbox.test-stable.shopee.sg'
  : 'partner.shopeemobile.com';
const PARTNER_ID  = parseInt(process.env.SHOPEE_PARTNER_ID  ?? '0', 10);
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY ?? '';

function isConfigured() {
  return PARTNER_ID > 0 && PARTNER_KEY.length > 0;
}

function makeSign(path, timestamp) {
  const base = `${PARTNER_ID}${path}${timestamp}`;
  return crypto.createHmac('sha256', PARTNER_KEY).update(base).digest('hex');
}

// Assinatura para endpoints de loja (shop_id + access_token no base string)
function makeShopSign(path, timestamp, accessToken, shopId) {
  const base = `${PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`;
  return crypto.createHmac('sha256', PARTNER_KEY).update(base).digest('hex');
}

function getAuthUrl(storeId) {
  const redirect = process.env.SHOPEE_REDIRECT_URI ?? '';
  const cbUrl    = `${redirect}?storeId=${encodeURIComponent(storeId)}`;

  if (process.env.SHOPEE_ENV === 'sandbox') {
    // Sandbox usa OAuth padrão — sem sign, sem timestamp
    return (
      `https://open.sandbox.test-stable.shopee.com/auth` +
      `?auth_type=seller` +
      `&partner_id=${PARTNER_ID}` +
      `&redirect_uri=${encodeURIComponent(cbUrl)}` +
      `&response_type=code`
    );
  }

  // Produção — URL assinada
  const path      = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig       = makeSign(path, timestamp);

  return (
    `https://${AUTH_HOST}${path}` +
    `?partner_id=${PARTNER_ID}` +
    `&redirect=${encodeURIComponent(cbUrl)}` +
    `&timestamp=${timestamp}` +
    `&sign=${sig}`
  );
}

// Utilitário: POST JSON via https nativo
function httpsPost(path, queryParams, body) {
  return new Promise((resolve, reject) => {
    const qs   = new URLSearchParams(queryParams).toString();
    const data = JSON.stringify(body);

    const options = {
      hostname: API_HOST,
      path:     `${path}?${qs}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Resposta inválida da API Shopee')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout na API Shopee')); });
    req.write(data);
    req.end();
  });
}

// Utilitário: GET via https nativo
function httpsGet(path, queryParams) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(queryParams).toString();

    const options = {
      hostname: API_HOST,
      path:     `${path}?${qs}`,
      method:   'GET',
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error('Resposta inválida da API Shopee')); }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout na API Shopee')); });
    req.end();
  });
}

async function exchangeToken(code, shopId) {
  const path      = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig       = makeSign(path, timestamp);

  const data = await httpsPost(
    path,
    { partner_id: PARTNER_ID, timestamp, sign: sig },
    { code, shop_id: parseInt(shopId, 10), partner_id: PARTNER_ID },
  );

  if (data.error && data.error !== '') throw new Error(data.message || data.error);
  return data; // { access_token, refresh_token, expire_in, shop_id }
}

async function refreshShopeeToken(refreshToken, shopId) {
  const path      = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig       = makeSign(path, timestamp);

  const data = await httpsPost(
    path,
    { partner_id: PARTNER_ID, timestamp, sign: sig },
    { refresh_token: refreshToken, shop_id: parseInt(shopId, 10), partner_id: PARTNER_ID },
  );

  if (data.error && data.error !== '') throw new Error(data.message || data.error);
  return data;
}

async function getShopInfo(accessToken, shopId) {
  const data = await shopApiGet('/api/v2/shop/get_shop_info', accessToken, shopId);
  return data?.response ?? data;
}

// ── Helper genérico para chamadas autenticadas de loja (GET) ──────────────────
async function shopApiGet(path, accessToken, shopId, extraParams = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sid       = parseInt(shopId, 10);
  const sig       = makeShopSign(path, timestamp, accessToken, sid);

  const data = await httpsGet(path, {
    partner_id:   PARTNER_ID,
    timestamp,
    sign:         sig,
    access_token: accessToken,
    shop_id:      sid,
    ...extraParams,
  });

  return data;
}

// ── Helper genérico para chamadas autenticadas de loja (POST) ─────────────────
async function shopApiPost(path, accessToken, shopId, body = {}, extraParams = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sid       = parseInt(shopId, 10);
  const sig       = makeShopSign(path, timestamp, accessToken, sid);

  const data = await httpsPost(
    path,
    {
      partner_id:   PARTNER_ID,
      timestamp,
      sign:         sig,
      access_token: accessToken,
      shop_id:      sid,
      ...extraParams,
    },
    body,
  );

  return data;
}

module.exports = { isConfigured, getAuthUrl, exchangeToken, refreshShopeeToken, getShopInfo, shopApiGet, shopApiPost };
