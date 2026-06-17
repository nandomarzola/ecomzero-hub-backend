const prisma = require('../lib/prisma');

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

async function listPurchaseOrders(req, res) {
  const { status } = req.query;
  const where = { userId: req.userId };
  if (status) where.status = status;

  const orders = await prisma.purchaseOrder.findMany({
    where,
    include: {
      supplier: { select: { name: true } },
      items: {
        include: { product: { select: { name: true, sku: true, stock: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ orders });
}

async function getPurchaseOrder(req, res) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: req.params.id, userId: req.userId },
    include: {
      supplier: true,
      items: { include: { product: true } },
    },
  });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  return res.json({ order });
}

async function createPurchaseOrder(req, res) {
  const { supplierId, expectedAt, notes, items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'Pelo menos um item é obrigatório' });

  const total = items.reduce((s, i) => s + (parseFloat(i.unitCost) * parseInt(i.quantity)), 0);

  const order = await prisma.purchaseOrder.create({
    data: {
      userId:     req.userId,
      supplierId: supplierId || null,
      expectedAt: expectedAt ? new Date(expectedAt) : null,
      notes:      notes?.trim() || null,
      total:      parseFloat(total.toFixed(2)),
      items: {
        create: items.map((i) => ({
          productId: i.productId,
          quantity:  parseInt(i.quantity),
          unitCost:  parseFloat(i.unitCost),
        })),
      },
    },
    include: {
      supplier: { select: { name: true } },
      items: { include: { product: { select: { name: true, sku: true } } } },
    },
  });
  return res.status(201).json({ order });
}

async function sendPurchaseOrder(req, res) {
  const order = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (order.status !== 'draft') return res.status(400).json({ error: 'Apenas rascunhos podem ser enviados' });

  const updated = await prisma.purchaseOrder.update({
    where: { id: req.params.id },
    data:  { status: 'sent', orderedAt: new Date() },
  });
  return res.json({ order: updated });
}

async function receivePurchaseOrder(req, res) {
  const { items: bodyItems } = req.body;

  const order = await prisma.purchaseOrder.findFirst({
    where:   { id: req.params.id, userId: req.userId },
    include: { items: { include: { product: true } }, supplier: true },
  });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (order.status === 'delivered') return res.status(409).json({ error: 'Pedido já foi entregue e não pode ser reprocessado' });
  if (order.status === 'cancelled') return res.status(400).json({ error: 'Pedido cancelado' });

  let billTotal = 0;

  await prisma.$transaction(async (tx) => {
    for (const item of order.items) {
      const recv = bodyItems?.find(i => i.itemId === item.id)?.receivedQty ?? item.quantity;

      await tx.purchaseOrderItem.update({
        where: { id: item.id },
        data:  { receivedQty: recv },
      });

      if (item.productId != null) {
        await tx.product.update({
          where: { id: item.productId },
          data:  { stock: { increment: recv } },
        });
      }

      billTotal += recv * item.unitCost;
    }

    billTotal = r2(billTotal);

    await tx.purchaseOrder.update({
      where: { id: order.id },
      data:  { status: 'delivered', receivedAt: new Date() },
    });

    if (billTotal > 0) {
      await tx.bill.create({
        data: {
          userId:      req.userId,
          supplierId:  order.supplierId,
          description: `Compra #${order.id.slice(0, 8).toUpperCase()}${order.supplier ? ` — ${order.supplier.name}` : ''}`,
          amount:      billTotal,
          dueDate:     new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          category:    'compra',
        },
      });
    }
  });

  return res.json({ message: 'Pedido recebido, estoque atualizado', billCreated: billTotal > 0, billAmount: billTotal });
}

async function cancelPurchaseOrder(req, res) {
  const order = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (order.status === 'delivered') return res.status(400).json({ error: 'Pedido já entregue, não pode cancelar' });

  await prisma.purchaseOrder.update({ where: { id: order.id }, data: { status: 'cancelled' } });
  return res.json({ message: 'Pedido cancelado' });
}

async function deletePurchaseOrder(req, res) {
  const order = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
  if (order.status === 'delivered') return res.status(400).json({ error: 'Não é possível excluir um pedido entregue' });
  await prisma.purchaseOrder.delete({ where: { id: order.id } });
  return res.json({ message: 'Pedido excluído' });
}

module.exports = { listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, sendPurchaseOrder, receivePurchaseOrder, cancelPurchaseOrder, deletePurchaseOrder };
