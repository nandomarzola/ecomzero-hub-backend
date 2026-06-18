const { z } = require('zod');
const { Prisma } = require('@prisma/client');
const prisma = require('../lib/prisma');
const { parsePage } = require('../lib/utils');
const PDFDocument = require('pdfkit');
const { getShopeeRates, calcOrderProfit } = require('../services/calculatorService');
const { recalculateStoreRates } = require('../services/storeRatesService');

const productSchema = z.object({
  storeId:             z.string().uuid('storeId inválido'),
  name:                z.string().min(1, 'Nome obrigatório'),
  externalId:          z.string().nullish(),
  sku:                 z.string().nullish(),
  barcode:             z.string().nullish(),
  category:            z.string().nullish(),
  costPrice:           z.number().min(0, 'Custo deve ser positivo'),
  listPrice:           z.number().min(0).optional(),
  packaging:           z.number().min(0).optional(),
  supplies:            z.number().min(0).optional(),
  shopeeShippingCost:  z.number().min(0).optional(),
  stock:               z.number().int().min(0).optional(),
  minStock:            z.number().int().min(0).optional(),
});

const variantSchema = z.object({
  name:      z.string().min(1, 'Nome da variação obrigatório'),
  sku:       z.string().nullish(),
  barcode:   z.string().nullish(),
  costPrice: z.number().min(0).optional(),
  listPrice: z.number().min(0).optional(),
  packaging: z.number().min(0).optional(),
  supplies:  z.number().min(0).optional(),
  stock:     z.number().int().min(0).optional(),
  minStock:  z.number().int().min(0).optional(),
});

async function verifyStoreOwnership(storeId, userId) {
  return prisma.store.findFirst({ where: { id: storeId, userId } });
}

function withAlerts(p) {
  return {
    ...p,
    lowStock: p.stock <= p.minStock,
    variants: p.variants?.map((v) => ({ ...v, lowStock: v.stock <= v.minStock })) ?? [],
  };
}

// GET /api/products — produtos raiz com paginação e busca
// source=ml  → só anúncios ML (externalId não nulo)
// source=catalog → só produtos do catálogo (externalId nulo)
async function list(req, res) {
  const { storeId, search, page = 1, limit = 20, source, mlStatus, noCost } = req.query;

  const andConditions = [];
  if (search) {
    andConditions.push({ OR: [
      { name: { contains: search } },
      { sku:  { contains: search } },
      { productVariants: { some: { OR: [
        { name: { contains: search } },
        { sku:  { contains: search } },
      ] } } },
    ]});
  }
  if (noCost === '1') {
    andConditions.push({ OR: [
      { productVariants: { none: {} }, costPrice: 0 },
      { productVariants: { some: { costPrice: null } } },
    ]});
  }

  const where = {
    parentId: null,
    ...(storeId ? { storeId, store: { userId: req.userId } } : { store: { userId: req.userId } }),
    ...(source === 'ml'      ? { externalId: { not: null } } : {}),
    ...(source === 'catalog' ? { externalId: null } : {}),
    ...(mlStatus ? { mlStatus } : {}),
    ...(andConditions.length ? { AND: andConditions } : {}),
  };

  const { skip, take } = parsePage(page, limit);

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        store:    { select: { name: true, marketplace: true } },
        variants: { orderBy: { name: 'asc' } },
        productVariants: { orderBy: { name: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.product.count({ where }),
  ]);

  // Agrega effectiveRate por produto (últimos 30 dias) quando uma loja está selecionada
  if (storeId && products.length > 0) {
    const allIds = [];
    for (const p of products) {
      allIds.push(p.id);
      for (const v of p.variants) allIds.push(v.id);
    }
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.$queryRaw`
      SELECT productId,
             AVG((calcGmv - calcNetRevenue) / calcGmv * 100) AS productEffectiveRate
      FROM \`Order\`
      WHERE storeId = ${storeId}
        AND productId IN (${Prisma.join(allIds)})
        AND orderCategory NOT IN ('cancelled_unpaid', 'cancelled_other', 'returned_full')
        AND soldAt >= ${cutoff}
        AND calcGmv > 0
      GROUP BY productId
    `;
    const rateMap = new Map(rows.map((r) => [r.productId, parseFloat(r.productEffectiveRate)]));
    for (const p of products) {
      p.productEffectiveRate = rateMap.get(p.id) ?? null;
      for (const v of p.variants) v.productEffectiveRate = rateMap.get(v.id) ?? null;
    }
  }

  return res.json({ products: products.map(withAlerts), total, page: Math.max(1, parseInt(page, 10) || 1), limit: take });
}

// GET /api/products/:id
async function get(req, res) {
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
    include: {
      store:    { select: { name: true, marketplace: true } },
      variants: { orderBy: { name: 'asc' } },
      productVariants: { orderBy: { name: 'asc' } },
    },
  });
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
  return res.json({ product: withAlerts(product) });
}

