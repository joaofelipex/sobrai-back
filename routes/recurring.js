const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, newId, validate } = require('../lib/http');

const schema = {
  description: { type: 'string', required: true },
  amount: { type: 'number', required: true, positive: true },
  type: { type: 'string', required: true, oneOf: ['revenue', 'expense'] },
  category: { type: 'string' },
  frequency: { type: 'string', oneOf: ['monthly'] },
  startDate: { type: 'date', required: true },
  nextDueDate: { type: 'date', required: true },
  isActive: { type: 'boolean' },
};

const toApi = (r) => ({ ...r, isActive: !!r.isActive });
const withDefaults = (r) => ({ category: null, frequency: 'monthly', isActive: true, ...r });

router.get('/', wrap(async (req, res) => {
  const db = await openDb();
  res.json((await db.all('SELECT * FROM recurring_transactions ORDER BY nextDueDate')).map(toApi));
}));

router.post('/', wrap(async (req, res) => {
  const r = { id: newId(), ...withDefaults(validate(req.body, schema)) };
  const db = await openDb();
  await db.run(
    'INSERT INTO recurring_transactions (id, description, amount, type, category, frequency, startDate, nextDueDate, isActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [r.id, r.description, r.amount, r.type, r.category, r.frequency, r.startDate, r.nextDueDate, r.isActive ? 1 : 0]
  );
  res.status(201).json(r);
}));

router.put('/:id', wrap(async (req, res) => {
  const r = withDefaults(validate(req.body, schema));
  const db = await openDb();
  const result = await db.run(
    'UPDATE recurring_transactions SET description = ?, amount = ?, type = ?, category = ?, frequency = ?, startDate = ?, nextDueDate = ?, isActive = ? WHERE id = ?',
    [r.description, r.amount, r.type, r.category, r.frequency, r.startDate, r.nextDueDate, r.isActive ? 1 : 0, req.params.id]
  );
  if (!result.changes) return res.status(404).json({ message: 'Recurring transaction not found' });
  res.json(toApi(await db.get('SELECT * FROM recurring_transactions WHERE id = ?', req.params.id)));
}));

router.delete('/:id', wrap(async (req, res) => {
  const db = await openDb();
  const result = await db.run('DELETE FROM recurring_transactions WHERE id = ?', req.params.id);
  if (!result.changes) return res.status(404).json({ message: 'Recurring transaction not found' });
  res.status(204).send();
}));

module.exports = router;
