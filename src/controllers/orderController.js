const fs    = require('fs');
const prisma = require('../lib/prisma');
const { recalculateQueue, recalcProgress } = require('../services/recalculateQueue');
const { recalculateOrdersForStore }       = require('../services/recalculateService');
const { importShopeeOrderAll } = require('../services/importOrderAll');
const { importSheinOrderAll }  = require('../services/importSheinService');
const { importTiktokOrderAll } = require('../services/importTiktokService');
const { importProgress } = require('../lib/importProgress');
const { r2, parsePage, parseYearMonth } = require('../lib/utils');

const PROCESSING_STALE_MS = 12 * 60 * 1000;
const REVENUE_ORDER_CATEGORIES = ['valid', 'pending', 'returned_partial'];
const APP_TIMEZONE = 'America/Sao_Paulo';

function saoPauloDateToUtc(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute, second, millisecond));
}

function parseYmd(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const [year, month, day] = String(value).split('-').map(Number);
  return { year, month, day };
}

function buildDateRange(startDate, endDate) {
  if (!startDate && !endDate) return null;
  const startParts = parseYmd(startDate) ?? parseYmd(endDate);
  const endParts = parseYmd(endDate) ?? parseYmd(startDate);
  if (!startParts || !endParts) return null;
  return {
    start: saoPauloDateToUtc(startParts.year, startParts.month, startParts.day),
    end: saoPauloDateToUtc(endParts.year, endParts.month, endParts.day, 23, 59, 59, 999),
    timezone: APP_TIMEZONE,
  };
}

function getOrderUniqueKey(order) {
  return order.orderId || order.id;
}

function isConfirmedRepasse(order, marketplace) {
  if (order.orderCategory !== 'valid') return false;
  if (String(marketplace ?? '').toLowerCase() === 'shopee') {
    return order.escrowAmount !== null && order.escrowAmount !== undefined;
  }
  return true;
}

function calcOrderFinancials(order, taxRate = 0, marketplace = 'shopee') {
  const gmv = r2(order.calcGmv ?? order.salePrice ?? 0);
  const rawFee = r2((order.platformCommission ?? 0) + (order.platformServiceFee ?? 0));
  const fee = rawFee > 0 ? rawFee : r2(order.calcShopeeFee ?? 0);
  const discount = r2((order.sellerCoupon ?? 0) + (order.lmmDiscount ?? 0));
  const confirmed = isConfirmedRepasse(order, marketplace);
  const fallbackNet = r2(gmv - fee - discount);
  const netRevenue = confirmed && order.escrowAmount !== null && order.escrowAmount !== undefined
    ? r2(order.escrowAmount)
    : r2(order.calcNetRevenue ?? fallbackNet);
  const tax = order.calcTax !== null && order.calcTax !== undefined
    ? r2(order.calcTax)
    : r2(gmv * taxRate / 100);
  const cost = r2((order.calcProductCost ?? 0) + (order.calcPackaging ?? 0));
  const profit = confirmed
    ? r2(netRevenue - tax - cost)
    : r2(order.calcGrossProfit ?? (netRevenue - tax - cost));
  const margin = netRevenue > 0 ? r2((profit / netRevenue) * 100) : 0;

  return { gmv, fee, netRevenue, tax, profit, margin, confirmed };
}

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
  if (imp.status === 'processing' && !progress && imp.importedAt && Date.now() - new Date(imp.importedAt).getTime() > PROCESSING_STALE_MS) {
    await prisma.import.update({
      where: { id: importId },
      data: { status: 'error', errorMessage: 'Sincronização interrompida antes de concluir. Tente novamente.' },
    }).catch(() => {});
    return res.json({ jobId: importId, status: 'error', error: 'Sincronização interrompida antes de concluir. Tente novamente.' });
  }

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
        skipped:     imp.skippedCount ?? 0,
        newProducts: imp.newProductCount ?? 0,
        gmv:         imp.gmv ?? 0,
        netRevenue:  imp.netRevenue ?? 0,
        grossProfit: imp.grossProfit ?? 0,
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

