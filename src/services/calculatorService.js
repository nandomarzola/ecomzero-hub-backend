// Tiers oficiais Shopee 2026 baseados no preço acordado por unidade
function getShopeeRates(unitPrice) {
  if (unitPrice < 80)  return { commissionPct: 20, fixedFee: 4.00 };
  if (unitPrice < 100) return { commissionPct: 14, fixedFee: 16.00 };
  if (unitPrice < 200) return { commissionPct: 14, fixedFee: 20.00 };
  return                      { commissionPct: 14, fixedFee: 26.00 };
}

// Taxa Shopee por unidade (preço acordado unitário)
function calcShopeeFeePorUnidade(agreedPrice) {
  const { commissionPct, fixedFee } = getShopeeRates(agreedPrice);
  return agreedPrice * (commissionPct / 100) + fixedFee;
}

function calcProfit(salePrice, quantity, product, store, freight = 0, discount = 0) {
  const effectivePrice = salePrice - discount; // = GMV do pedido

  if (store.marketplace?.toLowerCase() === 'shopee') {
    // Preço unitário para determinar o tier
    const unitPrice  = quantity > 0 ? effectivePrice / quantity : effectivePrice;
    const feePerUnit = calcShopeeFeePorUnidade(unitPrice);
    const shopeeFee  = parseFloat((feePerUnit * quantity).toFixed(2));

    // Receita líquida SEMPRE menor que GMV (subtração, nunca soma)
    const netRevenue = parseFloat((effectivePrice - shopeeFee).toFixed(2));

    // Imposto sobre GMV (receita bruta MEI/Simples — base legal é o valor da venda ao consumidor)
    const taxRate  = (store.taxRate ?? 0) / 100;
    const tax      = parseFloat((effectivePrice * taxRate).toFixed(2));

    const cogs      = parseFloat(((product.costPrice ?? 0) * quantity).toFixed(2));
    const packaging = parseFloat(((product.packaging ?? 0) * quantity).toFixed(2));
    const supplies  = parseFloat(((product.supplies  ?? 0) * quantity).toFixed(2));
    const fr        = parseFloat((freight ?? 0).toFixed(2));

    const profit = parseFloat((netRevenue - tax - cogs - packaging - supplies - fr).toFixed(2));
    // Margem sempre sobre GMV (spec Shopee)
    const margin = effectivePrice > 0 ? parseFloat(((profit / effectivePrice) * 100).toFixed(2)) : 0;

    return {
      profit,
      margin,
      breakdown: {
        salePrice:     parseFloat(effectivePrice.toFixed(2)),
        commissionPct: parseFloat(((shopeeFee / Math.max(effectivePrice, 0.01)) * 100).toFixed(2)),
        commission:    shopeeFee,
        serviceFee:    0,
        fixedFee:      0,
        netRevenue,
        tax,
        cogs,
        packaging,
        supplies,
        freight:       fr,
      },
    };
  }

  // ── Outros marketplaces ──────────────────────────────────────────────────
  const commissionPct   = store.commission     ?? 0;
  const fixedFeePerItem = store.fixedFeePerItem ?? 0;
  const serviceFeeRate  = store.serviceFee      ?? 0;

  const commission = parseFloat((effectivePrice * (commissionPct / 100)).toFixed(2));
  const serviceFee = parseFloat((effectivePrice * (serviceFeeRate / 100)).toFixed(2));
  const tax        = parseFloat((effectivePrice * ((store.taxRate ?? 0) / 100)).toFixed(2));
  const cogs       = parseFloat(((product.costPrice ?? 0) * quantity).toFixed(2));
  const packaging  = parseFloat(((product.packaging ?? 0) * quantity).toFixed(2));
  const supplies   = parseFloat(((product.supplies  ?? 0) * quantity).toFixed(2));
  const fixedFee   = parseFloat((fixedFeePerItem * quantity).toFixed(2));
  const fr         = parseFloat((freight ?? 0).toFixed(2));

  const profit = parseFloat((effectivePrice - commission - serviceFee - tax - cogs - packaging - supplies - fixedFee - fr).toFixed(2));
  const margin = effectivePrice > 0 ? parseFloat(((profit / effectivePrice) * 100).toFixed(2)) : 0;

  return {
    profit,
    margin,
    breakdown: {
      salePrice:     parseFloat(effectivePrice.toFixed(2)),
      commissionPct: parseFloat(commissionPct.toFixed(2)),
      commission,
      serviceFee,
      fixedFee,
      tax,
      cogs,
      packaging,
      supplies,
      freight:       fr,
    },
  };
}

module.exports = { calcProfit, getShopeeRates, calcShopeeFeePorUnidade };
