// Conexão com bancos via Pluggy (open finance): token do widget, registro de itens e sincronização.
const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, validate } = require('../lib/http');
const pluggy = require('../lib/pluggy');
const { syncItem, syncAll } = require('../lib/pluggy-sync');

// Erros da Pluggy viram respostas legíveis em vez de 500 genérico.
const guard = (fn) => wrap(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (!(err instanceof pluggy.PluggyError)) throw err;
    res.status(err.status === 503 ? 503 : 502).json({ message: err.message });
  }
});

router.get('/status', wrap(async (req, res) => {
  const db = await openDb();
  const items = await db.all('SELECT * FROM mx_pluggy_items ORDER BY createdAt');
  const lastSyncAt = items.map((i) => i.lastSyncAt).filter(Boolean).sort().pop() || null;
  res.json({ configured: pluggy.configured(), items, lastSyncAt });
}));

// Token para o widget Pluggy Connect (o front abre o widget e devolve o itemId criado).
router.post('/connect-token', guard(async (req, res) => {
  res.json({ accessToken: await pluggy.createConnectToken() });
}));

// Registra uma conexão (itemId vindo do widget ou do painel da Pluggy) e já sincroniza.
router.post('/items', guard(async (req, res) => {
  const { itemId } = validate(req.body, { itemId: { type: 'string', required: true } });
  const item = await pluggy.getItem(itemId); // falha se o item não existir nesta conta
  const db = await openDb();
  await db.run(
    `INSERT INTO mx_pluggy_items (itemId, connector, status, createdAt) VALUES (?, ?, ?, ?)
     ON CONFLICT(itemId) DO UPDATE SET connector = excluded.connector, status = excluded.status`,
    [itemId, item?.connector?.name || null, item?.status || null, new Date().toISOString()]
  );
  let stats = null;
  let error = null;
  try { stats = await syncItem(db, itemId); } catch (err) {
    error = err.message;
    await db.run('UPDATE mx_pluggy_items SET lastError = ? WHERE itemId = ?', [error, itemId]);
  }
  res.status(201).json({ itemId, stats, error });
}));

router.post('/sync', guard(async (req, res) => {
  if (!pluggy.configured()) return res.status(503).json({ message: 'Pluggy não configurada: defina PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET' });
  res.json(await syncAll(await openDb()));
}));

// Remove só o vínculo: contas e lançamentos já importados continuam no MiXCo.
router.delete('/items/:itemId', wrap(async (req, res) => {
  const db = await openDb();
  const result = await db.run('DELETE FROM mx_pluggy_items WHERE itemId = ?', req.params.itemId);
  if (!result.changes) return res.status(404).json({ message: 'Conexão não encontrada' });
  res.status(204).send();
}));

module.exports = router;
