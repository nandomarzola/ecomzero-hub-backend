const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { listSuppliers, getSupplier, createSupplier, updateSupplier, deleteSupplier } = require('../controllers/supplierController');

router.get('/',    authMiddleware, listSuppliers);
router.get('/:id', authMiddleware, getSupplier);
router.post('/',   authMiddleware, createSupplier);
router.put('/:id', authMiddleware, updateSupplier);
router.delete('/:id', authMiddleware, deleteSupplier);

module.exports = router;
