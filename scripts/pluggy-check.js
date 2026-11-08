// Verifica a integração com a Pluggy sem gravar nada: node scripts/pluggy-check.js [itemId]
// Lê o .env da API. Sem itemId, só testa as credenciais e a emissão do token do widget.
try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* sem .env */ }
const pluggy = require('../lib/pluggy');

const ok = (m) => console.log(`  ✔ ${m}`);
const fail = (m) => { console.log(`  ✘ ${m}`); process.exitCode = 1; };

(async () => {
  console.log(`Pluggy: ${process.env.PLUGGY_API_URL || 'https://api.pluggy.ai'}`);
  if (!pluggy.configured()) return fail('Defina PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no .env');
  ok('credenciais encontradas no .env');

  try { await pluggy.createConnectToken(); ok('autenticou e gerou o token do widget (credenciais válidas)'); }
  catch (e) { return fail(`autenticação falhou: ${e.message}`); }

  const itemId = process.argv[2];
  if (!itemId) return console.log('\nPara testar uma conexão existente: node scripts/pluggy-check.js <itemId>');

  try {
    const item = await pluggy.getItem(itemId);
    ok(`item ${itemId}: ${item?.connector?.name || '?'} (status ${item?.status})`);
    const accounts = await pluggy.listAccounts(itemId);
    ok(`${accounts.length} conta(s)/cartão(ões)`);
    for (const a of accounts) {
      const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const txs = await pluggy.listTransactions(a.id, from, new Date().toISOString().slice(0, 10));
      console.log(`      - ${a.type}/${a.subtype} "${a.marketingName || a.name}" saldo ${a.balance} · ${txs.length} lançamento(s) em 30 dias`);
    }
    ok(`${(await pluggy.listInvestments(itemId)).length} investimento(s)`);
  } catch (e) { fail(e.message); }
})();
