const { getPool } = require('./db');

// USD per 1 million tokens. Source: OpenAI's published API pricing, checked
// August 2026. A model not listed here still gets counted in totalTokens,
// just with hasUnpricedUsage flagged instead of a wrong cost.
const PRICING_PER_MILLION_TOKENS = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
};

function emptyBucket() {
  return { callCount: 0, totalTokens: 0, totalCostUsd: 0, hasUnpricedUsage: false };
}

function estimateCost(model, promptTokens, completionTokens) {
  const rates = PRICING_PER_MILLION_TOKENS[model];
  if (!rates) return null;
  return (promptTokens * rates.input + completionTokens * rates.output) / 1000000;
}

// Call this right after any completed OpenAI chat completion, passing the
// response's own usage object — no separate lookup needed.
async function logUsage(model, promptTokens, completionTokens) {
  const cost = estimateCost(model, promptTokens || 0, completionTokens || 0);
  await getPool().query(
    `insert into usage_log (source, model, prompt_tokens, completion_tokens, estimated_cost_usd)
     values ($1, $2, $3, $4, $5)`,
    ['chat', model, promptTokens || 0, completionTokens || 0, cost]
  );
}

async function summarize(sinceClause, params) {
  const { rows } = await getPool().query(
    `select
       count(*)::int as call_count,
       coalesce(sum(prompt_tokens + completion_tokens), 0)::bigint as total_tokens,
       coalesce(sum(estimated_cost_usd), 0)::numeric as total_cost_usd,
       bool_or(estimated_cost_usd is null) as has_unpriced_usage
     from usage_log
     ${sinceClause}`,
    params
  );
  const row = rows[0];
  return {
    callCount: row.call_count,
    totalTokens: Number(row.total_tokens),
    totalCostUsd: Number(row.total_cost_usd),
    hasUnpricedUsage: !!row.has_unpriced_usage,
  };
}

async function getSummary() {
  const [allTime, thisMonth] = await Promise.all([
    summarize('', []),
    summarize("where created_at >= date_trunc('month', now())", []),
  ]);
  return { allTime, thisMonth };
}

// Clears logged usage — for after topping up the OpenAI account, so a
// countdown built on top of this starts fresh against the new credit.
async function reset() {
  await getPool().query('delete from usage_log');
}

module.exports = { logUsage, getSummary, reset, PRICING_PER_MILLION_TOKENS };