// POST /api/products — cria produto; aceita campo `variants` para criar variações junto
async function create(req, res) {
  const { variants, ...rest } = req.body;
  const parsed = productSchema.safeParse(rest);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });

  const store = await verifyStoreOwnership(parsed.data.storeId, req.userId);
  if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

  const product = await prisma.product.create({ data: parsed.data });

  if (Array.isArray(variants) && variants.length > 0) {
    const parsedVariants = variants.map((v) => variantSchema.parse(v));
    await prisma.product.createMany({
      data: parsedVariants.map((v) => ({
        storeId:   product.storeId,
        parentId:  product.id,
        name:      v.name,
        sku:       v.sku       ?? null,
        barcode:   v.barcode   ?? null,
        costPrice: v.costPrice ?? 0,
        listPrice: v.listPrice ?? 0,
        packaging: v.packaging ?? 0,
        supplies:  v.supplies  ?? 0,
        stock:     v.stock     ?? 0,
        minStock:  v.minStock  ?? 5,
      })),
    });
  }

  const full = await prisma.product.findUnique({
    where: { id: product.id },
    include: { variants: { orderBy: { name: 'asc' } } },
  });
  return res.status(201).json({ product: withAlerts(full) });
}

// PUT /api/products/:id
async function update(req, res) {
  const existing = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
  });
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

  const parsed = productSchema.omit({ storeId: true }).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });

  const product = await prisma.product.update({
    where:   { id: req.params.id },
    data:    parsed.data,
    include: { variants: { orderBy: { name: 'asc' } } },
  });
  return res.json({ product: withAlerts(product) });
}

// DELETE /api/products/:id
async function remove(req, res) {
  const existing = await prisma.product.findFirst({
    where:   { id: req.params.id, store: { userId: req.userId } },
    include: { variants: { select: { id: true } } },
  });
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

  const ids = [existing.id, ...existing.variants.map((v) => v.id)];
  const orderCount = await prisma.order.count({ where: { productId: { in: ids }, status: 'paid' } });
  if (orderCount > 0) {
    return res.status(409).json({
      error: `Este produto possui ${orderCount} pedido(s) vinculado(s) e não pode ser removido.`,
    });
  }

  await prisma.product.delete({ where: { id: req.params.id } });
  return res.json({ message: 'Produto removido' });
}

// PATCH /api/products/:id/stock
async function adjustStock(req, res) {
  const { quantity, operation } = req.body;
  if (!['add', 'subtract', 'set'].includes(operation))
    return res.status(400).json({ error: 'operation deve ser: add, subtract ou set' });
  if (typeof quantity !== 'number' || quantity < 0)
    return res.status(400).json({ error: 'quantity deve ser um número positivo' });

  const existing = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
  });
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

  let newStock;
  if (operation === 'set') newStock = quantity;
  else if (operation === 'add') newStock = existing.stock + quantity;
  else newStock = Math.max(0, existing.stock - quantity);

  const product = await prisma.product.update({
    where: { id: req.params.id },
    data:  { stock: newStock },
  });
  return res.json({ product, lowStock: product.stock <= product.minStock });
}

// POST /api/products/:id/variants — adiciona variação a produto existente
async function addVariant(req, res) {
  const parent = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId }, parentId: null },
  });
  if (!parent) return res.status(404).json({ error: 'Produto pai não encontrado' });

  const parsed = variantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });

  const variant = await prisma.product.create({
    data: {
      storeId:   parent.storeId,
      parentId:  parent.id,
      name:      parsed.data.name,
      sku:       parsed.data.sku       ?? null,
      barcode:   parsed.data.barcode   ?? null,
      costPrice: parsed.data.costPrice ?? 0,
      listPrice: parsed.data.listPrice ?? parent.listPrice,
      packaging: parsed.data.packaging ?? parent.packaging,
      supplies:  parsed.data.supplies  ?? parent.supplies,
      stock:     parsed.data.stock     ?? 0,
      minStock:  parsed.data.minStock  ?? 5,
    },
  });
  return res.status(201).json({ variant: withAlerts(variant) });
}

// DELETE /api/products/:id/variants/:variantId — remove uma variação
async function removeVariant(req, res) {
  const variant = await prisma.product.findFirst({
    where: {
      id:       req.params.variantId,
      parentId: req.params.id,
      store:    { userId: req.userId },
    },
  });
  if (!variant) return res.status(404).json({ error: 'Variação não encontrada' });

  const orderCount = await prisma.order.count({ where: { productId: variant.id, status: 'paid' } });
  if (orderCount > 0) {
    return res.status(409).json({
      error: `Esta variação possui ${orderCount} pedido(s) vinculado(s) e não pode ser removida.`,
    });
  }

  await prisma.product.delete({ where: { id: variant.id } });
  return res.json({ message: 'Variação removida' });
}

