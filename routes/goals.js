const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, newId, validate } = require('../lib/http');

const schema = {
  name: { type: 'string', required: true },
  type: { type: 'string', required: true, oneOf: ['revenue', 'savings'] },
  targetAmount: { type: 'number', required: true, positive: true },
  deadline: { type: 'date', required: true },
};

router.get('/', wrap(async (req, res) => {
  const db = await openDb();
  res.json(await db.all('SELECT * FROM goals'));
}));

router.post('/', wrap(async (req, res) => {
  const g = { id: newId(), ...validate(req.body, schema) };
  const db = await openDb();
  await db.run(
    'INSERT INTO goals (id, name, type, targetAmount, deadline) VALUES (?, ?, ?, ?, ?)',
    [g.id, g.name, g.type, g.targetAmount, g.deadline]
  );
  res.status(201).json(g);
}));

router.put('/:id', wrap(async (req, res) => {
  const g = validate(req.body, schema);
  const db = await openDb();
  const result = await db.run(
    'UPDATE goals SET name = ?, type = ?, targetAmount = ?, deadline = ? WHERE id = ?',
    [g.name, g.type, g.targetAmount, g.deadline, req.params.id]
  );
  if (!result.changes) return res.status(404).json({ message: 'Goal not found' });
  res.json(await db.get('SELECT * FROM goals WHERE id = ?', req.params.id));
}));

router.delete('/:id', wrap(async (req, res) => {
  const db = await openDb();
  const result = await db.run('DELETE FROM goals WHERE id = ?', req.params.id);
  if (!result.changes) return res.status(404).json({ message: 'Goal not found' });
  res.status(204).send();
}));

module.exports = router;
