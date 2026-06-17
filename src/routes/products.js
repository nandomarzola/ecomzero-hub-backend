const express = require('express');
const router = express.Router();
const { list, get, create, update, remove, adjustStock, addVariant, removeVariant, stockReport, exportPdf, setCostBySku, searchWithCost, saveAndRecalc, updateVariantCost, getProductStats } = require('../controllers/productController');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/stats', getProductStats);
router.get('/stock-report', stockReport);
router.get('/export-pdf', exportPdf);
router.get('/search-cost', searchWithCost);
router.patch('/by-sku', setCostBySku);
router.patch('/:id/save-and-recalc', saveAndRecalc);
router.get('/', list);
router.get('/:id', get);
router.post('/', create);
router.put('/:id', update);
router.patch('/:id', update);
router.delete('/:id', remove);
router.patch('/:id/stock', adjustStock);
router.post('/:id/variants', addVariant);
router.delete('/:id/variants/:variantId', removeVariant);
router.patch('/:id/variants/:variantId/cost', updateVariantCost);

module.exports = router;
