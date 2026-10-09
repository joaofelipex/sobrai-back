const https = require('https');
const tls = require('tls');
const fs = require('fs');
const zlib = require('zlib');

// URLs base da SEFIN Nacional. Conferir no portal gov.br/nfse (documentação técnica) antes de ir a produção.
const URLS = {
  2: process.env.NFSE_SEFIN_URL_HOMOLOGACAO || 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
  1: process.env.NFSE_SEFIN_URL_PRODUCAO || 'https://sefin.nfse.gov.br/SefinNacional',
};

/** Produção só é liberada de forma explícita: NFSE_AMBIENTE=1 e NFSE_ALLOW_PRODUCTION=true. */
function ambienteAtual() {
  if (process.env.NFSE_AMBIENTE === '1') {
    if (process.env.NFSE_ALLOW_PRODUCTION !== 'true') {
      throw new Error('Produção bloqueada: defina NFSE_ALLOW_PRODUCTION=true para emitir notas reais');
    }
    return 1;
  }
  return 2;
}

// O certificado raiz da ICP-Brasil não vem no repositório de CAs do Node. Se a validação TLS
// falhar, aponte NFSE_CA_FILE para um .pem com a cadeia ICP-Brasil (a validação nunca é desligada).
function caList() {
  const file = process.env.NFSE_CA_FILE;
  if (!file) return undefined;
  return [...tls.rootCertificates, fs.readFileSync(file, 'utf8')];
}

const gzipB64 = (xml) => zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
const gunzipB64 = (b64) => zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');

function request(ambiente, method, path, body, { pfx, passphrase }) {
  const url = new URL(URLS[ambiente] + path);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        pfx,
        passphrase,
        ca: caList(),
        timeout: 30000,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* corpo não-JSON */ }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado ao falar com a SEFIN')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Junta os erros da SEFIN ({erros:[{codigo,descricao,complemento}]}) em uma frase. */
function formatErrors(res) {
  const list = res.json && (res.json.erros || res.json.erro);
  if (Array.isArray(list) && list.length) {
    return list.map((e) => [e.codigo, e.descricao, e.complemento].filter(Boolean).join(' - ')).join('; ');
  }
  return `HTTP ${res.status}${res.text ? `: ${res.text.slice(0, 300)}` : ''}`;
}

/** Envia a DPS assinada. Sucesso = 201 com nfseXmlGZipB64. */
async function enviarDps(ambiente, signedXml, creds) {
  const res = await request(ambiente, 'POST', '/nfse', { dpsXmlGZipB64: gzipB64(signedXml) }, creds);
  if (res.status === 201 || res.status === 200) {
    const j = res.json || {};
    if (!j.nfseXmlGZipB64) return { ok: false, error: 'Resposta da SEFIN sem a NFS-e (nfseXmlGZipB64)' };
    return { ok: true, chaveAcesso: j.chaveAcesso, xmlNfse: gunzipB64(j.nfseXmlGZipB64) };
  }
  return { ok: false, error: formatErrors(res) };
}

/**
 * Registra o evento de cancelamento.
 * ATENÇÃO: o nome da chave JSON do evento (`pedidoRegistroEventoXmlGZipB64`) veio de fontes da
 * comunidade, não do manual oficial; confirme no Swagger da SEFIN em homologação.
 */
async function enviarEvento(ambiente, chaveAcesso, signedXml, creds) {
  const res = await request(
    ambiente,
    'POST',
    `/nfse/${chaveAcesso}/eventos`,
    { pedidoRegistroEventoXmlGZipB64: gzipB64(signedXml) },
    creds
  );
  if (res.status >= 200 && res.status < 300) return { ok: true };
  return { ok: false, error: formatErrors(res) };
}

module.exports = { ambienteAtual, enviarDps, enviarEvento, gzipB64, gunzipB64, URLS };
