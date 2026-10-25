'use strict';

/**
 * One queue for every request this process sends to the AI provider (Ollama or
 * OpenAI).
 *
 * - At most AI_MAX_CONCURRENT requests run at once (Ollama answers one at a
 *   time, so the default there is 1); the rest wait their turn, most important
 *   first.
 * - When the provider stops answering (connection refused, server errors, the
 *   model missing, repeated timeouts), new requests are held instead of sent:
 *   the queue pauses 5s, then 10s, 20s ... up to AI_BACKOFF_MAX_SEC, and after
 *   each pause sends a single request to see whether it's back.
 * - A request waits at most AI_QUEUE_WAIT_SEC, and at most AI_QUEUE_MAX wait at
 *   once; when it's full the oldest, least important request is dropped.
 *
 * - An admin can pause the AI by hand (Settings > Pause AI, e.g. while taking
 *   Ollama down). Nothing is sent until it's resumed; requests wait as above.
 *   The pause is kept in data/ai-paused.json so the bot and web server
 *   processes share it and it survives a restart.
 * - onResume(fn) is told when the AI is back after a pause or an outage, and
 *   from when requests may have been missed, so callers can catch up.
 *
 * Settings are read on every request, so changes apply right away.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const PRIORITY = { high: 0, normal: 1, low: 2 };
const DEFAULT_OLLAMA_NUM_CTX = 8192;
const FIRST_BACKOFF_MS = 5000;
// Timeouts / server errors in a row before pausing. A refused connection pauses at once.
const FAILURES_BEFORE_BACKOFF = 3;
// HTTP statuses that mean "not available right now" (404: Ollama doesn't have the model).
const OUTAGE_STATUSES = new Set([401, 403, 404, 408, 409, 425, 429]);

class LlmUnavailableError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'LlmUnavailableError';
    this.reason = reason; // 'paused' | 'full' | 'expired'
  }
}

let log = console;
const queue = [];
let running = 0;
let seq = 0;
let failures = 0; // in a row
let backoffMs = 0; // > 0 while the provider is considered down
let pausedUntil = 0;
let pauseTimer = null;
let lastError = '';
let outageSince = 0; // when the current outage began
const dropped = { full: 0, expired: 0 };
const resumeListeners = [];
let dropLogTimer = null;

// ---- Manual pause (shared between processes through a file) ----
const PAUSE_FILE = process.env.SCANNER_AI_PAUSE_FILE || path.join(__dirname, '..', '..', 'data', 'ai-paused.json');
const PAUSE_POLL_MS = 2000;
let manual = null; // { since } while paused by hand
let pauseStamp = null;
let pausePoll = null;

function readPauseFile() {
  try {
    const data = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
    return data && data.paused ? { since: data.since || null } : null;
  } catch (_) {
    return null;
  }
}

function pauseFileStamp() {
  try {
    const st = fs.statSync(PAUSE_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch (_) {
    return 'missing';
  }
}

// Pick up a pause or resume made by the other process.
function checkPauseFile() {
  const st = pauseFileStamp();
  if (st === pauseStamp) return;
  pauseStamp = st;
  const next = readPauseFile();
  const prev = manual;
  manual = next;
  if (!!prev === !!next) return;
  if (next) {
    log.warn(`[AI] Paused by an admin; holding AI requests until it's resumed (${queue.length} waiting).`);
  } else {
    log.info(`[AI] Resumed by an admin; sending the ${queue.length} waiting request(s).`);
    reset();
    const pausedAt = Date.parse(prev.since);
    notifyResume('pause', Number.isFinite(pausedAt) ? pausedAt : Date.now());
  }
}

/**
 * Call fn({ reason, since }) when the AI is back: reason 'pause' (resumed by
 * hand) or 'outage' (answering again), since the time in ms from which AI
 * requests may have been missed. Requests already waiting when it stopped
 * could give up too, so since is that long (AI_QUEUE_WAIT_SEC) earlier.
 */
function onResume(fn) {
  resumeListeners.push(fn);
}

function notifyResume(reason, stoppedAt) {
  const since = stoppedAt - settings().waitMs;
  setImmediate(() => {
    for (const fn of resumeListeners) {
      try {
        fn({ reason, since });
      } catch (e) {
        log.error(`[AI] Resume listener failed: ${e.stack || e.message}`);
      }
    }
  });
}

function watchPauseFile() {
  if (pausePoll) return;
  checkPauseFile();
  pausePoll = setInterval(checkPauseFile, PAUSE_POLL_MS);
  pausePoll.unref?.();
}

/**
 * Pause or resume sending to the AI by hand. Applies to every process within a
 * couple of seconds.
 * @param {boolean} paused
 */
