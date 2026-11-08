// MiXCo — gestão de patrimônio pessoal.
// Contas e lançamentos (fluxo de caixa), bens e investimentos, dívidas, orçamento por categoria
// e um resumo que consolida tudo no patrimônio líquido.
const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, newId, validate, ValidationError } = require('../lib/http');
const { INTERNAL_CATEGORIES } = require('../lib/pluggy-sync');
const { applyRules } = require('../lib/rules');

const ACCOUNT_KINDS = ['checking', 'savings', 'cash', 'brokerage', 'credit'];
const ASSET_CLASSES = ['renda_fixa', 'renda_variavel', 'fiis', 'cripto', 'imoveis', 'veiculos', 'previdencia', 'outros'];
const LIABILITY_KINDS = ['financiamento', 'emprestimo', 'cartao', 'outros'];
// Classes que viram dinheiro rápido; entram na reserva de emergência.
const LIQUID_CLASSES = ['renda_fixa'];

// Saldo da conta: o informado pelo banco (Pluggy) ou saldo inicial + movimentos. Cartão de crédito
// devedor tem saldo negativo e conta como dívida, não como caixa.
const BALANCE_SQL = `ROUND(CASE WHEN mx_accounts.source = 'pluggy' AND mx_accounts.externalBalance IS NOT NULL
  THEN mx_accounts.externalBalance
  ELSE mx_accounts.initialBalance + COALESCE((SELECT SUM(CASE t.type WHEN 'income' THEN t.amount ELSE -t.amount END)
    FROM mx_transactions t WHERE t.accountId = mx_accounts.id), 0) END, 2)`;
// Pagamento de fatura e transferência entre contas suas não são gasto nem renda.
const REAL_FLOW = `category NOT IN (${INTERNAL_CATEGORIES.map((c) => `'${c}'`).join(', ')})`;

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

router.use('/pluggy', require('./mixco-pluggy'));

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
  select: `SELECT mx_accounts.id, mx_accounts.name, mx_accounts.kind, mx_accounts.institution, mx_accounts.initialBalance,
    mx_accounts.source, ${BALANCE_SQL} AS balance FROM mx_accounts`,
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
    row.category = row.category || (await applyRules(db, row.description)) || 'Outros';
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

// ---- Metas pessoais ---------------------------------------------------------------------
router.use('/goals', crud({
  table: 'mx_goals',
  schema: {
    name: { type: 'string', required: true },
    targetAmount: { type: 'number', required: true, positive: true },
    savedAmount: { type: 'number' },
    deadline: { type: 'date', required: true },
  },
  columns: ['name', 'targetAmount', 'savedAmount', 'deadline'],
  beforeWrite: async (db, row) => {
    if (row.savedAmount == null) row.savedAmount = 0;
    if (row.savedAmount < 0) throw new ValidationError('"savedAmount" não pode ser negativo');
    row.deadline = row.deadline.slice(0, 10);
  },
}));

// ---- Contas fixas -------------------------------------------------------------------------
router.use('/recurring', crud({
  table: 'mx_recurring',
  schema: {
    description: { type: 'string', required: true },
    type: { type: 'string', required: true, oneOf: ['income', 'expense'] },
    amount: { type: 'number', required: true, positive: true },
    dayOfMonth: { type: 'number', required: true },
    category: { type: 'string' },
  },
  columns: ['description', 'type', 'amount', 'dayOfMonth', 'category'],
  beforeWrite: async (db, row) => {
    if (!Number.isInteger(row.dayOfMonth) || row.dayOfMonth < 1 || row.dayOfMonth > 31) throw new ValidationError('"dayOfMonth" deve ser um dia de 1 a 31');
    row.category = row.category || 'Outros';
  },
  select: 'SELECT * FROM mx_recurring ORDER BY dayOfMonth',
}));

