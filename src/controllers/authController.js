const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const prisma = require('../lib/prisma');

const registerSchema = z.object({
  name:     z.string().min(2, 'Nome deve ter ao menos 2 caracteres'),
  email:    z.string().email('E-mail inválido'),
  password: z.string().min(6, 'Senha deve ter ao menos 6 caracteres'),
  document: z.string().optional(), // CPF ou CNPJ
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

async function register(req, res) {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });
  }

  const { name, email, password, document } = parsed.data;

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) {
    return res.status(409).json({ error: 'E-mail já cadastrado' });
  }

  const hashed = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name, email, password: hashed, ...(document ? { cnpj: document } : {}) },
    select: { id: true, name: true, email: true, plan: true, role: true, createdAt: true },
  });

  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });

  return res.status(201).json({ user, token });
}

async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Dados inválidos', issues: parsed.error.issues });
  }

  const { email, password } = parsed.data;
  const { logLogin, getIP } = require('../middleware/accessLog');
  const ip = getIP(req);
  const ua = req.headers['user-agent'] ?? null;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await logLogin(email, null, ip, ua, false);
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    await logLogin(email, user.id, ip, ua, false);
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  await logLogin(email, user.id, ip, ua, true);

  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });

  const { password: _, ...userSafe } = user;
  return res.json({ user: userSafe, token });
}

async function me(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, name: true, email: true, cnpj: true, plan: true, role: true, createdAt: true },
  });

  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado' });
  }

  return res.json({ user });
}

async function updateMe(req, res) {
  const { name, currentPassword, newPassword, cnpj } = req.body;

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  const data = {};

  if (name && name.trim().length >= 2) {
    data.name = name.trim();
  }

  if (cnpj !== undefined) {
    // Aceita string (CNPJ/CPF) ou null para limpar
    data.cnpj = cnpj ? String(cnpj).trim() : null;
  }

  if (newPassword) {
    if (!currentPassword) {
      return res.status(400).json({ error: 'Senha atual obrigatória para trocar a senha' });
    }
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Senha atual incorreta' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Nova senha deve ter ao menos 6 caracteres' });
    data.password = await bcrypt.hash(newPassword, 12);
  }

  if (!Object.keys(data).length) {
    return res.status(400).json({ error: 'Nada para atualizar' });
  }

  const updated = await prisma.user.update({
    where: { id: req.userId },
    data,
    select: { id: true, name: true, email: true, cnpj: true, plan: true, role: true, createdAt: true },
  });

  return res.json({ user: updated });
}

// POST /api/auth/ping — atualiza lastSeenAt (chamado pelo frontend a cada 5 min)
async function ping(req, res) {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { lastSeenAt: true } });
  // Só atualiza se passou mais de 5 min desde o último ping (evita writes desnecessários)
  if (!user?.lastSeenAt || user.lastSeenAt < fiveMinAgo) {
    await prisma.user.update({ where: { id: req.userId }, data: { lastSeenAt: new Date() } });
  }
  return res.json({ ok: true });
}

module.exports = { register, login, me, updateMe, ping };
