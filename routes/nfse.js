const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, newId, validate, ValidationError } = require('../lib/http');
const secretStore = require('../lib/nfse/secret-store');
const { parsePfx } = require('../lib/nfse/certificate');
const { buildDps, buildCancelEvent } = require('../lib/nfse/dps');
const { signInf } = require('../lib/nfse/sign');
const sefin = require('../lib/nfse/sefin');

const PUBLIC_COLS = 'id, invoiceId, ambiente, dpsId, nDPS, status, chaveAcesso, numeroNfse, erro, createdAt, updatedAt';

class FiscalSetupError extends Error {}

/** Carrega dados fiscais + certificado (descriptografado só em memória). */
async function loadFiscal(db) {
  const settings = await db.get('SELECT * FROM fiscal_settings WHERE id = 1');
  if (!settings) throw new FiscalSetupError('Configure os dados fiscais antes de emitir NFS-e');
  const row = await db.get('SELECT * FROM fiscal_certificate WHERE id = 1');
  if (!row) throw new FiscalSetupError('Envie o certificado digital A1 antes de emitir NFS-e');
  let pfx, password;
  try {
    pfx = secretStore.decrypt(row.pfxEnc);
    password = secretStore.decrypt(row.passEnc).toString('utf8');
  } catch (e) {
    if (e instanceof secretStore.SecretNotConfiguredError) throw new FiscalSetupError(e.message);
    throw new FiscalSetupError('Não foi possível ler o certificado salvo (NFSE_SECRET mudou?). Envie-o novamente');
  }
  let parsed;
  try { parsed = parsePfx(pfx, password); } catch (e) { throw new FiscalSetupError(e.message); }
  return { settings, signing: parsed, tls: { pfx, passphrase: password } };
}

// Problemas de configuração viram 409 com mensagem clara, em vez de 500.
const setupGuard = (fn) => wrap(async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) {
    if (e instanceof FiscalSetupError) return res.status(409).json({ message: e.message });
    throw e;
  }
});

const update = (db, id, fields) => {
  const keys = Object.keys(fields);
  return db.run(
    `UPDATE nfse_documents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updatedAt = ? WHERE id = ?`,
    [...keys.map((k) => fields[k]), new Date().toISOString(), id]
  );
};

const publicDoc = (db, id) => db.get(`SELECT ${PUBLIC_COLS} FROM nfse_documents WHERE id = ?`, id);

// Lista as NFS-e (sem os XMLs). Filtro opcional: ?invoiceId=
router.get('/', wrap(async (req, res) => {
  const db = await openDb();
  const rows = req.query.invoiceId
    ? await db.all(`SELECT ${PUBLIC_COLS} FROM nfse_documents WHERE invoiceId = ? ORDER BY createdAt DESC`, String(req.query.invoiceId))
    : await db.all(`SELECT ${PUBLIC_COLS} FROM nfse_documents ORDER BY createdAt DESC`);
  res.json(rows);
}));

// XML da NFS-e autorizada (para download / guarda fiscal).
router.get('/:id/xml', wrap(async (req, res) => {
  const db = await openDb();
  const row = await db.get('SELECT xmlNfse FROM nfse_documents WHERE id = ?', req.params.id);
  if (!row || !row.xmlNfse) return res.status(404).json({ message: 'XML da NFS-e não encontrado' });
  res.type('application/xml').send(row.xmlNfse);
}));

// Emite a NFS-e de uma nota fiscal.
router.post('/emitir', setupGuard(async (req, res) => {
  const { invoiceId } = validate(req.body, { invoiceId: { type: 'string', required: true } });

  let ambiente;
  try { ambiente = sefin.ambienteAtual(); } catch (e) { throw new FiscalSetupError(e.message); }

  const db = await openDb();
  const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
  if (invoice.status === 'canceled') return res.status(409).json({ message: 'Nota fiscal cancelada não pode gerar NFS-e' });
  const client = await db.get('SELECT * FROM clients WHERE id = ?', invoice.clientId);

  const { settings, signing, tls } = await loadFiscal(db);

  // Reserva o número da DPS de forma atômica; ele não é reaproveitado, mesmo se a nota for rejeitada.
  const reserved = await db.get('UPDATE fiscal_settings SET proximoNumero = proximoNumero + 1 WHERE id = 1 RETURNING proximoNumero - 1 AS n');
  const { id: dpsId, xml } = buildDps({ settings, invoice, client, nDPS: reserved.n, ambiente });
  const signed = signInf(xml, 'infDPS', dpsId, signing);

  const docId = newId();
  const now = new Date().toISOString();
  try {
    await db.run(
      `INSERT INTO nfse_documents (id, invoiceId, ambiente, dpsId, nDPS, status, xmlDps, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?)`,
      [docId, invoiceId, ambiente, dpsId, reserved.n, signed, now, now]
    );
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ message: 'Esta nota fiscal já tem uma NFS-e em andamento ou autorizada' });
    throw e;
  }

  let result;
  try {
    result = await sefin.enviarDps(ambiente, signed, tls);
  } catch (e) {
    // Falha de rede/TLS: não sabemos se a SEFIN recebeu. Não marcamos como rejeitada.
    await update(db, docId, { status: 'indeterminate', erro: `Falha de comunicação com a SEFIN: ${e.message}` });
    return res.status(502).json(await publicDoc(db, docId));
  }

  if (!result.ok) {
    await update(db, docId, { status: 'rejected', erro: result.error });
    return res.status(422).json(await publicDoc(db, docId));
  }

  const numero = (result.xmlNfse.match(/<nNFSe>(\d+)<\/nNFSe>/) || [])[1] || null;
  await update(db, docId, { status: 'authorized', chaveAcesso: result.chaveAcesso || null, numeroNfse: numero, xmlNfse: result.xmlNfse, erro: null });
  res.status(201).json(await publicDoc(db, docId));
}));

// Cancela uma NFS-e autorizada (evento e101101).
router.post('/:id/cancelar', setupGuard(async (req, res) => {
  const { codigoMotivo, motivo } = validate(req.body, {
    codigoMotivo: { type: 'string', required: true, oneOf: ['1', '2', '9'] },
    motivo: { type: 'string', required: true },
  });
  if (motivo.length < 15 || motivo.length > 255) throw new ValidationError('"motivo" deve ter de 15 a 255 caracteres');

  const db = await openDb();
  const doc = await db.get('SELECT * FROM nfse_documents WHERE id = ?', req.params.id);
  if (!doc) return res.status(404).json({ message: 'NFS-e não encontrada' });
  if (doc.status !== 'authorized' || !doc.chaveAcesso) return res.status(409).json({ message: 'Só é possível cancelar uma NFS-e autorizada' });

  const { settings, signing, tls } = await loadFiscal(db);
  const { id, xml } = buildCancelEvent({ settings, chaveAcesso: doc.chaveAcesso, codigoMotivo, motivo, ambiente: doc.ambiente });
  const signed = signInf(xml, 'infPedReg', id, signing);

  let result;
  try {
    result = await sefin.enviarEvento(doc.ambiente, doc.chaveAcesso, signed, tls);
  } catch (e) {
    return res.status(502).json({ message: `Falha de comunicação com a SEFIN: ${e.message}` });
  }
  if (!result.ok) return res.status(422).json({ message: result.error });

  await update(db, doc.id, { status: 'canceled' });
  await db.run("UPDATE invoices SET status = 'canceled' WHERE id = ?", doc.invoiceId);
  res.json(await publicDoc(db, doc.id));
}));

module.exports = router;
