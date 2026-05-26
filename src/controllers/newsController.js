const prisma = require('../lib/prisma');

// Admin: criar novidade
async function createNews(req, res) {
  const { title, content, type } = req.body;
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: 'Título e conteúdo obrigatórios' });

  const news = await prisma.systemNews.create({
    data: {
      title:     title.trim(),
      content:   content.trim(),
      type:      type || 'feature',
      createdBy: req.userId,
    },
  });
  return res.status(201).json({ news });
}

// Admin: listar todas (com contagem de leituras)
async function adminListNews(req, res) {
  const newsList = await prisma.systemNews.findMany({
    orderBy: { publishedAt: 'desc' },
    include: { _count: { select: { reads: true } } },
  });
  return res.json({ news: newsList });
}

// Admin: editar
async function updateNews(req, res) {
  const { title, content, type } = req.body;
  const news = await prisma.systemNews.update({
    where: { id: req.params.id },
    data: {
      title:   title?.trim()   || undefined,
      content: content?.trim() || undefined,
      type:    type             || undefined,
    },
  });
  return res.json({ news });
}

// Admin: deletar
async function deleteNews(req, res) {
  await prisma.systemNews.delete({ where: { id: req.params.id } });
  return res.json({ message: 'Novidade removida' });
}

// User: listar novidades com status de leitura
async function listNews(req, res) {
  const newsList = await prisma.systemNews.findMany({
    orderBy: { publishedAt: 'desc' },
    include: { reads: { where: { userId: req.userId } } },
  });

  const enriched = newsList.map((n) => ({
    id:          n.id,
    title:       n.title,
    content:     n.content,
    type:        n.type,
    publishedAt: n.publishedAt,
    read:        n.reads.length > 0,
  }));

  const unread = enriched.filter((n) => !n.read).length;
  return res.json({ news: enriched, unread });
}

// User: marcar como lida
async function markRead(req, res) {
  await prisma.newsRead.upsert({
    where:  { userId_newsId: { userId: req.userId, newsId: req.params.id } },
    create: { userId: req.userId, newsId: req.params.id },
    update: {},
  });
  return res.json({ ok: true });
}

// User: marcar todas como lidas
async function markAllRead(req, res) {
  const unread = await prisma.systemNews.findMany({
    where: { reads: { none: { userId: req.userId } } },
    select: { id: true },
  });

  await prisma.newsRead.createMany({
    data: unread.map((n) => ({ userId: req.userId, newsId: n.id })),
    skipDuplicates: true,
  });

  return res.json({ marked: unread.length });
}

module.exports = { createNews, adminListNews, updateNews, deleteNews, listNews, markRead, markAllRead };
