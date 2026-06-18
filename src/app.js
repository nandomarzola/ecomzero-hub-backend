require('dotenv').config();

// ── Validação de variáveis críticas — falha rápido antes de qualquer import de DB ──
const REQUIRED_ENV = ['JWT_SECRET', 'DATABASE_URL'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error(`[FATAL] Variáveis de ambiente obrigatórias não definidas: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const fs           = require('fs');
const prisma       = require('./lib/prisma');

const authRoutes          = require('./routes/auth');
const storeRoutes         = require('./routes/stores');
const productRoutes       = require('./routes/products');
const orderRoutes         = require('./routes/orders');
const dashboardRoutes     = require('./routes/dashboard');
const supplierRoutes      = require('./routes/suppliers');
const billRoutes          = require('./routes/bills');
const purchaseOrderRoutes = require('./routes/purchaseOrders');
const newsRoutes          = require('./routes/news');
const cashflowRoutes      = require('./routes/cashflow');
const adminPanelRoutes    = require('./routes/adminPanel');
const goalsRoutes         = require('./routes/goals');
const insightsRoutes      = require('./routes/insights');
const closingRoutes       = require('./routes/closing');
const mlRoutes            = require('./routes/ml');
const tiktokRoutes        = require('./routes/tiktok');
const shopeeRoutes        = require('./routes/shopee');
const monthlyTaxRoutes    = require('./routes/monthlyTax');
const appRoutes           = require('./routes/app');

const { startRecalculateWorker } = require('./services/recalculateQueue');

const app = express();
app.set('etag', false);

// ── Security headers ────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // gerenciado pelo frontend
}));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ── Garante que a pasta de uploads exista ──────────────────────────────────────
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ── CORS ────────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  'http://localhost',
  'http://localhost:5173',
  'http://127.0.0.1',
  'http://127.0.0.1:5173',
  'https://app.ecomzero.com.br',
  'https://ecomzero-hub-frontend-1622.vercel.app',
];

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiters ───────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde 15 minutos.' },
  skip: (req) => process.env.NODE_ENV === 'test',
});

// Sync dispara chamadas caras a APIs externas — limitar por usuário
const syncLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas sincronizações em sequência. Aguarde 1 minuto.' },
  keyGenerator: (req) => req.userId ?? req.ip,
});

// ── Log de todos os acessos à API ──────────────────────────────────────────────
const { logAccess } = require('./middleware/accessLog');
app.use('/api', logAccess);

// ── Health check com verificação real do banco ─────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'ok', db: 'error', timestamp: new Date().toISOString() });
  }
});

// ── Rotas ───────────────────────────────────────────────────────────────────────
app.use('/api/auth',            authRoutes);          // rate limit aplicado na rota
app.use('/api/stores',          storeRoutes);
app.use('/api/products',        productRoutes);
app.use('/api/orders',          orderRoutes);
app.use('/api/dashboard',       dashboardRoutes);
app.use('/api/suppliers',       supplierRoutes);
app.use('/api/bills',           billRoutes);
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/news',            newsRoutes);
app.use('/api/cashflow',        cashflowRoutes);
app.use('/api/admin',           adminPanelRoutes);
app.use('/api/goals',           goalsRoutes);
app.use('/api/insights',        insightsRoutes);
app.use('/api/closing',         closingRoutes);
app.use('/api/ml',              mlRoutes);
app.use('/api/tiktok',          tiktokRoutes);
app.use('/api/shopee',          shopeeRoutes);
app.use('/api/monthly-tax',     monthlyTaxRoutes);
app.use('/api/app',             appRoutes);

// ── Error handler global com contexto de diagnóstico ───────────────────────────
// Express 5: erros de async handlers chegam aqui automaticamente
app.use((err, req, res, next) => {
  const status = err.status ?? err.statusCode ?? 500;
  const isDev  = process.env.NODE_ENV !== 'production';

  console.error({
    msg:    err.message,
    stack:  isDev ? err.stack : undefined,
    method: req.method,
    path:   req.path,
    userId: req.userId ?? null,
    body:   isDev ? req.body : undefined,
    status,
  });

  res.status(status).json({ error: status === 500 ? 'Erro interno do servidor' : err.message });
});

// ── Exporta limiters para uso nas rotas ────────────────────────────────────────
app.locals.authLimiter = authLimiter;
app.locals.syncLimiter = syncLimiter;

const PORT = process.env.PORT || 3333;
const server = app.listen(PORT, () => {
  console.log(`ProfitTrack API rodando na porta ${PORT}`);

  if (process.env.ENABLE_WORKER === 'true') {
    startRecalculateWorker();
    console.log('[recalculate-worker] Worker de recálculo iniciado');
  }
});

// ── Graceful shutdown: fecha conexões abertas antes de reiniciar ───────────────
async function shutdown(signal) {
  console.log(`[${signal}] Encerrando servidor...`);
  server.close(async () => {
    await prisma.$disconnect();
    console.log('[shutdown] Banco desconectado. Processo encerrado.');
    process.exit(0);
  });
  // Forçar saída após 10s se algo travar
  setTimeout(() => process.exit(1), 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
