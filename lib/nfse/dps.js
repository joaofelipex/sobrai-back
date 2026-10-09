// Montagem do XML da DPS (Declaração de Prestação de Serviços) e do pedido de
// registro de evento de cancelamento, conforme os XSDs oficiais da NFS-e Nacional v1.00
// (lib/nfse/schemas). Regras de negócio que os XSDs não cobrem são validadas pela
// SEFIN no ambiente de homologação.

const NS = 'http://www.sped.fazenda.gov.br/nfse';
const VERSAO = '1.00';
const VER_APLIC = 'sobrai-1.0';

const esc = (v) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const digits = (v) => String(v || '').replace(/\D/g, '');
const money = (n) => (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '');

/** dhEmi no padrão do XSD: AAAA-MM-DDThh:mm:ss-03:00 (horário de Brasília). */
function dateTimeBR(date = new Date()) {
  const br = new Date(date.getTime() - 3 * 3600 * 1000);
  return br.toISOString().slice(0, 19) + '-03:00';
}

/** Id da DPS: "DPS" + município(7) + tipo inscrição(1: 2=CNPJ) + CNPJ(14) + série(5) + nDPS(15) = 45. */
function dpsId({ codMunicipioIbge, cnpj, serie, nDPS }) {
  return `DPS${codMunicipioIbge}2${digits(cnpj).padStart(14, '0')}${String(serie).padStart(5, '0')}${String(nDPS).padStart(15, '0')}`;
}

function tomadorXml(client) {
  const doc = digits(client && client.document);
  if (!client || !client.name || (doc.length !== 11 && doc.length !== 14)) return '';
  const tag = doc.length === 14 ? 'CNPJ' : 'CPF';
  return `<toma><${tag}>${doc}</${tag}><xNome>${esc(client.name.slice(0, 300))}</xNome></toma>`;
}

/**
 * @param {object} p
 * @param {object} p.settings  linha de fiscal_settings
 * @param {object} p.invoice   { description, amount, issueDate }
 * @param {object} p.client    { name, document }
 * @param {number} p.nDPS      número sequencial já reservado
 * @param {1|2}    p.ambiente  1 produção, 2 homologação
 * @param {Date}   [p.now]
 * @returns {{ id: string, xml: string }} XML ainda sem assinatura
 */
function buildDps({ settings: s, invoice, client, nDPS, ambiente, now = new Date() }) {
  const id = dpsId({ codMunicipioIbge: s.codMunicipioIbge, cnpj: s.cnpj, serie: s.serie, nDPS });

  const opSimp = String(s.opSimpNac);
  // Alíquota do ISS só é informada para quem não é MEI/Simples (ou ME/EPP com ISS fora do DAS).
  const informaAliquota = opSimp === '1' || (opSimp === '3' && s.regApTribSN && String(s.regApTribSN) !== '1');

  const regTrib =
    `<regTrib><opSimpNac>${opSimp}</opSimpNac>` +
    (opSimp === '3' && s.regApTribSN ? `<regApTribSN>${s.regApTribSN}</regApTribSN>` : '') +
    `<regEspTrib>${s.regEspTrib}</regEspTrib></regTrib>`;

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DPS xmlns="${NS}" versao="${VERSAO}"><infDPS Id="${id}">` +
    `<tpAmb>${ambiente}</tpAmb>` +
    // Um minuto no passado: a SEFIN rejeita dhEmi à frente do relógio dela.
    `<dhEmi>${dateTimeBR(new Date(now.getTime() - 60 * 1000))}</dhEmi>` +
    `<verAplic>${VER_APLIC}</verAplic>` +
    `<serie>${esc(s.serie)}</serie>` +
    `<nDPS>${nDPS}</nDPS>` +
    `<dCompet>${String(invoice.issueDate).slice(0, 10)}</dCompet>` +
    `<tpEmit>1</tpEmit>` +
    `<cLocEmi>${s.codMunicipioIbge}</cLocEmi>` +
    `<prest><CNPJ>${digits(s.cnpj)}</CNPJ>` +
    (s.inscricaoMunicipal ? `<IM>${esc(s.inscricaoMunicipal)}</IM>` : '') +
    regTrib +
    `</prest>` +
    tomadorXml(client) +
    `<serv><locPrest><cLocPrestacao>${s.codMunicipioIbge}</cLocPrestacao></locPrest>` +
    `<cServ><cTribNac>${s.codTribNac}</cTribNac>` +
    (s.codTribMun ? `<cTribMun>${esc(s.codTribMun)}</cTribMun>` : '') +
    `<xDescServ>${esc(String(invoice.description || '').slice(0, 2000))}</xDescServ></cServ></serv>` +
    `<valores><vServPrest><vServ>${money(invoice.amount)}</vServ></vServPrest>` +
    `<trib><tribMun><tribISSQN>1</tribISSQN>` +
    (informaAliquota && s.aliquotaIss != null ? `<pAliq>${money(s.aliquotaIss)}</pAliq>` : '') +
    `<tpRetISSQN>1</tpRetISSQN></tribMun>` +
    `<totTrib><indTotTrib>0</indTotTrib></totTrib></trib></valores>` +
    `</infDPS></DPS>`;

  return { id, xml };
}

/** Pedido de registro de evento de cancelamento (e101101). */
function buildCancelEvent({ settings: s, chaveAcesso, codigoMotivo, motivo, ambiente, now = new Date() }) {
  const id = `PRE${chaveAcesso}101101`;
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<pedRegEvento xmlns="${NS}" versao="${VERSAO}"><infPedReg Id="${id}">` +
    `<tpAmb>${ambiente}</tpAmb>` +
    `<verAplic>${VER_APLIC}</verAplic>` +
    `<dhEvento>${dateTimeBR(new Date(now.getTime() - 60 * 1000))}</dhEvento>` +
    `<CNPJAutor>${digits(s.cnpj)}</CNPJAutor>` +
    `<chNFSe>${chaveAcesso}</chNFSe>` +
    `<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>${codigoMotivo}</cMotivo><xMotivo>${esc(motivo)}</xMotivo></e101101>` +
    `</infPedReg></pedRegEvento>`;
  return { id, xml };
}

module.exports = { buildDps, buildCancelEvent, dpsId, NS };
