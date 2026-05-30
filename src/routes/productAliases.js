const express = require('express');
const { authMiddleware: auth } = require('../middleware/auth');
const { suggestProducts, resolveOrphan } = require('../controllers/productAliasController');

const router = express.Router();

router.get('/suggest',  auth, suggestProducts);
router.post('/resolve', auth, resolveOrphan);

module.exports = router;
