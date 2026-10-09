// Fluxo ponta a ponta: backend real (processo filho, banco temporário) falando com uma
// "SEFIN" falsa em HTTPS que exige certificado de cliente (mTLS).
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const forge = require('node-forge');

const PORT = 3099;
const MOCK_PORT = 3098;
const BASE = `http://localhost:${PORT}/api`;
const SECRET = 'segredo-de-teste-123456';
const CNPJ = '11222333000181';

function makeCert(cn, { server = false } = {}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0' + Math.floor(Math.random() * 1e6);
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: cn }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  if (server) cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}

const j = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null };
};

let child, mock, tmp, mockMode = 'ok', received = [];

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sobrai-nfse-'));
  const server = makeCert('localhost', { server: true });
  const serverPem = forge.pki.certificateToPem(server.cert);
  fs.writeFileSync(path.join(tmp, 'ca.pem'), serverPem);

  mock = https.createServer(
    { key: forge.pki.privateKeyToPem(server.keys.privateKey), cert: serverPem, requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const peer = req.socket.getPeerCertificate();
        received.push({ method: req.method, url: req.url, body: data ? JSON.parse(data) : null, hasClientCert: !!(peer && peer.subject) });
        const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (!peer || !peer.subject) return send(403, { erros: [{ codigo: 'E403', descricao: 'Certificado de cliente ausente' }] });
        if (req.url === '/SefinNacional/nfse' && req.method === 'POST') {
          if (mockMode === 'reject') return send(400, { erros: [{ codigo: 'E0001', descricao: 'Código de tributação inválido', complemento: 'cTribNac' }] });
          const dps = zlib.gunzipSync(Buffer.from(JSON.parse(data).dpsXmlGZipB64, 'base64')).toString();
          assert.ok(dps.includes('<Signature'), 'DPS enviada sem assinatura');
          const nfse = `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse"><infNFSe><nNFSe>42</nNFSe></infNFSe></NFSe>`;
          return send(201, { nfseXmlGZipB64: zlib.gzipSync(nfse).toString('base64'), chaveAcesso: '5'.repeat(50), idDPS: 'x' });
        }
        if (/^\/SefinNacional\/nfse\/\d{50}\/eventos$/.test(req.url)) return send(200, {});
        send(404, { erros: [{ codigo: 'E404', descricao: 'rota' }] });
      });
    }
  );
  await new Promise((r) => mock.listen(MOCK_PORT, r));

  child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      SOBRAI_DB: path.join(tmp, 'test.db'),
      NFSE_SECRET: SECRET,
      NFSE_AMBIENTE: '2',
      NFSE_SEFIN_URL_HOMOLOGACAO: `https://localhost:${MOCK_PORT}/SefinNacional`,
      NFSE_CA_FILE: path.join(tmp, 'ca.pem'),
    },
  });
  let log = '';
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { log += d; if (log.includes('running')) resolve(); });
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', () => reject(new Error('backend caiu: ' + log)));
    setTimeout(() => reject(new Error('timeout subindo backend: ' + log)), 15000);
  });
});

test.after(() => {
  child && child.kill();
  mock && mock.close();
});

