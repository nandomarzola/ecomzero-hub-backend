const prisma = require('../lib/prisma');
const { calcOrderProfit } = require('./calculatorService');
const { randomUUID } = require('crypto');

// Progress em memória — sem Redis, sem BullMQ
// jobId → { pct, message, status, result, error }
const recalcProgress = new Map();

function r2(n) { return Math.round(n * 100) / 100; }

function orderMonth(order) {
  const d = new Date(order.soldAt || order.orderPaidAt || order.orderCreatedAt || order.createdAt);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ── Lógica principal do recálculo ─────────────────────────────────────────────
async function doRecalculate(jobId, userId, all, months) {
  const onProgress = (pct, message) => {
    recalcProgress.set(jobId, { pct, message, status: 'active' });
  };

  try {
    onProgress(5, 'Carregando pedidos...');

    const whereOrder = { store: { userId } };
    let monthsLabel  = 'todos';

    if (!all && Array.isArray(months) && months.length) {
      const dates = months.flatMap((m) => {
        const [y, mo] = m.split('-').map(Number);
        return [new Date(Date.UTC(y, mo - 1, 1)), new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999))];
      });
      whereOrder.soldAt = { gte: dates[0], lte: dates[dates.length - 1] };
      monthsLabel = months.join(', ');
    } else if (!all) {
      const now = new Date();
      const y   = now.getFullYear();
      const mo  = now.getMonth() + 1;
      whereOrder.soldAt = {
        gte: new Date(Date.UTC(y, mo - 1, 1)),
        lte: new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999)),
      };
      monthsLabel = `${y}-${String(mo).padStart(2, '0')}`;
    }

    const orders = await prisma.order.findMany({
      where:   whereOrder,
      include: {
        store:   { select: { taxRate: true, marketplace: true } },
        product: { select: { costPrice: true, packaging: true } },
      },
    });

    const total = orders.length;
    onProgress(15, `Recalculando ${total} pedidos...`);

    const summaryMap = new Map();

    function getSummary(month, storeId) {
      const key = `${storeId}::${month}`;
      if (!summaryMap.has(key)) {
        summaryMap.set(key, {
          storeId, month,
          gmv: 0, shopeeDeductions: 0, netRevenue: 0, tax: 0, grossProfit: 0,
          validCount: 0, unitCount: 0,
          cancelledCount: 0, cancelledGmv: 0,
          unpaidCount: 0, unpaidGmv: 0,
          returnedFullCount: 0, returnedFullValue: 0,
          returnedPartialCount: 0, returnedPartialValue: 0,
          cancelReasons: {},
        });
      }
      return summaryMap.get(key);
    }

    const BATCH   = 200;
    const updates = [];

    for (let i = 0; i < total; i++) {
      const order    = orders[i];
      const month    = orderMonth(order);
      const category = order.orderCategory || 'valid';
      const summary  = getSummary(month, order.storeId);
      const taxRate  = order.store?.taxRate ?? 0;

      const marketplace = order.store?.marketplace ?? 'shopee';
      // ML: usa a taxa real gravada pela API (shopeeCommission = sale_fee do ML)
      // Shopee: recalcula pelos tiers de preço
      const precomputedFee = marketplace === 'mercadolivre' ? (order.shopeeCommission ?? null) : null;

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
        listingType:   order.listingType ?? null,
      });

      if (['valid', 'pending', 'returned_partial'].includes(category)) {
        summary.gmv              += calc.gmv;
        summary.shopeeDeductions += calc.shopeeFee + calc.extraFees;
        summary.netRevenue       += calc.netRevenue;
        summary.tax              += calc.taxAmount;
        summary.grossProfit      += calc.grossProfit;
        if (category === 'valid') { summary.validCount++; summary.unitCount += order.quantity; }
        if (category === 'returned_partial') { summary.returnedPartialCount++; summary.returnedPartialValue += calc.gmv; }
      } else if (category === 'returned_full') {
        summary.returnedFullCount++; summary.returnedFullValue += calc.gmv;
      } else if (category === 'cancelled_unpaid') {
        summary.unpaidCount++; summary.unpaidGmv += calc.gmv;
      } else if (category === 'cancelled_other') {
        summary.cancelledCount++; summary.cancelledGmv += calc.gmv;
        const reason = order.cancelReason || 'Outros';
        summary.cancelReasons[reason] = (summary.cancelReasons[reason] || 0) + 1;
      }

      const isRevenue   = ['valid', 'pending', 'returned_partial'].includes(category);
      const finalProfit = isRevenue ? calc.grossProfit : 0;
      const finalMargin = isRevenue ? calc.margin      : 0;

      updates.push({
        id:   order.id,
        data: {
          calcGmv:         calc.gmv,
          calcShopeeFee:   calc.shopeeFee,
          calcNetRevenue:  calc.netRevenue,
          calcTax:         calc.taxAmount,
          calcProductCost: calc.productCost,
          calcPackaging:   calc.packaging,
          calcGrossProfit: finalProfit,
          calcMargin:      finalMargin,
          hasCost:         calc.hasCost,
          snapshotTaxRate: taxRate,
          profit:          finalProfit,
          margin:          finalMargin,
        },
      });

      if (i % Math.max(1, Math.floor(total / 10)) === 0 || i === total - 1) {
        const pct = Math.round(15 + ((i + 1) / total) * 60);
        onProgress(pct, `Recalculando pedidos... (${i + 1}/${total})`);
      }
    }

    onProgress(76, 'Salvando resultados...');

    for (let i = 0; i < updates.length; i += BATCH) {
      await Promise.all(
        updates.slice(i, i + BATCH).map((u) =>
          prisma.order.update({ where: { id: u.id }, data: u.data })
        )
      );
      const pct = Math.round(76 + ((i + BATCH) / Math.max(1, updates.length)) * 14);
      onProgress(Math.min(90, pct), 'Salvando resultados...');
    }

    onProgress(91, 'Consolidando resumos mensais...');

    const summaryUpserts = [];
    for (const [, s] of summaryMap) {
      const margin = s.gmv > 0 ? r2((s.grossProfit / s.gmv) * 100) : 0;
      const data = {
        gmv:                  r2(s.gmv),
        shopeeDeductions:     r2(s.shopeeDeductions),
        netRevenue:           r2(s.netRevenue),
        tax:                  r2(s.tax),
        grossProfit:          r2(s.grossProfit),
        margin,
        validCount:           s.validCount,
        unitCount:            s.unitCount,
        cancelledCount:       s.cancelledCount,
        cancelledGmv:         r2(s.cancelledGmv),
        unpaidCount:          s.unpaidCount,
        unpaidGmv:            r2(s.unpaidGmv),
        returnedFullCount:    s.returnedFullCount,
        returnedFullValue:    r2(s.returnedFullValue),
        returnedPartialCount: s.returnedPartialCount,
        returnedPartialValue: r2(s.returnedPartialValue),
        cancelReasonBreakdown: JSON.stringify(s.cancelReasons),
      };
      summaryUpserts.push(
        prisma.shopeePeriodSummary.upsert({
          where:  { storeId_month: { storeId: s.storeId, month: s.month } },
          create: { storeId: s.storeId, month: s.month, ...data },
          update: data,
        })
      );
    }
    await Promise.all(summaryUpserts);

    const result = {
      updated:   total,
      months:    monthsLabel,
      summaries: summaryMap.size,
      message:   `${total} pedido(s) recalculado(s)`,
    };

    recalcProgress.set(jobId, { pct: 100, message: 'Concluido!', status: 'completed', result });
  } catch (err) {
    console.error('[recalculate] erro:', err.message);
    recalcProgress.set(jobId, { pct: 0, message: err.message, status: 'failed', error: err.message });
  } finally {
    // Limpar da memória após 5 min
    setTimeout(() => recalcProgress.delete(jobId), 5 * 60 * 1000);
  }
}

// Manter compat com app.js que ainda importa startRecalculateWorker
function startRecalculateWorker() {}

// Shim para compatibilidade com orderController que usa recalculateQueue.add()
const recalculateQueue = {
  add: async (_name, data) => {
    const jobId = randomUUID();
    recalcProgress.set(jobId, { pct: 2, message: 'Iniciando...', status: 'active' });
    setImmediate(() => doRecalculate(jobId, data.userId, data.all, data.months));
    return { id: jobId };
  },
};

module.exports = { recalculateQueue, startRecalculateWorker, recalcProgress };
