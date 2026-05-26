const express = require('express');
const router  = express.Router();
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const {
  createNews, adminListNews, updateNews, deleteNews,
  listNews, markRead, markAllRead,
} = require('../controllers/newsController');

// Rotas fixas ANTES das rotas com parâmetro (:id)
router.get('/admin/all',      authMiddleware, adminMiddleware, adminListNews);
router.post('/admin',         authMiddleware, adminMiddleware, createNews);
router.put('/admin/:id',      authMiddleware, adminMiddleware, updateNews);
router.delete('/admin/:id',   authMiddleware, adminMiddleware, deleteNews);

router.get('/',               authMiddleware, listNews);
router.post('/read-all',      authMiddleware, markAllRead);
router.post('/:id/read',      authMiddleware, markRead);

module.exports = router;
