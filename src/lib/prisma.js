const { PrismaClient } = require('@prisma/client');

const isProduction = process.env.NODE_ENV === 'production';

const prisma = new PrismaClient({
  log: isProduction
    ? [{ emit: 'event', level: 'error' }]
    : [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'query' },
      ],
});

if (!isProduction) {
  const SLOW_QUERY_MS = 500;
  prisma.$on('query', (e) => {
    if (e.duration >= SLOW_QUERY_MS) {
      console.warn(`[prisma:slow] ${e.duration}ms — ${e.query.slice(0, 200)}`);
    }
  });
}

prisma.$on('error', (e) => {
  console.error('[prisma:error]', e.message);
});

module.exports = prisma;
