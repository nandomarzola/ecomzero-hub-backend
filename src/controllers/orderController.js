const fs    = require('fs');
const prisma = require('../lib/prisma');
const { recalculateQueue, recalcProgress } = require('../services/recalculateQueue');
const { importShopeeOrderAll } = require('../services/importOrderAll');

function r2(n) { return Math.round(n * 100) / 100; }

// Progress em memória — sem Redis, sem BullMQ
// importId → { pct, message }
const importProgress = new Map();

// POST /api/orders/import — dispara import em background, responde imediatamente
async function importOrders(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Arquivo .xlsx obrigatório' });
  const { storeId } = req.body;
  if (!storeId) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'storeId obrigatório' });
  }

  // Criar Import record imediatamente para ter o ID
  const imp = await prisma.import.create({
    data: { storeId, filename: req.file.originalname, periodMonth: '0000-00', totalRows: 0, status: 'processing' },
  });

  importProgress.set(imp.id, { pct: 2, message: 'Iniciando...' });

  // Disparar em background — sem await
  setImmediate(async () => {
    try {
      await importShopeeOrderAll(
        req.file.path,
        storeId,
        req.userId,
        req.file.originalname,
        (progress) => importProgress.set(imp.id, progress),
        imp.id,
      );
    } catch (err) {
      console.error('[import] erro:', err.message);
      await prisma.import.update({
        where: { id: imp.id },
        data: { status: 'error', errorMessage: err.message },
      }).catch(() => {});
    } finally {
      importProgress.delete(imp.id);
      try { fs.unlinkSync(req.file.path); } catch {}
    }
  });

  return res.status(202).json({ jobId: imp.id });
}

// GET /api/orders/import/:jobId — lê do Import record + progress em memória
async function importStatus(req, res) {
  const importId = req.params.jobId;
  const imp = await prisma.import.findUnique({ where: { id: importId } }).catch(() => null);
  if (!imp) return res.status(404).json({ error: 'Import não encontrado' });

  const progress = importProgress.get(importId);

  if (imp.status === 'done') {
    return res.json({
      jobId:  importId,
      status: 'done',
      pct:    100,
      message: 'Concluído!',
      result: {
        imported:    (imp.validCount ?? 0) + (imp.pendingCount ?? 0),
        valid:       imp.validCount ?? 0,
        pending:     imp.pendingCount ?? 0,
        cancelled:   imp.cancelledCount ?? 0,
        skipped:     0,
        periodMonth: imp.periodMonth,
      },
    });
  }

  if (imp.status === 'error') {
    return res.json({ jobId: importId, status: 'error', error: imp.errorMessage ?? 'Erro na importação' });
  }

  if (imp.status === 'cancelled') {
    return res.json({ jobId: importId, status: 'error', error: 'Importação cancelada' });
  }

  // processing
  return res.json({
    jobId:   importId,
    status:  'processing',
    pct:     progress?.pct    ?? 5,
    message: progress?.message ?? 'Processando...',
  });
}

