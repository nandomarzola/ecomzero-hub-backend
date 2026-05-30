const { Queue, Worker } = require('bullmq');
const connection = require('../lib/redisConnection');
const prisma     = require('../lib/prisma');
const { calcProfit, calcShopeeFeePorUnidade } = require('./calculatorService');

const QUEUE_NAME = 'recalculate-orders';

const recalculateQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 20 },
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function orderMonth(order) {
  const d = new Date(order.soldAt);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getOrderCategory(order) {
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

      // ── Pre-fetch produtos para fallback de custo (items sem productId) ──────
      const storeIds = [...new Set(orders.map((o) => o.storeId))];
      const allProducts = await prisma.product.findMany({
        where:  { storeId: { in: storeIds } },
        select: { id: true, storeId: true, name: true, sku: true, costPrice: true, packaging: true, supplies: true },
      });
      // Mapa por storeId → Map<nomeLower, produto>
      const productMapByStore = {};
      for (const p of allProducts) {
        if (!productMapByStore[p.storeId]) productMapByStore[p.storeId] = new Map();
        productMapByStore[p.storeId].set(p.name.toLowerCase(), p);
      }
      function findProductFallback(storeId, productNameRaw, variationName) {
        const storeMap = productMapByStore[storeId];
        if (!storeMap) return null;
        // Tenta "Nome — Variação" primeiro
        if (variationName && variationName !== '-') {
          const key = `${productNameRaw} — ${variationName}`.toLowerCase();
          const found = storeMap.get(key);
          if (found) return found;
        }
        return storeMap.get((productNameRaw || '').toLowerCase()) ?? null;
      }

      // ── Per-order recalculation ───────────────────────────────────────────
      const orderUpdates = [];
      const itemUpdates  = [];

      // Group for period summaries
      const summaryMap = new Map(); // `${storeId}::${month}` → accumulator

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

      for (let i = 0; i < total; i++) {
        const order    = orders[i];
        const month    = orderMonth(order);
        const category = getOrderCategory(order);
        const summary  = getSummary(month, order.storeId);

        // ── Shopee-native fields (from Order_all import) ──────────────────
        const hasNativeFields = order.importSource === 'orderall';
        const agreedPrice     = hasNativeFields ? (order.agreedPrice || 0) : 0;
        const quantity        = order.items.reduce((s, it) => s + it.quantity, 0) || 1;
        const gmvOrder        = hasNativeFields ? agreedPrice * quantity : order.salePrice;

        // ── Accumulate period summary ─────────────────────────────────────
        if (category === 'valid' || category === 'returned_partial') {
          summary.gmv       += gmvOrder;
          summary.validCount += 1;
          summary.unitCount  += quantity;

          if (hasNativeFields && agreedPrice > 0) {
            const shopeeFee = calcShopeeFeePorUnidade(agreedPrice) * quantity;
            const taxRate   = (order.store.taxRate || 0) / 100;
            summary.shopeeDeductions += shopeeFee;
            summary.tax              += gmvOrder * taxRate;
          }
        } else if (category === 'returned_full') {
          summary.returnedFullCount += 1;
          summary.returnedFullValue += gmvOrder;
        } else if (category === 'returned_partial') {
          summary.returnedPartialCount += 1;
          summary.returnedPartialValue += gmvOrder - (hasNativeFields ? (order.globalTotal || 0) : 0);
        } else if (category === 'cancelled_unpaid') {
          summary.unpaidCount += 1;
          summary.unpaidGmv   += gmvOrder;
        } else if (category === 'cancelled_other') {
          summary.cancelledCount += 1;
          summary.cancelledGmv   += gmvOrder;
          const reason = order.cancelReason || 'Outros';
          summary.cancelReasons[reason] = (summary.cancelReasons[reason] || 0) + 1;
        }

        // ── Profit recalculation (só para pedidos que geram receita) ──────
        if (category !== 'valid' && category !== 'returned_partial') {
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
          commission:      order.store.commission,
          serviceFee:      order.store.serviceFee,
          // Sempre usa taxRate atual da loja — não depende do snapshot que pode ser 0 ou desatualizado
          taxRate:         order.store.taxRate,
          fixedFeePerItem: order.store.fixedFeePerItem,
        };

        let totalProfit        = 0;
        let totalSalePrice     = 0;
        let totalShopeeFee     = 0;

        for (const item of order.items) {
          // Se o item não tem produto vinculado, tenta resolver pelo nome do pedido
          const resolvedProduct = item.product
            ?? findProductFallback(order.storeId, order.productNameRaw, order.variationName);

          const costPrice = resolvedProduct?.costPrice ?? item.snapshotCostPrice ?? 0;
          const packaging = resolvedProduct?.packaging ?? item.snapshotPackaging ?? 0;
          const supplies  = resolvedProduct?.supplies  ?? item.snapshotSupplies  ?? 0;

          // Para Order_all: usa agreedPrice como base de cálculo por item
          // Para pedidos com múltiplos produtos diferentes, cada item usa seu próprio unitPrice
          const effectiveUnitPrice = hasNativeFields && agreedPrice > 0 && order.items.length === 1
            ? agreedPrice
            : item.unitPrice;

          const productConfig = { costPrice, packaging, supplies };
          const calc = calcProfit(effectiveUnitPrice * item.quantity, item.quantity, productConfig, storeConfig, 0, 0);

          const itemProfit    = parseFloat(calc.profit.toFixed(2));
          const itemShopeeFee = parseFloat(calc.breakdown.commission.toFixed(2));

          totalProfit    += calc.profit;
          totalSalePrice += calc.breakdown.salePrice;
          totalShopeeFee += itemShopeeFee;

          // Sempre atualiza snapshots + profit/shopeeCommission por item (para agrupamento correto)
          itemUpdates.push(prisma.orderItem.update({
            where: { id: item.id },
            data:  {
              snapshotCostPrice: costPrice,
              snapshotPackaging: packaging,
              snapshotSupplies:  supplies,
              profit:            itemProfit,
              shopeeCommission:  itemShopeeFee,
            },
          }));
        }

        summary.grossProfit += totalProfit;

        const margin = totalSalePrice > 0 ? (totalProfit / totalSalePrice) * 100 : 0;

        const taxData = {
          snapshotTaxRate:  order.store.taxRate,
          // shopeeCommission = soma real das taxas por item (correto para pedidos multi-produto)
          shopeeCommission: parseFloat(totalShopeeFee.toFixed(2)),
          shopeeServiceFee: 0,
        };

        orderUpdates.push(prisma.order.update({
          where: { id: order.id },
          data:  { profit: parseFloat(totalProfit.toFixed(2)), margin: parseFloat(margin.toFixed(2)), ...taxData },
        }));

        if (i % Math.max(1, Math.floor(total / 20)) === 0 || i === total - 1) {
          const pct = Math.round(35 + ((i + 1) / total) * 45);
          await job.updateProgress({ pct, message: `Recalculando pedidos... (${i + 1}/${total})` });
        }
      }

      await job.updateProgress({ pct: 82, message: 'Consolidando métricas do período...' });

      // ── Compute derived summary fields + upsert ───────────────────────────
      const summaryUpserts = [];
      for (const [, s] of summaryMap) {
        const netRevenue = parseFloat((s.gmv - s.shopeeDeductions).toFixed(2));
        const margin     = s.gmv > 0 ? (s.grossProfit / s.gmv) * 100 : 0;

        const data = {
          gmv:                  parseFloat(s.gmv.toFixed(2)),
          shopeeDeductions:     parseFloat(s.shopeeDeductions.toFixed(2)),
          netRevenue,
          tax:                  parseFloat(s.tax.toFixed(2)),
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
        };

        summaryUpserts.push(
          prisma.shopeePeriodSummary.upsert({
            where:  { storeId_month: { storeId: s.storeId, month: s.month } },
            create: { storeId: s.storeId, month: s.month, ...data },
            update: data,
          })
        );
      }

      await job.updateProgress({ pct: 85, message: 'Salvando resultados no banco...' });

      const allUpdates = [...orderUpdates, ...itemUpdates];
      for (let i = 0; i < allUpdates.length; i += 50) {
        await Promise.all(allUpdates.slice(i, i + 50));
        const pct = Math.round(85 + ((i + 50) / Math.max(1, allUpdates.length)) * 10);
        await job.updateProgress({ pct: Math.min(94, pct), message: 'Salvando resultados no banco...' });
      }

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
    {
      connection,
      concurrency:     1,
      drainDelay:      30,      // s — espera 30s antes de novo poll quando fila vazia
      stalledInterval: 300000,  // 5min
      lockDuration:    60000,   // 60s
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[recalculate-worker] job ${job?.id} falhou:`, err.message);
  });

  return worker;
}

module.exports = { recalculateQueue, startRecalculateWorker };