// GET /api/products/stock-report — inteligência de estoque por produto
async function stockReport(req, res) {
  const { storeId } = req.query;

  const storeWhere = { userId: req.userId };
  if (storeId) storeWhere.id = storeId;

  const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true, name: true, marketplace: true } });
  const storeIds = stores.map((s) => s.id);
  if (!storeIds.length) return res.json({ products: [] });

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [allProducts, items30, lastPurchases] = await Promise.all([
    prisma.product.findMany({
      where:   { storeId: { in: storeIds } },
      select:  { id: true, name: true, sku: true, stock: true, minStock: true, costPrice: true, storeId: true, parentId: true, createdAt: true },
      orderBy: { name: 'asc' },
    }),
    prisma.order.findMany({
      where:  { storeId: { in: storeIds }, status: { not: 'cancelled' }, productId: { not: null }, soldAt: { gte: thirtyDaysAgo } },
      select: { productId: true, quantity: true },
    }),
    prisma.purchaseOrderItem.findMany({
      where:   { purchaseOrder: { userId: req.userId, status: 'delivered' } },
      select:  { productId: true, purchaseOrder: { select: { receivedAt: true } } },
      orderBy: { purchaseOrder: { receivedAt: 'desc' } },
    }),
  ]);

  const sales30ByPid   = {};
  for (const it of items30) {
    sales30ByPid[it.productId] = (sales30ByPid[it.productId] ?? 0) + it.quantity;
  }

  const lastReceiptByPid = {};
  for (const it of lastPurchases) {
    if (!lastReceiptByPid[it.productId]) {
      lastReceiptByPid[it.productId] = it.purchaseOrder.receivedAt;
    }
  }

  const storeById = Object.fromEntries(stores.map((s) => [s.id, s]));

  const products = allProducts.map((p) => {
    const sales30     = sales30ByPid[p.id] ?? 0;
    const salesPerDay = sales30 / 30;
    const daysRem     = salesPerDay > 0 ? p.stock / salesPerDay : null;
    const suggested   = salesPerDay > 0 ? Math.max(0, Math.round(salesPerDay * 60 - p.stock)) : 0;
    const store       = storeById[p.storeId];
    return {
      id:              p.id,
      name:            p.name,
      sku:             p.sku ?? '',
      stock:           p.stock,
      minStock:        p.minStock,
      costPrice:       p.costPrice,
      storeId:         p.storeId,
      storeName:       store?.name ?? '',
      marketplace:     store?.marketplace ?? '',
      isVariant:       !!p.parentId,
      salesLast30:     sales30,
      salesPerDay:     parseFloat(salesPerDay.toFixed(3)),
      daysRemaining:   daysRem !== null ? parseFloat(daysRem.toFixed(1)) : null,
      suggestedReorder: suggested,
      lastReceivedAt:  lastReceiptByPid[p.id] ?? null,
      createdAt:       p.createdAt,
    };
  });

  // Ordena: críticos (< 15 dias) → atenção (15-30) → ok → sem movimento → sem estoque/venda
  products.sort((a, b) => {
    const urgA = a.daysRemaining !== null ? a.daysRemaining : 9999;
    const urgB = b.daysRemaining !== null ? b.daysRemaining : 9999;
    return urgA - urgB;
  });

  const totals = {
    total:      products.length,
    critical:   products.filter((p) => p.daysRemaining !== null && p.daysRemaining < 15).length,
    warning:    products.filter((p) => p.daysRemaining !== null && p.daysRemaining >= 15 && p.daysRemaining < 30).length,
    ok:         products.filter((p) => p.daysRemaining !== null && p.daysRemaining >= 30).length,
    noMovement: products.filter((p) => p.daysRemaining === null).length,
  };

  return res.json({ products, totals });
}

