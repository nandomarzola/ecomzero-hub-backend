const prisma = require('../lib/prisma');
const {
  isConfigured,
  getAuthUrl,
  exchangeToken,
  refreshShopeeToken,
  getShopInfo,
} = require('../services/shopeeAuthService');

const FRONTEND_URL = process.env.SHOPEE_FRONTEND_URL || 'https://profittrack.ecomzero.com.br';

// GET /api/shopee/auth?storeId=xxx — gera URL de autorização Shopee
async function getAuth(req, res) {
  const { storeId } = req.query;
  if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });

  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  if (!isConfigured()) {
    return res.status(503).json({ error: 'Integração Shopee ainda não configurada — aguardando aprovação do Partner ID' });
  }

  const url = getAuthUrl(storeId);
  return res.json({ url });
}

// GET /api/shopee/callback?code=xxx&shop_id=xxx&storeId=xxx
// Endpoint público — chamado pelo redirect da Shopee
async function handleCallback(req, res) {
  const { code, shop_id, storeId, error: spError } = req.query;

  if (spError) {
    return res.redirect(`${FRONTEND_URL}/settings?sp_error=${encodeURIComponent(spError)}`);
  }
  if (!code || !shop_id) {
    return res.redirect(`${FRONTEND_URL}/settings?sp_error=missing_params`);
  }

  try {
    // Trocar code por tokens
    const tokens = await exchangeToken(code, shop_id);
    const expiresAt = new Date(Date.now() + ((tokens.expire_in ?? 14400) * 1000));

    // Tentar buscar nome da loja
    let shopName = null;
    try {
      const info = await getShopInfo(tokens.access_token, shop_id);
      shopName = info?.shop_name ?? info?.name ?? null;
    } catch {}

    // Se storeId foi passado via redirect, usa ele; senão tenta pelo spShopId existente
    let targetStoreId = storeId ?? null;
    if (!targetStoreId) {
      const existing = await prisma.store.findFirst({
        where: { spShopId: String(shop_id) },
        select: { id: true },
      });
      targetStoreId = existing?.id ?? null;
    }

    if (targetStoreId) {
      await prisma.store.update({
        where: { id: targetStoreId },
        data: {
          spAccessToken:    tokens.access_token,
          spRefreshToken:   tokens.refresh_token,
          spShopId:         String(shop_id),
          spShopName:       shopName,
          spTokenExpiresAt: expiresAt,
        },
      });
      console.log(`[Shopee] Loja ${targetStoreId} conectada — shop_id ${shop_id} (${shopName ?? 'sem nome'})`);
      return res.redirect(`${FRONTEND_URL}/settings?sp_connected=1&store=${targetStoreId}`);
    }

    // Sem storeId: loja não identificada — salva shop_id em qualquer loja Shopee sem conexão
    const unlinked = await prisma.store.findFirst({
      where: { marketplace: 'shopee', spShopId: null },
      orderBy: { createdAt: 'asc' },
    });
    if (unlinked) {
      await prisma.store.update({
        where: { id: unlinked.id },
        data: {
          spAccessToken:    tokens.access_token,
          spRefreshToken:   tokens.refresh_token,
          spShopId:         String(shop_id),
          spShopName:       shopName,
          spTokenExpiresAt: expiresAt,
        },
      });
      return res.redirect(`${FRONTEND_URL}/settings?sp_connected=1&store=${unlinked.id}`);
    }

    return res.redirect(`${FRONTEND_URL}/settings?sp_error=loja_nao_encontrada`);
  } catch (err) {
    console.error('[Shopee] callback erro:', err.message);
    return res.redirect(`${FRONTEND_URL}/settings?sp_error=${encodeURIComponent(err.message)}`);
  }
}

// GET /api/shopee/status?storeId=xxx
async function getStatus(req, res) {
  const { storeId } = req.query;
  const store = await prisma.store.findFirst({
    where: { id: storeId, userId: req.userId },
    select: { id: true, spAccessToken: true, spShopId: true, spShopName: true, spTokenExpiresAt: true },
  });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  const connected  = !!store.spAccessToken && !!store.spShopId;
  const expired    = store.spTokenExpiresAt ? new Date(store.spTokenExpiresAt) < new Date() : false;
  const configured = isConfigured();

  return res.json({
    connected,
    expired,
    configured,
    shopId:   store.spShopId,
    shopName: store.spShopName,
  });
}

// POST /api/shopee/disconnect
async function disconnect(req, res) {
  const { storeId } = req.body;
  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  await prisma.store.update({
    where: { id: storeId },
    data: { spAccessToken: null, spRefreshToken: null, spShopId: null, spShopName: null, spTokenExpiresAt: null },
  });
  return res.json({ success: true });
}

// POST /api/shopee/refresh-token
async function refreshToken(req, res) {
  const { storeId } = req.body;
  const store = await prisma.store.findFirst({ where: { id: storeId, userId: req.userId } });
  if (!store?.spRefreshToken) return res.status(400).json({ error: 'Token não disponível — reconecte a loja' });

  try {
    const tokens    = await refreshShopeeToken(store.spRefreshToken, store.spShopId);
    const expiresAt = new Date(Date.now() + ((tokens.expire_in ?? 14400) * 1000));
    await prisma.store.update({
      where: { id: storeId },
      data: {
        spAccessToken:    tokens.access_token,
        spRefreshToken:   tokens.refresh_token ?? store.spRefreshToken,
        spTokenExpiresAt: expiresAt,
      },
    });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao renovar token: ' + err.message });
  }
}

module.exports = { getAuth, handleCallback, getStatus, disconnect, refreshToken };