// GET /api/orders/closing?storeId=&month= — dados agregados para Fechamento Mensal
async function getClosing(req, res) {
  const { storeId, month } = req.query;
  if (!month) return res.status(400).json({ error: 'month obrigatório (YYYY-MM)' });

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return res.json({ summary: null, groups: [], orphanCount: 0, month });

  const [y, mo] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, mo - 1, 1));
  const end   = new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999));

  const revenueOrders = await prisma.order.findMany({
    where: {
      storeId:       { in: storeIds },
      orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
      soldAt:        { gte: start, lte: end },
    },
    include: { product: { select: { id: true, name: true, sku: true } } },
  });

  let gmv = 0, shopeeFee = 0, netRevenue = 0, tax = 0, productCost = 0, packaging = 0, grossProfit = 0;
  let validCount = 0, pendingCount = 0, unitCount = 0;
  let validGmv = 0, pendingGmv = 0;

  const groupMap = new Map();

  for (const o of revenueOrders) {
    gmv         += o.calcGmv;
    shopeeFee   += o.calcShopeeFee;
    netRevenue  += o.calcNetRevenue;
    tax         += o.calcTax;
    productCost += o.calcProductCost;
    packaging   += o.calcPackaging;
    grossProfit += o.calcGrossProfit;
    unitCount   += o.quantity;
    if (o.orderCategory === 'valid') { validCount++; validGmv += o.calcGmv; }
    else if (o.orderCategory === 'pending') { pendingCount++; pendingGmv += o.calcGmv; }

    const groupKey = o.productId
      ? `pid:${o.productId}`
      : `sku:${o.skuVariacao || o.skuPrincipal || o.productName || o.orderId}`;

    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        productId:    o.productId,
        productName:  o.product?.name ?? o.productName ?? '(sem nome)',
        sku:          o.product?.sku ?? o.skuVariacao ?? o.skuPrincipal ?? '',
        variationName: o.variationName ?? null,
        hasCost:      true,
        orderCount:   0,
        qty:          0,
        gmv:          0,
        shopeeFee:    0,
        netRevenue:   0,
        productCost:  0,
        packaging:    0,
        grossProfit:  0,
      });
    }

    const g = groupMap.get(groupKey);
    g.orderCount  += 1;
    g.qty         += o.quantity;
    g.gmv         += o.calcGmv;
    g.shopeeFee   += o.calcShopeeFee;
    g.netRevenue  += o.calcNetRevenue;
    g.productCost += o.calcProductCost;
    g.packaging   += o.calcPackaging;
    g.grossProfit += o.calcGrossProfit;
    if (!o.hasCost) g.hasCost = false;
  }

  const summary = gmv > 0
    ? {
        gmv:          r2(gmv),
        shopeeFee:    r2(shopeeFee),
        netRevenue:   r2(netRevenue),
        tax:          r2(tax),
        productCost:  r2(productCost),
        packaging:    r2(packaging),
        grossProfit:  r2(grossProfit),
        margin:       r2((grossProfit / gmv) * 100),
        validCount,
        pendingCount,
        validGmv:     r2(validGmv),
        pendingGmv:   r2(pendingGmv),
        unitCount,
      }
    : null;

  const groups = [...groupMap.values()]
    .map((g) => ({
      productId:    g.productId,
      productName:  g.productName,
      sku:          g.sku,
      variationName: g.variationName,
      hasCost:      g.hasCost,
      orderCount:   g.orderCount,
      qty:          g.qty,
      gmv:          r2(g.gmv),
      shopeeFee:    r2(g.shopeeFee),
      netRevenue:   r2(g.netRevenue),
      productCost:  r2(g.productCost),
      packaging:    r2(g.packaging),
      grossProfit:  r2(g.grossProfit),
      margin:       g.gmv > 0 ? r2((g.grossProfit / g.gmv) * 100) : 0,
    }))
    .sort((a, b) => b.gmv - a.gmv);

  const orphanCount = groups.filter((g) => !g.hasCost).length;

  return res.json({ summary, groups, orphanCount, month });
}