// GET /api/products/export-pdf?storeId=X
async function exportPdf(req, res) {
  try {
    const { storeId } = req.query;

    const where = {
      parentId:  null,
      listPrice: { gt: 0 },
      costPrice: { gt: 0 },
      ...(storeId
        ? { storeId, store: { userId: req.userId } }
        : { store: { userId: req.userId } }),
    };

    const products = await prisma.product.findMany({
      where,
      include: { store: true, variants: { orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' },
    });

    // Pré-busca a última StoreRate de cada loja envolvida
    const storeIds = [...new Set(products.map((p) => p.storeId))];
    const latestRatesArr = await Promise.all(
      storeIds.map((sid) =>
        prisma.storeRate.findFirst({
          where:   { storeId: sid },
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
        }).then((r) => [sid, r])
      )
    );
    const latestRateMap = new Map(latestRatesArr);

    // ── helpers ───────────────────────────────────────────────────────────────
    const brl = (n) => 'R$' + Math.abs(parseFloat(n)).toFixed(2).replace('.', ',');
    const neg = (v, label) => label; // negativo indicado apenas por negrito

    function calcDescontos(sp, product, store) {
      if (!sp || sp <= 0 || !product.costPrice || product.costPrice <= 0) return null;
      const mp    = (store.marketplace ?? '').toLowerCase();
      let commissionPct, fixedFee;
      if (mp === 'shopee') {
        const r = getShopeeRates(sp);
        commissionPct = r.commissionPct;
        fixedFee      = r.fixedFee;
      } else {
        const latestRate = latestRateMap.get(store.id);
        commissionPct = latestRate ? parseFloat(latestRate.avgCommissionRate) : 0;
        fixedFee      = 0;
      }
      const comissao  = sp * (commissionPct / 100);
      const imposto   = sp * ((store.taxRate ?? 0) / 100);
      const embalagem = parseFloat(product.packaging || 0);
      const totalDesc = comissao + fixedFee + imposto + embalagem;
      const lucro     = sp - parseFloat(product.costPrice) - totalDesc;
      const margem    = sp > 0 ? (lucro / sp) * 100 : 0;
      return { totalDesc, lucro, margem };
    }

    let totalItems = 0;
    for (const p of products) totalItems += p.variants.length > 0 ? p.variants.length : 1;

    // ── layout ────────────────────────────────────────────────────────────────
    const MARGIN  = Math.round(10 * 2.8346); // 10 mm → 28 pt
    const FOOTER  = 16;  // footer band height
    const HDR_H   = 14;  // table-header row
    const ROW_H   = 12;  // minimum data-row height
    const PAD_V   = 2;   // vertical cell padding
    const PAD_H   = 3;   // horizontal cell padding
    const FONT_D  = 7.5; // data font
    const FONT_H  = 8;   // header font

    // Columns — total 786 pt to fill A4-landscape minus 2×28 margins
    const COLS = [
      { label: '#',           w: 23,  align: 'center' },
      { label: 'PRODUTO',     w: 384, align: 'left'   },
      { label: 'VL.VENDA',    w: 62,  align: 'right'  },
      { label: 'CUSTO PROD.', w: 62,  align: 'right'  },
      { label: 'DESCONTOS',   w: 85,  align: 'right'  },
      { label: 'LUCRO LÍQ.',  w: 62,  align: 'right'  },
      { label: 'MARGEM',      w: 57,  align: 'right'  },
      { label: 'ESTOQUE',     w: 51,  align: 'right'  },
    ];

    const colX = [];
    let _cx = MARGIN;
    for (const c of COLS) { colX.push(_cx); _cx += c.w; }
    const TW = _cx - MARGIN; // table width (786)

    // ── PDF doc ───────────────────────────────────────────────────────────────
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
      autoFirstPage: true,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="produtos.pdf"');
    doc.pipe(res);

    const PW = doc.page.width;  // 841.89
    const PH = doc.page.height; // 595.28
    let Y = MARGIN;
    let rowParity = 0; // for alternating row colour

    // ── document header (first page only) ────────────────────────────────────
    const now     = new Date();
    const dateFmt = now.toLocaleDateString('pt-BR') + ' ' + now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000')
       .text('Lista de Produtos — EcomZero Hub', MARGIN, Y, { lineBreak: false });
    Y += 14;
    doc.font('Helvetica').fontSize(8).fillColor('#666666')
       .text(
         `Emitido em: ${dateFmt}  |  ${totalItems} produto(s)  |  ` +
         '* DESCONTOS = Embalagem + Imposto + Tx. Shopee + Taxa fixa',
         MARGIN, Y, { width: TW, lineBreak: false, ellipsis: true },
       );
    Y += 13;

    // ── table header ─────────────────────────────────────────────────────────
    function tableHeader() {
      doc.rect(MARGIN, Y, TW, HDR_H).fill('#222222');
      doc.font('Helvetica-Bold').fontSize(FONT_H).fillColor('#ffffff');
      for (let i = 0; i < COLS.length; i++) {
        doc.text(COLS[i].label, colX[i] + PAD_H, Y + PAD_V, {
          width: COLS[i].w - PAD_H * 2, align: COLS[i].align, lineBreak: false,
        });
      }
      Y += HDR_H;
      // 1 pt black rule below header
      doc.moveTo(MARGIN, Y).lineTo(MARGIN + TW, Y).lineWidth(1).strokeColor('#000000').stroke();
    }

    tableHeader();

    // ── grid lines for one row ────────────────────────────────────────────────
    function grid(y, h) {
      // horizontal bottom
      doc.moveTo(MARGIN, y + h).lineTo(MARGIN + TW, y + h)
         .lineWidth(0.25).strokeColor('#cccccc').stroke();
      // vertical column separators
      for (let i = 1; i < COLS.length; i++) {
        doc.moveTo(colX[i], y).lineTo(colX[i], y + h)
           .lineWidth(0.25).strokeColor('#cccccc').stroke();
      }
    }

    // ── page-break guard ──────────────────────────────────────────────────────
    function guard(need) {
      if (Y + need > PH - MARGIN - FOOTER) {
        doc.addPage();
        Y = MARGIN;
        tableHeader();
        rowParity = 0;
      }
    }

    // ── text helper: write a cell ─────────────────────────────────────────────
    function cell(i, rowY, txt, { fs = FONT_D, bold = false, color = '#000000', align } = {}) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
         .fontSize(fs).fillColor(color)
         .text(String(txt ?? '—'), colX[i] + PAD_H, rowY + PAD_V, {
           width: COLS[i].w - PAD_H * 2,
           align: align ?? COLS[i].align,
           lineBreak: false,
           ellipsis: true,
         });
    }

    // ── TIPO 1: produto pai com variações ─────────────────────────────────────
    function parentRow(p) {
      guard(1 + ROW_H);
      // 0.5 pt divider above
      doc.moveTo(MARGIN, Y).lineTo(MARGIN + TW, Y).lineWidth(0.5).strokeColor('#888888').stroke();
      Y += 1;

      const y = Y;
      const totalStock = p.variants.reduce((s, v) => s + (v.stock ?? 0), 0);
      doc.rect(MARGIN, y, TW, ROW_H).fill('#e8e8e8');
      doc.font('Helvetica-Bold').fontSize(FONT_H).fillColor('#000000');
      // PRODUTO (col 1) — bold name
      doc.text(p.name, colX[1] + PAD_H, y + PAD_V, {
        width: COLS[1].w - PAD_H * 2, align: 'left', lineBreak: false, ellipsis: true,
      });
      // cols 2-6: em-dash
      for (let i = 2; i <= 6; i++) {
        doc.text('—', colX[i] + PAD_H, y + PAD_V, {
          width: COLS[i].w - PAD_H * 2, align: COLS[i].align, lineBreak: false,
        });
      }
      // ESTOQUE: "X.XXX total"
      doc.text(totalStock.toLocaleString('pt-BR') + ' total', colX[7] + PAD_H, y + PAD_V, {
        width: COLS[7].w - PAD_H * 2, align: 'right', lineBreak: false,
      });
      grid(y, ROW_H);
      Y += ROW_H;
    }

    // ── TIPO 2: produto simples ou variação ───────────────────────────────────
    function dataRow(p, store, num, isVariant, parentP) {
      guard(ROW_H);
      const y  = Y;
      const bg = rowParity++ % 2 === 0 ? '#ffffff' : '#f5f5f5';

      const noCost = !p.costPrice || p.costPrice <= 0;
      const sp     = parseFloat(p.listPrice) > 0 ? parseFloat(p.listPrice)
                   : (parentP && parseFloat(parentP.listPrice) > 0 ? parseFloat(parentP.listPrice) : null);
      const effP   = {
        ...p,
        listPrice: sp || 0,
        packaging: parseFloat(p.packaging) > 0 ? parseFloat(p.packaging)
                 : parseFloat(parentP?.packaging || 0),
      };
      const calc = sp && !noCost ? calcDescontos(sp, effP, store) : null;

      doc.rect(MARGIN, y, TW, ROW_H).fill(bg);

      // #
      cell(0, y, num);

      // PRODUTO — indent 2 spaces for variants, reduce font for long names
      const nameStr = isVariant ? '  ' + p.name : p.name;
      const nameFs  = nameStr.length > 60 ? 7 : FONT_D;
      cell(1, y, nameStr, { fs: nameFs });

      // PREÇO VENDA
      cell(2, y, sp ? brl(sp) : '—');

      // CUSTO PROD.
      cell(3, y, noCost ? '—' : brl(p.costPrice));

      // DESCONTOS
      cell(4, y, calc ? `-${brl(calc.totalDesc)}` : '—');

      // LUCRO LÍQ.
      if (calc) {
        const negL = calc.lucro < 0;
        cell(5, y, neg(calc.lucro, brl(calc.lucro)), { bold: negL });
      } else {
        cell(5, y, '—');
      }

      // MARGEM
      if (calc) {
        const negM = calc.margem < 0;
        const mStr = Math.abs(calc.margem).toFixed(1) + '%';
        cell(6, y, neg(calc.margem, mStr), { bold: negM });
      } else {
        cell(6, y, '—');
      }

      // ESTOQUE
      cell(7, y, p.stock ?? 0);

      grid(y, ROW_H);
      Y += ROW_H;
    }

    // ── render all products ───────────────────────────────────────────────────
    let seq = 0;
    for (const p of products) {
      if (p.variants.length === 0) {
        seq++;
        dataRow(p, p.store, seq, false, null);
      } else {
        parentRow(p);
        for (const v of p.variants) {
          seq++;
          dataRow(v, p.store, seq, true, p);
        }
      }
    }

    // ── legend (last page, below table) ──────────────────────────────────────
    guard(16);
    Y += 4;
    doc.moveTo(MARGIN, Y).lineTo(MARGIN + TW, Y).lineWidth(0.25).strokeColor('#cccccc').stroke();
    Y += 4;
    doc.font('Helvetica').fontSize(7).fillColor('#666666')
       .text('Negrito = Margem negativa  |  — = Sem custo cadastrado', MARGIN, Y, { lineBreak: false });

    // ── page footers — "Página X de Y" ───────────────────────────────────────
    // Must zero doc.page.margins.bottom before writing inside the margin band,
    // otherwise PDFKit auto-creates a new page (root cause of the blank pages).
    const range = doc.bufferedPageRange();
    const nPages = range.count;
    const footerY = PH - MARGIN + 4;

    for (let i = 0; i < nPages; i++) {
      doc.switchToPage(i);
      const saved = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7).fillColor('#888888')
         .text(`Página ${i + 1} de ${nPages}`, MARGIN, footerY, {
           width: TW, align: 'right', lineBreak: false,
         });
      doc.page.margins.bottom = saved;
    }

    doc.end();
  } catch (err) {
    console.error('exportPdf error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erro ao gerar PDF' });
  }
}

