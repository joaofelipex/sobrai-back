const express = require('express');
const router = express.Router();
const { openDb } = require('../database');

// GET all transactions
router.get('/', async (req, res) => {
  console.log('GET /api/transactions called');
  const db = await openDb();
  const transactions = await db.all('SELECT * FROM transactions');
  res.json(transactions);
});

// POST a new transaction
router.post('/', async (req, res) => {
  const { type, description, amount, date, category } = req.body;
  const newTransaction = { id: Date.now().toString(), type, description, amount, date, category };
  
  const db = await openDb();
  await db.run(
    'INSERT INTO transactions (id, type, description, amount, date, category) VALUES (?, ?, ?, ?, ?, ?)',
    [newTransaction.id, newTransaction.type, newTransaction.description, newTransaction.amount, newTransaction.date, newTransaction.category]
  );
  
  console.log('POST /api/transactions - Added:', newTransaction);
  res.status(201).json(newTransaction);
});

// PUT (update) a transaction
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { type, description, amount, date, category } = req.body;
  
  const db = await openDb();
  const result = await db.run(
    'UPDATE transactions SET type = ?, description = ?, amount = ?, date = ?, category = ? WHERE id = ?',
    [type, description, amount, date, category, id]
  );

  if (result.changes > 0) {
    const updatedTransaction = await db.get('SELECT * FROM transactions WHERE id = ?', id);
    console.log(`PUT /api/transactions/${id} - Updated:`, updatedTransaction);
    res.json(updatedTransaction);
  } else {
    res.status(404).json({ message: 'Transaction not found' });
  }
});

// DELETE a transaction
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  
  const db = await openDb();
  const result = await db.run('DELETE FROM transactions WHERE id = ?', id);

  if (result.changes > 0) {
    console.log(`DELETE /api/transactions/${id} - Deleted`);
    res.status(204).send();
  } else {
    res.status(404).json({ message: 'Transaction not found' });
  }
});

module.exports = router;
