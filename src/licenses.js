const crypto = require('crypto');
const { getPool } = require('./db');

// How many WordPress sites a single purchase can be active on at once.
const SITE_LIMIT = 1;

function newLicenseKey() {
  return `SBA-${crypto.randomUUID().toUpperCase()}`;
}

function normalizeSiteUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase().replace(/\/+$/, '');
  if (!trimmed || trimmed.length > 200) return null;
  return trimmed;
}

function rowToLicense(row) {
  if (!row) return null;
  return {
    licenseKey: row.license_key,
    email: row.email,
    stripeCustomerId: row.stripe_customer_id,
    stripeSessionId: row.stripe_session_id,
    status: row.status,
    createdAt: row.created_at,
    emailClaimedAt: row.email_claimed_at,
    emailSentAt: row.email_sent_at,
  };
}

// Called from the Stripe webhook once a checkout actually completes.
async function createLicense({ email, stripeCustomerId, stripeSessionId }) {
  const key = newLicenseKey();
  await getPool().query(
    `insert into licenses (license_key, email, stripe_customer_id, stripe_session_id)
     values ($1, $2, $3, $4)`,
    [key, email || null, stripeCustomerId || null, stripeSessionId || null]
  );
  return key;
}

async function getLicense(key) {
  const { rows } = await getPool().query('select * from licenses where license_key = $1', [key]);
  return rowToLicense(rows[0]);
}

async function getLicenseBySession(stripeSessionId) {
  const { rows } = await getPool().query('select * from licenses where stripe_session_id = $1', [stripeSessionId]);
  return rowToLicense(rows[0]);
}

async function getLicenseKeyBySession(stripeSessionId) {
  const license = await getLicenseBySession(stripeSessionId);
  return license ? license.licenseKey : null;
}

/**
 * Registers a site against a license, or just refreshes it if already
 * registered — re-activating the same site (e.g. re-saving the settings
 * field) must never count a second time against the limit.
 *
 * The count-then-insert is wrapped in a transaction with an advisory lock
 * per license key (same technique Magpie's devices.ts uses) so two
 * activation attempts landing at the same instant can't both slip past the
 * limit check before either has inserted its row.
 */
async function activateSite(key, siteUrlInput) {
  const siteUrl = normalizeSiteUrl(siteUrlInput);
  if (!siteUrl) return { allowed: false, reason: 'invalid_site' };

  const license = await getLicense(key);
  if (!license) return { allowed: false, reason: 'not_found' };
  if (license.status !== 'active') return { allowed: false, reason: 'revoked' };

  const client = await getPool().connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [key]);

    const existing = await client.query(
      'select 1 from license_sites where license_key = $1 and site_url = $2',
      [key, siteUrl]
    );
    if (existing.rowCount > 0) {
      await client.query(
        'update license_sites set last_seen = now() where license_key = $1 and site_url = $2',
        [key, siteUrl]
      );
      await client.query('commit');
      return { allowed: true };
    }

    const { rows } = await client.query(
      'select count(*)::int as n from license_sites where license_key = $1',
      [key]
    );
    if (rows[0].n >= SITE_LIMIT) {
      await client.query('commit');
      return { allowed: false, reason: 'site_limit', limit: SITE_LIMIT };
    }

    await client.query(
      'insert into license_sites (license_key, site_url) values ($1, $2)',
      [key, siteUrl]
    );
    await client.query('commit');
    return { allowed: true };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function validateSite(key, siteUrlInput) {
  const siteUrl = normalizeSiteUrl(siteUrlInput);
  const license = await getLicense(key);
  if (!license) return { valid: false, reason: 'not_found' };
  if (license.status !== 'active') return { valid: false, reason: 'revoked' };
  if (!siteUrl) return { valid: false, reason: 'site_not_activated' };

  const { rowCount } = await getPool().query(
    'select 1 from license_sites where license_key = $1 and site_url = $2',
    [key, siteUrl]
  );
  return rowCount > 0 ? { valid: true } : { valid: false, reason: 'site_not_activated' };
}

// Frees this license's one slot — lets a genuine customer move the plugin
// to a different site.
async function deactivateSite(key, siteUrlInput) {
  const siteUrl = normalizeSiteUrl(siteUrlInput);
  const license = await getLicense(key);
  if (!license) return { ok: false, reason: 'not_found' };
  await getPool().query('delete from license_sites where license_key = $1 and site_url = $2', [key, siteUrl]);
  return { ok: true };
}

// For refunds/chargebacks, via the Stripe webhook.
async function revokeLicense(key) {
  const { rowCount } = await getPool().query("update licenses set status = 'revoked' where license_key = $1", [key]);
  return rowCount > 0;
}

/**
 * Delivery tracking for the license email — a Stripe webhook retry must
 * not send a second email for the same purchase. Mirrors the claim/
 * complete/release pattern Magpie's backend uses for the same reason
 * (checkout.session.completed can be delivered more than once).
 */
async function claimEmailDelivery(key) {
  const { rows } = await getPool().query(
    `update licenses
     set email_claimed_at = now()
     where license_key = $1
       and email_sent_at is null
       and (email_claimed_at is null or email_claimed_at < now() - interval '10 minutes')
     returning license_key`,
    [key]
  );
  return rows.length > 0;
}

async function completeEmailDelivery(key) {
  await getPool().query(
    'update licenses set email_claimed_at = null, email_sent_at = now() where license_key = $1',
    [key]
  );
}

async function releaseEmailDelivery(key) {
  await getPool().query(
    "update licenses set email_claimed_at = null where license_key = $1 and email_sent_at is null",
    [key]
  );
}

module.exports = {
  newLicenseKey,
  createLicense,
  getLicense,
  getLicenseBySession,
  getLicenseKeyBySession,
  activateSite,
  validateSite,
  deactivateSite,
  revokeLicense,
  claimEmailDelivery,
  completeEmailDelivery,
  releaseEmailDelivery,
  SITE_LIMIT,
};
