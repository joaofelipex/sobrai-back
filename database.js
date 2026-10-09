const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

const DB_FILE = path.join(__dirname, 'sobrai.db');

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

  console.log('Database initialized');
  return db;
};

module.exports = { initDb, openDb };
