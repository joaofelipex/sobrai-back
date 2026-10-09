const express = require('express');
const router = express.Router();
const { openDb } = require('../database');
const { wrap, validate, ValidationError } = require('../lib/http');
const secretStore = require('../lib/nfse/secret-store');
const { parsePfx, cnpjFromSubject } = require('../lib/nfse/certificate');
const { ambienteAtual } = require('../lib/nfse/sefin');

const digitsOnly = (v) => String(v || '').replace(/\D/g, '');

const schema = {
  cnpj: { type: 'string', required: true },
  inscricaoMunicipal: { type: 'string' },
  codMunicipioIbge: { type: 'string', required: true },
  opSimpNac: { type: 'string', required: true, oneOf: ['1', '2', '3'] },
  regApTribSN: { type: 'string', oneOf: ['1', '2', '3'] },
  regEspTrib: { type: 'string', oneOf: ['0', '1', '2', '3', '4', '5', '6'] },
  serie: { type: 'string' },
  proximoNumero: { type: 'number' },
  codTribNac: { type: 'string', required: true },
  codTribMun: { type: 'string' },
  aliquotaIss: { type: 'number' },
};

const CERT_COLS = 'subject, validTo, uploadedAt';
const certStatus = (row) => ({
  configured: !!row,
  subject: row ? row.subject : null,
  validTo: row ? row.validTo : null,
  uploadedAt: row ? row.uploadedAt : null,
});

// Estado geral da integração, para a tela de configuração.
router.get('/status', wrap(async (req, res) => {
  const db = await openDb();
  let ambiente = null;
  let ambienteErro = null;
  try { ambiente = ambienteAtual(); } catch (e) { ambienteErro = e.message; }
  res.json({
    ambiente,
    ambienteErro,
    secretConfigured: !!(process.env.NFSE_SECRET && process.env.NFSE_SECRET.length >= 16),
    settingsConfigured: !!(await db.get('SELECT id FROM fiscal_settings WHERE id = 1')),
    certificate: certStatus(await db.get(`SELECT ${CERT_COLS} FROM fiscal_certificate WHERE id = 1`)),
  });
}));

router.get('/settings', wrap(async (req, res) => {
  const db = await openDb();
  const row = await db.get('SELECT * FROM fiscal_settings WHERE id = 1');
  if (!row) return res.status(404).json({ message: 'Dados fiscais não configurados' });
  const { id, ...rest } = row;
  res.json(rest);
}));

router.put('/settings', wrap(async (req, res) => {
  const body = validate(req.body, schema);
  const cnpj = digitsOnly(body.cnpj);
  const errors = [];
  if (cnpj.length !== 14) errors.push('"cnpj" deve ter 14 dígitos');
  if (!/^\d{7}$/.test(body.codMunicipioIbge)) errors.push('"codMunicipioIbge" deve ter 7 dígitos (código IBGE)');
  if (!/^\d{6}$/.test(body.codTribNac)) errors.push('"codTribNac" deve ter 6 dígitos (código de tributação nacional)');
  if (body.opSimpNac === '3' && !body.regApTribSN) errors.push('"regApTribSN" é obrigatório para ME/EPP do Simples Nacional');
  if (body.serie && !/^\d{1,5}$/.test(body.serie)) errors.push('"serie" deve ter de 1 a 5 dígitos');
  if (body.proximoNumero != null && (!Number.isInteger(body.proximoNumero) || body.proximoNumero < 1 || body.proximoNumero > 999999999999999)) {
    errors.push('"proximoNumero" deve ser um inteiro positivo');
  }
  if (body.aliquotaIss != null && (body.aliquotaIss < 0 || body.aliquotaIss > 9.99)) errors.push('"aliquotaIss" deve estar entre 0 e 9,99');
  if (errors.length) throw new ValidationError(errors.join('; '));

  const db = await openDb();
  const current = await db.get('SELECT proximoNumero FROM fiscal_settings WHERE id = 1');
  const s = {
    inscricaoMunicipal: null, regApTribSN: null, codTribMun: null, aliquotaIss: null,
    regEspTrib: '0', serie: '1',
    ...body,
    cnpj,
    proximoNumero: body.proximoNumero || (current ? current.proximoNumero : 1),
  };
  if (s.opSimpNac !== '3') s.regApTribSN = null;

  const cols = ['cnpj', 'inscricaoMunicipal', 'codMunicipioIbge', 'opSimpNac', 'regApTribSN', 'regEspTrib', 'serie', 'proximoNumero', 'codTribNac', 'codTribMun', 'aliquotaIss'];
  await db.run(
    `INSERT INTO fiscal_settings (id, ${cols.join(', ')}) VALUES (1, ${cols.map(() => '?').join(', ')})
     ON CONFLICT(id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
    cols.map((c) => s[c])
  );
  const { id, ...saved } = await db.get('SELECT * FROM fiscal_settings WHERE id = 1');
  res.json(saved);
}));

router.get('/certificate', wrap(async (req, res) => {
  const db = await openDb();
  res.json(certStatus(await db.get(`SELECT ${CERT_COLS} FROM fiscal_certificate WHERE id = 1`)));
}));

// Recebe o .pfx em base64 + senha, valida e guarda criptografado. Nunca devolve o conteúdo.
router.put('/certificate', wrap(async (req, res) => {
  const { pfxBase64, password } = validate(req.body, {
    pfxBase64: { type: 'string', required: true },
    password: { type: 'string', required: true },
  });
  const pfx = Buffer.from(pfxBase64, 'base64');
  if (pfx.length === 0 || pfx.length > 200 * 1024) throw new ValidationError('Arquivo de certificado inválido ou grande demais');

  let info;
  try {
    info = parsePfx(pfx, password);
  } catch (e) {
    throw new ValidationError(e.message);
  }

  const db = await openDb();
  const settings = await db.get('SELECT cnpj FROM fiscal_settings WHERE id = 1');
  const certCnpj = cnpjFromSubject(info.subject);
  if (settings && certCnpj && certCnpj !== settings.cnpj) {
    throw new ValidationError(`O CNPJ do certificado (${certCnpj}) é diferente do CNPJ dos dados fiscais (${settings.cnpj})`);
  }

  let pfxEnc, passEnc;
  try {
    pfxEnc = secretStore.encrypt(pfx);
    passEnc = secretStore.encrypt(Buffer.from(password, 'utf8'));
  } catch (e) {
    if (e instanceof secretStore.SecretNotConfiguredError) return res.status(503).json({ message: e.message });
    throw e;
  }

  await db.run(
    `INSERT INTO fiscal_certificate (id, pfxEnc, passEnc, subject, validFrom, validTo, uploadedAt) VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET pfxEnc = excluded.pfxEnc, passEnc = excluded.passEnc, subject = excluded.subject,
       validFrom = excluded.validFrom, validTo = excluded.validTo, uploadedAt = excluded.uploadedAt`,
    [pfxEnc, passEnc, info.subject, info.validFrom, info.validTo, new Date().toISOString()]
  );
  res.json(certStatus(await db.get(`SELECT ${CERT_COLS} FROM fiscal_certificate WHERE id = 1`)));
}));

router.delete('/certificate', wrap(async (req, res) => {
  const db = await openDb();
  await db.run('DELETE FROM fiscal_certificate WHERE id = 1');
  res.status(204).send();
}));

module.exports = router;
