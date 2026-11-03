'use strict';

/**
 * Local copy of radio aliases (unit names such as "CCFD E25" or "SFD LADDER 74D").
 *
 * Trunk-recorder sends a srcList with each call: every radio that keyed up, and
 * its over-the-air alias when the system broadcasts one. Aliases are often
 * missing on a given call, so we keep the last one seen per (system, radio id)
 * and fill the gaps from it. Trunk-recorder stays the source of truth: when it
 * sends an alias that differs from ours, ours is replaced.
 *
 * Each call's own radio list is also kept on the call (transcriptions.src_list),
 * so features such as the CAD board can tell which units talked on it.
 */

let ready = null;
let log = { info() {}, warn() {} };

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); }));
}
function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}

function init(db, logger) {
  if (logger) log = logger;
  if (!ready) {
    ready = (async () => {
      await run(db, `CREATE TABLE IF NOT EXISTS radio_aliases (
        system TEXT NOT NULL,
        radio_id TEXT NOT NULL,
        alias TEXT,
        first_seen INTEGER,
        last_seen INTEGER,
        alias_updated INTEGER,
        PRIMARY KEY (system, radio_id)
      )`);
      try {
        await run(db, 'ALTER TABLE transcriptions ADD COLUMN src_list TEXT');
      } catch (err) {
        if (!/duplicate column/i.test(err.message)) throw err;
      }
    })().catch((err) => { ready = null; throw err; });
  }
  return ready;
}

/** srcList (JSON string or array) -> [{ pos, src, tag }] with real radio ids only */
function parseSrcList(srcList) {
  let list = srcList;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => ({
      pos: Number(s.pos) || 0,
      src: s.src != null ? String(s.src) : '',
      tag: typeof s.tag === 'string' ? s.tag.replace(/\s+/g, ' ').trim() : '',
    }))
    .filter((s) => s.src && s.src !== '-1' && s.src !== '0');
}

/**
 * Save a call's radio list and learn its aliases.
 * @param {object} db sqlite3 database
 * @param {{ transcriptionId: number, system: string, srcList: string|object[], timestamp: number }} call
 */
async function recordCall(db, { transcriptionId, system, srcList, timestamp }) {
  const radios = parseSrcList(srcList);
  if (!radios.length) return;
  await init(db);
  const sys = String(system || '');
  const at = Number(timestamp) || Math.floor(Date.now() / 1000);

  await run(db, 'UPDATE transcriptions SET src_list = ? WHERE id = ?',
    [JSON.stringify(radios.map((r) => (r.tag ? { pos: r.pos, src: r.src, tag: r.tag } : { pos: r.pos, src: r.src }))), transcriptionId]);

  // One entry per radio, keeping an alias if any entry carried one
  const byId = new Map();
  for (const r of radios) if (!byId.has(r.src) || (!byId.get(r.src) && r.tag)) byId.set(r.src, r.tag);
  const ids = [...byId.keys()];
  const known = new Map((await all(db, `SELECT radio_id, alias FROM radio_aliases WHERE system = ? AND radio_id IN (${ids.map(() => '?').join(',')})`, [sys, ...ids]))
    .map((r) => [r.radio_id, r.alias]));

  for (const [id, tag] of byId) {
    if (!known.has(id)) {
      await run(db, 'INSERT OR IGNORE INTO radio_aliases (system, radio_id, alias, first_seen, last_seen, alias_updated) VALUES (?, ?, ?, ?, ?, ?)',
        [sys, id, tag || null, at, at, tag ? at : null]);
    } else if (tag && tag !== known.get(id)) {
      // Trunk-recorder is the source of truth
      await run(db, 'UPDATE radio_aliases SET alias = ?, alias_updated = ?, last_seen = MAX(COALESCE(last_seen, 0), ?) WHERE system = ? AND radio_id = ?',
        [tag, at, at, sys, id]);
      if (known.get(id)) log.info(`Radio alias changed on ${sys}: ${id} "${known.get(id)}" -> "${tag}"`);
    } else {
      await run(db, 'UPDATE radio_aliases SET last_seen = MAX(COALESCE(last_seen, 0), ?) WHERE system = ? AND radio_id = ?', [at, sys, id]);
    }
  }
}

/** Aliases for radio ids on one system: Map(radio_id -> alias) */
async function lookup(db, system, radioIds) {
  const ids = [...new Set(radioIds.map(String))];
  if (!ids.length) return new Map();
  await init(db);
  const rows = await all(db, `SELECT radio_id, alias FROM radio_aliases WHERE system = ? AND alias IS NOT NULL AND radio_id IN (${ids.map(() => '?').join(',')})`,
    [String(system || ''), ...ids]);
  return new Map(rows.map((r) => [r.radio_id, r.alias]));
}

/** A call's radios with aliases filled in from the local copy where the call had none */
async function radiosForCall(db, system, srcListJson) {
  const radios = parseSrcList(srcListJson);
  const missing = radios.filter((r) => !r.tag).map((r) => r.src);
  const aliases = await lookup(db, system, missing);
  return radios.map((r) => ({ ...r, alias: r.tag || aliases.get(r.src) || null, fromCall: !!r.tag }));
}

module.exports = { init, parseSrcList, recordCall, lookup, radiosForCall };
