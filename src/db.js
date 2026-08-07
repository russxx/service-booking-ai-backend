const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Coolify's internal database URL isn't reachable over TLS the way a
      // public managed database would be — disable it explicitly with
      // DATABASE_SSL=false rather than leaving pg to guess and fail.
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

// Creates every table this backend needs if they don't already exist — same
// "no separate migration step" convenience Magpie's backend relies on.
async function ensureSchema() {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL is not set');

  await p.query(`
    create table if not exists licenses (
      license_key text primary key,
      email text,
      stripe_customer_id text,
      stripe_session_id text unique,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      email_claimed_at timestamptz,
      email_sent_at timestamptz
    );

    create table if not exists license_sites (
      license_key text not null references licenses(license_key) on delete cascade,
      site_url text not null,
      first_seen timestamptz not null default now(),
      last_seen timestamptz not null default now(),
      primary key (license_key, site_url)
    );

    create table if not exists releases (
      version text primary key,
      changelog text not null default '',
      zip_data bytea not null,
      released_at timestamptz not null default now()
    );

    create table if not exists usage_log (
      id bigserial primary key,
      created_at timestamptz not null default now(),
      source text not null,
      model text not null,
      prompt_tokens bigint not null default 0,
      completion_tokens bigint not null default 0,
      estimated_cost_usd numeric(10,6)
    );

    create table if not exists processed_webhook_events (
      event_id text primary key,
      created_at timestamptz not null default now()
    );
  `);
}

module.exports = { getPool, ensureSchema };
