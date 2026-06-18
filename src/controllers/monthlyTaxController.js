const prisma = require('../lib/prisma');
const { r2, parseYearMonth } = require('../lib/utils');

// Soma o GMV (valid+pending) de cada loja do usuário no mês,
// direto dos pedidos (Order), independente do mês estar fechado
async function computeRevenueByStore(userId, month) {
  const stores = await prisma.store.findMany({
    where: { userId },
    select: { id: true, name: true, marketplace: true },
  });
  if (!stores.length) return { revenueByStore: {}, totalRevenue: 0 };

  const { year: y, month: mo } = parseYearMonth(month);
  const start = new Date(Date.UTC(y, mo - 1, 1));
  const end   = new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999));

  const grouped = await prisma.order.groupBy({
    by: ['storeId'],
    where: {
      storeId: { in: stores.map((s) => s.id) },
      soldAt: { gte: start, lte: end },
      orderCategory: { in: ['valid', 'pending'] },
    },
    _sum: { calcGmv: true },
  });
  const revenueByStoreId = new Map(grouped.map((g) => [g.storeId, r2(g._sum.calcGmv)]));

  const revenueByStore = {};
  let totalRevenue = 0;

  for (const store of stores) {
    const revenue = revenueByStoreId.get(store.id);
    if (!revenue) continue;

    revenueByStore[store.id] = {
      storeName: store.name,
      marketplace: store.marketplace,
      revenue,
    };
    totalRevenue += revenue;
  }

  return { revenueByStore, totalRevenue: r2(totalRevenue) };
}

