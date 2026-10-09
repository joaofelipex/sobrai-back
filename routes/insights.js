const express = require('express');
const router = express.Router();
const { wrap, ValidationError } = require('../lib/http');

const MODEL = 'gemini-2.5-flash';
const COMPANY_TYPES = {
  mei: 'MEI (Microempreendedor Individual)',
  simples: 'Simples Nacional',
  autonomo: 'Trabalhador Autônomo',
};
const brl = (n) => n.toLocaleString('pt-BR');

function buildPrompt(profile, transactions) {
  const sum = (type) => transactions.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
  const totalRevenue = sum('revenue');
  const totalExpenses = sum('expense');

  const byCategory = {};
  for (const t of transactions) {
    if (t.type === 'expense') byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
  }
  const topExpenses = Object.entries(byCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([name, value]) => `${name}: R$ ${value.toFixed(2)}`)
    .join(', ');

  return `
    Você é 'Sobrai', um assistente financeiro especialista em pequenos negócios no Brasil.
    Seu tom é empático, motivador e fala a língua do empreendedor brasileiro.

    Analise o perfil e o resumo financeiro de uma empresa e gere 3 insights acionáveis e práticos.
    - Perfil da Empresa: ${COMPANY_TYPES[profile.type] || 'Pequeno Negócio'}
    - Faturamento Mensal Estimado no Onboarding: R$ ${brl(profile.monthlyRevenue)}

    - Resumo dos últimos 30 dias:
    - Receita Total: R$ ${brl(totalRevenue)}
    - Despesa Total: R$ ${brl(totalExpenses)}
    - Principais Despesas: ${topExpenses || 'Nenhuma despesa registrada.'}

    Os insights devem ser diretos, baseados nos dados fornecidos, fáceis de entender e focados em otimização fiscal, economia ou melhoria do fluxo de caixa.
    Varie os ícones entre 'lightbulb', 'trending-up', 'shield', 'zap', 'award'.
    Para o campo 'type', use 'economy', 'cashflow', ou 'reminder'.
    Para o campo 'priority', use 'Alta prioridade', 'Média prioridade', ou 'Baixa prioridade'.
    Preencha o campo 'estimatedImpact' com um valor em R$ ou uma breve descrição do impacto.
  `;
}

const str = { type: 'STRING' };
const responseSchema = {
  type: 'OBJECT',
  properties: {
    insights: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { title: str, description: str, icon: str, priority: str, type: str, estimatedImpact: str },
      },
    },
  },
};

// POST /api/insights  { profile, transactions } -> { insights: Insight[] }
router.post('/', wrap(async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ message: 'GEMINI_API_KEY não configurada no backend' });

  const { profile, transactions } = req.body || {};
  if (!profile || typeof profile.monthlyRevenue !== 'number' || !Array.isArray(transactions)) {
    throw new ValidationError('"profile" e "transactions" são obrigatórios');
  }
  const clean = transactions.slice(0, 500).filter(
    (t) => t && ['revenue', 'expense'].includes(t.type) && typeof t.amount === 'number'
  );

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(profile, clean) }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema },
      }),
    }
  );
  if (!response.ok) {
    console.error('Gemini respondeu', response.status, await response.text());
    return res.status(502).json({ message: 'Falha ao consultar a IA' });
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  res.json({ insights: JSON.parse(text).insights });
}));

module.exports = router;
