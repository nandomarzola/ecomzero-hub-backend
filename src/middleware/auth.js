const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  // Aceita token via query param para endpoints de download (PDF)
  const rawToken = req.query.token;

  if (!authHeader && !rawToken) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  const token = rawToken || authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId   = payload.userId;
    req.userRole = payload.role ?? 'seller';
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.userRole !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

module.exports = { authMiddleware, adminMiddleware };
