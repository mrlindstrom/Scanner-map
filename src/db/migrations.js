'use strict';

const { createLogger } = require('../logger');

const log = createLogger('db:migrate');

/**
 * Idempotent schema upgrades + performance indexes.
 * Accepts an open sqlite3 Database handle (callback API) and returns a Promise.
 *
 * Safe to run on every boot.
 */
function runMigrations(db) {
  const statements = [
    // ----- Performance indexes (the big win: these queries were full scans) -----
    `CREATE INDEX IF NOT EXISTS idx_transcriptions_talkgroup
       ON transcriptions(talk_group_id)`,
    `CREATE INDEX IF NOT EXISTS idx_transcriptions_timestamp
       ON transcriptions(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_transcriptions_tg_ts
       ON transcriptions(talk_group_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_transcriptions_latlon
       ON transcriptions(lat, lon)`,
    `CREATE INDEX IF NOT EXISTS idx_transcriptions_category
       ON transcriptions(category)`,
    `CREATE INDEX IF NOT EXISTS idx_audio_files_transcription
       ON audio_files(transcription_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_token
       ON sessions(token)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user
       ON sessions(user_id)`,
    // Multi-system support: talkgroups are keyed by (system, id). The
    // transcriptions(system) index is created later, after the column is added.
    `CREATE INDEX IF NOT EXISTS idx_talk_groups_id
       ON talk_groups(id)`,
    // Mapped calls still without a category (the web server's catch-up sweep);
    // stays small, where idx_transcriptions_category would walk every
    // uncategorized unmapped call
    `CREATE INDEX IF NOT EXISTS idx_transcriptions_uncategorized_mapped
       ON transcriptions(id) WHERE category IS NULL AND lat IS NOT NULL`,

    // ----- New columns for externalized audio storage (nullable, backwards compatible) -----
    // storage_key  : object key in the configured storage backend
    // storage_mode : which backend the audio lives in (local/s3/r2/b2/minio/db)
  ];

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      let pending = statements.length;
      let failed = false;

      const done = (err) => {
        if (failed) return;
        if (err && !/no such table/i.test(err.message)) {
          failed = true;
          log.error(`migration failed: ${err.message}`);
          return reject(err);
        }
        // "no such table" just means the schema hasn't been created yet; the
        // index will be created on a later run once tables exist.
        if (--pending === 0) {
          // Add nullable columns separately (ALTER TABLE errors if column exists).
          addColumnIfMissing(db, 'transcriptions', 'storage_key', 'TEXT', () => {
            addColumnIfMissing(db, 'transcriptions', 'storage_mode', 'TEXT', () => {
              addColumnIfMissing(db, 'transcriptions', 'system', 'TEXT', () => {
                // Safe to index now that the column exists.
                db.run(`CREATE INDEX IF NOT EXISTS idx_transcriptions_system ON transcriptions(system)`, () => {
                  // Partial index over calls whose audio is parked locally awaiting
                  // re-upload (src/storage/pendingUploads.js); stays tiny.
                  db.run(`CREATE INDEX IF NOT EXISTS idx_transcriptions_pending_upload
                            ON transcriptions(storage_key) WHERE storage_mode = 'pending'`, () => {
                  migrateTalkGroupsToComposite(db, () => {
                    log.info('migrations complete (indexes + storage + multi-system ensured)');
                    resolve();
                  });
                  });
                });
              });
            });
          });
        }
      };

      for (const sql of statements) db.run(sql, done);
      if (statements.length === 0) done();
    });
  });
}

function addColumnIfMissing(db, table, column, type, cb) {
  db.all(`PRAGMA table_info(${table})`, (err, rows) => {
    if (err) {
      // Table may not exist yet on a brand-new DB; ignore and continue.
      return cb();
    }
    // PRAGMA table_info returns an empty set (no error) when the table doesn't
    // exist yet — e.g. during first-time setup before the bot creates schema.
    // Skip silently so we don't emit "no such table" warnings.
    if (!rows || rows.length === 0) return cb();
    const exists = rows.some((r) => r.name === column);
    if (exists) return cb();
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`, (alterErr) => {
      if (alterErr && !/duplicate column/i.test(alterErr.message)) {
        log.warn(`could not add ${table}.${column}: ${alterErr.message}`);
      } else if (!alterErr) {
        log.info(`added column ${table}.${column}`);
      }
      cb();
    });
  });
}

/**
 * Rebuild the talk_groups table so its primary key is (system, id) instead of
 * just id. Talkgroup IDs collide across radio systems, and the old PK(id) caused
 * INSERT OR REPLACE to silently overwrite one system's talkgroup with another's.
 *
 * Idempotent: if the table already has a `system` column we assume it's migrated.
 * If the table doesn't exist yet (fresh DB), bot.js creates it with the new
 * schema directly, so there's nothing to do here.
 */
function migrateTalkGroupsToComposite(db, cb) {
  db.all(`PRAGMA table_info(talk_groups)`, (err, rows) => {
    if (err || !rows || rows.length === 0) {
      // Table doesn't exist yet; the CREATE TABLE in bot.js handles new schema.
      return cb();
    }
    const hasSystem = rows.some((r) => r.name === 'system');
    if (hasSystem) return cb(); // already migrated

    log.info('migrating talk_groups to composite key (system, id)...');
    const sql = `
      BEGIN TRANSACTION;
      CREATE TABLE talk_groups_new (
        id TEXT NOT NULL,
        system TEXT NOT NULL DEFAULT '',
        hex TEXT,
        alpha_tag TEXT,
        mode TEXT,
        description TEXT,
        tag TEXT,
        county TEXT,
        PRIMARY KEY (system, id)
      );
      INSERT INTO talk_groups_new (id, system, hex, alpha_tag, mode, description, tag, county)
        SELECT id, '', hex, alpha_tag, mode, description, tag, county FROM talk_groups;
      DROP TABLE talk_groups;
      ALTER TABLE talk_groups_new RENAME TO talk_groups;
      CREATE INDEX IF NOT EXISTS idx_talk_groups_id ON talk_groups(id);
      COMMIT;
    `;
    db.exec(sql, (execErr) => {
      if (execErr) {
        log.error(`talk_groups migration failed, rolling back: ${execErr.message}`);
        db.exec('ROLLBACK;', () => cb());
      } else {
        log.info('talk_groups migrated to (system, id) key');
        cb();
      }
    });
  });
}

/**
 * Settings for every connection to botdata.db. The bot and the web server
 * each have one, so:
 * - WAL journal: reads (map loads, summaries, sweeps) don't block the other
 *   process's writes and the reverse; only two writes at once wait for each
 *   other. Kept in the database file, so setting it again is a no-op.
 * - Waiting up to 15 s for a lock instead of sqlite3's 1 s before SQLITE_BUSY.
 * - synchronous=NORMAL: the usual pairing with WAL (safe on a crash; only a
 *   power cut can drop the last commits).
 */
function configureConnection(db, label = 'db') {
  db.configure('busyTimeout', 15000);
  db.get('PRAGMA journal_mode = WAL', (err, row) => {
    const mode = row && (row.journal_mode || Object.values(row)[0]);
    if (err) log.warn(`${label}: could not switch to WAL: ${err.message}`);
    else if (String(mode).toLowerCase() !== 'wal') log.warn(`${label}: journal mode is ${mode}, not WAL`);
  });
  db.run('PRAGMA synchronous = NORMAL', () => {});
}

module.exports = { runMigrations, configureConnection };
