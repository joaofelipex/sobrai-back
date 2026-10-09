const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, newId, validate } = require('../lib/http');

const schema = {
  type: { type: 'string', required: true, oneOf: ['revenue', 'expense'] },
  description: { type: 'string', required: true },
  amount: { type: 'number', required: true, positive: true },
  date: { type: 'date', required: true },
  category: { type: 'string' },
  invoiceId: { type: 'string' },
};

router.get('/', wrap(async (req, res) => {
  const db = await openDb();
  res.json(await db.all('SELECT * FROM transactions ORDER BY date DESC'));
}));

router.post('/', wrap(async (req, res) => {
  const t = { id: newId(), category: null, invoiceId: null, ...validate(req.body, schema) };
  const db = await openDb();
  await db.run(
    'INSERT INTO transactions (id, type, description, amount, date, category, invoiceId) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [t.id, t.type, t.description, t.amount, t.date, t.category, t.invoiceId]
  );
  res.status(201).json(t);
}));

router.put('/:id', wrap(async (req, res) => {
  const t = { category: null, invoiceId: null, ...validate(req.body, schema) };
  const db = await openDb();
  const result = await db.run(
    'UPDATE transactions SET type = ?, description = ?, amount = ?, date = ?, category = ?, invoiceId = ? WHERE id = ?',
    [t.type, t.description, t.amount, t.date, t.category, t.invoiceId, req.params.id]
  );
  if (!result.changes) return res.status(404).json({ message: 'Transaction not found' });
  res.json(await db.get('SELECT * FROM transactions WHERE id = ?', req.params.id));
}));

router.delete('/:id', wrap(async (req, res) => {
  const db = await openDb();
  const result = await db.run('DELETE FROM transactions WHERE id = ?', req.params.id);
  if (!result.changes) return res.status(404).json({ message: 'Transaction not found' });
  res.status(204).send();
}));

module.exports = router;
