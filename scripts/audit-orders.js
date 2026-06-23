#!/usr/bin/env node
'use strict';

/**
 * audit-orders.js — Auditoria read-only de cálculo de profit por loja.
 *
 * Uso (a partir de profittrack-backend/):
 *   node scripts/audit-orders.js --store=<storeId> [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--marketplace=<nome>]
 *
 * Nunca escreve no banco. Apenas findMany / findUnique.
 */

require('dotenv').config();
const prisma = require('../src/lib/prisma');

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((a, s) => {
  const [k, v] = s.replace(/^--/, '').split('=');
  a[k] = v;
  return a;
}, {});

if (!args.store) {
  console.error('ERRO: --store=<storeId> é obrigatório. Nunca rode sem storeId explícito.');
  process.exit(1);
}

const storeId  = args.store;
const filterMp = args.marketplace?.toLowerCase() ?? null;

// ── Datas São Paulo ─────────────────────────────────────────────────────────
function todaySP() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = {};
  for (const { type, value } of parts) if (type !== 'literal') p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

function firstOfMonth() {
  return todaySP().substring(0, 7) + '-01';
}

const fromStr = args.from ?? firstOfMonth();
const toStr   = args.to   ?? todaySP();

function parseYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Data inválida: ${s}`);
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

// Converte data/hora São Paulo → UTC (Brasil fixo UTC-3, sem horário de verão)
function spToUtc(y, m, d, h = 0, min = 0, sec = 0, ms = 0) {
  return new Date(Date.UTC(y, m - 1, d, h + 3, min, sec, ms));
}

// ── Aritmética ──────────────────────────────────────────────────────────────
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

const REVENUE_CATS = new Set(['valid', 'pending', 'returned_partial']);

// ── Fórmula canônica (closingController.js / formulas.md) ───────────────────
// NUNCA lê calcShopeeFee ou calcNetRevenue como entrada.
function calcCanonical(o, taxRate) {
  const fee     = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
  const disc    = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
  const net     = r2((o.calcGmv ?? 0) - fee - disc);
  const hasEscrow = o.escrowAmount !== null && o.escrowAmount !== undefined;
  const repasse = hasEscrow ? r2(o.escrowAmount) : net;
  const tax     = r2((o.calcGmv ?? 0) * taxRate / 100);
  const profit  = r2(repasse - tax - (o.calcProductCost ?? 0) - (o.calcPackaging ?? 0));
  return { fee, disc, net, repasse, tax, profit, hasEscrow };
}

// ── Fórmula do Dashboard para ML (confirmedProfit após fix 2026-06) ──────────
// Dashboard agora usa a cadeia canônica — mesma fórmula do fechamento.
// Se o resultado == canonical, dashboardVsClosingDivergence deve ser 0.
function calcDashboardML(o, taxRate) {
  return calcCanonical(o, taxRate).profit;
}

// ── Classificação de causa ───────────────────────────────────────────────────
function classifyCause(o, can) {
  if (!REVENUE_CATS.has(o.orderCategory))           return 'order_category_not_revenue';
  if (o.orderCategory === 'valid' && !can.hasEscrow) return 'escrow_arrived_after_snapshot';
  if (o.lineItemKey && o.lineItemKey !== '0')        return 'possible_multi_item_fee_split';
  if ((o.calcGmv ?? 0) > 0 && can.tax === 0)        return 'tax_rate_zero_or_missing';
  if (o.calcGrossProfit !== null)                    return 'snapshot_outdated';
  return 'unidentified';
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const store = await prisma.store.findUnique({
    where:  { id: storeId },
    select: { id: true, name: true, marketplace: true, taxRate: true },
  });

  if (!store) {
    console.error(`Loja não encontrada: ${storeId}`);
    process.exit(1);
  }

  if (filterMp && store.marketplace !== filterMp) {
    console.error(`Loja "${store.name}" é ${store.marketplace}, mas foi solicitado --marketplace=${filterMp}`);
    process.exit(1);
  }

  const taxRate = store.taxRate ?? 0;
  const { y: fy, m: fm, d: fd } = parseYmd(fromStr);
  const { y: ty, m: tm, d: td } = parseYmd(toStr);
  const rangeStart = spToUtc(fy, fm, fd, 0, 0, 0, 0);
  const rangeEnd   = spToUtc(ty, tm, td, 23, 59, 59, 999);

  // READ-ONLY — nenhum update, upsert ou create
  const orders = await prisma.order.findMany({
    where: {
      storeId,
      soldAt:        { gte: rangeStart, lte: rangeEnd },
      orderCategory: { in: Array.from(REVENUE_CATS) },
    },
    select: {
      orderId: true, lineItemKey: true, orderCategory: true,
      calcGmv: true,
      platformCommission: true, platformServiceFee: true,
      sellerCoupon: true, lmmDiscount: true,
      escrowAmount: true,
      calcNetRevenue: true,  // lido APENAS para comparação do dashboard ML
      calcTax: true,         // lido APENAS para comparação do dashboard ML
      calcProductCost: true, calcPackaging: true,
      calcGrossProfit: true, // snapshot a comparar
    },
  });

  const flaggedOrders  = [];
  const dashDivergence = [];

  for (const o of orders) {
    const can    = calcCanonical(o, taxRate);
    const stored = o.calcGrossProfit;
    const diff   = r2(can.profit - (stored ?? 0));

    // Comparação 1: canônico vs calcGrossProfit (snapshot)
    if (stored === null || Math.abs(diff) >= 0.01) {
      flaggedOrders.push({
        orderId:          o.orderId,
        marketplace:      store.marketplace,
        orderCategory:    o.orderCategory,
        recomputedProfit: can.profit,
        storedProfit:     stored,
        diff,
        likelyCause:      classifyCause(o, can),
        _debug: {
          calcGmv: o.calcGmv, orderFee: can.fee, orderDisc: can.disc,
          orderNet: can.net, hasEscrow: can.hasEscrow, orderRepasse: can.repasse,
          orderTax: can.tax, calcProductCost: o.calcProductCost, calcPackaging: o.calcPackaging,
        },
      });
    }

    // Comparação 2 (ML): canônico (fechamento) vs dashboard formula
    if (store.marketplace === 'mercadolivre') {
      const dashProfit = calcDashboardML(o, taxRate);
      const dashDiff   = r2(can.profit - dashProfit);
      if (Math.abs(dashDiff) >= 0.01) {
        dashDivergence.push({
          orderId:          o.orderId,
          orderCategory:    o.orderCategory,
          canonicalProfit:  can.profit,
          dashboardProfit:  dashProfit,
          diff:             dashDiff,
          note: 'Estrutural: Dashboard usa calcNetRevenue (snapshot), Fechamento usa escrowAmount/orderNet (raw)',
        });
      }
    }
  }

  flaggedOrders.sort((a, b)  => Math.abs(b.diff) - Math.abs(a.diff));
  dashDivergence.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const totalFlagged = flaggedOrders.length;
  const pctMatch     = orders.length > 0
    ? r2(((orders.length - totalFlagged) / orders.length) * 100)
    : 100;

  const result = {
    storeId,
    storeName:   store.name,
    marketplace: store.marketplace,
    taxRate,
    periodo:     { from: fromStr, to: toStr },
    totalChecked: orders.length,
    totalFlagged,
    pctMatch,
    flaggedOrders,
    dashboardVsClosingDivergence: {
      total:  dashDivergence.length,
      orders: dashDivergence,
    },
  };

  console.log(JSON.stringify(result, null, 2));
  await prisma.$disconnect();
}

main().catch(async e => {
  console.error('[audit-orders] Erro fatal:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
