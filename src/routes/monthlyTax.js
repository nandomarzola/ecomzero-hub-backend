const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getMonthlyTax, saveMonthlyTax, getMonthlyTaxHistory } = require('../controllers/monthlyTaxController');

router.use(authMiddleware);

router.get('/history', getMonthlyTaxHistory);
router.get('/:month',  getMonthlyTax);
router.post('/:month', saveMonthlyTax);

module.exports = router;
