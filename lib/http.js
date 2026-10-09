const crypto = require('crypto');

// Repassa erros de handlers async para o middleware de erro do Express 4.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const newId = () => crypto.randomUUID();

class ValidationError extends Error {}

const isIsoDate = (v) => typeof v === 'string' && v.length >= 8 && !Number.isNaN(Date.parse(v));

/**
 * Valida o body segundo um schema simples: { campo: { type, required, oneOf, positive } }.
 * Retorna apenas os campos conhecidos (ignora o resto).
 */
function validate(body, schema) {
  const out = {};
  const errors = [];
  for (const [key, rule] of Object.entries(schema)) {
    const v = body ? body[key] : undefined;
    if (v === undefined || v === null || v === '') {
      if (rule.required) errors.push(`"${key}" é obrigatório`);
      else if (v !== undefined) out[key] = null;
      continue;
    }
    if (rule.type === 'string' && typeof v !== 'string') errors.push(`"${key}" deve ser texto`);
    else if (rule.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) errors.push(`"${key}" deve ser número`);
    else if (rule.type === 'boolean' && typeof v !== 'boolean') errors.push(`"${key}" deve ser booleano`);
    else if (rule.type === 'date' && !isIsoDate(v)) errors.push(`"${key}" deve ser uma data válida`);
    else if (rule.oneOf && !rule.oneOf.includes(v)) errors.push(`"${key}" deve ser um de: ${rule.oneOf.join(', ')}`);
    else if (rule.positive && v <= 0) errors.push(`"${key}" deve ser maior que zero`);
    else out[key] = v;
  }
  if (errors.length) throw new ValidationError(errors.join('; '));
  return out;
}

const errorHandler = (err, req, res, next) => {
  if (err instanceof ValidationError) return res.status(400).json({ message: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'JSON inválido' });
  console.error(`${req.method} ${req.originalUrl} falhou:`, err);
  res.status(500).json({ message: 'Erro interno do servidor' });
};

module.exports = { wrap, newId, validate, ValidationError, errorHandler };
