const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const {
  listPurchaseOrders, getPurchaseOrder, createPurchaseOrder,
  sendPurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder, deletePurchaseOrder,
  getProductCosts,
} = require('../controllers/purchaseOrderController');

router.get('/product-costs',          authMiddleware, getProductCosts);
router.get('/',                        authMiddleware, listPurchaseOrders);
router.get('/:id',                     authMiddleware, getPurchaseOrder);
router.post('/',                       authMiddleware, createPurchaseOrder);
router.post('/:id/send',               authMiddleware, sendPurchaseOrder);
router.post('/:id/receive',            authMiddleware, receivePurchaseOrder);
router.post('/:id/cancel',             authMiddleware, cancelPurchaseOrder);
router.delete('/:id',                  authMiddleware, deletePurchaseOrder);

module.exports = router;