// PATCH /api/products/by-sku — define custo pelo SKU (para produtos sem productId no fechamento)
async function setCostBySku(req, res) {
  try {
    const { sku, productName, costPrice, packaging, storeId } = req.body;
    if (!sku) return res.status(400).json({ error: 'SKU obrigatório' });

    const storeWhere = { userId: req.userId };
    if (storeId) storeWhere.id = storeId;
    const stores   = await prisma.store.findMany({ where: storeWhere, select: { id: true } });
    const storeIds = stores.map(s => s.id);
    if (!storeIds.length) return res.status(404).json({ error: 'Loja não encontrada' });

    const cost = parseFloat(costPrice || 0);
    const pkg  = parseFloat(packaging  || 0);

    // 1. Buscar produto pelo SKU
    let product = await prisma.product.findFirst({
      where: { storeId: { in: storeIds }, sku },
    });

    // Fallback: SKU pode ser de uma variação (anúncio Shopee agrupado pelo SKU raiz)
    let matchedVariantId = null;
    if (!product) {
      const variant = await prisma.productVariant.findFirst({
        where: { sku, product: { storeId: { in: storeIds } } },
        include: { product: true },
      });
      if (variant) {
        product = variant.product;
        matchedVariantId = variant.id;
      }
    }

    if (product) {
      // Atualizar custo no produto existente
      product = await prisma.product.update({
        where: { id: product.id },
        data:  { costPrice: cost, packaging: pkg },
      });
    } else {
      // Produto não existe — buscar storeId do pedido para criar
      const sampleOrder = await prisma.order.findFirst({
        where: {
          storeId: { in: storeIds },
          OR: [{ skuVariacao: sku }, { skuPrincipal: sku }],
        },
        select: { storeId: true },
      });
      const targetStoreId = sampleOrder?.storeId ?? storeIds[0];

      product = await prisma.product.create({
        data: {
          storeId:   targetStoreId,
          sku,
          name:      productName || sku,
          costPrice: cost,
          packaging: pkg,
          listPrice: 0,
          supplies:  0,
          stock:     0,
          minStock:  5,
        },
      });
    }

    // 2. Linkar pedidos órfãos (sem productId) ao produto pelo SKU
    const linked = await prisma.order.updateMany({
      where: {
        storeId:   { in: storeIds },
        productId: null,
        OR: [{ skuVariacao: sku }, { skuPrincipal: sku }],
      },
      data: { productId: product.id, ...(matchedVariantId ? { variantId: matchedVariantId } : {}) },
    });

    return res.json({ success: true, productId: product.id, linkedOrders: linked.count });
  } catch (err) {
    console.error('setCostBySku error:', err);
    return res.status(500).json({ error: 'Erro ao salvar custo' });
  }
}

