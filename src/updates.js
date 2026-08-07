const fs = require('fs');
const path = require('path');

// Same bind-mounted /app/data volume as usage.js and licenses.js. Zip files
// live alongside the metadata rather than in a database — a plugin update
// is just a file, and this backend already has nowhere better to put one.
const DATA_DIR = process.env.SBA_USAGE_DATA_DIR || path.join(__dirname, '..', 'data');
const UPDATES_DIR = path.join(DATA_DIR, 'updates');
const META_FILE = path.join(UPDATES_DIR, 'latest.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function save(meta) {
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(meta), 'utf8');
}

function zipPathFor(version) {
  return path.join(UPDATES_DIR, `service-booking-ai-standalone-${version}.zip`);
}

/**
 * @param {{version: string, changelog: string, zipBuffer: Buffer}} args
 */
function publish({ version, changelog, zipBuffer }) {
  fs.mkdirSync(UPDATES_DIR, { recursive: true });
  fs.writeFileSync(zipPathFor(version), zipBuffer);
  save({ version, changelog: changelog || '', releasedAt: new Date().toISOString() });
}

function getLatest() {
  return load();
}

function getZipPath(version) {
  const p = zipPathFor(version);
  return fs.existsSync(p) ? p : null;
}

/** Simple numeric-segment comparison — good enough for plain x.y.z versions. */
function isNewer( candidate, current ) {
  const a = String(candidate).split('.').map(Number);
  const b = String(current).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

module.exports = { publish, getLatest, getZipPath, isNewer };