// GET /api/orders — lista paginada com contagem por aba
async function listOrders(req, res) {
  const { storeId, month, orderCategory, status, search, page = 1, limit = 30 } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);

  const baseWhere = { storeId: { in: storeIds } };

  if (month) {
    const [y, mo] = month.split('-').map(Number);
    baseWhere.soldAt = {
      gte: new Date(Date.UTC(y, mo - 1, 1)),
      lte: new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999)),
    };
  }

  const where = { ...baseWhere };
  if (orderCategory === 'cancelled') {
    where.status = 'cancelled';
  } else if (orderCategory === 'returned') {
    where.status = 'returned';
  } else if (orderCategory) {
    where.orderCategory = orderCategory;
  }
  if (status) where.status = status;

  if (search && search.trim()) {
    const q = search.trim();
    where.OR = [
      { orderId:      { contains: q } },
      { productName:  { contains: q } },
      { skuVariacao:  { contains: q } },
      { skuPrincipal: { contains: q } },
      { product:      { name: { contains: q } } },
      { product:      { sku:  { contains: q } } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const [orders, total, tabGroups, agg, aggCancelled] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { product: { select: { name: true, sku: true } } },
      orderBy: { soldAt: 'desc' },
      skip,
      take,
    }),
    prisma.order.count({ where }),
    prisma.order.groupBy({
      by:    ['orderCategory', 'status'],
      where: baseWhere,
      _count: { _all: true },
    }),
    // Totais financeiros de pedidos com receita (valid + pending + returned_partial)
    prisma.order.aggregate({
      where: { ...baseWhere, orderCategory: { in: ['valid', 'pending', 'returned_partial'] } },
      _sum:  { calcGmv: true, calcShopeeFee: true, calcNetRevenue: true, calcGrossProfit: true, calcTax: true, quantity: true },
      _count: { _all: true },
    }),
    // Totais de cancelados
    prisma.order.aggregate({
      where: { ...baseWhere, status: 'cancelled' },
      _sum:  { calcGmv: true },
      _count: { _all: true },
    }),
  ]);

  const tabCounts = { all: 0, valid: 0, cancelled: 0, returned: 0, pending: 0 };
  for (const g of tabGroups) {
    tabCounts.all += g._count._all;
    if (g.orderCategory === 'valid')   tabCounts.valid     += g._count._all;
    if (g.status === 'cancelled')      tabCounts.cancelled += g._count._all;
    if (g.status === 'returned')       tabCounts.returned  += g._count._all;
    if (g.orderCategory === 'pending') tabCounts.pending   += g._count._all;
  }

  const r2 = (n) => Math.round((n ?? 0) * 100) / 100;
  const gmv        = r2(agg._sum.calcGmv);
  const shopeeFee  = r2(agg._sum.calcShopeeFee);
  const netRevenue = r2(agg._sum.calcNetRevenue);
  const grossProfit= r2(agg._sum.calcGrossProfit);
  const summary = {
    gmv,
    shopeeFee,
    netRevenue,
    grossProfit,
    margin:       gmv > 0 ? r2((grossProfit / gmv) * 100) : 0,
    units:        agg._sum.quantity ?? 0,
    cancelledGmv: r2(aggCancelled._sum.calcGmv),
    cancelledCount: aggCancelled._count._all,
  };

  return res.json({ orders, total, page: parseInt(page), limit: take, tabCounts, summary });
}

// GET /api/orders/:id — detalhe de um pedido
async function getOrder(req, res) {
  const order = await prisma.order.findFirst({
    where:   { id: req.params.id, store: { userId: req.userId } },
    include: {
      store:   { select: { name: true, marketplace: true, taxRate: true } },
      product: true,
    },
  });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  return res.json({ order });
}

// DELETE /api/orders/:id — marca como cancelado
async function deleteOrder(req, res) {
  const order = await prisma.order.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
  });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (order.status === 'cancelled') return res.status(400).json({ error: 'Pedido já cancelado' });

  await prisma.order.update({
    where: { id: order.id },
    data:  { status: 'cancelled', orderCategory: 'cancelled_other' },
  });
  return res.json({ message: 'Pedido cancelado' });
}

