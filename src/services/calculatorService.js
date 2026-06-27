const { r2 } = require('../lib/utils');

// ── Taxas Shopee por categoria (comissão + taxa de serviço) ───────────────────
// Fonte: tabela de categorias Shopee BR 2025 — apenas para o SIMULADOR e pedidos pendentes.
// Para pedidos confirmados com escrow, sempre usar escrowAmount (fonte da verdade real).
const SHOPEE_CATEGORY_RATES = {
  eletronicos:  0.07,  // ~5% comissão + 2% serviço
  informatica:  0.07,
  moda:         0.12,  // ~10% comissão + 2% serviço
  calcados:     0.12,
  bolsas:       0.12,
  casa:         0.10,  // ~8% comissão + 2% serviço
  decoracao:    0.10,
  saude_beleza: 0.10,
  bebe:         0.10,
  esportes:     0.12,  // ~10% comissão + 2% serviço
  brinquedos:   0.12,
  geral:        0.12,  // default conservador para categorias não mapeadas
};

// ── Taxas Shopee 2026 ─────────────────────────────────────────────────────────
// Quando category está cadastrado: usa taxa por categoria (precisa, específica).
// Fallback sem category: tabela por faixa de preço (imprecisa — superestima eletrônicos).
function calcShopeeFeePorUnidade(agreedPrice, category = null) {
  if (category) {
    const cat  = category.toLowerCase().trim();
    const rate = SHOPEE_CATEGORY_RATES[cat] ?? SHOPEE_CATEGORY_RATES.geral;
    return r2(agreedPrice * rate);
  }
  // Tabela oficial Shopee BR (comissão por faixa de preço unitário):
  // Até R$79,99:          20% + R$4/un
  // R$80 a R$99,99:       14% + R$16/un
  // R$100 a R$199,99:     14% + R$20/un
  // R$200 a R$499,99:     14% + R$26/un
  // Acima de R$500:       14% + R$26/un
  if (agreedPrice < 80)  return r2((agreedPrice * 0.20) + 4.00);
  if (agreedPrice < 100) return r2((agreedPrice * 0.14) + 16.00);
  if (agreedPrice < 200) return r2((agreedPrice * 0.14) + 20.00);
  return                      r2((agreedPrice * 0.14) + 26.00);
}

// ── Taxas Mercado Livre 2026 ───────────────────────────────────────────────────
// listingType: 'gold_pro' = Premium (17%), 'gold_special' = Clássico (11%), 'free' = Grátis (0%)
// ML cobra R$6 por unidade adicional para produtos com preço > R$79 (Clássico e Premium)
function calcMLFeePorUnidade(price, listingType = 'gold_special') {
  const type = (listingType ?? 'gold_special').toLowerCase();
  if (type === 'free') return 0;
  const pct      = type === 'gold_pro' ? 0.17 : 0.11;
  const fixedFee = price > 79 ? 6.00 : 0;
  return r2(price * pct + fixedFee);
}

// ── Rates compat (usado no simulador de produtos) ─────────────────────────────
// category: quando fornecido para Shopee, usa taxa por categoria (mais preciso).
// Sem category: fallback para tabela de faixa de preço.
function getMarketplaceRates(marketplace, unitPrice, listingType, category = null) {
  const mp = (marketplace ?? '').toLowerCase();
  if (mp === 'shopee') {
    if (category) {
      const cat  = category.toLowerCase().trim();
      const rate = SHOPEE_CATEGORY_RATES[cat] ?? SHOPEE_CATEGORY_RATES.geral;
      return { commissionPct: r2(rate * 100), fixedFee: 0 };
    }
    if (unitPrice < 80)  return { commissionPct: 20, fixedFee: 4.00 };
    if (unitPrice < 100) return { commissionPct: 14, fixedFee: 16.00 };
    if (unitPrice < 200) return { commissionPct: 14, fixedFee: 20.00 };
    return                      { commissionPct: 14, fixedFee: 26.00 };
  }
  if (mp === 'mercadolivre') {
    const type     = (listingType ?? 'gold_special').toLowerCase();
    const pct      = type === 'gold_pro' ? 17 : type === 'free' ? 0 : 11;
    const fixedFee = (unitPrice > 79 && type !== 'free') ? 6.00 : 0;
    return { commissionPct: pct, fixedFee };
  }
  return { commissionPct: 0, fixedFee: 0 };
}

// Alias para compatibilidade
function getShopeeRates(unitPrice) { return getMarketplaceRates('shopee', unitPrice); }

