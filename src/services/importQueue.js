const { Queue, Worker } = require('bullmq');
const { importShopeeOrderAll } = require('./importOrderAll');
const fs = require('fs');
const connection = require('../lib/redisConnection');

const QUEUE_NAME = 'import-orders';

const importQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 50 },
    removeOnFail:     { count: 20 },
  },
});

let worker = null;

function startWorker() {
  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { filePath, storeId, userId, filename } = job.data;

      await job.updateProgress({ step: 'aguardando', current: 0, total: 0 });

      const result = await importShopeeOrderAll(
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
      concurrency:     3,
      drainDelay:      30,      // s — espera 30s antes de novo poll quando fila vazia
      stalledInterval: 300000,  // 5min — check de jobs travados
      lockDuration:    60000,   // 60s — evita lock renewal excessivo
    },
  );

  worker.on('completed', (job) => {
    try { fs.unlinkSync(job.data.filePath); } catch {}
  });

  worker.on('failed', (job, err) => {
    console.error(`[import-worker] job ${job?.id} falhou:`, err.message);
    const maxAttempts = job?.opts?.attempts ?? 1;
    if (job && job.attemptsMade >= maxAttempts) {
      try { if (job.data?.filePath) fs.unlinkSync(job.data.filePath); } catch {}
    }
  });

  return worker;
}

module.exports = { importQueue, startWorker };
