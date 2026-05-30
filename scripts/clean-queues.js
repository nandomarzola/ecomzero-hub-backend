require('dotenv').config();
const { Queue } = require('bullmq');

const connection = {
  host:     process.env.REDIS_HOST     || '127.0.0.1',
  port:     parseInt(process.env.REDIS_PORT  || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  ...(process.env.REDIS_TLS === 'true' ? { tls: {} } : {}),
};

async function clean(queueName) {
  const q = new Queue(queueName, { connection });

  const [comp, fail, wait, delay] = await Promise.all([
    q.clean(0, 10000, 'completed'),
    q.clean(0, 10000, 'failed'),
    q.clean(0, 10000, 'wait'),
    q.clean(0, 10000, 'delayed'),
  ]);

  console.log(`[${queueName}] removidos: completed=${comp.length} failed=${fail.length} wait=${wait.length} delayed=${delay.length}`);

  await q.close();
}

(async () => {
  await clean('import-orders');
  await clean('recalculate-orders');
  console.log('Filas limpas.');
  process.exit(0);
})();
