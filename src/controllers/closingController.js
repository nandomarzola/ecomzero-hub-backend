const prisma      = require('../lib/prisma');
const PDFDocument = require('pdfkit');

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

function fmtBRL(n) {
  const abs = Math.abs(n ?? 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return 'R$ ' + abs;
}

function fmtPct(n) { return (n ?? 0).toFixed(1) + '%'; }

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Resolve fonte/alíquota/DAS para exibição no fechamento
function computeTaxInfo(monthlyTax, taxAmount, gmvTotal) {
  const fonte = monthlyTax?.effectiveRate != null ? 'das_real' : 'estimada';
  const aliquota = fonte === 'das_real'
    ? monthlyTax.effectiveRate
    : (gmvTotal > 0 ? r2((taxAmount / gmvTotal) * 100) : 0);
  return {
    fonte,
    aliquota,
    dasAmount: monthlyTax?.dasAmount ?? null,
    totalRevenue: monthlyTax?.totalRevenue ?? null,
  };
}

// Soma um campo numérico através dos grupos de produto de um snapshot salvo
function sumGroupField(snap, field) {
  if (!Array.isArray(snap)) return 0;
  return r2(snap.reduce((sum, g) => sum + (g[field] ?? 0), 0));
}

// Reconstrói o objeto de dados completo (incl. campos do novo modelo de repasse/imposto)
// a partir de um MonthlyClosing salvo + DAS atual. taxInfo é sempre recalculado ao vivo,
// pois a DAS pode ter sido informada depois do fechamento.
function snapshotToClosingData(closing, monthlyTax) {
  const snap = closing.productsSnapshot ?? [];

  // Snapshots gerados antes da refatoração do fechamento não têm os campos de repasse/imposto por grupo
  const hasNewFields = Array.isArray(snap) && snap.some(g => g.impostoTotal != null);

  const repasseConfirmado = hasNewFields ? sumGroupField(snap, 'repasseConfirmado') : closing.netRevenue;
  const repasseEstimado   = hasNewFields ? sumGroupField(snap, 'repasseEstimado')   : 0;
  const repasseTotal      = r2(repasseConfirmado + repasseEstimado);
  const impostoTotal      = hasNewFields ? sumGroupField(snap, 'impostoTotal') : closing.taxAmount;
  const custoTotal        = r2(closing.productCost + closing.packagingCost);
  const resultadoLiquido  = hasNewFields
    ? r2(repasseTotal - impostoTotal - custoTotal - closing.fixedTaxAmount)
    : closing.grossProfit;
  const margem = repasseTotal > 0 ? r2((resultadoLiquido / repasseTotal) * 100) : closing.avgMargin;

  return {
    totalOrders:      closing.totalOrders,
    confirmedOrders:  closing.confirmedOrders,
    pendingOrders:    closing.pendingOrders,
    cancelledOrders:  closing.cancelledOrders,
    returnedOrders:   closing.returnedOrders,
    unitCount:        closing.unitCount,
    gmvTotal:         closing.gmvTotal,
    gmvConfirmed:     closing.gmvConfirmed,
    gmvPending:       closing.gmvPending,
    shopeeDeductions: closing.shopeeDeductions,
    sellerDiscounts:  closing.sellerDiscounts,
    netRevenue:       closing.netRevenue,
    taxAmount:        closing.taxAmount,
    fixedTaxAmount:   closing.fixedTaxAmount,
    productCost:      closing.productCost,
    packagingCost:    closing.packagingCost,
    grossProfit:      closing.grossProfit,
    avgMargin:        closing.avgMargin,
    cancelledGmv:     closing.cancelledGmv,
    returnedValue:    closing.returnedValue,
    orphanCount:      Array.isArray(snap) ? snap.filter(g => !g.hasCost).length : 0,
    taxInfo:          computeTaxInfo(monthlyTax, impostoTotal, closing.gmvTotal),

    repasseConfirmado,
    repasseEstimado,
    repasseTotal,
    impostoTotal,
    custoTotal,
    resultadoLiquido,
    margem,
    pendentes: {
      count: closing.pendingOrders,
      gmv: closing.gmvPending,
      estimatedRepasse: repasseEstimado,
    },

    // Snapshots de meses fechados nao guardam as listas individuais de pedidos —
    // drawers ficam vazios nesse caso
    returnedOrdersList:  [],
    cancelledOrdersList: [],
    pendingOrdersList:   [],

    groups: Array.isArray(snap) ? snap : [],
  };
}

function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('pt-BR') + ' as ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
}

// PDF pure helpers (no doc dependency)
function fmtBRLpdf(v) {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v ?? 0);
  const str = abs.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return v < 0 ? `-R$ ${str}` : `R$ ${str}`;
}
function trunc(str, max = 46) {
  const s = String(str || '');
  return s.length > max ? s.substring(0, max) + '...' : s;
}

// Shared doc-bound helpers factory
function makeH(doc, ML = 42, MR = 553) {
  return {
    ds:    (x, y, txt)          => doc.text(String(txt), x, y, { lineBreak: false }),
    drs:   (rx, y, txt, w = 200) => doc.text(String(txt), rx - w, y, { width: w, align: 'right', lineBreak: false }),
    sep:   (y, lw = 0.5)        => doc.moveTo(ML, y).lineTo(MR, y).lineWidth(lw).strokeColor('black').stroke(),
    fc:    (r, g, b)            => doc.fillColor([r, g, b]),
    black: ()                   => doc.fillColor('black'),
  };
}

