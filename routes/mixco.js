// MiXCo — gestão de patrimônio pessoal.
// Contas e lançamentos (fluxo de caixa), bens e investimentos, dívidas, orçamento por categoria
// e um resumo que consolida tudo no patrimônio líquido.
const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, newId, validate, ValidationError } = require('../lib/http');

const ACCOUNT_KINDS = ['checking', 'savings', 'cash', 'brokerage'];
const ASSET_CLASSES = ['renda_fixa', 'renda_variavel', 'fiis', 'cripto', 'imoveis', 'veiculos', 'previdencia', 'outros'];
const LIABILITY_KINDS = ['financiamento', 'emprestimo', 'cartao', 'outros'];
// Classes que viram dinheiro rápido; entram na reserva de emergência.
const LIQUID_CLASSES = ['renda_fixa'];

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const monthOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const assertMonth = (m) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new ValidationError('"month" deve estar no formato AAAA-MM');
  return m;
};
const shiftMonth = (m, delta) => {
  const [y, mo] = m.split('-').map(Number);
  return monthOf(new Date(y, mo - 1 + delta, 1));
};

/** Monta GET/POST/PUT/DELETE para uma tabela simples. `select` não pode ter WHERE no nível externo. */
function crud({ table, schema, columns, beforeWrite, beforeDelete, select }) {
  const r = express.Router();
  const list = select || `SELECT * FROM ${table}`;

  r.get('/', wrap(async (req, res) => {
    const db = await openDb();
    res.json(await db.all(list));
  }));

  r.post('/', wrap(async (req, res) => {
    const db = await openDb();
    const row = { id: newId(), ...validate(req.body, schema) };
    if (beforeWrite) await beforeWrite(db, row);
    await db.run(
      `INSERT INTO ${table} (id, ${columns.join(', ')}) VALUES (?${', ?'.repeat(columns.length)})`,
      [row.id, ...columns.map((c) => row[c] ?? null)]
    );
    res.status(201).json(await db.get(`${list} WHERE ${table}.id = ?`, row.id));
  }));

  r.put('/:id', wrap(async (req, res) => {
    const db = await openDb();
    const row = validate(req.body, schema);
    if (beforeWrite) await beforeWrite(db, row);
    const result = await db.run(
      `UPDATE ${table} SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((c) => row[c] ?? null), req.params.id]
    );
    if (!result.changes) return res.status(404).json({ message: 'Registro não encontrado' });
    res.json(await db.get(`${list} WHERE ${table}.id = ?`, req.params.id));
  }));

  r.delete('/:id', wrap(async (req, res) => {
    const db = await openDb();
    if (beforeDelete) {
      const blocked = await beforeDelete(db, req.params.id);
      if (blocked) return res.status(409).json({ message: blocked });
    }
    const result = await db.run(`DELETE FROM ${table} WHERE id = ?`, req.params.id);
    if (!result.changes) return res.status(404).json({ message: 'Registro não encontrado' });
    res.status(204).send();
  }));

  return r;
}

// ---- Contas (saldo = saldo inicial + receitas - despesas) --------------------------------
router.use('/accounts', crud({
  table: 'mx_accounts',
  schema: {
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true, oneOf: ACCOUNT_KINDS },
    institution: { type: 'string' },
    initialBalance: { type: 'number' },
  },
  columns: ['name', 'kind', 'institution', 'initialBalance'],
  beforeWrite: async (db, row) => { if (row.initialBalance == null) row.initialBalance = 0; },
  beforeDelete: async (db, id) => {
    const used = await db.get('SELECT COUNT(*) AS n FROM mx_transactions WHERE accountId = ?', id);
    return used.n ? 'A conta tem lançamentos; exclua-os antes de remover a conta' : null;
  },
  select: `SELECT mx_accounts.*, ROUND(mx_accounts.initialBalance + COALESCE((
      SELECT SUM(CASE t.type WHEN 'income' THEN t.amount ELSE -t.amount END)
      FROM mx_transactions t WHERE t.accountId = mx_accounts.id), 0), 2) AS balance
    FROM mx_accounts`,
}));

// ---- Lançamentos ------------------------------------------------------------------------
const txRouter = crud({
  table: 'mx_transactions',
  schema: {
    accountId: { type: 'string', required: true },
    type: { type: 'string', required: true, oneOf: ['income', 'expense'] },
    description: { type: 'string', required: true },
    amount: { type: 'number', required: true, positive: true },
    date: { type: 'date', required: true },
    category: { type: 'string' },
  },
  columns: ['accountId', 'type', 'description', 'amount', 'date', 'category'],
  beforeWrite: async (db, row) => {
    if (!(await db.get('SELECT 1 FROM mx_accounts WHERE id = ?', row.accountId))) {
      throw new ValidationError('"accountId" não corresponde a nenhuma conta');
    }
    row.date = row.date.slice(0, 10);
    row.category = row.category || 'Outros';
  },
});
// Lista filtrável por mês (?month=AAAA-MM), mais recentes primeiro.
router.get('/transactions', wrap(async (req, res) => {
  const db = await openDb();
  const where = req.query.month ? 'WHERE substr(date, 1, 7) = ?' : '';
  const args = req.query.month ? [assertMonth(String(req.query.month))] : [];
  res.json(await db.all(`SELECT * FROM mx_transactions ${where} ORDER BY date DESC, rowid DESC`, args));
}));
router.use('/transactions', txRouter);

// ---- Bens e investimentos ---------------------------------------------------------------
router.use('/assets', crud({
  table: 'mx_assets',
  schema: {
    name: { type: 'string', required: true },
    assetClass: { type: 'string', required: true, oneOf: ASSET_CLASSES },
    institution: { type: 'string' },
    invested: { type: 'number' },
    currentValue: { type: 'number', required: true },
  },
  columns: ['name', 'assetClass', 'institution', 'invested', 'currentValue', 'updatedAt'],
  beforeWrite: async (db, row) => {
    if (row.currentValue < 0) throw new ValidationError('"currentValue" não pode ser negativo');
    if (row.invested == null) row.invested = row.currentValue;
    row.updatedAt = new Date().toISOString();
  },
}));

// ---- Dívidas ----------------------------------------------------------------------------
router.use('/liabilities', crud({
  table: 'mx_liabilities',
  schema: {
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true, oneOf: LIABILITY_KINDS },
    balance: { type: 'number', required: true },
    monthlyRate: { type: 'number' },
    monthlyPayment: { type: 'number' },
  },
  columns: ['name', 'kind', 'balance', 'monthlyRate', 'monthlyPayment'],
  beforeWrite: async (db, row) => {
    if (row.balance < 0) throw new ValidationError('"balance" não pode ser negativo');
  },
}));

// ---- Orçamento mensal por categoria -----------------------------------------------------
router.get('/budgets', wrap(async (req, res) => {
  const db = await openDb();
  res.json(await db.all('SELECT * FROM mx_budgets ORDER BY category'));
}));
router.put('/budgets/:category', wrap(async (req, res) => {
  const { monthlyLimit } = validate(req.body, { monthlyLimit: { type: 'number', required: true, positive: true } });
  const db = await openDb();
  await db.run(
    'INSERT INTO mx_budgets (category, monthlyLimit) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthlyLimit = excluded.monthlyLimit',
    [req.params.category, monthlyLimit]
  );
  res.json({ category: req.params.category, monthlyLimit });
}));
router.delete('/budgets/:category', wrap(async (req, res) => {
  const db = await openDb();
  const result = await db.run('DELETE FROM mx_budgets WHERE category = ?', req.params.category);
  if (!result.changes) return res.status(404).json({ message: 'Orçamento não encontrado' });
  res.status(204).send();
}));

// ---- Resumo: patrimônio líquido, alocação, fluxo do mês e orçamento ---------------------
router.get('/summary', wrap(async (req, res) => {
  const db = await openDb();
  const month = req.query.month ? assertMonth(String(req.query.month)) : monthOf();

  const accounts = await db.all(`SELECT mx_accounts.initialBalance + COALESCE((
      SELECT SUM(CASE t.type WHEN 'income' THEN t.amount ELSE -t.amount END)
      FROM mx_transactions t WHERE t.accountId = mx_accounts.id), 0) AS balance FROM mx_accounts`);
  const assets = await db.all('SELECT assetClass, invested, currentValue FROM mx_assets');
  const liabilities = await db.all('SELECT balance, monthlyPayment FROM mx_liabilities');

  const cash = accounts.reduce((s, a) => s + a.balance, 0);
  const assetsTotal = cash + assets.reduce((s, a) => s + a.currentValue, 0);
  const liabilitiesTotal = liabilities.reduce((s, l) => s + l.balance, 0);
  const netWorth = assetsTotal - liabilitiesTotal;

  // Alocação por classe (caixa das contas entra como "caixa").
  const byClass = new Map();
  if (cash > 0) byClass.set('caixa', cash);
  for (const a of assets) byClass.set(a.assetClass, (byClass.get(a.assetClass) || 0) + a.currentValue);
  const allocationBase = [...byClass.values()].reduce((s, v) => s + v, 0);
  const allocation = [...byClass.entries()]
    .map(([assetClass, value]) => ({ assetClass, value: round2(value), percent: allocationBase ? round2((value / allocationBase) * 100) : 0 }))
    .sort((a, b) => b.value - a.value);

  const invested = assets.reduce((s, a) => s + a.invested, 0);
  const current = assets.reduce((s, a) => s + a.currentValue, 0);

  // Fluxo do mês escolhido.
  const flow = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
            COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
     FROM mx_transactions WHERE substr(date, 1, 7) = ?`, month);
  const saved = flow.income - flow.expense;

  // Orçamento: gasto do mês por categoria, com o limite quando existir.
  const spent = await db.all(
    `SELECT category, SUM(amount) AS spent FROM mx_transactions
     WHERE type = 'expense' AND substr(date, 1, 7) = ? GROUP BY category`, month);
  const limits = new Map((await db.all('SELECT * FROM mx_budgets')).map((b) => [b.category, b.monthlyLimit]));
  const categories = new Set([...spent.map((s) => s.category), ...limits.keys()]);
  const spentBy = new Map(spent.map((s) => [s.category, s.spent]));
  const budget = [...categories].map((category) => {
    const sp = spentBy.get(category) || 0;
    const limit = limits.get(category) ?? null;
    return { category, spent: round2(sp), limit, percent: limit ? round2((sp / limit) * 100) : null, over: limit != null && sp > limit };
  }).sort((a, b) => b.spent - a.spent);

  // Reserva de emergência: liquidez ÷ despesa média dos 3 meses anteriores ao mês escolhido.
  const from = shiftMonth(month, -3);
  const past = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM mx_transactions
     WHERE type = 'expense' AND substr(date, 1, 7) >= ? AND substr(date, 1, 7) < ?`, [from, month]);
  const avgExpense = past.total / 3;
  const liquid = Math.max(cash, 0) + assets.filter((a) => LIQUID_CLASSES.includes(a.assetClass)).reduce((s, a) => s + a.currentValue, 0);

  // Foto do mês corrente (para a curva de evolução do patrimônio).
  if (month === monthOf()) {
    await db.run(
      `INSERT INTO mx_snapshots (month, assets, liabilities, netWorth, updatedAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET assets = excluded.assets, liabilities = excluded.liabilities,
         netWorth = excluded.netWorth, updatedAt = excluded.updatedAt`,
      [month, round2(assetsTotal), round2(liabilitiesTotal), round2(netWorth), new Date().toISOString()]
    );
  }
  const history = (await db.all('SELECT month, assets, liabilities, netWorth FROM mx_snapshots ORDER BY month DESC LIMIT 12')).reverse();

  res.json({
    month,
    netWorth: round2(netWorth),
    assets: round2(assetsTotal),
    liabilities: round2(liabilitiesTotal),
    cash: round2(cash),
    debtToAssets: assetsTotal > 0 ? round2((liabilitiesTotal / assetsTotal) * 100) : null,
    monthlyDebtPayments: round2(liabilities.reduce((s, l) => s + (l.monthlyPayment || 0), 0)),
    investments: {
      invested: round2(invested),
      current: round2(current),
      profit: round2(current - invested),
      returnPercent: invested > 0 ? round2(((current - invested) / invested) * 100) : null,
    },
    allocation,
    flow: {
      income: round2(flow.income),
      expense: round2(flow.expense),
      saved: round2(saved),
      savingsRate: flow.income > 0 ? round2((saved / flow.income) * 100) : null,
    },
    budget,
    emergencyFund: {
      liquid: round2(liquid),
      avgMonthlyExpense: round2(avgExpense),
      months: avgExpense > 0 ? round2(liquid / avgExpense) : null,
    },
    history,
  });
}));

module.exports = router;
