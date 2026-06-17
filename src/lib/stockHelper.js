const prisma = require('./prisma');

/**
 * Aplica decremento/restauração de estoque para um pedido.
 *
 * Hierarquia de composição (prioridade decrescente):
 *  1. ProductVariantComponent (variação específica → produtos base)
 *  2. ProductComponent (anúncio inteiro → produtos base)
 *  3. Legado: decrementa stock da própria variação ou produto
 *
 * Idempotência:
 *  valid + !stockDeducted        → decrementa, seta stockDeducted=true
 *  returned_full + stockDeducted → restaura, seta stockDeducted=false
 */
async function applyStockFromOrder(order, tx) {
  const db = tx ?? prisma;

  const shouldDeduct  = order.orderCategory === 'valid'         && !order.stockDeducted;
  const shouldRestore = order.orderCategory === 'returned_full' && order.stockDeducted;
  if (!shouldDeduct && !shouldRestore) return;

  const delta = shouldDeduct ? -1 : 1;
  const qty   = order.quantity ?? 1;

  let handled = false;

  // 1. Composição por variação
  if (order.variantId) {
    const variantComponents = await db.productVariantComponent.findMany({
      where: { variantId: order.variantId },
    });
    if (variantComponents.length > 0) {
      for (const comp of variantComponents) {
        await db.product.update({
          where: { id: comp.baseProductId },
          data: { stock: { increment: delta * comp.quantity * qty } },
        });
      }
      handled = true;
    }
  }

  // 2. Composição por produto (anúncio inteiro), se não tratado por variação
  if (!handled && order.productId) {
    const productComponents = await db.productComponent.findMany({
      where: { productId: order.productId },
    });
    if (productComponents.length > 0) {
      for (const comp of productComponents) {
        await db.product.update({
          where: { id: comp.baseProductId },
          data: { stock: { increment: delta * comp.quantity * qty } },
        });
      }
      handled = true;
    }
  }

  // 3. Legado: decrementa a variação ou produto diretamente
  if (!handled) {
    if (order.variantId) {
      await db.productVariant.update({
        where: { id: order.variantId },
        data: { stock: { increment: delta * qty } },
      }).catch(() => {});
    } else if (order.productId) {
      await db.product.update({
        where: { id: order.productId },
        data: { stock: { increment: delta * qty } },
      }).catch(() => {});
    }
  }

  // Marcar idempotência no Order
  await db.order.update({
    where: { id: order.id },
    data: { stockDeducted: shouldDeduct },
  });
}

module.exports = { applyStockFromOrder };
