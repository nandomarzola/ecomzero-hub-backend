const XLSX  = require('xlsx');
const prisma = require('../lib/prisma');
const { calcProfit } = require('./calculatorService');

function parseBRL(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const str = String(value).trim();
  if (!str || str === '-') return 0;
  return parseFloat(str.replace(/\./g, '').replace(',', '.')) || 0;
}

function parseINT(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Math.round(value);
  return parseInt(String(value).trim().replace(/\./g, '').replace(',', '.')) || 0;
}

function extractMonthKey(filename) {
  if (filename) {
    const m = String(filename).match(/(\d{4})(\d{2})\d{2}_/);
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

async function importShopeeParentSKU(filePath, storeId, userId, originalFilename, onProgress) {
  // ── 1. Verificar loja ────────────────────────────────────────────────────
  const where = userId ? { id: storeId, userId } : { id: storeId };
  const store = await prisma.store.findFirst({ where });
  if (!store) throw new Error('Loja não encontrada');

  const monthKey = extractMonthKey(originalFilename);
  const [year, mon] = monthKey.split('-').map(Number);
  const soldAt = new Date(Date.UTC(year, mon - 1, 15)); // dia 15 do mês como referência

  // ── 2. Ler XLSX e agrupar linhas ─────────────────────────────────────────
  const workbook = XLSX.readFile(filePath, { raw: false });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rows     = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const groups = {};
  for (const row of rows) {
    const itemId = String(row['ID do Item'] || '').trim();
    if (!itemId || itemId === 'ID do Item') continue;
    if (!groups[itemId]) groups[itemId] = { parent: null, variations: [] };
    String(row['ID da Variação'] || '').trim() === '-'
      ? (groups[itemId].parent = row)
      : groups[itemId].variations.push(row);
  }

  // ── 3. PRÉ-FETCH em batch: produtos existentes + orders do mês ───────────
  // Uma query para todos os produtos da loja
  const existingProducts = await prisma.product.findMany({
    where:  { storeId },
    select: { id: true, externalId: true, sku: true, costPrice: true, packaging: true, supplies: true, parentId: true },
  });
  const byExternalId = new Map(existingProducts.map((p) => [p.externalId, p]));
  const bySku        = new Map(existingProducts.filter((p) => p.sku).map((p) => [p.sku, p]));

  // Uma query para todos os externalIds de orders já importados (evita duplicata)
  const existingOrders = await prisma.order.findMany({
    where:  { storeId },
    select: { externalId: true },
  });
  const existingExternalIds = new Set(existingOrders.map((o) => o.externalId));

  // ── 4. Calcular o que precisa ser criado ─────────────────────────────────
  const productsToCreate = []; // novos produtos a criar em batch
  const ordersToCreate   = []; // { externalId, productRef, revenue, quantity, unitPrice }
  const errors = [];

  // Variação ativa = tem vendas pagas E não foi excluída no Shopee
  const isActiveVar = (v) =>
    parseBRL(v['Vendas (Pedido pago) (BRL)']) > 0 &&
    String(v['Status Atual da Variação'] || '').trim() !== 'Excluído';

  // Variação excluída mas com vendas reais → pedido vai para o produto pai (preserva faturamento)
  const isDeletedWithRevenue = (v) =>
    parseBRL(v['Vendas (Pedido pago) (BRL)']) > 0 &&
    String(v['Status Atual da Variação'] || '').trim() === 'Excluído';

  let total = 0;
  for (const group of Object.values(groups)) {
    const active  = group.variations.filter(isActiveVar);
    const deleted = group.variations.filter(isDeletedWithRevenue);
    if (active.length + deleted.length > 0) total += active.length + deleted.length;
    else if (group.parent && parseBRL(group.parent['Vendas (Pedido pago) (BRL)']) > 0) total++;
  }

  // Mapa de produtos que ainda vamos criar (key = externalId planejado)
  const plannedProducts = new Map();

  for (const [itemId, group] of Object.entries(groups)) {
    const varsActive  = group.variations.filter(isActiveVar);
    const varsDeleted = group.variations.filter(isDeletedWithRevenue);

    if (varsActive.length > 0 || varsDeleted.length > 0) {
      // ── Produto com variações (ativas e/ou excluídas com vendas) ──
      const parentName  = String(group.parent?.['Produto'] || varsActive[0]?.['Produto'] || varsDeleted[0]?.['Produto'] || '').trim();
      const parentExtId = itemId;

      // Garantir produto pai (pode já existir, estar em byExternalId ou ser novo)
      let parentRef = byExternalId.get(parentExtId) ?? plannedProducts.get(parentExtId);
      if (!parentRef) {
        parentRef = { _planned: true, externalId: parentExtId, name: parentName.substring(0, 255), sku: null, costPrice: 0, listPrice: 0, packaging: 0, supplies: 0, stock: 0 };
        productsToCreate.push({ storeId, externalId: parentExtId, name: parentRef.name, sku: null, costPrice: 0, listPrice: 0, packaging: 0, supplies: 0, stock: 0 });
        plannedProducts.set(parentExtId, parentRef);
      }

      // ── Variações ativas: cria produto de variação e pedido normalmente ──
      for (const varRow of varsActive) {
        try {
          const varId       = String(varRow['ID da Variação'] || '').trim();
          const varName     = String(varRow['Nome da Variação'] || '').trim();
          const productName = String(varRow['Produto'] || group.parent?.['Produto'] || '').trim();
          const sku         = String(varRow['SKU da Variação'] || varRow['SKU Principle'] || '').trim();
          const revenue     = parseBRL(varRow['Vendas (Pedido pago) (BRL)']);
          const quantity    = parseINT(varRow['Unidades (Pedido pago)']);
          if (revenue <= 0 || quantity <= 0) continue;

          const unitPrice  = parseFloat((revenue / quantity).toFixed(2));
          const externalId = `${itemId}_${varId}_${monthKey}`;
          if (existingExternalIds.has(externalId)) continue;

          const varExtId = `${itemId}_${varId}`;
          let productRef = (sku && sku !== '-' ? bySku.get(sku) : null) ?? byExternalId.get(varExtId) ?? plannedProducts.get(varExtId);

          if (!productRef) {
            // Não usar varName se for igual ao productName (evita "Produto — Produto")
            const usefulVarName = varName && varName !== '-' && varName.trim().toLowerCase() !== productName.trim().toLowerCase()
              ? varName.trim()
              : null;
            const displayName = usefulVarName ? `${productName} — ${usefulVarName}` : productName;
            productRef = { _planned: true, externalId: varExtId, costPrice: 0, packaging: 0, supplies: 0 };
            productsToCreate.push({
              storeId,
              externalId: varExtId,
              name:       displayName.substring(0, 255),
              sku:        sku && sku !== '-' ? sku : `SHOPEE-${itemId}-${varId}`,
              costPrice:  0, listPrice: unitPrice, packaging: 0, supplies: 0, stock: 0,
              _parentExtId: parentExtId,
            });
            plannedProducts.set(varExtId, productRef);
          }

          ordersToCreate.push({ externalId, varExtId: productRef._planned ? varExtId : null, productId: productRef._planned ? null : productRef.id, revenue, quantity, unitPrice, storeConfig: store });
        } catch (err) {
          errors.push({ produto: String(varRow['Produto'] || '?').substring(0, 50), erro: err.message });
        }
      }

      // ── Variações excluídas com vendas reais ──
      // Era um produto único antes de virar variação. Cria como produto próprio
      // com prefixo "(Produto Inexistente)" para identificar que não existe mais.
      for (const varRow of varsDeleted) {
        try {
          const varId       = String(varRow['ID da Variação'] || '').trim();
          const productName = String(varRow['Produto'] || group.parent?.['Produto'] || '').trim();
          const sku         = String(varRow['SKU da Variação'] || varRow['SKU Principle'] || '').trim();
          const revenue     = parseBRL(varRow['Vendas (Pedido pago) (BRL)']);
          const quantity    = parseINT(varRow['Unidades (Pedido pago)']);
          if (revenue <= 0 || quantity <= 0) continue;

          const externalId = `${itemId}_${varId}_${monthKey}`;
          if (existingExternalIds.has(externalId)) continue;

          const unitPrice = parseFloat((revenue / quantity).toFixed(2));
          const varExtId  = `${itemId}_${varId}`;

          let productRef = (sku && sku !== '-' ? bySku.get(sku) : null) ?? byExternalId.get(varExtId) ?? plannedProducts.get(varExtId);

          if (!productRef) {
            const displayName = `(Produto Inexistente) ${productName}`.substring(0, 255);
            productRef = { _planned: true, externalId: varExtId, costPrice: 0, packaging: 0, supplies: 0 };
            productsToCreate.push({
              storeId,
              externalId: varExtId,
              name:       displayName,
              sku:        sku && sku !== '-' ? sku : `SHOPEE-${itemId}-${varId}`,
              costPrice:  0, listPrice: unitPrice, packaging: 0, supplies: 0, stock: 0,
              _parentExtId: parentExtId,
            });
            plannedProducts.set(varExtId, productRef);
          }

          ordersToCreate.push({ externalId, varExtId: productRef._planned ? varExtId : null, productId: productRef._planned ? null : productRef.id, revenue, quantity, unitPrice, storeConfig: store });
        } catch (err) {
          errors.push({ produto: String(varRow['Produto'] || '?').substring(0, 50), erro: err.message });
        }
      }

    } else if (group.parent) {
      // ── Produto sem variações ──
      try {
        const row         = group.parent;
        const productName = String(row['Produto'] || '').trim();
        const sku         = String(row['SKU Principle'] || row['SKU da Variação'] || '').trim();
        const revenue     = parseBRL(row['Vendas (Pedido pago) (BRL)']);
        const quantity    = parseINT(row['Unidades (Pedido pago)']);
        if (revenue <= 0 || quantity <= 0) continue;

        const unitPrice  = parseFloat((revenue / quantity).toFixed(2));
        const externalId = `${itemId}_${monthKey}`;
        if (existingExternalIds.has(externalId)) continue;

        let productRef = (sku && sku !== '-' ? bySku.get(sku) : null) ?? byExternalId.get(itemId) ?? plannedProducts.get(itemId);

        if (!productRef) {
          productRef = { _planned: true, externalId: itemId, costPrice: 0, packaging: 0, supplies: 0 };
          productsToCreate.push({
            storeId,
            externalId: itemId,
            name:       productName.substring(0, 255),
            sku:        sku && sku !== '-' ? sku : `SHOPEE-${itemId}`,
            costPrice:  0, listPrice: unitPrice, packaging: 0, supplies: 0, stock: 0,
          });
          plannedProducts.set(itemId, productRef);
        }

        ordersToCreate.push({ externalId, varExtId: productRef._planned ? itemId : null, productId: productRef._planned ? null : productRef.id, revenue, quantity, unitPrice, storeConfig: store });
      } catch (err) {
        errors.push({ produto: String(group.parent['Produto'] || '?').substring(0, 50), erro: err.message });
      }
    }
  }

  onProgress?.({ step: 'products', current: 0, total: productsToCreate.length });

  // ── 5. Criar produtos em batch (uma query) ──────────────────────────────
  if (productsToCreate.length > 0) {
    // Remover o campo auxiliar antes de criar
    const data = productsToCreate.map(({ _parentExtId, ...rest }) => rest);
    await prisma.product.createMany({ data, skipDuplicates: true });

    // Buscar os recém-criados para obter IDs
    const created = await prisma.product.findMany({
      where:  { storeId, externalId: { in: productsToCreate.map((p) => p.externalId) } },
      select: { id: true, externalId: true },
    });
    for (const p of created) byExternalId.set(p.externalId, p);

    // Vincular variações ao produto pai (batch update)
    const variantsToLink = productsToCreate.filter((p) => p._parentExtId);
    if (variantsToLink.length > 0) {
      await Promise.all(
        variantsToLink.map((v) => {
          const parentProduct = byExternalId.get(v._parentExtId);
          const varProduct    = byExternalId.get(v.externalId);
          if (parentProduct && varProduct) {
            return prisma.product.update({ where: { id: varProduct.id }, data: { parentId: parentProduct.id } });
          }
        }).filter(Boolean)
      );
    }
  }

  onProgress?.({ step: 'orders', current: 0, total: ordersToCreate.length });

  // ── 6. Criar orders em paralelo (batches de 20) ──────────────────────────
  let imported = 0;
  let skipped  = 0;
  let totalRevenue = 0;
  let totalProfit  = 0;

  const orderBatches = chunks(ordersToCreate, 20);
  for (const batch of orderBatches) {
    await Promise.all(
      batch.map(async (item) => {
        try {
          const productId = item.productId ?? byExternalId.get(item.varExtId)?.id;
          if (!productId) { skipped++; return; }

          // Buscar produto para calcProfit (custo pode ser 0, OK)
          const product = existingProducts.find((p) => p.id === productId) ?? { costPrice: 0, packaging: 0, supplies: 0 };
          const calc    = calcProfit(item.revenue, item.quantity, product, item.storeConfig, 0, 0);

          await prisma.$transaction(async (tx) => {
            const order = await tx.order.create({
              data: {
                storeId,
                externalId:         item.externalId,
                salePrice:          item.revenue,
                freight:            0,
                discount:           0,
                status:             'paid',
                soldAt,
                profit:             calc.profit,
                margin:             calc.margin,
                snapshotCommission: store.commission,
                snapshotServiceFee: store.serviceFee,
                snapshotTaxRate:    store.taxRate,
                snapshotFixedFee:   store.fixedFeePerItem || 0,
              },
            });
            await tx.orderItem.create({
              data: {
                orderId:           order.id,
                productId,
                quantity:          item.quantity,
                unitPrice:         item.unitPrice,
                snapshotCostPrice: product.costPrice,
                snapshotPackaging: product.packaging ?? 0,
                snapshotSupplies:  product.supplies  ?? 0,
              },
            });
          });

          totalRevenue += item.revenue;
          totalProfit  += calc.profit;
          imported++;
        } catch (err) {
          skipped++;
          errors.push({ produto: item.externalId, erro: err.message });
        }
      })
    );
    onProgress?.({ step: 'orders', current: imported + skipped, total: ordersToCreate.length });
  }

  return {
    imported,
    skipped,
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    totalProfit:  parseFloat(totalProfit.toFixed(2)),
    avgMargin:    totalRevenue > 0 ? parseFloat(((totalProfit / totalRevenue) * 100).toFixed(2)) : 0,
    errors:       errors.slice(0, 20),
  };
}

module.exports = { importShopeeParentSKU };
