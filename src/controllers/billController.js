const prisma = require('../lib/prisma');

function computeStatus(bill) {
  if (bill.status === 'paid') return 'paid';
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return new Date(bill.dueDate) < now ? 'overdue' : 'pending';
}

async function listBills(req, res) {
  const { status, storeId, startDate, endDate } = req.query;

  const where = { userId: req.userId };
  if (storeId) where.storeId = storeId;

  if (startDate || endDate) {
    where.dueDate = {};
    if (startDate) where.dueDate.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setUTCHours(23, 59, 59, 999);
      where.dueDate.lte = end;
    }
  }

  let bills = await prisma.bill.findMany({
    where,
    include: { supplier: { select: { name: true } }, store: { select: { name: true } } },
    orderBy: { dueDate: 'asc' },
  });

  // Enriquecer com status calculado (overdue)
  bills = bills.map((b) => ({ ...b, computedStatus: computeStatus(b) }));

  if (status) bills = bills.filter((b) => b.computedStatus === status);

  const totalPending  = bills.filter((b) => b.computedStatus === 'pending').reduce((s, b) => s + b.amount, 0);
  const totalOverdue  = bills.filter((b) => b.computedStatus === 'overdue').reduce((s, b) => s + b.amount, 0);
  const totalPaid     = bills.filter((b) => b.computedStatus === 'paid').reduce((s, b) => s + b.amount, 0);

  return res.json({ bills, totalPending, totalOverdue, totalPaid });
}

async function createBill(req, res) {
  const { description, amount, dueDate, category, storeId, supplierId, recurring, recurrence, notes, installments } = req.body;
  if (!description?.trim()) return res.status(400).json({ error: 'Descrição obrigatória' });
  if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'Valor inválido' });
  if (!dueDate) return res.status(400).json({ error: 'Data de vencimento obrigatória' });

  const n = Math.max(1, Math.min(999, parseInt(installments) || 1));

  if (n === 1) {
    const bill = await prisma.bill.create({
      data: {
        userId:      req.userId,
        description: description.trim(),
        amount:      parseFloat(amount),
        dueDate:     new Date(dueDate),
        category:    category || 'outros',
        storeId:     storeId  || null,
        supplierId:  supplierId || null,
        recurring:   Boolean(recurring),
        recurrence:  recurrence || null,
        notes:       notes?.trim() || null,
      },
      include: { supplier: { select: { name: true } }, store: { select: { name: true } } },
    });
    return res.status(201).json({ bill: { ...bill, computedStatus: computeStatus(bill) } });
  }

  // Parcelas: distribui valor igualmente, centavos residuais vão para a última
  const total      = parseFloat(amount);
  const baseAmount = Math.floor((total / n) * 100) / 100;
  const lastAmount = Math.round((total - baseAmount * (n - 1)) * 100) / 100;
  const baseDate   = new Date(dueDate);
  const baseDesc   = description.trim();
  const sharedData = {
    userId:     req.userId,
    category:   category   || 'outros',
    storeId:    storeId    || null,
    supplierId: supplierId || null,
    recurring:  false,
    recurrence: null,
    notes:      notes?.trim() || null,
  };

  const created = await prisma.$transaction(
    Array.from({ length: n }, (_, i) => {
      const due = new Date(baseDate);
      due.setMonth(due.getMonth() + i);
      return prisma.bill.create({
        data: {
          ...sharedData,
          description: `${baseDesc} (${i + 1}/${n})`,
          amount:      i === n - 1 ? lastAmount : baseAmount,
          dueDate:     due,
        },
      });
    })
  );

  return res.status(201).json({
    bills: created.map((b) => ({ ...b, computedStatus: computeStatus(b) })),
    count: n,
  });
}

async function updateBill(req, res) {
  const exists = await prisma.bill.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!exists) return res.status(404).json({ error: 'Conta não encontrada' });

  const { description, amount, dueDate, category, storeId, supplierId, recurring, recurrence, notes } = req.body;

  const bill = await prisma.bill.update({
    where: { id: req.params.id },
    data: {
      description: description?.trim() || exists.description,
      amount:      amount !== undefined ? parseFloat(amount) : exists.amount,
      dueDate:     dueDate ? new Date(dueDate) : exists.dueDate,
      category:    category || exists.category,
      storeId:     storeId !== undefined ? (storeId || null) : exists.storeId,
      supplierId:  supplierId !== undefined ? (supplierId || null) : exists.supplierId,
      recurring:   recurring !== undefined ? Boolean(recurring) : exists.recurring,
      recurrence:  recurrence !== undefined ? (recurrence || null) : exists.recurrence,
      notes:       notes !== undefined ? (notes?.trim() || null) : exists.notes,
    },
    include: { supplier: { select: { name: true } }, store: { select: { name: true } } },
  });
  return res.json({ bill: { ...bill, computedStatus: computeStatus(bill) } });
}

async function payBill(req, res) {
  const exists = await prisma.bill.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!exists) return res.status(404).json({ error: 'Conta não encontrada' });
  if (exists.status === 'paid') return res.status(400).json({ error: 'Conta já paga' });

  const bill = await prisma.bill.update({
    where: { id: req.params.id },
    data:  { status: 'paid', paidAt: new Date() },
    include: { supplier: { select: { name: true } } },
  });

  // Se for recorrente, cria a próxima parcela automaticamente
  if (exists.recurring && exists.recurrence) {
    const nextDue = new Date(exists.dueDate);
    if (exists.recurrence === 'monthly') nextDue.setMonth(nextDue.getMonth() + 1);
    else if (exists.recurrence === 'weekly') nextDue.setDate(nextDue.getDate() + 7);

    await prisma.bill.create({
      data: {
        userId:      exists.userId,
        description: exists.description,
        amount:      exists.amount,
        dueDate:     nextDue,
        category:    exists.category,
        storeId:     exists.storeId,
        supplierId:  exists.supplierId,
        recurring:   true,
        recurrence:  exists.recurrence,
        notes:       exists.notes,
      },
    });
  }

  return res.json({ bill: { ...bill, computedStatus: 'paid' }, nextCreated: exists.recurring });
}

async function deleteBill(req, res) {
  const exists = await prisma.bill.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!exists) return res.status(404).json({ error: 'Conta não encontrada' });
  await prisma.bill.delete({ where: { id: req.params.id } });
  return res.json({ message: 'Conta removida' });
}

module.exports = { listBills, createBill, updateBill, payBill, deleteBill };
