const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, newId, validate } = require('../lib/http');

const STATUSES = ['issued', 'paid', 'canceled'];

const createSchema = {
  clientId: { type: 'string', required: true },
  description: { type: 'string' },
  amount: { type: 'number', required: true, positive: true },
  taxAmount: { type: 'number', required: true },
  issueDate: { type: 'date', required: true },
  status: { type: 'string', oneOf: STATUSES },
};

router.get('/', wrap(async (req, res) => {
  const db = await openDb();
  res.json(await db.all('SELECT * FROM invoices ORDER BY issueDate DESC'));
}));

router.post('/', wrap(async (req, res) => {
  const inv = { id: newId(), description: null, status: 'issued', ...validate(req.body, createSchema) };
  const db = await openDb();
  if (!(await db.get('SELECT id FROM clients WHERE id = ?', inv.clientId))) {
    return res.status(400).json({ message: 'Cliente não encontrado' });
  }
  await db.run(
    'INSERT INTO invoices (id, clientId, description, amount, taxAmount, issueDate, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [inv.id, inv.clientId, inv.description, inv.amount, inv.taxAmount, inv.issueDate, inv.status]
  );
  res.status(201).json(inv);
}));

// Uma nota com NFS-e autorizada é documento fiscal: só sai de cena cancelando a NFS-e.
const hasAuthorizedNfse = async (db, invoiceId) =>
  !!(await db.get("SELECT id FROM nfse_documents WHERE invoiceId = ? AND status = 'authorized'", invoiceId));

// PATCH: atualiza apenas o status (paga / cancelada).
router.patch('/:id', wrap(async (req, res) => {
  const { status } = validate(req.body, { status: { type: 'string', required: true, oneOf: STATUSES } });
  const db = await openDb();
  if (status === 'canceled' && (await hasAuthorizedNfse(db, req.params.id))) {
    return res.status(409).json({ message: 'Esta nota tem NFS-e autorizada. Cancele a NFS-e primeiro.' });
  }
  const result = await db.run('UPDATE invoices SET status = ? WHERE id = ?', [status, req.params.id]);
  if (!result.changes) return res.status(404).json({ message: 'Invoice not found' });
  res.json(await db.get('SELECT * FROM invoices WHERE id = ?', req.params.id));
}));

// DELETE: remove a nota e a receita gerada por ela.
router.delete('/:id', wrap(async (req, res) => {
  const db = await openDb();
  if (await hasAuthorizedNfse(db, req.params.id)) {
    return res.status(409).json({ message: 'Esta nota tem NFS-e autorizada e não pode ser excluída. Cancele a NFS-e primeiro.' });
  }
  const result = await db.run('DELETE FROM invoices WHERE id = ?', req.params.id);
  if (!result.changes) return res.status(404).json({ message: 'Invoice not found' });
  await db.run('DELETE FROM transactions WHERE invoiceId = ?', req.params.id);
  res.status(204).send();
}));

module.exports = router;