// POST /api/orders/recalculate — recalcula diretamente (síncrono, sem job queue)
async function recalculateOrders(req, res) {
  const body    = req.body ?? {};
  const months  = body.months ?? null;
  const all     = body.all ?? false;
  const { calcOrderProfit } = require('../services/calculatorService');

  const storeWhere = { userId: req.userId };
  const whereOrder = { store: storeWhere };

  if (!all && Array.isArray(months) && months.length) {
    const [y, mo] = months[0].split('-').map(Number);
    whereOrder.soldAt = {
      gte: new Date(Date.UTC(y, mo - 1, 1)),
      lte: new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999)),
    };
  } else if (!all) {
    const now = new Date();
    whereOrder.soldAt = {
      gte: new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)),
      lte: new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)),
    };
  }

  const orders = await prisma.order.findMany({
    where: whereOrder,
    include: {
      store:   { select: { taxRate: true, marketplace: true } },
      product: { select: { costPrice: true, packaging: true } },
    },
  });

  const r2 = (n) => Math.round((n ?? 0) * 100) / 100;
  const BATCH = 200;
  const updates = [];

  for (const order of orders) {
    const marketplace    = order.store?.marketplace ?? 'shopee';
    const taxRate        = order.store?.taxRate ?? 0;
    const mlFrete        = order.mlShippingCost ?? 0;
    const precomputedFee = marketplace === 'mercadolivre'
      ? r2((order.shopeeCommission ?? 0) + mlFrete)
      : null;

    const calc = calcOrderProfit({
      agreedPrice:   order.agreedPrice,
      quantity:      order.quantity,
      sellerCoupon:  order.sellerCoupon,
      lmmDiscount:   order.lmmDiscount,
      costPrice:     order.product?.costPrice ?? 0,
      packagingCost: order.product?.packaging ?? 0,
      taxRate,
      marketplace,
      precomputedFee,
      listingType:   order.listingType,
    });

    const isRevenue   = ['valid', 'pending', 'returned_partial'].includes(order.orderCategory);
    const finalProfit = isRevenue ? calc.grossProfit : 0;
    const finalMargin = isRevenue ? calc.margin      : 0;

    updates.push(prisma.order.update({
      where: { id: order.id },
      data: {
        calcGmv:         calc.gmv,
        calcShopeeFee:   calc.marketplaceFee,
        calcNetRevenue:  calc.netRevenue,
        calcTax:         calc.taxAmount,
        calcProductCost: calc.productCost,
        calcPackaging:   calc.packaging,
        calcGrossProfit: finalProfit,
        calcMargin:      finalMargin,
        hasCost:         calc.hasCost,
        profit:          finalProfit,
        margin:          finalMargin,
        snapshotTaxRate: taxRate,
      },
    }));
  }

  // Salvar em batches
  for (let i = 0; i < updates.length; i += BATCH) {
    await Promise.all(updates.slice(i, i + BATCH));
  }

  return res.json({ success: true, updated: updates.length, months: months ?? 'current' });
}

// GET /api/orders/recalculate/:jobId — polling do job de recálculo
async function recalculateStatus(req, res) {
  const jobId = req.params.jobId;
  const prog  = recalcProgress.get(jobId);
  if (!prog) return res.status(404).json({ error: 'Job nao encontrado' });

  return res.json({
    jobId,
    status:  prog.status  ?? 'active',
    pct:     prog.pct     ?? 0,
    message: prog.message ?? '',
    result:  prog.result  ?? null,
    error:   prog.error   ?? null,
  });
}

// GET /api/orders/export — CSV
async function exportOrders(req, res) {
  const { storeId, month, orderCategory, status } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);

  const where = { storeId: { in: storeIds } };
  if (month) {
    const [y, mo] = month.split('-').map(Number);
    where.soldAt = {
      gte: new Date(Date.UTC(y, mo - 1, 1)),
      lte: new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999)),
    };
  }
  if (orderCategory === 'cancelled') {
    where.status = 'cancelled';
  } else if (orderCategory === 'returned') {
    where.status = 'returned';
  } else if (orderCategory) {
    where.orderCategory = orderCategory;
  }
  if (status) where.status = status;

  const orders = await prisma.order.findMany({
    where,
    include: { product: { select: { name: true, sku: true } } },
    orderBy: { soldAt: 'desc' },
  });

  const header = ['Data', 'Nº Pedido', 'SKU', 'Produto', 'Qtd', 'Preço Acordado', 'GMV', 'Taxa Shopee', 'Lucro Bruto', 'Margem (%)', 'Categoria'];

  const catLabel = {
    valid: 'Faturado', pending: 'Pendente',
    cancelled_unpaid: 'Cancelado (Não pago)', cancelled_other: 'Cancelado',
    returned_full: 'Devolvido (total)', returned_partial: 'Devolvido (parcial)',
  };

  const rows = orders.map((o) => {
    const date = o.soldAt ? new Date(o.soldAt).toLocaleDateString('pt-BR') : '';
    const sku  = o.product?.sku ?? o.skuVariacao ?? o.skuPrincipal ?? '';
    const name = o.product?.name ?? o.productName ?? '';
    return [
      date, o.orderId, sku, name, o.quantity,
      o.agreedPrice.toFixed(2).replace('.', ','),
      o.calcGmv.toFixed(2).replace('.', ','),
      o.calcShopeeFee.toFixed(2).replace('.', ','),
      o.calcGrossProfit.toFixed(2).replace('.', ','),
      o.calcMargin.toFixed(1).replace('.', ','),
      catLabel[o.orderCategory] ?? o.orderCategory,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';');
  });

  const csv = [header.join(';'), ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pedidos.csv"');
  res.send('﻿' + csv);
}

