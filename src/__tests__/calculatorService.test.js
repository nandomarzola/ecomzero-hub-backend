const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { calcOrderProfit, calcShopeeFeePorUnidade, calcMLFeePorUnidade, getMarketplaceRates } = require('../services/calculatorService');
const { r2, parsePage, parseYearMonth } = require('../lib/utils');

// ── r2 (arredondamento) ─────────────────────────────────────────────────────
describe('r2', () => {
  test('arredonda 2 casas decimais corretamente', () => {
    assert.equal(r2(1.005), 1.01);
    assert.equal(r2(2.555), 2.56);
    assert.equal(r2(0), 0);
    assert.equal(r2(100), 100);
  });

  test('lida com floats imprecisos (0.1 + 0.2)', () => {
    assert.equal(r2(0.1 + 0.2), 0.30);
  });

  test('arredonda valores negativos', () => {
    assert.equal(r2(-1.555), -1.55);
    assert.equal(r2(-2.005), -2.00);
  });
});

// ── parsePage ──────────────────────────────────────────────────────────────
describe('parsePage', () => {
  test('valores padrão: page=1, limit=30', () => {
    const { skip, take } = parsePage(undefined, undefined);
    assert.equal(skip, 0);
    assert.equal(take, 30);
  });

  test('page 2 com limit 10 → skip=10, take=10', () => {
    const { skip, take } = parsePage(2, 10);
    assert.equal(skip, 10);
    assert.equal(take, 10);
  });

  test('respeita maxLimit=100', () => {
    const { take } = parsePage(1, 9999);
    assert.equal(take, 100);
  });

  test('clamp page negativa para 1', () => {
    const { skip } = parsePage(-5, 10);
    assert.equal(skip, 0);
  });

  test('limit 0 usa defaultLimit', () => {
    const { take } = parsePage(1, 0);
    assert.equal(take, 30);
  });
});

// ── parseYearMonth ─────────────────────────────────────────────────────────
describe('parseYearMonth', () => {
  test('formatos válidos', () => {
    assert.deepEqual(parseYearMonth('2026-06'), { year: 2026, month: 6 });
    assert.deepEqual(parseYearMonth('2025-01'), { year: 2025, month: 1 });
    assert.deepEqual(parseYearMonth('2024-12'), { year: 2024, month: 12 });
  });

  test('formato inválido lança RangeError', () => {
    assert.throws(() => parseYearMonth('abc'), RangeError);
    assert.throws(() => parseYearMonth('2026-13'), RangeError);
    assert.throws(() => parseYearMonth('2026-00'), RangeError);
    assert.throws(() => parseYearMonth(undefined), RangeError);
    assert.throws(() => parseYearMonth('2026/06'), RangeError);
  });

  test('erro tem status 400', () => {
    try {
      parseYearMonth('abc');
    } catch (e) {
      assert.equal(e.status, 400);
    }
  });
});

// ── calcShopeeFeePorUnidade ────────────────────────────────────────────────
describe('calcShopeeFeePorUnidade', () => {
  test('preço < 80: 20% + R$4', () => {
    // R$50 → 50*0.20 + 4 = 14
    assert.equal(calcShopeeFeePorUnidade(50), 14);
  });

  test('preço 80-99: 14% + R$16', () => {
    // R$80 → 80*0.14 + 16 = 27.2
    assert.equal(r2(calcShopeeFeePorUnidade(80)), 27.2);
  });

  test('preço 100-199: 14% + R$20', () => {
    // R$100 → 100*0.14 + 20 = 34
    assert.equal(calcShopeeFeePorUnidade(100), 34);
  });

  test('preço >= 200: 14% + R$26', () => {
    // R$200 → 200*0.14 + 26 = 54
    assert.equal(calcShopeeFeePorUnidade(200), 54);
  });
});

