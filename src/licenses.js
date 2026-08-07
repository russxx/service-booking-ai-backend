const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Same bind-mount pattern as usage.js — persists across redeploys via the
// volume mounted at /app/data. This is a single traditional Node process
// (not serverless/multi-instance), so plain synchronous file I/O makes the
// check-then-write in activateSite() atomic within one event-loop tick —
// no cross-request race, no need for the Postgres advisory-lock dance
// Magpie's backend uses for the same problem in a multi-instance setting.
const DATA_DIR = process.env.SBA_USAGE_DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'licenses.json');

// How many WordPress sites a single purchase can be active on at once.
const SITE_LIMIT = 1;

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return { licenses: parsed.licenses || {} };
  } catch (e) {
    return { licenses: {} };
  }
}

function save(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state), 'utf8');
  } catch (e) {
    console.error('licenses: failed to persist license data:', e.message);
  }
}

function newLicenseKey() {
  return `SBA-${crypto.randomUUID().toUpperCase()}`;
}

function normalizeSiteUrl(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase().replace(/\/+$/, '');
  if (!trimmed || trimmed.length > 200) return null;
  return trimmed;
}

// Called from the Stripe webhook once a checkout actually completes.
function createLicense({ email, stripeCustomerId, stripeSessionId }) {
  const state = load();
  const key = newLicenseKey();
  state.licenses[key] = {
    email: email || null,
    stripeCustomerId: stripeCustomerId || null,
    stripeSessionId: stripeSessionId || null,
    status: 'active',
    createdAt: new Date().toISOString(),
    sites: [],
  };
  save(state);
  return key;
}

function getLicense(key) {
  const state = load();
  return state.licenses[key] || null;
}

function getLicenseBySession(stripeSessionId) {
  const state = load();
  return Object.values(state.licenses).find((lic) => lic.stripeSessionId === stripeSessionId) || null;
}

function getLicenseKeyBySession(stripeSessionId) {
  const state = load();
  const entry = Object.entries(state.licenses).find(([, lic]) => lic.stripeSessionId === stripeSessionId);
  return entry ? entry[0] : null;
}

/**
 * Registers a site against a license, or just refreshes it if already
 * registered — re-activating the same site (e.g. re-saving the settings
 * field) must never count a second time against the limit.
 */
function activateSite(key, siteUrlInput) {
  const siteUrl = normalizeSiteUrl(siteUrlInput);
  const state = load();
  const license = state.licenses[key];

  if (!license) return { allowed: false, reason: 'not_found' };
  if (license.status !== 'active') return { allowed: false, reason: 'revoked' };
  if (!siteUrl) return { allowed: false, reason: 'invalid_site' };

  const now = new Date().toISOString();
  const existing = license.sites.find((s) => s.url === siteUrl);
  if (existing) {
    existing.lastSeen = now;
    save(state);
    return { allowed: true };
  }

  if (license.sites.length >= SITE_LIMIT) {
    return { allowed: false, reason: 'site_limit', limit: SITE_LIMIT };
  }

  license.sites.push({ url: siteUrl, firstSeen: now, lastSeen: now });
  save(state);
  return { allowed: true };
}

function validateSite(key, siteUrlInput) {
  const siteUrl = normalizeSiteUrl(siteUrlInput);
  const license = getLicense(key);
  if (!license) return { valid: false, reason: 'not_found' };
  if (license.status !== 'active') return { valid: false, reason: 'revoked' };
  if (!siteUrl || !license.sites.some((s) => s.url === siteUrl)) {
    return { valid: false, reason: 'site_not_activated' };
  }
  return { valid: true };
}

// Frees this license's one slot — lets a genuine customer move the plugin
// to a different site.
function deactivateSite(key, siteUrlInput) {
  const siteUrl = normalizeSiteUrl(siteUrlInput);
  const state = load();
  const license = state.licenses[key];
  if (!license) return { ok: false, reason: 'not_found' };
  license.sites = license.sites.filter((s) => s.url !== siteUrl);
  save(state);
  return { ok: true };
}

// For refunds/chargebacks, via the Stripe webhook.
function revokeLicense(key) {
  const state = load();
  const license = state.licenses[key];
  if (!license) return false;
  license.status = 'revoked';
  save(state);
  return true;
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
  SITE_LIMIT,
};
