const XLSX           = require('xlsx');
const { randomUUID } = require('crypto');
const prisma         = require('../lib/prisma');
const { calcOrderProfit }      = require('./calculatorService');
const { recalculateStoreRates } = require('./storeRatesService');

function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

function parseBRL(v) {
  if (v === null || v === undefined || v === '') return 0;
  let s = String(v).trim().replace(/BRL\s*/gi, '').trim();
  // "1.234,56" → remove dot thousand sep then swap comma
  if (s.includes(',') && s.includes('.')) s = s.replace('.', '').replace(',', '.');
  else s = s.replace(',', '.');
  return parseFloat(s) || 0;
}

function parseQty(v) { return Math.max(1, Math.round(parseBRL(v))) || 1; }

function parseDate(v) {
  if (!v) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(' ', 'T');
  if (/T\d{2}:\d{2}$/.test(s))            s += ':00.000Z';
  else if (/T\d{2}:\d{2}:\d{2}$/.test(s)) s += '.000Z';
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00.000Z';
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function classifyTTStatus(raw) {
  const s = (raw || '').trim().toLowerCase();
  if (s.includes('entregue') || s.includes('concluido') || s === 'completed' || s === 'delivered') return 'valid';
  if (s.includes('cancelado') || s.includes('cancelled') || s === 'cancel') return 'cancelled_other';
  if (s.includes('devolvido') || s.includes('returned') || s === 'return')  return 'returned_full';
  return 'pending';
}

function categoryToStatus(cat) {
  if (cat === 'returned_full') return 'returned';
  if (cat.startsWith('cancelled')) return 'cancelled';
  return 'paid';
}

function extractMonth(rows, fallbackFilename) {
  const m = String(fallbackFilename || '').match(/\b(20\d{2})(0[1-9]|1[0-2])\d{2}\b/);
  if (m) return `${m[1]}-${m[2]}`;
  for (const row of rows.slice(0, 20)) {
    const d = parseDate(String(row['Created Time'] || row['Order Creation Time'] || '').trim());
    if (d) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function importTiktokOrderAll(filePath, storeId, userId, originalFilename, onProgress, existingImportId = null) {
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

  const workbook = XLSX.readFile(filePath, { raw: false });
  const rows     = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
  if (rows.length === 0) throw new Error('Arquivo vazio ou sem dados');

  const periodMonth  = extractMonth(rows, originalFilename);
  const [year, mon]  = periodMonth.split('-').map(Number);
  const fallbackDate = new Date(Date.UTC(year, mon - 1, 15));

  let imp;
  if (existingImportId) {
    imp = await prisma.import.update({ where: { id: existingImportId }, data: { periodMonth, totalRows: rows.length } });
  } else {
    imp = await prisma.import.create({
      data: { storeId, filename: originalFilename, periodMonth, totalRows: rows.length, status: 'processing' },
    });
  }

  await onProgress?.({ pct: 12, message: `${rows.length} linhas — agrupando pedidos...` });

  const orderGroups = new Map();
  for (const row of rows) {
    const orderId = String(row['Order ID'] || row['Order Id'] || '').trim();
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
      const firstRow       = items[0];
      const statusRaw      = String(firstRow['Order Status'] || '').trim();
      const orderCategory  = classifyTTStatus(statusRaw);
      const orderCreatedAt = parseDate(String(firstRow['Created Time'] || firstRow['Order Creation Time'] || '').trim());
      const soldAt         = orderCreatedAt ?? fallbackDate;

      // Order-level fields (same across all item rows)
      const orderAmount        = parseBRL(firstRow['Order Amount']);
      const shippingSellerCost = parseBRL(firstRow['Shipping Fee Seller Discount']);
      const paymentMethod      = String(firstRow['Payment Method'] || '').toLowerCase();
      const isPix              = paymentMethod.includes('pix');

      // Aggregate item-level fields
      let totalSubtotalAfterDiscount = 0;
      let totalSellerDiscount        = 0;
      let totalQuantity              = 0;
      let totalOriginalPrice         = 0;
      let firstProductId             = null;
      let firstProductName           = null;
      let firstSkuRef                = null;
      let firstVariation             = null;
      let multipleProducts           = false;

      for (const row of items) {
        const qty          = parseQty(row['Quantity']);
        const unitPrice    = parseBRL(row['SKU Unit Original Price']);
        const subtotalAfter = parseBRL(row['SKU Subtotal After Discount']);
        const sellerDisc   = parseBRL(row['SKU Seller Discount']);
        const skuSeller    = String(row['Seller SKU'] || '').trim() || null;
        const skuId        = String(row['SKU ID']     || '').trim() || null;
        const skuRef       = skuSeller || skuId || null;
        const productName  = String(row['Product Name'] || '').trim();
        const variation    = String(row['Variation']    || '').trim() || null;

        totalSubtotalAfterDiscount += subtotalAfter || (unitPrice * qty);
        totalSellerDiscount        += sellerDisc;
        totalQuantity              += qty;
        totalOriginalPrice         += unitPrice * qty;

        const product = skuRef ? (bySkuMap.get(skuRef.toLowerCase()) ?? null) : null;

        if (firstProductId === null) {
          firstProductName = productName;
          firstSkuRef      = skuRef;
          firstVariation   = variation;
          firstProductId   = product?.id ?? null;

          if (!product && skuRef && !newProductsMap.has(skuRef)) {
            const pid      = randomUUID();
            const dispName = variation ? `${productName} — ${variation}` : productName;
            newProductsMap.set(skuRef, {
              id: pid, sku: skuRef, name: dispName.substring(0, 255), storeId,
              listPrice: unitPrice, costPrice: 0, packaging: 0, supplies: 0, stock: 0, minStock: 5,
            });
            bySkuMap.set(skuRef.toLowerCase(), { id: pid, sku: skuRef, name: dispName, costPrice: 0, packaging: 0 });
            firstProductId = pid;
          }
        } else {
          const thisPid = product?.id ?? (skuRef ? (newProductsMap.get(skuRef)?.id ?? null) : null);
          if (thisPid !== firstProductId) multipleProducts = true;
        }
      }

      const productId  = multipleProducts ? null : firstProductId;
      const product    = productId
        ? (products.find((p) => p.id === productId) ?? bySkuMap.get(firstSkuRef?.toLowerCase()) ?? null)
        : null;

      const avgUnitPrice             = totalQuantity > 0 ? r2(totalOriginalPrice / totalQuantity) : 0;
      const subtotalAfterDiscount    = r2(totalSubtotalAfterDiscount);
      const sellerDiscount           = r2(totalSellerDiscount);

      const commission   = r2(subtotalAfterDiscount * 0.06 + 4.00 * totalQuantity);
      const paymentFee   = orderAmount > 0
        ? (isPix ? r2(orderAmount * 0.0199) : r2(orderAmount * 0.0299 + 0.40))
        : 0;
      const shippingCost = r2(shippingSellerCost);

      const platformNetRevenue = r2(subtotalAfterDiscount - commission - paymentFee - shippingCost - sellerDiscount);

      const calc = calcOrderProfit({
        agreedPrice:       avgUnitPrice,
        quantity:          totalQuantity,
        costPrice:         product?.costPrice ?? 0,
        packagingCost:     product?.packaging ?? 0,
        taxRate:           store.taxRate ?? 0,
        marketplace:       'tiktok',
        platformNetRevenue,
      });

      const isRevenue = ['valid', 'pending', 'returned_partial'].includes(orderCategory);

      ordersData.push({
        storeId,
        importId:        imp.id,
        orderId,
        orderStatus:     statusRaw,
        orderCategory,
        cancelReason:    null,
        returnStatus:    null,
        skuPrincipal:    firstSkuRef || null,
        skuVariacao:     firstSkuRef || null,
        productName:     firstProductName || null,
        variationName:   firstVariation   || null,
        productId,
        originalPrice:   avgUnitPrice,
        agreedPrice:     avgUnitPrice,
        quantity:        totalQuantity,
        platformCommission: r2(commission + paymentFee),
        platformServiceFee: paymentFee,
        sellerCoupon:    0,
        sellerDiscount,
        lmmDiscount:     0,
        globalTotal:     subtotalAfterDiscount,
        orderTotal:      subtotalAfterDiscount,
        trackingNumber:  null,
        shippingOption:  null,
        listingType:     null,
        orderCreatedAt,
        orderPaidAt:     null,
        orderDeliveredAt: null,
        mlShippingCost:   shippingCost,
        mlInstallmentFee: 0,
        calcGmv:          calc.gmv,
        calcShopeeFee:    calc.marketplaceFee,
        calcNetRevenue:   calc.netRevenue,
        calcTax:          calc.taxAmount,
        calcProductCost:  calc.productCost,
        calcPackaging:    calc.packaging,
        calcGrossProfit:  isRevenue ? calc.grossProfit : 0,
        calcMargin:       isRevenue ? calc.margin      : 0,
        hasCost:          calc.hasCost,
        status:           categoryToStatus(orderCategory),
        soldAt,
        salePrice:        calc.gmv,
        profit:           isRevenue ? calc.grossProfit : 0,
        margin:           isRevenue ? calc.margin      : 0,
        snapshotTaxRate:  store.taxRate ?? 0,
      });
    } catch {
      // linha com erro: continua
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

  const faturados      = ordersData.filter((o) => ['valid', 'pending', 'returned_partial'].includes(o.orderCategory));
  const sum            = (arr, f) => arr.reduce((s, o) => s + (o[f] ?? 0), 0);
  const gmv            = sum(faturados, 'calcGmv');
  const deductions     = sum(faturados, 'calcShopeeFee');
  const netRevenue     = sum(faturados, 'calcNetRevenue');
  const grossProfit    = sum(faturados.filter((o) => o.hasCost), 'calcGrossProfit');
  const validCount     = ordersData.filter((o) => o.orderCategory === 'valid').length;
  const pendingCount   = ordersData.filter((o) => o.orderCategory === 'pending').length;
  const cancelledCount = ordersData.filter((o) => o.orderCategory.startsWith('cancelled')).length;

  await prisma.import.update({
    where: { id: imp.id },
    data: {
      validCount, pendingCount, cancelledCount,
      gmv:              parseFloat(gmv.toFixed(2)),
      shopeeDeductions: parseFloat(deductions.toFixed(2)),
      netRevenue:       parseFloat(netRevenue.toFixed(2)),
      grossProfit:      parseFloat(grossProfit.toFixed(2)),
      skippedCount:     orderGroups.size - ordersData.length - existingSet.size,
      newProductCount:  newProductsMap.size,
      status:           'done',
    },
  });

  await onProgress?.({ pct: 90, message: 'Atualizando taxas...' });

  const unitCount    = faturados.reduce((s, o) => s + o.quantity, 0);
  const cancelledGmv = sum(ordersData.filter((o) => o.orderCategory.startsWith('cancelled')), 'calcGmv');
  const tax          = sum(faturados, 'calcTax');
  const margin       = gmv > 0 ? parseFloat(((grossProfit / gmv) * 100).toFixed(2)) : 0;

  await prisma.shopeePeriodSummary.upsert({
    where:  { storeId_month: { storeId, month: periodMonth } },
    create: { storeId, month: periodMonth, gmv: parseFloat(gmv.toFixed(2)), shopeeDeductions: parseFloat(deductions.toFixed(2)), netRevenue: parseFloat(netRevenue.toFixed(2)), tax: parseFloat(tax.toFixed(2)), grossProfit: parseFloat(grossProfit.toFixed(2)), margin, validCount, unitCount, cancelledCount, cancelledGmv: parseFloat(cancelledGmv.toFixed(2)) },
    update: { gmv: parseFloat(gmv.toFixed(2)), shopeeDeductions: parseFloat(deductions.toFixed(2)), netRevenue: parseFloat(netRevenue.toFixed(2)), tax: parseFloat(tax.toFixed(2)), grossProfit: parseFloat(grossProfit.toFixed(2)), margin, validCount, unitCount, cancelledCount, cancelledGmv: parseFloat(cancelledGmv.toFixed(2)) },
  });

  await recalculateStoreRates(storeId, mon, year).catch(() => {});

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

module.exports = { importTiktokOrderAll };