// GET /api/products/search-cost?q=nome — busca produtos COM custo em todas as lojas do usuário
// Usado para copiar custo de produto de outra loja (ex: ML → Shopee)
async function searchWithCost(req, res) {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ products: [] });

  const words = q.trim().split(/\s+/).filter(w => w.length >= 3).slice(0, 4);

  const products = await prisma.product.findMany({
    where: {
      store:     { userId: req.userId },
      costPrice: { gt: 0 },
      OR: words.map(w => ({ name: { contains: w } })),
    },
    include: { store: { select: { name: true, marketplace: true } } },
    orderBy: { costPrice: 'desc' },
    take: 8,
  });

  return res.json({
    products: products.map(p => ({
      id:          p.id,
      name:        p.name,
      sku:         p.sku,
      costPrice:   p.costPrice,
      packaging:   p.packaging,
      storeName:   p.store?.name,
      marketplace: p.store?.marketplace,
    })),
  });
}

// PATCH /api/products/:id/save-and-recalc — salva custo E recalcula pedidos do produto imediatamente
// Usado no Fechamento Mensal — sem job queue, resultado síncrono
async function saveAndRecalc(req, res) {
  try {
    const { costPrice, packaging } = req.body;
    const productId = req.params.id;

    const product = await prisma.product.findFirst({
      where: { id: productId, store: { userId: req.userId } },
      include: { store: { select: { taxRate: true, marketplace: true } } },
    });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

    // 1. Atualizar custo
    await prisma.product.update({
      where: { id: productId },
      data: { costPrice: parseFloat(costPrice || 0), packaging: parseFloat(packaging || 0) },
    });

    const cost = parseFloat(costPrice || 0);
    const pkg  = parseFloat(packaging  || 0);
    // calcOrderProfit importado no topo do arquivo

    // 2. Buscar todos os pedidos vinculados a este produto
    const orders = await prisma.order.findMany({
      where: { productId },
      select: { id: true, agreedPrice: true, quantity: true, sellerCoupon: true, lmmDiscount: true, orderCategory: true, platformCommission: true, listingType: true, mlShippingCost: true, mlInstallmentFee: true },
    });

    // 3. Recalcular cada pedido
    const marketplace  = product.store?.marketplace ?? 'shopee';
    const taxRate      = product.store?.taxRate ?? 0;
    const updates = orders.map(o => {
      const isRevenue = ['valid', 'pending', 'returned_partial'].includes(o.orderCategory);
      // Para ML: precomputedFee = comissão + frete vendedor + taxa de parcelamento
      const mlFrete        = o.mlShippingCost   ?? 0;
      const mlParcelamento = o.mlInstallmentFee ?? 0;
      const precomputedFee = marketplace === 'mercadolivre'
        ? Math.round(((o.platformCommission ?? 0) + mlFrete + mlParcelamento) * 100) / 100
        : null;
      const calc = calcOrderProfit({
        agreedPrice:   o.agreedPrice,
        quantity:      o.quantity,
        sellerCoupon:  o.sellerCoupon,
        lmmDiscount:   o.lmmDiscount,
        costPrice:     cost,
        packagingCost: pkg,
        taxRate,
        marketplace,
        precomputedFee,
        listingType:   o.listingType,
      });
      const finalProfit = isRevenue ? calc.grossProfit : 0;
      const finalMargin = isRevenue ? calc.margin      : 0;
      return prisma.order.update({
        where: { id: o.id },
        data: {
          calcGmv:         calc.gmv,
          calcShopeeFee:   calc.marketplaceFee,
          calcNetRevenue:  calc.netRevenue,
          calcTax:         calc.taxAmount,
          calcProductCost: calc.productCost,
          calcPackaging:   calc.packaging,
          calcGrossProfit: finalProfit,
          calcMargin:      finalMargin,
          hasCost:         calc.hasCost,
          profit:          finalProfit,
          margin:          finalMargin,
        },
      });
    });

    await Promise.all(updates);

    return res.json({ success: true, updated: updates.length, costPrice: cost, packaging: pkg });
  } catch (err) {
    console.error('saveAndRecalc error:', err);
    return res.status(500).json({ error: 'Erro ao salvar custo: ' + err.message });
  }
}

