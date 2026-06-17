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
      spTokenExpiresAt: true,
      mlAccessToken:    true,
      mlTokenExpiresAt: true,
      ttAccessToken:    true,
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

    if (mp === 'shopee') {
      if (!store.spAccessToken) {
        tokenStatus = 'not_connected';
      } else if (store.spTokenExpiresAt && new Date(store.spTokenExpiresAt) < now) {
        tokenStatus = 'expired';
      } else {
        tokenStatus = 'connected';
      }
    } else if (mp === 'mercadolivre') {
      if (!store.mlAccessToken) {
        tokenStatus = 'not_connected';
      } else if (store.mlTokenExpiresAt && new Date(store.mlTokenExpiresAt) < now) {
        tokenStatus = 'expired';
      } else {
        tokenStatus = 'connected';
      }
    } else if (mp === 'tiktok') {
      if (!store.ttAccessToken) {
        tokenStatus = 'not_connected';
      } else if (store.ttTokenExpiresAt && new Date(store.ttTokenExpiresAt) < now) {
        tokenStatus = 'expired';
      } else {
        tokenStatus = 'connected';
      }
    } else {
      tokenStatus = store.spAccessToken || store.mlAccessToken || store.ttAccessToken
        ? 'connected'
        : 'not_connected';
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
