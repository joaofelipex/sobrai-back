// MiXCo: sobe a API real com um banco temporário e exercita contas, lançamentos, bens, dívidas,
// orçamento e o resumo de patrimônio.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3097;
const BASE = `http://localhost:${PORT}/api/mixco`;
let child, tmp;

const j = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixco-'));
  child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SOBRAI_DB: path.join(tmp, 'test.db') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/budgets'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('API não subiu');
});

test.after(() => {
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('validação recusa dados inválidos', async () => {
  assert.strictEqual((await j('POST', '/accounts', { name: 'X', kind: 'banco' })).status, 400);
  assert.strictEqual((await j('POST', '/assets', { name: 'X', assetClass: 'renda_fixa', currentValue: -1 })).status, 400);
  assert.strictEqual((await j('POST', '/transactions', { accountId: 'nao-existe', type: 'income', description: 'x', amount: 10, date: '2025-01-10' })).status, 400);
  assert.strictEqual((await j('GET', '/summary?month=2025-13')).status, 400);
});

test('patrimônio líquido, fluxo do mês, orçamento e reserva de emergência', async () => {
  const m = thisMonth();
  const acc = (await j('POST', '/accounts', { name: 'Conta corrente', kind: 'checking', institution: 'Banco', initialBalance: 1000 })).body;
  const tx = (type, amount, category) => j('POST', '/transactions', { accountId: acc.id, type, description: `${type} ${category}`, amount, date: `${m}-05`, category });
  assert.strictEqual((await tx('income', 5000, 'Salário')).status, 201);
  assert.strictEqual((await tx('expense', 1200, 'Moradia')).status, 201);
  assert.strictEqual((await tx('expense', 800, 'Alimentação')).status, 201);

  assert.strictEqual((await j('POST', '/assets', { name: 'Tesouro Selic', assetClass: 'renda_fixa', invested: 2000, currentValue: 2300 })).status, 201);
  assert.strictEqual((await j('POST', '/assets', { name: 'Apartamento', assetClass: 'imoveis', invested: 200000, currentValue: 250000 })).status, 201);
  assert.strictEqual((await j('POST', '/liabilities', { name: 'Financiamento', kind: 'financiamento', balance: 100000, monthlyRate: 0.8, monthlyPayment: 1500 })).status, 201);
  assert.strictEqual((await j('PUT', '/budgets/Alimentação', { monthlyLimit: 600 })).status, 200);

  // Saldo da conta = 1000 + 5000 - 1200 - 800
  const accounts = (await j('GET', '/accounts')).body;
  assert.strictEqual(accounts.find((a) => a.id === acc.id).balance, 4000);

  const s = (await j('GET', '/summary')).body;
  assert.strictEqual(s.cash, 4000);
  assert.strictEqual(s.assets, 4000 + 2300 + 250000);
  assert.strictEqual(s.liabilities, 100000);
  assert.strictEqual(s.netWorth, 4000 + 2300 + 250000 - 100000);
  assert.deepStrictEqual(s.flow, { income: 5000, expense: 2000, saved: 3000, savingsRate: 60, previousExpense: 0 });
  assert.strictEqual(s.investments.profit, 300 + 50000);
  assert.strictEqual(s.monthlyDebtPayments, 1500);

  const food = s.budget.find((b) => b.category === 'Alimentação');
  assert.deepStrictEqual([food.spent, food.limit, food.over], [800, 600, true]);

  const imoveis = s.allocation.find((a) => a.assetClass === 'imoveis');
  assert.ok(imoveis.percent > 95);
  assert.strictEqual(s.history.at(-1).netWorth, s.netWorth);
  assert.strictEqual(s.emergencyFund.liquid, 4000 + 2300);
});

test('conta com lançamentos não pode ser excluída; edição e exclusão de lançamento', async () => {
  const acc = (await j('POST', '/accounts', { name: 'Carteira', kind: 'cash' })).body;
  assert.strictEqual(acc.initialBalance, 0);
  const t = (await j('POST', '/transactions', { accountId: acc.id, type: 'expense', description: 'Café', amount: 10, date: '2025-03-10T12:00:00Z' })).body;
  assert.strictEqual(t.date, '2025-03-10');
  assert.strictEqual(t.category, 'Outros');
  assert.strictEqual((await j('DELETE', `/accounts/${acc.id}`)).status, 409);

  const upd = await j('PUT', `/transactions/${t.id}`, { accountId: acc.id, type: 'expense', description: 'Café', amount: 12, date: '2025-03-10' });
  assert.strictEqual(upd.body.amount, 12);
  assert.strictEqual((await j('GET', '/transactions?month=2025-03')).body.length, 1);
  assert.strictEqual((await j('DELETE', `/transactions/${t.id}`)).status, 204);
  assert.strictEqual((await j('DELETE', `/accounts/${acc.id}`)).status, 204);
  assert.strictEqual((await j('DELETE', `/accounts/${acc.id}`)).status, 404);
});

test('contas fixas: pagas x pendentes e projeção do mês', async () => {
  const m = thisMonth();
  const acc = (await j('POST', '/accounts', { name: 'Conta fixas', kind: 'checking', initialBalance: 1000 })).body;
  assert.strictEqual((await j('POST', '/recurring', { description: 'Aluguel', type: 'expense', amount: 700, dayOfMonth: 40 })).status, 400);
  await j('POST', '/recurring', { description: 'Aluguel', type: 'expense', amount: 700, dayOfMonth: 5 });
  await j('POST', '/recurring', { description: 'Academia', type: 'expense', amount: 120, dayOfMonth: 28 });
  await j('POST', '/transactions', { accountId: acc.id, type: 'expense', description: 'PIX ALUGUEL JOAO', amount: 700, date: `${m}-05` });

  const s = (await j('GET', '/summary')).body;
  const by = Object.fromEntries(s.upcoming.map((u) => [u.description, u]));
  assert.strictEqual(by.Aluguel.paid, true);
  assert.strictEqual(by.Academia.paid, false);
  assert.strictEqual(s.projection.pendingOut, 120);
  assert.strictEqual(s.projection.projectedBalance, s.cash - s.cardDebt - 120);
});
