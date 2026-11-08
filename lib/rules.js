// Categorização por regras do usuário: a primeira palavra-chave contida na descrição vence.
async function applyRules(db, description) {
  const d = (description || '').toLowerCase();
  const rules = await db.all('SELECT keyword, category FROM mx_rules');
  const hit = rules.find((r) => d.includes(r.keyword.toLowerCase()));
  return hit ? hit.category : null;
}
module.exports = { applyRules };
