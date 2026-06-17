const express = require('express');
const router = express.Router();
const { list, get, create, update, remove, getRates } = require('../controllers/storeController');
const { getIntegrationStatus } = require('../controllers/storeStatusController');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', list);
router.get('/integration-status', getIntegrationStatus);
router.get('/:id/rates', getRates);
router.get('/:id', get);
router.post('/', create);
router.put('/:id', update);
router.delete('/:id', remove);

module.exports = router;
