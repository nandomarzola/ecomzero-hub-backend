const prisma = require('../lib/prisma');

// GET /api/stores/integration-status
// Retorna, para cada loja do usuário autenticado:
//   - lastSync: data do Import mais recente com status='done' (null se nunca sincronizou)
//   - tokenStatus: 'connected' | 'expired' | 'not_connected'
async function getIntegrationStatus(req, res) {
  const stores = await prisma.store.findMany({
    where: { userId: req.userId },
    select: {
      id:               true,
      name:             true,
      marketplace:      true,
      spAccessToken:    true,
      spRefreshToken:   true,
      spTokenExpiresAt: true,
      mlAccessToken:    true,
      mlRefreshToken:   true,
      mlTokenExpiresAt: true,
      ttAccessToken:    true,
      ttRefreshToken:   true,
      ttTokenExpiresAt: true,
    },
  });

  const now = new Date();

  const result = await Promise.all(stores.map(async (store) => {
    const lastImport = await prisma.import.findFirst({
      where:   { storeId: store.id, status: 'done' },
      orderBy: { importedAt: 'desc' },
      select:  { importedAt: true },
    });

    let tokenStatus;
    const mp = store.marketplace;

    // Regra: tokenStatus só é 'reconnect_required' quando NÃO há refresh token
    // e o access token já expirou. Se o refresh token existe, o sistema auto-renova
    // o access token na próxima sync — não é necessária ação do usuário.
    if (mp === 'shopee') {
      if (!store.spAccessToken && !store.spRefreshToken) {
        tokenStatus = 'not_connected';
      } else if (!store.spRefreshToken && store.spTokenExpiresAt && new Date(store.spTokenExpiresAt) < now) {
        tokenStatus = 'reconnect_required';
      } else {
        tokenStatus = 'connected';
      }
    } else if (mp === 'mercadolivre') {
      if (!store.mlAccessToken && !store.mlRefreshToken) {
        tokenStatus = 'not_connected';
      } else if (!store.mlRefreshToken && store.mlTokenExpiresAt && new Date(store.mlTokenExpiresAt) < now) {
        tokenStatus = 'reconnect_required';
      } else {
        tokenStatus = 'connected';
      }
    } else if (mp === 'tiktok') {
      if (!store.ttAccessToken && !store.ttRefreshToken) {
        tokenStatus = 'not_connected';
      } else if (!store.ttRefreshToken && store.ttTokenExpiresAt && new Date(store.ttTokenExpiresAt) < now) {
        tokenStatus = 'reconnect_required';
      } else {
        tokenStatus = 'connected';
      }
    } else {
      tokenStatus = 'not_connected';
    }

    return {
      storeId:     store.id,
      name:        store.name,
      marketplace: store.marketplace,
      lastSync:    lastImport ? lastImport.importedAt.toISOString() : null,
      tokenStatus,
    };
  }));

  return res.json(result);
}

module.exports = { getIntegrationStatus };
