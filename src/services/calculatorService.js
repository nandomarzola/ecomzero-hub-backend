// ── Tabela oficial Shopee 2026 ─────────────────────────────────────────────
function calcShopeeFeePorUnidade(agreedPrice) {
  if (agreedPrice < 80)  return (agreedPrice * 0.20) + 4.00;
  if (agreedPrice < 100) return (agreedPrice * 0.14) + 16.00;
  if (agreedPrice < 200) return (agreedPrice * 0.14) + 20.00;
  return                        (agreedPrice * 0.14) + 26.00;
}

function r2(n) { return Math.round(n * 100) / 100; }

// ── Fonte única de verdade para cálculo de lucro por pedido ──────────────────
// Validação:
//   agreedPrice=38.99, qty=97, costPrice=21.47, packaging=0.15, taxRate=5.2
//   gmv=3782.03, shopeeFee=1144.51, netRevenue=2637.52
//   tax=196.67, productCost=2082.59, packaging=14.55, grossProfit=343.71, margin=9.09%
function calcOrderProfit({
  agreedPrice,
  quantity,
  sellerCoupon   = 0,
  lmmDiscount    = 0,
  costPrice      = 0,
  packagingCost  = 0,
  taxRate        = 0,     // % (ex: 5.2)
}) {
  const gmv          = r2(agreedPrice * quantity);
  const shopeeFee    = r2(calcShopeeFeePorUnidade(agreedPrice) * quantity);
  const extraFees    = r2(sellerCoupon + lmmDiscount);
  const netRevenue   = r2(gmv - shopeeFee - extraFees);
  const taxAmount    = r2(gmv * (taxRate / 100));
  const productCost  = r2(costPrice * quantity);
  const packaging    = r2(packagingCost * quantity);
  const grossProfit  = r2(netRevenue - taxAmount - productCost - packaging);
  const margin       = gmv > 0 ? r2((grossProfit / gmv) * 100) : 0;
  const hasCost      = costPrice > 0;

  return { gmv, shopeeFee, extraFees, netRevenue, taxAmount, productCost, packaging, grossProfit, margin, hasCost };
}

// ── Compat com código legado (dashboard, cashflow, etc.) ─────────────────────
function getShopeeRates(unitPrice) {
  if (unitPrice < 80)  return { commissionPct: 20, fixedFee: 4.00 };
  if (unitPrice < 100) return { commissionPct: 14, fixedFee: 16.00 };
  if (unitPrice < 200) return { commissionPct: 14, fixedFee: 20.00 };
  return                      { commissionPct: 14, fixedFee: 26.00 };
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

module.exports = { calcProfit, calcOrderProfit, getShopeeRates, calcShopeeFeePorUnidade };
