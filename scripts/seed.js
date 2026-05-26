require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🗑  Limpando banco...');

  // Ordem respeitando foreign keys
  await prisma.newsRead.deleteMany();
  await prisma.systemNews.deleteMany();
  await prisma.purchaseOrderItem.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.bill.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
  await prisma.store.deleteMany();
  await prisma.user.deleteMany();

  console.log('✅ Banco limpo.');

  const hashed = await bcrypt.hash('qweqwe', 12);

  const user = await prisma.user.create({
    data: {
      name:     'Nando',
      email:    'nandomarzola1@gmail.com',
      password: hashed,
      role:     'admin',
      plan:     'pro',
    },
  });

  console.log(`✅ Usuário criado: ${user.name} <${user.email}> [${user.role}]`);
  console.log(`   ID: ${user.id}`);
}

main()
  .catch((e) => { console.error('❌ Erro:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
