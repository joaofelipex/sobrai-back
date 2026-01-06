const express = require('express');
const cors = require('cors');
const { initDb } = require('./database');

const transactionsRouter = require('./routes/transactions');
const companyProfileRouter = require('./routes/company-profile');
const clientsRouter = require('./routes/clients');
const goalsRouter = require('./routes/goals');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/transactions', transactionsRouter);
app.use('/api/company-profile', companyProfileRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/goals', goalsRouter);

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Backend server running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
