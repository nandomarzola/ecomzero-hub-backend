#!/usr/bin/env node
'use strict';

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');

const CSV_PATH =
  process.argv[2] ||
  '/home/nandomarzola/Downloads/MAIO_2026_pedidos_SKUs_EZ_FINAL.csv';

const prisma = new PrismaClient();

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalize(str) {
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')     // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      cols.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

/** Derive parentSku from a variant SKU: strip trailing -N suffix */
function deriveParentSku(variantSku) {
  return variantSku.replace(/-\d+$/, '');
}

/** Jaccard similarity on word sets */
function jaccard(a, b) {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  const intersection = [...sa].filter(w => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : intersection / union;
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCsv(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1); // strip BOM

  const lines = content.split(/\r?\n/);
  // Map: normProductName → { productName, parentSku, variants: Map<normVariation, {variationName, sku}> }
  const skuMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCsvLine(line);
    if (cols.length < 20) continue;

    const productName  = cols[17].trim();
    const variantSku   = cols[18].trim();
    const variationName = cols[19].trim();

    if (!productName || !variantSku || !variantSku.startsWith('EZ')) continue;

    const parentSku  = deriveParentSku(variantSku);
    const normName   = normalize(productName);

    if (!skuMap.has(normName)) {
      skuMap.set(normName, { productName, parentSku, variants: new Map() });
    }

    const entry = skuMap.get(normName);

    // Keep the "shortest" parentSku seen (EZ0028 < EZ0028-7)
    if (entry.parentSku.length > parentSku.length) {
      entry.parentSku = parentSku;
    }

    if (variationName) {
      const normVar = normalize(variationName);
      if (!entry.variants.has(normVar)) {
        entry.variants.set(normVar, { variationName, sku: variantSku });
      }
    }
  }

  return skuMap;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nReading CSV: ${CSV_PATH}`);
  const skuMap = parseCsv(CSV_PATH);
  console.log(`Unique EZ products in CSV: ${skuMap.size}\n`);

  const dbProducts = await prisma.product.findMany({
    where:   { parentId: null },
    select:  {
      id: true, name: true, sku: true,
      variants: { select: { id: true, name: true, sku: true } },
    },
    orderBy: { name: 'asc' },
  });

  console.log(`Parent products in DB: ${dbProducts.length}\n`);

  let updatedParents  = 0;
  let updatedVariants = 0;
  let alreadyOk       = 0;
  let noMatch         = 0;
  const noMatchList   = [];

  for (const dbProd of dbProducts) {
    const normDb = normalize(dbProd.name);

    // 1 — exact normalized match
    let csvEntry = skuMap.get(normDb);

    // 2 — fuzzy: best Jaccard ≥ 0.65
    if (!csvEntry) {
      let bestScore = 0;
      let bestEntry = null;
      for (const [normCsv, entry] of skuMap.entries()) {
        const score = jaccard(normDb, normCsv);
        if (score > bestScore) { bestScore = score; bestEntry = entry; }
      }
      if (bestScore >= 0.65) csvEntry = bestEntry;
    }

    if (!csvEntry) {
      // Only report products that could plausibly have EZ codes
      noMatch++;
      noMatchList.push(dbProd.name);
      continue;
    }

    const { parentSku, variants: csvVariants } = csvEntry;

    // ── Update parent SKU ──────────────────────────────────────────────────
    if (dbProd.sku !== parentSku) {
      await prisma.product.update({ where: { id: dbProd.id }, data: { sku: parentSku } });
      console.log(`[UPDATED] ${dbProd.name}`);
      console.log(`          sku: ${dbProd.sku ?? '(null)'} → ${parentSku}`);
      updatedParents++;
    } else {
      alreadyOk++;
    }

    // ── Update variant SKUs ────────────────────────────────────────────────
    for (const dbVar of dbProd.variants) {
      // Extract variation label from DB variant name (after " — ")
      const sep = ' — '; // em dash
      const sepIdx = dbVar.name.lastIndexOf(sep);
      const rawLabel = sepIdx !== -1 ? dbVar.name.slice(sepIdx + sep.length) : dbVar.name;
      const normLabel = normalize(rawLabel);

      // Exact match
      let csvVar = csvVariants.get(normLabel);

      // Fuzzy match
      if (!csvVar && csvVariants.size > 0) {
        let bestScore = 0;
        for (const [normV, cv] of csvVariants.entries()) {
          const score = jaccard(normLabel, normV);
          if (score > bestScore) { bestScore = score; csvVar = cv; }
        }
        if (bestScore < 0.4) csvVar = null;
      }

      if (!csvVar) {
        console.log(`  [NO VAR MATCH] ${rawLabel}`);
        continue;
      }

      if (dbVar.sku !== csvVar.sku) {
        await prisma.product.update({ where: { id: dbVar.id }, data: { sku: csvVar.sku } });
        console.log(`  [UPDATED VAR] ${rawLabel}`);
        console.log(`               sku: ${dbVar.sku ?? '(null)'} → ${csvVar.sku}`);
        updatedVariants++;
      } else {
        alreadyOk++;
      }
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Updated parents  : ${updatedParents}`);
  console.log(`Updated variants : ${updatedVariants}`);
  console.log(`Already correct  : ${alreadyOk}`);
  console.log(`No CSV match     : ${noMatch}`);
  if (noMatchList.length > 0 && noMatchList.length <= 20) {
    console.log('\nProducts with no CSV match:');
    noMatchList.forEach(n => console.log(`  - ${n}`));
  }
  console.log(`${'─'.repeat(60)}\n`);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