// ── GET /api/monthly-tax/:month ──────────────────────────────────────────────
async function getMonthlyTax(req, res) {
  try {
    const { month } = req.params;

    const existing = await prisma.monthlyTax.findUnique({
      where: { userId_month: { userId: req.userId, month } },
    });

    if (existing) {
      return res.json({
        exists: true,
        revenueByStore: existing.revenueByStore,
        totalRevenue: existing.totalRevenue,
        dasAmount: existing.dasAmount,
        effectiveRate: existing.effectiveRate,
      });
    }

    const { revenueByStore, totalRevenue } = await computeRevenueByStore(req.userId, month);

    return res.json({
      exists: false,
      revenueByStore,
      totalRevenue,
      dasAmount: null,
      effectiveRate: null,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar imposto mensal' });
  }
}

// ── POST /api/monthly-tax/:month ─────────────────────────────────────────────
async function saveMonthlyTax(req, res) {
  try {
    const { month } = req.params;
    const { dasAmount } = req.body;

    if (dasAmount == null || isNaN(dasAmount) || dasAmount < 0) {
      return res.status(400).json({ error: 'dasAmount inválido' });
    }

    const { revenueByStore, totalRevenue } = await computeRevenueByStore(req.userId, month);
    const effectiveRate = totalRevenue > 0 ? r2((dasAmount / totalRevenue) * 100) : null;

    const saved = await prisma.monthlyTax.upsert({
      where: { userId_month: { userId: req.userId, month } },
      create: {
        userId: req.userId, month,
        revenueByStore, totalRevenue,
        dasAmount: r2(dasAmount), effectiveRate,
      },
      update: {
        revenueByStore, totalRevenue,
        dasAmount: r2(dasAmount), effectiveRate,
      },
    });

    return res.json({
      exists: true,
      revenueByStore: saved.revenueByStore,
      totalRevenue: saved.totalRevenue,
      dasAmount: saved.dasAmount,
      effectiveRate: saved.effectiveRate,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao salvar imposto mensal' });
  }
}

// ── GET /api/monthly-tax/history ─────────────────────────────────────────────
async function getMonthlyTaxHistory(req, res) {
  try {
    const history = await prisma.monthlyTax.findMany({
      where: { userId: req.userId },
      orderBy: { month: 'desc' },
      take: 12,
      select: { month: true, totalRevenue: true, dasAmount: true, effectiveRate: true },
    });
    return res.json({ history });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao buscar histórico de DAS' });
  }
}

// Tabela Simples Nacional Anexo I — Comércio (vigente 2024-2025)
const FAIXAS_SIMPLES = [
  { numero: 1, limite: 180000,  aliquota: 0.04,  pd: 0       },
  { numero: 2, limite: 360000,  aliquota: 0.073, pd: 5940    },
  { numero: 3, limite: 720000,  aliquota: 0.095, pd: 13860   },
  { numero: 4, limite: 1800000, aliquota: 0.107, pd: 22500   },
  { numero: 5, limite: 3600000, aliquota: 0.143, pd: 87300   },
  { numero: 6, limite: 4800000, aliquota: 0.19,  pd: 378000  },
];

// ── GET /api/monthly-tax/simples-faixa ───────────────────────────────────────
// Retorna em qual faixa do Simples Nacional o seller está baseado no RBT12.
// Query param opcional: ?rbt12Override=500000 — seller informa o valor real dos
// últimos 12 meses quando o sistema não tem dados completos.
async function getSimplesFaixaInfo(req, res) {
  try {
    const stores = await prisma.store.findMany({
      where: { userId: req.userId },
      select: { id: true, taxType: true },
    });
    if (!stores.length) {
      return res.json({
        confiabilidade: 'indeterminado',
        mesesDeData: 0,
        rbt12Parcial: 0,
        faixaEstimativaMinima: 1,
        aliquotaEstimativaMinima: 4.0,
        faixa: null,
        aliquotaEfetivaPct: null,
      });
    }

    const allMei = stores.length > 0 && stores.every((s) => s.taxType === 'mei');
    if (allMei) {
      return res.json({ taxType: 'mei', faixa: null, aliquotaEfetivaPct: null, confiabilidade: 'mei' });
    }

    const storeIds = stores.map((s) => s.id);
    const since = new Date();
    since.setFullYear(since.getFullYear() - 1);
    since.setDate(1);
    since.setHours(0, 0, 0, 0);

    const result = await prisma.order.aggregate({
      where: {
        storeId: { in: storeIds },
        soldAt: { gte: since },
        orderCategory: { in: ['valid', 'pending'] },
      },
      _sum: { calcGmv: true },
      _min: { soldAt: true },
      _max: { soldAt: true },
      _count: true,
    });

    const rbt12 = r2(result._sum.calcGmv ?? 0);

    // Meses de dados: diferença entre o pedido mais antigo e o mais recente no período
    let mesesDeData = 0;
    if ((result._count ?? 0) > 0 && result._min.soldAt) {
      const minDate = new Date(result._min.soldAt);
      const maxDate = new Date(result._max.soldAt);
      mesesDeData = (maxDate.getFullYear() - minDate.getFullYear()) * 12
        + (maxDate.getMonth() - minDate.getMonth()) + 1;
    }
    const incompleto = mesesDeData < 12;

    // rbt12Override: seller informa o faturamento real dos últimos 12 meses
    const overrideRaw = req.query.rbt12Override ? parseFloat(req.query.rbt12Override) : null;
    const rbt12Efetivo = (overrideRaw && overrideRaw > 0) ? overrideRaw : rbt12;

    const faixa = FAIXAS_SIMPLES.find((f) => rbt12Efetivo <= f.limite) ?? FAIXAS_SIMPLES[FAIXAS_SIMPLES.length - 1];
    const aliquotaEfetivaPct = rbt12Efetivo > 0
      ? r2(((rbt12Efetivo * faixa.aliquota - faixa.pd) / rbt12Efetivo) * 100)
      : 0;
    const nextFaixa = FAIXAS_SIMPLES.find((f) => f.numero === faixa.numero + 1) ?? null;
    const proximoLimite = nextFaixa?.limite ?? null;
    const distanciaProximaFaixa = proximoLimite ? r2(proximoLimite - rbt12Efetivo) : null;

    const temOverride = !!(overrideRaw && overrideRaw > 0);
    const confiabilidade = (mesesDeData >= 12 || temOverride) ? 'confiavel' : 'indeterminado';

    if (confiabilidade === 'indeterminado') {
      return res.json({
        confiabilidade: 'indeterminado',
        mesesDeData,
        rbt12Parcial: rbt12,
        faixaEstimativaMinima: faixa.numero,
        aliquotaEstimativaMinima: aliquotaEfetivaPct,
        faixa: null,
        aliquotaEfetivaPct: null,
      });
    }

    return res.json({
      confiabilidade: 'confiavel',
      rbt12,
      rbt12Efetivo,
      mesesDeData,
      incompleto,
      faixa: faixa.numero,
      aliquotaNominalPct: r2(faixa.aliquota * 100),
      parcelaDeducao: faixa.pd,
      aliquotaEfetivaPct,
      proximoLimite,
      distanciaProximaFaixa,
      alertaFaixa: !!proximoLimite && distanciaProximaFaixa < proximoLimite * 0.1,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erro ao calcular faixa Simples Nacional' });
  }
}

module.exports = { getMonthlyTax, saveMonthlyTax, getMonthlyTaxHistory, getSimplesFaixaInfo };
