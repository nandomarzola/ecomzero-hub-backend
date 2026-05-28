const fs     = require('fs');
const prisma  = require('../lib/prisma');
const { calcProfit } = require('../services/calculatorService');
const { Job }        = require('bullmq');
const { importQueue } = require('../services/importQueue');
const connection = require('../lib/redisConnection');

// POST /api/orders/import — enfileira job, responde 202 + jobId imediatamente
async function importOrders(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Arquivo .xlsx obrigatório' });

  const { storeId } = req.body;
  if (!storeId) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'storeId obrigatório' });
  }

  const job = await importQueue.add('import', {
    filePath: req.file.path,
    filename: req.file.originalname,
    storeId,
    userId:   req.userId,
  });

  return res.status(202).json({ jobId: job.id });
}

// GET /api/orders/import/:jobId — retorna status do job via BullMQ/Redis
async function importStatus(req, res) {
  const job = await Job.fromId(importQueue, req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  if (job.data.userId !== req.userId) return res.status(403).json({ error: 'Acesso negado' });

  const state = await job.getState(); // waiting | active | completed | failed | delayed

  const statusMap = { waiting: 'pending', active: 'processing', completed: 'done', failed: 'error', delayed: 'pending' };

  return res.json({
    jobId:    job.id,
    status:   statusMap[state] ?? state,
    progress: job.progress ?? { step: 'aguardando', current: 0, total: 0 },
    result:   state === 'completed' ? job.returnvalue : null,
    error:    state === 'failed'    ? job.failedReason : null,
  });
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
            marketplace:     order.store.marketplace,
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

// GET /api/orders/export — retorna CSV com todos os pedidos do período (sem paginação)
async function exportOrders(req, res) {
  const { storeId, startDate, endDate, status } = req.query;

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

  const orders = await prisma.order.findMany({
    where,
    include: { items: { include: { product: { select: { name: true, sku: true } } } } },
    orderBy: { soldAt: 'desc' },
  });

  const header = ['Data', 'ID Externo', 'Produto', 'SKU', 'Qtd', 'Faturado', 'Lucro', 'Margem (%)', 'Status'];

  const rows = orders.map((o) => {
    const date    = new Date(o.soldAt).toLocaleDateString('pt-BR');
    const extId   = o.externalId ?? '';
    const name    = o.items?.[0]?.product?.name ?? '';
    const sku     = o.items?.[0]?.product?.sku  ?? '';
    const qty     = o.items?.reduce((s, it) => s + it.quantity, 0) ?? 0;
    const revenue = Number(o.salePrice ?? 0).toFixed(2).replace('.', ',');
    const profit  = Number(o.profit   ?? 0).toFixed(2).replace('.', ',');
    const margin  = Number(o.margin   ?? 0).toFixed(1).replace('.', ',');
    const statusLabel = { paid: 'Pago', cancelled: 'Cancelado', returned: 'Devolvido' }[o.status] ?? o.status;
    return [date, extId, name, sku, qty, revenue, profit, margin, statusLabel]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(';');
  });

  const csv = [header.join(';'), ...rows].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pedidos.csv"');
  res.send('﻿' + csv); // BOM para Excel reconhecer UTF-8
}

// GET /api/orders/sku-report — performance por produto no período
async function skuReport(req, res) {
  const { storeId, startDate, endDate } = req.query;

  const where = { store: { userId: req.userId }, status: { not: 'cancelled' } };
  if (storeId) where.storeId = storeId;
  if (startDate || endDate) {
    where.soldAt = {};
    if (startDate) where.soldAt.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      where.soldAt.lte = end;
    }
  }

  const orders = await prisma.order.findMany({
    where,
    include: {
      store: { select: { marketplace: true } },
      items: { include: { product: { select: { id: true, name: true, sku: true } } } },
    },
  });

  // Agrega por produto usando cálculo por item com snapshots
  const map = new Map();

  for (const order of orders) {
    const isCurrentMonth = (() => {
      const now = new Date();
      const d   = new Date(order.soldAt);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    })();

    const storeConfig = isCurrentMonth
      ? await prisma.store.findUnique({ where: { id: order.storeId } })
      : { marketplace: order.store.marketplace, commission: order.snapshotCommission, serviceFee: order.snapshotServiceFee, taxRate: order.snapshotTaxRate, fixedFeePerItem: order.snapshotFixedFee };

    for (const item of order.items) {
      const productConfig = isCurrentMonth
        ? item.product
        : { costPrice: item.snapshotCostPrice, packaging: item.snapshotPackaging, supplies: item.snapshotSupplies };

      const revenue = item.unitPrice * item.quantity;
      const calc    = calcProfit(revenue, item.quantity, productConfig, storeConfig, 0, 0);

      const pid = item.product.id;
      if (!map.has(pid)) {
        map.set(pid, {
          productId:    pid,
          name:         item.product.name,
          sku:          item.product.sku ?? '',
          totalQty:     0,
          totalRevenue: 0,
          totalProfit:  0,
          orderCount:   0,
        });
      }

      const row = map.get(pid);
      row.totalQty     += item.quantity;
      row.totalRevenue += revenue;
      row.totalProfit  += calc.profit;
      row.orderCount   += 1;
    }
  }

  const products = Array.from(map.values()).map((r) => ({
    ...r,
    totalRevenue: parseFloat(r.totalRevenue.toFixed(2)),
    totalProfit:  parseFloat(r.totalProfit.toFixed(2)),
    avgMargin:    r.totalRevenue > 0 ? parseFloat(((r.totalProfit / r.totalRevenue) * 100).toFixed(1)) : 0,
  })).sort((a, b) => b.totalRevenue - a.totalRevenue);

  const totals = products.reduce((s, p) => ({
    qty:     s.qty     + p.totalQty,
    revenue: s.revenue + p.totalRevenue,
    profit:  s.profit  + p.totalProfit,
  }), { qty: 0, revenue: 0, profit: 0 });

  return res.json({ products, totals });
}

module.exports = { importOrders, importStatus, listOrders, getOrder, deleteOrder, recalculateOrders, exportOrders, skuReport };
