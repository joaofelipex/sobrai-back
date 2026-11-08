// Cliente mínimo da API da Pluggy (open finance). As credenciais ficam só no servidor.
// Docs: https://docs.pluggy.ai — POST /auth troca clientId/clientSecret por uma apiKey (válida ~2h).
const base = () => (process.env.PLUGGY_API_URL || 'https://api.pluggy.ai').replace(/\/$/, '');
const configured = () => Boolean(process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET);

class PluggyError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

let cached = { key: null, expires: 0 };

async function request(method, path, { body, query, key } = {}) {
  const url = new URL(base() + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-KEY': key } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new PluggyError(`Não foi possível falar com a Pluggy: ${err.message}`, 502);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* corpo não-JSON */ }
  if (!res.ok) throw new PluggyError(data?.message || `Pluggy respondeu ${res.status}`, res.status);
  return data;
}

async function apiKey() {
  if (!configured()) throw new PluggyError('Pluggy não configurada: defina PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET', 503);
  if (cached.key && Date.now() < cached.expires) return cached.key;
  const { apiKey: key } = await request('POST', '/auth', {
    body: { clientId: process.env.PLUGGY_CLIENT_ID, clientSecret: process.env.PLUGGY_CLIENT_SECRET },
  });
  cached = { key, expires: Date.now() + 100 * 60 * 1000 };
  return key;
}

/** Chamada autenticada; renova a apiKey uma vez se a Pluggy a recusar. */
async function call(method, path, opts = {}) {
  try {
    return await request(method, path, { ...opts, key: await apiKey() });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      cached = { key: null, expires: 0 };
      return request(method, path, { ...opts, key: await apiKey() });
    }
    throw err;
  }
}

/** Percorre todas as páginas de uma listagem `{ results, totalPages }`. */
async function listAll(path, query) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const data = await call('GET', path, { query: { ...query, page, pageSize: 500 } });
    out.push(...(data?.results || []));
    if (page >= (data?.totalPages || 1)) break;
  }
  return out;
}

module.exports = {
  PluggyError,
  configured,
  /** Token de curta duração para abrir o widget Pluggy Connect no navegador. */
  createConnectToken: (itemId) => call('POST', '/connect_token', { body: itemId ? { itemId } : {} }).then((r) => r.accessToken),
  getItem: (itemId) => call('GET', `/items/${encodeURIComponent(itemId)}`),
  listAccounts: (itemId) => listAll('/accounts', { itemId }),
  listTransactions: (accountId, from, to) => listAll('/transactions', { accountId, from, to }),
  listInvestments: (itemId) => listAll('/investments', { itemId }),
};