// ---- Regras de categorização --------------------------------------------------------------
const rulesRouter = crud({
  table: 'mx_rules',
  schema: { keyword: { type: 'string', required: true }, category: { type: 'string', required: true } },
  columns: ['keyword', 'category'],
  beforeWrite: async (db, row) => { row.keyword = row.keyword.trim(); },
});
// Reclassifica o que ficou em "Outros" usando as regras atuais.
router.post('/rules/apply', wrap(async (req, res) => {
  const db = await openDb();
  const rows = await db.all("SELECT id, description FROM mx_transactions WHERE category = 'Outros'");
  let changed = 0;
  for (const t of rows) {
    const category = await applyRules(db, t.description);
    if (category) { await db.run('UPDATE mx_transactions SET category = ? WHERE id = ?', [category, t.id]); changed++; }
  }
  res.json({ checked: rows.length, changed });
}));
router.use('/rules', rulesRouter);

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

// ---- Resumo: patrimônio líquido, alocação, fluxo, orçamento e alertas ---------------------
router.get('/summary', wrap(async (req, res) => {
  const db = await openDb();
  const month = req.query.month ? assertMonth(String(req.query.month)) : monthOf();

  const accounts = await db.all(`SELECT mx_accounts.kind AS kind, ${BALANCE_SQL} AS balance FROM mx_accounts`);
  const assets = await db.all('SELECT assetClass, invested, currentValue FROM mx_assets');
  const liabilities = await db.all('SELECT name, balance, monthlyRate, monthlyPayment FROM mx_liabilities');

  const cash = accounts.filter((a) => a.kind !== 'credit').reduce((s, a) => s + a.balance, 0);
  const cardDebt = accounts.filter((a) => a.kind === 'credit').reduce((s, a) => s + Math.max(0, -a.balance), 0);
  const assetsTotal = cash + assets.reduce((s, a) => s + a.currentValue, 0);
  const liabilitiesTotal = liabilities.reduce((s, l) => s + l.balance, 0) + cardDebt;
  const netWorth = assetsTotal - liabilitiesTotal;

  // Alocação por classe (o caixa das contas entra como "caixa").
  const byClass = new Map();
  if (cash > 0) byClass.set('caixa', cash);
  for (const a of assets) byClass.set(a.assetClass, (byClass.get(a.assetClass) || 0) + a.currentValue);
  const allocationBase = [...byClass.values()].reduce((s, v) => s + v, 0);
  const allocation = [...byClass.entries()]
    .map(([assetClass, value]) => ({ assetClass, value: round2(value), percent: allocationBase ? round2((value / allocationBase) * 100) : 0 }))
    .sort((a, b) => b.value - a.value);

  const invested = assets.reduce((s, a) => s + a.invested, 0);
  const current = assets.reduce((s, a) => s + a.currentValue, 0);

  const flowOf = (m) => db.get(
    `SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS income,
            COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS expense
     FROM mx_transactions WHERE substr(date, 1, 7) = ? AND ${REAL_FLOW}`, m);
  const flow = await flowOf(month);
  const prevFlow = await flowOf(shiftMonth(month, -1));
  const saved = flow.income - flow.expense;

  // Tendência dos últimos 6 meses (até o mês escolhido).
  const trend = [];
  for (let i = 5; i >= 0; i--) {
    const m = shiftMonth(month, -i);
    const f = i === 0 ? flow : await flowOf(m);
    trend.push({ month: m, income: round2(f.income), expense: round2(f.expense), saved: round2(f.income - f.expense) });
  }

  // Orçamento: gasto do mês por categoria (e mês anterior, para comparar), com o limite se existir.
  const spentIn = async (m) => new Map((await db.all(
    `SELECT category, SUM(amount) AS spent FROM mx_transactions
     WHERE type = 'expense' AND substr(date, 1, 7) = ? AND ${REAL_FLOW} GROUP BY category`, m)).map((r) => [r.category, r.spent]));
  const spentBy = await spentIn(month);
  const prevSpentBy = await spentIn(shiftMonth(month, -1));
  const limits = new Map((await db.all('SELECT * FROM mx_budgets')).map((b) => [b.category, b.monthlyLimit]));
  const categories = new Set([...spentBy.keys(), ...limits.keys()]);
  const budget = [...categories].map((category) => {
    const sp = spentBy.get(category) || 0;
    const limit = limits.get(category) ?? null;
    return {
      category, spent: round2(sp), previous: round2(prevSpentBy.get(category) || 0), limit,
      percent: limit ? round2((sp / limit) * 100) : null, over: limit != null && sp > limit,
    };
  }).sort((a, b) => b.spent - a.spent);

  // Reserva de emergência: liquidez ÷ despesa média dos 3 meses anteriores ao mês escolhido.
  const past = await db.get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM mx_transactions
     WHERE type = 'expense' AND substr(date, 1, 7) >= ? AND substr(date, 1, 7) < ? AND ${REAL_FLOW}`, [shiftMonth(month, -3), month]);
  const avgExpense = past.total / 3;
  const liquid = Math.max(cash, 0) + assets.filter((a) => LIQUID_CLASSES.includes(a.assetClass)).reduce((s, a) => s + a.currentValue, 0);
  const emergencyMonths = avgExpense > 0 ? round2(liquid / avgExpense) : null;

  const { n: uncategorized } = await db.get(
    "SELECT COUNT(*) AS n FROM mx_transactions WHERE category = 'Outros' AND substr(date, 1, 7) = ?", month);

  // Foto do mês corrente (curva de evolução do patrimônio).
  if (month === monthOf()) {
    await db.run(
      `INSERT INTO mx_snapshots (month, assets, liabilities, netWorth, updatedAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(month) DO UPDATE SET assets = excluded.assets, liabilities = excluded.liabilities,
         netWorth = excluded.netWorth, updatedAt = excluded.updatedAt`,
      [month, round2(assetsTotal), round2(liabilitiesTotal), round2(netWorth), new Date().toISOString()]
    );
  }
  const history = (await db.all('SELECT month, assets, liabilities, netWorth FROM mx_snapshots ORDER BY month DESC LIMIT 12')).reverse();

  // ---- Contas fixas do mês: o que já foi pago (há lançamento com a mesma descrição) e o que falta ----
  const today = new Date();
  const isCurrent = month === monthOf(today);
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const monthTx = await db.all("SELECT description, type FROM mx_transactions WHERE substr(date, 1, 7) = ?", month);
  const upcoming = (await db.all('SELECT * FROM mx_recurring ORDER BY dayOfMonth')).map((r) => {
    const day = Math.min(r.dayOfMonth, lastDay);
    const key = r.description.toLowerCase();
    const paid = monthTx.some((t) => t.type === r.type && t.description.toLowerCase().includes(key));
    return { id: r.id, description: r.description, type: r.type, amount: r.amount, category: r.category, day, paid,
      overdue: isCurrent && !paid && day < today.getDate() };
  });
  const pending = upcoming.filter((u) => !u.paid);
  const pendingOut = pending.filter((u) => u.type === 'expense').reduce((s, u) => s + u.amount, 0);
  const pendingIn = pending.filter((u) => u.type === 'income').reduce((s, u) => s + u.amount, 0);
  const projectedBalance = cash - cardDebt - pendingOut + pendingIn;

  // ---- Alertas: o que fazer agora, em ordem de urgência ----
  const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const insights = [];
  const add = (level, title, text, link) => insights.push({ level, title, text, link });
  const monthlyPayments = liabilities.reduce((s, l) => s + (l.monthlyPayment || 0), 0);

  if (flow.income > 0 || flow.expense > 0) {
    if (saved < 0) add('alert', 'Você gastou mais do que ganhou', `O mês fecha ${brl(-saved)} no vermelho. Corte as maiores categorias ou adie compras.`, '/mixco/fluxo');
    else if (flow.income > 0 && saved / flow.income < 0.2) add('warn', 'Poupança abaixo de 20%', `Você guardou ${round2((saved / flow.income) * 100)}% da renda. Uma referência comum é 20% ou mais.`, '/mixco/fluxo');
    else if (flow.income > 0) add('ok', 'Boa taxa de poupança', `Você guardou ${round2((saved / flow.income) * 100)}% da renda neste mês.`);
  }
  for (const b of budget.filter((x) => x.over)) {
    add('alert', `${b.category} passou do limite`, `Gasto de ${brl(b.spent)} para um limite de ${brl(b.limit)} (${brl(b.spent - b.limit)} acima).`, '/mixco/fluxo');
  }
  if (flow.expense > 0 && !limits.size) add('info', 'Defina um orçamento', 'Sem limites por categoria não dá para saber se o gasto está sob controle. Comece pelas 3 maiores categorias.', '/mixco/fluxo');
  if (emergencyMonths !== null) {
    if (emergencyMonths < 3) add('alert', 'Reserva de emergência baixa', `Sua liquidez cobre ${emergencyMonths} meses de despesas. Priorize chegar a 6.`, '/mixco/metas');
    else if (emergencyMonths < 6) add('warn', 'Reserva de emergência em construção', `Cobre ${emergencyMonths} meses; a meta usual é 6.`, '/mixco/metas');
  }
  if (cardDebt > 0 && liquid >= cardDebt) add('info', 'Fatura do cartão em aberto', `Há ${brl(cardDebt)} no cartão e você tem liquidez para pagar. Evite o rotativo.`);
  else if (cardDebt > 0) add('alert', 'Fatura maior que a liquidez', `O cartão deve ${brl(cardDebt)} e sua liquidez é ${brl(liquid)}.`);
  for (const l of liabilities.filter((x) => (x.monthlyRate || 0) >= 2)) {
    add('warn', `Juros altos: ${l.name}`, `${l.monthlyRate}% ao mês. Dívidas caras costumam render mais pagar do que investir (método avalanche: quite a de maior juros primeiro).`, '/mixco/patrimonio');
  }
  if (flow.income > 0 && monthlyPayments / flow.income > 0.3) {
    add('warn', 'Parcelas pesam na renda', `As parcelas somam ${round2((monthlyPayments / flow.income) * 100)}% da renda do mês (referência: até 30%).`, '/mixco/patrimonio');
  }
  const financial = allocation.filter((a) => !['imoveis', 'veiculos'].includes(a.assetClass));
  const financialBase = financial.reduce((s, a) => s + a.value, 0);
  const top = financial[0];
  if (top && financial.length > 1 && financialBase > 0 && top.value / financialBase > 0.7) {
    add('info', 'Carteira concentrada', `${round2((top.value / financialBase) * 100)}% do patrimônio financeiro está em "${top.assetClass}". Considere diversificar.`);
  }
  if (uncategorized > 0) add('info', `${uncategorized} lançamento(s) sem categoria`, 'Categorize para o orçamento refletir a realidade. Crie regras para automatizar.', '/mixco/fluxo');
  const overdue = upcoming.filter((u) => u.overdue && u.type === 'expense');
  if (overdue.length) add('alert', `${overdue.length} conta(s) fixa(s) sem registro`, `${overdue.map((o) => o.description).join(', ')}: o dia passou e não há lançamento. Já pagou? Registre ou sincronize.`, '/mixco/fluxo');
  if (isCurrent && pendingOut > 0 && projectedBalance < 0) add('alert', 'Saldo não cobre as contas até o fim do mês', `Faltam ${brl(pendingOut)} em contas fixas e a projeção fecha em ${brl(projectedBalance)} (já descontada a fatura do cartão).`, '/mixco/fluxo');
  const order = { alert: 0, warn: 1, info: 2, ok: 3 };
  insights.sort((a, b) => order[a.level] - order[b.level]);

  res.json({
    month,
    netWorth: round2(netWorth),
    assets: round2(assetsTotal),
    liabilities: round2(liabilitiesTotal),
    cash: round2(cash),
    cardDebt: round2(cardDebt),
    debtToAssets: assetsTotal > 0 ? round2((liabilitiesTotal / assetsTotal) * 100) : null,
    monthlyDebtPayments: round2(monthlyPayments),
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
      previousExpense: round2(prevFlow.expense),
    },
    trend,
    budget,
    uncategorized,
    upcoming,
    projection: { pendingOut: round2(pendingOut), pendingIn: round2(pendingIn), projectedBalance: round2(projectedBalance) },
    emergencyFund: { liquid: round2(liquid), avgMonthlyExpense: round2(avgExpense), months: emergencyMonths },
    insights,
    history,
  });
}));

module.exports = router;
