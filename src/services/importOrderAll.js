const XLSX        = require('xlsx');
const { randomUUID } = require('crypto');
const prisma       = require('../lib/prisma');
const { calcOrderProfit } = require('./calculatorService');

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  return parseFloat(String(v).trim().replace(',', '.')) || 0;
}

function parseQty(v) { return Math.max(1, Math.round(parseNum(v))); }

function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s.replace(' ', 'T') + (s.includes(':') ? ':00.000Z' : 'T00:00:00.000Z'));
  return isNaN(d.getTime()) ? null : d;
}

function normStr(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[–—\-]/g, ' ')
    .replace(/[|]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractNameAndVariation(productName, variationName) {
  if (variationName && variationName.trim()) {
    return { realName: productName, realVariation: variationName.trim() };
  }
  const idx = productName.lastIndexOf(' — ');
  if (idx > -1) {
    return { realName: productName.substring(0, idx).trim(), realVariation: productName.substring(idx + 3).trim() };
  }
  return { realName: productName, realVariation: '' };
}

function extractMonth(rows, fallbackFilename) {
  const m = String(fallbackFilename || '').match(/(\d{4})(\d{2})\d{2}/);
  if (m) return `${m[1]}-${m[2]}`;
  for (const row of rows.slice(0, 20)) {
    const d = parseDate(row['Data de criação do pedido'] || row['Hora do pagamento do pedido']);
    if (d) return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function classifyOrder(row) {
  const status       = String(row['Status do pedido'] || '').trim();
  const returnStatus = String(row['Status da Devolução / Reembolso'] || '').trim();
  const globalTotal  = parseNum(row['Total global']);
  const cancelReason = String(row['Cancelar Motivo'] || '').trim().toLowerCase();

  if (status === 'Concluído') {
    if (returnStatus === 'Solicitação aprovada') return globalTotal === 0 ? 'returned_full' : 'returned_partial';
    if (returnStatus === 'Devolução em Andamento') return globalTotal > 0 ? 'returned_partial' : 'returned_full';
    return 'valid';
  }
  if (status === 'Cancelado' || status === 'Não pago') {
    return (cancelReason.includes('automaticamente') || cancelReason.includes('não pago') || status === 'Não pago')
      ? 'cancelled_unpaid' : 'cancelled_other';
  }
  const pendingKws = ['A Enviar', 'Enviado', 'Entregue', 'Order Received'];
  if (pendingKws.some((kw) => status.includes(kw))) return 'pending';
  if (status.startsWith('O comprador pode pedir')) return 'pending';
  return 'pending';
}

function categoryToStatus(cat) {
  if (cat === 'returned_full') return 'returned';
  if (cat.startsWith('cancelled')) return 'cancelled';
  return 'paid';
}

function r2(n) { return Math.round(n * 100) / 100; }

function chunkArr(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Import principal ──────────────────────────────────────────────────────────

async function importShopeeOrderAll(filePath, storeId, userId, originalFilename, onProgress, existingImportId = null) {

  // ═══ FASE 1: Carregar TUDO em memória — 2 queries paralelas ════════════════
  await onProgress?.({ pct: 5, message: 'Carregando dados...' });

  const [store, products] = await Promise.all([
    prisma.store.findFirst({ where: userId ? { id: storeId, userId } : { id: storeId } }),
    prisma.product.findMany({
      where: { storeId },
      select: { id: true, sku: true, name: true, costPrice: true, packaging: true, parentId: true, listPrice: true },
    }),
  ]);
  if (!store) throw new Error('Loja não encontrada');

  // Índices O(1)
  const bySkuMap      = new Map(); // sku.lower → product
  const byNameMap     = new Map(); // name.lower → product
  const byNormNameMap = new Map(); // normStr(name) → product

  for (const p of products) {
    if (p.sku) bySkuMap.set(p.sku.toLowerCase().trim(), p);
    byNameMap.set(p.name.toLowerCase().trim(), p);
    byNormNameMap.set(normStr(p.name), p);
  }

  // ═══ FASE 2: Ler XLSX + criar Import record ════════════════════════════════
  await onProgress?.({ pct: 8, message: 'Lendo arquivo...' });

  const workbook = XLSX.readFile(filePath, { raw: false });
  const rows     = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
  if (rows.length === 0) throw new Error('Arquivo vazio ou sem dados');

  const periodMonth  = extractMonth(rows, originalFilename);
  const [year, mon]  = periodMonth.split('-').map(Number);
  const fallbackDate = new Date(Date.UTC(year, mon - 1, 15));

  // Usar Import record existente (criado pelo controller) ou criar novo
  let imp;
  if (existingImportId) {
    imp = await prisma.import.update({
      where: { id: existingImportId },
      data: { periodMonth, totalRows: rows.length },
    });
  } else {
    imp = await prisma.import.create({
      data: { storeId, filename: originalFilename, periodMonth, totalRows: rows.length, status: 'processing' },
    });
  }

  // ═══ VALIDAÇÃO: SKU Principal obrigatório — bloquear antes de processar ═══
  await onProgress?.({ pct: 10, message: 'Validando arquivo...' });

  const semSkuPai = rows.filter(row => {
    const sku = String(row['Nº de referência do SKU principal'] || '').trim();
    return !sku || sku.toLowerCase() === 'nan';
  });

  if (semSkuPai.length > 0) {
    const produtosSemSku = [...new Set(
      semSkuPai.map(r => String(r['Nome do Produto'] || '').trim()).filter(Boolean)
    )].slice(0, 20);

    const errorData = JSON.stringify({
      code:     'MISSING_SKU_PRINCIPAL',
      count:    semSkuPai.length,
      produtos: produtosSemSku,
    });

    await prisma.import.update({
      where: { id: imp.id },
      data:  { status: 'error', errorMessage: errorData },
    });

    throw new Error(errorData);
  }
  // ═══ FIM DA VALIDAÇÃO ═════════════════════════════════════════════════════

  await onProgress?.({ pct: 12, message: `${rows.length} linhas encontradas — processando em memória...` });

  // ═══ FASE 3: Processar TODOS os pedidos em memória — ZERO queries ══════════
  const ordersData     = [];
  const newParentsMap  = new Map(); // skuPrincipal → { id, sku, name, listPrice, variants: Map<skuVar, varData> }
  const newProductsMap = new Map(); // key → { id, ...fields } — produtos simples ou filhos de pai já existente
  const toUpdateSkus   = new Map(); // productId → sku

  // Infere o SKU pai a partir do SKU de variação: EZ0333-6 → EZ0333
  function inferPai(skuVar) {
    if (!skuVar) return null;
    const m = skuVar.match(/^(.+)-\d+$/);
    return m ? m[1] : null;
  }

  function findProduct(skuVar, skuPai) {
    if (skuVar) return bySkuMap.get(skuVar.toLowerCase().trim()) ?? null;
    if (skuPai) return bySkuMap.get(skuPai.toLowerCase().trim()) ?? null;
    return null;
  }

  function findProductByName(productName, variationName) {
    const hasVar = !!variationName && variationName !== '-' && variationName.trim() !== '';
    if (hasVar) {
      const p = byNameMap.get(`${productName} — ${variationName}`.toLowerCase().trim());
      if (p) return p;
    }
    const pByName = byNameMap.get(productName.toLowerCase().trim());
    if (pByName) return pByName;
    const normKey = hasVar ? `${normStr(productName)} ${normStr(variationName)}` : normStr(productName);
    return byNormNameMap.get(normKey) ?? (hasVar ? byNormNameMap.get(normStr(productName)) : null) ?? null;
  }

  for (const row of rows) {
    try {
      const orderId = String(row['ID do pedido'] || '').trim();
      if (!orderId) continue;

      const skuVar       = String(row['Número de referência SKU'] || '').trim() || null;
      const skuPai       = String(row['Nº de referência do SKU principal'] || '').trim() || null;
      const rawName      = String(row['Nome do Produto'] || '').trim();
      const rawVar       = String(row['Nome da variação'] || '').trim() || null;
      const { realName: productName, realVariation: varStr } = extractNameAndVariation(rawName, rawVar);
      const variationName = varStr || null;

      const agreedPrice    = parseNum(row['Preço acordado']);
      const originalPrice  = parseNum(row['Preço original']);
      const salePrice      = agreedPrice > 0 ? agreedPrice : originalPrice;
      const quantity       = parseQty(row['Quantidade']);
      const shopeeComm     = parseNum(row['Taxa de comissão líquida']);
      const shopeeFee      = parseNum(row['Taxa de serviço líquida']);
      const sellerCoupon   = parseNum(row['Cupom do vendedor']);
      const sellerDiscount = parseNum(row['Desconto do vendedor']);
      const lmmDiscount    = parseNum(row['Desconto da Leve Mais por Menos do vendedor']);
      const globalTotal    = parseNum(row['Total global']);
      const orderTotal     = parseNum(row['Valor Total']);
      const trackingNumber = String(row['Número de rastreamento'] || '').trim() || null;
      const shippingOption = String(row['Opção de envio'] || '').trim() || null;
      const cancelReason   = String(row['Cancelar Motivo'] || '').trim() || null;
      const returnStatus   = String(row['Status da Devolução / Reembolso'] || '').trim() || null;
      const orderCreatedAt   = parseDate(row['Data de criação do pedido']);
      const orderPaidAt      = parseDate(row['Hora do pagamento do pedido']);
      const orderDeliveredAt = parseDate(row['Hora completa do pedido']);
      const soldAt = orderPaidAt ?? orderCreatedAt ?? fallbackDate;
      const orderCategory = classifyOrder(row);
      const orderStatus   = String(row['Status do pedido'] || '').trim();

      // LOOKUP O(1) — sem query
      let product = findProduct(skuVar, skuPai);

      // Sem SKU → fallback por nome (pedidos legados)
      if (!product && !skuVar && !skuPai) {
        product = findProductByName(productName, variationName);
      }

      // Registrar SKU para atualizar produtos encontrados sem SKU
      if (product && skuVar && !product.sku) {
        toUpdateSkus.set(product.id, skuVar);
        product.sku = skuVar;
        bySkuMap.set(skuVar.toLowerCase(), product);
      }

      const platformNetRevenue = globalTotal > 0
        ? r2(globalTotal - shopeeComm - shopeeFee)
        : null;

      const calc = calcOrderProfit({
        agreedPrice:       salePrice,
        quantity,
        sellerCoupon,
        lmmDiscount,
        costPrice:         product?.costPrice ?? 0,
        packagingCost:     product?.packaging ?? 0,
        taxRate:           store.taxRate ?? 0,
        platformNetRevenue,
      });

      ordersData.push({
        storeId,
        importId:        imp.id,
        orderId,
        orderStatus,
        orderCategory,
        cancelReason,
        returnStatus,
        skuPrincipal:    skuPai || null,
        skuVariacao:     skuVar || null,
        productName:     productName || null,
        variationName,
        productId:       product?.id ?? null,
        originalPrice,
        agreedPrice:     salePrice,
        quantity,
        shopeeCommission: shopeeComm,
        shopeeServiceFee: shopeeFee,
        sellerCoupon,
        sellerDiscount,
        lmmDiscount,
        globalTotal,
        orderTotal,
        trackingNumber,
        shippingOption,
        orderCreatedAt,
        orderPaidAt,
        orderDeliveredAt,
        calcGmv:         calc.gmv,
        calcShopeeFee:   calc.shopeeFee,
        calcNetRevenue:  calc.netRevenue,
        calcTax:         calc.taxAmount,
        calcProductCost: calc.productCost,
        calcPackaging:   calc.packaging,
        calcGrossProfit: calc.grossProfit,
        calcMargin:      calc.margin,
        hasCost:         calc.hasCost,
        status:          categoryToStatus(orderCategory),
        soldAt,
        salePrice:       calc.gmv,
        profit:          calc.grossProfit,
        margin:          calc.margin,
        snapshotTaxRate: store.taxRate ?? 0,
      });

      // Marcar produtos órfãos para criar depois
      if (!product) {
        // effectiveSkuPai: usa o skuPai do arquivo quando é diferente do skuVar,
        // senão tenta inferir pelo padrão EZ0333-6 → EZ0333
        const effectiveSkuPai = (skuPai && skuPai !== skuVar)
          ? skuPai
          : inferPai(skuVar);

        const isVariant = !!(skuVar && effectiveSkuPai && skuVar !== effectiveSkuPai);
        const hasVar    = !!(variationName && variationName !== '-');
        const preco     = salePrice;

        if (isVariant) {
          const existingParent = bySkuMap.get(effectiveSkuPai.toLowerCase().trim());

          if (existingParent && !newParentsMap.has(effectiveSkuPai)) {
            // Pai já existe no DB — adicionar variação como filho do pai existente
            if (!newProductsMap.has(skuVar)) {
              const pid   = randomUUID();
              const pname = hasVar ? `${existingParent.name} — ${variationName}` : productName;
              newProductsMap.set(skuVar, {
                id: pid, sku: skuVar, name: pname, storeId,
                listPrice: preco,
                parentId: existingParent.id,
                costPrice: 0, packaging: 0, supplies: 0, stock: 0, minStock: 5,
              });
              bySkuMap.set(skuVar.toLowerCase(), { id: pid, sku: skuVar, name: pname, parentId: existingParent.id });
            }
          } else {
            // Pai não existe no DB — criar pai + variação no newParentsMap
            if (!newParentsMap.has(effectiveSkuPai)) {
              const parentId = randomUUID();
              newParentsMap.set(effectiveSkuPai, { id: parentId, sku: effectiveSkuPai, name: productName, listPrice: preco, storeId, variants: new Map() });
              bySkuMap.set(effectiveSkuPai.toLowerCase(), { id: parentId, sku: effectiveSkuPai, name: productName, parentId: null });
            }
            const parentEntry = newParentsMap.get(effectiveSkuPai);
            if (!parentEntry.variants.has(skuVar)) {
              const varId   = randomUUID();
              const varName = hasVar ? `${productName} — ${variationName}` : productName;
              parentEntry.variants.set(skuVar, { id: varId, sku: skuVar, name: varName, listPrice: preco });
              bySkuMap.set(skuVar.toLowerCase(), { id: varId, sku: skuVar, name: varName, parentId: parentEntry.id });
            }
          }
        } else {
          // Produto simples — sem padrão de variação detectável
          const key = skuVar || `${productName}||${variationName || ''}`;
          if (!newProductsMap.has(key)) {
            const pid   = randomUUID();
            newProductsMap.set(key, {
              id: pid, sku: skuVar, name: productName, storeId,
              listPrice: preco,
              parentId:  null,
              costPrice: 0, packaging: 0, supplies: 0, stock: 0, minStock: 5,
            });
            bySkuMap.set((skuVar || key).toLowerCase(), { id: pid, sku: skuVar, name: productName, parentId: null });
          }
        }
      }
    } catch (err) {
      // linha com erro: continua
    }
  }

  // ═══ FASE 4: Criar produtos órfãos — 2-4 queries totais ═══════════════════
  if (newParentsMap.size > 0 || newProductsMap.size > 0) {
    await onProgress?.({ pct: 55, message: `Criando ${newParentsMap.size + newProductsMap.size} produtos novos...` });

    // 4a. Pais novos (createMany — 1 INSERT)
    if (newParentsMap.size > 0) {
      const parentRows = [...newParentsMap.values()].map(({ id, sku, name, listPrice, storeId: sid }) => ({
        id, sku, name, storeId: sid, listPrice, costPrice: 0, packaging: 0, supplies: 0, stock: 0, minStock: 5,
      }));
      await prisma.product.createMany({ data: parentRows, skipDuplicates: true });

      // 4b. Variações (1 INSERT)
      const varRows = [];
      for (const parent of newParentsMap.values()) {
        for (const v of parent.variants.values()) {
          varRows.push({ id: v.id, sku: v.sku, name: v.name, storeId, parentId: parent.id, listPrice: v.listPrice, costPrice: 0, packaging: 0, supplies: 0, stock: 0, minStock: 5 });
        }
      }
      if (varRows.length > 0) await prisma.product.createMany({ data: varRows, skipDuplicates: true });
    }

    // 4c. Produtos simples / filhos de pai existente (1 INSERT)
    if (newProductsMap.size > 0) {
      const simpleRows = [...newProductsMap.values()];
      for (const batch of chunkArr(simpleRows, 500)) {
        await prisma.product.createMany({ data: batch, skipDuplicates: true });
      }
    }

  } else {
    await onProgress?.({ pct: 55, message: 'Nenhum produto novo.' });
  }

  // ═══ FASE 5: Salvar pedidos — createMany em batches de 200 ════════════════
  await onProgress?.({ pct: 60, message: `Salvando ${ordersData.length} pedidos...` });

  for (const batch of chunkArr(ordersData, 200)) {
    await prisma.order.createMany({ data: batch, skipDuplicates: true });
  }

  // 5b. Vincular pedidos órfãos aos produtos pelo SKU (roda APÓS createMany)
  // Necessário para produtos criados neste mesmo import (não estavam no bySkuMap no início)
  await prisma.$executeRaw`
    UPDATE \`Order\` o
    INNER JOIN Product p
      ON p.storeId = o.storeId
      AND p.sku IS NOT NULL
      AND (p.sku = o.skuVariacao OR (o.skuVariacao IS NULL AND p.sku = o.skuPrincipal))
    SET o.productId = p.id
    WHERE o.importId = ${imp.id} AND o.productId IS NULL
  `;

  await onProgress?.({ pct: 78, message: 'Pedidos salvos.' });

  // ═══ FASE 6: Atualizar SKUs e preços — SQL puro, zero loops ══════════════
  // 6a. Atualizar SKU em produtos encontrados por nome que ainda não tinham
  if (toUpdateSkus.size > 0) {
    const entries = [...toUpdateSkus];
    for (const batch of chunkArr(entries, 50)) {
      await prisma.$transaction(
        batch.map(([productId, sku]) => prisma.product.update({ where: { id: productId }, data: { sku } }))
      );
    }
  }

  // 6b. Atualizar listPrice: variações (preço mais recente de cada produto via SQL)
  await prisma.$executeRaw`
    UPDATE Product p
    INNER JOIN (
      SELECT productId, agreedPrice
      FROM \`Order\`
      WHERE importId = ${imp.id}
        AND productId IS NOT NULL
        AND agreedPrice > 0
      ORDER BY COALESCE(orderPaidAt, orderCreatedAt, soldAt) DESC
    ) latest ON latest.productId = p.id
    SET p.listPrice = latest.agreedPrice
    WHERE p.storeId = ${storeId} AND p.listPrice = 0
  `;

  // 6c. Propagar listPrice do pai (herda preço da variação mais barata)
  await prisma.$executeRaw`
    UPDATE Product p
    JOIN (
      SELECT parentId, MIN(listPrice) AS minPrice
      FROM Product
      WHERE parentId IS NOT NULL AND listPrice > 0
      GROUP BY parentId
    ) v ON v.parentId = p.id
    SET p.listPrice = v.minPrice
    WHERE p.storeId = ${storeId} AND p.listPrice = 0
  `;

  await onProgress?.({ pct: 87, message: 'Consolidando totais do período...' });

  // ═══ FASE 7: Consolidar totais e finalizar Import ════════════════════════
  const faturados  = ordersData.filter((o) => ['valid', 'pending', 'returned_partial'].includes(o.orderCategory));
  const comCusto   = faturados.filter((o) => o.hasCost);
  const sum        = (arr, f) => arr.reduce((s, o) => s + (o[f] ?? 0), 0);

  const gmv              = sum(faturados, 'calcGmv');
  const shopeeDeductions = sum(faturados, 'calcShopeeFee') + sum(faturados, 'sellerCoupon') + sum(faturados, 'lmmDiscount');
  const netRevenue       = sum(faturados, 'calcNetRevenue');
  const grossProfit      = sum(comCusto,  'calcGrossProfit');
  const validCount       = ordersData.filter((o) => o.orderCategory === 'valid').length;
  const pendingCount     = ordersData.filter((o) => o.orderCategory === 'pending').length;
  const cancelledCount   = ordersData.filter((o) => o.orderCategory.startsWith('cancelled')).length;
  const retFullCount     = ordersData.filter((o) => o.orderCategory === 'returned_full').length;
  const retPartCount     = ordersData.filter((o) => o.orderCategory === 'returned_partial').length;

  await prisma.import.update({
    where: { id: imp.id },
    data: {
      validCount, pendingCount, cancelledCount,
      returnedFullCount: retFullCount, returnedPartialCount: retPartCount,
      gmv:              parseFloat(gmv.toFixed(2)),
      shopeeDeductions: parseFloat(shopeeDeductions.toFixed(2)),
      netRevenue:       parseFloat(netRevenue.toFixed(2)),
      grossProfit:      parseFloat(grossProfit.toFixed(2)),
      skippedCount:     rows.length - ordersData.length,
      newProductCount:  newParentsMap.size + newProductsMap.size,
      status:           'done',
    },
  });

  await onProgress?.({ pct: 92, message: 'Atualizando resumo financeiro...' });

  // Atualizar ShopeePeriodSummary (compat dashboard)
  const unitCount    = faturados.reduce((s, o) => s + o.quantity, 0);
  const cancelledGmv = sum(ordersData.filter((o) => o.orderCategory.startsWith('cancelled')), 'calcGmv');
  const tax          = sum(faturados, 'calcTax');
  const margin       = gmv > 0 ? parseFloat(((grossProfit / gmv) * 100).toFixed(2)) : 0;

  await prisma.shopeePeriodSummary.upsert({
    where:  { storeId_month: { storeId, month: periodMonth } },
    create: { storeId, month: periodMonth, gmv: parseFloat(gmv.toFixed(2)), shopeeDeductions: parseFloat(shopeeDeductions.toFixed(2)), netRevenue: parseFloat(netRevenue.toFixed(2)), tax: parseFloat(tax.toFixed(2)), grossProfit: parseFloat(grossProfit.toFixed(2)), margin, validCount, unitCount, cancelledCount, cancelledGmv: parseFloat(cancelledGmv.toFixed(2)) },
    update: { gmv: parseFloat(gmv.toFixed(2)), shopeeDeductions: parseFloat(shopeeDeductions.toFixed(2)), netRevenue: parseFloat(netRevenue.toFixed(2)), tax: parseFloat(tax.toFixed(2)), grossProfit: parseFloat(grossProfit.toFixed(2)), margin, validCount, unitCount, cancelledCount, cancelledGmv: parseFloat(cancelledGmv.toFixed(2)) },
  });

  await onProgress?.({ pct: 100, message: 'Concluído!' });

  return {
    imported:   ordersData.length,
    valid:      validCount,
    pending:    pendingCount,
    cancelled:  cancelledCount,
    skipped:    rows.length - ordersData.length,
    newProducts: newParentsMap.size + newProductsMap.size,
    periodMonth,
  };
}

module.exports = { importShopeeOrderAll };