// ── calcShopeeFeePorUnidade — por categoria ────────────────────────────────
describe('calcShopeeFeePorUnidade — por categoria', () => {
  test('eletronicos: 7% do preço (mais justo que faixa de preço)', () => {
    // R$120 × 7% = R$8.40  (sem categoria seria 14%+R$20 = R$36.80)
    assert.equal(calcShopeeFeePorUnidade(120, 'eletronicos'), r2(120 * 0.07));
  });

  test('moda: 12% do preço', () => {
    assert.equal(calcShopeeFeePorUnidade(80, 'moda'), r2(80 * 0.12));
  });

  test('casa: 10% do preço', () => {
    assert.equal(calcShopeeFeePorUnidade(100, 'casa'), r2(100 * 0.10));
  });

  test('saude_beleza: 10% do preço', () => {
    assert.equal(calcShopeeFeePorUnidade(50, 'saude_beleza'), r2(50 * 0.10));
  });

  test('categoria não mapeada usa geral (12%)', () => {
    assert.equal(calcShopeeFeePorUnidade(100, 'categoria_nova'), r2(100 * 0.12));
  });

  test('sem categoria usa tabela de faixa de preço (backward compat)', () => {
    // faixa < 80: 20% + R$4
    assert.equal(calcShopeeFeePorUnidade(50), 14);
    // faixa 100-199: 14% + R$20
    assert.equal(calcShopeeFeePorUnidade(100), 34);
  });
});

// ── getMarketplaceRates — Shopee com categoria ─────────────────────────────
describe('getMarketplaceRates — Shopee com categoria', () => {
  test('shopee eletronicos: 7% total, sem taxa fixa', () => {
    const result = getMarketplaceRates('shopee', 120, null, 'eletronicos');
    assert.equal(result.commissionPct, 7);
    assert.equal(result.fixedFee, 0);
  });

  test('shopee moda: 12% total', () => {
    const result = getMarketplaceRates('shopee', 80, null, 'moda');
    assert.equal(result.commissionPct, 12);
    assert.equal(result.fixedFee, 0);
  });

  test('shopee casa: 10% total', () => {
    const result = getMarketplaceRates('shopee', 100, null, 'casa');
    assert.equal(result.commissionPct, 10);
    assert.equal(result.fixedFee, 0);
  });

  test('shopee sem categoria: fallback para tabela de preço (backward compat)', () => {
    const result = getMarketplaceRates('shopee', 50);
    assert.equal(result.commissionPct, 20);
    assert.equal(result.fixedFee, 4);
  });
});

// ── calcMLFeePorUnidade ────────────────────────────────────────────────────
describe('calcMLFeePorUnidade', () => {
  test('gold_pro: 17% + R$6 fixo para produto > R$79', () => {
    // R$100 × 17% + R$6 = R$23
    assert.equal(calcMLFeePorUnidade(100, 'gold_pro'), 23);
  });

  test('gold_pro: 17% sem taxa fixa para produto ≤ R$79', () => {
    // R$50 × 17% = R$8.50
    assert.equal(calcMLFeePorUnidade(50, 'gold_pro'), 8.5);
  });

  test('gold_special (clássico): 11% + R$6 fixo para produto > R$79', () => {
    // R$100 × 11% + R$6 = R$17
    assert.equal(calcMLFeePorUnidade(100, 'gold_special'), 17);
  });

  test('gold_special: 11% sem taxa fixa para produto ≤ R$79', () => {
    // R$50 × 11% = R$5.50
    assert.equal(calcMLFeePorUnidade(50, 'gold_special'), 5.5);
  });

  test('free: 0%', () => {
    assert.equal(calcMLFeePorUnidade(100, 'free'), 0);
  });

  test('default é gold_special com taxa fixa (produto > R$79)', () => {
    // R$100 × 11% + R$6 = R$17
    assert.equal(calcMLFeePorUnidade(100), 17);
  });
});

