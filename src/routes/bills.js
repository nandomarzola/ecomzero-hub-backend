const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { listBills, createBill, updateBill, payBill, deleteBill } = require('../controllers/billController');

router.get('/',           authMiddleware, listBills);
router.post('/',          authMiddleware, createBill);
router.put('/:id',        authMiddleware, updateBill);
router.post('/:id/pay',   authMiddleware, payBill);
router.delete('/:id',     authMiddleware, deleteBill);

module.exports = router;
