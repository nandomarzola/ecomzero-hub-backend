// Retorna comissão (%) e taxa fixa (R$) escalonadas da Shopee por faixa de preço unitário
function getShopeeRates(unitPrice) {
  if (unitPrice < 80)  return { commissionPct: 20, fixedFee: 4.00 };
  if (unitPrice < 100) return { commissionPct: 14, fixedFee: 16.00 };
  if (unitPrice < 200) return { commissionPct: 14, fixedFee: 20.00 };
  return                      { commissionPct: 14, fixedFee: 26.00 };
}

function calcProfit(salePrice, quantity, product, store, freight = 0, discount = 0) {
  const effectivePrice = salePrice - discount;

  let commissionPct, fixedFeePerItem, serviceFeeRate;

  if (store.marketplace === 'shopee') {
    const unitPrice = quantity > 0 ? effectivePrice / quantity : effectivePrice;
    const rates     = getShopeeRates(unitPrice);
    commissionPct   = rates.commissionPct;
    fixedFeePerItem = rates.fixedFee;
    serviceFeeRate  = 0;
  } else {
    commissionPct   = store.commission   ?? 0;
    fixedFeePerItem = store.fixedFeePerItem ?? 0;
    serviceFeeRate  = store.serviceFee   ?? 0;
  }

  const commission = effectivePrice * (commissionPct / 100);
  const serviceFee = effectivePrice * (serviceFeeRate / 100);
  const tax        = effectivePrice * ((store.taxRate ?? 0) / 100);
  const cogs       = product.costPrice * quantity;
  const packaging  = product.packaging * quantity;
  const supplies   = product.supplies  * quantity;
  const fixedFee   = fixedFeePerItem * quantity;
  const totalCost  = commission + serviceFee + tax + cogs + packaging + supplies + fixedFee + freight;
  const profit     = effectivePrice - totalCost;
  const margin     = effectivePrice > 0 ? (profit / effectivePrice) * 100 : 0;

  return {
    profit:    parseFloat(profit.toFixed(2)),
    margin:    parseFloat(margin.toFixed(2)),
    breakdown: {
      salePrice:     parseFloat(effectivePrice.toFixed(2)),
      commissionPct: parseFloat(commissionPct.toFixed(2)),
      commission:    parseFloat(commission.toFixed(2)),
      serviceFee:    parseFloat(serviceFee.toFixed(2)),
      tax:           parseFloat(tax.toFixed(2)),
      cogs:          parseFloat(cogs.toFixed(2)),
      packaging:     parseFloat(packaging.toFixed(2)),
      supplies:      parseFloat(supplies.toFixed(2)),
      fixedFee:      parseFloat(fixedFee.toFixed(2)),
      freight:       parseFloat(freight.toFixed(2)),
    },
  };
}

module.exports = { calcProfit, getShopeeRates };
