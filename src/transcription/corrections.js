'use strict';

/**
 * Fix words the transcriber reliably mishears ("Kirkendall" for Kuykendahl).
 *
 * The list lives in data/transcript_corrections.txt, one rule per line:
 *
 *   Kirkendall => Kuykendahl      # optional note
 *
 * Matching ignores case, whole words only, and the words of a phrase may be
 * separated by any spacing or a hyphen ("Cypress Wood", "Cypress-Wood"). The
 * replacement is used as written. The file can be edited by hand or from the
 * admin page (Settings → Transcript Fixes); both processes reload it when it
 * changes, so no restart is needed.
 */

const fs = require('fs');
const path = require('path');

const FILE = process.env.TRANSCRIPT_CORRECTIONS_FILE
  || path.join(__dirname, '..', '..', 'data', 'transcript_corrections.txt');
// Starting list shipped with the code; copied to FILE the first time. FILE
// itself isn't tracked by git, so your edits never block an update.
const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'transcript_corrections.default.txt');

const DEFAULT_HEADER = [
  '# Transcript fixes: words the transcriber mishears, and what was really said.',
  '# One per line:   heard => correct      # optional note',
  '# Case doesn\'t matter and only whole words match; in a phrase, spaces also',
  '# match hyphens. A longer phrase wins over a shorter rule inside it.',
  '# Edit here or in Settings -> Transcript Fixes; changes apply to new calls',
  '# within a few seconds, without a restart.',
];

const ARROW = /\s*=>\s*/;

