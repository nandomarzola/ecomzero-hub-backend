require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Limpando tabelas transacionais...');

  // Ordem importa por causa das FKs
  const [items, aliases, summaries, orders] = await Promise.all([
    prisma.orderItem.deleteMany({}),
    prisma.productAlias.deleteMany({}),
    prisma.shopeePeriodSummary.deleteMany({}),
  ]).then(async (results) => {
    const orders = await prisma.order.deleteMany({});
    return [...results, orders];
  });

  console.log('✓ OrderItem deletados:', items.count);
  console.log('✓ ProductAlias deletados:', aliases.count);
  console.log('✓ ShopeePeriodSummary deletados:', summaries.count);
  console.log('✓ Orders deletados:', orders.count);
  console.log('Concluído. Produtos mantidos intactos.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
