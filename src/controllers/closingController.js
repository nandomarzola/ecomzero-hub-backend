const prisma      = require('../lib/prisma');
const PDFDocument = require('pdfkit');
const { r2, parseYearMonth } = require('../lib/utils');
const { recalculateOrdersForStore } = require('../services/recalculateService');
const { calcOrderFinancials } = require('../services/profitCalculator');

// São Paulo é UTC-3 fixo (sem horário de verão desde 2019)
function spToUtc(year, month, day, h = 0, min = 0, sec = 0, ms = 0) {
  return new Date(Date.UTC(year, month - 1, day, h + 3, min, sec, ms));
}

function fmtBRL(n) {
  const abs = Math.abs(n ?? 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return 'R$ ' + abs;
}

function fmtPct(n) { return (n ?? 0).toFixed(1) + '%'; }

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Soma um campo numérico através dos grupos de produto de um snapshot salvo
function sumGroupField(snap, field) {
  if (!Array.isArray(snap)) return 0;
  return r2(snap.reduce((sum, g) => sum + (g[field] ?? 0), 0));
}

// Reconstrói o objeto de dados completo (incl. campos do novo modelo de repasse/imposto)
// a partir de um MonthlyClosing salvo.
function snapshotToClosingData(closing) {
  const snap = closing.productsSnapshot ?? [];

  // Snapshots gerados antes da refatoração do fechamento não têm os campos de repasse/imposto por grupo
  const hasNewFields = Array.isArray(snap) && snap.some(g => g.impostoTotal != null);

  const repasseConfirmado = hasNewFields ? sumGroupField(snap, 'repasseConfirmado') : closing.netRevenue;
  const repasseEstimado   = hasNewFields ? sumGroupField(snap, 'repasseEstimado')   : 0;
  const repasseTotal      = r2(repasseConfirmado + repasseEstimado);
  const impostoTotal      = hasNewFields ? sumGroupField(snap, 'impostoTotal') : closing.taxAmount;
  const resultadoEstimado = hasNewFields ? sumGroupField(snap, 'estimatedProfit') : 0;
  const impostoEstimadoTotal = hasNewFields ? sumGroupField(snap, 'impostoEstimado') : 0;
  const custoEstimadoTotal = hasNewFields ? sumGroupField(snap, 'custoEstimado') : 0;
  const gmvEstimado = hasNewFields ? sumGroupField(snap, 'gmvEstimado') : closing.gmvPending;
  const custoTotal        = r2(closing.productCost + closing.packagingCost);
  const resultadoLiquido  = closing.grossProfit;
  const margem = closing.gmvTotal > 0 ? r2((resultadoLiquido / closing.gmvTotal) * 100) : closing.avgMargin;

  const orphanGroups = Array.isArray(snap) ? snap.filter(g => !g.hasCost) : [];
  const orphanCatalogIds = new Set(orphanGroups.map(g => g.catalogProductId ?? g.productId).filter(Boolean));
  const orphanUnlinkedGroups = orphanGroups.filter(g => !(g.catalogProductId ?? g.productId));
  const orphanLinkedGmv = orphanGroups
    .filter(g => g.catalogProductId ?? g.productId)
    .reduce((sum, g) => sum + (g.gmv ?? 0) + (g.gmvEstimado ?? 0), 0);
  const orphanUnlinkedGmv = orphanUnlinkedGroups.reduce((sum, g) => sum + (g.gmv ?? 0) + (g.gmvEstimado ?? 0), 0);

  return {
    totalOrders:      closing.totalOrders,
    totalLineCount:   closing.totalOrders,
    confirmedOrders:  closing.confirmedOrders,
    confirmedLineCount: closing.confirmedOrders,
    pendingOrders:    closing.pendingOrders,
    pendingLineCount: closing.pendingOrders,
    cancelledOrders:  closing.cancelledOrders,
    cancelledLineCount: closing.cancelledOrders,
    returnedOrders:   closing.returnedOrders,
    returnedLineCount: closing.returnedOrders,
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
    orphanCount:      orphanGroups.length,
    costIssues: {
      totalGroups: orphanGroups.length,
      catalogProducts: orphanCatalogIds.size,
      linkedGroups: orphanGroups.length - orphanUnlinkedGroups.length,
      unlinkedGroups: orphanUnlinkedGroups.length,
      linkedGmv: r2(orphanLinkedGmv),
      unlinkedGmv: r2(orphanUnlinkedGmv),
      gmv: r2(orphanLinkedGmv + orphanUnlinkedGmv),
    },
    operational: {
      createdOrders: closing.totalOrders,
      createdLines: closing.totalOrders,
      createdUnits: closing.unitCount,
      createdSalesTotal: closing.gmvTotal,
    },
    competence: {
      basis: 'repasse',
      basisField: 'orderPaidAt',
      operationalField: 'soldAt',
      hasShift: false,
      financial: {
        orders: closing.confirmedOrders,
        lines: closing.confirmedOrders,
        units: closing.unitCount,
        salesTotal: closing.gmvTotal,
        gmv: closing.gmvTotal,
        repasse: repasseConfirmado,
        tax: impostoTotal,
        cost: custoTotal,
        profit: resultadoLiquido,
      },
      soldInPeriod: null,
      soldInPeriodPaidOutside: { orders: 0, lines: 0, units: 0, salesTotal: 0, gmv: 0, repasse: 0, tax: 0, cost: 0, profit: 0, ordersList: [] },
      paidInPeriodSoldOutside: { orders: 0, lines: 0, units: 0, salesTotal: 0, gmv: 0, repasse: 0, tax: 0, cost: 0, profit: 0, ordersList: [] },
      returnedPartial: { orders: 0, lines: 0, units: 0, salesTotal: 0, gmv: 0, repasse: 0, tax: 0, cost: 0, profit: 0, ordersList: [] },
    },

    repasseConfirmado,
    repasseEstimado,
    repasseTotal,
    impostoTotal,
    custoTotal,
    resultadoLiquido,
    margem,
    resultadoEstimado,
    impostoEstimadoTotal,
    custoEstimadoTotal,
    gmvEstimado,
    pendentes: {
      count: closing.pendingOrders,
      gmv: gmvEstimado,
      estimatedRepasse: repasseEstimado,
      estimatedProfit: resultadoEstimado,
      estimatedTax: impostoEstimadoTotal,
      estimatedCost: custoEstimadoTotal,
    },

    // Snapshots de meses fechados nao guardam as listas individuais de pedidos —
    // drawers ficam vazios nesse caso
    returnedOrdersList:  [],
    cancelledOrdersList: [],
    pendingOrdersList:   [],

    groups: Array.isArray(snap) ? snap : [],
    salesPerformance: salesPerformanceFromGroups(snap),
  };
}

function combineClosingData(items) {
  const combined = {
    totalOrders: 0, totalLineCount: 0,
    confirmedOrders: 0, confirmedLineCount: 0,
    pendingOrders: 0, pendingLineCount: 0,
    cancelledOrders: 0, cancelledLineCount: 0,
    returnedOrders: 0, returnedLineCount: 0,
    unitCount: 0,
    gmvTotal: 0, gmvConfirmed: 0, gmvPending: 0,
    shopeeDeductions: 0, sellerDiscounts: 0, netRevenue: 0,
    taxAmount: 0, fixedTaxAmount: 0, productCost: 0, packagingCost: 0,
    grossProfit: 0, cancelledGmv: 0, returnedValue: 0, returnedCost: 0,
    repasseConfirmado: 0, repasseEstimado: 0, repasseTotal: 0,
    impostoTotal: 0, custoTotal: 0, resultadoLiquido: 0,
    resultadoEstimado: 0, impostoEstimadoTotal: 0, custoEstimadoTotal: 0,
    gmvEstimado: 0, orphanCount: 0,
    groups: [], salesPerformance: [],
    returnedOrdersList: [], cancelledOrdersList: [], pendingOrdersList: [],
    operational: { createdOrders: 0, createdLines: 0, createdUnits: 0, createdSalesTotal: 0 },
    competence: {
      basis: 'repasse',
      basisField: 'orderPaidAt',
      operationalField: 'soldAt',
      hasShift: false,
      soldInPeriodPaidOutside: { orders: 0, lines: 0, units: 0, salesTotal: 0, gmv: 0, repasse: 0, tax: 0, cost: 0, profit: 0, ordersList: [] },
      paidInPeriodSoldOutside: { orders: 0, lines: 0, units: 0, salesTotal: 0, gmv: 0, repasse: 0, tax: 0, cost: 0, profit: 0, ordersList: [] },
      returnedPartial: { orders: 0, lines: 0, units: 0, salesTotal: 0, gmv: 0, repasse: 0, tax: 0, cost: 0, profit: 0, ordersList: [] },
    },
  };

  const sumKeys = [
    'totalOrders', 'totalLineCount', 'confirmedOrders', 'confirmedLineCount',
    'pendingOrders', 'pendingLineCount', 'cancelledOrders', 'cancelledLineCount',
    'returnedOrders', 'returnedLineCount', 'unitCount', 'gmvTotal', 'gmvConfirmed',
    'gmvPending', 'shopeeDeductions', 'sellerDiscounts', 'netRevenue', 'taxAmount',
    'fixedTaxAmount', 'productCost', 'packagingCost', 'grossProfit', 'cancelledGmv',
    'returnedValue', 'returnedCost', 'repasseConfirmado', 'repasseEstimado',
    'repasseTotal', 'impostoTotal', 'custoTotal', 'resultadoLiquido',
    'resultadoEstimado', 'impostoEstimadoTotal', 'custoEstimadoTotal',
    'gmvEstimado', 'orphanCount',
  ];

  for (const data of items) {
    for (const key of sumKeys) combined[key] += data[key] ?? 0;
    combined.groups.push(...(data.groups ?? []));
    combined.salesPerformance.push(...(data.salesPerformance ?? salesPerformanceFromGroups(data.groups ?? [])));
    combined.returnedOrdersList.push(...(data.returnedOrdersList ?? []));
    combined.cancelledOrdersList.push(...(data.cancelledOrdersList ?? []));
    combined.pendingOrdersList.push(...(data.pendingOrdersList ?? []));
    combined.operational.createdOrders += data.operational?.createdOrders ?? data.totalOrders ?? 0;
    combined.operational.createdLines += data.operational?.createdLines ?? data.totalLineCount ?? data.totalOrders ?? 0;
    combined.operational.createdUnits += data.operational?.createdUnits ?? data.unitCount ?? 0;
    combined.operational.createdSalesTotal += data.operational?.createdSalesTotal ?? data.gmvTotal ?? 0;
  }

  combined.avgMargin = combined.gmvTotal > 0 ? r2((combined.grossProfit / combined.gmvTotal) * 100) : 0;
  combined.margem = combined.gmvTotal > 0 ? r2((combined.resultadoLiquido / combined.gmvTotal) * 100) : 0;
  combined.pendentes = {
    count: combined.pendingOrders,
    lineCount: combined.pendingLineCount,
    gmv: r2(combined.gmvPending),
    estimatedRepasse: r2(combined.repasseEstimado),
    estimatedProfit: r2(combined.resultadoEstimado),
    estimatedTax: r2(combined.impostoEstimadoTotal),
    estimatedCost: r2(combined.custoEstimadoTotal),
  };
  const orphanGroups = combined.groups.filter(g => !g.hasCost);
  const orphanCatalogIds = new Set(orphanGroups.map(g => g.catalogProductId ?? g.productId).filter(Boolean));
  const orphanUnlinkedGroups = orphanGroups.filter(g => !(g.catalogProductId ?? g.productId));
  const orphanLinkedGmv = orphanGroups
    .filter(g => g.catalogProductId ?? g.productId)
    .reduce((sum, g) => sum + (g.gmv ?? 0) + (g.gmvEstimado ?? 0), 0);
  const orphanUnlinkedGmv = orphanUnlinkedGroups.reduce((sum, g) => sum + (g.gmv ?? 0) + (g.gmvEstimado ?? 0), 0);
  combined.orphanCount = orphanGroups.length;
  combined.costIssues = {
    totalGroups: orphanGroups.length,
    catalogProducts: orphanCatalogIds.size,
    linkedGroups: orphanGroups.length - orphanUnlinkedGroups.length,
    unlinkedGroups: orphanUnlinkedGroups.length,
    linkedGmv: r2(orphanLinkedGmv),
    unlinkedGmv: r2(orphanUnlinkedGmv),
    gmv: r2(orphanLinkedGmv + orphanUnlinkedGmv),
  };

  for (const key of [...sumKeys, 'avgMargin', 'margem']) {
    if (typeof combined[key] === 'number') combined[key] = r2(combined[key]);
  }
  combined.operational.createdSalesTotal = r2(combined.operational.createdSalesTotal);
  combined.salesPerformance = combined.salesPerformance
    .sort((a, b) => (b.qty - a.qty) || ((b.gmv ?? 0) - (a.gmv ?? 0)));
  return combined;
}

function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('pt-BR') + ' as ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function monthLabel(month) {
  const { year: y, month: m } = parseYearMonth(month);
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

const FINANCIAL_REVENUE_CATEGORIES = ['valid', 'returned_partial'];
const SALES_REVENUE_CATEGORIES = ['valid', 'pending', 'returned_partial'];

function orderKey(order) {
  return order?.orderId || order?.id;
}

function hasRealRepasse(order) {
  return FINANCIAL_REVENUE_CATEGORIES.includes(order.orderCategory)
    && order.escrowAmount !== null
    && order.escrowAmount !== undefined;
}

function marketplaceOf(order, storeMarketplaceMap) {
  return String(storeMarketplaceMap.get(order.storeId) ?? '').toLowerCase();
}

function isShopeeOrder(order, storeMarketplaceMap) {
  return marketplaceOf(order, storeMarketplaceMap) === 'shopee';
}

function hasSettledRevenue(order, storeMarketplaceMap) {
  if (!FINANCIAL_REVENUE_CATEGORIES.includes(order.orderCategory)) return false;
  if (isShopeeOrder(order, storeMarketplaceMap)) return hasRealRepasse(order);
  return Boolean(order.orderPaidAt) || (order.calcNetRevenue ?? 0) > 0;
}

function inRange(date, start, end) {
  if (!date) return false;
  const t = new Date(date).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function addUniqueOrder(set, order) {
  const key = orderKey(order);
  if (key) set.add(key);
}

// Fórmula canônica compartilhada — services/profitCalculator.js.
// Mantém a forma { orderFee, orderDisc, orderNet, repasse, tax, cost, profit }
// que o buildClosingData/summarizeLines/auditOrder consomem.
function calcLine(order, storeTaxRateMap, storeMarketplaceMap = null) {
  const taxRate = storeTaxRateMap.get(order.storeId) ?? 0;
  const marketplace = storeMarketplaceMap?.get?.(order.storeId) ?? 'shopee';
  const fin = calcOrderFinancials(order, taxRate, marketplace);
  return {
    orderFee: fin.fee, orderDisc: fin.disc, orderNet: fin.net,
    repasse: fin.repasse, tax: fin.tax, cost: fin.cost, profit: fin.profit,
  };
}

function hasCurrentCost(order) {
  const savedLineCost = r2((order.calcProductCost ?? 0) + (order.calcPackaging ?? 0));
  const variantCost = Number(order.variant?.costPrice ?? 0);
  const productCost = Number(order.product?.costPrice ?? 0);
  const parentCost = Number(order.product?.parent?.costPrice ?? 0);
  return savedLineCost > 0 || variantCost > 0 || productCost > 0 || parentCost > 0;
}

function catalogProductId(order) {
  return order.product?.parentId ?? order.productId ?? null;
}

function summarizeLines(rows, storeTaxRateMap, storeMarketplaceMap = null) {
  const orderIds = new Set();
  const totals = {
    orders: 0, lines: rows.length, units: 0, salesTotal: 0, gmv: 0,
    repasse: 0, marketplaceFee: 0, tax: 0, cost: 0, profit: 0,
  };

  for (const row of rows) {
    addUniqueOrder(orderIds, row);
    const line = calcLine(row, storeTaxRateMap, storeMarketplaceMap);
    totals.units += row.quantity ?? 0;
    totals.gmv += row.calcGmv ?? 0;
    totals.repasse += line.repasse ?? 0;
    totals.marketplaceFee += line.orderFee;
    totals.tax += line.tax;
    totals.cost += line.cost;
    totals.profit += line.profit ?? 0;
  }

  totals.orders = orderIds.size;
  totals.salesTotal = totals.gmv;
  for (const key of ['salesTotal', 'gmv', 'repasse', 'marketplaceFee', 'tax', 'cost', 'profit']) {
    totals[key] = r2(totals[key]);
  }
  return totals;
}

function productGroupKey(order) {
  return order.productId
    ? `pid:${order.productId}`
    : `sku:${order.skuVariacao || order.skuPrincipal || order.productName || order.orderId}`;
}

function variationKey(order) {
  if (order.variantId) return `variant:${order.variantId}`;
  if (order.skuVariacao) return `sku:${order.skuVariacao}`;
  if (order.variationName) return `name:${order.variationName.trim()}`;
  if (order.lineItemKey && order.lineItemKey !== '0') return `line:${order.lineItemKey}`;
  return null;
}

function makeSalesEntry(order, storeMarketplaceMap, { variant = false } = {}) {
  const settled = hasSettledRevenue(order, storeMarketplaceMap);
  const parent = order.product?.parent;
  return {
    key: variant ? `${productGroupKey(order)}|${variationKey(order) ?? 'base'}` : productGroupKey(order),
    productId: order.productId,
    catalogProductId: catalogProductId(order),
    productName: parent?.name ?? order.product?.name ?? order.productName ?? '(sem nome)',
    variationName: variant
      ? (order.variant?.name ?? order.variationName ?? (parent ? order.product?.name : null))
      : null,
    sku: variant
      ? (order.variant?.sku ?? order.skuVariacao ?? order.product?.sku ?? order.skuPrincipal ?? '')
      : (parent?.sku ?? order.product?.sku ?? order.skuPrincipal ?? ''),
    orderIds: new Set(),
    qty: 0,
    confirmedQty: 0,
    pendingQty: 0,
    gmv: 0,
    confirmedGmv: 0,
    pendingGmv: 0,
    returnedPartialQty: 0,
    hasPending: false,
    settled,
  };
}

function addSalesPerformanceRow(map, order, storeMarketplaceMap, options = {}) {
  const key = options.variant ? `${productGroupKey(order)}|${variationKey(order) ?? 'base'}` : productGroupKey(order);
  if (!map.has(key)) map.set(key, makeSalesEntry(order, storeMarketplaceMap, options));
  const entry = map.get(key);
  const settled = hasSettledRevenue(order, storeMarketplaceMap);
  addUniqueOrder(entry.orderIds, order);
  entry.qty += order.quantity ?? 0;
  entry.gmv += order.calcGmv ?? 0;
  if (settled) {
    entry.confirmedQty += order.quantity ?? 0;
    entry.confirmedGmv += order.calcGmv ?? 0;
  } else {
    entry.pendingQty += order.quantity ?? 0;
    entry.pendingGmv += order.calcGmv ?? 0;
    entry.hasPending = true;
  }
  if (order.orderCategory === 'returned_partial') entry.returnedPartialQty += order.quantity ?? 0;
}

function finalizeSalesEntry(entry) {
  return {
    key: entry.key,
    productId: entry.productId,
    catalogProductId: entry.catalogProductId,
    productName: entry.productName,
    variationName: entry.variationName,
    sku: entry.sku,
    orderCount: entry.orderIds?.size ?? entry.orderCount ?? 0,
    qty: entry.qty ?? 0,
    confirmedQty: entry.confirmedQty ?? 0,
    pendingQty: entry.pendingQty ?? 0,
    gmv: r2(entry.gmv ?? 0),
    confirmedGmv: r2(entry.confirmedGmv ?? 0),
    pendingGmv: r2(entry.pendingGmv ?? 0),
    returnedPartialQty: entry.returnedPartialQty ?? 0,
    hasPending: Boolean(entry.hasPending),
  };
}

function buildSalesPerformance(soldAtOrders, storeMarketplaceMap) {
  const byGroup = new Map();
  const byVariation = new Map();

  for (const order of soldAtOrders) {
    if (!SALES_REVENUE_CATEGORIES.includes(order.orderCategory)) continue;
    addSalesPerformanceRow(byGroup, order, storeMarketplaceMap);
    if (variationKey(order)) addSalesPerformanceRow(byVariation, order, storeMarketplaceMap, { variant: true });
  }

  const list = [...byVariation.values(), ...[...byGroup.values()].filter((entry) => {
    return ![...byVariation.keys()].some((key) => key.startsWith(`${entry.key}|`));
  })]
    .map(finalizeSalesEntry)
    .sort((a, b) => (b.qty - a.qty) || (b.gmv - a.gmv));

  return { byGroup, byVariation, list };
}

function salesPerformanceFromGroups(groups) {
  if (!Array.isArray(groups)) return [];
  const rows = [];
  for (const group of groups) {
    if (Array.isArray(group.variants) && group.variants.length > 0) {
      for (const variant of group.variants) {
        rows.push({
          key: variant.salesKey ?? `${group.productId ?? group.productName}|${variant.variantId ?? variant.sku ?? variant.name ?? 'variant'}`,
          productId: group.productId,
          catalogProductId: group.catalogProductId ?? group.productId,
          productName: group.productName,
          variationName: variant.name,
          sku: variant.sku,
          orderCount: variant.salesOrderCount ?? variant.orderCount ?? 0,
          qty: variant.salesQty ?? ((variant.qty ?? 0) + (variant.pendingQty ?? 0)),
          confirmedQty: variant.salesConfirmedQty ?? variant.qty ?? 0,
          pendingQty: variant.salesPendingQty ?? variant.pendingQty ?? 0,
          gmv: variant.salesGmv ?? ((variant.gmv ?? 0) + (variant.gmvEstimado ?? 0)),
          confirmedGmv: variant.salesConfirmedGmv ?? variant.gmv ?? 0,
          pendingGmv: variant.salesPendingGmv ?? variant.gmvEstimado ?? 0,
          returnedPartialQty: variant.salesReturnedPartialQty ?? 0,
          hasPending: Boolean(variant.hasPending),
        });
      }
    } else {
      rows.push({
        key: group.salesKey ?? group.productId ?? group.productName,
        productId: group.productId,
        catalogProductId: group.catalogProductId ?? group.productId,
        productName: group.productName,
        variationName: group.variationName,
        sku: group.sku,
        orderCount: group.salesOrderCount ?? group.orderCount ?? 0,
        qty: group.salesQty ?? ((group.qty ?? 0) + (group.pendingQty ?? 0)),
        confirmedQty: group.salesConfirmedQty ?? group.qty ?? 0,
        pendingQty: group.salesPendingQty ?? group.pendingQty ?? 0,
        gmv: group.salesGmv ?? ((group.gmv ?? 0) + (group.gmvEstimado ?? 0)),
        confirmedGmv: group.salesConfirmedGmv ?? group.gmv ?? 0,
        pendingGmv: group.salesPendingGmv ?? group.gmvEstimado ?? 0,
        returnedPartialQty: group.salesReturnedPartialQty ?? 0,
        hasPending: Boolean(group.hasPending),
      });
    }
  }
  return rows
    .map(row => ({
      ...row,
      gmv: r2(row.gmv ?? 0),
      confirmedGmv: r2(row.confirmedGmv ?? 0),
      pendingGmv: r2(row.pendingGmv ?? 0),
    }))
    .sort((a, b) => (b.qty - a.qty) || (b.gmv - a.gmv));
}

function auditOrder(row, storeTaxRateMap, storeMarketplaceMap = null) {
  const line = calcLine(row, storeTaxRateMap, storeMarketplaceMap);
  return {
    id: row.id,
    orderId: row.orderId,
    lineItemKey: row.lineItemKey,
    productName: row.productName,
    variationName: row.variationName,
    orderCategory: row.orderCategory,
    orderStatus: row.orderStatus,
    returnStatus: row.returnStatus ?? null,
    soldAt: row.soldAt,
    orderPaidAt: row.orderPaidAt,
    orderCreatedAt: row.orderCreatedAt,
    quantity: row.quantity ?? 0,
    salesTotal: r2(row.globalTotal ?? row.calcGmv ?? 0),
    gmv: r2(row.calcGmv ?? 0),
    repasse: line.repasse,
    marketplaceFee: line.orderFee,
    tax: line.tax,
    cost: line.cost,
    profit: line.profit,
  };
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
async function buildClosingDataLegacy(storeIds, month) {
  const { year: y, month: mo } = parseYearMonth(month);
  // Range em horário de São Paulo (UTC-3) — mesmo critério do dashboard/appAuthController.
  // spToUtc(y, mo, 1) = dia 1 às 00:00 SP = 03:00 UTC
  // Último dia do mês: new Date(y, mo, 0) dá o último dia de mo-1; passamos dia 0 do mês seguinte
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // nº do último dia
  const start = spToUtc(y, mo, 1);
  const end   = spToUtc(y, mo, lastDay, 23, 59, 59, 999);

  const stores = await prisma.store.findMany({
    where:  { id: { in: storeIds } },
    select: { id: true, taxType: true, taxRate: true, fixedMonthlyTax: true },
  });
  const fixedTaxAmount = r2(stores
    .filter(s => s.taxType === 'mei')
    .reduce((sum, s) => sum + (s.fixedMonthlyTax ?? 0), 0));
  const storeTaxRateMap = new Map(stores.map(s => [s.id, s.taxRate ?? 0]));

  // Competência de caixa/repasse:
  //  - Pedidos pagos (orderPaidAt não null): filtrar pela data de pagamento ao seller
  //  - Pedidos sem pagamento (pendentes, cancelados s/ pag.): filtrar por soldAt (criação)
  // Isso alinha o Fechamento com o Dashboard que usa a mesma competência de repasse.
  const allOrders = await prisma.order.findMany({
    where: {
      storeId: { in: storeIds },
      OR: [
        { orderPaidAt: { gte: start, lte: end } },
        { orderPaidAt: null, soldAt: { gte: start, lte: end } },
      ],
    },
    include: {
      product: { select: { id: true, name: true, sku: true } },
      variant: { select: { id: true, name: true, sku: true } },
    },
  });

  let gmvTotal = 0, gmvConfirmed = 0, gmvPending = 0;
  let shopeeDeductions = 0, sellerDiscounts = 0, netRevenue = 0;
  let taxAmount = 0, productCost = 0, packagingCost = 0, grossProfit = 0;
  let estimatedTaxAmount = 0, estimatedProductCost = 0, estimatedPackagingCost = 0, estimatedGrossProfit = 0;
  let repasseConfirmado = 0, repasseEstimado = 0;
  let cancelledGmv = 0, returnedValue = 0, returnedCost = 0;
  let unitCount = 0;
  let confirmedCount = 0, pendingCount = 0, cancelledCount = 0, returnedCount = 0;

  const groupMap = new Map();

  // Listas para os drawers do frontend (devolucoes, cancelamentos, pendentes)
  const returnedOrdersList  = [];
  const cancelledOrdersList = [];
  const pendingOrdersList   = [];

  for (const o of allOrders) {
    const isConfirmedSale = o.orderCategory === 'valid';
    const hasConfirmedRepasse = isConfirmedSale && o.escrowAmount !== null && o.escrowAmount !== undefined;
    const isPending   = o.orderCategory === 'pending';
    const isEstimatedRevenue = isPending || (isConfirmedSale && !hasConfirmedRepasse);
    const isRevenue   = hasConfirmedRepasse || isEstimatedRevenue;
    const isCancelled = o.orderCategory.startsWith('cancelled');
    const isReturned  = o.orderCategory === 'returned_full' || o.orderCategory === 'returned_partial';

    // Taxa real = comissão + taxa de serviço (escrow), não a estimativa em calcShopeeFee
    // (que pode estar divergente por causa de um recálculo antigo)
    const orderFee    = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
    const orderDisc   = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
    const orderNet    = r2(o.calcGmv - orderFee - orderDisc);

    // Repasse: confirmado usa escrowAmount real (Shopee). Sem escrow ainda e pending ficam estimados.
    const orderRepasse = hasConfirmedRepasse ? r2(o.escrowAmount) : orderNet;

    // Imposto: sobre o faturamento bruto (calcGmv) — não desconta voucher Shopee da base
    const aliquotaOrder = storeTaxRateMap.get(o.storeId) ?? 0;
    const orderTax      = r2((o.calcGmv ?? 0) * aliquotaOrder / 100);

    // Para pedidos confirmados: usa escrowAmount real como base (já computado em orderRepasse)
    const orderProfit = r2(orderRepasse - orderTax - o.calcProductCost - o.calcPackaging);

    if (hasConfirmedRepasse) confirmedCount++;
    else if (isPending)   pendingCount++;
    else if (isEstimatedRevenue) pendingCount++;
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
    if (isConfirmedSale && !hasConfirmedRepasse) {
      pendingOrdersList.push({
        id:               o.id,
        orderId:          o.orderId,
        soldAt:           o.soldAt,
        productName:      o.productName,
        variationName:    o.variationName,
        calcGmv:          r2(o.calcGmv),
        estimatedRepasse: orderRepasse,
        reason:           'Aguardando repasse Shopee',
      });
    }

    if (hasConfirmedRepasse) {
      gmvTotal         += o.calcGmv;
      shopeeDeductions += orderFee;
      sellerDiscounts  += orderDisc;
      netRevenue       += orderRepasse;
      taxAmount        += orderTax;
      productCost      += o.calcProductCost;
      packagingCost    += o.calcPackaging;
      grossProfit      += orderProfit;
      unitCount        += o.quantity;
      gmvConfirmed     += o.calcGmv;
      repasseConfirmado += orderRepasse;
    } else if (isEstimatedRevenue) {
      gmvPending += o.calcGmv;
      repasseEstimado += orderRepasse;
      estimatedTaxAmount += orderTax;
      estimatedProductCost += o.calcProductCost;
      estimatedPackagingCost += o.calcPackaging;
      estimatedGrossProfit += orderProfit;
    }
    if (isCancelled) cancelledGmv += o.calcGmv;
    if (isReturned) {
      returnedValue += o.calcGmv;
      returnedCost  += (o.calcProductCost ?? 0) + (o.calcPackaging ?? 0);
    }

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
          orderCount: 0, qty: 0, pendingOrderCount: 0, pendingQty: 0,
          gmv: 0, shopeeFee: 0, netRevenue: 0,
          productCost: 0, packaging: 0, grossProfit: 0, estimatedProfit: 0,
          gmvEstimado: 0, impostoEstimado: 0, custoEstimado: 0,
          repasseConfirmado: 0, repasseEstimado: 0, impostoTotal: 0,
          orders: [],
          variantMap: new Map(),
        });
      }
      const g = groupMap.get(key);
      if (hasConfirmedRepasse) {
        g.orderCount  += 1;
        g.qty         += o.quantity;
        g.gmv         += o.calcGmv;
        g.shopeeFee   += orderFee;
        g.netRevenue  += orderRepasse;
        g.productCost += o.calcProductCost;
        g.packaging   += o.calcPackaging;
        g.grossProfit += orderProfit;
        g.impostoTotal += orderTax;
        g.repasseConfirmado += orderRepasse;
      } else if (isEstimatedRevenue) {
        g.pendingOrderCount += 1;
        g.pendingQty += o.quantity;
        g.gmvEstimado += o.calcGmv;
        g.estimatedProfit += orderProfit;
        g.impostoEstimado += orderTax;
        g.custoEstimado += (o.calcProductCost ?? 0) + (o.calcPackaging ?? 0);
        g.repasseEstimado += orderRepasse;
      }
      if (!o.hasCost)                    g.hasCost   = false;
      if (isEstimatedRevenue) g.hasPending = true;
      g.orders.push({
        orderId:       o.orderId,
        soldAt:        o.soldAt,
        quantity:      o.quantity,
        calcGmv:       r2(o.calcGmv),
        escrowAmount:  o.escrowAmount,
        orderCategory: o.orderCategory,
        variationName: o.variationName ?? null,
        repasse:       orderRepasse,
        estimated:     isEstimatedRevenue,
      });

      // Quebra adicional por variação real (ProductVariant)
      if (o.variantId) {
        if (!g.variantMap.has(o.variantId)) {
          g.variantMap.set(o.variantId, {
            variantId: o.variantId,
            name: o.variant?.name ?? o.variationName ?? null,
            sku:  o.variant?.sku  ?? o.skuVariacao ?? null,
            hasCost: true, hasPending: false,
            orderCount: 0, qty: 0, pendingOrderCount: 0, pendingQty: 0,
            gmv: 0, shopeeFee: 0, netRevenue: 0,
            productCost: 0, packaging: 0, grossProfit: 0, estimatedProfit: 0,
            gmvEstimado: 0, impostoEstimado: 0, custoEstimado: 0,
            repasseConfirmado: 0, repasseEstimado: 0, impostoTotal: 0,
            orders: [],
          });
        }
        const v = g.variantMap.get(o.variantId);
        if (hasConfirmedRepasse) {
          v.orderCount  += 1;
          v.qty         += o.quantity;
          v.gmv         += o.calcGmv;
          v.shopeeFee   += orderFee;
          v.netRevenue  += orderRepasse;
          v.productCost += o.calcProductCost;
          v.packaging   += o.calcPackaging;
          v.grossProfit += orderProfit;
          v.impostoTotal += orderTax;
          v.repasseConfirmado += orderRepasse;
        } else if (isEstimatedRevenue) {
          v.pendingOrderCount += 1;
          v.pendingQty += o.quantity;
          v.gmvEstimado += o.calcGmv;
          v.estimatedProfit += orderProfit;
          v.impostoEstimado += orderTax;
          v.custoEstimado += (o.calcProductCost ?? 0) + (o.calcPackaging ?? 0);
          v.repasseEstimado += orderRepasse;
        }
        if (!o.hasCost)                    v.hasCost   = false;
        if (isEstimatedRevenue) v.hasPending = true;
        v.orders.push({
          orderId:       o.orderId,
          soldAt:        o.soldAt,
          quantity:      o.quantity,
          calcGmv:       r2(o.calcGmv),
          escrowAmount:  o.escrowAmount,
          orderCategory: o.orderCategory,
          variationName: o.variationName ?? null,
          repasse:       orderRepasse,
          estimated:     isEstimatedRevenue,
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
  const resultadoLiquido = r2(grossProfit);
  const margem           = repasseConfirmado > 0 ? r2((resultadoLiquido / repasseConfirmado) * 100) : 0;
  const resultadoEstimado = r2(estimatedGrossProfit);
  const impostoEstimadoTotal = r2(estimatedTaxAmount);
  const custoEstimadoTotal = r2(estimatedProductCost + estimatedPackagingCost);

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
      margin:       g.repasseConfirmado > 0 ? r2((g.grossProfit / g.repasseConfirmado) * 100) : 0,
      estimatedProfit: r2(g.estimatedProfit),
      gmvEstimado:     r2(g.gmvEstimado),
      impostoEstimado: r2(g.impostoEstimado),
      custoEstimado:   r2(g.custoEstimado),
      pendingOrderCount: g.pendingOrderCount,
      pendingQty:        g.pendingQty,
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
          margin:       v.repasseConfirmado > 0 ? r2((v.grossProfit / v.repasseConfirmado) * 100) : 0,
          estimatedProfit: r2(v.estimatedProfit),
          gmvEstimado:     r2(v.gmvEstimado),
          impostoEstimado: r2(v.impostoEstimado),
          custoEstimado:   r2(v.custoEstimado),
          pendingOrderCount: v.pendingOrderCount,
          pendingQty:        v.pendingQty,
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
    returnedCost:     r2(returnedCost),
    orphanCount:      groups.filter(g => !g.hasCost).length,

    // ── Novo modelo: repasse / imposto / resultado líquido ──────────────────
    repasseConfirmado: r2(repasseConfirmado),
    repasseEstimado:   r2(repasseEstimado),
    repasseTotal,
    impostoTotal,
    custoTotal,
    resultadoLiquido,
    margem,
    resultadoEstimado,
    impostoEstimadoTotal,
    custoEstimadoTotal,
    gmvEstimado: r2(gmvPending),
    pendentes: {
      count: pendingCount,
      gmv: r2(gmvPending),
      estimatedRepasse: r2(repasseEstimado),
      estimatedProfit: resultadoEstimado,
      estimatedTax: impostoEstimadoTotal,
      estimatedCost: custoEstimadoTotal,
    },

    // Listas para drawers (devolucoes/cancelamentos/pendentes)
    returnedOrdersList,
    cancelledOrdersList,
    pendingOrdersList,

    groups,
  };
}

async function buildClosingData(storeIds, month) {
  const { year: y, month: mo } = parseYearMonth(month);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const start = spToUtc(y, mo, 1);
  const end = spToUtc(y, mo, lastDay, 23, 59, 59, 999);

  const stores = await prisma.store.findMany({
    where: { id: { in: storeIds } },
    select: { id: true, marketplace: true, taxType: true, taxRate: true, fixedMonthlyTax: true },
  });
  const fixedTaxAmount = r2(stores
    .filter(s => s.taxType === 'mei')
    .reduce((sum, s) => sum + (s.fixedMonthlyTax ?? 0), 0));
  const storeTaxRateMap = new Map(stores.map(s => [s.id, s.taxRate ?? 0]));
  const storeMarketplaceMap = new Map(stores.map(s => [s.id, s.marketplace ?? '']));
  const shopeeStoreIds = stores.filter(s => String(s.marketplace ?? '').toLowerCase() === 'shopee').map(s => s.id);
  const nonEscrowStoreIds = stores.filter(s => String(s.marketplace ?? '').toLowerCase() !== 'shopee').map(s => s.id);

  const includeProduct = {
    product: { select: { id: true, parentId: true, name: true, sku: true, costPrice: true, packaging: true, parent: { select: { id: true, name: true, sku: true, costPrice: true } } } },
    variant: { select: { id: true, name: true, sku: true, costPrice: true } },
  };

  const financialOrders = await prisma.order.findMany({
    where: {
      orderCategory: { in: FINANCIAL_REVENUE_CATEGORIES },
      orderPaidAt: { gte: start, lte: end },
      OR: [
        { storeId: { in: shopeeStoreIds }, escrowAmount: { not: null } },
        { storeId: { in: nonEscrowStoreIds } },
      ],
    },
    include: includeProduct,
  });

  const soldAtOrders = await prisma.order.findMany({
    where: { storeId: { in: storeIds }, soldAt: { gte: start, lte: end } },
    include: includeProduct,
  });

  const financialRowIds = new Set(financialOrders.map(o => o.id));
  const allOrders = [
    ...financialOrders,
    ...soldAtOrders.filter(o => !financialRowIds.has(o.id)),
  ];

  const soldAtFinancialRows = soldAtOrders.filter(o => hasSettledRevenue(o, storeMarketplaceMap));
  const soldInPeriodPaidOutsideRows = soldAtFinancialRows.filter(o => !inRange(o.orderPaidAt, start, end));
  const paidInPeriodSoldOutsideRows = financialOrders.filter(o => !inRange(o.soldAt, start, end));
  const returnedPartialRows = financialOrders.filter(o => o.orderCategory === 'returned_partial');
  const salesPerformance = buildSalesPerformance(soldAtOrders, storeMarketplaceMap);

  const competence = {
    basis: 'repasse',
    basisField: 'orderPaidAt',
    operationalField: 'soldAt',
    financial: summarizeLines(financialOrders, storeTaxRateMap, storeMarketplaceMap),
    soldInPeriod: summarizeLines(soldAtFinancialRows, storeTaxRateMap, storeMarketplaceMap),
    soldInPeriodPaidOutside: {
      ...summarizeLines(soldInPeriodPaidOutsideRows, storeTaxRateMap, storeMarketplaceMap),
      ordersList: soldInPeriodPaidOutsideRows.map(o => auditOrder(o, storeTaxRateMap, storeMarketplaceMap)),
    },
    paidInPeriodSoldOutside: {
      ...summarizeLines(paidInPeriodSoldOutsideRows, storeTaxRateMap, storeMarketplaceMap),
      ordersList: paidInPeriodSoldOutsideRows.map(o => auditOrder(o, storeTaxRateMap, storeMarketplaceMap)),
    },
    returnedPartial: {
      ...summarizeLines(returnedPartialRows, storeTaxRateMap, storeMarketplaceMap),
      ordersList: returnedPartialRows.map(o => auditOrder(o, storeTaxRateMap, storeMarketplaceMap)),
    },
  };
  competence.hasShift = competence.soldInPeriodPaidOutside.orders > 0 || competence.paidInPeriodSoldOutside.orders > 0;

  const operational = {
    createdOrders: new Set(soldAtOrders.map(orderKey).filter(Boolean)).size,
    createdLines: soldAtOrders.length,
    createdUnits: soldAtOrders.reduce((sum, o) => sum + (o.quantity ?? 0), 0),
    createdSalesTotal: summarizeLines(soldAtOrders, storeTaxRateMap, storeMarketplaceMap).salesTotal,
  };

  let gmvTotal = 0, gmvConfirmed = 0, gmvPending = 0;
  let shopeeDeductions = 0, sellerDiscounts = 0, netRevenue = 0;
  let taxAmount = 0, productCost = 0, packagingCost = 0, grossProfit = 0;
  let estimatedTaxAmount = 0, estimatedProductCost = 0, estimatedPackagingCost = 0, estimatedGrossProfit = 0;
  let repasseConfirmado = 0, repasseEstimado = 0;
  let cancelledGmv = 0, returnedValue = 0, returnedCost = 0;
  let unitCount = 0;
  let confirmedLineCount = 0, pendingLineCount = 0, cancelledLineCount = 0, returnedLineCount = 0;
  const confirmedOrderIds = new Set();
  const pendingOrderIds = new Set();
  const estimatedReliableOrderIds = new Set();
  const estimatedUnreliableOrderIds = new Set();
  const cancelledOrderIds = new Set();
  const returnedOrderIds = new Set();
  const revenueOrderIds = new Set();
  let revenueLineCount = 0;
  let revenueUnitCount = 0;

  const groupMap = new Map();
  const returnedOrdersList = [];
  const cancelledOrdersList = [];
  const pendingOrdersList = [];

  for (const o of allOrders) {
    const hasConfirmedRepasse = financialRowIds.has(o.id);
    const isPending = o.orderCategory === 'pending';
    const isEstimatedRevenue = isPending || (
      FINANCIAL_REVENUE_CATEGORIES.includes(o.orderCategory)
      && !hasConfirmedRepasse
      && !hasSettledRevenue(o, storeMarketplaceMap)
    );
    const isRevenue = hasConfirmedRepasse || isEstimatedRevenue;
    const isCancelled = !hasConfirmedRepasse && o.orderCategory.startsWith('cancelled');
    const isReturned = o.orderCategory === 'returned_full' || o.orderCategory === 'returned_partial';
    const { orderFee, orderDisc, repasse: orderRepasse, tax: orderTax, profit: orderProfit } = calcLine(o, storeTaxRateMap, storeMarketplaceMap);
    const hasReliableEstimate = orderRepasse !== null && orderRepasse !== undefined && orderProfit !== null && orderProfit !== undefined;

    if (hasConfirmedRepasse) {
      confirmedLineCount++;
      addUniqueOrder(confirmedOrderIds, o);
    } else if (isPending || isEstimatedRevenue) {
      pendingLineCount++;
      addUniqueOrder(pendingOrderIds, o);
    } else if (isCancelled) {
      cancelledLineCount++;
      addUniqueOrder(cancelledOrderIds, o);
    }
    if (isReturned) {
      returnedLineCount++;
      addUniqueOrder(returnedOrderIds, o);
    }

    if (isCancelled) {
      cancelledOrdersList.push({
        id: o.id, orderId: o.orderId, soldAt: o.soldAt, orderPaidAt: o.orderPaidAt,
        productName: o.productName, variationName: o.variationName,
        calcGmv: r2(o.calcGmv), cancelReason: o.cancelReason ?? null,
      });
    }
    if (isReturned) {
      returnedOrdersList.push({
        id: o.id, orderId: o.orderId, soldAt: o.soldAt, orderPaidAt: o.orderPaidAt,
        productName: o.productName, variationName: o.variationName,
        calcGmv: r2(o.calcGmv), escrowAmount: o.escrowAmount,
        orderCategory: o.orderCategory, returnStatus: o.returnStatus ?? null,
      });
    }
    if (isPending || (FINANCIAL_REVENUE_CATEGORIES.includes(o.orderCategory) && !hasConfirmedRepasse && !hasSettledRevenue(o, storeMarketplaceMap))) {
      if (hasReliableEstimate) addUniqueOrder(estimatedReliableOrderIds, o);
      else addUniqueOrder(estimatedUnreliableOrderIds, o);
      pendingOrdersList.push({
        id: o.id, orderId: o.orderId, soldAt: o.soldAt, orderPaidAt: o.orderPaidAt,
        productName: o.productName, variationName: o.variationName,
        calcGmv: r2(o.calcGmv), estimatedRepasse: orderRepasse,
        reason: hasReliableEstimate ? (isPending ? undefined : 'Aguardando repasse Shopee') : 'Sem base de repasse confiável',
      });
    }

    if (hasConfirmedRepasse) {
      gmvTotal += o.calcGmv;
      shopeeDeductions += orderFee;
      sellerDiscounts += orderDisc;
      netRevenue += orderRepasse;
      taxAmount += orderTax;
      productCost += o.calcProductCost;
      packagingCost += o.calcPackaging;
      grossProfit += orderProfit;
      unitCount += o.quantity;
      gmvConfirmed += o.calcGmv;
      repasseConfirmado += orderRepasse;
    } else if (isEstimatedRevenue) {
      gmvPending += o.calcGmv;
      if (hasReliableEstimate) {
        repasseEstimado += orderRepasse;
        estimatedTaxAmount += orderTax;
        estimatedProductCost += o.calcProductCost;
        estimatedPackagingCost += o.calcPackaging;
        estimatedGrossProfit += orderProfit;
      }
    }
    if (isCancelled) cancelledGmv += o.calcGmv;
    if (isReturned) {
      returnedValue += o.calcGmv;
      returnedCost += (o.calcProductCost ?? 0) + (o.calcPackaging ?? 0);
    }

    if (!isRevenue) continue;

    revenueLineCount++;
    revenueUnitCount += o.quantity ?? 0;
    addUniqueOrder(revenueOrderIds, o);

    const key = productGroupKey(o);

    if (!groupMap.has(key)) {
      groupMap.set(key, {
        productId: o.productId,
        catalogProductId: catalogProductId(o),
        salesKey: key,
        productName: o.product?.parent?.name ?? o.product?.name ?? o.productName ?? '(sem nome)',
        sku: o.product?.sku ?? o.skuVariacao ?? o.skuPrincipal ?? '',
        variationName: o.variationName ?? null,
        hasCost: true, hasPending: false,
        orderCount: 0, qty: 0, pendingOrderCount: 0, pendingQty: 0,
        orderIds: new Set(), pendingOrderIds: new Set(),
        gmv: 0, shopeeFee: 0, netRevenue: 0,
        productCost: 0, packaging: 0, grossProfit: 0, estimatedProfit: 0,
        gmvEstimado: 0, impostoEstimado: 0, custoEstimado: 0,
        repasseConfirmado: 0, repasseEstimado: 0, impostoTotal: 0,
        orders: [],
        variantMap: new Map(),
      });
    }
    const g = groupMap.get(key);
    if (hasConfirmedRepasse) {
      addUniqueOrder(g.orderIds, o);
      g.orderCount = g.orderIds.size;
      g.qty += o.quantity;
      g.gmv += o.calcGmv;
      g.shopeeFee += orderFee;
      g.netRevenue += orderRepasse;
      g.productCost += o.calcProductCost;
      g.packaging += o.calcPackaging;
      g.grossProfit += orderProfit;
      g.impostoTotal += orderTax;
      g.repasseConfirmado += orderRepasse;
    } else if (isEstimatedRevenue) {
      addUniqueOrder(g.pendingOrderIds, o);
      g.pendingOrderCount = g.pendingOrderIds.size;
      g.pendingQty += o.quantity;
      g.gmvEstimado += o.calcGmv;
      if (hasReliableEstimate) {
        g.estimatedProfit += orderProfit;
        g.impostoEstimado += orderTax;
        g.custoEstimado += (o.calcProductCost ?? 0) + (o.calcPackaging ?? 0);
        g.repasseEstimado += orderRepasse;
      }
    }
    if (!hasCurrentCost(o)) g.hasCost = false;
    if (isEstimatedRevenue) g.hasPending = true;
    g.orders.push({
      orderId: o.orderId,
      soldAt: o.soldAt,
      orderPaidAt: o.orderPaidAt,
      quantity: o.quantity,
      calcGmv: r2(o.calcGmv),
      escrowAmount: o.escrowAmount,
      orderCategory: o.orderCategory,
      variationName: o.variationName ?? null,
      repasse: orderRepasse,
      estimated: isEstimatedRevenue,
    });

    const vKey = variationKey(o);
    if (vKey) {
      if (!g.variantMap.has(vKey)) {
        g.variantMap.set(vKey, {
          salesKey: `${key}|${vKey}`,
          variantId: o.variantId,
          name: o.variant?.name ?? o.variationName ?? null,
          sku: o.variant?.sku ?? o.skuVariacao ?? null,
          hasCost: true, hasPending: false,
          orderCount: 0, qty: 0, pendingOrderCount: 0, pendingQty: 0,
          orderIds: new Set(), pendingOrderIds: new Set(),
          gmv: 0, shopeeFee: 0, netRevenue: 0,
          productCost: 0, packaging: 0, grossProfit: 0, estimatedProfit: 0,
          gmvEstimado: 0, impostoEstimado: 0, custoEstimado: 0,
          repasseConfirmado: 0, repasseEstimado: 0, impostoTotal: 0,
          orders: [],
        });
      }
      const v = g.variantMap.get(vKey);
      if (hasConfirmedRepasse) {
        addUniqueOrder(v.orderIds, o);
        v.orderCount = v.orderIds.size;
        v.qty += o.quantity;
        v.gmv += o.calcGmv;
        v.shopeeFee += orderFee;
        v.netRevenue += orderRepasse;
        v.productCost += o.calcProductCost;
        v.packaging += o.calcPackaging;
        v.grossProfit += orderProfit;
        v.impostoTotal += orderTax;
        v.repasseConfirmado += orderRepasse;
      } else if (isEstimatedRevenue) {
        addUniqueOrder(v.pendingOrderIds, o);
        v.pendingOrderCount = v.pendingOrderIds.size;
        v.pendingQty += o.quantity;
        v.gmvEstimado += o.calcGmv;
        if (hasReliableEstimate) {
          v.estimatedProfit += orderProfit;
          v.impostoEstimado += orderTax;
          v.custoEstimado += (o.calcProductCost ?? 0) + (o.calcPackaging ?? 0);
          v.repasseEstimado += orderRepasse;
        }
      }
      if (!hasCurrentCost(o)) v.hasCost = false;
      if (isEstimatedRevenue) v.hasPending = true;
      v.orders.push({
        orderId: o.orderId,
        soldAt: o.soldAt,
        orderPaidAt: o.orderPaidAt,
        quantity: o.quantity,
        calcGmv: r2(o.calcGmv),
        escrowAmount: o.escrowAmount,
        orderCategory: o.orderCategory,
        variationName: o.variationName ?? null,
        repasse: orderRepasse,
        estimated: isEstimatedRevenue,
      });
    }
  }

  const revenueGmvTotal = r2(gmvConfirmed + gmvPending);
  const confirmedSalesTotal = r2(gmvConfirmed);
  const pendingSalesTotal = r2(gmvPending);

  grossProfit -= fixedTaxAmount;
  const avgMargin = confirmedSalesTotal > 0 ? (grossProfit / confirmedSalesTotal) * 100 : 0;
  const repasseTotal = r2(repasseConfirmado + repasseEstimado);
  const impostoTotal = r2(taxAmount);
  const custoTotal = r2(productCost + packagingCost);
  const resultadoLiquido = r2(grossProfit);
  const margem = confirmedSalesTotal > 0 ? r2((resultadoLiquido / confirmedSalesTotal) * 100) : 0;
  const resultadoEstimado = r2(estimatedGrossProfit);
  const impostoEstimadoTotal = r2(estimatedTaxAmount);
  const custoEstimadoTotal = r2(estimatedProductCost + estimatedPackagingCost);

  const sortOrders = (orders) => orders.slice().sort((a, b) => new Date(a.orderPaidAt ?? a.soldAt) - new Date(b.orderPaidAt ?? b.soldAt));
  const groups = [...groupMap.values()]
    .map(g => {
      const sales = salesPerformance.byGroup.get(g.salesKey);
      return {
      productId: g.productId,
      catalogProductId: g.catalogProductId,
      salesKey: g.salesKey,
      productName: g.productName,
      sku: g.sku,
      variationName: g.variationName,
      hasCost: g.hasCost,
      hasPending: g.hasPending,
      orderCount: g.orderCount,
      qty: g.qty,
      gmv: r2(g.gmv),
      shopeeFee: r2(g.shopeeFee),
      netRevenue: r2(g.netRevenue),
      productCost: r2(g.productCost),
      packaging: r2(g.packaging),
      grossProfit: r2(g.grossProfit),
      margin: g.gmv > 0 ? r2((g.grossProfit / g.gmv) * 100) : 0,
      estimatedProfit: r2(g.estimatedProfit),
      gmvEstimado: r2(g.gmvEstimado),
      impostoEstimado: r2(g.impostoEstimado),
      custoEstimado: r2(g.custoEstimado),
      pendingOrderCount: g.pendingOrderCount,
      pendingQty: g.pendingQty,
      repasseConfirmado: r2(g.repasseConfirmado),
      repasseEstimado: r2(g.repasseEstimado),
      impostoTotal: r2(g.impostoTotal),
      salesOrderCount: sales?.orderIds?.size ?? 0,
      salesQty: sales?.qty ?? 0,
      salesConfirmedQty: sales?.confirmedQty ?? 0,
      salesPendingQty: sales?.pendingQty ?? 0,
      salesGmv: r2(sales?.gmv ?? 0),
      salesConfirmedGmv: r2(sales?.confirmedGmv ?? 0),
      salesPendingGmv: r2(sales?.pendingGmv ?? 0),
      salesReturnedPartialQty: sales?.returnedPartialQty ?? 0,
      orders: sortOrders(g.orders),
      variants: [...g.variantMap.values()]
        .map(v => {
          const vSales = salesPerformance.byVariation.get(v.salesKey);
          return {
          salesKey: v.salesKey,
          variantId: v.variantId,
          name: v.name,
          sku: v.sku,
          hasCost: v.hasCost,
          hasPending: v.hasPending,
          orderCount: v.orderCount,
          qty: v.qty,
          gmv: r2(v.gmv),
          shopeeFee: r2(v.shopeeFee),
          netRevenue: r2(v.netRevenue),
          productCost: r2(v.productCost),
          packaging: r2(v.packaging),
          grossProfit: r2(v.grossProfit),
          margin: v.gmv > 0 ? r2((v.grossProfit / v.gmv) * 100) : 0,
          estimatedProfit: r2(v.estimatedProfit),
          gmvEstimado: r2(v.gmvEstimado),
          impostoEstimado: r2(v.impostoEstimado),
          custoEstimado: r2(v.custoEstimado),
          pendingOrderCount: v.pendingOrderCount,
          pendingQty: v.pendingQty,
          repasseConfirmado: r2(v.repasseConfirmado),
          repasseEstimado: r2(v.repasseEstimado),
          impostoTotal: r2(v.impostoTotal),
          salesOrderCount: vSales?.orderIds?.size ?? 0,
          salesQty: vSales?.qty ?? 0,
          salesConfirmedQty: vSales?.confirmedQty ?? 0,
          salesPendingQty: vSales?.pendingQty ?? 0,
          salesGmv: r2(vSales?.gmv ?? 0),
          salesConfirmedGmv: r2(vSales?.confirmedGmv ?? 0),
          salesPendingGmv: r2(vSales?.pendingGmv ?? 0),
          salesReturnedPartialQty: vSales?.returnedPartialQty ?? 0,
          orders: sortOrders(v.orders),
        };
        })
        .sort((a, b) => b.gmv - a.gmv),
    };
    })
    .sort((a, b) => b.gmv - a.gmv);

  const orphanGroups = groups.filter(g => !g.hasCost);
  const orphanCatalogIds = new Set(orphanGroups.map(g => g.catalogProductId ?? g.productId).filter(Boolean));
  const orphanLinkedGmv = orphanGroups
    .filter(g => g.catalogProductId ?? g.productId)
    .reduce((sum, g) => sum + (g.gmv ?? 0) + (g.gmvEstimado ?? 0), 0);
  const orphanUnlinkedGroups = orphanGroups.filter(g => !(g.catalogProductId ?? g.productId));
  const orphanUnlinkedGmv = orphanUnlinkedGroups.reduce((sum, g) => sum + (g.gmv ?? 0) + (g.gmvEstimado ?? 0), 0);

  return {
    totalOrders: revenueOrderIds.size,
    totalLineCount: revenueLineCount,
    confirmedOrders: confirmedOrderIds.size,
    confirmedLineCount,
    pendingOrders: pendingOrderIds.size,
    pendingLineCount,
    cancelledOrders: cancelledOrderIds.size,
    cancelledLineCount,
    returnedOrders: returnedOrderIds.size,
    returnedLineCount,
    unitCount: revenueUnitCount,
    gmvTotal: revenueGmvTotal,
    gmvConfirmed: confirmedSalesTotal,
    gmvPending: pendingSalesTotal,
    shopeeDeductions: r2(shopeeDeductions),
    sellerDiscounts: r2(sellerDiscounts),
    netRevenue: r2(netRevenue),
    taxAmount: r2(taxAmount),
    fixedTaxAmount,
    productCost: r2(productCost),
    packagingCost: r2(packagingCost),
    grossProfit: r2(grossProfit),
    avgMargin: r2(avgMargin),
    cancelledGmv: r2(cancelledGmv),
    returnedValue: r2(returnedValue),
    returnedCost: r2(returnedCost),
    orphanCount: orphanGroups.length,
    costIssues: {
      totalGroups: orphanGroups.length,
      catalogProducts: orphanCatalogIds.size,
      linkedGroups: orphanGroups.length - orphanUnlinkedGroups.length,
      unlinkedGroups: orphanUnlinkedGroups.length,
      linkedGmv: r2(orphanLinkedGmv),
      unlinkedGmv: r2(orphanUnlinkedGmv),
      gmv: r2(orphanLinkedGmv + orphanUnlinkedGmv),
    },
    operational,
    competence,

    repasseConfirmado: r2(repasseConfirmado),
    repasseEstimado: r2(repasseEstimado),
    repasseTotal,
    impostoTotal,
    custoTotal,
    resultadoLiquido,
    margem,
    resultadoEstimado,
    impostoEstimadoTotal,
    custoEstimadoTotal,
    gmvEstimado: r2(gmvPending),
    pendentes: {
      count: pendingOrderIds.size,
      lineCount: pendingLineCount,
      reliableCount: estimatedReliableOrderIds.size,
      unreliableCount: estimatedUnreliableOrderIds.size,
      gmv: r2(gmvPending),
      estimatedRepasse: r2(repasseEstimado),
      estimatedProfit: resultadoEstimado,
      estimatedTax: impostoEstimadoTotal,
      estimatedCost: custoEstimadoTotal,
    },

    returnedOrdersList,
    cancelledOrdersList,
    pendingOrdersList,

    groups,
    salesPerformance: salesPerformance.list,
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
    const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true, marketplace: true } });
    const storeIds = stores.map(s => s.id);
    if (!storeIds.length) return res.json({ orders: [] });
    const shopeeStoreIds = stores.filter(s => String(s.marketplace ?? '').toLowerCase() === 'shopee').map(s => s.id);
    const nonEscrowStoreIds = stores.filter(s => String(s.marketplace ?? '').toLowerCase() !== 'shopee').map(s => s.id);

    const { year: y, month: mo } = parseYearMonth(month);
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const start = spToUtc(y, mo, 1);
    const end   = spToUtc(y, mo, lastDay, 23, 59, 59, 999);

    const where = {
      storeId: { in: storeIds },
      productId,
      OR: [
        {
          orderCategory: { in: FINANCIAL_REVENUE_CATEGORIES },
          orderPaidAt: { gte: start, lte: end },
          OR: [
            { storeId: { in: shopeeStoreIds }, escrowAmount: { not: null } },
            { storeId: { in: nonEscrowStoreIds } },
          ],
        },
        {
          orderCategory: 'pending',
          soldAt: { gte: start, lte: end },
        },
        {
          orderCategory: { in: FINANCIAL_REVENUE_CATEGORIES },
          escrowAmount: null,
          soldAt: { gte: start, lte: end },
          storeId: { in: shopeeStoreIds },
        },
      ],
    };
    if (variantId) where.variantId = variantId;

    const orders = await prisma.order.findMany({
      where,
      orderBy: [{ orderPaidAt: 'asc' }, { soldAt: 'asc' }],
      select: {
        storeId: true, orderId: true, orderCategory: true, soldAt: true, orderPaidAt: true, calcGmv: true,
        calcNetRevenue: true,
        escrowAmount: true, platformCommission: true, platformServiceFee: true,
        sellerCoupon: true, lmmDiscount: true,
      },
    });

    const storeMarketplaceMap = new Map(stores.map(s => [s.id, s.marketplace ?? '']));
    const list = orders.map(o => {
      const isConfirmed = hasSettledRevenue(o, storeMarketplaceMap) && inRange(o.orderPaidAt, start, end);
      const orderFee  = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
      const orderDisc = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
      const orderNet  = r2(o.calcGmv - orderFee - orderDisc);
      const repasse   = isConfirmed && o.escrowAmount != null
        ? r2(o.escrowAmount)
        : r2(o.calcNetRevenue ?? orderNet);

      return {
        orderSn: o.orderId,
        soldAt:  o.soldAt,
        orderPaidAt: o.orderPaidAt,
        valor:   r2(o.calcGmv),
        status:  isConfirmed ? 'Liquidado' : 'Aguardando repasse',
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

    const closings = await prisma.monthlyClosing.findMany({
      where: { storeId: { in: storeIds }, periodMonth: month, status: 'closed' },
      orderBy: { closedAt: 'desc' },
    });

    if (storeId && closings.length > 0) {
      const data = snapshotToClosingData(closings[0]);
      return res.json({
        status: 'closed',
        closedAt: closings[0].closedAt,
        closedBy: closings[0].closedBy,
        data,
        groups: data.groups,
      });
    }

    if (!storeId && closings.length === storeIds.length) {
      const data = combineClosingData(closings.map(snapshotToClosingData));
      return res.json({
        status: 'closed',
        closedAt: closings[0]?.closedAt ?? null,
        closedBy: closings[0]?.closedBy ?? null,
        data,
        groups: data.groups,
      });
    }

    const computed = await buildClosingData(storeIds, month);
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
    const storeIds = stores.map(s => s.id);

    const existingClosings = await prisma.monthlyClosing.findMany({
      where: { storeId: { in: storeIds }, periodMonth: month, status: 'closed' },
      select: { storeId: true, closedAt: true },
    });
    if (storeId && existingClosings.length > 0) {
      return res.status(409).json({
        error: `Mes ${month} ja foi fechado em ${fmtDateTime(existingClosings[0].closedAt)}`,
        closedAt: existingClosings[0].closedAt,
      });
    }
    if (!storeId && existingClosings.length === storeIds.length) {
      return res.status(409).json({
        error: `Mes ${month} ja foi fechado para todas as lojas`,
        closedAt: existingClosings[0]?.closedAt ?? null,
      });
    }

    const closedAt = new Date();
    const results = [];
    for (const sid of storeIds) {
      await recalculateOrdersForStore(sid, month, { dateBasis: 'paidOrSold' });
      const d = await buildClosingData([sid], month);
      const closing = await prisma.monthlyClosing.upsert({
        where: { storeId_periodMonth: { storeId: sid, periodMonth: month } },
        create: {
          storeId: sid, periodMonth: month,
          closedAt, closedBy: req.userId, status: 'closed',
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
          closedAt, closedBy: req.userId, status: 'closed',
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
      results.push({ closing, data: d });
    }

    const data = storeId ? results[0].data : combineClosingData(results.map(r => r.data));
    return res.json({ success: true, closedAt, data });
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
    const storeIds = stores.map(s => s.id);

    // Deleta para TODAS as lojas filtradas (não só a primeira)
    await prisma.monthlyClosing.deleteMany({ where: { storeId: { in: storeIds }, periodMonth: month } });
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
  const totalOrd  = d.totalOrders ?? (d.confirmedOrders + d.pendingOrders + d.cancelledOrders + d.returnedOrders);
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
    ['Pedidos confirmados:', d.confirmedOrders,            'Unidades confirmadas:', d.unitCount],
    ['Sem repasse:',         d.pendingOrders,              'Cancelamentos:',        d.cancelledOrders],
    ['Potencial pendente:',  fmtBRLpdf(d.repasseEstimado), 'Devolucoes:',           d.returnedOrders],
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
  const aliquota  = d.gmvTotal > 0 ? r2((d.impostoTotal / d.gmvTotal) * 100) : 0;
  const aliqStr   = String(aliquota).replace('.', ',');
  const taxLabel  = `(-) Imposto (aliquota ${aliqStr}% s/ faturamento)`;

  const dreRows  = [
    { l: 'Repasse confirmado',                        v: fmtBRLpdf(d.repasseConfirmado) + ` (${d.confirmedOrders} liquidados)`, bold: false, sepBefore: false },
    { l: '(+) Potencial estimado',                    v: fmtBRLpdf(d.repasseEstimado)   + ` (${d.pendingOrders} sem repasse)`, bold: false, sepBefore: false },
    { l: '(=) Total previsto (confirmado + estimado)', v: fmtBRLpdf(d.repasseTotal),                                           bold: true,  sepBefore: true  },
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
  ds(ML, y, 'RESULTADO CONFIRMADO:');
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
    ds(ML, y, `! ${d.pendentes.count} pedido(s) sem repasse (${fmtBRLpdf(d.pendentes.estimatedRepasse)} estimado) — nao entra no resultado confirmado`);
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
        d = snapshotToClosingData(closing);
      } else {
        d = await buildClosingData([store.id], month);
      }

      renderStoreSection(doc, store, d, month, { isClosed, closedAt });

    } else {
      // ── CONSOLIDATED MULTI-STORE PATH (Fix 2) ──────────────────────────────
      const allStoreIds = stores.map(s => s.id);

      // Parallel: consolidated total + per-store breakdown
      const [consolidatedData, ...storeDataArr] = await Promise.all([
        buildClosingData(allStoreIds, month),
        ...stores.map(s => buildClosingData([s.id], month)),
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
      const totalOrd  = d.totalOrders ?? (d.confirmedOrders + d.pendingOrders + d.cancelledOrders + d.returnedOrders);
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
        ['Pedidos confirmados:', d.confirmedOrders,            'Unidades confirmadas:', d.unitCount],
        ['Sem repasse:',         d.pendingOrders,              'Cancelamentos:',        d.cancelledOrders],
        ['Potencial pendente:',  fmtBRLpdf(d.repasseEstimado), 'Devolucoes:',           d.returnedOrders],
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
      const aliquota = d.gmvTotal > 0 ? r2((d.impostoTotal / d.gmvTotal) * 100) : 0;
      const aliqStr  = String(aliquota).replace('.', ',');
      const taxLabel = `(-) Imposto (aliquota ${aliqStr}% s/ faturamento)`;

      const dreRows = [
        { l: 'Repasse confirmado',                        v: fmtBRLpdf(d.repasseConfirmado) + ` (${d.confirmedOrders} liquidados)`, bold: false, sepBefore: false },
        { l: '(+) Potencial estimado',                    v: fmtBRLpdf(d.repasseEstimado)   + ` (${d.pendingOrders} sem repasse)`, bold: false, sepBefore: false },
        { l: '(=) Total previsto (confirmado + estimado)', v: fmtBRLpdf(d.repasseTotal),                                           bold: true,  sepBefore: true  },
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

      // 4. RESULTADO CONFIRMADO TOTAL
      y += 8;
      doc.font('Helvetica-Bold').fontSize(12).fillColor('black');
      ds(ML, y, 'RESULTADO CONFIRMADO TOTAL:');
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
        ds(ML, y, `! ${d.pendentes.count} pedido(s) sem repasse (${fmtBRLpdf(d.pendentes.estimatedRepasse)} estimado) — nao entra no resultado confirmado`);
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