// ── calcOrderProfit — Shopee ───────────────────────────────────────────────
describe('calcOrderProfit — Shopee', () => {
  test('pedido básico Shopee com custo', () => {
    // preço=100, qty=1, custo=30, embalagem=5, taxRate=6, marketplace=shopee
    // fee = 100*0.14 + 20 = 34 (faixa 100-199)
    // netRevenue = 100 - 34 = 66
    // taxAmount = 100 * 0.06 = 6
    // grossProfit = 66 - 6 - 30 - 5 = 25
    // margin = 25/100 = 25%
    const result = calcOrderProfit({
      agreedPrice: 100,
      quantity: 1,
      costPrice: 30,
      packagingCost: 5,
      taxRate: 6,
      marketplace: 'shopee',
    });
    assert.equal(result.gmv, 100);
    assert.equal(result.netRevenue, 66);
    assert.equal(result.taxAmount, 6);
    assert.equal(result.productCost, 30);
    assert.equal(result.packaging, 5);
    assert.equal(result.grossProfit, 25);
    assert.equal(result.margin, 25);
    assert.equal(result.hasCost, true);
  });

  test('sem custo: hasCost=false, grossProfit negativo', () => {
    const result = calcOrderProfit({
      agreedPrice: 50,
      quantity: 1,
      costPrice: 0,
      packagingCost: 0,
      taxRate: 0,
      marketplace: 'shopee',
    });
    assert.equal(result.hasCost, false);
    // netRevenue = 50 - (50*0.20 + 4) = 50 - 14 = 36
    assert.equal(result.netRevenue, 36);
    assert.equal(result.grossProfit, 36);
  });

  test('múltiplas unidades: valores são multiplicados corretamente', () => {
    const one = calcOrderProfit({ agreedPrice: 50, quantity: 1, costPrice: 10, packagingCost: 2, taxRate: 5, marketplace: 'shopee' });
    const two = calcOrderProfit({ agreedPrice: 50, quantity: 2, costPrice: 10, packagingCost: 2, taxRate: 5, marketplace: 'shopee' });
    assert.equal(two.gmv, r2(one.gmv * 2));
    assert.equal(two.productCost, r2(one.productCost * 2));
    assert.equal(two.packaging, r2(one.packaging * 2));
  });

  test('pedido cancelado (calcGmv=0): margem=0', () => {
    const result = calcOrderProfit({
      agreedPrice: 0,
      quantity: 1,
      costPrice: 10,
      taxRate: 5,
      marketplace: 'shopee',
    });
    assert.equal(result.gmv, 0);
    assert.equal(result.margin, 0);
  });

  test('platformNetRevenue sobrepõe cálculo de taxa', () => {
    // Quando o escrow real é conhecido
    const result = calcOrderProfit({
      agreedPrice: 100,
      quantity: 1,
      costPrice: 20,
      taxRate: 5,
      marketplace: 'shopee',
      platformNetRevenue: 60, // escrow real
    });
    assert.equal(result.netRevenue, 60);
    // marketplaceFee = 100 - 60 = 40
    assert.equal(result.shopeeFee, 40);
  });

  test('sellerCoupon reduz netRevenue', () => {
    const sem = calcOrderProfit({ agreedPrice: 100, quantity: 1, costPrice: 0, taxRate: 0, marketplace: 'shopee' });
    const com = calcOrderProfit({ agreedPrice: 100, quantity: 1, costPrice: 0, taxRate: 0, marketplace: 'shopee', sellerCoupon: 10 });
    assert.equal(r2(sem.netRevenue - com.netRevenue), 10);
  });
});

