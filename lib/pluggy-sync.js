// Importa contas, lançamentos e investimentos da Pluggy para as tabelas mx_*.
// Idempotente: tudo é identificado por externalId, então sincronizar de novo não duplica.
const crypto = require('crypto');
const pluggy = require('./pluggy');

// Categorias que só movem dinheiro entre contas suas: não são renda nem gasto.
const INTERNAL_CATEGORIES = ['Pagamento de fatura', 'Transferência interna'];

// Categorias da Pluggy (em inglês) -> categorias do MiXCo. Heurística por trecho do nome.
const CATEGORY_MAP = [
  [/credit card payment/i, 'Pagamento de fatura'],
  [/same person transfer|own account transfer/i, 'Transferência interna'],
  [/grocer|supermarket|restaurant|eating out|food|delivery|bakery/i, 'Alimentação'],
  [/rent|housing|utilit|electric|water|internet|telecom|condo|home/i, 'Moradia'],
  [/transport|taxi|ride|fuel|gas station|parking|toll|public transit|auto/i, 'Transporte'],
  [/health|pharmac|doctor|dental|gym|wellness|insurance/i, 'Saúde'],
  [/educat|school|course|book/i, 'Educação'],
  [/subscription|streaming|digital service|software/i, 'Assinaturas'],
  [/entertain|leisure|travel|hotel|shopping|clothing|gaming|bar/i, 'Lazer'],
  [/tax|fee|fine|iof/i, 'Impostos'],
  [/salary|payroll|wage/i, 'Salário'],
  [/interest|dividend|yield|investment income/i, 'Rendimentos'],
];

const mapCategory = (pluggyCategory) => {
  if (!pluggyCategory) return 'Outros';
  const hit = CATEGORY_MAP.find(([re]) => re.test(pluggyCategory));
  return hit ? hit[1] : 'Outros';
};

const ASSET_CLASS = {
  FIXED_INCOME: 'renda_fixa', MUTUAL_FUND: 'renda_fixa', EQUITY: 'renda_variavel', ETF: 'renda_variavel',
  SECURITY: 'outros', COE: 'renda_fixa', OTHER: 'outros',
};
const assetClassOf = (inv) => {
  if (/REAL_ESTATE|FII/i.test(`${inv.subtype || ''}`)) return 'fiis';
  if (/PENSION|PREVIDENCIA/i.test(`${inv.subtype || ''} ${inv.name || ''}`)) return 'previdencia';
  if (/CRYPTO/i.test(`${inv.type || ''} ${inv.subtype || ''}`)) return 'cripto';
  return ASSET_CLASS[inv.type] || 'outros';
};

const accountKind = (a) => {
  if (a.type === 'CREDIT') return 'credit';
  return /SAVINGS/i.test(a.subtype || '') ? 'savings' : 'checking';
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const ymd = (d) => d.toISOString().slice(0, 10);

let running = false;

/** Aplica as regras do usuário (palavra na descrição) antes do mapeamento da Pluggy. */
function categorize(rules, description, pluggyCategory) {
  const d = (description || '').toLowerCase();
  const rule = rules.find((r) => d.includes(r.keyword.toLowerCase()));
  return rule ? rule.category : mapCategory(pluggyCategory);
}

async function syncItem(db, itemId) {
  const now = new Date().toISOString();
  const rules = await db.all('SELECT keyword, category FROM mx_rules');
  const row = await db.get('SELECT lastSyncAt FROM mx_pluggy_items WHERE itemId = ?', itemId);
  // Primeira vez: 90 dias. Depois: desde a última sincronização, com 7 dias de folga para pendentes.
  const since = row?.lastSyncAt ? new Date(new Date(row.lastSyncAt).getTime() - 7 * 86400000) : new Date(Date.now() - 90 * 86400000);
  const stats = { accounts: 0, transactions: 0, investments: 0 };

  const item = await pluggy.getItem(itemId);
  const accounts = await pluggy.listAccounts(itemId);

  for (const a of accounts) {
    const kind = accountKind(a);
    // Cartão: a Pluggy informa o valor devido (positivo); no MiXCo dívida é saldo negativo.
    const balance = kind === 'credit' ? -Math.abs(num(a.balance)) : num(a.balance);
    const name = a.marketingName || a.name || 'Conta';
    const existing = await db.get('SELECT id FROM mx_accounts WHERE externalId = ?', a.id);
    let accountId = existing?.id;
    if (accountId) {
      await db.run('UPDATE mx_accounts SET externalBalance = ?, itemId = ? WHERE id = ?', [balance, itemId, accountId]);
    } else {
      accountId = crypto.randomUUID();
      await db.run(
        `INSERT INTO mx_accounts (id, name, kind, institution, initialBalance, source, externalId, itemId, externalBalance)
         VALUES (?, ?, ?, ?, 0, 'pluggy', ?, ?, ?)`,
        [accountId, name, kind, item?.connector?.name || null, a.id, itemId, balance]
      );
    }
    stats.accounts++;

    for (const t of await pluggy.listTransactions(a.id, ymd(since), ymd(new Date()))) {
      if (t.status === 'PENDING') continue; // só entra o que foi efetivado
      const type = t.type === 'CREDIT' ? 'income' : 'expense';
      const amount = Math.abs(num(t.amountInAccountCurrency ?? t.amount));
      if (!amount) continue;
      const res = await db.run(
        `INSERT OR IGNORE INTO mx_transactions (id, accountId, type, description, amount, date, category, externalId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), accountId, type, t.description || 'Sem descrição', amount, String(t.date).slice(0, 10),
          categorize(rules, t.description, t.category), t.id]
      );
      stats.transactions += res.changes;
    }
  }

  for (const inv of await pluggy.listInvestments(itemId)) {
    const current = num(inv.balance ?? inv.value);
    const invested = inv.amountOriginal != null ? num(inv.amountOriginal) : current - num(inv.amountProfit);
    const res = await db.run(
      `INSERT INTO mx_assets (id, name, assetClass, institution, invested, currentValue, updatedAt, source, externalId, itemId)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pluggy', ?, ?)
       ON CONFLICT(externalId) WHERE externalId IS NOT NULL DO UPDATE SET name = excluded.name, assetClass = excluded.assetClass,
         invested = excluded.invested, currentValue = excluded.currentValue, updatedAt = excluded.updatedAt`,
      [crypto.randomUUID(), inv.name || 'Investimento', assetClassOf(inv), item?.connector?.name || null,
        invested, current, now, inv.id, itemId]
    );
    if (res.changes) stats.investments++;
  }

  await db.run(
    'UPDATE mx_pluggy_items SET connector = ?, status = ?, lastSyncAt = ?, lastError = NULL WHERE itemId = ?',
    [item?.connector?.name || null, item?.status || null, now, itemId]
  );
  return stats;
}

/** Sincroniza todas as conexões; um erro numa conexão não impede as outras. */
async function syncAll(db) {
  if (running) return { skipped: true, items: [] };
  running = true;
  try {
    const items = [];
    for (const { itemId } of await db.all('SELECT itemId FROM mx_pluggy_items')) {
      try {
        items.push({ itemId, ...(await syncItem(db, itemId)) });
      } catch (err) {
        await db.run('UPDATE mx_pluggy_items SET lastError = ? WHERE itemId = ?', [err.message, itemId]);
        items.push({ itemId, error: err.message });
      }
    }
    return { skipped: false, items };
  } finally {
    running = false;
  }
}

module.exports = { syncItem, syncAll, mapCategory, categorize, INTERNAL_CATEGORIES };
