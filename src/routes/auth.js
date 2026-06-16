const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { register, login, me, updateMe, ping } = require('../controllers/authController');
const { authMiddleware } = require('../middleware/auth');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos.' },
  skip: () => process.env.NODE_ENV === 'test',
});

router.post('/register', authLimiter, register);
router.post('/login',    authLimiter, login);
router.get('/me',   authMiddleware, me);
router.put('/me',   authMiddleware, updateMe);
router.post('/ping', authMiddleware, ping);

module.exports = router;
