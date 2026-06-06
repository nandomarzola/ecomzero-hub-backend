const crypto = require('crypto');
const axios  = require('axios');

const BASE_URL    = 'https://partner.shopeemobile.com';
const PARTNER_ID  = parseInt(process.env.SHOPEE_PARTNER_ID  ?? '0', 10);
const PARTNER_KEY = process.env.SHOPEE_PARTNER_KEY ?? '';

function isConfigured() {
  return PARTNER_ID > 0 && PARTNER_KEY.length > 0;
}

function makeSign(path, timestamp) {
  const base = `${PARTNER_ID}${path}${timestamp}`;
  return crypto.createHmac('sha256', PARTNER_KEY).update(base).digest('hex');
}

function getAuthUrl(storeId) {
  const path      = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig       = makeSign(path, timestamp);
  const redirect  = process.env.SHOPEE_REDIRECT_URI ?? '';
  const cbUrl     = `${redirect}?storeId=${encodeURIComponent(storeId)}`;

  return (
    `${BASE_URL}${path}` +
    `?partner_id=${PARTNER_ID}` +
    `&redirect=${encodeURIComponent(cbUrl)}` +
    `&timestamp=${timestamp}` +
    `&sign=${sig}`
  );
}

async function exchangeToken(code, shopId) {
  const path      = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig       = makeSign(path, timestamp);

  const { data } = await axios.post(
    `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sig}`,
    { code, shop_id: parseInt(shopId, 10), partner_id: PARTNER_ID },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );

  if (data.error && data.error !== '') throw new Error(data.message || data.error);
  return data; // { access_token, refresh_token, expire_in, shop_id }
}

async function refreshShopeeToken(refreshToken, shopId) {
  const path      = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig       = makeSign(path, timestamp);

  const { data } = await axios.post(
    `${BASE_URL}${path}?partner_id=${PARTNER_ID}&timestamp=${timestamp}&sign=${sig}`,
    { refresh_token: refreshToken, shop_id: parseInt(shopId, 10), partner_id: PARTNER_ID },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 },
  );

  if (data.error && data.error !== '') throw new Error(data.message || data.error);
  return data;
}

// Busca nome/info da loja autenticada
async function getShopInfo(accessToken, shopId) {
  const path      = '/api/v2/shop/get_shop_info';
  const timestamp = Math.floor(Date.now() / 1000);
  const sig       = makeSign(path, timestamp);

  const { data } = await axios.get(`${BASE_URL}${path}`, {
    params: {
      partner_id:   PARTNER_ID,
      timestamp,
      sign:         sig,
      access_token: accessToken,
      shop_id:      parseInt(shopId, 10),
    },
    timeout: 10000,
  });

  return data?.response ?? data;
}

module.exports = { isConfigured, getAuthUrl, exchangeToken, refreshShopeeToken, getShopInfo };