test('fluxo completo: configurar, emitir, rejeitar, cancelar', async () => {
  // Sem configuração, emitir devolve 409 com instrução clara
  const client = (await j('POST', '/clients', { name: 'Cliente SA', document: '11.444.777/0001-61' })).body;
  const invoice = (await j('POST', '/invoices', {
    clientId: client.id, description: 'Consultoria', amount: 1000, taxAmount: 50, issueDate: '2026-10-09',
  })).body;
  let r = await j('POST', '/nfse/emitir', { invoiceId: invoice.id });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.message, /dados fiscais/);

  // Dados fiscais inválidos são recusados
  r = await j('PUT', '/fiscal/settings', { cnpj: '123', codMunicipioIbge: '1', opSimpNac: '2', codTribNac: 'abc' });
  assert.strictEqual(r.status, 400);

  r = await j('PUT', '/fiscal/settings', { cnpj: CNPJ, codMunicipioIbge: '3550308', opSimpNac: '2', codTribNac: '010101', inscricaoMunicipal: '123' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.proximoNumero, 1);

  r = await j('POST', '/nfse/emitir', { invoiceId: invoice.id });
  assert.strictEqual(r.status, 409);
  assert.match(r.body.message, /certificado/i);

  // Certificado: senha errada é recusada; CNPJ divergente é recusado; correto é aceito
  const mine = makeCert(`EMPRESA TESTE:${CNPJ}`);
  const pfx = (cert, pw) => Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(cert.keys.privateKey, [cert.cert], pw, { algorithm: '3des' })).getBytes(), 'binary').toString('base64');
  r = await j('PUT', '/fiscal/certificate', { pfxBase64: pfx(mine, 'senha1'), password: 'errada' });
  assert.strictEqual(r.status, 400);
  r = await j('PUT', '/fiscal/certificate', { pfxBase64: pfx(makeCert('OUTRA:99888777000166'), 'senha1'), password: 'senha1' });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.message, /CNPJ/);
  r = await j('PUT', '/fiscal/certificate', { pfxBase64: pfx(mine, 'senha1'), password: 'senha1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.configured, true);
  assert.ok(!JSON.stringify(r.body).includes('senha1'));

  // Certificado e senha estão criptografados no banco
  const sqlite3 = require('sqlite3');
  const raw = await new Promise((res, rej) => new sqlite3.Database(path.join(tmp, 'test.db'), sqlite3.OPEN_READONLY)
    .get('SELECT pfxEnc, passEnc FROM fiscal_certificate', (e, row) => (e ? rej(e) : res(row))));
  assert.ok(!Buffer.from(raw.passEnc, 'base64').includes('senha1'));

  // Rejeição da SEFIN: status rejected, erro legível, número consumido
  mockMode = 'reject';
  r = await j('POST', '/nfse/emitir', { invoiceId: invoice.id });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.body.status, 'rejected');
  assert.match(r.body.erro, /E0001.*Código de tributação inválido/);
  assert.strictEqual(r.body.nDPS, 1);

  // Nova tentativa após ajuste: autorizada, usa nDPS 2, mTLS com certificado do cliente
  mockMode = 'ok';
  received = [];
  r = await j('POST', '/nfse/emitir', { invoiceId: invoice.id });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.status, 'authorized');
  assert.strictEqual(r.body.nDPS, 2);
  assert.strictEqual(r.body.numeroNfse, '42');
  assert.strictEqual(r.body.chaveAcesso, '5'.repeat(50));
  assert.ok(received[0].hasClientCert, 'SEFIN não recebeu certificado de cliente (mTLS)');
  assert.ok(!('xmlDps' in r.body) && !('xmlNfse' in r.body), 'listagem não deve vazar XML');

  // Emissão duplicada é bloqueada
  r = await j('POST', '/nfse/emitir', { invoiceId: invoice.id });
  assert.strictEqual(r.status, 409);

  const doc = (await j('GET', `/nfse?invoiceId=${invoice.id}`)).body.find((d) => d.status === 'authorized');
  const xml = (await j('GET', `/nfse/${doc.id}/xml`)).body;
  assert.match(xml, /<nNFSe>42<\/nNFSe>/);

  // Com NFS-e autorizada, a nota não pode ser excluída nem cancelada "por fora"
  r = await j('DELETE', `/invoices/${invoice.id}`);
  assert.strictEqual(r.status, 409);
  r = await j('PATCH', `/invoices/${invoice.id}`, { status: 'canceled' });
  assert.strictEqual(r.status, 409);

  // Cancelamento: motivo curto recusado; válido cancela a NFS-e e a nota fiscal
  r = await j('POST', `/nfse/${doc.id}/cancelar`, { codigoMotivo: '1', motivo: 'curto' });
  assert.strictEqual(r.status, 400);
  r = await j('POST', `/nfse/${doc.id}/cancelar`, { codigoMotivo: '1', motivo: 'Erro na emissão da nota fiscal' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.status, 'canceled');
  const inv = (await j('GET', '/invoices')).body.find((i) => i.id === invoice.id);
  assert.strictEqual(inv.status, 'canceled');

  // Produção continua bloqueada sem a liberação explícita
  const st = (await j('GET', '/fiscal/status')).body;
  assert.strictEqual(st.ambiente, 2);
});
