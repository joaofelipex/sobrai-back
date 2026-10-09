// Carrega variáveis de ambiente de .env (se existir), sem dependências extras.
try { process.loadEnvFile(require('path').join(__dirname, '.env')); } catch { /* sem .env */ }

const express = require('express');
const cors = require('cors');
const { initDb } = require('./database');
const { errorHandler } = require('./lib/http');

const transactionsRouter = require('./routes/transactions');
const companyProfileRouter = require('./routes/company-profile');
const clientsRouter = require('./routes/clients');
const goalsRouter = require('./routes/goals');
const invoicesRouter = require('./routes/invoices');
const recurringRouter = require('./routes/recurring');
const insightsRouter = require('./routes/insights');

const app = express();
const PORT = process.env.PORT || 3001;

// Em produção, defina CORS_ORIGIN (ex: https://app.exemplo.com). Em dev, qualquer origem.
app.use(cors(process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined));
app.use(express.json());

app.use('/api/transactions', transactionsRouter);
app.use('/api/company-profile', companyProfileRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/goals', goalsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/recurring', recurringRouter);
app.use('/api/insights', insightsRouter);

app.use(errorHandler);

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend server running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
