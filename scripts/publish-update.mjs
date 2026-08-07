// Publishes a new Service Booking AI plugin version to the backend, so
// existing licensed sites see "Update available" the next time WordPress
// checks. Reads UPDATE_ADMIN_SECRET and APP_URL from backend/.env.local —
// same "never on the command line" pattern as setup-stripe.mjs.
//
//   node scripts/publish-update.mjs --version=1.1.0 --zip=../service-booking-ai-standalone.zip --changelog=changelog.txt
//
// --changelog points at a plain text file (one line per note is fine); omit
// it to publish with an empty changelog.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env.local');

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const env = { ...parseEnvFile(envPath), ...process.env };

const version = arg('version');
const zipPath = arg('zip');
const changelogPath = arg('changelog');

if (!version || !zipPath) {
  console.error('Usage: node scripts/publish-update.mjs --version=1.1.0 --zip=path/to.zip [--changelog=path/to.txt]');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Version "${version}" doesn't look like plain x.y.z — that's what the plugin's own version-compare logic expects.`);
  process.exit(1);
}
if (!existsSync(zipPath)) {
  console.error(`No file at ${zipPath}`);
  process.exit(1);
}
if (!env.UPDATE_ADMIN_SECRET) {
  console.error(`UPDATE_ADMIN_SECRET is not set in ${envPath}`);
  process.exit(1);
}
if (!env.APP_URL) {
  console.error(`APP_URL is not set in ${envPath}`);
  process.exit(1);
}

const zipBuffer = readFileSync(zipPath);
const changelog = changelogPath && existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';

const res = await fetch(`${env.APP_URL}/admin/publish-update`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${env.UPDATE_ADMIN_SECRET}`,
    'Content-Type': 'application/zip',
    'X-Version': version,
    'X-Changelog-Base64': Buffer.from(changelog, 'utf8').toString('base64'),
  },
  body: zipBuffer,
});

const body = await res.json().catch(() => ({}));

if (!res.ok) {
  console.error(`Publish failed (${res.status}):`, body);
  process.exit(1);
}

console.log(`Published version ${body.version}. Licensed sites will see it within ${env.APP_URL ? '12 hours (or immediately after clicking "Check Again" on the Plugins page)' : ''}.`);
