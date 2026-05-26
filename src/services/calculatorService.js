function calcProfit(salePrice, quantity, product, store, freight = 0, discount = 0) {
  const effectivePrice = salePrice - discount;
  const commission     = effectivePrice * (store.commission / 100);
  const serviceFee     = effectivePrice * (store.serviceFee / 100);
  const tax            = effectivePrice * (store.taxRate / 100);
  const cogs           = product.costPrice * quantity;
  const packaging      = product.packaging * quantity;
  const supplies       = product.supplies * quantity;
  const fixedFee       = (store.fixedFeePerItem || 0) * quantity;
  const totalCost      = commission + serviceFee + tax + cogs + packaging + supplies + fixedFee + freight;
  const profit         = effectivePrice - totalCost;
  const margin         = effectivePrice > 0 ? (profit / effectivePrice) * 100 : 0;

  return {
    profit:    parseFloat(profit.toFixed(2)),
    margin:    parseFloat(margin.toFixed(2)),
    breakdown: {
      salePrice:  parseFloat(effectivePrice.toFixed(2)),
      commission: parseFloat(commission.toFixed(2)),
      serviceFee: parseFloat(serviceFee.toFixed(2)),
      tax:        parseFloat(tax.toFixed(2)),
      cogs:       parseFloat(cogs.toFixed(2)),
      packaging:  parseFloat(packaging.toFixed(2)),
      supplies:   parseFloat(supplies.toFixed(2)),
      fixedFee:   parseFloat(fixedFee.toFixed(2)),
      freight:    parseFloat(freight.toFixed(2)),
    },
  };
}

module.exports = { calcProfit };
