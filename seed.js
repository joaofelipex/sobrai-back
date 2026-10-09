const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const DB_FILE = 'sobrai.db';

const clients = [
  { id: 'c-1001', name: 'Maria Oliveira', document: '12345678901' },
  { id: 'c-1002', name: 'Padaria Pão Dourado', document: '12345678000190' },
  { id: 'c-1003', name: 'Tech Solutions Ltda', document: '98765432000155' },
  { id: 'c-1004', name: 'Carlos Souza', document: '23456789012' },
  { id: 'c-1005', name: 'Studio Criativo Design', document: '11222333000144' },
];

const expenseCategories = ['Alimentação', 'Transporte', 'Moradia', 'Fornecedores', 'Impostos', 'Marketing', 'Software', 'Outros'];
const revenueCategories = ['Venda de Produto', 'Prestação de Serviço', 'Consultoria', 'Outros'];

function randomDateWithinDays(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(Math.random() * daysAgo));
  return d.toISOString().split('T')[0];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const transactions = [];
for (let i = 0; i < 25; i++) {
  const isRevenue = Math.random() > 0.45;
  transactions.push({
    id: `tx-mock-${i}`,
    type: isRevenue ? 'revenue' : 'expense',
    description: isRevenue
      ? pick(['Venda de produto', 'Serviço prestado', 'Consultoria mensal', 'Pagamento recebido'])
      : pick(['Compra de material', 'Pagamento fornecedor', 'Conta de energia', 'Internet/Software', 'Combustível']),
    amount: isRevenue
      ? Math.round((Math.random() * 2500 + 100) * 100) / 100
      : Math.round((Math.random() * 800 + 30) * 100) / 100,
    date: randomDateWithinDays(45),
    category: isRevenue ? pick(revenueCategories) : pick(expenseCategories),
  });
}

const goals = [
  { id: 'goal-1', name: 'Reserva de emergência', type: 'savings', targetAmount: 10000, deadline: '2026-12-31' },
  { id: 'goal-2', name: 'Comprar equipamento novo', type: 'purchase', targetAmount: 4500, deadline: '2026-06-30' },
  { id: 'goal-3', name: 'Reduzir despesas fixas', type: 'expense_reduction', targetAmount: 500, deadline: '2026-03-31' },
];

const companyProfile = {
  name: 'Loja do João Comércio Digital',
  type: 'mei',
  monthlyRevenue: 4000,
  cnpj: '12345678000190',
  phone: '(11) 98765-4321',
  email: 'contato@lojadojoao.com.br',
  address: JSON.stringify({
    street: 'Rua das Flores',
    number: '123',
    neighborhood: 'Centro',
    city: 'São Paulo',
    state: 'SP',
    zipCode: '01000-000',
  }),
};

(async () => {
  const db = await open({ filename: DB_FILE, driver: sqlite3.Database });

  for (const c of clients) {
    await db.run(
      'INSERT OR IGNORE INTO clients (id, name, document) VALUES (?, ?, ?)',
      [c.id, c.name, c.document]
    );
  }

  for (const t of transactions) {
    await db.run(
      'INSERT OR IGNORE INTO transactions (id, type, description, amount, date, category) VALUES (?, ?, ?, ?, ?, ?)',
      [t.id, t.type, t.description, t.amount, t.date, t.category]
    );
  }

  for (const g of goals) {
    await db.run(
      'INSERT OR IGNORE INTO goals (id, name, type, targetAmount, deadline) VALUES (?, ?, ?, ?, ?)',
      [g.id, g.name, g.type, g.targetAmount, g.deadline]
    );
  }

  const existingProfile = await db.get('SELECT * FROM company_profile WHERE id = 1');
  if (!existingProfile) {
    await db.run(
      'INSERT INTO company_profile (id, name, type, monthlyRevenue, cnpj, phone, email, address) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
      [companyProfile.name, companyProfile.type, companyProfile.monthlyRevenue, companyProfile.cnpj, companyProfile.phone, companyProfile.email, companyProfile.address]
    );
  }

  console.log('Seed concluído.');
  const counts = {};
  for (const t of ['clients', 'transactions', 'goals', 'company_profile']) {
    const rows = await db.all(`SELECT * FROM ${t}`);
    counts[t] = rows.length;
  }
  console.log(counts);

  await db.close();
})();
