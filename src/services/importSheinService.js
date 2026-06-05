const XLSX           = require('xlsx');
const { randomUUID } = require('crypto');
const prisma         = require('../lib/prisma');
const { calcOrderProfit } = require('./calculatorService');

function r2(n) { return Math.round(n * 100) / 100; }

function parseNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  return parseFloat(String(v).trim().replace(',', '.')) || 0;
}

const PT_MONTH_NUM = { janeiro:'01',fevereiro:'02',marco:'03',abril:'04',maio:'05',junho:'06',julho:'07',agosto:'08',setembro:'09',outubro:'10',novembro:'11',dezembro:'12' };

function stripAccents(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, ''); }

function parseDate(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (!s) return null;
  // "05 junho 2026 10:40" or "5 junho 2026"
  const ptMatch = s.match(/^(\d{1,2})\s+([a-záéíóúâêîôûãõç]+)\s+(\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?/i);
  if (ptMatch) {
    const mon = PT_MONTH_NUM[stripAccents(ptMatch[2].toLowerCase())];
    if (mon) {
      const time = ptMatch[4] ? (ptMatch[4].split(':').length === 2 ? ptMatch[4] + ':00' : ptMatch[4]) : '00:00:00';
      return new Date(`${ptMatch[3]}-${mon}-${ptMatch[1].padStart(2,'0')}T${time}.000Z`);
    }
  }
  // DD/MM/YYYY → YYYY-MM-DD
  s = s.replace(/^(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1');
  s = s.replace(' ', 'T');
  if (/T\d{2}:\d{2}$/.test(s))            s += ':00.000Z';
  else if (/T\d{2}:\d{2}:\d{2}$/.test(s)) s += '.000Z';
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00.000Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function extractMonth(rows, fallbackFilename) {
  const fn = stripAccents(String(fallbackFilename || '').toLowerCase()).replace(/[+_]/g, ' ');
  const yearInFn = (fn.match(/\b(20\d{2})\b/) || [])[1];
  if (yearInFn) {
    for (const [name, num] of Object.entries(PT_MONTH_NUM)) {
      if (fn.includes(name)) return `${yearInFn}-${num}`;
    }
  }
  // YYYYMMDD com ano e mês realistas (2020-2099, mês 01-12)
  const m = String(fallbackFilename || '').match(/\b(20\d{2})(0[1-9]|1[0-2])\d{2}\b/);
  if (m) return `${m[1]}-${m[2]}`;
  // Extrair de datas nas primeiras linhas
  for (const row of rows.slice(0, 20)) {
    const d = parseDate(String(row['Data e hora de criação do pedido'] || row['Data de criação do pedido'] || '').trim());
    if (d) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function classifyStatus(raw) {
  const s = stripAccents((raw || '').toLowerCase());
  if (s.includes('concluido') || s.includes('entregue'))  return 'valid';
  if (s.includes('cancelar')  || s.includes('cancel'))    return 'cancelled_other';
  return 'pending';
}

function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function importSheinOrderAll(filePath, storeId, userId, originalFilename, onProgress, existingImportId = null) {
  await onProgress?.({ pct: 5, message: 'Carregando dados...' });

  const [store, products] = await Promise.all([
    prisma.store.findFirst({ where: userId ? { id: storeId, userId } : { id: storeId } }),
    prisma.product.findMany({
      where:  { storeId },
      select: { id: true, sku: true, name: true, costPrice: true, packaging: true },
    }),
  ]);
  if (!store) throw new Error('Loja não encontrada');

  const bySkuMap = new Map();
  for (const p of products) {
    if (p.sku) bySkuMap.set(p.sku.toLowerCase().trim(), p);
  }

  await onProgress?.({ pct: 8, message: 'Lendo arquivo...' });

  const workbook  = XLSX.readFile(filePath, { raw: false });
  // Shein exports have 2 header rows: row 1 = group labels, row 2 = real column names, row 3+ = data
  const rawRows   = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
  if (rawRows.length < 3) throw new Error('Arquivo vazio ou sem dados');
  const headers = rawRows[1].map((h) => String(h || '').trim());
  const rows    = rawRows.slice(2).map((rowArr) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = rowArr[i] ?? ''; });
    return obj;
  });

  const periodMonth  = extractMonth(rows, originalFilename);
  const [year, mon]  = periodMonth.split('-').map(Number);
  const fallbackDate = new Date(Date.UTC(year, mon - 1, 15));

  let imp;
  if (existingImportId) {
    imp = await prisma.import.update({
      where: { id: existingImportId },
      data:  { periodMonth, totalRows: rows.length },
    });
  } else {
    imp = await prisma.import.create({
      data: { storeId, filename: originalFilename, periodMonth, totalRows: rows.length, status: 'processing' },
    });
  }

  await onProgress?.({ pct: 12, message: `${rows.length} linhas — agrupando pedidos...` });

  const orderGroups = new Map();
  for (const row of rows) {
    const orderId = String(row['Número do pedido'] || '').trim();
    if (!orderId) continue;
    if (!orderGroups.has(orderId)) orderGroups.set(orderId, []);
    orderGroups.get(orderId).push(row);
  }

  const existingOrders = await prisma.order.findMany({
    where:  { storeId, orderId: { in: [...orderGroups.keys()] } },
    select: { orderId: true },
  });
  const existingSet = new Set(existingOrders.map((o) => o.orderId));

  const ordersData     = [];
  const newProductsMap = new Map();

  await onProgress?.({ pct: 20, message: 'Processando pedidos...' });

  for (const [orderId, items] of orderGroups) {
    if (existingSet.has(orderId)) continue;

    try {
      const firstRow     = items[0];
      const statusRaw    = String(firstRow['Status do pedido'] || '').trim();
      const orderCategory = classifyStatus(statusRaw);
      const orderCreatedAt = parseDate(String(firstRow['Data e hora de criação do pedido'] || '').trim());
      const soldAt = orderCreatedAt ?? fallbackDate;

      let totalOriginalPrice       = 0;
      let totalPlatformNetRevenue  = 0;
      let totalCommission          = 0;
      let totalFreight             = 0;
      let totalQuantity            = 0;
      let firstProductId           = null;
      let firstProductName         = null;
      let firstSkuRef              = null;
      let firstVariation           = null;
      let multipleProducts         = false;

      for (const row of items) {
        const price      = parseNum(row['Preço do produto']);
        const platformNet = parseNum(row['Receita estimada de mercadorias']);
        const commission = parseNum(row['Comissão']);
        const freight    = parseNum(row['Taxa de intermediação de frete']);
        const sellerSku  = String(row['SKU do vendedor'] || '').trim() || null;
        const productNum = String(row['Número do produto'] || '').trim() || null;
        const skuRef     = sellerSku || productNum;
        const productName = String(row['Nome do produto'] || '').trim();
        const variation  = String(row['Variação'] || '').trim() || null;

        totalOriginalPrice      += price;
        totalPlatformNetRevenue += platformNet;
        totalCommission         += commission;
        totalFreight            += freight;
        totalQuantity           += 1;

        let product = skuRef ? (bySkuMap.get(skuRef.toLowerCase()) ?? null) : null;

        if (firstProductId === null) {
          firstProductName = productName;
          firstSkuRef      = skuRef;
          firstVariation   = variation;
          firstProductId   = product?.id ?? null;

          if (!product && skuRef && !newProductsMap.has(skuRef)) {
            const pid      = randomUUID();
            const dispName = variation ? `${productName} — ${variation}`.substring(0, 255) : productName.substring(0, 255);
            newProductsMap.set(skuRef, {
              id: pid, sku: skuRef, name: dispName, storeId,
              listPrice: price, costPrice: 0, packaging: 0, supplies: 0, stock: 0, minStock: 5,
            });
            bySkuMap.set(skuRef.toLowerCase(), { id: pid, sku: skuRef, name: dispName, costPrice: 0, packaging: 0 });
            firstProductId = pid;
          }
        } else {
          const thisPid = product?.id ?? (skuRef ? (newProductsMap.get(skuRef)?.id ?? null) : null);
          if (thisPid !== firstProductId) multipleProducts = true;
        }
      }

      const productId = multipleProducts ? null : firstProductId;
      const product   = productId
        ? (products.find((p) => p.id === productId) ?? bySkuMap.get(firstSkuRef?.toLowerCase()) ?? null)
        : null;

      const avgPrice            = totalQuantity > 0 ? r2(totalOriginalPrice / totalQuantity) : 0;
      const platformNetRevenue  = r2(totalPlatformNetRevenue);

      const calc = calcOrderProfit({
        agreedPrice:       avgPrice,
        quantity:          totalQuantity,
        costPrice:         product?.costPrice ?? 0,
        packagingCost:     product?.packaging ?? 0,
        taxRate:           store.taxRate ?? 0,
        platformNetRevenue,
      });

      const isRevenue = ['valid', 'pending', 'returned_partial'].includes(orderCategory);
      const status    = orderCategory.startsWith('cancelled') ? 'cancelled'
        : orderCategory === 'returned_full' ? 'returned' : 'paid';

      ordersData.push({
        storeId,
        importId:         imp.id,
        orderId,
        orderStatus:      statusRaw,
        orderCategory,
        productId,
        productName:      firstProductName || null,
        variationName:    firstVariation   || null,
        skuPrincipal:     firstSkuRef      || null,
        originalPrice:    r2(totalOriginalPrice),
        agreedPrice:      avgPrice,
        quantity:         totalQuantity,
        shopeeCommission: r2(totalCommission),
        shopeeServiceFee: r2(totalFreight),
        globalTotal:      r2(totalOriginalPrice),
        orderTotal:       platformNetRevenue,
        orderCreatedAt,
        calcGmv:          calc.gmv,
        calcShopeeFee:    calc.marketplaceFee,
        calcNetRevenue:   calc.netRevenue,
        calcTax:          calc.taxAmount,
        calcProductCost:  calc.productCost,
        calcPackaging:    calc.packaging,
        calcGrossProfit:  isRevenue ? calc.grossProfit : 0,
        calcMargin:       isRevenue ? calc.margin      : 0,
        hasCost:          calc.hasCost,
        status,
        soldAt,
        salePrice:        calc.gmv,
        profit:           isRevenue ? calc.grossProfit : 0,
        margin:           isRevenue ? calc.margin      : 0,
        snapshotTaxRate:  store.taxRate ?? 0,
      });
    } catch {
      // linha com erro: ignora e continua
    }
  }

  if (newProductsMap.size > 0) {
    await onProgress?.({ pct: 55, message: `Criando ${newProductsMap.size} produtos novos...` });
    await prisma.product.createMany({ data: [...newProductsMap.values()], skipDuplicates: true });
  }

  await onProgress?.({ pct: 60, message: `Salvando ${ordersData.length} pedidos...` });

  for (const batch of chunkArr(ordersData, 200)) {
    await prisma.order.createMany({ data: batch, skipDuplicates: true });
  }

  await prisma.$executeRaw`
    UPDATE \`Order\` o
    INNER JOIN Product p
      ON p.storeId = o.storeId
      AND p.sku IS NOT NULL
      AND p.sku = o.skuPrincipal
    SET o.productId = p.id
    WHERE o.importId = ${imp.id} AND o.productId IS NULL
  `;

  await onProgress?.({ pct: 80, message: 'Consolidando totais...' });

  const faturados    = ordersData.filter((o) => ['valid', 'pending', 'returned_partial'].includes(o.orderCategory));
  const sum          = (arr, f) => arr.reduce((s, o) => s + (o[f] ?? 0), 0);
  const gmv          = sum(faturados, 'calcGmv');
  const deductions   = sum(faturados, 'calcShopeeFee');
  const netRevenue   = sum(faturados, 'calcNetRevenue');
  const grossProfit  = sum(faturados.filter((o) => o.hasCost), 'calcGrossProfit');
  const validCount   = ordersData.filter((o) => o.orderCategory === 'valid').length;
  const pendingCount = ordersData.filter((o) => o.orderCategory === 'pending').length;
  const cancelledCount = ordersData.filter((o) => o.orderCategory.startsWith('cancelled')).length;

  await prisma.import.update({
    where: { id: imp.id },
    data: {
      validCount, pendingCount, cancelledCount,
      gmv:              parseFloat(gmv.toFixed(2)),
      shopeeDeductions: parseFloat(deductions.toFixed(2)),
      netRevenue:       parseFloat(netRevenue.toFixed(2)),
      grossProfit:      parseFloat(grossProfit.toFixed(2)),
      skippedCount:     orderGroups.size - ordersData.length,
      newProductCount:  newProductsMap.size,
      status:           'done',
    },
  });

  await onProgress?.({ pct: 90, message: 'Atualizando resumo financeiro...' });

  const unitCount    = faturados.reduce((s, o) => s + o.quantity, 0);
  const cancelledGmv = sum(ordersData.filter((o) => o.orderCategory.startsWith('cancelled')), 'calcGmv');
  const tax          = sum(faturados, 'calcTax');
  const margin       = gmv > 0 ? parseFloat(((grossProfit / gmv) * 100).toFixed(2)) : 0;

  await prisma.shopeePeriodSummary.upsert({
    where:  { storeId_month: { storeId, month: periodMonth } },
    create: { storeId, month: periodMonth, gmv: parseFloat(gmv.toFixed(2)), shopeeDeductions: parseFloat(deductions.toFixed(2)), netRevenue: parseFloat(netRevenue.toFixed(2)), tax: parseFloat(tax.toFixed(2)), grossProfit: parseFloat(grossProfit.toFixed(2)), margin, validCount, unitCount, cancelledCount, cancelledGmv: parseFloat(cancelledGmv.toFixed(2)) },
    update: { gmv: parseFloat(gmv.toFixed(2)), shopeeDeductions: parseFloat(deductions.toFixed(2)), netRevenue: parseFloat(netRevenue.toFixed(2)), tax: parseFloat(tax.toFixed(2)), grossProfit: parseFloat(grossProfit.toFixed(2)), margin, validCount, unitCount, cancelledCount, cancelledGmv: parseFloat(cancelledGmv.toFixed(2)) },
  });

  await onProgress?.({ pct: 100, message: 'Concluído!' });

  return {
    imported:    ordersData.length,
    valid:       validCount,
    pending:     pendingCount,
    cancelled:   cancelledCount,
    skipped:     orderGroups.size - ordersData.length - existingSet.size,
    newProducts: newProductsMap.size,
    periodMonth,
  };
}

module.exports = { importSheinOrderAll };
