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

function startRecalculateWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { userId, all, months } = job.data;

      await job.updateProgress({ pct: 5, message: 'Iniciando recálculo...' });

      // Build date filter
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

      await job.updateProgress({ pct: 15, message: 'Buscando pedidos do período...' });

      const whereOrder = { store: { userId } };
      if (Object.keys(dateFilter).length) whereOrder.soldAt = dateFilter;

      const orders = await prisma.order.findMany({
        where:   whereOrder,
        include: { store: true, items: { include: { product: true } } },
      });

      await job.updateProgress({ pct: 30, message: `Calculando custos e taxas... (0/${orders.length})` });

      const orderUpdates = [];
      const itemUpdates  = [];
      const total        = orders.length;

      for (let i = 0; i < total; i++) {
        const order = orders[i];
        let totalProfit    = 0;
        let totalSalePrice = 0;

        const storeConfig = {
          marketplace:     order.store.marketplace,
          commission:      order.snapshotCommission || order.store.commission,
          serviceFee:      order.snapshotServiceFee || order.store.serviceFee,
          taxRate:         order.snapshotTaxRate    || order.store.taxRate,
          fixedFeePerItem: order.snapshotFixedFee   || order.store.fixedFeePerItem,
        };

        for (const item of order.items) {
          // Always use current product cost — recalculate reflects the cost the user set now
          const costPrice = item.product?.costPrice ?? item.snapshotCostPrice ?? 0;
          const packaging = item.product?.packaging ?? item.snapshotPackaging ?? 0;
          const supplies  = item.product?.supplies  ?? item.snapshotSupplies  ?? 0;

          const productConfig = { costPrice, packaging, supplies };
          const calc = calcProfit(item.unitPrice * item.quantity, item.quantity, productConfig, storeConfig, 0, 0);
          totalProfit    += calc.profit;
          totalSalePrice += calc.breakdown.salePrice;

          // Always sync snapshot to current product cost so future reads are consistent
          if (item.product) {
            itemUpdates.push(prisma.orderItem.update({
              where: { id: item.id },
              data:  { snapshotCostPrice: costPrice, snapshotPackaging: packaging, snapshotSupplies: supplies },
            }));
          }
        }

        const margin  = totalSalePrice > 0 ? (totalProfit / totalSalePrice) * 100 : 0;
        const taxData = {};
        if (!order.snapshotCommission  && order.store.commission)      taxData.snapshotCommission  = order.store.commission;
        if (!order.snapshotServiceFee  && order.store.serviceFee)      taxData.snapshotServiceFee  = order.store.serviceFee;
        if (!order.snapshotTaxRate     && order.store.taxRate)         taxData.snapshotTaxRate     = order.store.taxRate;
        if (!order.snapshotFixedFee    && order.store.fixedFeePerItem) taxData.snapshotFixedFee    = order.store.fixedFeePerItem;

        orderUpdates.push(prisma.order.update({
          where: { id: order.id },
          data:  { profit: parseFloat(totalProfit.toFixed(2)), margin: parseFloat(margin.toFixed(2)), ...taxData },
        }));

        // Dynamic progress: 30% → 80% proportional to orders processed
        if (total > 0 && (i % Math.max(1, Math.floor(total / 20)) === 0 || i === total - 1)) {
          const pct = Math.round(30 + ((i + 1) / total) * 50);
          await job.updateProgress({ pct, message: `Processando margens... (${i + 1}/${total})` });
        }
      }

      await job.updateProgress({ pct: 82, message: 'Consolidando totais...' });

      // Batch DB writes in groups of 50
      const allUpdates = [...orderUpdates, ...itemUpdates];
      for (let i = 0; i < allUpdates.length; i += 50) {
        await Promise.all(allUpdates.slice(i, i + 50));
        const pct = Math.round(82 + ((i + 50) / allUpdates.length) * 13);
        await job.updateProgress({ pct: Math.min(95, pct), message: 'Salvando resultados...' });
      }

      await job.updateProgress({ pct: 100, message: 'Concluído!' });

      return {
        updated:   orders.length,
        snapshots: itemUpdates.length,
        months:    monthsLabel,
        message:   `${orders.length} pedido(s) recalculado(s), ${itemUpdates.length} snapshot(s) corrigido(s)`,
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
