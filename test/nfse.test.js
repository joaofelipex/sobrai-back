const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { buildDps, buildCancelEvent } = require('../lib/nfse/dps');
const { signInf } = require('../lib/nfse/sign');
const { parsePfx } = require('../lib/nfse/certificate');
const secretStore = require('../lib/nfse/secret-store');

const SCHEMAS = path.join(__dirname, '../lib/nfse/schemas');

// Certificado autoassinado só para teste (não é ICP-Brasil).
function selfSignedPfx(password, { expired = false } = {}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 2 * 86400000);
  cert.validity.notAfter = new Date(Date.now() + (expired ? -86400000 : 365 * 86400000));
  const attrs = [{ name: 'commonName', value: 'EMPRESA TESTE LTDA:11222333000181' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

const settings = {
  cnpj: '11.222.333/0001-81', inscricaoMunicipal: '12345', codMunicipioIbge: '3550308', opSimpNac: '2',
  regApTribSN: null, regEspTrib: '0', serie: '1', codTribNac: '010101', codTribMun: null, aliquotaIss: 2,
};
const invoice = { description: 'Consultoria <teste> & "cia"', amount: 1234.5, issueDate: '2026-10-09' };

async function validate(xml, xsdFile) {
  const { validateXML } = await import('xmllint-wasm');
  const files = fs.readdirSync(SCHEMAS).filter((f) => f.endsWith('.xsd'));
  const preload = files.filter((f) => f !== xsdFile).map((f) => ({ fileName: f, contents: fs.readFileSync(path.join(SCHEMAS, f), 'utf8') }));
  return validateXML({
    xml: [{ fileName: 'doc.xml', contents: xml }],
    schema: [{ fileName: xsdFile, contents: fs.readFileSync(path.join(SCHEMAS, xsdFile), 'utf8') }],
    preload,
  });
}

test('DPS gerada é válida no XSD oficial v1.00 (MEI, com tomador PJ)', async () => {
  const { id, xml } = buildDps({ settings, invoice, client: { name: 'Cliente SA', document: '11.444.777/0001-61' }, nDPS: 7, ambiente: 2 });
  assert.match(id, /^DPS[0-9]{42}$/);
  assert.strictEqual(id, 'DPS3550308211222333000181' + '00001' + '000000000000007');
  const r = await validate(xml, 'DPS_v1.00.xsd');
  assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
});

test('DPS sem tomador e com Simples ME/EPP (regApTribSN) também valida', async () => {
  const s = { ...settings, opSimpNac: '3', regApTribSN: '1' };
  const { xml } = buildDps({ settings: s, invoice, client: { name: 'PF', document: '' }, nDPS: 1, ambiente: 2 });
  assert.ok(!xml.includes('<toma>'));
  assert.ok(!xml.includes('<pAliq>'));
  const r = await validate(xml, 'DPS_v1.00.xsd');
  assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
});

test('DPS assinada valida no XSD e a assinatura confere', async () => {
  const pfx = selfSignedPfx('segredo');
  const creds = parsePfx(pfx, 'segredo');
  const { id, xml } = buildDps({ settings, invoice, client: null, nDPS: 3, ambiente: 2 });
  const signed = signInf(xml, 'infDPS', id, creds);

  const r = await validate(signed, 'DPS_v1.00.xsd');
  assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));

  const v = new SignedXml({ publicCert: creds.certPem });
  const sigNode = signed.match(/<Signature[\s\S]*<\/Signature>/)[0];
  v.loadSignature(sigNode);
  assert.ok(v.checkSignature(signed), 'assinatura inválida');

  const tampered = signed.replace('<vServ>1234.50</vServ>', '<vServ>9999</vServ>');
  assert.notStrictEqual(tampered, signed);
  const v2 = new SignedXml({ publicCert: creds.certPem });
  v2.loadSignature(sigNode);
  assert.ok(!v2.checkSignature(tampered), 'adulteração não foi detectada');
});

test('evento de cancelamento assinado valida no XSD', async () => {
  const creds = parsePfx(selfSignedPfx('x'), 'x');
  const chave = '3'.repeat(50);
  const { id, xml } = buildCancelEvent({ settings, chaveAcesso: chave, codigoMotivo: '1', motivo: 'Erro na emissão da nota fiscal', ambiente: 2 });
  const r = await validate(signInf(xml, 'infPedReg', id, creds), 'pedRegEvento_v1.00.xsd');
  assert.deepStrictEqual(r.errors, [], JSON.stringify(r.errors));
});

test('certificado: senha errada e vencido são recusados', () => {
  assert.throws(() => parsePfx(selfSignedPfx('certa'), 'errada'), /senha incorreta/);
  assert.throws(() => parsePfx(selfSignedPfx('a', { expired: true }), 'a'), /vencido/);
});

test('secret-store: criptografa e descriptografa; exige NFSE_SECRET', () => {
  delete process.env.NFSE_SECRET;
  assert.throws(() => secretStore.encrypt(Buffer.from('x')), /NFSE_SECRET/);
  process.env.NFSE_SECRET = 'uma-chave-de-teste-bem-longa';
  const enc = secretStore.encrypt(Buffer.from('conteudo'));
  assert.ok(!enc.includes('conteudo'));
  assert.strictEqual(secretStore.decrypt(enc).toString(), 'conteudo');
});
