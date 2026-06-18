const express  = require('express');
const multer   = require('multer');
const router   = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { importOrders, importStatus, importSheinOrders, importTiktokOrders, listOrders, getOrder, deleteOrder, recalculateOrders, recalculateStatus, exportOrders, skuReport } = require('../controllers/orderController');

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

const uploadCsv = multer({
  dest: process.env.UPLOAD_DIR || './uploads/',
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.csv$/i.test(file.originalname) || file.mimetype.includes('csv') || file.mimetype.includes('text');
    ok ? cb(null, true) : cb(new Error('Apenas arquivos .csv são aceitos'));
  },
});

router.post('/import',            authMiddleware, upload.single('file'),    importOrders);
router.post('/import-shein',      authMiddleware, upload.single('file'),    importSheinOrders);
router.post('/import-tiktok',     authMiddleware, uploadCsv.single('file'), importTiktokOrders);
router.get('/import/:jobId',      authMiddleware, importStatus);
router.post('/recalculate',          authMiddleware, recalculateOrders);
router.get('/recalculate/:jobId',    authMiddleware, recalculateStatus);
router.get('/export',     authMiddleware, exportOrders);
router.get('/sku-report', authMiddleware, skuReport);
router.get('/',        authMiddleware, listOrders);
router.get('/:id',    authMiddleware, getOrder);
router.delete('/:id', authMiddleware, deleteOrder);

module.exports = router;
