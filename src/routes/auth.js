const express = require('express');
const router = express.Router();
const { register, login, me, updateMe, ping } = require('../controllers/authController');
const { authMiddleware } = require('../middleware/auth');

router.post('/register', register);
router.post('/login', login);
router.get('/me',   authMiddleware, me);
router.put('/me',   authMiddleware, updateMe);
router.post('/ping', authMiddleware, ping);

module.exports = router;
