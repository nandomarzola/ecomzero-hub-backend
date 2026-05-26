const PDFDocument = require('pdfkit');

const BRAND_GREEN = '#16a34a';
const GRAY_DARK   = '#111827';
const GRAY_MID    = '#374151';
const GRAY_LIGHT  = '#6b7280';
const PAGE_W      = 595 - 80; // A4 width minus margins (40 each side)

function formatBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
}

function formatPct(v) {
  return `${Number(v || 0).toFixed(1)}%`;
}

// Draws a filled rounded rectangle (PDFKit doesn't have roundedRect natively)
function filledRect(doc, x, y, w, h, color) {
  doc.rect(x, y, w, h).fillColor(color).fill();
}

// Single horizontal rule
function rule(doc, y, color = '#e5e7eb') {
  doc.moveTo(40, y).lineTo(555, y).strokeColor(color).lineWidth(0.5).stroke();
}

async function generateMonthlyReport(store, summary, period) {
  return new Promise((resolve, reject) => {
    const doc     = new PDFDocument({ margin: 40, size: 'A4' });
    const buffers = [];

    doc.on('data',  (chunk) => buffers.push(chunk));
    doc.on('end',   () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // ── CABEÇALHO ────────────────────────────────────────────────────
    filledRect(doc, 0, 0, 595, 95, '#0f172a');

    doc.fontSize(24).font('Helvetica-Bold').fillColor('#4ade80')
       .text('ProfitTrack', 40, 28);
    doc.fontSize(11).font('Helvetica').fillColor('#94a3b8')
       .text(`Relatório mensal — ${store.name}`, 40, 58);
    doc.text(`Período: ${period}  ·  Marketplace: ${store.marketplace}`, 40, 74);

    let y = 115;

    // ── 4 CARDS DE RESUMO ────────────────────────────────────────────
    const cards = [
      {
        label: 'Faturamento bruto',
        value: formatBRL(summary.totalRevenue),
        bg: '#dbeafe', accent: '#1d4ed8',
      },
      {
        label: 'Lucro líquido',
        value: formatBRL(summary.totalProfit),
        bg: summary.totalProfit >= 0 ? '#dcfce7' : '#fee2e2',
        accent: summary.totalProfit >= 0 ? BRAND_GREEN : '#dc2626',
      },
      {
        label: 'Margem média',
        value: formatPct(summary.avgMargin),
        bg: summary.avgMargin >= 10 ? '#dcfce7' : '#fef9c3',
        accent: summary.avgMargin >= 10 ? BRAND_GREEN : '#ca8a04',
      },
      {
        label: 'Total de pedidos',
        value: String(summary.totalOrders),
        bg: '#f3f4f6', accent: '#374151',
      },
    ];

    const cardW = 122;
    const cardH = 68;
    cards.forEach((card, i) => {
      const cx = 40 + i * (cardW + 6);
      filledRect(doc, cx, y, cardW, cardH, card.bg);
      doc.fillColor(card.accent).fontSize(8).font('Helvetica-Bold')
         .text(card.label.toUpperCase(), cx + 8, y + 10, { width: cardW - 16 });
      doc.fillColor(GRAY_DARK).fontSize(15).font('Helvetica-Bold')
         .text(card.value, cx + 8, y + 26, { width: cardW - 16 });
      doc.font('Helvetica');
    });

    y += cardH + 24;
    rule(doc, y);
    y += 14;

    // ── TABELA DE DESEMPENHO POR PRODUTO ────────────────────────────
    doc.fillColor(GRAY_DARK).fontSize(13).font('Helvetica-Bold')
       .text('Desempenho por produto', 40, y);
    y += 18;

    const cols = [
      { label: 'Produto',   x: 40,  w: 210 },
      { label: 'Qtd',       x: 258, w: 40  },
      { label: 'Receita',   x: 306, w: 80  },
      { label: 'Custo',     x: 390, w: 72  },
      { label: 'Lucro',     x: 466, w: 64  },
      { label: 'Margem',    x: 535, w: 45  },
    ];

    // Header row
    filledRect(doc, 40, y, PAGE_W, 20, '#f1f5f9');
    doc.fillColor(GRAY_LIGHT).fontSize(8).font('Helvetica-Bold');
    cols.forEach((c) => doc.text(c.label, c.x, y + 6, { width: c.w }));
    y += 22;

    const topProducts = (summary.topProducts || []).slice(0, 18);
    topProducts.forEach((p, idx) => {
      if (y > 730) {
        doc.addPage();
        y = 40;
        // re-draw header on new page
        filledRect(doc, 40, y, PAGE_W, 20, '#f1f5f9');
        doc.fillColor(GRAY_LIGHT).fontSize(8).font('Helvetica-Bold');
        cols.forEach((c) => doc.text(c.label, c.x, y + 6, { width: c.w }));
        y += 22;
      }

      const rowBg = p.margin < 0
        ? '#fff1f2'
        : idx % 2 === 0 ? '#ffffff' : '#f9fafb';

      filledRect(doc, 40, y, PAGE_W, 18, rowBg);
      doc.fillColor(GRAY_DARK).fontSize(8).font('Helvetica');

      const name = (p.name || '').length > 32 ? p.name.substring(0, 30) + '…' : p.name;
      doc.text(name,                        cols[0].x, y + 4, { width: cols[0].w });
      doc.text(String(p.quantity || 0),     cols[1].x, y + 4, { width: cols[1].w });
      doc.text(formatBRL(p.revenue ?? p.profit + (p.cogs ?? 0)), cols[2].x, y + 4, { width: cols[2].w });
      doc.fillColor(GRAY_MID)
         .text(formatBRL(p.cogs ?? 0),      cols[3].x, y + 4, { width: cols[3].w });
      doc.fillColor(p.profit < 0 ? '#dc2626' : BRAND_GREEN)
         .text(formatBRL(p.profit),         cols[4].x, y + 4, { width: cols[4].w });
      doc.fillColor(p.margin < 0 ? '#dc2626' : GRAY_MID)
         .text(formatPct(p.margin),         cols[5].x, y + 4, { width: cols[5].w });
      y += 20;
    });

    if (!topProducts.length) {
      doc.fillColor(GRAY_LIGHT).fontSize(9).font('Helvetica')
         .text('Nenhum pedido no período.', 40, y + 6);
      y += 22;
    }

    // ── GRÁFICO DE BARRAS — top 5 produtos ─────────────────────────
    y += 16;
    if (y > 650) { doc.addPage(); y = 40; }
    rule(doc, y);
    y += 14;

    doc.fillColor(GRAY_DARK).fontSize(13).font('Helvetica-Bold')
       .text('Top 5 produtos por lucro', 40, y);
    y += 18;

    const top5 = (summary.topProducts || []).filter((p) => p.profit > 0).slice(0, 5);
    if (top5.length) {
      const maxProfit = Math.max(...top5.map((p) => p.profit));
      const barAreaW  = PAGE_W - 10;
      const barH      = 16;
      const barGap    = 10;

      top5.forEach((p, i) => {
        const barW = maxProfit > 0 ? Math.max(4, (p.profit / maxProfit) * (barAreaW - 120)) : 4;
        const by   = y + i * (barH + barGap);

        // Label
        const lbl = (p.name || '').length > 22 ? p.name.substring(0, 20) + '…' : p.name;
        doc.fillColor(GRAY_MID).fontSize(8).font('Helvetica')
           .text(lbl, 40, by + 3, { width: 110 });

        // Bar
        filledRect(doc, 155, by, barW, barH, BRAND_GREEN);

        // Value
        doc.fillColor(GRAY_DARK).fontSize(8)
           .text(formatBRL(p.profit), 160 + barW, by + 3, { width: 80 });
      });
      y += top5.length * (barH + barGap) + 20;
    } else {
      doc.fillColor(GRAY_LIGHT).fontSize(9).text('Dados insuficientes para o gráfico.', 40, y);
      y += 20;
    }

    // ── BREAKDOWN DE CUSTOS ──────────────────────────────────────────
    y += 6;
    if (y > 680) { doc.addPage(); y = 40; }
    rule(doc, y);
    y += 14;

    doc.fillColor(GRAY_DARK).fontSize(13).font('Helvetica-Bold')
       .text('Breakdown de custos', 40, y);
    y += 18;

    const costs = summary.costsBreakdown || {};
    const costItems = [
      ['Comissão marketplace',    costs.commission],
      ['Taxa de serviço',         costs.serviceFee],
      ['Impostos',                costs.tax],
      ['Custo dos produtos (CMV)',costs.cogs],
      ['Embalagem + insumos',     costs.packaging],
      ['Frete subsidiado',        costs.freight],
    ];

    costItems.forEach(([label, value], idx) => {
      const rowBg = idx % 2 === 0 ? '#f9fafb' : '#ffffff';
      filledRect(doc, 40, y, PAGE_W, 18, rowBg);
      doc.fillColor(GRAY_MID).fontSize(9).font('Helvetica')
         .text(label, 48, y + 4, { width: 280 });
      doc.fillColor(GRAY_DARK)
         .text(formatBRL(value || 0), 330, y + 4, { width: PAGE_W - 295, align: 'right' });
      y += 20;
    });

    // Total de custos
    const totalCosts = costItems.reduce((s, [, v]) => s + (v || 0), 0);
    filledRect(doc, 40, y, PAGE_W, 22, '#f1f5f9');
    doc.fillColor(GRAY_DARK).fontSize(10).font('Helvetica-Bold')
       .text('Total de custos', 48, y + 5, { width: 280 })
       .fillColor('#dc2626')
       .text(formatBRL(totalCosts), 330, y + 5, { width: PAGE_W - 295, align: 'right' });
    y += 26;

    // ── RODAPÉ ───────────────────────────────────────────────────────
    const footerY = 810;
    rule(doc, footerY - 10, '#d1d5db');
    doc.fontSize(8).font('Helvetica').fillColor(GRAY_LIGHT)
       .text(
         `Gerado por ProfitTrack em ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}`,
         40, footerY, { align: 'center', width: PAGE_W },
       );

    doc.end();
  });
}

module.exports = { generateMonthlyReport };
