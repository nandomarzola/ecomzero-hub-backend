const { Queue, Worker } = require('bullmq');
const connection = require('../lib/redisConnection');
const prisma     = require('../lib/prisma');
const { calcProfit } = require('./calculatorService');

const QUEUE_NAME = 'recalculate-orders';

const recalculateQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 2 * 60 * 60 },
    removeOnFail:     { age: 6 * 60 * 60 },
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function orderMonth(order) {
  const d = new Date(order.soldAt);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getOrderCategory(order) {
  // Already classified on import for orderall; derive for legacy parentsku orders
  if (order.orderCategory) return order.orderCategory;
  if (order.status === 'cancelled') return 'cancelled_other';
  if (order.status === 'returned')  return 'returned_full';
  return 'valid';
}

function startRecalculateWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { userId, all, months } = job.data;

      await job.updateProgress({ pct: 5, message: 'Carregando todos os pedidos do período...' });

      // ── Build date filter ─────────────────────────────────────────────────
      let dateFilter  = {};
      let monthsLabel = '';

      if (all) {
        monthsLabel = 'todos';
      } else if (Array.isArray(months) && months.length) {
        const dates = months.flatMap((m) => {
          const [y, mo] = m.split('-').map(Number);
          return [new Date(Date.UTC(y, mo - 1, 1)), new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999))];
        });
        dateFilter  = { gte: dates[0], lte: dates[dates.length - 1] };
        monthsLabel = months.join(', ');
      } else {
        const now = new Date();
        const y   = now.getFullYear();
        const mo  = now.getMonth() + 1;
        dateFilter = {
          gte: new Date(Date.UTC(y, mo - 1, 1)),
          lte: new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999)),
        };
        monthsLabel = `${y}-${String(mo).padStart(2, '0')}`;
      }

      // ── Fetch ALL orders (all statuses) ───────────────────────────────────
      const whereOrder = { store: { userId } };
      if (Object.keys(dateFilter).length) whereOrder.soldAt = dateFilter;

      const orders = await prisma.order.findMany({
        where:   whereOrder,
        include: { store: true, items: { include: { product: true } } },
      });

      const total = orders.length;
      await job.updateProgress({ pct: 15, message: `Classificando ${total} pedidos por status...` });

      // ── Per-order recalculation ───────────────────────────────────────────
      const orderUpdates = [];
      const itemUpdates  = [];

      // Group for period summaries
      const summaryMap = new Map(); // monthKey → accumulator

      function getSummary(month, storeId) {
        const key = `${storeId}::${month}`;
        if (!summaryMap.has(key)) {
          summaryMap.set(key, {
            storeId, month,
            gmv: 0, shopeeDeductions: 0, netRevenue: 0, grossProfit: 0,
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

      for (let i = 0; i < total; i++) {
        const order    = orders[i];
        const month    = orderMonth(order);
        const category = getOrderCategory(order);
        const summary  = getSummary(month, order.storeId);

        // ── Shopee-native fields (from Order_all import) ──────────────────
        const hasNativeFields = order.importSource === 'orderall';
        const agreedPrice     = hasNativeFields ? (order.agreedPrice || 0) : 0;
        const shopeeComm      = hasNativeFields ? (order.shopeeCommission || 0) : 0;
        const shopeeService   = hasNativeFields ? (order.shopeeServiceFee || 0) : 0;
        const sellerCoupon    = hasNativeFields ? (order.sellerCoupon || 0) : 0;
        const globalTotal     = hasNativeFields ? (order.globalTotal || 0) : 0;
        const quantity        = order.items.reduce((s, it) => s + it.quantity, 0) || 1;
        const gmvOrder        = hasNativeFields
          ? agreedPrice * quantity
          : order.salePrice;

        // ── Accumulate period summary ─────────────────────────────────────
        if (category === 'valid' || category === 'returned_partial') {
          // GMV: agreedPrice × qty for both valid and returned_partial
          summary.gmv              += gmvOrder;
          summary.shopeeDeductions += shopeeComm + shopeeService + sellerCoupon;
          summary.validCount       += 1;
          summary.unitCount        += quantity;
        } else if (category === 'returned_full') {
          summary.returnedFullCount += 1;
          summary.returnedFullValue += gmvOrder;
        } else if (category === 'cancelled_unpaid') {
          summary.unpaidCount += 1;
          summary.unpaidGmv   += gmvOrder;
        } else if (category === 'cancelled_other') {
          summary.cancelledCount += 1;
          summary.cancelledGmv   += gmvOrder;
          const reason = order.cancelReason || 'Outros';
          summary.cancelReasons[reason] = (summary.cancelReasons[reason] || 0) + 1;
        }

        if (category === 'returned_partial') {
          summary.returnedPartialCount += 1;
          summary.returnedPartialValue += (gmvOrder - globalTotal); // valor perdido
        }

        // ── Profit recalculation (only for paying orders) ─────────────────
        if (category !== 'valid' && category !== 'returned_partial') {
          // No profit calc for cancelled/returned_full
          if (order.profit !== 0 || order.margin !== 0) {
            orderUpdates.push(prisma.order.update({
              where: { id: order.id },
              data:  { profit: 0, margin: 0 },
            }));
          }
          continue;
        }

        const storeConfig = {
          marketplace:     order.store.marketplace,
          commission:      order.snapshotCommission || order.store.commission,
          serviceFee:      order.snapshotServiceFee || order.store.serviceFee,
          taxRate:         order.snapshotTaxRate    || order.store.taxRate,
          fixedFeePerItem: order.snapshotFixedFee   || order.store.fixedFeePerItem,
        };

        let totalProfit    = 0;
        let totalSalePrice = 0;

        for (const item of order.items) {
          // Always use current product cost when recalculating
          const costPrice = item.product?.costPrice ?? item.snapshotCostPrice ?? 0;
          const packaging = item.product?.packaging ?? item.snapshotPackaging ?? 0;
          const supplies  = item.product?.supplies  ?? item.snapshotSupplies  ?? 0;

          // For Order_all: use agreedPrice as unit price for profit calc
          const effectiveUnitPrice = hasNativeFields && agreedPrice > 0
            ? agreedPrice
            : item.unitPrice;

          const productConfig = { costPrice, packaging, supplies };
          const calc = calcProfit(effectiveUnitPrice * item.quantity, item.quantity, productConfig, storeConfig, 0, 0);
          totalProfit    += calc.profit;
          totalSalePrice += calc.breakdown.salePrice;

          // Sync snapshot to current cost
          if (item.product) {
            itemUpdates.push(prisma.orderItem.update({
              where: { id: item.id },
              data:  { snapshotCostPrice: costPrice, snapshotPackaging: packaging, snapshotSupplies: supplies },
            }));
          }
        }

        // For Order_all: override profit with native Shopee fee data if available
        let finalProfit = totalProfit;
        let finalSalePrice = totalSalePrice;

        if (hasNativeFields && gmvOrder > 0) {
          // netRevenue = gmv - actual shopee fees
          const itemsCost = order.items.reduce((s, it) => {
            const cost = it.product?.costPrice ?? it.snapshotCostPrice ?? 0;
            return s + cost * it.quantity;
          }, 0);
          const taxRate  = (order.snapshotTaxRate || order.store.taxRate || 0) / 100;
          const tax      = gmvOrder * taxRate;
          const netRev   = gmvOrder - shopeeComm - shopeeService - sellerCoupon - tax;
          finalProfit    = netRev - itemsCost;
          finalSalePrice = gmvOrder;
          summary.grossProfit += finalProfit;
        } else {
          summary.grossProfit += finalProfit;
        }

        const margin = finalSalePrice > 0 ? (finalProfit / finalSalePrice) * 100 : 0;

        const taxData = {};
        if (!order.snapshotCommission  && order.store.commission)      taxData.snapshotCommission  = order.store.commission;
        if (!order.snapshotServiceFee  && order.store.serviceFee)      taxData.snapshotServiceFee  = order.store.serviceFee;
        if (!order.snapshotTaxRate     && order.store.taxRate)         taxData.snapshotTaxRate     = order.store.taxRate;
        if (!order.snapshotFixedFee    && order.store.fixedFeePerItem) taxData.snapshotFixedFee    = order.store.fixedFeePerItem;

        orderUpdates.push(prisma.order.update({
          where: { id: order.id },
          data:  { profit: parseFloat(finalProfit.toFixed(2)), margin: parseFloat(margin.toFixed(2)), ...taxData },
        }));

        // Progress 35% → 80%
        if (i % Math.max(1, Math.floor(total / 20)) === 0 || i === total - 1) {
          const pct = Math.round(35 + ((i + 1) / total) * 45);
          await job.updateProgress({ pct, message: `Calculando GMV dos pedidos válidos... (${i + 1}/${total})` });
        }
      }

      await job.updateProgress({ pct: 82, message: 'Consolidando métricas do período...' });

      // ── Compute derived summary fields ────────────────────────────────────
      const summaryUpserts = [];
      for (const [, s] of summaryMap) {
        const netRevenue = s.gmv - s.shopeeDeductions;
        const margin     = s.gmv > 0 ? (s.grossProfit / s.gmv) * 100 : 0;
        const totalOrders = s.validCount + s.cancelledCount + s.unpaidCount + s.returnedFullCount + s.returnedPartialCount;
        summaryUpserts.push(
          prisma.shopeePeriodSummary.upsert({
            where:  { storeId_month: { storeId: s.storeId, month: s.month } },
            create: {
              storeId:              s.storeId,
              month:                s.month,
              gmv:                  parseFloat(s.gmv.toFixed(2)),
              shopeeDeductions:     parseFloat(s.shopeeDeductions.toFixed(2)),
              netRevenue:           parseFloat(netRevenue.toFixed(2)),
              grossProfit:          parseFloat(s.grossProfit.toFixed(2)),
              margin:               parseFloat(margin.toFixed(2)),
              validCount:           s.validCount,
              unitCount:            s.unitCount,
              cancelledCount:       s.cancelledCount,
              cancelledGmv:         parseFloat(s.cancelledGmv.toFixed(2)),
              unpaidCount:          s.unpaidCount,
              unpaidGmv:            parseFloat(s.unpaidGmv.toFixed(2)),
              returnedFullCount:    s.returnedFullCount,
              returnedFullValue:    parseFloat(s.returnedFullValue.toFixed(2)),
              returnedPartialCount: s.returnedPartialCount,
              returnedPartialValue: parseFloat(s.returnedPartialValue.toFixed(2)),
              cancelReasonBreakdown: JSON.stringify(s.cancelReasons),
            },
            update: {
              gmv:                  parseFloat(s.gmv.toFixed(2)),
              shopeeDeductions:     parseFloat(s.shopeeDeductions.toFixed(2)),
              netRevenue:           parseFloat(netRevenue.toFixed(2)),
              grossProfit:          parseFloat(s.grossProfit.toFixed(2)),
              margin:               parseFloat(margin.toFixed(2)),
              validCount:           s.validCount,
              unitCount:            s.unitCount,
              cancelledCount:       s.cancelledCount,
              cancelledGmv:         parseFloat(s.cancelledGmv.toFixed(2)),
              unpaidCount:          s.unpaidCount,
              unpaidGmv:            parseFloat(s.unpaidGmv.toFixed(2)),
              returnedFullCount:    s.returnedFullCount,
              returnedFullValue:    parseFloat(s.returnedFullValue.toFixed(2)),
              returnedPartialCount: s.returnedPartialCount,
              returnedPartialValue: parseFloat(s.returnedPartialValue.toFixed(2)),
              cancelReasonBreakdown: JSON.stringify(s.cancelReasons),
            },
          })
        );
      }

      await job.updateProgress({ pct: 85, message: 'Salvando resultados no banco...' });

      // ── Batch DB writes ───────────────────────────────────────────────────
      const allUpdates = [...orderUpdates, ...itemUpdates];
      for (let i = 0; i < allUpdates.length; i += 50) {
        await Promise.all(allUpdates.slice(i, i + 50));
        const pct = Math.round(85 + ((i + 50) / Math.max(1, allUpdates.length)) * 10);
        await job.updateProgress({ pct: Math.min(94, pct), message: 'Salvando resultados no banco...' });
      }

      // Save period summaries
      await Promise.all(summaryUpserts);

      await job.updateProgress({ pct: 100, message: 'Concluído!' });

      return {
        updated:   orders.length,
        snapshots: itemUpdates.length,
        months:    monthsLabel,
        summaries: summaryMap.size,
        message:   `${orders.length} pedido(s) recalculado(s), ${summaryMap.size} resumo(s) de período gerado(s)`,
      };
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[recalculate-worker] job ${job?.id} falhou:`, err.message);
  });

  return worker;
}

module.exports = { recalculateQueue, startRecalculateWorker };
