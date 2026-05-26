const prisma = require('../lib/prisma');

async function listSuppliers(req, res) {
  const suppliers = await prisma.supplier.findMany({
    where: { userId: req.userId },
    include: {
      _count: { select: { purchaseOrders: true } },
    },
    orderBy: { name: 'asc' },
  });
  return res.json({ suppliers });
}

async function getSupplier(req, res) {
  const supplier = await prisma.supplier.findFirst({
    where: { id: req.params.id, userId: req.userId },
    include: {
      purchaseOrders: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { items: { include: { product: { select: { name: true, sku: true } } } } },
      },
      bills: { orderBy: { dueDate: 'desc' }, take: 10 },
    },
  });
  if (!supplier) return res.status(404).json({ error: 'Fornecedor não encontrado' });
  return res.json({ supplier });
}

async function createSupplier(req, res) {
  const { name, contact, phone, email, cnpj, notes, leadDays } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });

  const supplier = await prisma.supplier.create({
    data: {
      userId:  req.userId,
      name:    name.trim(),
      contact: contact?.trim() || null,
      phone:   phone?.trim()   || null,
      email:   email?.trim()   || null,
      cnpj:    cnpj?.trim()    || null,
      notes:   notes?.trim()   || null,
      leadDays: parseInt(leadDays ?? 7),
    },
  });
  return res.status(201).json({ supplier });
}

async function updateSupplier(req, res) {
  const exists = await prisma.supplier.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!exists) return res.status(404).json({ error: 'Fornecedor não encontrado' });

  const { name, contact, phone, email, cnpj, notes, leadDays } = req.body;
  const supplier = await prisma.supplier.update({
    where: { id: req.params.id },
    data: {
      name:     name?.trim()    || exists.name,
      contact:  contact?.trim() ?? exists.contact,
      phone:    phone?.trim()   ?? exists.phone,
      email:    email?.trim()   ?? exists.email,
      cnpj:     cnpj?.trim()    ?? exists.cnpj,
      notes:    notes?.trim()   ?? exists.notes,
      leadDays: leadDays !== undefined ? parseInt(leadDays) : exists.leadDays,
    },
  });
  return res.json({ supplier });
}

async function deleteSupplier(req, res) {
  const exists = await prisma.supplier.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!exists) return res.status(404).json({ error: 'Fornecedor não encontrado' });
  await prisma.supplier.delete({ where: { id: req.params.id } });
  return res.json({ message: 'Fornecedor removido' });
}

module.exports = { listSuppliers, getSupplier, createSupplier, updateSupplier, deleteSupplier };
