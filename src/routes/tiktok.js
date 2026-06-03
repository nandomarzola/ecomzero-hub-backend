const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getAuth, handleCallback, getStatus, disconnect, syncOrders } = require('../controllers/tiktokController');

router.get('/callback', handleCallback); // OAuth redirect — sem auth
router.use(authMiddleware);
router.get('/auth',        getAuth);
router.get('/status',      getStatus);
router.post('/disconnect', disconnect);
router.post('/sync',       syncOrders);

module.exports = router;
