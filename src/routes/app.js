const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { generateCode, verifyCode, getAppDashboard } = require('../controllers/appAuthController');

router.post('/auth/generate-code', authMiddleware, generateCode);   // web → gera código
router.post('/auth/verify-code',   verifyCode);                     // app → troca código por JWT
router.get('/dashboard',           authMiddleware, getAppDashboard); // app → dashboard resumido
router.get('/me',                  authMiddleware, (req, res) => res.json({ user: { id: req.userId } })); // valida token

module.exports = router;
