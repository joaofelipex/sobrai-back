const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Mock data - mimics the structure from localStorage
let mockTransactions = [
  {
    id: '1',
    type: 'revenue',
    description: 'Serviço de Consultoria',
    amount: 5000,
    date: '2023-10-26',
    category: 'Prestação de Serviço'
  },
  {
    id: '2',
    type: 'expense',
    description: 'Assinatura Adobe Creative Cloud',
    amount: 250,
    date: '2023-10-20',
    category: 'Software'
  },
  {
    id: '3',
    type: 'expense',
    description: 'Aluguel do Escritório',
    amount: 1500,
    date: '2023-10-05',
    category: 'Infraestrutura'
  }
];

// --- Endpoints ---

// GET all transactions
app.get('/api/transactions', (req, res) => {
  console.log('GET /api/transactions called');
  res.json(mockTransactions);
});

// POST a new transaction
app.post('/api/transactions', (req, res) => {
  const newTransaction = { ...req.body, id: Date.now().toString() };
  mockTransactions.push(newTransaction);
  console.log('POST /api/transactions - Added:', newTransaction);
  res.status(201).json(newTransaction);
});

// PUT (update) a transaction
app.put('/api/transactions/:id', (req, res) => {
  const { id } = req.params;
  const updatedTransaction = req.body;
  const index = mockTransactions.findIndex(t => t.id === id);

  if (index !== -1) {
    mockTransactions[index] = { ...mockTransactions[index], ...updatedTransaction };
    console.log(`PUT /api/transactions/${id} - Updated:`, mockTransactions[index]);
    res.json(mockTransactions[index]);
  } else {
    res.status(404).json({ message: 'Transaction not found' });
  }
});

// DELETE a transaction
app.delete('/api/transactions/:id', (req, res) => {
  const { id } = req.params;
  const index = mockTransactions.findIndex(t => t.id === id);

  if (index !== -1) {
    mockTransactions.splice(index, 1);
    console.log(`DELETE /api/transactions/${id} - Deleted`);
    res.status(204).send();
  } else {
    res.status(404).json({ message: 'Transaction not found' });
  }
});

// --- Company Profile Data and Endpoints ---

let mockCompanyProfile = {
  name: 'Empresa Exemplo Ltda',
  industry: 'Tecnologia',
  size: 'pequeno',
  annualRevenue: 500000,
  taxRegime: 'simples-nacional',
  accountingSystem: 'none',
  bankIntegration: false
};

app.get('/api/company-profile', (req, res) => {
  console.log('GET /api/company-profile called');
  res.json(mockCompanyProfile);
});

app.put('/api/company-profile', (req, res) => {
  mockCompanyProfile = { ...mockCompanyProfile, ...req.body };
  console.log('PUT /api/company-profile - Updated:', mockCompanyProfile);
  res.json(mockCompanyProfile);
});

// --- Clients Data and Endpoints ---

let mockClients = [
  {
    id: '1',
    name: 'Cliente Exemplo Ltda',
    document: '12.345.678/0001-90'
  }
];

app.get('/api/clients', (req, res) => {
  console.log('GET /api/clients called');
  res.json(mockClients);
});

app.post('/api/clients', (req, res) => {
  const newClient = {
    id: Date.now().toString(),
    ...req.body
  };
  mockClients.push(newClient);
  console.log('POST /api/clients - Added:', newClient);
  res.status(201).json(newClient);
});

// --- Goals Data and Endpoints ---

let mockGoals = [
  {
    id: '1',
    name: 'Faturamento de Outubro',
    type: 'revenue',
    targetAmount: 8000,
    deadline: '2023-10-31'
  },
  {
    id: '2',
    name: 'Economizar para Reserva de Emergência',
    type: 'savings',
    targetAmount: 2000,
    deadline: '2023-12-31'
  }
];

app.get('/api/goals', (req, res) => {
  console.log('GET /api/goals called');
  res.json(mockGoals);
});

app.post('/api/goals', (req, res) => {
  const newGoal = { ...req.body, id: Date.now().toString() };
  mockGoals.push(newGoal);
  console.log('POST /api/goals - Added:', newGoal);
  res.status(201).json(newGoal);
});

app.put('/api/goals/:id', (req, res) => {
  const { id } = req.params;
  const updatedGoal = req.body;
  const index = mockGoals.findIndex(g => g.id === id);

  if (index !== -1) {
    mockGoals[index] = { ...mockGoals[index], ...updatedGoal };
    console.log(`PUT /api/goals/${id} - Updated:`, mockGoals[index]);
    res.json(mockGoals[index]);
  } else {
    res.status(404).json({ message: 'Goal not found' });
  }
});

app.delete('/api/goals/:id', (req, res) => {
  const { id } = req.params;
  const index = mockGoals.findIndex(g => g.id === id);

  if (index !== -1) {
    mockGoals.splice(index, 1);
    console.log(`DELETE /api/goals/${id} - Deleted`);
    res.status(204).send();
  } else {
    res.status(404).json({ message: 'Goal not found' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running at http://localhost:${PORT}`);
});
