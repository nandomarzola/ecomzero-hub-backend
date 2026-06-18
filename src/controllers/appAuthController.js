const { randomInt } = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { r2 } = require('../lib/utils');

async function generateCode(req, res) {
  // Invalidar códigos anteriores não usados deste usuário
  await prisma.appAccessCode.deleteMany({
    where: { userId: req.userId, usedAt: null },
  });

  // Gerar código único de 6 dígitos
  let code, exists;
  do {
    code = String(randomInt(100000, 999999));
    exists = await prisma.appAccessCode.findUnique({ where: { code } });
  } while (exists);

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 dias

  const record = await prisma.appAccessCode.create({
    data: { userId: req.userId, code, expiresAt },
  });

  return res.json({
    code: record.code,
    expiresAt: record.expiresAt,
  });
}

async function verifyCode(req, res) {
  const { code } = req.body;
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Código inválido — deve ter 6 dígitos.' });
  }

  const record = await prisma.appAccessCode.findUnique({
    where: { code },
    include: { user: { select: { id: true, name: true, email: true, plan: true, role: true, cnpj: true } } },
  });

  if (!record)                        return res.status(401).json({ error: 'Código não encontrado.' });
  if (record.usedAt)                  return res.status(401).json({ error: 'Código já utilizado.' });
  if (new Date() > record.expiresAt)  return res.status(401).json({ error: 'Código expirado.' });

  // Marcar como usado
  await prisma.appAccessCode.update({
    where: { code },
    data: { usedAt: new Date() },
  });

  // JWT com prazo de 90 dias (app mobile)
  const token = jwt.sign(
    { userId: record.userId, source: 'mobile' },
    process.env.JWT_SECRET,
    { expiresIn: '90d' }
  );

  return res.json({
    token,
    user: record.user,
  });
}

async function getAppDashboard(req, res) {
  const { storeId } = req.query;
  const userId = req.userId;

  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Buscar lojas do usuário
  const stores = await prisma.store.findMany({
    where: { userId, ...(storeId ? { id: storeId } : {}) },
    select: { id: true, name: true, marketplace: true, taxRate: true },
  });
  const storeIds = stores.map(s => s.id);
  const taxRateMap = Object.fromEntries(stores.map(s => [s.id, s.taxRate ?? 0]));

  if (storeIds.length === 0) return res.json({ stores: [], summary: null });

  // Pedidos do mês com receita
  const orders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      soldAt: { gte: startOfMonth },
      orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
    },
    select: {
      id: true, storeId: true, soldAt: true, quantity: true,
      calcGmv: true, platformCommission: true, platformServiceFee: true,
      sellerCoupon: true, lmmDiscount: true, escrowAmount: true,
      calcProductCost: true, calcPackaging: true, orderCategory: true,
      productId: true,
    },
  });

  // Calcular por loja (recompute do raw)
  const byStore = {};
  for (const s of stores) byStore[s.id] = { storeId: s.id, name: s.name, marketplace: s.marketplace, gmv: 0, profit: 0, orders: 0 };

  let totalGmv = 0, totalProfit = 0, totalOrders = 0;
  let todayGmv = 0, todayProfit = 0, todayOrders = 0;

  for (const o of orders) {
    const taxRate = taxRateMap[o.storeId] ?? 0;
    const fee   = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
    const disc  = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
    const repasse = o.orderCategory === 'valid' && o.escrowAmount != null
      ? r2(o.escrowAmount)
      : r2(o.calcGmv - fee - disc);
    const tax    = r2(o.calcGmv * (taxRate / 100));
    const profit = r2(repasse - tax - (o.calcProductCost ?? 0) - (o.calcPackaging ?? 0));

    byStore[o.storeId].gmv    += o.calcGmv;
    byStore[o.storeId].profit += profit;
    byStore[o.storeId].orders += 1;
    totalGmv    += o.calcGmv;
    totalProfit += profit;
    totalOrders += 1;

    const orderDate = new Date(o.soldAt);
    if (orderDate >= startOfDay) {
      todayGmv    += o.calcGmv;
      todayProfit += profit;
      todayOrders += 1;
    }
  }

  // Projeção do mês
  const daysElapsed = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projectedGmv    = daysElapsed > 0 ? r2(totalGmv    / daysElapsed * daysInMonth) : 0;
  const projectedProfit = daysElapsed > 0 ? r2(totalProfit / daysElapsed * daysInMonth) : 0;

  return res.json({
    month,
    summary: {
      gmv: r2(totalGmv), profit: r2(totalProfit), orders: totalOrders,
      margin: totalGmv > 0 ? r2((totalProfit / totalGmv) * 100) : 0,
    },
    today: {
      gmv: r2(todayGmv), profit: r2(todayProfit), orders: todayOrders,
    },
    projection: {
      gmv: projectedGmv, profit: projectedProfit,
      daysElapsed, daysInMonth,
    },
    stores: Object.values(byStore).map(s => ({
      ...s,
      gmv: r2(s.gmv),
      profit: r2(s.profit),
      margin: s.gmv > 0 ? r2((s.profit / s.gmv) * 100) : 0,
    })).sort((a, b) => b.profit - a.profit),
  });
}

module.exports = { generateCode, verifyCode, getAppDashboard };