// ── calcOrderProfit — categoria Shopee ────────────────────────────────────
describe('calcOrderProfit — categoria Shopee', () => {
  test('eletronicos R$120: taxa 7% em vez de tabela de preço (14%+R$20)', () => {
    const comCat = calcOrderProfit({
      agreedPrice: 120, quantity: 1, costPrice: 40, taxRate: 6,
      marketplace: 'shopee', category: 'eletronicos',
    });
    const semCat = calcOrderProfit({
      agreedPrice: 120, quantity: 1, costPrice: 40, taxRate: 6,
      marketplace: 'shopee',
    });
    // Com categoria: taxa = 120*7% = R$8.40 → netRevenue = R$111.60
    assert.equal(comCat.marketplaceFee, r2(120 * 0.07));
    // Sem categoria (faixa): taxa = 120*14%+R$20 = R$36.80 → netRevenue = R$83.20
    assert.equal(semCat.marketplaceFee, r2(120 * 0.14 + 20));
    // Lucro com categoria é maior (taxa menor)
    assert.ok(comCat.grossProfit > semCat.grossProfit);
  });

  test('shopeeShippingCost reduz grossProfit sem afetar imposto', () => {
    const semFrete = calcOrderProfit({
      agreedPrice: 100, quantity: 1, costPrice: 20, taxRate: 6,
      marketplace: 'shopee', platformNetRevenue: 90,
    });
    const comFrete = calcOrderProfit({
      agreedPrice: 100, quantity: 1, costPrice: 20, taxRate: 6,
      marketplace: 'shopee', platformNetRevenue: 90,
      shopeeShippingCost: 12,
    });
    // Imposto não muda (base = GMV)
    assert.equal(semFrete.taxAmount, comFrete.taxAmount);
    // Lucro reduz exatamente pelo frete
    assert.equal(r2(semFrete.grossProfit - comFrete.grossProfit), 12);
    assert.equal(comFrete.shopeeShipping, 12);
  });

  test('shopeeShippingCost ignorado para ML', () => {
    const result = calcOrderProfit({
      agreedPrice: 100, quantity: 1, costPrice: 20, taxRate: 5,
      marketplace: 'mercadolivre', precomputedFee: 17,
      shopeeShippingCost: 15,
    });
    assert.equal(result.shopeeShipping, 0);
  });
});

// ── calcOrderProfit — Mercado Livre ────────────────────────────────────────
describe('calcOrderProfit — Mercado Livre', () => {
  test('ML clássico (11%) com precomputedFee da API', () => {
    // precomputedFee vem da API ML e já inclui comissão + taxa fixa + parcelamento
    const result = calcOrderProfit({
      agreedPrice: 150,
      quantity: 1,
      costPrice: 50,
      packagingCost: 3,
      taxRate: 6,
      marketplace: 'mercadolivre',
      precomputedFee: 22.50, // 11% × 150 + R$6 = R$22.50
    });
    assert.equal(result.gmv, 150);
    assert.equal(result.netRevenue, r2(150 - 22.50));
    assert.equal(result.taxAmount, r2(150 * 0.06));
    assert.equal(result.grossProfit, r2(result.netRevenue - result.taxAmount - 50 - 3));
  });

  test('ML clássico simulado (sem precomputedFee): 11% + R$6 para produto > R$79', () => {
    // Simulador usa calcMLFeePorUnidade: 100 × 11% + 6 = R$17
    const result = calcOrderProfit({
      agreedPrice: 100,
      quantity: 1,
      costPrice: 30,
      taxRate: 5,
      marketplace: 'mercadolivre',
      listingType: 'gold_special',
    });
    assert.equal(result.marketplaceFee, 17); // 11% + R$6
    assert.equal(result.netRevenue, r2(100 - 17));
  });
});

// ── getMarketplaceRates ────────────────────────────────────────────────────
describe('getMarketplaceRates', () => {
  test('shopee faixa < 80', () => {
    const r = getMarketplaceRates('shopee', 50);
    assert.equal(r.commissionPct, 20);
    assert.equal(r.fixedFee, 4);
  });

  test('ML gold_pro: 17% + R$6 para produto > R$79', () => {
    const r = getMarketplaceRates('mercadolivre', 100, 'gold_pro');
    assert.equal(r.commissionPct, 17);
    assert.equal(r.fixedFee, 6);
  });

  test('marketplace desconhecido: sem taxa', () => {
    const r = getMarketplaceRates('outro', 100);
    assert.equal(r.commissionPct, 0);
    assert.equal(r.fixedFee, 0);
  });
});
