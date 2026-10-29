'use strict';

/**
 * Notices when the main thread stops responding (a long synchronous job, a
 * console window paused by a text selection, ...). Every timer, upload and
 * transcription request waits while it's stuck, and the normal log can't say
 * so: its writes queue behind the stall and are lost if the app is killed.
 *
 * A worker thread watches a heartbeat the main thread updates every second.
 * Once the heartbeat is STALL_WARN_SEC (30) old the worker appends to
 * logs/stalls.log with synchronous writes, which land even while the main
 * thread is stuck, and again every minute until it recovers. On recovery the
 * main thread also logs how long it was blocked.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_SOURCE = `
const fs = require('fs');
const { workerData } = require('worker_threads');
const beat = new BigInt64Array(workerData.buffer);
let reportedAt = 0;
function write(message) {
  const line = JSON.stringify({ level: 'error', message, rssMb: Math.round(process.memoryUsage().rss / 1048576), timestamp: new Date().toISOString() });
  try { fs.mkdirSync(require('path').dirname(workerData.file), { recursive: true }); fs.appendFileSync(workerData.file, line + '\\n'); } catch (_) {}
}
setInterval(() => {
  const age = Date.now() - Number(Atomics.load(beat, 0));
  if (age < workerData.warnMs) { reportedAt = 0; return; }
  if (reportedAt && Date.now() - reportedAt < 60000) return;
  reportedAt = Date.now();
  write('Main thread not responding for ' + Math.round(age / 1000) + ' s (transcription, uploads and timers are all waiting)');
}, 5000);
`;

function startStallWatchdog({ logger, logsDir = path.join(process.cwd(), 'logs') } = {}) {
  const warnSec = parseInt(process.env.STALL_WARN_SEC, 10);
  const warnMs = (warnSec > 0 ? warnSec : 30) * 1000;
  const buffer = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(buffer);
  let last = Date.now();
  Atomics.store(beat, 0, BigInt(last));

  setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    if (gap >= warnMs && logger) logger.error(`Main thread was blocked for ${Math.round(gap / 1000)} s; see logs/stalls.log`);
    last = now;
    Atomics.store(beat, 0, BigInt(now));
  }, 1000).unref();

  try {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { buffer, warnMs, file: path.join(logsDir, 'stalls.log') },
    });
    worker.unref();
    worker.on('error', (err) => logger && logger.warn(`Stall watchdog stopped: ${err.message}`));
  } catch (err) {
    if (logger) logger.warn(`Stall watchdog not started: ${err.message}`);
  }
}

module.exports = { startStallWatchdog };
