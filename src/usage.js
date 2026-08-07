const fs = require('fs');
const path = require('path');

// Bind-mounted at /app/data in production (see custom_docker_run_options on
// the Coolify app) so this survives redeploys — without that mount this
// falls back to the container's own ephemeral filesystem, which is fine for
// local dev but means the counter resets on every restart there.
const DATA_DIR = process.env.SBA_USAGE_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'usage.json');

// USD per 1 million tokens. Source: OpenAI's published API pricing, checked
// August 2026. A model not listed here still gets counted in totalTokens,
// just with hasUnpricedUsage flagged instead of a wrong cost.
const PRICING_PER_MILLION_TOKENS = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
};

function emptyBucket() {
  return { callCount: 0, totalTokens: 0, totalCostUsd: 0, hasUnpricedUsage: false };
}

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { allTime: parsed.allTime || emptyBucket(), months: parsed.months || {} };
  } catch (e) {
    return { allTime: emptyBucket(), months: {} };
  }
}

function save(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state), 'utf8');
  } catch (e) {
    console.error('usage: failed to persist usage data:', e.message);
  }
}

function estimateCost(model, promptTokens, completionTokens) {
  const rates = PRICING_PER_MILLION_TOKENS[model];
  if (!rates) return null;
  return (promptTokens * rates.input + completionTokens * rates.output) / 1000000;
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM, UTC
}

function addToBucket(bucket, tokens, cost) {
  bucket.callCount += 1;
  bucket.totalTokens += tokens;
  if (cost === null) {
    bucket.hasUnpricedUsage = true;
  } else {
    bucket.totalCostUsd += cost;
  }
}

// Call this right after any completed OpenAI chat completion, passing the
// response's own usage object — no separate lookup needed.
function logUsage(model, promptTokens, completionTokens) {
  const state = load();
  const tokens = (promptTokens || 0) + (completionTokens || 0);
  const cost = estimateCost(model, promptTokens || 0, completionTokens || 0);

  addToBucket(state.allTime, tokens, cost);

  const monthKey = currentMonthKey();
  if (!state.months[monthKey]) state.months[monthKey] = emptyBucket();
  addToBucket(state.months[monthKey], tokens, cost);

  // Only the current month's bucket is ever read back — drop any other
  // month so this file can't grow without bound.
  Object.keys(state.months).forEach((key) => {
    if (key !== monthKey) delete state.months[key];
  });

  save(state);
}

function getSummary() {
  const state = load();
  return { allTime: state.allTime, thisMonth: state.months[currentMonthKey()] || emptyBucket() };
}

// Clears logged usage — for after topping up the OpenAI account, so a
// countdown built on top of this starts fresh against the new credit.
function reset() {
  save({ allTime: emptyBucket(), months: {} });
}

module.exports = { logUsage, getSummary, reset, PRICING_PER_MILLION_TOKENS };