// ── Core: compute monthly data ─────────────────────────────────────────────────
async function buildClosingData(storeIds, month, userId = null) {
  const [y, mo] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, mo - 1, 1));
  const end   = new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999));

  const stores = await prisma.store.findMany({
    where:  { id: { in: storeIds } },
    select: { id: true, taxType: true, taxRate: true, fixedMonthlyTax: true },
  });
  const fixedTaxAmount = r2(stores
    .filter(s => s.taxType === 'mei')
    .reduce((sum, s) => sum + (s.fixedMonthlyTax ?? 0), 0));
  const storeTaxRateMap = new Map(stores.map(s => [s.id, s.taxRate ?? 0]));

  // DAS mensal informada pelo usuário (alíquota efetiva real) — fallback p/ taxRate da loja
  const monthlyTax = userId
    ? await prisma.monthlyTax.findUnique({ where: { userId_month: { userId, month } } })
    : null;
  const taxFonte = monthlyTax?.effectiveRate != null ? 'das_real' : 'estimada';

  const allOrders = await prisma.order.findMany({
    where: { storeId: { in: storeIds }, soldAt: { gte: start, lte: end } },
    include: {
      product: { select: { id: true, name: true, sku: true } },
      variant: { select: { id: true, name: true, sku: true } },
    },
  });

  let gmvTotal = 0, gmvConfirmed = 0, gmvPending = 0;
  let shopeeDeductions = 0, sellerDiscounts = 0, netRevenue = 0;
  let taxAmount = 0, productCost = 0, packagingCost = 0, grossProfit = 0;
  let repasseConfirmado = 0, repasseEstimado = 0;
  let cancelledGmv = 0, returnedValue = 0;
  let unitCount = 0;
  let confirmedCount = 0, pendingCount = 0, cancelledCount = 0, returnedCount = 0;

  const groupMap = new Map();

  // Listas para os drawers do frontend (devolucoes, cancelamentos, pendentes)
  const returnedOrdersList  = [];
  const cancelledOrdersList = [];
  const pendingOrdersList   = [];

  for (const o of allOrders) {
    const isConfirmed = o.orderCategory === 'valid';
    const isPending   = o.orderCategory === 'pending';
    const isRevenue   = isConfirmed || isPending;
    const isCancelled = o.orderCategory.startsWith('cancelled');
    const isReturned  = o.orderCategory === 'returned_full' || o.orderCategory === 'returned_partial';

    // Taxa real = comissão + taxa de serviço (escrow), não a estimativa em calcShopeeFee
    // (que pode estar divergente por causa de um recálculo antigo)
    const orderFee    = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
    const orderDisc   = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
    const orderNet    = r2(o.calcGmv - orderFee - orderDisc);

    // Repasse: confirmado usa escrowAmount real (Shopee); pending usa estimativa (gmv - taxas - descontos)
    const orderRepasse = isConfirmed ? r2(o.escrowAmount ?? orderNet) : orderNet;

    // Imposto: sobre o faturamento bruto (calcGmv) — não desconta voucher Shopee da base
    const aliquotaOrder = taxFonte === 'das_real' ? monthlyTax.effectiveRate : (storeTaxRateMap.get(o.storeId) ?? 0);
    const orderTax      = r2((o.calcGmv ?? 0) * aliquotaOrder / 100);

    const orderProfit = r2(orderRepasse - orderTax - o.calcProductCost - o.calcPackaging);

    if (isConfirmed)      confirmedCount++;
    else if (isPending)   pendingCount++;
    else if (isCancelled) cancelledCount++;
    if (isReturned)       returnedCount++;

    if (isCancelled) {
      cancelledOrdersList.push({
        id:            o.id,
        orderId:       o.orderId,
        soldAt:        o.soldAt,
        productName:   o.productName,
        variationName: o.variationName,
        calcGmv:       r2(o.calcGmv),
        cancelReason:  o.cancelReason ?? null,
      });
    }
    if (isReturned) {
      returnedOrdersList.push({
        id:            o.id,
        orderId:       o.orderId,
        soldAt:        o.soldAt,
        productName:   o.productName,
        variationName: o.variationName,
        calcGmv:       r2(o.calcGmv),
        escrowAmount:  o.escrowAmount,
        orderCategory: o.orderCategory,
        returnStatus:  o.returnStatus ?? null,
      });
    }
    if (isPending) {
      pendingOrdersList.push({
        id:               o.id,
        orderId:          o.orderId,
        soldAt:           o.soldAt,
        productName:      o.productName,
        variationName:    o.variationName,
        calcGmv:          r2(o.calcGmv),
        estimatedRepasse: orderRepasse,
      });
    }

    if (isRevenue) {
      gmvTotal         += o.calcGmv;
      shopeeDeductions += orderFee;
      sellerDiscounts  += orderDisc;
      netRevenue       += orderNet;
      taxAmount        += orderTax;
      productCost      += o.calcProductCost;
      packagingCost    += o.calcPackaging;
      grossProfit      += orderProfit;
      unitCount        += o.quantity;
      if (isConfirmed) { gmvConfirmed += o.calcGmv; repasseConfirmado += orderRepasse; }
      if (isPending)   { gmvPending   += o.calcGmv; repasseEstimado   += orderRepasse; }
    }
    if (isCancelled) cancelledGmv += o.calcGmv;
    if (isReturned)  returnedValue += o.calcGmv;

    if (isRevenue) {
      const key = o.productId
        ? `pid:${o.productId}`
        : `sku:${o.skuVariacao || o.skuPrincipal || o.productName || o.orderId}`;

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          productId: o.productId,
          productName: o.product?.name ?? o.productName ?? '(sem nome)',
          sku: o.product?.sku ?? o.skuVariacao ?? o.skuPrincipal ?? '',
          variationName: o.variationName ?? null,
          hasCost: true, hasPending: false,
          orderCount: 0, qty: 0,
          gmv: 0, shopeeFee: 0, netRevenue: 0,
          productCost: 0, packaging: 0, grossProfit: 0,
          repasseConfirmado: 0, repasseEstimado: 0, impostoTotal: 0,
          orders: [],
          variantMap: new Map(),
        });
      }
      const g = groupMap.get(key);
      g.orderCount  += 1;
      g.qty         += o.quantity;
      g.gmv         += o.calcGmv;
      g.shopeeFee   += orderFee;
      g.netRevenue  += orderNet;
      g.productCost += o.calcProductCost;
      g.packaging   += o.calcPackaging;
      g.grossProfit += orderProfit;
      g.impostoTotal += orderTax;
      if (isConfirmed) g.repasseConfirmado += orderRepasse;
      if (isPending)   g.repasseEstimado   += orderRepasse;
      if (!o.hasCost)                    g.hasCost   = false;
      if (o.orderCategory === 'pending') g.hasPending = true;
      g.orders.push({
        orderId:       o.orderId,
        soldAt:        o.soldAt,
        quantity:      o.quantity,
        calcGmv:       r2(o.calcGmv),
        escrowAmount:  o.escrowAmount,
        orderCategory: o.orderCategory,
        variationName: o.variationName ?? null,
        repasse:       orderRepasse,
      });

      // Quebra adicional por variação real (ProductVariant)
      if (o.variantId) {
        if (!g.variantMap.has(o.variantId)) {
          g.variantMap.set(o.variantId, {
            variantId: o.variantId,
            name: o.variant?.name ?? o.variationName ?? null,
            sku:  o.variant?.sku  ?? o.skuVariacao ?? null,
            hasCost: true, hasPending: false,
            orderCount: 0, qty: 0,
            gmv: 0, shopeeFee: 0, netRevenue: 0,
            productCost: 0, packaging: 0, grossProfit: 0,
            repasseConfirmado: 0, repasseEstimado: 0, impostoTotal: 0,
            orders: [],
          });
        }
        const v = g.variantMap.get(o.variantId);
        v.orderCount  += 1;
        v.qty         += o.quantity;
        v.gmv         += o.calcGmv;
        v.shopeeFee   += orderFee;
        v.netRevenue  += orderNet;
        v.productCost += o.calcProductCost;
        v.packaging   += o.calcPackaging;
        v.grossProfit += orderProfit;
        v.impostoTotal += orderTax;
        if (isConfirmed) v.repasseConfirmado += orderRepasse;
        if (isPending)   v.repasseEstimado   += orderRepasse;
        if (!o.hasCost)                    v.hasCost   = false;
        if (o.orderCategory === 'pending') v.hasPending = true;
        v.orders.push({
          orderId:       o.orderId,
          soldAt:        o.soldAt,
          quantity:      o.quantity,
          calcGmv:       r2(o.calcGmv),
          escrowAmount:  o.escrowAmount,
          orderCategory: o.orderCategory,
          variationName: o.variationName ?? null,
          repasse:       orderRepasse,
        });
      }
    }
  }

  // DAS mensal (MEI) é um custo fixo do período, não por pedido — descontado uma vez do lucro do mês
  grossProfit -= fixedTaxAmount;
  const avgMargin = gmvTotal > 0 ? (grossProfit / gmvTotal) * 100 : 0;

  const repasseTotal     = r2(repasseConfirmado + repasseEstimado);
  const impostoTotal     = r2(taxAmount);
  const custoTotal       = r2(productCost + packagingCost);
  const resultadoLiquido = r2(repasseTotal - impostoTotal - custoTotal - fixedTaxAmount);
  const margem           = repasseTotal > 0 ? r2((resultadoLiquido / repasseTotal) * 100) : 0;

  const groups = [...groupMap.values()]
    .map(g => ({
      productId:    g.productId,
      productName:  g.productName,
      sku:          g.sku,
      variationName: g.variationName,
      hasCost:      g.hasCost,
      hasPending:   g.hasPending,
      orderCount:   g.orderCount,
      qty:          g.qty,
      gmv:          r2(g.gmv),
      shopeeFee:    r2(g.shopeeFee),
      netRevenue:   r2(g.netRevenue),
      productCost:  r2(g.productCost),
      packaging:    r2(g.packaging),
      grossProfit:  r2(g.grossProfit),
      margin:       (g.repasseConfirmado + g.repasseEstimado) > 0 ? r2((g.grossProfit / (g.repasseConfirmado + g.repasseEstimado)) * 100) : 0,
      repasseConfirmado: r2(g.repasseConfirmado),
      repasseEstimado:   r2(g.repasseEstimado),
      impostoTotal:      r2(g.impostoTotal),
      orders: g.orders.slice().sort((a, b) => new Date(a.soldAt) - new Date(b.soldAt)),
      variants: [...g.variantMap.values()]
        .map(v => ({
          variantId:    v.variantId,
          name:         v.name,
          sku:          v.sku,
          hasCost:      v.hasCost,
          hasPending:   v.hasPending,
          orderCount:   v.orderCount,
          qty:          v.qty,
          gmv:          r2(v.gmv),
          shopeeFee:    r2(v.shopeeFee),
          netRevenue:   r2(v.netRevenue),
          productCost:  r2(v.productCost),
          packaging:    r2(v.packaging),
          grossProfit:  r2(v.grossProfit),
          margin:       (v.repasseConfirmado + v.repasseEstimado) > 0 ? r2((v.grossProfit / (v.repasseConfirmado + v.repasseEstimado)) * 100) : 0,
          repasseConfirmado: r2(v.repasseConfirmado),
          repasseEstimado:   r2(v.repasseEstimado),
          impostoTotal:      r2(v.impostoTotal),
          orders: v.orders.slice().sort((a, b) => new Date(a.soldAt) - new Date(b.soldAt)),
        }))
        .sort((a, b) => b.gmv - a.gmv),
    }))
    .sort((a, b) => b.gmv - a.gmv);

  return {
    totalOrders:      allOrders.length,
    confirmedOrders:  confirmedCount,
    pendingOrders:    pendingCount,
    cancelledOrders:  cancelledCount,
    returnedOrders:   returnedCount,
    unitCount,
    gmvTotal:         r2(gmvTotal),
    gmvConfirmed:     r2(gmvConfirmed),
    gmvPending:       r2(gmvPending),
    shopeeDeductions: r2(shopeeDeductions),
    sellerDiscounts:  r2(sellerDiscounts),
    netRevenue:       r2(netRevenue),
    taxAmount:        r2(taxAmount),
    fixedTaxAmount,
    productCost:      r2(productCost),
    packagingCost:    r2(packagingCost),
    grossProfit:      r2(grossProfit),
    avgMargin:        r2(avgMargin),
    cancelledGmv:     r2(cancelledGmv),
    returnedValue:    r2(returnedValue),
    orphanCount:      groups.filter(g => !g.hasCost).length,
    taxInfo:          computeTaxInfo(monthlyTax, taxAmount, gmvTotal),

    // ── Novo modelo: repasse / imposto / resultado líquido ──────────────────
    repasseConfirmado: r2(repasseConfirmado),
    repasseEstimado:   r2(repasseEstimado),
    repasseTotal,
    impostoTotal,
    custoTotal,
    resultadoLiquido,
    margem,
    pendentes: {
      count: pendingCount,
      gmv: r2(gmvPending),
      estimatedRepasse: r2(repasseEstimado),
    },

    // Listas para drawers (devolucoes/cancelamentos/pendentes)
    returnedOrdersList,
    cancelledOrdersList,
    pendingOrdersList,

    groups,
  };
}

