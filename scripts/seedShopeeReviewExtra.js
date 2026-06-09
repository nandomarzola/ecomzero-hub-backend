/**
 * Seed script — completa a conta shopee-review@ecomzero.com.br com lojas
 * de Mercado Livre, TikTok Shop e Shein (produtos + pedidos), para que a
 * tela de Integrações deixe de mostrar "Nenhuma loja configurada".
 *
 * Uso: node scripts/seedShopeeReviewExtra.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function r2(n) { return Math.round(n * 100) / 100; }
function rnd(min, max) { return r2(min + Math.random() * (max - min)); }
function randInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
function dateInMonth(year, month, day) { return new Date(Date.UTC(year, month - 1, day, randInt(8, 20), randInt(0, 59))); }

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
    const price    = r2(product.list * rnd(0.90, 1.00));
    const gmv      = r2(price * qty);
    const cat      = statusDist[i % statusDist.length];
    const day      = randInt(1, 28);
    const soldAt   = dateInMonth(year, month, day);
    const orderId  = `SPR${year}${String(month).padStart(2,'0')}${marketplace.slice(0,2).toUpperCase()}${String(i+1).padStart(6,'0')}`;

    let commRate = 0;
    if (marketplace === 'mercadolivre') commRate = 0.11;
    else if (marketplace === 'shein')   commRate = 0.18;
    else if (marketplace === 'tiktok')  commRate = 0.09;

    const comm      = r2(price * qty * commRate);
    const netRev    = r2(gmv - comm);
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
      platformServiceFee: 0,
      globalTotal:      gmv,
      orderTotal:       gmv,
      calcGmv:          isRevenue ? gmv : 0,
      calcShopeeFee:    isRevenue ? comm : 0,
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
  console.log('🌱  Completando lojas da conta shopee-review...');

  const EMAIL = 'shopee-review@ecomzero.com.br';
  const user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) {
    console.error(`❌  Usuário ${EMAIL} não encontrado.`);
    process.exit(1);
  }
  console.log(`✅  Usuário: ${user.id}`);

  const storeConfigs = [
    { name: 'Minha Loja Demo — Mercado Livre', marketplace: 'mercadolivre', taxType: 'mei', taxRate: 5.0, prods: PRODUCTS_ML },
    { name: 'Minha Loja Demo — Shein',         marketplace: 'shein',        taxType: 'mei', taxRate: 5.0, prods: PRODUCTS_SHEIN },
    { name: 'Minha Loja Demo — TikTok Shop',   marketplace: 'tiktok',       taxType: 'mei', taxRate: 5.0, prods: PRODUCTS_TIKTOK },
  ];

  for (const cfg of storeConfigs) {
    let store = await prisma.store.findFirst({ where: { userId: user.id, marketplace: cfg.marketplace } });
    if (!store) {
      store = await prisma.store.create({
        data: { name: cfg.name, marketplace: cfg.marketplace, taxType: cfg.taxType, taxRate: cfg.taxRate, userId: user.id },
      });
      console.log(`✅  Loja criada: ${store.name}`);
    } else {
      console.log(`✅  Loja existente: ${store.name}`);
    }

    // Produtos
    const products = [];
    for (const p of cfg.prods) {
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
      products.push({ ...p, id: prod.id });
    }
    console.log(`   produtos: ${products.length}`);

    // Pedidos — Maio e Junho 2026
    const orderConfigs = [
      { count: cfg.marketplace === 'mercadolivre' ? 65 : (cfg.marketplace === 'shein' ? 35 : 28), year: 2026, month: 5 },
      { count: cfg.marketplace === 'mercadolivre' ? 48 : (cfg.marketplace === 'shein' ? 22 : 19), year: 2026, month: 6 },
    ];

    for (const oc of orderConfigs) {
      const existing = await prisma.order.count({
        where: {
          storeId: store.id,
          soldAt: {
            gte: new Date(Date.UTC(oc.year, oc.month - 1, 1)),
            lte: new Date(Date.UTC(oc.year, oc.month, 0, 23, 59, 59)),
          },
        },
      });
      if (existing >= oc.count) {
        console.log(`   pedidos ${oc.year}-${String(oc.month).padStart(2,'0')}: já existem (${existing})`);
        continue;
      }

      const rows = makeOrders(store.id, products, oc.year, oc.month, oc.count, cfg.marketplace);
      const BATCH = 50;
      let created = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        await Promise.all(batch.map(o => prisma.order.upsert({
          where:  { storeId_orderId: { storeId: o.storeId, orderId: o.orderId } },
          create: o,
          update: {},
        })));
        created += batch.length;
      }
      console.log(`   pedidos ${oc.year}-${String(oc.month).padStart(2,'0')}: ${created} criados`);
    }
  }

  console.log('\n🎉  Concluído! A conta shopee-review agora tem lojas em Shopee, Mercado Livre, Shein e TikTok Shop.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
