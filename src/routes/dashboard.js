const express  = require('express');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getSummary, getAlerts, getMonthlyReport } = require('../controllers/dashboardController');

router.get('/summary', authMiddleware, getSummary);
router.get('/alerts',  authMiddleware, getAlerts);
router.get('/report',  authMiddleware, getMonthlyReport);

module.exports = router;