// GET /api/orders — lista paginada com contagem por aba
async function listOrders(req, res) {
  const { storeId, month, startDate, endDate, orderCategory, status, search, page = 1, limit = 30 } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds = stores.map((s) => s.id);

  const storeFilter = { storeId: { in: storeIds } };

  const dateRange = buildDateRange(startDate, endDate);
  let createdDateFilter = {};
  let paidDateFilter = {};
  if (dateRange) {
    createdDateFilter = {
      soldAt: {
        gte: dateRange.start,
        lte: dateRange.end,
      },
    };
    paidDateFilter = {
      orderPaidAt: {
        gte: dateRange.start,
        lte: dateRange.end,
      },
    };
  } else if (month) {
    const { year: y, month: mo } = parseYearMonth(month);
    createdDateFilter = {
      soldAt: {
        gte: new Date(Date.UTC(y, mo - 1, 1)),
        lte: new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999)),
      },
    };
    paidDateFilter = {
      orderPaidAt: {
        gte: new Date(Date.UTC(y, mo - 1, 1)),
        lte: new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999)),
      },
    };
  }

  const createdBaseWhere = { ...storeFilter, ...createdDateFilter };
  const revenueBaseWhere = { ...storeFilter, ...paidDateFilter };
  const realBuyerFilter = { NOT: [{ buyerUsername: null }, { buyerUsername: '-' }] };
  const paidCancelledWhere = {
    ...revenueBaseWhere,
    ...realBuyerFilter,
    status: 'cancelled',
    orderCategory: 'cancelled_other',
  };

  let where = { ...createdBaseWhere };
  if (['valid', 'pending'].includes(orderCategory)) {
    where = { ...revenueBaseWhere, orderCategory };
  } else if (orderCategory === 'returned') {
    where = { ...revenueBaseWhere, status: 'returned' };
  } else if (orderCategory === 'cancelled') {
    where = paidCancelledWhere;
  } else if (orderCategory) {
    where = { ...revenueBaseWhere, orderCategory };
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

  const { skip, take } = parsePage(page, limit);

  // Mapa de alíquota por loja — imposto sempre sobre GMV bruto (Simples Nacional)
  const taxStores = await prisma.store.findMany({
    where: { id: { in: storeIds } }, select: { id: true, taxRate: true, marketplace: true },
  });
  const taxRateMap = new Map(taxStores.map((s) => [s.id, s.taxRate ?? 0]));
  const marketplaceMap = new Map(taxStores.map((s) => [s.id, s.marketplace ?? 'shopee']));

  const [orders, totalRows, tabAll, tabValid, tabPending, tabCancelledRows, tabReturned, revenueOrders, aggCancelled, orphanCount] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { product: { select: { name: true, sku: true } } },
      orderBy: { soldAt: 'desc' },
      skip,
      take,
    }),
    prisma.order.count({ where }),
    prisma.order.count({ where: createdBaseWhere }),
    prisma.order.count({ where: { ...revenueBaseWhere, orderCategory: 'valid' } }),
    prisma.order.count({ where: { ...revenueBaseWhere, orderCategory: 'pending' } }),
    prisma.order.findMany({ where: paidCancelledWhere, distinct: ['orderId'], select: { orderId: true } }),
    prisma.order.count({ where: { ...revenueBaseWhere, status: 'returned' } }),
    // Totais financeiros pela lógica Upseller: vendas válidas entram pelo pagamento/validação.
    prisma.order.findMany({
      where: { ...revenueBaseWhere, orderCategory: { in: ['valid', 'pending'] } },
      select: {
        id: true, storeId: true, orderId: true, orderCategory: true, calcGmv: true, salePrice: true, quantity: true,
        platformCommission: true, platformServiceFee: true,
        sellerCoupon: true, lmmDiscount: true, escrowAmount: true,
        calcProductCost: true, calcPackaging: true, calcShopeeFee: true,
        calcNetRevenue: true, calcGrossProfit: true, calcTax: true,
      },
    }),
    // Totais de cancelados
    prisma.order.aggregate({
      where: paidCancelledWhere,
      _sum:  { calcGmv: true },
      _count: { _all: true },
    }),
    // Pedidos com receita mas sem custo de produto cadastrado
    prisma.order.count({
      where: { ...revenueBaseWhere, orderCategory: { in: ['valid', 'pending', 'returned_partial'] }, hasCost: false },
    }),
  ]);
  const tabCancelled = tabCancelledRows.length;
  const total = orderCategory === 'cancelled' ? tabCancelled : totalRows;

  const tabCounts = {
    all: tabAll,
    valid: tabValid,
    cancelled: tabCancelled,
    returned: tabReturned,
    pending: tabPending,
  };

  // Recompute financeiro com a cadeia canônica:
  // repasse confirmado quando existe escrow; enquanto não existe, usa calc* recalculado.
  let gmv = 0, shopeeFee = 0, netRevenue = 0, grossProfit = 0, units = 0;
  let confirmedNetRevenue = 0, confirmedGrossProfit = 0, estimatedNetRevenue = 0, estimatedGrossProfit = 0;
  const confirmedRepasseIds = new Set();
  const awaitingRepasseIds = new Set();
  for (const o of revenueOrders) {
    const fin = calcOrderFinancials(o, taxRateMap.get(o.storeId) ?? 0, marketplaceMap.get(o.storeId));
    const orderKey = getOrderUniqueKey(o);
    gmv         += fin.gmv;
    shopeeFee   += fin.fee;
    netRevenue  += fin.netRevenue;
    grossProfit += fin.profit;
    units       += o.quantity ?? 0;
    if (fin.confirmed) {
      confirmedNetRevenue += fin.netRevenue;
      confirmedGrossProfit += fin.profit;
      if (orderKey) confirmedRepasseIds.add(orderKey);
    } else {
      estimatedNetRevenue += fin.netRevenue;
      estimatedGrossProfit += fin.profit;
      if (orderKey) awaitingRepasseIds.add(orderKey);
    }
  }
  gmv = r2(gmv); shopeeFee = r2(shopeeFee); netRevenue = r2(netRevenue); grossProfit = r2(grossProfit);
  confirmedNetRevenue = r2(confirmedNetRevenue);
  confirmedGrossProfit = r2(confirmedGrossProfit);
  estimatedNetRevenue = r2(estimatedNetRevenue);
  estimatedGrossProfit = r2(estimatedGrossProfit);

  const summary = {
    gmv,
    shopeeFee,
    netRevenue,
    grossProfit,
    confirmedNetRevenue,
    confirmedGrossProfit,
    confirmedProfit: confirmedGrossProfit,
    confirmedRepasse: confirmedNetRevenue,
    estimatedNetRevenue,
    estimatedGrossProfit,
    estimatedProfit: estimatedGrossProfit,
    estimatedRepasse: estimatedNetRevenue,
    confirmedRepasseOrders: confirmedRepasseIds.size,
    awaitingRepasseOrders: awaitingRepasseIds.size,
    margin:       netRevenue > 0 ? r2((grossProfit / netRevenue) * 100) : 0,
    units,
    cancelledGmv: r2(aggCancelled._sum.calcGmv),
    cancelledCount: aggCancelled._count._all,
  };

  // Recompute dos campos calc* exibidos na tabela/detalhe, a partir do RAW —
  // mantém cada linha consistente com o Fechamento Mensal e com o summary acima.
  const ordersOut = orders.map((o) => {
    const hasRevenue = REVENUE_ORDER_CATEGORIES.includes(o.orderCategory);
    if (!hasRevenue) return o;
    const fin = calcOrderFinancials(o, taxRateMap.get(o.storeId) ?? 0, marketplaceMap.get(o.storeId));
    return {
      ...o,
      calcShopeeFee:   fin.fee,
      calcNetRevenue:  fin.netRevenue,
      calcTax:         fin.tax,
      calcGrossProfit: fin.profit,
      calcMargin:      fin.margin,
      repasseStatus:   fin.confirmed ? 'confirmed' : 'estimated',
    };
  });

  return res.json({ orders: ordersOut, total, page: parseInt(page), limit: take, tabCounts, summary, orphanCount });
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
  const body   = req.body ?? {};
  const months = body.months ?? null;
  const all    = body.all ?? false;

  const storeWhere = { userId: req.userId };
  const stores     = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
  const storeIds   = stores.map((s) => s.id);
  if (!storeIds.length) return res.json({ success: true, updated: 0, months: months ?? 'current' });

  // Resolve the target period (null = all orders, no date filter)
  let periodMonth = null;
  if (!all) {
    if (Array.isArray(months) && months.length) {
      periodMonth = months[0];
    } else {
      const now = new Date();
      periodMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }
  }

  let total = 0;
  for (const sid of storeIds) {
    total += await recalculateOrdersForStore(sid, periodMonth);
  }

  return res.json({ success: true, updated: total, months: months ?? 'current' });
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
    const { year: y, month: mo } = parseYearMonth(month);
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

  // Mapa de alíquota por loja — imposto sempre sobre GMV bruto (Simples Nacional)
  const taxStores  = await prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, taxRate: true } });
  const taxRateMap = new Map(taxStores.map((s) => [s.id, s.taxRate ?? 0]));

  const EXPORT_LIMIT = 10_000;
  const orders = await prisma.order.findMany({
    where,
    include: { product: { select: { name: true, sku: true } } },
    orderBy: { soldAt: 'desc' },
    take: EXPORT_LIMIT + 1,  // +1 para detectar truncagem
  });

  const truncated = orders.length > EXPORT_LIMIT;
  if (truncated) orders.length = EXPORT_LIMIT;

  // "Lucro Líquido": calcGrossProfit já subtrai imposto, taxas, custo e embalagem — não é "bruto"
  const header = ['Data', 'Nº Pedido', 'SKU', 'Produto', 'Qtd', 'Preço Acordado', 'GMV', 'Taxa Shopee', 'Lucro Líquido', 'Margem (%)', 'Categoria'];

  const catLabel = {
    valid: 'Faturado', pending: 'Pendente',
    cancelled_unpaid: 'Cancelado (Não pago)', cancelled_other: 'Cancelado',
    returned_full: 'Devolvido (total)', returned_partial: 'Devolvido (parcial)',
  };

  // Recomputa taxa/lucro/margem do RAW — mantém CSV consistente com a tela (listOrders)
  const rows = orders.map((o) => {
    const date = o.soldAt ? new Date(o.soldAt).toLocaleDateString('pt-BR') : '';
    const sku  = o.product?.sku ?? o.skuVariacao ?? o.skuPrincipal ?? '';
    const name = o.product?.name ?? o.productName ?? '';

    const hasRevenue = ['valid', 'pending', 'returned_partial'].includes(o.orderCategory);
    let orderFee = 0;
    let profit   = 0;
    let margin   = 0;

    if (hasRevenue) {
      const isConfirmed = o.orderCategory === 'valid';
      orderFee          = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
      const orderDisc   = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
      const orderNet    = r2((o.calcGmv ?? 0) - orderFee - orderDisc);
      const repasse     = isConfirmed ? r2(o.escrowAmount ?? orderNet) : orderNet;
      const orderTax    = r2((o.calcGmv ?? 0) * (taxRateMap.get(o.storeId) ?? 0) / 100);
      profit            = r2(repasse - orderTax - (o.calcProductCost ?? 0) - (o.calcPackaging ?? 0));
      margin            = repasse > 0 ? r2((profit / repasse) * 100) : 0;
    }

    return [
      date, o.orderId, sku, name, o.quantity,
      o.agreedPrice.toFixed(2).replace('.', ','),
      o.calcGmv.toFixed(2).replace('.', ','),
      orderFee.toFixed(2).replace('.', ','),
      profit.toFixed(2).replace('.', ','),
      margin.toFixed(1).replace('.', ','),
      catLabel[o.orderCategory] ?? o.orderCategory,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';');
  });

  const warningRows = truncated
    ? [`"AVISO: exportação limitada a ${EXPORT_LIMIT.toLocaleString('pt-BR')} registros. Use filtro por mês para exportar períodos menores."`]
    : [];

  const csv = [header.join(';'), ...warningRows, ...rows].join('\r\n');
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
      where:   { purchaseOrder: { userId: req.userId, status: 'delivered' } },
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

