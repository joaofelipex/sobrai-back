const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const DB_FILE = process.env.SOBRAI_DB || path.join(__dirname, 'sobrai.db');

// Conexão única reaproveitada por todas as rotas.
let dbPromise = null;
const openDb = () => {
  if (!dbPromise) {
    dbPromise = open({ filename: DB_FILE, driver: sqlite3.Database }).then(async (db) => {
      await db.exec('PRAGMA foreign_keys = ON;');
      return db;
    });
  }
  return dbPromise;
};

const columnsOf = async (db, table) =>
  (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);

const initDb = async () => {
  const db = await openDb();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      category TEXT,
      invoiceId TEXT
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      document TEXT
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      targetAmount REAL NOT NULL,
      deadline TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      clientId TEXT NOT NULL,
      description TEXT,
      amount REAL NOT NULL,
      taxAmount REAL NOT NULL,
      issueDate TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'issued'
    );

    CREATE TABLE IF NOT EXISTS recurring_transactions (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      category TEXT,
      frequency TEXT NOT NULL DEFAULT 'monthly',
      startDate TEXT NOT NULL,
      nextDueDate TEXT NOT NULL,
      isActive INTEGER NOT NULL DEFAULT 1
    );

    -- NFS-e Nacional: dados fiscais do emitente (linha única)
    CREATE TABLE IF NOT EXISTS fiscal_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cnpj TEXT NOT NULL,
      inscricaoMunicipal TEXT,
      codMunicipioIbge TEXT NOT NULL,
      opSimpNac TEXT NOT NULL,
      regApTribSN TEXT,
      regEspTrib TEXT NOT NULL DEFAULT '0',
      serie TEXT NOT NULL DEFAULT '1',
      proximoNumero INTEGER NOT NULL DEFAULT 1,
      codTribNac TEXT NOT NULL,
      codTribMun TEXT,
      aliquotaIss REAL
    );

    -- Certificado A1 (.pfx) e senha, sempre criptografados (ver lib/nfse/secret-store.js)
    CREATE TABLE IF NOT EXISTS fiscal_certificate (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pfxEnc TEXT NOT NULL,
      passEnc TEXT NOT NULL,
      subject TEXT,
      validFrom TEXT,
      validTo TEXT,
      uploadedAt TEXT NOT NULL
    );

    -- Uma linha por tentativa de emissão de NFS-e para uma nota fiscal
    CREATE TABLE IF NOT EXISTS nfse_documents (
      id TEXT PRIMARY KEY,
      invoiceId TEXT NOT NULL,
      ambiente INTEGER NOT NULL,
      dpsId TEXT NOT NULL,
      nDPS INTEGER NOT NULL,
      status TEXT NOT NULL,
      chaveAcesso TEXT,
      numeroNfse TEXT,
      xmlDps TEXT,
      xmlNfse TEXT,
      erro TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nfse_invoice ON nfse_documents(invoiceId);
    -- Garante no banco que uma nota fiscal não tenha duas NFS-e em andamento/autorizadas.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_nfse_active ON nfse_documents(invoiceId) WHERE status IN ('processing', 'authorized');
  `);

  // MiXCo: gestão de patrimônio pessoal (tabelas com prefixo mx_, independentes do restante).
  await db.exec(`
    CREATE TABLE IF NOT EXISTS mx_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      institution TEXT,
      initialBalance REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS mx_transactions (
      id TEXT PRIMARY KEY,
      accountId TEXT NOT NULL REFERENCES mx_accounts(id),
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Outros'
    );
    CREATE INDEX IF NOT EXISTS idx_mx_tx_date ON mx_transactions(date);
    CREATE INDEX IF NOT EXISTS idx_mx_tx_account ON mx_transactions(accountId);

    CREATE TABLE IF NOT EXISTS mx_assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      assetClass TEXT NOT NULL,
      institution TEXT,
      invested REAL NOT NULL DEFAULT 0,
      currentValue REAL NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mx_liabilities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      balance REAL NOT NULL,
      monthlyRate REAL,
      monthlyPayment REAL
    );

    CREATE TABLE IF NOT EXISTS mx_budgets (
      category TEXT PRIMARY KEY,
      monthlyLimit REAL NOT NULL
    );

    -- Uma foto do patrimônio por mês (o mês corrente é atualizado a cada consulta do resumo).
    CREATE TABLE IF NOT EXISTS mx_snapshots (
      month TEXT PRIMARY KEY,
      assets REAL NOT NULL,
      liabilities REAL NOT NULL,
      netWorth REAL NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);

  // MiXCo: colunas da integração Pluggy (open finance) e tabelas de metas, regras e conexões.
  const addColumn = async (table, col, ddl) => {
    if (!(await columnsOf(db, table)).includes(col)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  };
  await addColumn('mx_accounts', 'source', "TEXT NOT NULL DEFAULT 'manual'");
  await addColumn('mx_accounts', 'externalId', 'TEXT');
  await addColumn('mx_accounts', 'itemId', 'TEXT');
  await addColumn('mx_accounts', 'externalBalance', 'REAL');
  await addColumn('mx_transactions', 'externalId', 'TEXT');
  await addColumn('mx_assets', 'source', "TEXT NOT NULL DEFAULT 'manual'");
  await addColumn('mx_assets', 'externalId', 'TEXT');
  await addColumn('mx_assets', 'itemId', 'TEXT');
  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mx_acc_ext ON mx_accounts(externalId) WHERE externalId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mx_tx_ext ON mx_transactions(externalId) WHERE externalId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_mx_asset_ext ON mx_assets(externalId) WHERE externalId IS NOT NULL;

    CREATE TABLE IF NOT EXISTS mx_pluggy_items (
      itemId TEXT PRIMARY KEY,
      connector TEXT,
      status TEXT,
      lastSyncAt TEXT,
      lastError TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mx_goals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      targetAmount REAL NOT NULL,
      savedAmount REAL NOT NULL DEFAULT 0,
      deadline TEXT NOT NULL
    );

    -- Contas fixas (aluguel, assinaturas, parcelas): vencem em um dia do mês.
    CREATE TABLE IF NOT EXISTS mx_recurring (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      dayOfMonth INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'Outros'
    );

    -- Lançamentos importados que o usuário apagou: a sincronização não os traz de volta.
    CREATE TABLE IF NOT EXISTS mx_tombstones (
      externalId TEXT PRIMARY KEY
    );

    -- Regras de categorização: se a descrição contém a palavra, usa a categoria.
    CREATE TABLE IF NOT EXISTS mx_rules (
      id TEXT PRIMARY KEY,
      keyword TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL
    );
  `);

  // Migração: transações antigas não tinham invoiceId.
  if (!(await columnsOf(db, 'transactions')).includes('invoiceId')) {
    await db.exec('ALTER TABLE transactions ADD COLUMN invoiceId TEXT');
  }

  // Migração: o schema antigo do perfil (industry, size...) não correspondia ao model do front.
  const profileCols = await columnsOf(db, 'company_profile');
  if (profileCols.length && !profileCols.includes('monthlyRevenue')) {
    await db.exec('DROP TABLE company_profile');
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS company_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      monthlyRevenue REAL NOT NULL DEFAULT 0,
      cnpj TEXT,
      phone TEXT,
      email TEXT,
      address TEXT
    );
  `);

  // Emissões interrompidas (servidor caiu no meio): o resultado na SEFIN é desconhecido.
  await db.run(
    `UPDATE nfse_documents SET status = 'indeterminate', updatedAt = ?,
       erro = 'Emissão interrompida; confira no portal da NFS-e se a nota foi autorizada antes de tentar de novo'
     WHERE status = 'processing'`,
    new Date().toISOString()
  );

  console.log('Database initialized');
  return db;
};

module.exports = { initDb, openDb };
