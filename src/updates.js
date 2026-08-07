const { getPool } = require('./db');

/**
 * @param {{version: string, changelog: string, zipBuffer: Buffer}} args
 */
async function publish({ version, changelog, zipBuffer }) {
  await getPool().query(
    `insert into releases (version, changelog, zip_data, released_at)
     values ($1, $2, $3, now())
     on conflict (version) do update set
       changelog = excluded.changelog,
       zip_data = excluded.zip_data,
       released_at = now()`,
    [version, changelog || '', zipBuffer]
  );
}

/** Simple numeric-segment comparison — good enough for plain x.y.z versions. */
function isNewer(candidate, current) {
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

/**
 * @return {Promise<{version: string, changelog: string, releasedAt: Date}|null>}
 *          The highest version currently published, by numeric comparison
 *          (not just whichever row was inserted most recently — a mistaken
 *          out-of-order publish shouldn't demote what customers see as latest).
 */
async function getLatest() {
  const { rows } = await getPool().query('select version, changelog, released_at from releases');
  if (!rows.length) return null;

  let latest = rows[0];
  for (const row of rows.slice(1)) {
    if (isNewer(row.version, latest.version)) latest = row;
  }
  return { version: latest.version, changelog: latest.changelog, releasedAt: latest.released_at };
}

/** @return {Promise<Buffer|null>} */
async function getZipBuffer(version) {
  const { rows } = await getPool().query('select zip_data from releases where version = $1', [version]);
  return rows[0] ? rows[0].zip_data : null;
}

module.exports = { publish, getLatest, getZipBuffer, isNewer };
