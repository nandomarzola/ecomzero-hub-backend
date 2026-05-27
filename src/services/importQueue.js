const { Queue, Worker, QueueEvents } = require('bullmq');
const { importShopeeParentSKU } = require('./importService');
const fs = require('fs');
const connection = require('../lib/redisConnection');

const QUEUE_NAME = 'import-orders';

const REDIS_AVAILABLE = Boolean(process.env.REDIS_HOST);

// ── Fila ────────────────────────────────────────────────────────────────────
const importQueue = REDIS_AVAILABLE
  ? new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 2 * 60 * 60 },
        removeOnFail:     { age: 6 * 60 * 60 },
      },
    })
  : null;

// ── Eventos (para polling) ───────────────────────────────────────────────────
const queueEvents = REDIS_AVAILABLE
  ? new QueueEvents(QUEUE_NAME, { connection })
  : null;

// ── Worker ───────────────────────────────────────────────────────────────────
let worker = null;

function startWorker() {
  if (!REDIS_AVAILABLE) {
    console.warn('[import-worker] Redis não configurado — worker desativado.');
    return null;
  }

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { filePath, storeId, userId, filename } = job.data;

      await job.updateProgress({ step: 'aguardando', current: 0, total: 0 });

      const result = await importShopeeParentSKU(
        filePath,
        storeId,
        userId,
        filename,
        (progress) => job.updateProgress(progress),
      );

      return result;
    },
    {
      connection,
      concurrency: 3,
    },
  );

  worker.on('completed', (job) => {
    try { fs.unlinkSync(job.data.filePath); } catch {}
  });

  worker.on('failed', (job, err) => {
    console.error(`[import-worker] job ${job?.id} falhou:`, err.message);
    try { if (job?.data?.filePath) fs.unlinkSync(job.data.filePath); } catch {}
  });

  return worker;
}

module.exports = { importQueue, queueEvents, startWorker };