// PATCH /api/products/:id/variants/:variantId/cost — salva custo de 1 variação (ou de todas) e recalcula pedidos vinculados
async function updateVariantCost(req, res) {
  try {
    const { id: productId, variantId } = req.params;
    const { costPrice, applyToAll } = req.body;

    const product = await prisma.product.findFirst({
      where: { id: productId, store: { userId: req.userId } },
      include: {
        store: { select: { taxRate: true, marketplace: true } },
        productVariants: true,
      },
    });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

    const variant = product.productVariants.find(v => v.id === variantId);
    if (!variant) return res.status(404).json({ error: 'Variação não encontrada' });

    const cost = (costPrice === '' || costPrice === null || costPrice === undefined) ? null : parseFloat(costPrice);

    const targetIds = applyToAll ? product.productVariants.map(v => v.id) : [variantId];
    await prisma.productVariant.updateMany({ where: { id: { in: targetIds } }, data: { costPrice: cost } });

    // Recalcular pedidos vinculados às variações alteradas
    const orders = await prisma.order.findMany({
      where: { variantId: { in: targetIds } },
      select: { id: true, agreedPrice: true, quantity: true, sellerCoupon: true, lmmDiscount: true, orderCategory: true, platformCommission: true, listingType: true, mlShippingCost: true, mlInstallmentFee: true },
    });

    const marketplace   = product.store?.marketplace ?? 'shopee';
    const taxRate       = product.store?.taxRate ?? 0;
    const effectiveCost = cost ?? product.costPrice ?? 0;
    const pkg           = product.packaging ?? 0;

    const updates = orders.map(o => {
      const isRevenue = ['valid', 'pending', 'returned_partial'].includes(o.orderCategory);
      const mlFrete        = o.mlShippingCost   ?? 0;
      const mlParcelamento = o.mlInstallmentFee ?? 0;
      const precomputedFee = marketplace === 'mercadolivre'
        ? Math.round(((o.platformCommission ?? 0) + mlFrete + mlParcelamento) * 100) / 100
        : null;
      const calc = calcOrderProfit({
        agreedPrice:   o.agreedPrice,
        quantity:      o.quantity,
        sellerCoupon:  o.sellerCoupon,
        lmmDiscount:   o.lmmDiscount,
        costPrice:     effectiveCost,
        packagingCost: pkg,
        taxRate,
        marketplace,
        precomputedFee,
        listingType:   o.listingType,
      });
      const finalProfit = isRevenue ? calc.grossProfit : 0;
      const finalMargin = isRevenue ? calc.margin      : 0;
      return prisma.order.update({
        where: { id: o.id },
        data: {
          calcGmv:         calc.gmv,
          calcShopeeFee:   calc.marketplaceFee,
          calcNetRevenue:  calc.netRevenue,
          calcTax:         calc.taxAmount,
          calcProductCost: calc.productCost,
          calcPackaging:   calc.packaging,
          calcGrossProfit: finalProfit,
          calcMargin:      finalMargin,
          hasCost:         calc.hasCost,
          profit:          finalProfit,
          margin:          finalMargin,
        },
      });
    });

    await Promise.all(updates);

    return res.json({
      success: true,
      updated: updates.length,
      variantsUpdated: targetIds.length,
      appliedToAll: !!applyToAll,
      costPrice: cost,
    });
  } catch (err) {
    console.error('updateVariantCost error:', err);
    return res.status(500).json({ error: 'Erro ao salvar custo da variação: ' + err.message });
  }
}

// GET /api/products/stats — contagens de margem para o Dashboard (sem paginação)
async function getProductStats(req, res) {
  const { storeId } = req.query;
  const { r2 } = require('../lib/utils');

  const products = await prisma.product.findMany({
    where: {
      parentId: null,
      store: { userId: req.userId },
      ...(storeId ? { storeId } : {}),
    },
    select: {
      id: true,
      costPrice: true,
      listPrice: true,
      store: { select: { taxRate: true, sellerType: true, pfgEnabled: true, marketplace: true } },
      productVariants: { select: { costPrice: true, price: true } },
    },
  });

  let totalCount = 0, noCostCount = 0, atRiskCount = 0;
  let marginSum = 0, marginCount = 0;

  for (const p of products) {
    totalCount++;
    const mp = (p.store?.marketplace ?? 'shopee').toLowerCase();
    const taxRate = p.store?.taxRate ?? 0;
    const pfgEnabled = p.store?.pfgEnabled ?? false;
    const sellerType = p.store?.sellerType ?? 'cnpj';

    let commissionPct = 0, fixedFee = 0;
    if (mp === 'shopee') {
      commissionPct = 14 + (pfgEnabled ? 6 : 0);
      fixedFee = sellerType === 'cnpj' ? 4 : 7;
    } else if (mp === 'mercadolivre') {
      commissionPct = 12; fixedFee = 0;
    }

    const items = p.productVariants?.length
      ? p.productVariants
          .filter(v => (v.costPrice ?? 0) > 0 && (v.price ?? 0) > 0)
          .map(v => {
            const profit = v.price - r2(v.price * commissionPct / 100) - fixedFee - r2(v.price * taxRate / 100) - v.costPrice;
            return (profit / v.price) * 100;
          })
      : [];

    let margin = null;
    if (items.length > 0) {
      margin = Math.min(...items);
    } else if ((p.costPrice ?? 0) > 0 && (p.listPrice ?? 0) > 0) {
      const profit = p.listPrice - r2(p.listPrice * commissionPct / 100) - fixedFee - r2(p.listPrice * taxRate / 100) - p.costPrice;
      margin = (profit / p.listPrice) * 100;
    }

    if (margin === null) {
      noCostCount++;
      continue;
    }

    marginSum += margin;
    marginCount++;

    const score = margin >= 25 ? 'healthy' : margin >= 15 ? 'warning' : margin >= 10 ? 'risk' : 'loss';
    if (score === 'risk' || score === 'loss') atRiskCount++;
  }

  return res.json({
    totalCount,
    noCostCount,
    atRiskCount,
    avgMargin: marginCount > 0 ? r2(marginSum / marginCount) : null,
    hasEnoughData: marginCount >= 5,
  });
}

