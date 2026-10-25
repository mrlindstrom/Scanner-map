'use strict';

/**
 * Catching up on calls the AI missed.
 *
 * While the AI is paused by hand or not answering, new calls are posted
 * without an address lookup (or the lookup gives up in the queue). When the AI
 * is back (llmQueue.onResume), the calls from the time it stopped until now
 * are queued here and looked up again, oldest first, one at a time and behind
 * live calls. Pausing again (or another outage) stops it where it is; it goes
 * on from there when the AI is back, also after a restart, since the ranges
 * still to do are kept in data/ai-catchup.json.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.SCANNER_AI_CATCHUP_FILE || path.join(__dirname, '..', '..', 'data', 'ai-catchup.json');
const PAGE = 200;
const SAVE_EVERY_MS = 5000;

/**
 * @param {object} o
 * @param {object} o.db  sqlite3 database with the transcriptions table
 * @param {object} o.logger
 * @param {(row) => boolean} o.needsLookup  whether a call (id, talk_group_id, system, transcription, lat) should be looked up
 * @param {(row) => Promise<'done'|'unavailable'>} o.lookup  look one call up; 'unavailable' when the AI stopped answering
 * @param {() => boolean} o.isReady  whether the AI can take requests now
 */
function createCatchUp({ db, logger, needsLookup, lookup, isReady }) {
  // [{ nextId, endId, total, done, since }] oldest first
  let ranges = load();
  let running = false;
  let lastSave = 0;
  let current = null; // id being looked up

  const all = (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
  const get = (sql, params) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return Array.isArray(data.ranges) ? data.ranges.filter((r) => r.nextId <= r.endId) : [];
    } catch (_) {
      return [];
    }
  }

  function save(force = false) {
    if (!force && Date.now() - lastSave < SAVE_EVERY_MS) return;
    lastSave = Date.now();
    try {
      if (!ranges.length) {
        fs.rmSync(FILE, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify({ ranges }, null, 2));
    } catch (e) {
      logger.warn(`[AI catch-up] Could not save progress: ${e.message}`);
    }
  }

  // How many calls in [fromId, toId] need a lookup (read in pages; transcripts are small)
  async function countNeeded(fromId, toId) {
    let n = 0;
    let after = fromId - 1;
    for (;;) {
      const rows = await all(
        'SELECT id, talk_group_id, system, transcription, lat FROM transcriptions WHERE id > ? AND id <= ? ORDER BY id LIMIT 2000',
        [after, toId],
      );
      if (!rows.length) return n;
      for (const r of rows) if (needsLookup(r)) n++;
      after = rows[rows.length - 1].id;
    }
  }

  /**
   * Queue the calls from sinceMs until now, then start.
   * @param {{ reason: string, since: number }} info  from llmQueue.onResume
   */
  async function enqueue({ reason, since }) {
    try {
      const sinceSec = Math.floor(since / 1000);
      const first = await get('SELECT MIN(id) AS id FROM transcriptions WHERE timestamp >= ?', [sinceSec]);
      const last = await get('SELECT MAX(id) AS id FROM transcriptions', []);
      if (!first || first.id == null || !last || last.id == null) {
        return run();
      }
      // Calls already queued (or already looked up) from an earlier pause aren't done twice
      let fromId = first.id;
      for (const r of ranges) if (fromId <= r.endId) fromId = Math.max(fromId, r.endId + 1);
      if (fromId <= last.id) {
        const total = await countNeeded(fromId, last.id);
        if (total > 0) {
          ranges.push({ nextId: fromId, endId: last.id, total, done: 0, since: new Date(since).toISOString() });
          save(true);
          const why = reason === 'pause' ? 'the AI was paused' : 'the AI was not answering';
          logger.info(`[AI catch-up] ${total} call(s) from while ${why} (since ${new Date(since).toLocaleString()}) queued for an address lookup`);
        }
      }
    } catch (e) {
      logger.error(`[AI catch-up] Could not queue missed calls: ${e.message}`);
    }
    return run();
  }

  async function run() {
    if (running || !ranges.length) return;
    running = true;
    let looked = 0;
    try {
      while (ranges.length && isReady()) {
        const range = ranges[0];
        const rows = await all(
          'SELECT id, talk_group_id, system, transcription, lat FROM transcriptions WHERE id >= ? AND id <= ? ORDER BY id LIMIT ?',
          [range.nextId, range.endId, PAGE],
        );
        if (!rows.length) {
          ranges.shift();
          save(true);
          continue;
        }
        let stopped = false;
        for (const row of rows) {
          if (!isReady()) { stopped = true; break; }
          if (needsLookup(row)) {
            current = row.id;
            const outcome = await lookup(row);
            current = null;
            if (outcome === 'unavailable') { stopped = true; break; } // this call again next time
            range.done++;
            looked++;
          }
          range.nextId = row.id + 1;
          save();
        }
        if (range.nextId > range.endId) {
          ranges.shift();
          save(true);
        }
        if (stopped) break;
      }
    } catch (e) {
      logger.error(`[AI catch-up] Stopped: ${e.message}`);
    } finally {
      running = false;
      current = null;
      save(true);
      if (ranges.length) {
        const left = ranges.reduce((n, r) => n + Math.max(0, r.total - r.done), 0);
        if (looked) logger.info(`[AI catch-up] Paused after ${looked} call(s); about ${left} left, going on when the AI is back`);
      } else if (looked) {
        logger.info(`[AI catch-up] Done: looked up ${looked} missed call(s)`);
      }
    }
  }

  function status() {
    if (!ranges.length) return null;
    const total = ranges.reduce((n, r) => n + r.total, 0);
    const done = ranges.reduce((n, r) => n + Math.min(r.done, r.total), 0);
    return { total, done, running, current, since: ranges[0].since };
  }

  /** Forget the calls still queued. */
  function clear() {
    const left = status();
    ranges = [];
    save(true);
    return left;
  }

  return { enqueue, run, status, clear };
}

module.exports = { createCatchUp, FILE };
