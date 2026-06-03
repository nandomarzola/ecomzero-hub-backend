require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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

const { startRecalculateWorker }  = require('./services/recalculateQueue');

const app = express();
app.set('etag', false);
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Garante que a pasta de uploads exista
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

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

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log de todos os acessos à API
const { logAccess } = require('./middleware/accessLog');
app.use('/api', logAccess);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth',           authRoutes);
app.use('/api/stores',         storeRoutes);
app.use('/api/products',       productRoutes);
app.use('/api/orders',         orderRoutes);
app.use('/api/dashboard',      dashboardRoutes);
app.use('/api/suppliers',      supplierRoutes);
app.use('/api/bills',          billRoutes);
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/news',           newsRoutes);
app.use('/api/cashflow',       cashflowRoutes);
app.use('/api/admin',          adminPanelRoutes);
app.use('/api/goals',           goalsRoutes);
app.use('/api/insights',        insightsRoutes);
app.use('/api/closing',         closingRoutes);
app.use('/api/ml',              mlRoutes);
app.use('/api/tiktok',          tiktokRoutes);

// Tratamento de erros global
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
  console.log(`ProfitTrack API rodando na porta ${PORT}`);

  // Import roda direto em background (sem BullMQ/Redis)
  if (process.env.ENABLE_WORKER === 'true') {
    startRecalculateWorker();
    console.log('[recalculate-worker] Worker de recálculo iniciado');
  }
});

module.exports = app;
