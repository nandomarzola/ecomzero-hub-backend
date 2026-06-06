const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getAuth, handleCallback, getStatus, disconnect, refreshToken } = require('../controllers/shopeeController');

// Callback público — Shopee redireciona sem Authorization header
router.get('/callback', handleCallback);

// Demais rotas protegidas
router.use(authMiddleware);
router.get('/auth',           getAuth);
router.get('/status',         getStatus);
router.post('/disconnect',    disconnect);
router.post('/refresh-token', refreshToken);

module.exports = router;
