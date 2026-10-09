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
