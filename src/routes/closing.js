const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getHistory, getClosing, closeMonth, reopenMonth, getPdf, getProductOrders } = require('../controllers/closingController');

router.use(authMiddleware);

router.get('/history',        getHistory);
router.get('/:month/pdf',     getPdf);
router.get('/:month/orders',  getProductOrders);
router.get('/:month',         getClosing);
router.post('/:month/close',  closeMonth);
router.post('/:month/reopen', reopenMonth);

module.exports = router;