// GET /api/products/:id/components
async function getComponents(req, res) {
  const product = await prisma.product.findFirst({
    where: { id: req.params.id, store: { userId: req.userId } },
    select: { id: true },
  });
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

  const components = await prisma.productComponent.findMany({
    where: { productId: req.params.id },
    include: { baseProduct: { select: { id: true, name: true, sku: true, stock: true } } },
  });
  return res.json({ components });
}

// POST /api/products/:id/components
// Body: { components: [{ baseProductId, quantity }] }
async function setComponents(req, res) {
  const productId = req.params.id;

  const product = await prisma.product.findFirst({
    where: { id: productId, store: { userId: req.userId } },
    select: { id: true, storeId: true },
  });
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

  const { components } = req.body;
  if (!Array.isArray(components)) return res.status(400).json({ error: 'components deve ser um array' });

  if (components.length > 0) {
    // Verificar que cada baseProductId pertence ao mesmo userId
    const baseIds = components.map(c => c.baseProductId);
    const validBases = await prisma.product.findMany({
      where: { id: { in: baseIds }, store: { userId: req.userId } },
      select: { id: true },
    });
    const validBaseIds = new Set(validBases.map(p => p.id));
    const invalid = baseIds.filter(id => !validBaseIds.has(id));
    if (invalid.length > 0) {
      return res.status(403).json({ error: 'Um ou mais produtos base não pertencem ao usuário', invalid });
    }

    await prisma.$transaction([
      prisma.productComponent.deleteMany({ where: { productId } }),
      prisma.productComponent.createMany({
        data: components.map(c => ({ productId, baseProductId: c.baseProductId, quantity: c.quantity ?? 1 })),
      }),
    ]);
  } else {
    // Array vazio: apenas deletar, não chamar createMany com array vazio
    await prisma.productComponent.deleteMany({ where: { productId } });
  }

  const updated = await prisma.productComponent.findMany({
    where: { productId },
    include: { baseProduct: { select: { id: true, name: true, sku: true, stock: true } } },
  });
  return res.json({ components: updated });
}

// GET /api/products/:id/variants/:variantId/components
async function getVariantComponents(req, res) {
  const variant = await prisma.productVariant.findFirst({
    where: { id: req.params.variantId, product: { store: { userId: req.userId } } },
  });
  if (!variant) return res.status(404).json({ error: 'Variação não encontrada' });

  const components = await prisma.productVariantComponent.findMany({
    where: { variantId: req.params.variantId },
    include: {
      baseProduct: { select: { id: true, name: true, sku: true, stock: true, costPrice: true } },
    },
    orderBy: { baseProduct: { name: 'asc' } },
  });
  return res.json({ components });
}

// POST /api/products/:id/variants/:variantId/components
// Body: { components: [{ baseProductId, quantity }] }
async function setVariantComponents(req, res) {
  const { variantId } = req.params;
  const { components = [] } = req.body;

  const variant = await prisma.productVariant.findFirst({
    where: { id: variantId, product: { store: { userId: req.userId } } },
  });
  if (!variant) return res.status(404).json({ error: 'Variação não encontrada' });

  if (components.length > 0) {
    const baseIds = components.map(c => c.baseProductId);
    const valid = await prisma.product.count({
      where: { id: { in: baseIds }, store: { userId: req.userId } },
    });
    if (valid !== baseIds.length) {
      return res.status(400).json({ error: 'Um ou mais produtos base inválidos' });
    }
  }

  await prisma.$transaction([
    prisma.productVariantComponent.deleteMany({ where: { variantId } }),
    ...(components.length > 0 ? [prisma.productVariantComponent.createMany({
      data: components.map(c => ({
        variantId,
        baseProductId: c.baseProductId,
        quantity: parseInt(c.quantity) || 1,
      })),
    })] : []),
  ]);

  return res.json({ ok: true });
}

// PATCH /api/products/:id/mark-base
// Body: { isBase: boolean }
async function markAsBase(req, res) {
  const productId = req.params.id;

  const existing = await prisma.product.findFirst({
    where: { id: productId, store: { userId: req.userId } },
    select: { id: true },
  });
  if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

  const { isBase } = req.body;
  const product = await prisma.product.update({
    where: { id: productId },
    data: { isBase: !!isBase },
  });
  return res.json({ product });
}

module.exports = { list, get, create, update, remove, adjustStock, addVariant, removeVariant, stockReport, exportPdf, setCostBySku, searchWithCost, saveAndRecalc, updateVariantCost, getProductStats, getComponents, setComponents, markAsBase, getVariantComponents, setVariantComponents };
