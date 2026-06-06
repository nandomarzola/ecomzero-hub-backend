/**
 * Seed script — conta demo para revisão Shopee Open Platform
 * Login: demo@ecomzero.com.br / Demo@2025
 *
 * Uso: node scripts/seedDemo.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function r2(n) { return Math.round(n * 100) / 100; }
function rnd(min, max) { return r2(min + Math.random() * (max - min)); }
function randInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
function daysAgo(n) { return new Date(Date.now() - n * 86400000); }
function dateInMonth(year, month, day) { return new Date(Date.UTC(year, month - 1, day, randInt(8, 20), randInt(0, 59))); }

// ── Produtos realistas por marketplace ────────────────────────────────────────
const PRODUCTS_SHOPEE = [
  { name: 'Difusor Elétrico Air Wick com Refil 16ml',     sku: 'EZ0028-1', cost: 21.00, list: 38.99 },
  { name: 'Glade Aromatizador Automático 2 Refis 260ml',  sku: 'EZ0031',   cost: 34.00, list: 59.99 },
  { name: 'Refil Lavanda & Gerânio 12ml',                 sku: 'EZ0028-3', cost: 17.30, list: 31.99 },
  { name: 'Bom Ar Click Spray Repelente 360ml',           sku: 'EZ0045',   cost: 12.50, list: 24.99 },
  { name: 'Aromatizador Ambiente Floral 250ml',           sku: 'EZ0052',   cost: 8.90,  list: 19.99 },
  { name: 'Difusor de Varetas Bambu & Sândalo 200ml',     sku: 'EZ0067',   cost: 14.00, list: 29.99 },
  { name: 'Vela Aromática Lavanda Grande 200g',           sku: 'EZ0071',   cost: 11.50, list: 24.99 },
  { name: 'Sabonete Líquido Premium 500ml',               sku: 'EZ0083',   cost: 7.80,  list: 17.99 },
  { name: 'Sachê Perfumado Floral Kit 6 unidades',        sku: 'EZ0091',   cost: 9.20,  list: 21.99 },
  { name: 'Purificador de Ar Elétrico 220V',              sku: 'EZ0104',   cost: 28.50, list: 54.99 },
];

const PRODUCTS_ML = [
  { name: 'Difusor Elétrico Air Wick 16ml Premium',       sku: 'ML001', cost: 21.00, list: 44.90 },
  { name: 'Glade Aromatizador Kit Completo',              sku: 'ML002', cost: 34.00, list: 64.90 },
  { name: 'Aromatizador Spray Automático 360ml',          sku: 'ML003', cost: 12.50, list: 27.90 },
  { name: 'Difusor de Varetas Premium 300ml',             sku: 'ML004', cost: 18.00, list: 39.90 },
  { name: 'Vela Aromática Soja Natural 180g',             sku: 'ML005', cost: 13.00, list: 29.90 },
  { name: 'Sachê Perfumado Lavanda 10 unidades',          sku: 'ML006', cost: 10.50, list: 24.90 },
  { name: 'Purificador de Ar USB Portátil',               sku: 'ML007', cost: 22.00, list: 49.90 },
  { name: 'Sabonete Esfoliante Natural 300ml',            sku: 'ML008', cost: 9.50,  list: 22.90 },
];

const PRODUCTS_SHEIN = [
  { name: 'Body Splash Floral 250ml',                     sku: 'SH001', cost: 8.50,  list: 19.90 },
  { name: 'Hidratante Corporal Manteiga Karité 400ml',    sku: 'SH002', cost: 11.00, list: 27.90 },
  { name: 'Esfoliante Corporal Café Orgânico 200g',       sku: 'SH003', cost: 9.00,  list: 22.90 },
  { name: 'Kit Skincare Básico 3 Peças',                  sku: 'SH004', cost: 24.00, list: 59.90 },
  { name: 'Máscara Capilar Reparadora 500g',              sku: 'SH005', cost: 13.50, list: 34.90 },
  { name: 'Sérum Vitamina C 30ml',                        sku: 'SH006', cost: 16.00, list: 39.90 },
];

const PRODUCTS_TIKTOK = [
  { name: 'Difusor Ultrassônico LED 500ml',               sku: 'TT001', cost: 32.00, list: 69.90 },
  { name: 'Óleo Essencial Lavanda Pura 10ml',             sku: 'TT002', cost: 9.50,  list: 24.90 },
  { name: 'Kit Aromaterapia 7 Óleos Essenciais',          sku: 'TT003', cost: 38.00, list: 89.90 },
  { name: 'Vela Decorativa Soja & Cera de Abelha',        sku: 'TT004', cost: 15.00, list: 39.90 },
  { name: 'Incenso Natural Premium 40 varetas',           sku: 'TT005', cost: 6.50,  list: 17.90 },
];

function makeOrders(storeId, products, year, month, count, marketplace) {
  const orders = [];
  const statusDist = ['valid', 'valid', 'valid', 'valid', 'valid', 'valid', 'valid', 'valid', 'pending', 'cancelled_other'];

  for (let i = 0; i < count; i++) {
    const product  = products[i % products.length];
    const qty      = Math.random() < 0.85 ? 1 : randInt(2, 4);
    const price    = r2(product.list * rnd(0.90, 1.00)); // alguns com desconto
    const gmv      = r2(price * qty);
    const cat      = statusDist[i % statusDist.length];
    const day      = randInt(1, 28);
    const soldAt   = dateInMonth(year, month, day);
    const orderId  = `DEMO${year}${String(month).padStart(2,'0')}${String(i+1).padStart(6,'0')}`;

    let commRate = 0, svcFee = 0;
    if (marketplace === 'shopee')       { commRate = price < 80 ? 0.20 : 0.14; svcFee = price < 80 ? 4.00 : (price < 100 ? 16 : 20); }
    else if (marketplace === 'mercadolivre') { commRate = 0.11; }
    else if (marketplace === 'shein')   { commRate = 0.18; }
    else if (marketplace === 'tiktok')  { commRate = 0.09; }

    const comm      = r2(price * qty * commRate);
    const svcTotal  = r2(svcFee * qty);
    const netRev    = r2(gmv - comm - svcTotal);
    const tax       = r2(gmv * 0.05);
    const cost      = r2(product.cost * qty);
    const pkg       = r2(1.50 * qty);
    const isRevenue = ['valid', 'pending'].includes(cat);
    const gp        = isRevenue ? r2(netRev - tax - cost - pkg) : 0;
    const margin    = isRevenue && gmv > 0 ? r2((gp / gmv) * 100) : 0;

    orders.push({
      storeId,
      orderId,
      orderStatus:      cat === 'valid' ? 'Concluído' : cat === 'pending' ? 'Para confirmar' : 'Cancelado',
      orderCategory:    cat,
      skuVariacao:      product.sku,
      productName:      product.name,
      agreedPrice:      price,
      originalPrice:    product.list,
      quantity:         qty,
      platformCommission: comm,
      platformServiceFee: svcTotal,
      globalTotal:      gmv,
      orderTotal:       gmv,
      calcGmv:          isRevenue ? gmv : 0,
      calcShopeeFee:    isRevenue ? r2(comm + svcTotal) : 0,
      calcNetRevenue:   isRevenue ? netRev : 0,
      calcTax:          isRevenue ? tax : 0,
      calcProductCost:  isRevenue ? cost : 0,
      calcPackaging:    isRevenue ? pkg : 0,
      calcGrossProfit:  gp,
      calcMargin:       margin,
      hasCost:          true,
      status:           cat === 'valid' ? 'paid' : cat === 'pending' ? 'paid' : 'cancelled',
      soldAt,
      salePrice:        isRevenue ? gmv : 0,
      profit:           gp,
      margin:           margin,
      snapshotTaxRate:  5.0,
    });
  }
  return orders;
}

async function main() {
  console.log('🌱  Iniciando seed da conta demo...');

  // ── Usuário demo ─────────────────────────────────────────────────────────────
  const DEMO_EMAIL = 'demo@ecomzero.com.br';
  const DEMO_PASS  = 'Demo@2025';

  let user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (user) {
    console.log(`✅  Usuário demo já existe (${user.id})`);
  } else {
    const hashed = await bcrypt.hash(DEMO_PASS, 12);
    user = await prisma.user.create({
      data: {
        name:  'EcomZero Demo',
        email: DEMO_EMAIL,
        password: hashed,
        plan: 'pro',
        role: 'seller',
        cnpj: '62.823.303/0001-61',
      },
    });
    console.log(`✅  Usuário demo criado: ${user.id}`);
  }

  // ── Lojas ────────────────────────────────────────────────────────────────────
  const storeConfigs = [
    { name: 'EcomZero — Shopee Principal',  marketplace: 'shopee',       taxType: 'mei', taxRate: 5.0 },
    { name: 'EcomZero — Mercado Livre',     marketplace: 'mercadolivre', taxType: 'mei', taxRate: 5.0 },
    { name: 'EcomZero — Shein',             marketplace: 'shein',        taxType: 'mei', taxRate: 5.0 },
    { name: 'EcomZero — TikTok Shop',       marketplace: 'tiktok',       taxType: 'mei', taxRate: 5.0 },
  ];

  const storeMap = {};
  for (const cfg of storeConfigs) {
    let store = await prisma.store.findFirst({ where: { userId: user.id, marketplace: cfg.marketplace } });
    if (!store) {
      store = await prisma.store.create({ data: { ...cfg, userId: user.id } });
      console.log(`✅  Loja criada: ${store.name}`);
    } else {
      console.log(`✅  Loja existente: ${store.name}`);
    }
    storeMap[cfg.marketplace] = store;
  }

  // ── Produtos ─────────────────────────────────────────────────────────────────
  const productMap = {};
  const allProdDefs = [
    { mp: 'shopee',       prods: PRODUCTS_SHOPEE },
    { mp: 'mercadolivre', prods: PRODUCTS_ML     },
    { mp: 'shein',        prods: PRODUCTS_SHEIN  },
    { mp: 'tiktok',       prods: PRODUCTS_TIKTOK },
  ];

  for (const { mp, prods } of allProdDefs) {
    const store = storeMap[mp];
    productMap[mp] = [];
    for (const p of prods) {
      let prod = await prisma.product.findFirst({ where: { storeId: store.id, sku: p.sku } });
      if (!prod) {
        prod = await prisma.product.create({
          data: {
            storeId:   store.id,
            name:      p.name,
            sku:       p.sku,
            costPrice: p.cost,
            listPrice: p.list,
            packaging: 1.50,
            stock:     randInt(20, 200),
            minStock:  10,
          },
        });
      }
      productMap[mp].push({ ...p, id: prod.id });
    }
    console.log(`✅  Produtos ${mp}: ${productMap[mp].length}`);
  }

  // ── Fornecedores ──────────────────────────────────────────────────────────────
  const supplierNames = ['Distribuidora Aroma Brasil', 'SC Importados LTDA', 'Beauty Wholesale SP'];
  const suppliers = [];
  for (const sname of supplierNames) {
    let s = await prisma.supplier.findFirst({ where: { userId: user.id, name: sname } });
    if (!s) {
      s = await prisma.supplier.create({
        data: { userId: user.id, name: sname, leadDays: randInt(5, 14), phone: '(11) 9' + randInt(1000, 9999) + '-' + randInt(1000, 9999) },
      });
    }
    suppliers.push(s);
  }
  console.log(`✅  Fornecedores: ${suppliers.length}`);

  // ── Pedidos (Maio e Junho 2026) ───────────────────────────────────────────────
  const orderConfigs = [
    { mp: 'shopee',       count: 120, year: 2026, month: 5 },
    { mp: 'shopee',       count: 85,  year: 2026, month: 6 },
    { mp: 'mercadolivre', count: 65,  year: 2026, month: 5 },
    { mp: 'mercadolivre', count: 48,  year: 2026, month: 6 },
    { mp: 'shein',        count: 35,  year: 2026, month: 5 },
    { mp: 'shein',        count: 22,  year: 2026, month: 6 },
    { mp: 'tiktok',       count: 28,  year: 2026, month: 5 },
    { mp: 'tiktok',       count: 19,  year: 2026, month: 6 },
  ];

  for (const cfg of orderConfigs) {
    const store    = storeMap[cfg.mp];
    const existing = await prisma.order.count({
      where: {
        storeId: store.id,
        soldAt:  {
          gte: new Date(Date.UTC(cfg.year, cfg.month - 1, 1)),
          lte: new Date(Date.UTC(cfg.year, cfg.month, 0, 23, 59, 59)),
        },
      },
    });
    if (existing >= cfg.count) {
      console.log(`✅  Pedidos ${cfg.mp} ${cfg.year}-${String(cfg.month).padStart(2,'0')}: já existem (${existing})`);
      continue;
    }

    const rows = makeOrders(store.id, productMap[cfg.mp], cfg.year, cfg.month, cfg.count, cfg.mp);
    const BATCH = 50;
    let created = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      // upsert idempotente
      await Promise.all(batch.map(o => prisma.order.upsert({
        where:  { storeId_orderId: { storeId: o.storeId, orderId: o.orderId } },
        create: o,
        update: {},
      })));
      created += batch.length;
    }
    console.log(`✅  Pedidos ${cfg.mp} ${cfg.year}-${String(cfg.month).padStart(2,'0')}: ${created} criados`);
  }

  // ── Contas a Pagar demo ───────────────────────────────────────────────────────
  const billCount = await prisma.bill.count({ where: { userId: user.id } });
  if (billCount === 0) {
    const billDefs = [
      { description: 'Frete — Distribuidora Aroma Brasil',        amount: 320.00,  dueDate: daysAgo(-5),  status: 'pending', category: 'fornecedor' },
      { description: 'Embalagens caixas papelão — SC Importados', amount: 185.50,  dueDate: daysAgo(3),   status: 'paid',    category: 'fornecedor' },
      { description: 'Mensalidade ERP EcomZero Hub',              amount: 99.90,   dueDate: daysAgo(-10), status: 'pending', category: 'software'   },
      { description: 'Frete Transportadora BR Log',               amount: 240.00,  dueDate: daysAgo(7),   status: 'paid',    category: 'logistica'  },
      { description: 'Estoque Glade Automatico — Beauty WS',      amount: 1200.00, dueDate: daysAgo(-2),  status: 'pending', category: 'fornecedor' },
    ];
    await Promise.all(billDefs.map(b => prisma.bill.create({
      data: { userId: user.id, storeId: storeMap.shopee.id, ...b, paidAt: b.status === 'paid' ? daysAgo(1) : null },
    })));
    console.log(`✅  Contas a pagar: ${billDefs.length}`);
  }

  // ── Pedido de compra demo ─────────────────────────────────────────────────────
  const poCount = await prisma.purchaseOrder.count({ where: { userId: user.id } });
  if (poCount === 0 && suppliers.length > 0) {
    const po = await prisma.purchaseOrder.create({
      data: {
        userId:     user.id,
        supplierId: suppliers[0].id,
        status:     'sent',
        orderedAt:  daysAgo(5),
        expectedAt: daysAgo(-3),
        notes:      'Reposição mensal — Difusores e Refis',
        total:      1450.00,
        items: {
          create: [
            { productId: productMap.shopee[0].id, quantity: 30, unitCost: 21.00 },
            { productId: productMap.shopee[2].id, quantity: 50, unitCost: 17.30 },
          ],
        },
      },
    });
    console.log(`✅  Pedido de compra criado: ${po.id}`);
  }

  // ── Meta mensal demo ─────────────────────────────────────────────────────────
  for (const m of ['2026-05', '2026-06']) {
    await prisma.goal.upsert({
      where:  { userId_month: { userId: user.id, month: m } },
      create: { userId: user.id, month: m, revenue: 8000, profit: 1500, orders: 200 },
      update: {},
    });
  }
  console.log('✅  Metas mensais criadas');

  console.log('\n🎉  Seed concluído!');
  console.log('─────────────────────────────────');
  console.log('  Email:  demo@ecomzero.com.br');
  console.log('  Senha:  Demo@2025');
  console.log('  URL:    https://profittrack.ecomzero.com.br');
  console.log('─────────────────────────────────');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
