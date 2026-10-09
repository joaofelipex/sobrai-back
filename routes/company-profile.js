const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, validate, ValidationError } = require('../lib/http');

const schema = {
  name: { type: 'string', required: true },
  type: { type: 'string', required: true, oneOf: ['mei', 'simples', 'autonomo'] },
  monthlyRevenue: { type: 'number', required: true },
  cnpj: { type: 'string' },
  phone: { type: 'string' },
  email: { type: 'string' },
};

const COLS = ['name', 'type', 'monthlyRevenue', 'cnpj', 'phone', 'email', 'address'];

// O endereço é um objeto aninhado, guardado como JSON.
const parseBody = (body) => {
  const p = { cnpj: null, phone: null, email: null, ...validate(body, schema) };
  const a = body && body.address;
  if (a !== undefined && a !== null && (typeof a !== 'object' || Array.isArray(a))) {
    throw new ValidationError('"address" deve ser um objeto');
  }
  p.address = a ? JSON.stringify(a) : null;
  return p;
};

const toApi = (row) => {
  const { id, address, ...rest } = row;
  const out = {};
  for (const [k, v] of Object.entries(rest)) if (v !== null) out[k] = v;
  if (address) out.address = JSON.parse(address);
  return out;
};

const upsert = async (p) => {
  const db = await openDb();
  await db.run(
    `INSERT INTO company_profile (id, ${COLS.join(', ')}) VALUES (1, ${COLS.map(() => '?').join(', ')})
     ON CONFLICT(id) DO UPDATE SET ${COLS.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    COLS.map((c) => p[c])
  );
  return toApi(await db.get('SELECT * FROM company_profile WHERE id = 1'));
};

router.get('/', wrap(async (req, res) => {
  const db = await openDb();
  const row = await db.get('SELECT * FROM company_profile WHERE id = 1');
  if (!row) return res.status(404).json({ message: 'Company profile not found' });
  res.json(toApi(row));
}));

router.post('/', wrap(async (req, res) => {
  const p = parseBody(req.body);
  const db = await openDb();
  if (await db.get('SELECT id FROM company_profile WHERE id = 1')) {
    return res.status(409).json({ message: 'Company profile already exists. Use PUT to update.' });
  }
  res.status(201).json(await upsert(p));
}));

// PUT faz upsert: cria o perfil se ainda não existir (primeiro onboarding).
router.put('/', wrap(async (req, res) => {
  res.json(await upsert(parseBody(req.body)));
}));

module.exports = router;
