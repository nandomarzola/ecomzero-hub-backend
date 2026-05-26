const prisma = require('../lib/prisma');

function computeBillStatus(bill) {
  if (bill.status === 'paid') return 'paid';
  return new Date(bill.dueDate) < new Date() ? 'overdue' : 'pending';
}

async function getSummary(req, res) {
  const { storeId, startDate, endDate } = req.query;

  // Lojas do usuário
  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);

  const dateFilter = {};
  if (startDate) dateFilter.gte = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);
    dateFilter.lte = end;
  }

  // Receitas (pedidos pagos)
  const orderWhere = {
    storeId: { in: storeIds },
    status:  'paid',
    ...(Object.keys(dateFilter).length ? { soldAt: dateFilter } : {}),
  };

  const orders = await prisma.order.findMany({
    where:  orderWhere,
    select: { salePrice: true, profit: true, soldAt: true },
  });

  const totalRevenue = orders.reduce((s, o) => s + o.salePrice, 0);
  const totalProfit  = orders.reduce((s, o) => s + (o.profit ?? 0), 0);

  // Contas a pagar do usuário
  const billWhere = {
    userId: req.userId,
    ...(storeId ? { storeId } : {}),
    ...(Object.keys(dateFilter).length ? { dueDate: dateFilter } : {}),
  };

  const bills = await prisma.bill.findMany({ where: billWhere });

  const enrichedBills = bills.map((b) => ({ ...b, computedStatus: computeBillStatus(b) }));

  const totalPaid    = enrichedBills.filter((b) => b.computedStatus === 'paid').reduce((s, b) => s + b.amount, 0);
  const totalPending = enrichedBills.filter((b) => b.computedStatus === 'pending').reduce((s, b) => s + b.amount, 0);
  const totalOverdue = enrichedBills.filter((b) => b.computedStatus === 'overdue').reduce((s, b) => s + b.amount, 0);

  // Resultado: receita - despesas pagas
  const netResult = totalRevenue - totalPaid;

  // Por categoria de despesa
  const byCategory = {};
  for (const b of enrichedBills) {
    if (!byCategory[b.category]) byCategory[b.category] = 0;
    byCategory[b.category] += b.amount;
  }

  // Evolução mensal: receitas e despesas por mês
  const monthlyMap = {};

  for (const o of orders) {
    const key = o.soldAt.toISOString().substring(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { month: key, revenue: 0, profit: 0, expenses: 0 };
    monthlyMap[key].revenue += o.salePrice;
    monthlyMap[key].profit  += o.profit ?? 0;
  }

  for (const b of enrichedBills) {
    const key = new Date(b.dueDate).toISOString().substring(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { month: key, revenue: 0, profit: 0, expenses: 0 };
    monthlyMap[key].expenses += b.amount;
  }

  const monthlyChart = Object.values(monthlyMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      month:    m.month,
      revenue:  parseFloat(m.revenue.toFixed(2)),
      profit:   parseFloat(m.profit.toFixed(2)),
      expenses: parseFloat(m.expenses.toFixed(2)),
      net:      parseFloat((m.revenue - m.expenses).toFixed(2)),
    }));

  // Próximas contas a vencer (próximos 30 dias)
  const soon = new Date();
  const soonLimit = new Date();
  soonLimit.setDate(soonLimit.getDate() + 30);

  const upcoming = enrichedBills
    .filter((b) => b.computedStatus === 'pending' && new Date(b.dueDate) <= soonLimit)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
    .slice(0, 10);

  return res.json({
    income: {
      totalRevenue:  parseFloat(totalRevenue.toFixed(2)),
      totalProfit:   parseFloat(totalProfit.toFixed(2)),
      orderCount:    orders.length,
    },
    expenses: {
      totalPaid:    parseFloat(totalPaid.toFixed(2)),
      totalPending: parseFloat(totalPending.toFixed(2)),
      totalOverdue: parseFloat(totalOverdue.toFixed(2)),
      byCategory:   Object.entries(byCategory).map(([cat, val]) => ({ category: cat, amount: parseFloat(val.toFixed(2)) })),
    },
    netResult: parseFloat(netResult.toFixed(2)),
    monthlyChart,
    upcoming,
  });
}

module.exports = { getSummary };
