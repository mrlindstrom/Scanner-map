'use strict';

/**
 * Resilient audio saves for remote object storage (MinIO / S3 / R2 / B2).
 *
 *   saveWithFallback()  try the remote store a few times; if it still fails,
 *                       park the file under STORAGE_FALLBACK_DIR so the call
 *                       isn't lost (its DB row is marked storage_mode='pending')
 *   flushPending()      maintenance job: re-upload parked files, then delete
 *                       the local copies so they don't fill the disk
 *   pendingPath()       where a parked file lives (webserver uses this to play
 *                       audio that hasn't been uploaded yet)
 *
 * Settings (.env):
 *   STORAGE_SAVE_ATTEMPTS        total upload attempts per call        (3)
 *   STORAGE_RETRY_DELAY_MS       pause before 2nd attempt, doubles     (2000)
 *   STORAGE_SAVE_TIMEOUT_MS      per-attempt time limit                (15000)
 *   STORAGE_FALLBACK_DIR         where parked files go                 (audio/pending-upload)
 *   STORAGE_FALLBACK_MAX_MB      stop parking above this size          (2048)
 *   STORAGE_OUTAGE_COOLDOWN_SEC  after a failure, park new calls
 *                                directly for this long (no retries)   (120)
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createLogger } = require('../logger');

const log = createLogger('storage:pending');

const PENDING_MODE = 'pending';

function intEnv(name, fallback, env = process.env) {
  const n = parseInt(env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadConfig(env = process.env) {
  const dir = env.STORAGE_FALLBACK_DIR || path.join('audio', 'pending-upload');
  return {
    attempts: Math.max(1, intEnv('STORAGE_SAVE_ATTEMPTS', 3, env)),
    retryDelayMs: intEnv('STORAGE_RETRY_DELAY_MS', 2000, env),
    attemptTimeoutMs: intEnv('STORAGE_SAVE_TIMEOUT_MS', 15000, env),
    fallbackDir: path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir),
    maxBytes: intEnv('STORAGE_FALLBACK_MAX_MB', 2048, env) * 1024 * 1024,
    outageCooldownMs: intEnv('STORAGE_OUTAGE_COOLDOWN_SEC', 120, env) * 1000,
  };
}

const config = loadConfig();
let remoteDownUntil = 0; // set after a save exhausts its retries
let sizeCache = { at: 0, bytes: 0 }; // fallback folder size, refreshed every 30s

/** Local path for a parked object key (path traversal is blocked). */
function pendingPath(key, cfg = config) {
  const safeKey = path.normalize(String(key)).replace(/^(\.\.([/\\]|$))+/, '');
  const full = path.join(cfg.fallbackDir, safeKey);
  if (!full.startsWith(cfg.fallbackDir)) throw new Error('Invalid storage key');
  return full;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else {
      try { total += (await fsp.stat(full)).size; } catch { /* removed meanwhile */ }
    }
  }
  return total;
}

/**
 * Save to remote storage with retries; park locally if that fails.
 * Resolves to { location: 'remote' | 'pending' | 'none', error? }.
 *   remote   uploaded normally
 *   pending  parked under fallbackDir, waiting for flushPending()
 *   none     remote failed and the local fallback is full/unwritable
 */
async function saveWithFallback(storage, key, buffer, contentType, cfg = config) {
  let lastError = null;

  if (Date.now() >= remoteDownUntil) {
    for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
      try {
        await withTimeout(storage.save(key, buffer, contentType), cfg.attemptTimeoutMs);
        return { location: 'remote' };
      } catch (err) {
        lastError = err;
        if (attempt < cfg.attempts) {
          log.warn(`Upload attempt ${attempt}/${cfg.attempts} failed for ${key}: ${err.message}; retrying`);
          await sleep(cfg.retryDelayMs * 2 ** (attempt - 1));
        }
      }
    }
    // Storage looks down: park the next calls straight away instead of making
    // each one wait through its own retries. flushPending() clears this early.
    remoteDownUntil = Date.now() + cfg.outageCooldownMs;
    log.error(`Upload failed after ${cfg.attempts} attempts for ${key}: ${lastError && lastError.message}; saving locally`);
  } else {
    lastError = new Error('remote storage marked down after recent failures');
  }

  try {
    // Rescanning the folder on every parked call is slow during long outages;
    // reuse a recent total and add what we've parked since
    if (Date.now() - sizeCache.at > 30000) sizeCache = { at: Date.now(), bytes: await dirSize(cfg.fallbackDir) };
    if (sizeCache.bytes + buffer.length > cfg.maxBytes) {
      log.error(`Local fallback is over ${Math.round(cfg.maxBytes / 1048576)} MB; audio for ${key} is not being kept`);
      return { location: 'none', error: lastError };
    }
    const file = pendingPath(key, cfg);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buffer);
    sizeCache.bytes += buffer.length;
    return { location: 'pending', error: lastError };
  } catch (err) {
    log.error(`Could not save ${key} locally either: ${err.message}`);
    return { location: 'none', error: err };
  }
}

async function listPending(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await listPending(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

async function removeEmptyDirs(dir, root) {
  if (dir === root) return;
  try {
    if ((await fsp.readdir(dir)).length === 0) {
      await fsp.rmdir(dir);
      await removeEmptyDirs(path.dirname(dir), root);
    }
  } catch { /* not empty or already gone */ }
}

let flushing = false;

/**
 * Re-upload parked files. For each key, `getRow(key)` returns the DB row (or
 * null when the call was purged / retention-deleted, in which case the local
 * copy is just removed); `markUploaded(key)` records the remote location.
 * Returns { uploaded, removed, failed, remaining }.
 */
async function flushPending(storage, { getRow, markUploaded, batchSize = 200 } = {}, cfg = config) {
  if (flushing) return null;
  flushing = true;
  const stats = { uploaded: 0, removed: 0, failed: 0, remaining: 0 };
  try {
    const keys = await listPending(cfg.fallbackDir);
    stats.remaining = keys.length;
    if (!keys.length) return stats;

    for (const key of keys.slice(0, batchSize)) {
      const file = pendingPath(key, cfg);
      try {
        const row = getRow ? await getRow(key) : true;
        if (!row) {
          await fsp.unlink(file);
          stats.removed++;
        } else {
          const ext = path.extname(key).toLowerCase();
          const contentType = ext === '.m4a' ? 'audio/mp4' : ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
          await withTimeout(storage.save(key, await fsp.readFile(file), contentType), cfg.attemptTimeoutMs);
          if (markUploaded) await markUploaded(key);
          await fsp.unlink(file);
          stats.uploaded++;
          remoteDownUntil = 0; // storage is reachable again
        }
        await removeEmptyDirs(path.dirname(file), cfg.fallbackDir);
      } catch (err) {
        stats.failed++;
        log.warn(`Re-upload of ${key} failed: ${err.message}`);
        if (stats.failed >= 3 && stats.uploaded === 0) break; // still down; try again next run
      }
    }
    stats.remaining = keys.length - stats.uploaded - stats.removed;
    sizeCache.at = 0; // force a fresh size check after files were removed
    return stats;
  } finally {
    flushing = false;
  }
}

module.exports = {
  PENDING_MODE,
  loadConfig,
  config,
  pendingPath,
  saveWithFallback,
  flushPending,
  dirSize,
};
