const express = require('express');
const router = express.Router();
const { list, get, create, update, remove, adjustStock } = require('../controllers/productController');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', list);
router.get('/:id', get);
router.post('/', create);
router.put('/:id', update);
router.delete('/:id', remove);
router.patch('/:id/stock', adjustStock);

module.exports = router;
