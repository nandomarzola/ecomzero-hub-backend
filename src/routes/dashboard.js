const express  = require('express');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getSummary, getAlerts, getMonthlyReport, getMonthlyComparison, getShopeeSummary, getShopeeLosses, getStoresComparison } = require('../controllers/dashboardController');

router.get('/summary',          authMiddleware, getSummary);
router.get('/alerts',           authMiddleware, getAlerts);
router.get('/report',           authMiddleware, getMonthlyReport);
router.get('/comparison',       authMiddleware, getMonthlyComparison);
router.get('/shopee-summary',   authMiddleware, getShopeeSummary);
router.get('/shopee-losses',    authMiddleware, getShopeeLosses);
router.get('/stores-comparison', authMiddleware, getStoresComparison);

module.exports = router;
