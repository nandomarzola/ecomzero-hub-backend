const XLSX = require('xlsx');
const prisma = require('../lib/prisma');
const { calcProfit } = require('./calculatorService');

function parseBRL(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const str = String(value).trim();
  if (!str || str === '-') return 0;
  const cleaned = str.replace(/\./g, '').replace(',', '.');
  const result = parseFloat(cleaned);
  return isNaN(result) ? 0 : result;
}

function parseINT(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Math.round(value);
  const str = String(value).trim().replace(/\./g, '').replace(',', '.');
  const result = parseInt(str);
  return isNaN(result) ? 0 : result;
}

// Extrai YYYY-MM do nome do arquivo (parentskudetail.20260501_20260524.xlsx → 2026-05)
function extractMonthKey(filename) {
  if (filename) {
    const m = String(filename).match(/(\d{4})(\d{2})\d{2}_/);
    if (m) return `${m[1]}-${m[2]}`;
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function importShopeeParentSKU(filePath, storeId, userId, originalFilename) {
  const workbook = XLSX.readFile(filePath, { raw: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const where = userId ? { id: storeId, userId } : { id: storeId };
  const store = await prisma.store.findFirst({ where });
  if (!store) throw new Error('Loja não encontrada');

  const monthKey = extractMonthKey(originalFilename);

  // Agrupar linhas por itemId para decidir pai vs variação
  const groups = {};
  for (const row of rows) {
    const itemId = String(row['ID do Item'] || '').trim();
    if (!itemId || itemId === 'ID do Item') continue;
    if (!groups[itemId]) groups[itemId] = { parent: null, variations: [] };
    const varId = String(row['ID da Variação'] || '').trim();
    if (varId === '-') {
      groups[itemId].parent = row;
    } else {
      groups[itemId].variations.push(row);
    }
  }

  let imported = 0;
  let skipped = 0;
  let totalRevenue = 0;
  let totalProfit = 0;
  const errors = [];

  for (const [itemId, group] of Object.entries(groups)) {
    const varsWithRevenue = group.variations.filter(v => parseBRL(v['Vendas (Pedido pago) (BRL)']) > 0);

    if (varsWithRevenue.length > 0) {
      // Produto COM variações — importar cada variação separada
      for (const varRow of varsWithRevenue) {
        try {
          const varId       = String(varRow['ID da Variação'] || '').trim();
          const varName     = String(varRow['Nome da Variação'] || '').trim();
          const productName = String(varRow['Produto'] || group.parent?.['Produto'] || '').trim();
          const sku         = String(varRow['SKU da Variação'] || varRow['SKU Principle'] || '').trim();

          const revenue  = parseBRL(varRow['Vendas (Pedido pago) (BRL)']);
          const quantity = parseINT(varRow['Unidades (Pedido pago)']);
          if (revenue <= 0 || quantity <= 0) { skipped++; continue; }

          const unitPrice = parseFloat((revenue / quantity).toFixed(2));
          const externalId = `${itemId}_${varId}_${monthKey}`;

          const exists = await prisma.order.findFirst({ where: { storeId, externalId } });
          if (exists) { skipped++; continue; }

          // Buscar produto pela variação
          let product = null;
          if (sku && sku !== '-') {
            product = await prisma.product.findFirst({ where: { storeId, sku } });
          }
          if (!product) {
            product = await prisma.product.findFirst({
              where: { storeId, externalId: `${itemId}_${varId}` },
            });
          }
          if (!product) {
            const displayName = varName && varName !== '-'
              ? `${productName} — ${varName}`
              : productName;
            product = await prisma.product.create({
              data: {
                storeId,
                externalId: `${itemId}_${varId}`,
                name:       displayName.substring(0, 255),
                sku:        sku && sku !== '-' ? sku : `SHOPEE-${itemId}-${varId}`,
                costPrice:  0,
                listPrice:  unitPrice,
                packaging:  0,
                supplies:   0,
                stock:      0,
              },
            });
          }

          const calc = calcProfit(revenue, quantity, product, store, 0, 0);

          await prisma.$transaction(async (tx) => {
            const order = await tx.order.create({
              data: {
                storeId,
                externalId,
                salePrice: revenue,
                freight:   0,
                discount:  0,
                status:    'paid',
                soldAt:    new Date(),
                profit:    calc.profit,
                margin:    calc.margin,
                snapshotCommission: store.commission,
                snapshotServiceFee: store.serviceFee,
                snapshotTaxRate:    store.taxRate,
                snapshotFixedFee:   store.fixedFeePerItem || 0,
              },
            });
            await tx.orderItem.create({
              data: {
                orderId:           order.id,
                productId:         product.id,
                quantity,
                unitPrice,
                snapshotCostPrice: product.costPrice,
                snapshotPackaging: product.packaging,
                snapshotSupplies:  product.supplies,
              },
            });
          });

          totalRevenue += revenue;
          totalProfit  += calc.profit;
          imported++;
        } catch (err) {
          errors.push({ produto: String(varRow['Produto'] || '?').substring(0, 50), erro: err.message });
          skipped++;
        }
      }
    } else if (group.parent) {
      // Produto SEM variações — importar linha pai
      try {
        const row         = group.parent;
        const productName = String(row['Produto'] || '').trim();
        const sku         = String(row['SKU Principle'] || row['SKU da Variação'] || '').trim();

        const revenue  = parseBRL(row['Vendas (Pedido pago) (BRL)']);
        const quantity = parseINT(row['Unidades (Pedido pago)']);
        if (revenue <= 0 || quantity <= 0) { skipped++; continue; }

        const unitPrice  = parseFloat((revenue / quantity).toFixed(2));
        const externalId = `${itemId}_${monthKey}`;

        const exists = await prisma.order.findFirst({ where: { storeId, externalId } });
        if (exists) { skipped++; continue; }

        let product = null;
        if (sku && sku !== '-') {
          product = await prisma.product.findFirst({ where: { storeId, sku } });
        }
        if (!product) {
          product = await prisma.product.findFirst({
            where: { storeId, externalId: itemId },
          });
        }
        if (!product) {
          product = await prisma.product.create({
            data: {
              storeId,
              externalId: itemId,
              name:       productName.substring(0, 255),
              sku:        sku && sku !== '-' ? sku : `SHOPEE-${itemId}`,
              costPrice:  0,
              listPrice:  unitPrice,
              packaging:  0,
              supplies:   0,
              stock:      0,
            },
          });
        }

        const calc = calcProfit(revenue, quantity, product, store, 0, 0);

        await prisma.$transaction(async (tx) => {
          const order = await tx.order.create({
            data: {
              storeId,
              externalId,
              salePrice: revenue,
              freight:   0,
              discount:  0,
              status:    'paid',
              soldAt:    new Date(),
              profit:    calc.profit,
              margin:    calc.margin,
              snapshotCommission: store.commission,
              snapshotServiceFee: store.serviceFee,
              snapshotTaxRate:    store.taxRate,
              snapshotFixedFee:   store.fixedFeePerItem || 0,
            },
          });
          await tx.orderItem.create({
            data: {
              orderId:           order.id,
              productId:         product.id,
              quantity,
              unitPrice,
              snapshotCostPrice: product.costPrice,
              snapshotPackaging: product.packaging,
              snapshotSupplies:  product.supplies,
            },
          });
        });

        totalRevenue += revenue;
        totalProfit  += calc.profit;
        imported++;
      } catch (err) {
        errors.push({ produto: String(group.parent['Produto'] || '?').substring(0, 50), erro: err.message });
        skipped++;
      }
    }
  }

  return {
    imported,
    skipped,
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    totalProfit:  parseFloat(totalProfit.toFixed(2)),
    avgMargin: totalRevenue > 0
      ? parseFloat(((totalProfit / totalRevenue) * 100).toFixed(2))
      : 0,
    errors: errors.slice(0, 20),
  };
}

module.exports = { importShopeeParentSKU };
