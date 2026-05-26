const express = require('express');
const router  = express.Router();
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { getStats, listUsers, updateUser, getPlans } = require('../controllers/adminController');

router.use(authMiddleware, adminMiddleware); // todas as rotas exigem admin

router.get('/stats',        getStats);
router.get('/users',        listUsers);
router.put('/users/:id',    updateUser);
router.get('/plans',        getPlans);

module.exports = router;
