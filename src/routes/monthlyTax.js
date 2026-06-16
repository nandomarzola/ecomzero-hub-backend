const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getMonthlyTax, saveMonthlyTax, getMonthlyTaxHistory, getSimplesFaixaInfo } = require('../controllers/monthlyTaxController');

router.use(authMiddleware);

router.get('/simples-faixa', getSimplesFaixaInfo);
router.get('/history',       getMonthlyTaxHistory);
router.get('/:month',        getMonthlyTax);
router.post('/:month',       saveMonthlyTax);

module.exports = router;
