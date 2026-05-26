const fs     = require('fs');
const prisma  = require('../lib/prisma');
const { calcProfit } = require('../services/calculatorService');
const { importShopeeParentSKU } = require('../services/importService');

// POST /api/orders/import
async function importOrders(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Arquivo .xlsx obrigatório' });

  const { storeId } = req.body;
  if (!storeId) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'storeId obrigatório' });
  }

  let result;
  try {
    result = await importShopeeParentSKU(req.file.path, storeId, req.userId, req.file.originalname);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch {}
  }

  return res.status(201).json(result);
}

// GET /api/orders
async function listOrders(req, res) {
  const { storeId, startDate, endDate, status, page = 1, limit = 20 } = req.query;

  const where = { store: { userId: req.userId } };
  if (storeId) where.storeId = storeId;
  if (status)  where.status  = status;
  if (startDate || endDate) {
    where.soldAt = {};
    if (startDate) where.soldAt.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      where.soldAt.lte = end;
    }
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const [orders, total, agg] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: { orderBy: { quantity: 'desc' }, include: { product: { select: { name: true, sku: true } } } } },
      orderBy: { salePrice: 'desc' },
      skip,
      take,
    }),
    prisma.order.count({ where }),
    prisma.order.aggregate({
      where,
      _sum: { salePrice: true, profit: true },
    }),
  ]);

  return res.json({
    orders,
    total,
    page:         parseInt(page),
    limit:        take,
    totalRevenue: parseFloat((agg._sum.salePrice ?? 0).toFixed(2)),
    totalProfit:  parseFloat((agg._sum.profit   ?? 0).toFixed(2)),
  });
}

// GET /api/orders/:id
async function getOrder(req, res) {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
    include: {
      store: { select: { name: true, marketplace: true, commission: true, serviceFee: true, taxRate: true, fixedFeePerItem: true } },
      items: { include: { product: true } },
    },
  });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });

  const breakdowns = order.items.map((item) =>
    calcProfit(item.unitPrice * item.quantity, item.quantity, item.product, order.store, 0, 0)
  );

  return res.json({ order, breakdowns });
}

// DELETE /api/orders/:id — soft delete, reverte estoque
async function deleteOrder(req, res) {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
    include: { items: true },
  });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (order.status === 'cancelled') return res.status(400).json({ error: 'Pedido já cancelado' });

  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data: { status: 'cancelled' } });

    if (order.status === 'paid') {
      for (const item of order.items) {
        await tx.product.update({
          where: { id: item.productId },
          data:  { stock: { increment: item.quantity } },
        });
      }
    }
  });

  return res.json({ message: 'Pedido cancelado e estoque revertido' });
}

// POST /api/orders/recalculate
// Recalcula profit/margin usando os custos atuais de produto e taxas da loja.
// Por padrão opera apenas no mês corrente (soldAt no mesmo mês de hoje).
// Passe { month: "2026-05" } no body para outro mês específico.
// Meses passados são protegidos: recalcula usando os snapshots salvos na importação,
// apenas atualizando o profit/margin caso os custos de produto tenham mudado.
async function recalculateOrders(req, res) {
  const { month } = req.body ?? {};

  const now = new Date();
  const targetMonth = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [year, mon] = targetMonth.split('-').map(Number);
  const startOfMonth = new Date(Date.UTC(year, mon - 1, 1));
  const endOfMonth   = new Date(Date.UTC(year, mon, 0, 23, 59, 59, 999));

  const isCurrentMonth =
    year === now.getFullYear() && mon === now.getMonth() + 1;

  const orders = await prisma.order.findMany({
    where: {
      store:  { userId: req.userId },
      soldAt: { gte: startOfMonth, lte: endOfMonth },
    },
    include: { store: true, items: { include: { product: true } } },
  });

  let updated = 0;
  for (const order of orders) {
    let totalProfit    = 0;
    let totalSalePrice = 0;

    for (const item of order.items) {
      // Para o mês atual: usa configurações atuais da loja + custo atual do produto
      // Para meses passados: usa snapshots salvos na importação (taxas e custo do produto)
      const storeConfig = isCurrentMonth
        ? order.store
        : {
            commission:      order.snapshotCommission,
            serviceFee:      order.snapshotServiceFee,
            taxRate:         order.snapshotTaxRate,
            fixedFeePerItem: order.snapshotFixedFee,
          };

      const productConfig = isCurrentMonth
        ? item.product
        : {
            costPrice: item.snapshotCostPrice,
            packaging: item.snapshotPackaging,
            supplies:  item.snapshotSupplies,
          };

      const calc = calcProfit(item.unitPrice * item.quantity, item.quantity, productConfig, storeConfig, 0, 0);
      totalProfit    += calc.profit;
      totalSalePrice += calc.breakdown.salePrice;
    }

    const margin = totalSalePrice > 0 ? (totalProfit / totalSalePrice) * 100 : 0;
    await prisma.order.update({
      where: { id: order.id },
      data:  {
        profit: parseFloat(totalProfit.toFixed(2)),
        margin: parseFloat(margin.toFixed(2)),
      },
    });
    updated++;
  }

  return res.json({
    updated,
    month: targetMonth,
    isCurrentMonth,
    message: `${updated} pedido(s) de ${targetMonth} recalculado(s)`,
  });
}

module.exports = { importOrders, listOrders, getOrder, deleteOrder, recalculateOrders };