function setManualPause(paused) {
  if (paused) {
    fs.mkdirSync(path.dirname(PAUSE_FILE), { recursive: true });
    fs.writeFileSync(PAUSE_FILE, JSON.stringify({ paused: true, since: new Date().toISOString() }, null, 2));
  } else {
    try { fs.unlinkSync(PAUSE_FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  pauseStamp = null; // apply here now rather than on the next poll
  checkPauseFile();
}

function isPausedByHand() {
  return !!manual;
}

function num(key, def) {
  const v = parseFloat(process.env[key]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function settings() {
  const openai = String(process.env.AI_PROVIDER || 'ollama').toLowerCase() === 'openai';
  return {
    maxConcurrent: Math.max(1, Math.floor(num('AI_MAX_CONCURRENT', openai ? 4 : 1))),
    queueMax: Math.max(1, Math.floor(num('AI_QUEUE_MAX', 30))),
    waitMs: Math.max(5, num('AI_QUEUE_WAIT_SEC', 120)) * 1000,
    backoffMaxMs: Math.max(5, num('AI_BACKOFF_MAX_SEC', 300)) * 1000,
  };
}

function setLogger(logger) {
  log = logger || console;
}

/** True unless the provider recently stopped answering or the AI is paused by hand. */
function isAvailable() {
  return backoffMs === 0 && !manual;
}

function status() {
  return {
    available: isAvailable(),
    paused: !!manual,
    pausedSince: manual ? manual.since : null,
    waiting: queue.length,
    running,
    retryInSec: pausedUntil > Date.now() ? Math.ceil((pausedUntil - Date.now()) / 1000) : 0,
    lastError,
  };
}

/** Forget a past outage (e.g. after the AI settings change) and send what's waiting. */
function reset() {
  failures = 0;
  backoffMs = 0;
  pausedUntil = 0;
  lastError = '';
  pump();
}

function noteDrop(kind) {
  dropped[kind]++;
  if (dropLogTimer) return;
  dropLogTimer = setTimeout(() => {
    dropLogTimer = null;
    const parts = [];
    if (dropped.expired) parts.push(`${dropped.expired} waited too long`);
    if (dropped.full) parts.push(`${dropped.full} didn't fit in the queue`);
    const why = manual ? 'the AI is paused' : lastError && `last error: ${lastError}`;
    log.warn(`[AI] Gave up on ${dropped.expired + dropped.full} AI request(s) in the last 30s: ${parts.join(', ')}${why ? ` (${why})` : ''}.`);
    dropped.full = 0;
    dropped.expired = 0;
  }, 30000);
  dropLogTimer.unref?.();
}

/**
 * Send one request to the AI provider through the queue. Resolves with a
 * Response-like object ({ok, status, text(), json()}) whose body is already read.
 * Rejects with an AbortError when it runs longer than timeoutMs, or with an
 * LlmUnavailableError when it can't be sent in time.
 *
 * @param {string} url
 * @param {object} init fetch options (no signal; the queue sets it)
 * @param {{label?: string, timeoutMs?: number, priority?: 'high'|'normal'|'low',
 *          maxWaitMs?: number, queueWhenDown?: boolean}} [opts]
 *   queueWhenDown: false fails at once while paused instead of waiting.
 */
function request(url, init = {}, opts = {}) {
  const s = settings();
  const label = opts.label || 'AI request';
  checkPauseFile();
  if (opts.queueWhenDown === false && manual) {
    return Promise.reject(new LlmUnavailableError(`${label} skipped: the AI is paused`, 'paused'));
  }
  if (opts.queueWhenDown === false && pausedUntil > Date.now()) {
    return Promise.reject(new LlmUnavailableError(`${label} skipped: the AI isn't answering${lastError ? ` (${lastError})` : ''}`, 'paused'));
  }
  return new Promise((resolve, reject) => {
    const waitMs = opts.maxWaitMs || s.waitMs;
    const job = {
      url, init, label, resolve, reject,
      timeoutMs: opts.timeoutMs || 30000,
      priority: PRIORITY[opts.priority] ?? PRIORITY.normal,
      seq: ++seq,
    };

    if (queue.length >= s.queueMax) {
      // Make room by dropping the least important request, oldest first; that
      // may be this one.
      let victim = queue[0];
      for (const j of queue) {
        if (j.priority > victim.priority || (j.priority === victim.priority && j.seq < victim.seq)) victim = j;
      }
      noteDrop('full');
      if (job.priority > victim.priority) {
        reject(new LlmUnavailableError(`${label} dropped: ${queue.length} AI requests are already waiting`, 'full'));
        return;
      }
      queue.splice(queue.indexOf(victim), 1);
      clearTimeout(victim.waitTimer);
      victim.reject(new LlmUnavailableError(`${victim.label} dropped to make room in the AI queue`, 'full'));
    }

    job.waitMs = waitMs;
    job.deadline = Date.now() + waitMs;
    enqueue(job);
    pump();
  });
}

// Add a job to the queue, giving up on it at its deadline.
function enqueue(job) {
  clearTimeout(job.waitTimer);
  job.waitTimer = setTimeout(() => {
    const i = queue.indexOf(job);
    if (i < 0) return;
    queue.splice(i, 1);
    noteDrop('expired');
    const why = manual ? 'the AI is paused' : lastError;
    job.reject(new LlmUnavailableError(`${job.label} gave up after waiting ${Math.round(job.waitMs / 1000)}s for the AI${why ? ` (${why})` : ''}`, 'expired'));
  }, Math.max(0, job.deadline - Date.now()));
  job.waitTimer.unref?.();
  queue.push(job);
}

function takeNext() {
  let best = 0;
  for (let i = 1; i < queue.length; i++) {
    const a = queue[i];
    const b = queue[best];
    if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
  }
  return queue.splice(best, 1)[0];
}

function pump() {
  if (!queue.length || manual) return; // resuming calls reset(), which pumps
  const now = Date.now();
  if (pausedUntil > now) {
    if (!pauseTimer) {
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        pump();
      }, pausedUntil - now);
      pauseTimer.unref?.();
    }
    return;
  }
  // While recovering from an outage, send one request at a time to test the water.
  const limit = backoffMs > 0 ? 1 : settings().maxConcurrent;
  while (running < limit && queue.length) run(takeNext());
}

function describeError(err) {
  const code = err.code || (err.errno && String(err.errno)) || '';
  if (/ECONNREFUSED/.test(code + err.message)) return 'connection refused';
  if (/ENOTFOUND|EAI_AGAIN/.test(code + err.message)) return 'host not found';
  if (/ECONNRESET/.test(code + err.message)) return 'connection reset';
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(code + err.message)) return 'host unreachable';
  return err.message || String(err);
}

async function run(job) {
  clearTimeout(job.waitTimer);
  running++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), job.timeoutMs);
  let failure = null; // { reason, immediate } when the provider didn't answer properly
  try {
    const res = await fetch(job.url, { ...job.init, signal: controller.signal });
    const text = await res.text();
    if (!res.ok && (res.status >= 500 || OUTAGE_STATUSES.has(res.status))) {
      const detail = text.replace(/\s+/g, ' ').trim().slice(0, 120);
      failure = { reason: `HTTP ${res.status}${detail ? `: ${detail}` : ''}`, immediate: res.status === 404 };
    }
    job.resolve({
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      text: async () => text,
      json: async () => JSON.parse(text),
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      failure = { reason: `no answer within ${job.timeoutMs / 1000}s`, immediate: false };
      const e = new Error(`${job.label} timed out after ${job.timeoutMs / 1000}s`);
      e.name = 'AbortError';
      job.reject(e);
    } else {
      failure = { reason: describeError(err), immediate: true };
      // The AI never got to work on it: put it back to wait for the AI to return.
      if (Date.now() < job.deadline) enqueue(job);
      else job.reject(err);
    }
  } finally {
    clearTimeout(timer);
    running--;
    if (failure) recordFailure(failure);
    else recordSuccess();
    pump();
  }
}

function recordFailure({ reason, immediate }) {
  lastError = reason;
  failures++;
  // Already paused (another request that was running failed too): don't stack pauses.
  if (pausedUntil > Date.now()) return;
  if (backoffMs === 0 && !immediate && failures < FAILURES_BEFORE_BACKOFF) return;
  const { backoffMaxMs } = settings();
  if (!backoffMs) outageSince = Date.now();
  backoffMs = backoffMs ? Math.min(backoffMs * 2, backoffMaxMs) : Math.min(FIRST_BACKOFF_MS, backoffMaxMs);
  const wait = Math.round(Math.min(backoffMaxMs, backoffMs * (0.85 + Math.random() * 0.3))); // jitter
  pausedUntil = Date.now() + wait;
  log.warn(`[AI] Not answering (${reason}); holding AI requests for ${Math.round(wait / 1000)}s before trying again (${queue.length} waiting).`);
}

function recordSuccess() {
  if (backoffMs > 0) {
    log.info(`[AI] Answering again; sending the ${queue.length} waiting request(s).`);
    // Requests wait out a short outage in the queue; only a longer one loses any
    if (!manual && outageSince && Date.now() - outageSince > settings().waitMs) notifyResume('outage', outageSince);
  }
  failures = 0;
  backoffMs = 0;
  pausedUntil = 0;
  lastError = '';
}

// Ollama context size (OLLAMA_NUM_CTX) for every request: all of them must use
// the same value, or Ollama reloads the model each time it changes.
function ollamaNumCtx() {
  const n = parseInt(process.env.OLLAMA_NUM_CTX, 10);
  return n > 0 ? n : DEFAULT_OLLAMA_NUM_CTX;
}

watchPauseFile();

module.exports = {
  request, isAvailable, status, reset, setLogger, setManualPause, isPausedByHand, onResume, ollamaNumCtx, LlmUnavailableError,
};
