require('dotenv').config({ path: '/var/www/html/nm_services/projeto-ecomzero-hub/profittrack-backend/.env' });
const prisma = require('/var/www/html/nm_services/projeto-ecomzero-hub/profittrack-backend/src/lib/prisma');
const STORE = '226c1858-866f-4d4c-9fe9-04fbabf63f7b';

(async () => {
  const store = await prisma.store.findUnique({
    where: { id: STORE },
    select: { name: true, mlTokenExpiresAt: true, mlAccessToken: true, mlRefreshToken: true }
  });
  console.log('=== STORE ===');
  console.log('tokenExpiresAt:', store.mlTokenExpiresAt);
  console.log('tokenValid:', store.mlTokenExpiresAt ? new Date(store.mlTokenExpiresAt) > new Date() : 'unknown');
  console.log('hasToken:', !!store.mlAccessToken);
  console.log('hasRefresh:', !!store.mlRefreshToken);

  const lastImport = await prisma.import.findFirst({
    where: { storeId: STORE },
    orderBy: { importedAt: 'desc' },
    select: { id: true, status: true, importedAt: true, periodMonth: true, totalRows: true }
  });
  console.log('\n=== LAST IMPORT ===');
  console.log(JSON.stringify(lastImport, null, 2));

  const TARGET = [
    '2000016930630430','2000016836520956','2000017000184570','2000016999570990',
    '2000016946292090','2000016755255292','2000016764546660','2000016739006456','2000016893678210'
  ];

  const orders = await prisma.order.findMany({
    where: { orderId: { in: TARGET }, storeId: STORE },
    select: {
      orderId: true, productName: true, skuPrincipal: true,
      productId: true, variantId: true,
      calcProductCost: true, calcPackaging: true,
      calcGmv: true, platformCommission: true, platformServiceFee: true,
      escrowAmount: true, calcGrossProfit: true,
      orderPaidAt: true, orderCategory: true,
      product: { select: { id: true, name: true, sku: true, costPrice: true } },
      variant: { select: { id: true, name: true, sku: true, costPrice: true } },
    },
    orderBy: { orderId: 'asc' }
  });

  console.log('\n=== 9 TARGET ORDERS — DB STATE ===');
  console.log(JSON.stringify(orders.map(o => ({
    orderId: o.orderId,
    productName: o.productName,
    skuPrincipal: o.skuPrincipal,
    productId: o.productId,
    variantId: o.variantId,
    product_costPrice: o.product ? o.product.costPrice : null,
    variant_costPrice: o.variant ? o.variant.costPrice : null,
    calcProductCost: o.calcProductCost,
    calcPackaging: o.calcPackaging,
    escrowAmount: o.escrowAmount,
    platformCommission: o.platformCommission,
    platformServiceFee: o.platformServiceFee,
    calcGrossProfit_snap: o.calcGrossProfit,
    orderPaidAt: o.orderPaidAt,
    orderCategory: o.orderCategory,
  })), null, 2));

  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
