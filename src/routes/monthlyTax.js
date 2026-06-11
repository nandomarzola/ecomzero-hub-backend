const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getMonthlyTax, saveMonthlyTax } = require('../controllers/monthlyTaxController');

router.use(authMiddleware);

router.get('/:month',  getMonthlyTax);
router.post('/:month', saveMonthlyTax);

module.exports = router;
