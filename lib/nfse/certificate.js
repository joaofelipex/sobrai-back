const forge = require('node-forge');

/**
 * Lê um certificado A1 (.pfx/.p12) e devolve a chave privada e o certificado em PEM,
 * além de metadados para exibição. Lança Error com mensagem amigável se a senha
 * estiver errada, o arquivo for inválido ou o certificado estiver vencido.
 */
function parsePfx(pfxBuffer, password) {
  let p12;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
  } catch {
    throw new Error('Não foi possível abrir o certificado: arquivo inválido ou senha incorreta');
  }

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
  const plainKeyBags = p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [];
  const keyBag = keyBags[0] || plainKeyBags[0];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!keyBag || certBags.length === 0) throw new Error('O arquivo não contém chave privada e certificado');

  // O certificado do titular é o que corresponde à chave privada (o resto é a cadeia).
  const publicN = keyBag.key.n.toString(16);
  const own = certBags.find((b) => b.cert.publicKey.n && b.cert.publicKey.n.toString(16) === publicN) || certBags[0];
  const cert = own.cert;

  const now = new Date();
  if (cert.validity.notAfter < now) throw new Error(`Certificado vencido em ${cert.validity.notAfter.toISOString().slice(0, 10)}`);
  if (cert.validity.notBefore > now) throw new Error('Certificado ainda não é válido');

  const cn = cert.subject.getField('CN');
  return {
    keyPem: forge.pki.privateKeyToPem(keyBag.key),
    certPem: forge.pki.certificateToPem(cert),
    chainPem: certBags.map((b) => forge.pki.certificateToPem(b.cert)),
    subject: cn ? cn.value : null,
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
  };
}

/** ICP-Brasil costuma colocar "NOME:CNPJ" no CN. Devolve o CNPJ (14 dígitos) se achar. */
function cnpjFromSubject(subject) {
  const m = subject && subject.match(/(\d{14})\s*$/);
  return m ? m[1] : null;
}

module.exports = { parsePfx, cnpjFromSubject };
