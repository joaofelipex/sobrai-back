const { SignedXml } = require('xml-crypto');

// Algoritmos fixados pelo xmldsig-core-schema.xsd da NFS-e Nacional.
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';

/**
 * Assina o elemento `infElement` (ex: "infDPS", "infPedReg") que tem atributo Id,
 * inserindo <Signature> logo após ele, como filho do elemento raiz.
 */
function signInf(xml, infElement, id, { keyPem, certPem }) {
  const sig = new SignedXml({
    privateKey: keyPem,
    publicCert: certPem,
    signatureAlgorithm: RSA_SHA1,
    canonicalizationAlgorithm: C14N,
  });
  sig.addReference({
    xpath: `//*[local-name(.)='${infElement}']`,
    uri: `#${id}`,
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA1,
  });
  sig.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='${infElement}']`, action: 'after' },
  });
  return sig.getSignedXml();
}

module.exports = { signInf };
