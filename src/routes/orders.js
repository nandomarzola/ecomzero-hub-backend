const express  = require('express');
const multer   = require('multer');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { importOrders, importStatus, listOrders, getOrder, deleteOrder, recalculateOrders, recalculateStatus, exportOrders, skuReport } = require('../controllers/orderController');

const upload = multer({
  dest: process.env.UPLOAD_DIR || './uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.includes('spreadsheet') ||
               file.originalname.endsWith('.xlsx') ||
               file.originalname.endsWith('.xls');
    ok ? cb(null, true) : cb(new Error('Apenas arquivos .xlsx são aceitos'));
  },
});

router.post('/import',            authMiddleware, upload.single('file'), importOrders);
router.get('/import/:jobId',      authMiddleware, importStatus);
router.post('/recalculate',          authMiddleware, recalculateOrders);
router.get('/recalculate/:jobId',    authMiddleware, recalculateStatus);
router.get('/export',     authMiddleware, exportOrders);
router.get('/sku-report', authMiddleware, skuReport);
router.get('/',        authMiddleware, listOrders);
router.get('/:id',    authMiddleware, getOrder);
router.delete('/:id', authMiddleware, deleteOrder);

module.exports = router;