// ── Fonte única de verdade para cálculo de lucro por pedido ──────────────────
// platformNetRevenue: receita líquida já calculada pela plataforma (Shopee/Shein)
//   → quando fornecida, ignora fee calculation e usa diretamente
// precomputedFee: taxa real da API ML (frete + comissão + parcelamento)
//   → usado apenas quando platformNetRevenue é null
function calcOrderProfit({
  agreedPrice,
  quantity,
  sellerCoupon        = 0,
  lmmDiscount         = 0,
  costPrice           = 0,
  packagingCost       = 0,
  taxRate             = 0,
  marketplace         = 'shopee',
  precomputedFee      = null,
  platformNetRevenue  = null,
  listingType         = null,
  category            = null,  // categoria do produto — melhora precisão da taxa Shopee no simulador
  shopeeShippingCost  = 0,     // frete pago pelo seller fora do escrow Shopee (envio não integrado)
}) {
  const gmv = r2(agreedPrice * quantity);

  let marketplaceFee;
  let netRevenue;

  if (platformNetRevenue !== null) {
    netRevenue     = r2(platformNetRevenue);
    marketplaceFee = r2(gmv - netRevenue);
  } else if (precomputedFee !== null && precomputedFee >= 0) {
    marketplaceFee = r2(precomputedFee);
    netRevenue     = r2(gmv - marketplaceFee - r2(sellerCoupon + lmmDiscount));
  } else {
    const mp = (marketplace ?? 'shopee').toLowerCase();
    if (mp === 'shopee') {
      marketplaceFee = r2(calcShopeeFeePorUnidade(agreedPrice, category) * quantity);
    } else if (mp === 'mercadolivre') {
      marketplaceFee = r2(calcMLFeePorUnidade(agreedPrice, listingType) * quantity);
    } else {
      marketplaceFee = 0;
    }
    netRevenue = r2(gmv - marketplaceFee - r2(sellerCoupon + lmmDiscount));
  }

  const taxAmount     = r2(gmv * (taxRate / 100));
  const productCost   = r2(costPrice * quantity);
  const packaging     = r2(packagingCost * quantity);
  // shopeeShippingCost: custo de frete externo ao escrow — não incide imposto (já é custo variável)
  const shopeeShipping = r2((marketplace ?? 'shopee').toLowerCase() === 'shopee' ? (shopeeShippingCost ?? 0) : 0);
  const grossProfit   = r2(netRevenue - taxAmount - productCost - packaging - shopeeShipping);
  const margin        = gmv > 0 ? r2((grossProfit / gmv) * 100) : 0;
  const hasCost       = costPrice > 0;

  return {
    gmv, shopeeFee: marketplaceFee, marketplaceFee,
    netRevenue, taxAmount, productCost, packaging, shopeeShipping,
    grossProfit, margin, hasCost,
  };
}

function calcProfit(salePrice, quantity, product, store, freight = 0, discount = 0) {
  const effectivePrice = salePrice - discount;
  if (store.marketplace?.toLowerCase() === 'shopee') {
    const unitPrice  = quantity > 0 ? effectivePrice / quantity : effectivePrice;
    const feePerUnit = calcShopeeFeePorUnidade(unitPrice, product?.category ?? null);
    const shopeeFee  = r2(feePerUnit * quantity);
    const netRevenue = r2(effectivePrice - shopeeFee);
    const taxRate    = (store.taxRate ?? 0) / 100;
    const tax        = r2(effectivePrice * taxRate);
    const cogs       = r2((product.costPrice ?? 0) * quantity);
    const packaging  = r2((product.packaging ?? 0) * quantity);
    const supplies   = r2((product.supplies  ?? 0) * quantity);
    const fr         = r2(freight ?? 0);
    const profit     = r2(netRevenue - tax - cogs - packaging - supplies - fr);
    const margin     = effectivePrice > 0 ? r2((profit / effectivePrice) * 100) : 0;
    return {
      profit, margin,
      breakdown: {
        salePrice: r2(effectivePrice), commissionPct: r2((shopeeFee / Math.max(effectivePrice, 0.01)) * 100),
        commission: shopeeFee, serviceFee: 0, fixedFee: 0, netRevenue, tax, cogs, packaging, supplies, freight: fr,
      },
    };
  }
  const commissionPct   = store.commission     ?? 0;
  const fixedFeePerItem = store.fixedFeePerItem ?? 0;
  const serviceFeeRate  = store.serviceFee      ?? 0;
  const commission  = r2(effectivePrice * (commissionPct / 100));
  const serviceFee  = r2(effectivePrice * (serviceFeeRate / 100));
  const tax         = r2(effectivePrice * ((store.taxRate ?? 0) / 100));
  const cogs        = r2((product.costPrice ?? 0) * quantity);
  const packaging   = r2((product.packaging ?? 0) * quantity);
  const supplies    = r2((product.supplies  ?? 0) * quantity);
  const fixedFee    = r2(fixedFeePerItem * quantity);
  const fr          = r2(freight ?? 0);
  const profit      = r2(effectivePrice - commission - serviceFee - tax - cogs - packaging - supplies - fixedFee - fr);
  const margin      = effectivePrice > 0 ? r2((profit / effectivePrice) * 100) : 0;
  return {
    profit, margin,
    breakdown: { salePrice: r2(effectivePrice), commissionPct: r2(commissionPct), commission, serviceFee, fixedFee, tax, cogs, packaging, supplies, freight: fr },
  };
}

module.exports = { calcProfit, calcOrderProfit, getShopeeRates, getMarketplaceRates, calcShopeeFeePorUnidade, calcMLFeePorUnidade };
