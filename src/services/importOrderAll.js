const XLSX  = require('xlsx');
const prisma = require('../lib/prisma');

function parseNum(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  return parseFloat(String(value).trim().replace(',', '.')) || 0;
}

function parseInt2(value) {
  const n = parseNum(value);
  return Math.round(n) || 1;
}

function parseOrderDate(value) {
  if (!value) return null;
  const str = String(value).trim();
  if (!str) return null;
  // "2026-04-01 01:27" → treat as UTC (close enough for monthly reporting)
  const d = new Date(str.replace(' ', 'T') + ':00.000Z');
  return isNaN(d) ? null : d;
}

function classifyOrder(row) {
  const status       = String(row['Status do pedido'] || '').trim();
  const returnStatus = String(row['Status da Devolução / Reembolso'] || '').trim();
  const globalTotal  = parseNum(row['Total global']);
  const cancelReason = String(row['Cancelar Motivo'] || '').trim().toLowerCase();

  if (status === 'Concluído') {
    if (returnStatus === 'Solicitação aprovada') {
      return globalTotal === 0 ? 'returned_full' : 'returned_partial';
    }
    return 'valid';
  }
  if (status === 'Cancelado') {
    return cancelReason.includes('não pago') ? 'cancelled_unpaid' : 'cancelled_other';
  }
  return 'valid';
}

function extractMonth(filename) {
  if (filename) {
    const m = String(filename).match(/(\d{4})(\d{2})\d{2}/);
    if (m) return `${m[1]}-${m[2]}`;
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function importShopeeOrderAll(filePath, storeId, userId, originalFilename, onProgress) {
  // ── 1. Verificar loja ─────────────────────────────────────────────────────
  const where = userId ? { id: storeId, userId } : { id: storeId };
  const store = await prisma.store.findFirst({ where });
  if (!store) throw new Error('Loja não encontrada');

  const monthKey = extractMonth(originalFilename);
  const [year, mon] = monthKey.split('-').map(Number);
  const fallbackDate = new Date(Date.UTC(year, mon - 1, 15));

  // ── 2. Ler XLSX ──────────────────────────────────────────────────────────
  const workbook = XLSX.readFile(filePath, { raw: false });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  onProgress?.({ step: 'parsing', current: 0, total: rows.length });

  // ── 3. Verificar duplicatas (pelos orderId do período já importados) ──────
  const existingOrders = await prisma.order.findMany({
    where: { storeId, importSource: 'orderall' },
    select: { externalId: true },
  });
  const existingIds = new Set(existingOrders.map((o) => o.externalId));

  // ── 4. Pre-fetch produtos para linking ───────────────────────────────────
  const products = await prisma.product.findMany({
    where:  { storeId },
    select: { id: true, sku: true, name: true, costPrice: true, packaging: true, supplies: true },
  });
  const bySkuMap  = new Map(products.filter((p) => p.sku).map((p) => [p.sku.toLowerCase(), p]));
  const byNameMap = new Map(products.map((p) => [p.name.toLowerCase(), p]));

  function findProduct(skuRef, productName, variationName) {
    if (skuRef) {
      const p = bySkuMap.get(skuRef.toLowerCase());
      if (p) return p;
    }
    const withVar = variationName && variationName !== '-'
      ? `${productName} — ${variationName}`.toLowerCase()
      : null;
    if (withVar) {
      const p = byNameMap.get(withVar);
      if (p) return p;
    }
    return byNameMap.get(productName.toLowerCase()) ?? null;
  }

  // ── 5. Processar linhas ──────────────────────────────────────────────────
  const toCreate = [];
  let skipped = 0;
  const errors = [];

  for (const row of rows) {
    try {
      const orderId = String(row['ID do pedido'] || '').trim();
      if (!orderId) { skipped++; continue; }
      if (existingIds.has(orderId)) { skipped++; continue; }

      const orderCategory  = classifyOrder(row);
      const agreedPrice    = parseNum(row['Preço acordado']);
      const quantity       = parseInt2(row['Quantidade']);
      const globalTotal    = parseNum(row['Total global']);
      const shopeeComm     = parseNum(row['Taxa de comissão líquida']);
      const shopeeService  = parseNum(row['Taxa de serviço líquida']);
      const sellerCoupon   = parseNum(row['Cupom do vendedor']);
      const sellerDiscount = parseNum(row['Desconto do vendedor']);
      const originalPrice  = parseNum(row['Preço original']);
      const productName    = String(row['Nome do Produto'] || '').trim();
      const variationName  = String(row['Nome da variação'] || '').trim();
      const skuRef         = String(row['Nº de referência do SKU principal'] || '').trim();
      const cancelReason   = String(row['Cancelar Motivo'] || '').trim();
      const returnStatus   = String(row['Status da Devolução / Reembolso'] || '').trim();

      const soldAt = parseOrderDate(row['Hora do pagamento do pedido'])
                  ?? parseOrderDate(row['Data de criação do pedido'])
                  ?? fallbackDate;

      const product    = findProduct(skuRef, productName, variationName);
      const salePrice  = parseFloat((agreedPrice * quantity).toFixed(2));

      // status: para compatibilidade com queries existentes
      const status = orderCategory === 'cancelled_unpaid' || orderCategory === 'cancelled_other'
        ? 'cancelled'
        : orderCategory === 'returned_full' ? 'returned' : 'paid';

      toCreate.push({
        storeId,
        externalId:       orderId,
        salePrice,
        freight:          0,
        discount:         sellerDiscount,
        status,
        soldAt,
        profit:           0,
        margin:           0,
        importSource:     'orderall',
        orderCategory,
        agreedPrice,
        originalPrice,
        sellerDiscount,
        sellerCoupon,
        shopeeCommission: shopeeComm,
        shopeeServiceFee: shopeeService,
        globalTotal,
        cancelReason:     cancelReason || null,
        returnStatus:     returnStatus || null,
        variationName:    variationName || null,
        productNameRaw:   productName || null,
        snapshotCommission: store.commission,
        snapshotServiceFee: store.serviceFee,
        snapshotTaxRate:    store.taxRate,
        snapshotFixedFee:   store.fixedFeePerItem || 0,
        _productId: product?.id ?? null,
        _product:   product,
        _quantity:  quantity,
        _unitPrice: agreedPrice,
      });
    } catch (err) {
      errors.push({ row: String(row['ID do pedido'] || '?'), erro: err.message });
    }
  }

  onProgress?.({ step: 'orders', current: 0, total: toCreate.length });

  // ── 6. Criar pedidos em batches ──────────────────────────────────────────
  let imported = 0;

  for (const batch of chunks(toCreate, 50)) {
    await prisma.$transaction(async (tx) => {
      for (const item of batch) {
        const { _productId, _product, _quantity, _unitPrice, ...orderData } = item;

        const order = await tx.order.create({ data: orderData });

        if (_productId) {
          await tx.orderItem.create({
            data: {
              orderId:           order.id,
              productId:         _productId,
              quantity:          _quantity,
              unitPrice:         _unitPrice,
              snapshotCostPrice: _product?.costPrice  ?? 0,
              snapshotPackaging: _product?.packaging  ?? 0,
              snapshotSupplies:  _product?.supplies   ?? 0,
            },
          });
        }
        imported++;
      }
    });
    onProgress?.({ step: 'orders', current: imported + skipped, total: rows.length });
  }

  return {
    imported,
    skipped,
    totalRevenue: 0,
    totalProfit:  0,
    avgMargin:    0,
    errors:       errors.slice(0, 20),
    source:       'orderall',
    month:        monthKey,
  };
}

module.exports = { importShopeeOrderAll };
