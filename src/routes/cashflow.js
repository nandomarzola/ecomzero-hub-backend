const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getSummary } = require('../controllers/cashflowController');

router.get('/summary', authMiddleware, getSummary);

module.exports = router;
