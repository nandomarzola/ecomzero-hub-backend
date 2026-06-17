const prisma = require('./prisma');

// Decrementa ou restaura estoque ao confirmar ou devolver um pedido.
// Regras:
//   valid + !stockDeducted        → decrementa estoque, seta stockDeducted=true
//   returned_full + stockDeducted → restaura estoque, seta stockDeducted=false
//   qualquer outro caso           → não mexe
// Suporta kits/compostos via ProductComponent.
// tx: instância Prisma opcional (para uso em transaction — null usa o singleton)
async function applyStockFromOrder(order, tx) {
  const db = tx ?? prisma;
  const shouldDeduct  = order.orderCategory === 'valid'         && !order.stockDeducted;
  const shouldRestore = order.orderCategory === 'returned_full' && order.stockDeducted;

  if (!shouldDeduct && !shouldRestore) return;
  if (!order.productId) return;

  const delta = shouldDeduct ? -1 : 1;
  const qty   = order.quantity ?? 1;

  const components = await db.productComponent.findMany({
    where: { productId: order.productId },
  });

  if (components.length > 0) {
    // Kit/composto: ajustar cada produto base
    for (const comp of components) {
      await db.product.update({
        where: { id: comp.baseProductId },
        data: { stock: { increment: delta * comp.quantity * qty } },
      });
    }
  } else {
    // Sem composição: ajustar o próprio produto (legado)
    await db.product.update({
      where: { id: order.productId },
      data: { stock: { increment: delta * qty } },
    });
  }

  // Marcar idempotência
  await db.order.update({
    where: { id: order.id },
    data: { stockDeducted: shouldDeduct },
  });
}

module.exports = { applyStockFromOrder };
