// Import the sqlite3 module, which is a driver for SQLite.
// The verbose() method enables verbose logging for easier debugging.
const sqlite3 = require('sqlite3').verbose();

// Import the 'sqlite' package, which provides a Promise-based API for interacting with SQLite.
const { open } = require('sqlite');

// Define the name of the database file.
const DB_FILE = 'sobrai.db';

// an async function to open the database connection.
const openDb = async () => {
  // The 'open' function returns a Promise that resolves to a database object.
  // The 'filename' property specifies the path to the database file.
  // The 'driver' property specifies the database driver to use.
  return open({
    filename: DB_FILE,
    driver: sqlite3.Database
  });
};

// an async function to initialize the database.
const initDb = async () => {
  // Open the database connection.
  const db = await openDb();
  
  // Use the 'exec' method to execute SQL commands to create the tables.
  // The 'exec' method can execute multiple SQL statements at once.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      type TEXT,
      description TEXT,
      amount REAL,
      date TEXT,
      category TEXT
    );

    CREATE TABLE IF NOT EXISTS company_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      industry TEXT,
      size TEXT,
      annualRevenue REAL,
      taxRegime TEXT,
      accountingSystem TEXT,
      bankIntegration BOOLEAN
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT,
      document TEXT
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      targetAmount REAL,
      deadline TEXT
    );
  `);

  // Log a message to the console indicating that the database has been initialized.
  console.log('Database initialized');
  
  // Return the database object.
  return db;
};

// Export the 'initDb' function and the 'openDb' function so they can be used in other modules.
module.exports = { initDb, openDb };
