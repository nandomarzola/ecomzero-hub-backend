const express = require('express');
const router  = express.Router();
const rateLimit = require('express-rate-limit');
const { authMiddleware } = require('../middleware/auth');
const { getAuth, handleCallback, getStatus, disconnect, syncOrders, syncItems } = require('../controllers/mlController');

const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas sincronizações em sequência. Aguarde 1 minuto.' },
  keyGenerator: (req) => req.userId ?? req.ip,
});

// Callback não precisa de auth (ML redireciona sem header)
router.get('/callback', handleCallback);

// Demais rotas protegidas
router.use(authMiddleware);
router.get('/auth',        getAuth);
router.get('/status',      getStatus);
router.post('/disconnect',  disconnect);
router.post('/sync',        syncLimiter, syncOrders);
router.post('/sync-items',  syncLimiter, syncItems);

module.exports = router;
