# API do MiXCo (sobrai-back)

Express + SQLite (`sobrai.db`, ignorado no git). Rotas do MiXCo em `routes/mixco.js` e `routes/mixco-pluggy.js`, prefixo `/api/mixco`.
Tabelas `mx_*` em `database.js` (migrações idempotentes). Sem autenticação, por decisão do dono: uso local apenas.

## Pluggy (open finance)
- `lib/pluggy.js` (cliente), `lib/pluggy-sync.js` (importação), credenciais só em `.env` (`PLUGGY_CLIENT_ID/SECRET`)
- `npm run pluggy:check [itemId]` valida credenciais e uma conexão sem gravar nada
- Só avança a janela de sincronização quando o item está `UPDATED`; lançamento apagado pelo usuário não volta (`mx_tombstones`); syncs rodam em fila
- Remover a conexão converte contas/ativos em manuais preservando o saldo

## Testes
`npm test` (22 testes, `node:test`). A Pluggy é simulada em `test/mixco-pluggy.test.js`. Ao mexer em dinheiro (saldo, fluxo, projeção), adicione teste.

## Cuidado
`crud()` em `routes/mixco.js`: o `select` não pode ter WHERE no nível externo nem ORDER BY (use `orderBy`).
