// Taxas de marketplace vigentes em 2026 — atualizar aqui quando as plataformas mudarem.
// Versionamento via git (histórico de alterações preservado automaticamente).

const SHOPEE_2026 = {
  commissionPct: 14,           // % flat sobre GMV bruto, CPF e CNPJ
  fixedFee: {
    cnpj:           4.00,      // R$ por item
    cpf_high:       4.00,      // CPF com >450 pedidos/90 dias
    cpf_low:        7.00,      // CPF com <450 pedidos/90 dias (default conservador)
  },
  feeCap: null,                // teto de R$100 removido em 2026
};

const ML_2026 = {
  classico: {
    commissionPct: 12,         // default conservador (faixa real: 10-14%, varia por categoria)
    commissionRange: [10, 14],
    label: 'Clássico',
  },
  premium: {
    commissionPct: 17,         // default conservador (faixa real: 15-19%, varia por categoria)
    commissionRange: [15, 19],
    label: 'Premium',
  },
  free: {
    commissionPct: 0,
    commissionRange: [0, 0],
    label: 'Grátis',
  },
  lowValueThreshold: 79,       // abaixo: taxa operacional variável (input do seller)
  fixedFeeHighValue: 6.00,     // R$ por item acima de R$79 (Clássico e Premium)
};

/**
 * Retorna os parâmetros de taxa para o marketplace.
 * @param {string} marketplace - "shopee" | "mercadolivre"
 * @param {object} opts
 * @param {string} opts.sellerType - "cpf" | "cnpj" (Shopee apenas)
 * @param {number|null} opts.shopeeFixedFeeOverride - override manual da taxa fixa
 * @param {string} opts.mlExposure - "classico" | "premium" | "free" (ML apenas)
 * @returns {{ commissionPct, fixedFee, feeCap, label, note }}
 */
function getMarketplaceRates(marketplace, opts = {}) {
  const { sellerType = 'cnpj', shopeeFixedFeeOverride = null, mlExposure = 'classico' } = opts;

  if (marketplace === 'shopee') {
    const fixedFee = shopeeFixedFeeOverride != null
      ? shopeeFixedFeeOverride
      : (sellerType === 'cnpj' ? SHOPEE_2026.fixedFee.cnpj : SHOPEE_2026.fixedFee.cpf_low);
    return {
      commissionPct: SHOPEE_2026.commissionPct,
      fixedFee,
      feeCap: SHOPEE_2026.feeCap,
      label: 'Shopee',
      note: `14% + R$${fixedFee.toFixed(2)} por item (${sellerType.toUpperCase()}, 2026)`,
    };
  }

  if (marketplace === 'mercadolivre') {
    const tier = ML_2026[mlExposure] ?? ML_2026.classico;
    const fixedFee = null; // calculado fora (depende do preço vs R$79)
    return {
      commissionPct: tier.commissionPct,
      commissionRange: tier.commissionRange,
      fixedFee,
      feeCap: null,
      label: `ML ${tier.label}`,
      note: `${tier.commissionPct}% (faixa real: ${tier.commissionRange[0]}-${tier.commissionRange[1]}% por categoria) + R$6 se preço > R$79`,
    };
  }

  return { commissionPct: 0, fixedFee: 0, feeCap: null, label: marketplace, note: '' };
}

module.exports = { getMarketplaceRates, SHOPEE_2026, ML_2026 };