/** Parse the file. Returns { header: [comment lines], rules: [{ heard, replacement, note, before }] }. */
function parse(text) {
  const lines = String(text || '').split(/\r?\n/);
  const header = [];
  let i = 0;
  // Leading comment block (up to the first blank line or rule) is the header
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('#')) break;
    header.push(lines[i].trimEnd());
  }
  const rules = [];
  let pending = [];
  for (; i < lines.length; i++) {
    const raw = lines[i].trimEnd();
    const l = raw.trim();
    if (!l) { if (pending.length) pending.push(''); continue; }
    if (l.startsWith('#')) { pending.push(raw); continue; }
    const m = l.match(/^(.*?)\s*=>\s*(.*?)\s*(?:#\s*(.*))?$/);
    if (!m || !m[1].trim()) { pending.push(`# (not understood) ${l}`); continue; }
    // Comments directly above a rule stay with it; drop blank lines between them and the rule
    while (pending.length && pending[pending.length - 1] === '') pending.pop();
    rules.push({ heard: m[1].trim(), replacement: m[2].trim(), note: (m[3] || '').trim(), before: pending });
    pending = [];
  }
  return { header, rules };
}

function serialize({ header, rules }) {
  const out = [...(header && header.length ? header : DEFAULT_HEADER), ''];
  for (const r of rules) {
    if (r.before && r.before.length) {
      if (out[out.length - 1] !== '') out.push('');
      out.push(...r.before);
    }
    out.push(`${r.heard} => ${r.replacement}${r.note ? `    # ${r.note}` : ''}`);
  }
  return out.join('\n') + '\n';
}

/** Check a rule from the admin page; returns an error message or null. */
function validateRule(r) {
  const heard = String((r && r.heard) || '').trim();
  const replacement = String((r && r.replacement) || '').trim();
  if (!heard) return 'Each fix needs the words that were heard';
  if (ARROW.test(heard) || ARROW.test(replacement) || /#/.test(heard) || /#/.test(replacement)) return `"${heard}": "=>" and "#" can't be used in a fix`;
  if (/[\r\n]/.test(heard + replacement + ((r && r.note) || ''))) return `"${heard}": a fix must be on one line`;
  if (heard.toLowerCase() === replacement.toLowerCase()) return `"${heard}" would be replaced with itself`;
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build one matcher for all rules, longest first, so a phrase rule wins over a
 * one-word rule inside it and a replacement is never corrected again.
 */
function compile(rules) {
  const usable = rules
    .filter((r) => r.heard && r.heard.trim())
    .map((r) => ({ ...r, words: r.heard.trim().split(/[\s-]+/).filter(Boolean) }))
    .filter((r) => r.words.length)
    .sort((a, b) => b.heard.length - a.heard.length);
  if (!usable.length) return { regex: null, rules: [] };
  const parts = usable.map((r) => `(${r.words.map(escapeRe).join('[\\s-]+')})`);
  // Word edges that also respect apostrophes ("O'Neil") and digits ("1960")
  const regex = new RegExp(`(?<![\\w'])(?:${parts.join('|')})(?![\\w'])`, 'gi');
  return { regex, rules: usable };
}

/** Apply compiled rules. Returns { text, applied: [{ heard, replacement, count }] }. */
function applyCompiled(text, compiled) {
  if (!text || !compiled.regex) return { text, applied: [] };
  const counts = new Map();
  const out = String(text).replace(compiled.regex, (...args) => {
    const groups = args.slice(1, compiled.rules.length + 1);
    const idx = groups.findIndex((g) => g !== undefined);
    const rule = compiled.rules[idx];
    if (!rule) return args[0];
    counts.set(rule, (counts.get(rule) || 0) + 1);
    return rule.replacement;
  });
  const applied = [...counts].map(([r, count]) => ({ heard: r.heard, replacement: r.replacement, count }));
  return { text: out, applied };
}

// --- Cached rules from the file -------------------------------------------

let cache = { mtimeMs: -1, size: -1, compiled: { regex: null, rules: [] }, parsed: { header: [], rules: [] } };
let lastStat = 0;
const STAT_INTERVAL_MS = 3000;

function ensureFile() {
  try {
    if (!fs.existsSync(FILE) && fs.existsSync(DEFAULT_FILE)) {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.copyFileSync(DEFAULT_FILE, FILE);
    }
  } catch (e) { /* read-only install: run without fixes */ }
}

function readFile() {
  ensureFile();
  try { return fs.readFileSync(FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Current rules, reloaded when the file changes (checked at most every few seconds). */
function current(logger) {
  const now = Date.now();
  if (now - lastStat < STAT_INTERVAL_MS && cache.mtimeMs !== -1) return cache;
  lastStat = now;
  ensureFile();
  let st = null;
  try { st = fs.statSync(FILE); } catch (e) { /* no file yet */ }
  const mtimeMs = st ? st.mtimeMs : 0, size = st ? st.size : 0;
  if (mtimeMs === cache.mtimeMs && size === cache.size) return cache;
  try {
    const text = readFile();
    const parsed = parse(text || '');
    cache = { mtimeMs, size, parsed, compiled: compile(parsed.rules) };
    if (logger && cache.mtimeMs !== -1) logger.info(`[Transcript fixes] Loaded ${parsed.rules.length} fix(es) from ${FILE}`);
  } catch (e) {
    if (logger) logger.warn(`[Transcript fixes] Could not read ${FILE}: ${e.message}`);
    cache.mtimeMs = mtimeMs; cache.size = size;
  }
  return cache;
}

/** Correct a transcript with the rules in the file. */
function applyCorrections(text, logger) {
  return applyCompiled(text, current(logger).compiled);
}

function loadRules() {
  const text = readFile();
  return parse(text || '');
}

/** Save rules (from the admin page). Comments kept: the header and those above unchanged rules. */
function saveRules(rules) {
  for (const r of rules) {
    const err = validateRule(r);
    if (err) throw new Error(err);
  }
  const existing = loadRules();
  const out = rules.map((r) => {
    const prev = Number.isInteger(r.id) ? existing.rules[r.id] : null;
    return {
      heard: String(r.heard).trim(),
      replacement: String(r.replacement || '').trim(),
      note: String(r.note || '').trim(),
      before: prev ? prev.before : [],
    };
  });
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, serialize({ header: existing.header, rules: out }), 'utf8');
  fs.renameSync(tmp, FILE);
  lastStat = 0; // reload on next use
  return out.length;
}

module.exports = { FILE, parse, serialize, compile, applyCompiled, applyCorrections, loadRules, saveRules, validateRule };