// GET /api/orders/sku-report — performance e inteligência de estoque por produto
async function skuReport(req, res) {
  const { storeId, startDate, endDate } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return res.json({ products: [], totals: { qty: 0, revenue: 0, profit: 0 } });

  const where = {
    storeId:       { in: storeIds },
    orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
    productId:     { not: null },
  };
  if (startDate || endDate) {
    where.soldAt = {};
    if (startDate) where.soldAt.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      where.soldAt.lte = end;
    }
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [orders, productsStock, orders30, lastPurchases] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        productId:       true,
        quantity:        true,
        calcGmv:         true,
        calcGrossProfit: true,
      },
    }),
    prisma.product.findMany({
      where:  { storeId: { in: storeIds } },
      select: { id: true, name: true, sku: true, stock: true, minStock: true },
    }),
    prisma.order.findMany({
      where: {
        storeId:       { in: storeIds },
        productId:     { not: null },
        orderCategory: { in: ['valid', 'pending', 'returned_partial'] },
        soldAt:        { gte: thirtyDaysAgo },
      },
      select: { productId: true, quantity: true },
    }),
    prisma.purchaseOrderItem.findMany({
      where:   { purchaseOrder: { userId: req.userId, status: 'received' } },
      select:  { productId: true, purchaseOrder: { select: { receivedAt: true } } },
      orderBy: { purchaseOrder: { receivedAt: 'desc' } },
    }),
  ]);

  const map = new Map();
  for (const o of orders) {
    if (!o.productId) continue;
    if (!map.has(o.productId)) {
      map.set(o.productId, { productId: o.productId, totalQty: 0, totalGmv: 0, totalProfit: 0, orderCount: 0 });
    }
    const r = map.get(o.productId);
    r.totalQty    += o.quantity;
    r.totalGmv    += o.calcGmv;
    r.totalProfit += o.calcGrossProfit;
    r.orderCount  += 1;
  }

  const stockByPid   = Object.fromEntries(productsStock.map((p) => [p.id, p]));
  const sales30ByPid = {};
  for (const o of orders30) {
    if (!o.productId) continue;
    sales30ByPid[o.productId] = (sales30ByPid[o.productId] ?? 0) + o.quantity;
  }

  const products = [...map.values()].map((r) => {
    const p           = stockByPid[r.productId];
    const sales30     = sales30ByPid[r.productId] ?? 0;
    const salesPerDay = sales30 / 30;
    const daysRem     = salesPerDay > 0 ? (p?.stock ?? 0) / salesPerDay : null;
    const suggested   = salesPerDay > 0 ? Math.max(0, Math.round(salesPerDay * 60 - (p?.stock ?? 0))) : 0;
    return {
      productId:        r.productId,
      name:             p?.name   ?? '',
      sku:              p?.sku    ?? '',
      totalQty:         r.totalQty,
      totalRevenue:     parseFloat(r.totalGmv.toFixed(2)),
      totalProfit:      parseFloat(r.totalProfit.toFixed(2)),
      avgMargin:        r.totalGmv > 0 ? parseFloat(((r.totalProfit / r.totalGmv) * 100).toFixed(1)) : 0,
      orderCount:       r.orderCount,
      stock:            p?.stock    ?? 0,
      minStock:         p?.minStock ?? 5,
      salesLast30:      sales30,
      salesPerDay:      parseFloat(salesPerDay.toFixed(2)),
      daysRemaining:    daysRem !== null ? parseFloat(daysRem.toFixed(1)) : null,
      suggestedReorder: suggested,
    };
  }).sort((a, b) => b.totalRevenue - a.totalRevenue);

  const totals = products.reduce(
    (s, p) => ({ qty: s.qty + p.totalQty, revenue: s.revenue + p.totalRevenue, profit: s.profit + p.totalProfit }),
    { qty: 0, revenue: 0, profit: 0 },
  );

  return res.json({ products, totals });
}

module.exports = {
  importOrders, importStatus, getClosing, listOrders, getOrder, deleteOrder,
  recalculateOrders, recalculateStatus, exportOrders, skuReport,
};
