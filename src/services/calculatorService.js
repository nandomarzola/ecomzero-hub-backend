const { r2 } = require('../lib/utils');

// ── Taxas Shopee 2026 (tiers por preço unitário) ──────────────────────────────
function calcShopeeFeePorUnidade(agreedPrice) {
  if (agreedPrice < 80)  return (agreedPrice * 0.20) + 4.00;
  if (agreedPrice < 100) return (agreedPrice * 0.14) + 16.00;
  if (agreedPrice < 200) return (agreedPrice * 0.14) + 20.00;
  return                        (agreedPrice * 0.14) + 26.00;
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
function getMarketplaceRates(marketplace, unitPrice, listingType) {
  const mp = (marketplace ?? '').toLowerCase();
  if (mp === 'shopee') {
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
  sellerCoupon      = 0,
  lmmDiscount       = 0,
  costPrice         = 0,
  packagingCost     = 0,
  taxRate           = 0,
  marketplace       = 'shopee',
  precomputedFee    = null,
  platformNetRevenue = null,
  listingType       = null,
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
      marketplaceFee = r2(calcShopeeFeePorUnidade(agreedPrice) * quantity);
    } else if (mp === 'mercadolivre') {
      marketplaceFee = r2(calcMLFeePorUnidade(agreedPrice, listingType) * quantity);
    } else {
      marketplaceFee = 0;
    }
    netRevenue = r2(gmv - marketplaceFee - r2(sellerCoupon + lmmDiscount));
  }

  const taxAmount   = r2(gmv * (taxRate / 100));
  const productCost = r2(costPrice * quantity);
  const packaging   = r2(packagingCost * quantity);
  const grossProfit = r2(netRevenue - taxAmount - productCost - packaging);
  const margin      = gmv > 0 ? r2((grossProfit / gmv) * 100) : 0;
  const hasCost     = costPrice > 0;

  return {
    gmv, shopeeFee: marketplaceFee, marketplaceFee,
    netRevenue, taxAmount, productCost, packaging, grossProfit, margin, hasCost,
  };
}

function calcProfit(salePrice, quantity, product, store, freight = 0, discount = 0) {
  const effectivePrice = salePrice - discount;
  if (store.marketplace?.toLowerCase() === 'shopee') {
    const unitPrice  = quantity > 0 ? effectivePrice / quantity : effectivePrice;
    const feePerUnit = calcShopeeFeePorUnidade(unitPrice);
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
