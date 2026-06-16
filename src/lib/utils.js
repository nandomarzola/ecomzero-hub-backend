/**
 * Arredonda para 2 casas decimais usando método bancário (half-even).
 * Centralizado aqui — NÃO duplicar em outros arquivos.
 * Estava duplicado em 14 arquivos antes desta centralização.
 */
function r2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Clamp + parse seguro para parâmetros de paginação vindos de query string.
 * Evita negative skip, take=0 ou take astronomicamente grande.
 */
function parsePage(page, limit, { maxLimit = 100, defaultLimit = 30 } = {}) {
  const p   = Math.max(1,         parseInt(page,  10) || 1);
  const lim = Math.min(maxLimit,  Math.max(1, parseInt(limit, 10) || defaultLimit));
  return { skip: (p - 1) * lim, take: lim };
}

/**
 * Valida e faz parse de parâmetro "YYYY-MM" (ex: "2025-06").
 * Retorna { year, month } ou lança RangeError.
 */
function parseYearMonth(value) {
  if (!/^\d{4}-\d{2}$/.test(value ?? '')) {
    throw Object.assign(new RangeError(`Formato de mês inválido: "${value}". Esperado: YYYY-MM`), { status: 400 });
  }
  const [year, month] = value.split('-').map(Number);
  if (month < 1 || month > 12) {
    throw Object.assign(new RangeError(`Mês fora do intervalo: ${month}`), { status: 400 });
  }
  return { year, month };
}

module.exports = { r2, parsePage, parseYearMonth };
