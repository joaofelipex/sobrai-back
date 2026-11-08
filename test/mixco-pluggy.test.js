// MiXCo + Pluggy: backend real em processo filho falando com uma "Pluggy" simulada em HTTP.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3096;
const MOCK_PORT = 3095;
const BASE = `http://localhost:${PORT}/api/mixco`;
let child, mock, tmp;
const calls = [];
let txPages = true;

const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);

const j = async (method, url, body) => {
  const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const ACCOUNTS = [
  { id: 'acc-bank', type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Conta', marketingName: 'Conta Corrente', balance: 5000 },
  { id: 'acc-card', type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Cartão', balance: 800 },
];
const TXS = {
  'acc-bank': [
    { id: 'tx1', description: 'SALARIO EMPRESA', amount: 8000, type: 'CREDIT', date: `${today}T10:00:00.000Z`, category: 'Salary', status: 'POSTED' },
    { id: 'tx2', description: 'SUPERMERCADO ABC', amount: -600, type: 'DEBIT', date: `${today}T10:00:00.000Z`, category: 'Groceries', status: 'POSTED' },
    { id: 'tx3', description: 'PAGAMENTO FATURA CARTAO', amount: -1500, type: 'DEBIT', date: `${today}T10:00:00.000Z`, category: 'Credit card payment', status: 'POSTED' },
    { id: 'tx4', description: 'COMPRA PENDENTE', amount: -50, type: 'DEBIT', date: `${today}T10:00:00.000Z`, category: 'Shopping', status: 'PENDING' },
    { id: 'tx5', description: 'PADARIA DO ZE', amount: -40, type: 'DEBIT', date: `${today}T10:00:00.000Z`, category: null, status: 'POSTED' },
  ],
  'acc-card': [
    { id: 'tx6', description: 'CINEMA', amount: 80, type: 'DEBIT', date: `${today}T10:00:00.000Z`, category: 'Entertainment', status: 'POSTED' },
  ],
};

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mixco-pluggy-'));
  mock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, key: req.headers['x-api-key'], body: data ? JSON.parse(data) : null });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (url.pathname === '/auth') {
        const b = JSON.parse(data);
        return b.clientId === 'id-teste' && b.clientSecret === 'segredo-teste' ? send(200, { apiKey: 'KEY123' }) : send(401, { message: 'credenciais inválidas' });
      }
      if (req.headers['x-api-key'] !== 'KEY123') return send(403, { message: 'sem apiKey' });
      if (url.pathname === '/connect_token') return send(200, { accessToken: 'CONNECT-TOKEN' });
      if (url.pathname === '/items/item-ok') return send(200, { id: 'item-ok', status: 'UPDATED', connector: { name: 'Banco Teste' } });
      if (url.pathname.startsWith('/items/')) return send(404, { message: 'Item not found' });
      if (url.pathname === '/accounts') return send(200, { results: ACCOUNTS, totalPages: 1 });
      if (url.pathname === '/transactions') return send(200, { results: TXS[url.searchParams.get('accountId')] || [], totalPages: 1 });
      if (url.pathname === '/investments') return send(200, { results: [
        { id: 'inv1', name: 'CDB 110% CDI', type: 'FIXED_INCOME', balance: 10500, amountOriginal: 10000 },
        { id: 'inv2', name: 'HGLG11', type: 'ETF', subtype: 'REAL_ESTATE_FUND', balance: 3000, amountProfit: -200 },
      ], totalPages: 1 });
      send(404, { message: 'rota desconhecida' });
    });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, r));

  child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), SOBRAI_DB: path.join(tmp, 'test.db'),
      PLUGGY_API_URL: `http://localhost:${MOCK_PORT}`, PLUGGY_CLIENT_ID: 'id-teste', PLUGGY_CLIENT_SECRET: 'segredo-teste' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/budgets'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('API não subiu');
});

