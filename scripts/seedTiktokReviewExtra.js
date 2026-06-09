/**
 * Seed script — corrige a conta tiktok-review@ecomzero.com.br para revisão:
 *  - eleva plano para 'pro' / role 'seller' (estava 'free' / 'user' — "1 loja")
 *  - completa com lojas de Shopee, Mercado Livre e Shein (produtos + pedidos),
 *    para que a tela de Integrações deixe de mostrar "Nenhuma loja configurada"
 *
 * Uso: node scripts/seedTiktokReviewExtra.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function r2(n) { return Math.round(n * 100) / 100; }
function rnd(min, max) { return r2(min + Math.random() * (max - min)); }
function randInt(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
function dateInMonth(year, month, day) { return new Date(Date.UTC(year, month - 1, day, randInt(8, 20), randInt(0, 59))); }

const PRODUCTS_SHOPEE = [
  { name: 'Difusor Elétrico Air Wick com Refil 16ml',     sku: 'EZ0028-1', cost: 21.00, list: 38.99 },
  { name: 'Glade Aromatizador Automático 2 Refis 260ml',  sku: 'EZ0031',   cost: 34.00, list: 59.99 },
  { name: 'Refil Lavanda & Gerânio 12ml',                 sku: 'EZ0028-3', cost: 17.30, list: 31.99 },
  { name: 'Bom Ar Click Spray Repelente 360ml',           sku: 'EZ0045',   cost: 12.50, list: 24.99 },
  { name: 'Aromatizador Ambiente Floral 250ml',           sku: 'EZ0052',   cost: 8.90,  list: 19.99 },
  { name: 'Difusor de Varetas Bambu & Sândalo 200ml',     sku: 'EZ0067',   cost: 14.00, list: 29.99 },
  { name: 'Vela Aromática Lavanda Grande 200g',           sku: 'EZ0071',   cost: 11.50, list: 24.99 },
  { name: 'Sabonete Líquido Premium 500ml',               sku: 'EZ0083',   cost: 7.80,  list: 17.99 },
];

const PRODUCTS_ML = [
  { name: 'Difusor Elétrico Air Wick 16ml Premium',       sku: 'ML001', cost: 21.00, list: 44.90 },
  { name: 'Glade Aromatizador Kit Completo',              sku: 'ML002', cost: 34.00, list: 64.90 },
  { name: 'Aromatizador Spray Automático 360ml',          sku: 'ML003', cost: 12.50, list: 27.90 },
  { name: 'Difusor de Varetas Premium 300ml',             sku: 'ML004', cost: 18.00, list: 39.90 },
  { name: 'Vela Aromática Soja Natural 180g',             sku: 'ML005', cost: 13.00, list: 29.90 },
  { name: 'Sachê Perfumado Lavanda 10 unidades',          sku: 'ML006', cost: 10.50, list: 24.90 },
];

const PRODUCTS_SHEIN = [
  { name: 'Body Splash Floral 250ml',                     sku: 'SH001', cost: 8.50,  list: 19.90 },
  { name: 'Hidratante Corporal Manteiga Karité 400ml',    sku: 'SH002', cost: 11.00, list: 27.90 },
  { name: 'Esfoliante Corporal Café Orgânico 200g',       sku: 'SH003', cost: 9.00,  list: 22.90 },
  { name: 'Kit Skincare Básico 3 Peças',                  sku: 'SH004', cost: 24.00, list: 59.90 },
  { name: 'Máscara Capilar Reparadora 500g',              sku: 'SH005', cost: 13.50, list: 34.90 },
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
    const orderId  = `TKR${year}${String(month).padStart(2,'0')}${marketplace.slice(0,2).toUpperCase()}${String(i+1).padStart(6,'0')}`;

    let commRate = 0, svcFee = 0;
    if (marketplace === 'shopee')            { commRate = price < 80 ? 0.20 : 0.14; svcFee = price < 80 ? 4.00 : (price < 100 ? 16 : 20); }
    else if (marketplace === 'mercadolivre') { commRate = 0.11; }
    else if (marketplace === 'shein')        { commRate = 0.18; }

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
  console.log('🌱  Corrigindo conta tiktok-review...');

  const EMAIL = 'tiktok-review@ecomzero.com.br';
  let user = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (!user) {
    console.error(`❌  Usuário ${EMAIL} não encontrado.`);
    process.exit(1);
  }

  // ── Eleva plano/role (estava free/user — "acesso básico, 1 loja") ───────────
  if (user.plan !== 'pro' || user.role !== 'seller') {
    user = await prisma.user.update({
      where: { id: user.id },
      data:  { plan: 'pro', role: 'seller' },
    });
    console.log(`✅  Plano/role atualizados: plan=${user.plan} role=${user.role}`);
  } else {
    console.log(`✅  Plano/role já corretos: plan=${user.plan} role=${user.role}`);
  }

  const storeConfigs = [
    { name: 'Minha Loja TikTok — Shopee',        marketplace: 'shopee',       taxType: 'mei', taxRate: 5.0, prods: PRODUCTS_SHOPEE },
    { name: 'Minha Loja TikTok — Mercado Livre', marketplace: 'mercadolivre', taxType: 'mei', taxRate: 5.0, prods: PRODUCTS_ML },
    { name: 'Minha Loja TikTok — Shein',         marketplace: 'shein',        taxType: 'mei', taxRate: 5.0, prods: PRODUCTS_SHEIN },
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
      { count: cfg.marketplace === 'shopee' ? 90 : (cfg.marketplace === 'mercadolivre' ? 60 : 32), year: 2026, month: 5 },
      { count: cfg.marketplace === 'shopee' ? 64 : (cfg.marketplace === 'mercadolivre' ? 44 : 21), year: 2026, month: 6 },
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

  console.log('\n🎉  Concluído! A conta tiktok-review agora é plan=pro/role=seller e tem lojas em TikTok, Shopee, Mercado Livre e Shein.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
