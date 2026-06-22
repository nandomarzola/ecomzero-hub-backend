const express = require('express');
const router  = express.Router();
const rateLimit = require('express-rate-limit');
const { authMiddleware } = require('../middleware/auth');
const { getAuth, handleCallback, getStatus, disconnect, refreshToken, syncOrders, syncItems, syncTraffic } = require('../controllers/shopeeController');

const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas sincronizações em sequência. Aguarde 1 minuto.' },
  keyGenerator: (req) => req.userId ?? req.ip,
});

// Callback público — Shopee redireciona sem Authorization header
router.get('/callback', handleCallback);

// Demais rotas protegidas
router.use(authMiddleware);
router.get('/auth',           getAuth);
router.get('/status',         getStatus);
router.post('/disconnect',    disconnect);
router.post('/refresh-token', refreshToken);
router.post('/sync',          syncLimiter, syncOrders);
router.post('/sync-items',    syncLimiter, syncItems);
router.post('/sync-traffic',  syncLimiter, syncTraffic);

module.exports = router;