// ── GET /api/closing/:month/orders ────────────────────────────────────────────
// Lista os pedidos individuais de um produto/variação no mês, para o drawer de detalhe
async function getProductOrders(req, res) {
  try {
    const { month } = req.params;
    const { storeId, productId, variantId } = req.query;
    if (!productId) return res.status(400).json({ error: 'productId obrigatório' });

    const storeWhere = { userId: req.userId };
    if (storeId) storeWhere.id = storeId;
    const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
    const storeIds = stores.map(s => s.id);
    if (!storeIds.length) return res.json({ orders: [] });

    const [y, mo] = month.split('-').map(Number);
    const start = new Date(Date.UTC(y, mo - 1, 1));
    const end   = new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999));

    const where = {
      storeId: { in: storeIds },
      soldAt: { gte: start, lte: end },
      productId,
      orderCategory: { in: ['valid', 'pending'] },
    };
    if (variantId) where.variantId = variantId;

    const orders = await prisma.order.findMany({
      where,
      orderBy: { soldAt: 'asc' },
      select: {
        orderId: true, orderCategory: true, soldAt: true, calcGmv: true,
        escrowAmount: true, platformCommission: true, platformServiceFee: true,
        sellerCoupon: true, lmmDiscount: true,
      },
    });

    const list = orders.map(o => {
      const isConfirmed = o.orderCategory === 'valid';
      const orderFee  = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
      const orderDisc = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
      const orderNet  = r2(o.calcGmv - orderFee - orderDisc);
      const repasse   = isConfirmed ? r2(o.escrowAmount ?? orderNet) : orderNet;

      return {
        orderSn: o.orderId,
        soldAt:  o.soldAt,
        valor:   r2(o.calcGmv),
        status:  isConfirmed ? 'Liquidado' : 'Pendente',
        repasse,
      };
    });

    return res.json({ orders: list });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar pedidos do produto' });
  }
}

