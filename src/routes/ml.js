const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getAuth, handleCallback, getStatus, disconnect, syncOrders, syncItems } = require('../controllers/mlController');

// Callback não precisa de auth (ML redireciona sem header)
router.get('/callback', handleCallback);

// Demais rotas protegidas
router.use(authMiddleware);
router.get('/auth',       getAuth);
router.get('/status',     getStatus);
router.post('/disconnect', disconnect);
router.post('/sync',       syncOrders);
router.post('/sync-items', syncItems);

module.exports = router;