test.after(() => { child.kill(); mock.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('status e token de conexão; item inexistente é recusado', async () => {
  const st = (await j('GET', '/pluggy/status')).body;
  assert.strictEqual(st.configured, true);
  assert.deepStrictEqual(st.items, []);
  assert.strictEqual((await j('POST', '/pluggy/connect-token')).body.accessToken, 'CONNECT-TOKEN');
  assert.strictEqual((await j('POST', '/pluggy/items', { itemId: 'nao-existe' })).status, 502);
  assert.strictEqual((await j('POST', '/pluggy/items', {})).status, 400);
});

test('regra de categoria é aplicada na importação', async () => {
  assert.strictEqual((await j('POST', '/rules', { keyword: 'padaria', category: 'Alimentação' })).status, 201);
});

test('sincroniza contas, lançamentos e investimentos; cartão vira dívida; fatura fora do fluxo', async () => {
  const r = await j('POST', '/pluggy/items', { itemId: 'item-ok' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.error, null, String(r.body.error));
  assert.deepStrictEqual(r.body.stats, { accounts: 2, transactions: 5, investments: 2 }); // pendente ignorada
  assert.ok(calls.every((c) => c.path === '/auth' || c.key === 'KEY123'));

  const accounts = (await j('GET', '/accounts')).body;
  assert.strictEqual(accounts.find((a) => a.kind === 'checking').balance, 5000); // saldo do banco, não derivado
  assert.strictEqual(accounts.find((a) => a.kind === 'credit').balance, -800);

  const s = (await j('GET', '/summary')).body;
  assert.strictEqual(s.cash, 5000);
  assert.strictEqual(s.cardDebt, 800);
  assert.strictEqual(s.liabilities, 800);
  assert.strictEqual(s.assets, 5000 + 10500 + 3000);
  // Fatura (1500) não conta como despesa; cartão (80) conta.
  assert.strictEqual(s.flow.income, 8000);
  assert.strictEqual(s.flow.expense, 600 + 40 + 80);
  const cats = Object.fromEntries(s.budget.map((b) => [b.category, b.spent]));
  assert.strictEqual(cats['Alimentação'], 640); // supermercado + padaria (regra)
  assert.strictEqual(cats['Lazer'], 80);
  assert.ok(!('Pagamento de fatura' in cats));
  assert.ok(s.allocation.find((a) => a.assetClass === 'fiis'));
  assert.ok(s.insights.some((i) => i.title.includes('Fatura do cartão')));
});

test('sincronizar de novo não duplica nada e atualiza saldos', async () => {
  ACCOUNTS[0].balance = 5200;
  const r = await j('POST', '/pluggy/sync');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.items[0].transactions, 0);
  assert.strictEqual((await j('GET', '/transactions')).body.length, 5);
  assert.strictEqual((await j('GET', '/assets')).body.length, 2);
  assert.strictEqual((await j('GET', '/accounts')).body.find((a) => a.kind === 'checking').balance, 5200);
  assert.strictEqual(calls.filter((c) => c.path === '/auth').length, 1, 'apiKey deve ser reaproveitada');
});

test('metas, regras em lote e remoção do vínculo', async () => {
  const g = (await j('POST', '/goals', { name: 'Reserva', targetAmount: 30000, savedAmount: 5000, deadline: '2027-12-31' })).body;
  assert.strictEqual(g.savedAmount, 5000);
  assert.strictEqual((await j('PUT', `/goals/${g.id}`, { name: 'Reserva', targetAmount: 30000, savedAmount: 7000, deadline: '2027-12-31' })).body.savedAmount, 7000);
  assert.strictEqual((await j('POST', '/goals', { name: 'X', targetAmount: 0, deadline: '2027-12-31' })).status, 400);

  await j('POST', '/transactions', { accountId: (await j('GET', '/accounts')).body[0].id, type: 'expense', description: 'UBER TRIP', amount: 30, date: today });
  await j('POST', '/rules', { keyword: 'uber', category: 'Transporte' });
  const applied = (await j('POST', '/rules/apply')).body;
  assert.ok(applied.changed >= 1);

  assert.strictEqual((await j('DELETE', '/pluggy/items/item-ok')).status, 204);
  assert.strictEqual((await j('GET', '/accounts')).body.length, 2); // dados importados permanecem
});

test('sem credenciais configuradas, a API responde 503 de forma clara', async () => {
  const other = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '3094', SOBRAI_DB: path.join(tmp, 'b.db'), PLUGGY_CLIENT_ID: '', PLUGGY_CLIENT_SECRET: '' },
    stdio: 'ignore',
  });
  try {
    let res;
    for (let i = 0; i < 50 && !res; i++) {
      try { res = await fetch('http://localhost:3094/api/mixco/pluggy/connect-token', { method: 'POST' }); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    assert.strictEqual(res.status, 503);
    assert.match((await res.json()).message, /PLUGGY_CLIENT_ID/);
  } finally { other.kill(); }
});