// ── GET /api/closing/history ──────────────────────────────────────────────────
async function getHistory(req, res) {
  try {
    const { storeId } = req.query;
    const storeWhere = { userId: req.userId };
    if (storeId) storeWhere.id = storeId;
    const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
    const storeIds = stores.map(s => s.id);

    const closings = await prisma.monthlyClosing.findMany({
      where:   { storeId: { in: storeIds } },
      orderBy: { periodMonth: 'desc' },
      select: { id: true, periodMonth: true, closedAt: true, status: true, gmvTotal: true, grossProfit: true, avgMargin: true, confirmedOrders: true, unitCount: true },
    });
    return res.json({ closings });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
}

// ── GET /api/closing/:month ───────────────────────────────────────────────────
async function getClosing(req, res) {
  try {
    const { month }   = req.params;
    const { storeId } = req.query;

    const storeWhere = { userId: req.userId };
    if (storeId) storeWhere.id = storeId;
    const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
    const storeIds = stores.map(s => s.id);
    if (!storeIds.length) return res.json({ status: 'open', data: null, groups: [] });

    const closing = await prisma.monthlyClosing.findFirst({
      where: { storeId: { in: storeIds }, periodMonth: month, status: 'closed' },
    });

    if (closing) {
      const monthlyTax = await prisma.monthlyTax.findUnique({ where: { userId_month: { userId: req.userId, month } } });
      const data = snapshotToClosingData(closing, monthlyTax);
      return res.json({
        status:   'closed',
        closedAt: closing.closedAt,
        closedBy: closing.closedBy,
        data,
        groups: data.groups,
      });
    }

    const computed = await buildClosingData(storeIds, month, req.userId);
    return res.json({ status: 'open', data: computed, groups: computed.groups });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar fechamento' });
  }
}

// ── POST /api/closing/:month/close ────────────────────────────────────────────
async function closeMonth(req, res) {
  try {
    const { month }   = req.params;
    const { storeId } = req.body;

    const storeWhere = { userId: req.userId };
    if (storeId) storeWhere.id = storeId;
    const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
    if (!stores.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const sid = stores[0].id;

    const existing = await prisma.monthlyClosing.findFirst({
      where: { storeId: sid, periodMonth: month, status: 'closed' },
    });
    if (existing) {
      return res.status(409).json({
        error: `Mes ${month} ja foi fechado em ${fmtDateTime(existing.closedAt)}`,
        closedAt: existing.closedAt,
      });
    }

    const d = await buildClosingData([sid], month, req.userId);

    const closing = await prisma.monthlyClosing.upsert({
      where:  { storeId_periodMonth: { storeId: sid, periodMonth: month } },
      create: {
        storeId: sid, periodMonth: month,
        closedAt: new Date(), closedBy: req.userId, status: 'closed',
        totalOrders: d.totalOrders, confirmedOrders: d.confirmedOrders,
        pendingOrders: d.pendingOrders, cancelledOrders: d.cancelledOrders,
        returnedOrders: d.returnedOrders, unitCount: d.unitCount,
        gmvTotal: d.gmvTotal, gmvConfirmed: d.gmvConfirmed, gmvPending: d.gmvPending,
        shopeeDeductions: d.shopeeDeductions, sellerDiscounts: d.sellerDiscounts,
        netRevenue: d.netRevenue, taxAmount: d.taxAmount, fixedTaxAmount: d.fixedTaxAmount,
        productCost: d.productCost, packagingCost: d.packagingCost,
        grossProfit: d.grossProfit, avgMargin: d.avgMargin,
        cancelledGmv: d.cancelledGmv, returnedValue: d.returnedValue,
        productsSnapshot: d.groups,
      },
      update: {
        closedAt: new Date(), closedBy: req.userId, status: 'closed',
        totalOrders: d.totalOrders, confirmedOrders: d.confirmedOrders,
        pendingOrders: d.pendingOrders, cancelledOrders: d.cancelledOrders,
        returnedOrders: d.returnedOrders, unitCount: d.unitCount,
        gmvTotal: d.gmvTotal, gmvConfirmed: d.gmvConfirmed, gmvPending: d.gmvPending,
        shopeeDeductions: d.shopeeDeductions, sellerDiscounts: d.sellerDiscounts,
        netRevenue: d.netRevenue, taxAmount: d.taxAmount, fixedTaxAmount: d.fixedTaxAmount,
        productCost: d.productCost, packagingCost: d.packagingCost,
        grossProfit: d.grossProfit, avgMargin: d.avgMargin,
        cancelledGmv: d.cancelledGmv, returnedValue: d.returnedValue,
        productsSnapshot: d.groups,
      },
    });

    return res.json({ success: true, closedAt: closing.closedAt, data: d });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao fechar mes' });
  }
}

// ── POST /api/closing/:month/reopen ──────────────────────────────────────────
async function reopenMonth(req, res) {
  try {
    const { month }   = req.params;
    const { storeId } = req.body;

    const storeWhere = { userId: req.userId };
    if (storeId) storeWhere.id = storeId;
    const stores = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
    if (!stores.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const sid = stores[0].id;

    await prisma.monthlyClosing.deleteMany({ where: { storeId: sid, periodMonth: month } });
    return res.json({ success: true, message: `Mes ${month} reaberto` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao reabrir mes' });
  }
}

// ── Per-store section renderer ────────────────────────────────────────────────
// Renders one store's full closing section on the current page of doc.
// Always starts at y=27 (top of page). Draws footer at H-32 absolute.
function renderStoreSection(doc, store, d, month, opts = {}) {
  const { isClosed = false, closedAt = null } = opts;

  const H  = 841.89;
  const ML = 42;
  const MR = 553;
  const { ds, drs, sep, fc, black } = makeH(doc, ML, MR);

  const mLabel    = monthLabel(month);
  const mLabelCap = mLabel.charAt(0).toUpperCase() + mLabel.slice(1);
  const top10     = d.groups.slice(0, 10);
  const negMargin = d.groups.filter(g => g.hasCost && g.margin < 0).length;
  const hasCosts  = d.orphanCount === 0;
  const totalOrd  = d.confirmedOrders + d.pendingOrders + d.cancelledOrders + d.returnedOrders;
  const cancelPct = totalOrd > 0 ? ((d.cancelledOrders / totalOrd) * 100).toFixed(1) : '0.0';
  const returnPct = totalOrd > 0 ? ((d.returnedOrders  / totalOrd) * 100).toFixed(1) : '0.0';

  let y = 27;

  // ── 1. HEADER ───────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(14).fillColor('black');
  ds(ML, y, 'ECOMZERO HUB');
  doc.font('Helvetica').fontSize(11);
  drs(MR, y, 'RELATORIO DE FECHAMENTO');

  y += 14;
  doc.font('Helvetica').fontSize(10);
  ds(ML, y, `${store.name} — ${store.marketplace ?? 'Shopee'}`);
  drs(MR, y, mLabelCap);

  if (isClosed) {
    y += 12;
    fc(120, 120, 120);
    doc.font('Helvetica').fontSize(9);
    ds(ML, y, `Fechado em: ${fmtDate(closedAt)}`);
    black();
  }

  y += 16;
  sep(y, 0.8);

  // ── 2. RESUMO DO PERÍODO ─────────────────────────────────────────────────
  y += 9;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
  ds(ML, y, 'RESUMO DO PERIODO');
  y += 12;
  sep(y, 0.3);
  y += 12;

  const rsV1 = 185, rsL2 = 285, rsV2 = MR;
  const resumoRows = [
    ['Pedidos faturados:', d.confirmedOrders + d.pendingOrders, 'Unidades vendidas:', d.unitCount],
    ['Confirmados:',       d.confirmedOrders,                   'Cancelamentos:',     d.cancelledOrders],
    ['Pendentes:',         d.pendingOrders,                     'Devolucoes:',        d.returnedOrders],
  ];
  for (const [l1, v1, l2, v2] of resumoRows) {
    doc.font('Helvetica').fontSize(9).fillColor('black');
    ds(ML, y, l1);
    doc.font('Helvetica-Bold').fontSize(9);
    drs(rsV1, y, String(v1));
    doc.font('Helvetica').fontSize(9);
    ds(rsL2, y, l2);
    doc.font('Helvetica-Bold').fontSize(9);
    drs(rsV2, y, String(v2));
    y += 14;
  }
  y += 4;
  sep(y, 0.3);

  // ── 3. REPASSE E RESULTADO ────────────────────────────────────────────────
  y += 9;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
  ds(ML, y, 'REPASSE E RESULTADO');
  y += 12;
  sep(y, 0.3);
  y += 14;

  const dreIndX   = ML + 12;
  const aliquota  = d.taxInfo?.aliquota ?? 0;
  const aliqStr   = String(aliquota).replace('.', ',');
  const taxLabel  = d.taxInfo?.fonte === 'das_real'
    ? `(-) Imposto (DAS — aliquota efetiva ${aliqStr}%)`
    : `(-) Imposto estimado (${aliqStr}% s/ faturamento)`;

  const dreRows  = [
    { l: 'Repasse confirmado',                        v: fmtBRLpdf(d.repasseConfirmado) + ` (${d.confirmedOrders} liquidados)`, bold: false, sepBefore: false },
    { l: '(+) Repasse estimado',                      v: fmtBRLpdf(d.repasseEstimado)   + ` (${d.pendingOrders} pendentes)`,    bold: false, sepBefore: false },
    { l: '(=) Repasse total previsto',                v: fmtBRLpdf(d.repasseTotal),                                            bold: true,  sepBefore: true  },
    { l: taxLabel,                                    v: fmtBRLpdf(-d.impostoTotal),                                           bold: false, sepBefore: false },
    ...(d.fixedTaxAmount > 0 ? [
      { l: '(-) DAS mensal (MEI)',                    v: fmtBRLpdf(-d.fixedTaxAmount),                                         bold: false, sepBefore: false },
    ] : []),
    { l: '(-) Custo dos produtos (CMV + embalagens)', v: fmtBRLpdf(-d.custoTotal) + (!hasCosts ? ' *' : ''),                   bold: false, sepBefore: false },
  ];

  for (const row of dreRows) {
    if (row.sepBefore) { sep(y - 3, 0.3); y += 4; }
    doc.font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('black');
    ds(dreIndX, y, row.l);
    drs(MR, y, row.v);
    y += 14;
    if (row.bold) { sep(y - 3, 0.3); y += 4; }
  }
  sep(y, 0.8);

  // ── 4. RESULTADO LÍQUIDO ─────────────────────────────────────────────────
  y += 8;
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black');
  ds(ML, y, 'RESULTADO LIQUIDO:');
  drs(MR, y, fmtBRLpdf(d.resultadoLiquido));

  y += 20;
  const barTotalW = 285;
  const margPct   = Math.max(0, Math.min(100, d.margem ?? 0));
  const filledW   = (margPct / 100) * barTotalW;
  doc.rect(ML, y, barTotalW, 9).fillColor([210, 210, 210]).fill();
  if (filledW > 0) doc.rect(ML, y, filledW, 9).fillColor([130, 130, 130]).fill();
  black();
  doc.font('Helvetica').fontSize(9);
  ds(ML + barTotalW + 10, y + 0.5, `Margem: ${margPct.toFixed(1)}%`);
  y += 16;

  if (!hasCosts) {
    fc(140, 140, 140);
    doc.font('Helvetica').fontSize(8);
    ds(ML, y, '* Produtos sem custo cadastrado — lucro estimado sem deducao de CMV');
    black();
    y += 13;
  }

  if (d.pendentes?.count > 0) {
    fc(180, 120, 0);
    doc.font('Helvetica-Bold').fontSize(8.5);
    ds(ML, y, `! ${d.pendentes.count} pedido(s) pendente(s) (${fmtBRLpdf(d.pendentes.estimatedRepasse)} estimado) — risco de devolucoes futuras`);
    black();
    y += 13;
  }

  // ── 5. PERDAS DO PERÍODO ─────────────────────────────────────────────────
  y += 8;
  sep(y, 0.3);
  y += 9;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
  ds(ML, y, 'PERDAS DO PERIODO');
  y += 12;
  sep(y, 0.3);
  y += 12;

  const pdL2 = 280, pdV1 = 185;
  doc.font('Helvetica').fontSize(9).fillColor('black');
  ds(ML, y, 'Cancelamentos:');
  doc.font('Helvetica-Bold'); drs(pdV1, y, `${d.cancelledOrders} pedidos`);
  doc.font('Helvetica');      ds(pdL2, y, 'GMV perdido:');
  doc.font('Helvetica-Bold'); drs(MR, y, fmtBRLpdf(d.cancelledGmv));

  y += 14;
  doc.font('Helvetica').fillColor('black');
  ds(ML, y, 'Devolucoes:');
  doc.font('Helvetica-Bold'); drs(pdV1, y, `${d.returnedOrders} pedidos`);
  doc.font('Helvetica');      ds(pdL2, y, 'Valor devolvido:');
  doc.font('Helvetica-Bold'); drs(MR, y, fmtBRLpdf(d.returnedValue));

  // ── 6. TOP 10 PRODUTOS ───────────────────────────────────────────────────
  y += 22;
  sep(y, 0.3);
  y += 9;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
  ds(ML, y, 'TOP 10 PRODUTOS DO PERIODO');
  y += 12;
  sep(y, 0.3);
  y += 12;

  const tNx = ML + 20, tPED = 342, tGMV = 418, tLUC = 492, tMAR = MR;
  fc(100, 100, 100);
  doc.font('Helvetica-Bold').fontSize(8.5);
  ds(ML, y, '#');
  ds(tNx, y, 'PRODUTO');
  doc.text('PED.',  tPED - 35, y, { width: 35, align: 'right', lineBreak: false });
  doc.text('GMV',   tGMV - 68, y, { width: 68, align: 'right', lineBreak: false });
  doc.text('LUCRO', tLUC - 65, y, { width: 65, align: 'right', lineBreak: false });
  doc.text('MARG.', tMAR - 52, y, { width: 52, align: 'right', lineBreak: false });
  black();
  y += 10;
  sep(y, 0.3);
  y += 5;

  doc.font('Helvetica').fontSize(9);
  for (let i = 0; i < top10.length; i++) {
    const g = top10[i];
    black();
    ds(ML, y, String(i + 1));
    ds(tNx, y, trunc(g.productName, 46));
    doc.text(String(g.orderCount), tPED - 35, y, { width: 35, align: 'right', lineBreak: false });
    doc.text(fmtBRLpdf(g.gmv),    tGMV - 68, y, { width: 68, align: 'right', lineBreak: false });
    if (g.hasCost) {
      black();
      doc.text(fmtBRLpdf(g.grossProfit), tLUC - 65, y, { width: 65, align: 'right', lineBreak: false });
      doc.text(`${g.margin.toFixed(1)}%`, tMAR - 52, y, { width: 52, align: 'right', lineBreak: false });
    } else {
      fc(140, 140, 140);
      doc.text('s/ custo', tLUC - 65, y, { width: 65, align: 'right', lineBreak: false });
      doc.text('—',        tMAR - 52, y, { width: 52, align: 'right', lineBreak: false });
      black();
    }
    y += 13;
  }

  // ── 7. ALERTAS ───────────────────────────────────────────────────────────
  y += 10;
  sep(y, 0.3);
  y += 9;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
  ds(ML, y, 'ALERTAS DO PERIODO');
  y += 12;
  sep(y, 0.3);
  y += 12;

  const alertTxtX = ML + 28;
  const alertas = [
    { warn: negMargin > 0,              prefix: '!',  text: `${negMargin} produto(s) com margem negativa` },
    { warn: d.orphanCount > 0,          prefix: '!',  text: `${d.orphanCount} produto(s) sem custo cadastrado — lucro nao calculado` },
    { warn: parseFloat(returnPct) > 2,  prefix: 'OK', text: `Taxa de devolucao: ${returnPct}% (normal < 2%)` },
    { warn: parseFloat(cancelPct) > 15, prefix: 'OK', text: `Taxa de cancelamento: ${cancelPct}% (normal < 15%)` },
  ];
  for (const a of alertas) {
    const fn  = a.warn ? 'Helvetica-Bold' : 'Helvetica';
    const clr = a.warn ? [0, 0, 0] : [100, 100, 100];
    doc.font(fn).fontSize(9).fillColor(clr);
    ds(ML, y, a.prefix);
    ds(alertTxtX, y, a.text);
    y += 14;
  }
  black();

  // ── 8. FOOTER ────────────────────────────────────────────────────────────
  const footerLineY = H - 32;
  sep(footerLineY, 0.3);
  fc(140, 140, 140);
  doc.font('Helvetica').fontSize(8);
  if (!isClosed) {
    ds(ML, footerLineY + 6, '* Valores nao finalizados — fechamento ainda aberto');
  }
  drs(MR, footerLineY + 6, `EcomZero Hub  |  Gerado em ${fmtDateTime(new Date())}`);
  black();
}

// ── GET /api/closing/:month/pdf ───────────────────────────────────────────────
async function getPdf(req, res) {
  try {
    const { month }   = req.params;
    const { storeId } = req.query;

    const storeWhere = { userId: req.userId };
    if (storeId) storeWhere.id = storeId;
    const stores = await prisma.store.findMany({
      where: storeWhere,
      include: { user: { select: { name: true, email: true } } },
    });
    if (!stores.length) return res.status(404).json({ error: 'Loja nao encontrada' });

    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="fechamento-${month}.pdf"`);
    doc.pipe(res);

    const isConsolidated = !storeId && stores.length > 1;

    if (!isConsolidated) {
      // ── SINGLE STORE PATH ──────────────────────────────────────────────────
      const store   = stores[0];
      const closing = await prisma.monthlyClosing.findFirst({
        where: { storeId: store.id, periodMonth: month, status: 'closed' },
      });

      let d, isClosed = false, closedAt = null;
      if (closing) {
        isClosed = true;
        closedAt = closing.closedAt;
        const monthlyTax = await prisma.monthlyTax.findUnique({ where: { userId_month: { userId: req.userId, month } } });
        d = snapshotToClosingData(closing, monthlyTax);
      } else {
        d = await buildClosingData([store.id], month, req.userId);
      }

      renderStoreSection(doc, store, d, month, { isClosed, closedAt });

    } else {
      // ── CONSOLIDATED MULTI-STORE PATH (Fix 2) ──────────────────────────────
      const allStoreIds = stores.map(s => s.id);

      // Parallel: consolidated total + per-store breakdown
      const [consolidatedData, ...storeDataArr] = await Promise.all([
        buildClosingData(allStoreIds, month, req.userId),
        ...stores.map(s => buildClosingData([s.id], month, req.userId)),
      ]);
      const storeResults = stores.map((s, i) => ({ store: s, data: storeDataArr[i] }));

      // Fix 3 — stores with negative margin products
      const storesWithNegMargin = storeResults
        .filter(sr => sr.data.groups.some(g => g.hasCost && g.margin < 0))
        .map(sr => sr.store.name);
      const totalNegMargin = consolidatedData.groups.filter(g => g.hasCost && g.margin < 0).length;

      const H  = 841.89;
      const ML = 42;
      const MR = 553;
      const { ds, drs, sep, fc, black } = makeH(doc, ML, MR);

      const mLabel    = monthLabel(month);
      const mLabelCap = mLabel.charAt(0).toUpperCase() + mLabel.slice(1);
      const d         = consolidatedData;
      const hasCosts  = d.orphanCount === 0;
      const totalOrd  = d.confirmedOrders + d.pendingOrders + d.cancelledOrders + d.returnedOrders;
      const cancelPct = totalOrd > 0 ? ((d.cancelledOrders / totalOrd) * 100).toFixed(1) : '0.0';
      const returnPct = totalOrd > 0 ? ((d.returnedOrders  / totalOrd) * 100).toFixed(1) : '0.0';

      let y = 27;

      // ── PÁGINA 1: CONSOLIDADO GERAL ─────────────────────────────────────

      // 1. HEADER
      doc.font('Helvetica-Bold').fontSize(14).fillColor('black');
      ds(ML, y, 'ECOMZERO HUB');
      doc.font('Helvetica').fontSize(11);
      drs(MR, y, 'FECHAMENTO CONSOLIDADO');

      y += 14;
      doc.font('Helvetica').fontSize(10);
      ds(ML, y, `Todas as lojas (${stores.length} lojas ativas no período)`);
      drs(MR, y, mLabelCap);

      y += 16;
      sep(y, 0.8);

      // 2. RESUMO CONSOLIDADO
      y += 9;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
      ds(ML, y, 'RESUMO CONSOLIDADO');
      y += 12;
      sep(y, 0.3);
      y += 12;

      const rsV1 = 185, rsL2 = 285, rsV2 = MR;
      const resumoRows = [
        ['Pedidos faturados:', d.confirmedOrders + d.pendingOrders, 'Unidades vendidas:', d.unitCount],
        ['Confirmados:',       d.confirmedOrders,                   'Cancelamentos:',     d.cancelledOrders],
        ['Pendentes:',         d.pendingOrders,                     'Devolucoes:',        d.returnedOrders],
      ];
      for (const [l1, v1, l2, v2] of resumoRows) {
        doc.font('Helvetica').fontSize(9).fillColor('black');
        ds(ML, y, l1);
        doc.font('Helvetica-Bold').fontSize(9);
        drs(rsV1, y, String(v1));
        doc.font('Helvetica').fontSize(9);
        ds(rsL2, y, l2);
        doc.font('Helvetica-Bold').fontSize(9);
        drs(rsV2, y, String(v2));
        y += 14;
      }
      y += 4;
      sep(y, 0.3);

      // 3. DEMONSTRATIVO FINANCEIRO (consolidado)
      y += 9;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
      ds(ML, y, 'REPASSE E RESULTADO');
      y += 12;
      sep(y, 0.3);
      y += 14;

      const dreIndX  = ML + 12;
      const aliquota = d.taxInfo?.aliquota ?? 0;
      const aliqStr  = String(aliquota).replace('.', ',');
      const taxLabel = d.taxInfo?.fonte === 'das_real'
        ? `(-) Imposto (DAS — aliquota efetiva ${aliqStr}%)`
        : `(-) Imposto estimado (${aliqStr}% s/ faturamento)`;

      const dreRows = [
        { l: 'Repasse confirmado',                        v: fmtBRLpdf(d.repasseConfirmado) + ` (${d.confirmedOrders} liquidados)`, bold: false, sepBefore: false },
        { l: '(+) Repasse estimado',                      v: fmtBRLpdf(d.repasseEstimado)   + ` (${d.pendingOrders} pendentes)`,    bold: false, sepBefore: false },
        { l: '(=) Repasse total previsto',                v: fmtBRLpdf(d.repasseTotal),                                            bold: true,  sepBefore: true  },
        { l: taxLabel,                                    v: fmtBRLpdf(-d.impostoTotal),                                           bold: false, sepBefore: false },
        ...(d.fixedTaxAmount > 0 ? [
          { l: '(-) DAS mensal (MEI)',                    v: fmtBRLpdf(-d.fixedTaxAmount),                                         bold: false, sepBefore: false },
        ] : []),
        { l: '(-) Custo dos produtos (CMV + embalagens)', v: fmtBRLpdf(-d.custoTotal) + (!hasCosts ? ' *' : ''),                   bold: false, sepBefore: false },
      ];
      for (const row of dreRows) {
        if (row.sepBefore) { sep(y - 3, 0.3); y += 4; }
        doc.font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('black');
        ds(dreIndX, y, row.l);
        drs(MR, y, row.v);
        y += 14;
        if (row.bold) { sep(y - 3, 0.3); y += 4; }
      }
      sep(y, 0.8);

      // 4. RESULTADO LÍQUIDO TOTAL
      y += 8;
      doc.font('Helvetica-Bold').fontSize(12).fillColor('black');
      ds(ML, y, 'RESULTADO LIQUIDO TOTAL:');
      drs(MR, y, fmtBRLpdf(d.resultadoLiquido));

      y += 20;
      const barTotalW = 285;
      const margPct   = Math.max(0, Math.min(100, d.margem ?? 0));
      const filledW   = (margPct / 100) * barTotalW;
      doc.rect(ML, y, barTotalW, 9).fillColor([210, 210, 210]).fill();
      if (filledW > 0) doc.rect(ML, y, filledW, 9).fillColor([130, 130, 130]).fill();
      black();
      doc.font('Helvetica').fontSize(9);
      ds(ML + barTotalW + 10, y + 0.5, `Margem media: ${margPct.toFixed(1)}%`);
      y += 16;

      if (!hasCosts) {
        fc(140, 140, 140);
        doc.font('Helvetica').fontSize(8);
        ds(ML, y, '* Produtos sem custo cadastrado — lucro estimado sem deducao de CMV');
        black();
        y += 13;
      }

      if (d.pendentes?.count > 0) {
        fc(180, 120, 0);
        doc.font('Helvetica-Bold').fontSize(8.5);
        ds(ML, y, `! ${d.pendentes.count} pedido(s) pendente(s) (${fmtBRLpdf(d.pendentes.estimatedRepasse)} estimado) — risco de devolucoes futuras`);
        black();
        y += 13;
      }

      // 5. BREAKDOWN POR LOJA
      y += 8;
      sep(y, 0.3);
      y += 9;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
      ds(ML, y, 'BREAKDOWN POR LOJA');
      y += 12;
      sep(y, 0.3);
      y += 10;

      // Table header
      const bkL  = ML;       // Loja left
      const bkG  = 255;      // Repasse right
      const bkR  = 348;      // Imposto right
      const bkLu = 430;      // Resultado right
      const bkM  = MR;       // Margem right

      fc(100, 100, 100);
      doc.font('Helvetica-Bold').fontSize(8.5);
      ds(bkL, y, 'LOJA');
      doc.text('REPASSE',   bkG  - 80, y, { width: 80, align: 'right', lineBreak: false });
      doc.text('IMPOSTO',   bkR  - 80, y, { width: 80, align: 'right', lineBreak: false });
      doc.text('RESULTADO', bkLu - 70, y, { width: 70, align: 'right', lineBreak: false });
      doc.text('MARGEM',    bkM  - 55, y, { width: 55, align: 'right', lineBreak: false });
      black();
      y += 10;
      sep(y, 0.3);
      y += 5;

      doc.font('Helvetica').fontSize(9);
      for (const { store: s, data: sd } of storeResults) {
        black();
        ds(bkL, y, trunc(s.name, 28));
        doc.text(fmtBRLpdf(sd.repasseTotal),     bkG  - 80, y, { width: 80, align: 'right', lineBreak: false });
        doc.text(fmtBRLpdf(-sd.impostoTotal),    bkR  - 80, y, { width: 80, align: 'right', lineBreak: false });
        doc.text(fmtBRLpdf(sd.resultadoLiquido), bkLu - 70, y, { width: 70, align: 'right', lineBreak: false });
        doc.text(`${(sd.margem ?? 0).toFixed(1)}%`, bkM - 55, y, { width: 55, align: 'right', lineBreak: false });
        y += 13;
      }

      // TOTAL row
      y += 2;
      sep(y, 0.5);
      y += 5;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('black');
      ds(bkL, y, 'TOTAL');
      doc.text(fmtBRLpdf(d.repasseTotal),     bkG  - 80, y, { width: 80, align: 'right', lineBreak: false });
      doc.text(fmtBRLpdf(-d.impostoTotal),    bkR  - 80, y, { width: 80, align: 'right', lineBreak: false });
      doc.text(fmtBRLpdf(d.resultadoLiquido), bkLu - 70, y, { width: 70, align: 'right', lineBreak: false });
      doc.text(`${margPct.toFixed(1)}%`, bkM  - 55, y, { width: 55, align: 'right', lineBreak: false });
      y += 16;

      // 6. TOP 10 PRODUTOS (consolidado)
      sep(y, 0.3);
      y += 9;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
      ds(ML, y, 'TOP 10 PRODUTOS (CONSOLIDADO)');
      y += 12;
      sep(y, 0.3);
      y += 12;

      const tNx = ML + 20, tPED = 342, tGMV = 418, tLUC = 492, tMAR = MR;
      fc(100, 100, 100);
      doc.font('Helvetica-Bold').fontSize(8.5);
      ds(ML, y, '#');
      ds(tNx, y, 'PRODUTO');
      doc.text('PED.',  tPED - 35, y, { width: 35, align: 'right', lineBreak: false });
      doc.text('GMV',   tGMV - 68, y, { width: 68, align: 'right', lineBreak: false });
      doc.text('LUCRO', tLUC - 65, y, { width: 65, align: 'right', lineBreak: false });
      doc.text('MARG.', tMAR - 52, y, { width: 52, align: 'right', lineBreak: false });
      black();
      y += 10;
      sep(y, 0.3);
      y += 5;

      const top10 = d.groups.slice(0, 10);
      doc.font('Helvetica').fontSize(9);
      for (let i = 0; i < top10.length; i++) {
        if (y > H - 120) { doc.addPage(); y = 27; }
        const g = top10[i];
        black();
        ds(ML, y, String(i + 1));
        ds(tNx, y, trunc(g.productName, 46));
        doc.text(String(g.orderCount), tPED - 35, y, { width: 35, align: 'right', lineBreak: false });
        doc.text(fmtBRLpdf(g.gmv),    tGMV - 68, y, { width: 68, align: 'right', lineBreak: false });
        if (g.hasCost) {
          black();
          doc.text(fmtBRLpdf(g.grossProfit), tLUC - 65, y, { width: 65, align: 'right', lineBreak: false });
          doc.text(`${g.margin.toFixed(1)}%`, tMAR - 52, y, { width: 52, align: 'right', lineBreak: false });
        } else {
          fc(140, 140, 140);
          doc.text('s/ custo', tLUC - 65, y, { width: 65, align: 'right', lineBreak: false });
          doc.text('—',        tMAR - 52, y, { width: 52, align: 'right', lineBreak: false });
          black();
        }
        y += 13;
      }

      // 7. ALERTAS (Fix 3 — indicar lojas com margem negativa)
      y += 10;
      sep(y, 0.3);
      y += 9;
      doc.font('Helvetica-Bold').fontSize(11).fillColor('black');
      ds(ML, y, 'ALERTAS DO PERIODO');
      y += 12;
      sep(y, 0.3);
      y += 12;

      const alertTxtX = ML + 28;
      const negMarginText = totalNegMargin > 0
        ? `${totalNegMargin} produto(s) com margem negativa` +
          (storesWithNegMargin.length > 0 ? ` — lojas: ${storesWithNegMargin.join(', ')}` : '')
        : '0 produtos com margem negativa';

      const alertas = [
        { warn: totalNegMargin > 0,         prefix: '!',  text: negMarginText },
        { warn: d.orphanCount > 0,          prefix: '!',  text: `${d.orphanCount} produto(s) sem custo cadastrado — lucro nao calculado` },
        { warn: parseFloat(returnPct) > 2,  prefix: 'OK', text: `Taxa de devolucao: ${returnPct}% (normal < 2%)` },
        { warn: parseFloat(cancelPct) > 15, prefix: 'OK', text: `Taxa de cancelamento: ${cancelPct}% (normal < 15%)` },
      ];
      for (const a of alertas) {
        const fn  = a.warn ? 'Helvetica-Bold' : 'Helvetica';
        const clr = a.warn ? [0, 0, 0] : [100, 100, 100];
        doc.font(fn).fontSize(9).fillColor(clr);
        ds(ML, y, a.prefix);
        ds(alertTxtX, y, a.text);
        y += 14;
      }
      black();

      // FOOTER página 1
      const footerLineY = H - 32;
      sep(footerLineY, 0.3);
      fc(140, 140, 140);
      doc.font('Helvetica').fontSize(8);
      ds(ML, footerLineY + 6, '* Valores calculados em tempo real — sem fechamento consolidado');
      drs(MR, footerLineY + 6, `EcomZero Hub  |  Gerado em ${fmtDateTime(new Date())}`);
      black();

      // ── PÁGINAS 2+: uma por loja ──────────────────────────────────────────
      for (const { store: s, data: sd } of storeResults) {
        doc.addPage();
        renderStoreSection(doc, s, sd, month, { isClosed: false, closedAt: null });
      }
    }

    doc.flushPages();
    doc.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao gerar PDF' });
  }
}

module.exports = { getHistory, getClosing, closeMonth, reopenMonth, getPdf, getProductOrders };
