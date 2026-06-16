const prisma = require('../lib/prisma');
const PLANS  = require('../config/plans');
const { parsePage } = require('../lib/utils');

const ONLINE_THRESHOLD_MS  = 15 * 60 * 1000; // 15 min
const ACTIVE_THRESHOLD_DAYS = 30;

function userStatus(u) {
  if (!u.lastSeenAt) return 'inactive';
  const diff = Date.now() - new Date(u.lastSeenAt).getTime();
  if (diff < ONLINE_THRESHOLD_MS) return 'online';
  if (diff < ACTIVE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000) return 'active';
  return 'inactive';
}

// GET /api/admin/stats
async function getStats(req, res) {
  const users = await prisma.user.findMany({
    select: { id: true, plan: true, role: true, lastSeenAt: true, createdAt: true },
  });

  const now = new Date();

  // Contagens gerais (todos os usuários)
  const total    = users.length;
  const online   = users.filter((u) => userStatus(u) === 'online').length;
  const active   = users.filter((u) => userStatus(u) === 'active').length;
  const inactive = users.filter((u) => userStatus(u) === 'inactive').length;

  // MRR/ARR: apenas sellers pagantes (admins não pagam — são proprietários)
  const sellers = users.filter((u) => u.role === 'seller');
  const byPlan  = PLANS.map((plan) => {
    const count = sellers.filter((u) => u.plan === plan.id).length;
    return {
      ...plan,
      count,
      revenue: parseFloat((count * plan.price).toFixed(2)),
    };
  });

  const mrr = parseFloat(byPlan.reduce((s, p) => s + p.revenue, 0).toFixed(2));
  const arr  = parseFloat((mrr * 12).toFixed(2));

  // Novos usuários nos últimos 30 dias
  const since30 = new Date(now);
  since30.setDate(since30.getDate() - 30);
  const newLast30 = users.filter((u) => new Date(u.createdAt) >= since30).length;

  // Usuários por dia (últimos 30 dias) para sparkline
  const dailyMap = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dailyMap[d.toISOString().substring(0, 10)] = 0;
  }
  for (const u of users) {
    const key = new Date(u.createdAt).toISOString().substring(0, 10);
    if (key in dailyMap) dailyMap[key]++;
  }
  const registrationChart = Object.entries(dailyMap).map(([date, count]) => ({ date, count }));

  return res.json({
    total, online, active, inactive,
    newLast30,
    mrr: parseFloat(mrr.toFixed(2)),
    arr,
    byPlan,
    registrationChart,
  });
}

// GET /api/admin/users
async function listUsers(req, res) {
  const { search = '', plan = '', page = 1, limit = 20 } = req.query;

  const where = {};
  if (plan)   where.plan = plan;
  if (search) {
    where.OR = [
      { name:  { contains: search } },
      { email: { contains: search } },
    ];
  }

  const { skip, take } = parsePage(page, limit);

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, plan: true,
        role: true, lastSeenAt: true, createdAt: true,
        _count: { select: { stores: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.user.count({ where }),
  ]);

  const enriched = users.map((u) => ({
    ...u,
    status: userStatus(u),
    planInfo: PLANS.find((p) => p.id === u.plan) ?? null,
  }));

  return res.json({ users: enriched, total, page: Math.max(1, parseInt(page, 10) || 1), limit: take });
}

// PUT /api/admin/users/:id — alterar plano e/ou role
async function updateUser(req, res) {
  const { plan, role } = req.body;

  const validPlans = PLANS.map((p) => p.id);
  if (plan && !validPlans.includes(plan)) {
    return res.status(400).json({ error: `Plano inválido. Válidos: ${validPlans.join(', ')}` });
  }
  if (role && !['seller', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Role inválida. Válidas: seller, admin' });
  }

  const exists = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!exists) return res.status(404).json({ error: 'Usuário não encontrado' });

  // Protege: admin não pode rebaixar a si mesmo
  if (req.params.id === req.userId && role === 'seller') {
    return res.status(400).json({ error: 'Você não pode remover seus próprios privilégios de admin' });
  }

  const data = {};
  if (plan) data.plan = plan;
  if (role) data.role = role;

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data,
    select: { id: true, name: true, email: true, plan: true, role: true, lastSeenAt: true, createdAt: true },
  });

  return res.json({ user: { ...user, status: userStatus(user), planInfo: PLANS.find((p) => p.id === user.plan) } });
}

// GET /api/admin/plans
async function getPlans(req, res) {
  return res.json({ plans: PLANS });
}

// GET /api/admin/access-logs — logs de acesso para monitoramento
async function getAccessLogs(req, res) {
  const { email, action, limit = 100, page = 1 } = req.query;
  const where = {};
  if (email)  where.email  = { contains: email };
  if (action) where.action = action;

  const { skip: logSkip, take: logTake } = parsePage(page, limit, { maxLimit: 500, defaultLimit: 100 });
  const [logs, total] = await Promise.all([
    prisma.accessLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: logTake,
      skip: logSkip,
    }),
    prisma.accessLog.count({ where }),
  ]);

  return res.json({ logs, total, page: parseInt(page) });
}

module.exports = { getStats, listUsers, updateUser, getPlans, getAccessLogs };
