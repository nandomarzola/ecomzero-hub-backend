const prisma = require('../lib/prisma');
const { r2 }  = require('../lib/utils');
const { calcOrderFinancials } = require('../services/profitCalculator');

// São Paulo UTC-3 fixo — alinha com closingController e goalsController
function spToUtc(dateStr, endOfDay = false) {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  return endOfDay
    ? new Date(Date.UTC(y, m - 1, d, 26, 59, 59, 999)) // 23:59:59 SP → 02:59:59+1d UTC
    : new Date(Date.UTC(y, m - 1, d, 3, 0, 0, 0));      // 00:00:00 SP → 03:00:00 UTC
}

function computeBillStatus(bill) {
  if (bill.status === 'paid') return 'paid';
  return new Date(bill.dueDate) < new Date() ? 'overdue' : 'pending';
}

// Categorias de receita — alinha com closingController
const REVENUE_CATEGORIES = ['valid', 'pending', 'returned_partial'];

async function getSummary(req, res) {
  const { storeId, startDate, endDate } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;
  const stores = await prisma.store.findMany({
    where:  storeWhere,
    select: { id: true, taxRate: true, taxType: true, fixedMonthlyTax: true, marketplace: true },
  });
  const storeIds       = stores.map((s) => s.id);
  const storeTaxRateMap = new Map(stores.map((s) => [s.id, s.taxRate ?? 0]));
  const marketplaceMap  = new Map(stores.map((s) => [s.id, s.marketplace ?? 'shopee']));

  // DAS MEI: soma valor fixo mensal por loja MEI
  const fixedTaxAmount = r2(
    stores
      .filter((s) => s.taxType === 'mei')
      .reduce((sum, s) => sum + (s.fixedMonthlyTax ?? 0), 0),
  );

  // Fix 1+2: timezone SP + competência de caixa (orderPaidAt)
  // Pedidos com repasse confirmado: filtra por orderPaidAt
  // Pedidos sem repasse (pending): filtra por soldAt (fallback)
  const startUtc = spToUtc(startDate, false);
  const endUtc   = spToUtc(endDate,   true);

  const dateRangeWhere = startUtc && endUtc
    ? {
        OR: [
          { orderPaidAt: { gte: startUtc, lte: endUtc } },
          { orderPaidAt: null, soldAt: { gte: startUtc, lte: endUtc } },
        ],
      }
    : {};

  // Fix 3: orderCategory em vez de status legado
  const orderWhere = {
    storeId:       { in: storeIds },
    orderCategory: { in: REVENUE_CATEGORIES },
    ...dateRangeWhere,
  };

  // Bills: dueDate no período (SP)
  const billDateWhere = startUtc && endUtc
    ? { dueDate: { gte: startUtc, lte: endUtc } }
    : {};
  const billWhere = {
    userId: req.userId,
    ...(storeId ? { storeId } : {}),
    ...billDateWhere,
  };

  const [orders, bills] = await Promise.all([
    prisma.order.findMany({
      where:  orderWhere,
      select: {
        storeId:            true,
        orderCategory:      true,
        orderStatus:        true,
        status:             true,
        calcGmv:            true,
        calcProductCost:    true,
        calcPackaging:      true,
        calcNetRevenue:     true,
        calcShopeeFee:      true,
        soldAt:             true,
        orderPaidAt:        true,
        platformCommission: true,
        platformServiceFee: true,
        sellerCoupon:       true,
        lmmDiscount:        true,
        escrowAmount:       true,
        shopeeShippingCost: true,
        quantity:           true,
      },
    }),
    prisma.bill.findMany({ where: billWhere }),
  ]);

  // ── Fórmula canônica compartilhada (services/profitCalculator.js) ──────────
  // Duas métricas SEPARADAS, nunca somadas:
  //   entradaBruta  = dinheiro que entra/entrará (GMV valid + pending), sem
  //                   desconto de taxa/imposto/custo e sem estimativa alguma
  //   lucroLiquido  = Σ lucro canônico por pedido (mesma função do dashboard/
  //                   fechamento/metas/pedidos); pendente sem taxa confiável
  //                   fica FORA do lucro, mas DENTRO da entradaBruta
  let entradaBruta            = 0; // GMV valid + pending
  let entradaBrutaConfirmada  = 0; // GMV valid
  let entradaBrutaPendente    = 0; // GMV pending
  let lucroLiquidoPedidos     = 0; // Σ fin.profit (confirmados + estimados confiáveis)
  let lucroConfirmado         = 0; // Σ fin.profit de pedidos com repasse real
  let lucroEstimado           = 0; // Σ fin.profit de estimativas confiáveis
  let semEstimativaCount      = 0; // pedidos fora da projeção de lucro

  let grossRevenue     = 0; // GMV de pedidos com repasse confirmado (escrow real)
  let pendingRevenue   = 0; // GMV de pedidos aguardando repasse
  let totalRepasse     = 0; // soma dos repasses reais (escrow)
  let repassePending   = 0; // soma dos repasses estimados confiáveis
  let totalCommission  = 0;
  let totalServiceFee  = 0;
  let totalFreight     = 0;
  let totalCmv         = 0; // escopo: pedidos confirmados (reconcilia com o DRE)
  let totalPackaging   = 0;
  let totalTaxProv     = 0;
  let confirmedCount   = 0;
  let pendingCount     = 0;

  const monthlyMap = {};

  for (const o of orders) {
    const aliquota = storeTaxRateMap.get(o.storeId) ?? 0;
    const gmv      = o.calcGmv ?? 0;
    const freight  = o.shopeeShippingCost ?? 0;
    const fin      = calcOrderFinancials(o, aliquota, marketplaceMap.get(o.storeId));
    const reliable = fin.profit !== null && fin.profit !== undefined;

    // Entrada bruta: valid + pending, sem dedução nenhuma
    if (o.orderCategory === 'valid')   { entradaBruta += gmv; entradaBrutaConfirmada += gmv; }
    if (o.orderCategory === 'pending') { entradaBruta += gmv; entradaBrutaPendente   += gmv; }

    // Lucro canônico: mesmo tratamento dos outros 4 pontos
    if (reliable) {
      lucroLiquidoPedidos += fin.profit;
      if (fin.confirmed) lucroConfirmado += fin.profit;
      else               lucroEstimado   += fin.profit;
    } else {
      semEstimativaCount++;
    }

    if (fin.confirmed) {
      grossRevenue += gmv;
      totalRepasse += fin.netRevenue;
      confirmedCount++;
      // Componentes do DRE escopados a confirmados — as linhas reconciliam com netProfit
      totalCommission += o.platformCommission ?? 0;
      totalServiceFee += o.platformServiceFee ?? 0;
      totalTaxProv    += fin.tax;
      totalCmv        += o.calcProductCost ?? 0;
      totalPackaging  += o.calcPackaging ?? 0;
    } else {
      pendingRevenue += gmv;
      pendingCount++;
      if (reliable) repassePending += fin.netRevenue;
    }
    totalFreight += freight;

    // Mapa mensal (usa orderPaidAt quando disponível, fallback soldAt)
    const dateRef = o.orderPaidAt ?? o.soldAt;
    const key = dateRef ? dateRef.toISOString().substring(0, 7) : 'unknown';
    if (!monthlyMap[key]) {
      monthlyMap[key] = { month: key, revenue: 0, cmv: 0, fees: 0, operational: 0, bills: 0, taxProvision: 0 };
    }
    const m      = monthlyMap[key];
    m.revenue     += gmv;
    m.fees        += fin.fee;
    m.taxProvision += fin.tax;
    m.cmv         += o.calcProductCost ?? 0;
    m.operational += (o.calcPackaging ?? 0) + freight;
  }

  const totalMarketplaceFees  = r2(totalCommission + totalServiceFee);
  const totalOperationalCosts = r2(totalPackaging + totalFreight);

  // Bills
  const enrichedBills = bills.map((b) => ({ ...b, computedStatus: computeBillStatus(b) }));
  const totalPaid     = r2(enrichedBills.filter((b) => b.computedStatus === 'paid').reduce((s, b) => s + b.amount, 0));
  const totalPending  = r2(enrichedBills.filter((b) => b.computedStatus === 'pending').reduce((s, b) => s + b.amount, 0));
  const totalOverdue  = r2(enrichedBills.filter((b) => b.computedStatus === 'overdue').reduce((s, b) => s + b.amount, 0));

  const byCategory = {};
  for (const b of enrichedBills) {
    if (!byCategory[b.category]) byCategory[b.category] = 0;
    byCategory[b.category] += b.amount;
  }

  // Fix 1: DRE com sequência correta para seller de marketplace
  // Receita Bruta (GMV)
  // (-) Taxas Marketplace          ← ANTES do CMV
  // = Repasse Líquido
  // (-) CMV
  // (-) Custos Operacionais
  // = Resultado Antes de Impostos e Despesas
  // (-) Provisão de Imposto
  // (-) Despesas Pagas
  // = Lucro Líquido Real
  // Repasse Líquido = repasse REAL da plataforma (escrow) dos pedidos confirmados —
  // valor canônico, não mais grossRevenue − taxas (que ignorava ajustes do escrow)
  const repasseLiquido  = r2(totalRepasse);
  const resultadoBruto  = r2(repasseLiquido - totalCmv - totalOperationalCosts);
  const lucroLiquidoDre = r2(resultadoBruto - totalTaxProv - fixedTaxAmount - totalPaid);
  // Projeção: com pendentes e vencidas
  const lucroLiquidoProj = r2(lucroLiquidoDre - totalPending - totalOverdue);

  // Mapa mensal — bills
  for (const b of enrichedBills) {
    const key = new Date(b.dueDate).toISOString().substring(0, 7);
    if (!monthlyMap[key]) monthlyMap[key] = { month: key, revenue: 0, cmv: 0, fees: 0, operational: 0, bills: 0, taxProvision: 0 };
    monthlyMap[key].bills += b.amount;
  }

  const monthlyChart = Object.values(monthlyMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      month:        m.month,
      revenue:      r2(m.revenue),
      cmv:          r2(m.cmv),
      fees:         r2(m.fees),
      operational:  r2(m.operational),
      bills:        r2(m.bills),
      taxProvision: r2(m.taxProvision),
      netProfit:    r2(m.revenue - m.fees - m.cmv - m.operational - m.bills - m.taxProvision),
    }));

  const soonLimit = new Date();
  soonLimit.setDate(soonLimit.getDate() + 30);
  const upcoming = enrichedBills
    .filter((b) => b.computedStatus === 'pending' && new Date(b.dueDate) <= soonLimit)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
    .slice(0, 10);

  return res.json({
    orderCount: orders.length,

    // ── Métricas de caixa vs lucro — SEPARADAS, nunca somar uma na outra ─────
    cash: {
      // Dinheiro que entra/entrará (GMV valid + pending), sem desconto algum
      entradaBruta:           r2(entradaBruta),
      entradaBrutaConfirmada: r2(entradaBrutaConfirmada),
      entradaBrutaPendente:   r2(entradaBrutaPendente),
      // Lucro pela fórmula canônica (mesma dos outros 4 pontos do sistema)
      lucroLiquido:           r2(lucroLiquidoPedidos),
      lucroConfirmado:        r2(lucroConfirmado),
      lucroEstimado:          r2(lucroEstimado),
      // Pedidos sem estimativa confiável: fora do lucro, dentro da entradaBruta
      pedidosSemEstimativa:   semEstimativaCount,
    },

    dre: {
      // Receita
      grossRevenue:        r2(grossRevenue),
      estimatedRevenue:    r2(pendingRevenue),
      repasseConfirmed:    r2(totalRepasse),
      repassePending:      r2(repassePending),
      confirmedOrderCount: confirmedCount,
      pendingOrderCount:   pendingCount,

      // Fix 1: nova sequência — taxas antes do CMV
      marketplaceFees: r2(totalMarketplaceFees),
      marketplaceFeesBreakdown: {
        commission: r2(totalCommission),
        serviceFee: r2(totalServiceFee),
        fixedFee:   0,
      },
      repasseLiquido,            // Receita Bruta - Taxas marketplace

      cmv:             r2(totalCmv),
      operationalCosts: r2(totalOperationalCosts),
      operationalCostsBreakdown: {
        packaging: r2(totalPackaging),
        supplies:  0,
        freight:   r2(totalFreight),
      },

      resultadoBruto,            // Repasse - CMV - Operacional

      taxProvision:   r2(totalTaxProv),
      fixedTax:       r2(fixedTaxAmount),

      billsPaid:      r2(totalPaid),
      billsPending:   r2(totalPending),
      billsOverdue:   r2(totalOverdue),

      // Fix 6: fórmulas explícitas, sem switch silencioso
      netProfit:      lucroLiquidoDre,
      netProfitProjected: lucroLiquidoProj,

      // Campos legados mantidos para não quebrar frontend enquanto não atualiza
      grossProfit:            r2(repasseLiquido - totalCmv),
      operatingProfit:        resultadoBruto,
      operatingProfitProjected: r2(resultadoBruto - totalPending - totalOverdue),
    },
    bills: {
      totalPaid,
      totalPending,
      totalOverdue,
      byCategory: Object.entries(byCategory).map(([cat, val]) => ({ category: cat, amount: r2(val) })),
    },
    monthlyChart,
    upcoming,
  });
}

module.exports = { getSummary };
