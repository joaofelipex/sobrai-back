const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, newId, validate } = require('../lib/http');

const schema = {
  name: { type: 'string', required: true },
  document: { type: 'string' },
};

router.get('/', wrap(async (req, res) => {
  const db = await openDb();
  res.json(await db.all('SELECT * FROM clients ORDER BY name'));
}));

router.post('/', wrap(async (req, res) => {
  const c = { id: newId(), document: null, ...validate(req.body, schema) };
  const db = await openDb();
  await db.run('INSERT INTO clients (id, name, document) VALUES (?, ?, ?)', [c.id, c.name, c.document]);
  res.status(201).json(c);
}));

router.put('/:id', wrap(async (req, res) => {
  const c = { document: null, ...validate(req.body, schema) };
  const db = await openDb();
  const result = await db.run('UPDATE clients SET name = ?, document = ? WHERE id = ?', [c.name, c.document, req.params.id]);
  if (!result.changes) return res.status(404).json({ message: 'Client not found' });
  res.json(await db.get('SELECT * FROM clients WHERE id = ?', req.params.id));
}));

router.delete('/:id', wrap(async (req, res) => {
  const db = await openDb();
  const used = await db.get('SELECT COUNT(*) AS n FROM invoices WHERE clientId = ?', req.params.id);
  if (used.n > 0) {
    return res.status(409).json({ message: 'Cliente possui notas fiscais e não pode ser excluído' });
  }
  const result = await db.run('DELETE FROM clients WHERE id = ?', req.params.id);
  if (!result.changes) return res.status(404).json({ message: 'Client not found' });
  res.status(204).send();
}));

module.exports = router;
