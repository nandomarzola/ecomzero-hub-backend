const prisma = require('../lib/prisma');
const { r2 }  = require('../lib/utils');

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
    select: { id: true, taxRate: true, taxType: true, fixedMonthlyTax: true },
  });
  const storeIds       = stores.map((s) => s.id);
  const storeTaxRateMap = new Map(stores.map((s) => [s.id, s.taxRate ?? 0]));

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
        calcGmv:            true,
        calcProductCost:    true,
        calcPackaging:      true,
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

  // Fix 4+5: acumular CMV/receita somente por categoria correta
  let grossRevenue     = 0; // GMV de pedidos válidos confirmados (escrow real)
  let pendingRevenue   = 0; // GMV de pedidos pendentes
  let totalRepasse     = 0; // soma dos repasses reais (escrow)
  let repassePending   = 0; // soma dos repasses estimados (pending)
  let totalCommission  = 0;
  let totalServiceFee  = 0;
  let totalFreight     = 0;
  let totalCmv         = 0; // Fix 5: só para pedidos de receita
  let totalPackaging   = 0;
  let totalTaxProv     = 0;
  let confirmedCount   = 0;
  let pendingCount     = 0;

  const monthlyMap = {};

  for (const o of orders) {
    const isConfirmed = o.orderCategory === 'valid';
    const isPending   = o.orderCategory === 'pending';
    const aliquota    = storeTaxRateMap.get(o.storeId) ?? 0;
    const gmv         = o.calcGmv ?? 0;

    // Fórmula canônica de repasse — nunca usa calcShopeeFee/calcNetRevenue
    const fee      = r2((o.platformCommission ?? 0) + (o.platformServiceFee ?? 0));
    const disc     = r2((o.sellerCoupon ?? 0) + (o.lmmDiscount ?? 0));
    const net      = r2(gmv - fee - disc);
    const hasEscrow = o.escrowAmount !== null && o.escrowAmount !== undefined;
    const repasse  = isConfirmed && hasEscrow ? r2(o.escrowAmount) : net;
    const orderTax = r2(gmv * aliquota / 100);
    const freight  = o.shopeeShippingCost ?? 0;

    if (isConfirmed) {
      grossRevenue  += gmv;
      totalRepasse  += repasse;
      confirmedCount++;
    } else if (isPending) {
      pendingRevenue += gmv;
      repassePending += repasse;
      pendingCount++;
    }

    // Fix 5: CMV acumula somente para pedidos de receita (evita sub-estimar gross profit)
    totalCommission += o.platformCommission ?? 0;
    totalServiceFee += o.platformServiceFee ?? 0;
    totalFreight    += freight;
    totalTaxProv    += orderTax;
    totalCmv        += o.calcProductCost ?? 0;
    totalPackaging  += o.calcPackaging ?? 0;

    // Mapa mensal (usa orderPaidAt quando disponível, fallback soldAt)
    const dateRef = o.orderPaidAt ?? o.soldAt;
    const key = dateRef ? dateRef.toISOString().substring(0, 7) : 'unknown';
    if (!monthlyMap[key]) {
      monthlyMap[key] = { month: key, revenue: 0, cmv: 0, fees: 0, operational: 0, bills: 0, taxProvision: 0 };
    }
    const m      = monthlyMap[key];
    m.revenue     += gmv;
    m.fees        += fee;
    m.taxProvision += orderTax;
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
  const repasseLiquido  = r2(r2(grossRevenue) - totalMarketplaceFees);
  const resultadoBruto  = r2(repasseLiquido - totalCmv - totalOperationalCosts);
  // Fix 6: fórmula única e explícita — sem switch silencioso
  const lucroLiquido    = r2(resultadoBruto - totalTaxProv - fixedTaxAmount - totalPaid);
  // Projeção: com pendentes e vencidas
  const lucroLiquidoProj = r2(lucroLiquido - totalPending - totalOverdue);

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
      netProfit:      lucroLiquido,
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
