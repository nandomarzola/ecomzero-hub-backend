const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getInsights } = require('../controllers/insightsController');

router.get('/', authMiddleware, getInsights);

module.exports = router;
