const prisma = require('../lib/prisma');
const { randomUUID } = require('crypto');

function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    '—'
  );
}

// Logar acesso a qualquer endpoint da API
function logAccess(req, res, next) {
  const start = Date.now();
  const ip    = getIP(req);
  const ua    = req.headers['user-agent'] ?? null;

  res.on('finish', () => {
    // Só loga endpoints relevantes (não polui com health checks)
    const skip = ['/api/health', '/api/auth/ping'].includes(req.path);
    if (skip) return;

    prisma.accessLog.create({
      data: {
        id:        randomUUID(),
        userId:    req.userId ?? null,
        email:     null, // preenchido no login
        action:    'api_call',
        ip,
        userAgent: ua,
        endpoint:  `${req.method} ${req.path}`,
        status:    res.statusCode,
      },
    }).catch(() => {}); // silencioso para não afetar performance
  });

  next();
}

// Logar login explicitamente (com email)
async function logLogin(email, userId, ip, ua, success) {
  await prisma.accessLog.create({
    data: {
      id:        randomUUID(),
      userId:    userId ?? null,
      email,
      action:    success ? 'login' : 'login_failed',
      ip,
      userAgent: ua,
      endpoint:  'POST /api/auth/login',
      status:    success ? 200 : 401,
    },
  }).catch(() => {});
}

module.exports = { logAccess, logLogin, getIP };
