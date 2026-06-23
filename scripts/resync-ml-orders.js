#!/usr/bin/env node
'use strict';
/**
 * resync-ml-orders.js — Atualiza escrowAmount e platformServiceFee de pedidos ML
 * específicos diretamente via API + Prisma update (sem criar duplicatas).
 *
 * Uso:
 *   node scripts/resync-ml-orders.js --store=<storeId> --from=YYYY-MM-DD --to=YYYY-MM-DD
 */

require('dotenv').config();
const prisma = require('../src/lib/prisma');
const {
  refreshAccessToken,
  fetchOrders,
  fetchShippingCosts,
  convertMlOrder,
} = require('../src/services/mlService');
const { recalculateOrdersForStore } = require('../src/services/recalculateService');

const args = process.argv.slice(2).reduce((a, s) => {
  const [k, v] = s.replace(/^--/, '').split('=');
  a[k] = v;
  return a;
}, {});

if (!args.store) {
  console.error('ERRO: --store=<storeId> obrigatório');
  process.exit(1);
}

const STORE_ID = args.store;
const FROM     = args.from ?? new Date().toISOString().substring(0, 7) + '-01';
const TO       = args.to   ?? new Date().toISOString().substring(0, 10);

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

async function main() {
  // ── 1. Carregar loja e refresh de token ─────────────────────────────────
  const store = await prisma.store.findUnique({
    where:  { id: STORE_ID },
    select: { id: true, name: true, marketplace: true, taxRate: true, mlSellerId: true,
              mlAccessToken: true, mlRefreshToken: true, mlTokenExpiresAt: true },
  });

  if (!store) { console.error('Loja não encontrada:', STORE_ID); process.exit(1); }
  if (store.marketplace !== 'mercadolivre') { console.error('Loja não é ML'); process.exit(1); }

  let accessToken = store.mlAccessToken;
  const tokenExpired = store.mlTokenExpiresAt && new Date(store.mlTokenExpiresAt) < new Date();

  if (tokenExpired || !accessToken) {
    console.log('[resync] Token expirado — refreshing...');
    try {
      const newTokens = await refreshAccessToken(store.mlRefreshToken);
      accessToken = newTokens.access_token;
      await prisma.store.update({
        where: { id: STORE_ID },
        data: {
          mlAccessToken:    newTokens.access_token,
          mlRefreshToken:   newTokens.refresh_token ?? store.mlRefreshToken,
          mlTokenExpiresAt: new Date(Date.now() + (newTokens.expires_in ?? 21600) * 1000),
        },
      });
      console.log('[resync] Token renovado.');
    } catch (err) {
      console.error('[resync] Falha ao renovar token:', err.message);
      process.exit(1);
    }
  }

  // ── 2. Buscar pedidos na API ML ─────────────────────────────────────────
  console.log(`[resync] Buscando pedidos ${FROM} → ${TO} na API ML...`);
  const mlOrders = await fetchOrders(
    accessToken,
    store.mlSellerId,
    new Date(FROM + 'T00:00:00Z').toISOString(),
    new Date(TO   + 'T23:59:59Z').toISOString()
  );
  console.log(`[resync] ${mlOrders.length} pedidos encontrados na API.`);

  if (mlOrders.length === 0) {
    console.log('[resync] Nenhum pedido no período. Nada a fazer.');
    await prisma.$disconnect();
    return;
  }

  // ── 3. Buscar custos de frete ────────────────────────────────────────────
  const shippingIds = [...new Set(mlOrders.map(o => o.shipping?.id).filter(Boolean))];
  console.log(`[resync] Buscando custos de frete para ${shippingIds.length} envios...`);
  const shippingCosts = shippingIds.length > 0
    ? await fetchShippingCosts(accessToken, shippingIds)
    : {};

  // ── 4. Calcular frete proporcional por pedido (mesmo algoritmo do mlController) ─
  const packGroups = {};
  mlOrders.forEach(o => {
    const packId   = String(o.pack_id ?? o.id);
    const shipId   = o.shipping?.id;
    const totalAmt = parseFloat(o.total_amount ?? 0);
    if (!packGroups[packId]) packGroups[packId] = [];
    packGroups[packId].push({ orderId: String(o.id), totalAmount: totalAmt, shippingId: shipId });
  });

  const shippingPerOrder = {};
  for (const [, group] of Object.entries(packGroups)) {
    const shipId     = group[0]?.shippingId;
    const sellerCost = shipId ? (shippingCosts[shipId]?.sellerCost ?? 0) : 0;
    const totalAmt   = group.reduce((s, o) => s + o.totalAmount, 0);
    for (const o of group) {
      const share = totalAmt > 0 ? o.totalAmount / totalAmt : 1 / group.length;
      shippingPerOrder[o.orderId] = r2(sellerCost * share);
    }
  }

  // ── 5. Converter e fazer UPDATE (não createMany — atualiza existentes) ──
  console.log('[resync] Atualizando pedidos no banco...');
  let updated = 0;
  let skipped = 0;

  for (const mlOrder of mlOrders) {
    const orderId         = String(mlOrder.id);
    const sellerShipping  = shippingPerOrder[orderId] ?? 0;
    const converted       = convertMlOrder(mlOrder, STORE_ID, null, store, null, sellerShipping);

    // Só atualiza se o pedido já existe no banco
    const existing = await prisma.order.findFirst({
      where: { orderId, storeId: STORE_ID },
      select: { id: true },
    });

    if (!existing) {
      // Pedido novo — upsert completo
      try {
        await prisma.order.create({ data: converted });
        console.log(`  [NEW] ${orderId}`);
        updated++;
      } catch {
        skipped++;
      }
      continue;
    }

    // Pedido existente — atualizar apenas os campos financeiros críticos
    await prisma.order.update({
      where: { id: existing.id },
      data: {
        escrowAmount:       converted.escrowAmount,
        platformServiceFee: converted.platformServiceFee,
        mlShippingCost:     converted.mlShippingCost,
        mlInstallmentFee:   converted.mlInstallmentFee,
        // Atualizar status e categoria para capturar mudanças (ex: delivered)
        orderStatus:        converted.orderStatus,
        orderCategory:      converted.orderCategory,
        orderPaidAt:        converted.orderPaidAt,
        orderDeliveredAt:   converted.orderDeliveredAt,
        buyerUsername:      converted.buyerUsername,
        // Recalcular campos calc* com base nos novos valores brutos
        calcGmv:            converted.calcGmv,
        calcShopeeFee:      converted.calcShopeeFee,
        calcNetRevenue:     converted.calcNetRevenue,
        salePrice:          converted.salePrice,
        status:             converted.status,
      },
    });
    updated++;
  }

  console.log(`[resync] ${updated} pedidos atualizados, ${skipped} pulados.`);

  // ── 6. Recalculate para atualizar calcGrossProfit / calcTax / calcProductCost ─
  const periodMonth = FROM.substring(0, 7);
  console.log(`[resync] Rodando recalculate para ${STORE_ID} mês ${periodMonth}...`);
  await recalculateOrdersForStore(STORE_ID, periodMonth);
  console.log('[resync] Recalculate concluído.');

  await prisma.$disconnect();
  console.log('[resync] Pronto.');
}

main().catch(async e => {
  console.error('[resync] Erro fatal:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
