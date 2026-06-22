const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { generateCode, verifyCode, getAppDashboard, getAppTrends, getAppProducts, getAppProductMetrics, getAppAlerts, getAppOrderDetail } = require('../controllers/appAuthController');
const prisma = require('../lib/prisma');

router.post('/auth/generate-code', authMiddleware, generateCode);   // web → gera código
router.post('/auth/verify-code',   verifyCode);                     // app → troca código por JWT
router.get('/dashboard',           authMiddleware, getAppDashboard); // app → dashboard resumido
router.get('/trends',              authMiddleware, getAppTrends);
router.get('/products',            authMiddleware, getAppProducts);
router.get('/product-metrics',     authMiddleware, getAppProductMetrics);
router.get('/alerts',              authMiddleware, getAppAlerts);
router.get('/order/:orderId',      authMiddleware, getAppOrderDetail);
router.get('/me', authMiddleware, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, name: true, email: true },
  });
  res.json({ user });
});

module.exports = router;
