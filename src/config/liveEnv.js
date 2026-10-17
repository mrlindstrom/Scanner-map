'use strict';

/**
 * Keeps process.env in step with the .env file while the app runs, so settings
 * saved from the admin page (or edited by hand) apply without a restart.
 *
 * The file is checked every few seconds. Changed keys are written to
 * process.env (or removed when their line is deleted) and every listener gets
 * the set of keys that changed. Variables that came from the real environment
 * rather than the file keep winning, as they do with dotenv at startup.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const ENV_PATH = process.env.SCANNER_ENV_FILE || path.join(process.cwd(), '.env');
const POLL_MS = 2000;

let fileValues = {}; // what the .env file held at the last check
let osKeys = new Set(); // keys set outside the file; the file never overrides them
let lastStamp = null;
let timer = null;
const listeners = [];

function readFile() {
  try {
    return dotenv.parse(fs.readFileSync(ENV_PATH));
  } catch (_) {
    return null;
  }
}

function stamp() {
  try {
    const st = fs.statSync(ENV_PATH);
    return `${st.mtimeMs}:${st.size}`;
  } catch (_) {
    return 'missing';
  }
}

/** Record the file as loaded at startup (dotenv has already applied it). */
function init() {
  fileValues = readFile() || {};
  lastStamp = stamp();
  osKeys = new Set(Object.keys(fileValues).filter((k) => process.env[k] !== fileValues[k]));
}

/**
 * Re-read the file and apply what changed.
 * @returns {string[]} the keys whose effective value changed
 */
function reload() {
  const next = readFile();
  lastStamp = stamp();
  if (!next) return [];
  const changed = [];
  const keys = new Set([...Object.keys(fileValues), ...Object.keys(next)]);
  for (const key of keys) {
    if (fileValues[key] === next[key] || osKeys.has(key)) continue;
    if (key in next) process.env[key] = next[key];
    else delete process.env[key];
    changed.push(key);
  }
  fileValues = next;
  if (changed.length) {
    for (const fn of listeners) {
      try {
        fn(changed);
      } catch (e) {
        console.error(`[liveEnv] settings listener failed: ${e.stack || e.message}`);
      }
    }
  }
  return changed;
}

/** Call fn(changedKeys) whenever the file changes. */
function onChange(fn) {
  listeners.push(fn);
}

function watch() {
  if (timer) return;
  if (lastStamp == null) init();
  timer = setInterval(() => {
    if (stamp() !== lastStamp) reload();
  }, POLL_MS);
  if (timer.unref) timer.unref();
}

/** Keys the real environment overrides (edits to them in .env are ignored). */
function overriddenKeys() {
  // The web server is started by the bot with the bot's environment, so the
  // bot passes along which keys really came from outside .env.
  if (lastStamp == null && process.env.SCANNER_ENV_OVERRIDDEN != null) {
    return process.env.SCANNER_ENV_OVERRIDDEN.split(',').filter(Boolean);
  }
  return [...osKeys];
}

module.exports = { ENV_PATH, init, reload, onChange, watch, overriddenKeys };
