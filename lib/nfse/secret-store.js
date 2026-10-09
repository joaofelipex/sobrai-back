const crypto = require('crypto');

// Criptografia AES-256-GCM para o certificado e a senha guardados no banco.
// A chave vem de NFSE_SECRET (variável de ambiente): sem ela, nada é gravado.

class SecretNotConfiguredError extends Error {
  constructor() {
    super('NFSE_SECRET não configurada no backend (necessária para guardar o certificado)');
  }
}

const key = () => {
  const secret = process.env.NFSE_SECRET;
  if (!secret || secret.length < 16) throw new SecretNotConfiguredError();
  return crypto.scryptSync(secret, 'sobrai-nfse-v1', 32);
};

const encrypt = (plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
};

const decrypt = (b64) => {
  const raw = Buffer.from(b64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
};

module.exports = { encrypt, decrypt, SecretNotConfiguredError };