async function importSheinOrders(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Arquivo .xlsx obrigatório' });
  const { storeId } = req.body;
  if (!storeId) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'storeId obrigatório' });
  }

  const imp = await prisma.import.create({
    data: { storeId, filename: req.file.originalname, periodMonth: '0000-00', totalRows: 0, status: 'processing' },
  });

  importProgress.set(imp.id, { pct: 2, message: 'Iniciando...' });

  setImmediate(async () => {
    try {
      await importSheinOrderAll(
        req.file.path,
        storeId,
        req.userId,
        req.file.originalname,
        (progress) => importProgress.set(imp.id, progress),
        imp.id,
      );
    } catch (err) {
      console.error('[import-shein] erro:', err.message);
      await prisma.import.update({
        where: { id: imp.id },
        data:  { status: 'error', errorMessage: err.message },
      }).catch(() => {});
    } finally {
      importProgress.delete(imp.id);
      try { fs.unlinkSync(req.file.path); } catch {}
    }
  });

  return res.status(202).json({ jobId: imp.id });
}

async function importTiktokOrders(req, res) {
  if (!req.file) return res.status(400).json({ error: 'Arquivo .csv obrigatório' });
  const { storeId } = req.body;
  if (!storeId) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'storeId obrigatório' });
  }

  const imp = await prisma.import.create({
    data: { storeId, filename: req.file.originalname, periodMonth: '0000-00', totalRows: 0, status: 'processing' },
  });

  importProgress.set(imp.id, { pct: 2, message: 'Iniciando...' });

  setImmediate(async () => {
    try {
      await importTiktokOrderAll(
        req.file.path,
        storeId,
        req.userId,
        req.file.originalname,
        (progress) => importProgress.set(imp.id, progress),
        imp.id,
      );
    } catch (err) {
      console.error('[import-tiktok] erro:', err.message);
      await prisma.import.update({
        where: { id: imp.id },
        data:  { status: 'error', errorMessage: err.message },
      }).catch(() => {});
    } finally {
      importProgress.delete(imp.id);
      try { fs.unlinkSync(req.file.path); } catch {}
    }
  });

  return res.status(202).json({ jobId: imp.id });
}

module.exports = {
  importOrders, importStatus, importSheinOrders, importTiktokOrders,
  listOrders, getOrder, deleteOrder,
  recalculateOrders, recalculateStatus, exportOrders, skuReport,
};
