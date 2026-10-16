'use strict';

/**
 * One console layout for every logger (bot, geocoding, modules, webserver,
 * python workers):
 *
 *   21:03:49  INFO   bot       Talk Group: 40001 - HFD Dispatch Citywide
 *   21:03:52  ERROR  storage   Error storing audio for ID 3054175 ...
 *   21:04:52  ERROR  storage   ↳ 37 more like "Error storing audio for ID 3054175 …" in the last 60s
 *
 * - fixed columns, long messages wrap under the message column
 * - a dim rule before each incoming call so calls read as blocks
 * - repeated warnings/errors within a minute are hidden, then summarized as one line
 * - stack traces only with LOG_CONSOLE_VERBOSE=true (files always keep them)
 *
 * NO_COLOR disables colors; colors are also off when stdout isn't a terminal.
 */

const winston = require('winston');
const MESSAGE = Symbol.for('message'); // winston's final-output key (triple-beam)

const VERBOSE = String(process.env.LOG_CONSOLE_VERBOSE || '').toLowerCase() === 'true';
const USE_COLOR = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR);
const TIMEZONE = process.env.TIMEZONE || undefined;
const SOURCE_WIDTH = 9;
const REPEAT_WINDOW_MS = 60 * 1000;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
};
const paint = (color, text) => (USE_COLOR && color ? `${color}${text}${C.reset}` : text);

const LEVELS = {
  error: { label: 'ERROR', color: C.red + C.bold },
  warn: { label: 'WARN', color: C.yellow },
  info: { label: 'INFO', color: C.gray },
  debug: { label: 'DEBUG', color: C.gray },
};

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/**
 * Split a message into colored spans. Returns [[text, color], ...].
 * Only the content-specific highlights live here; everything else is plain.
 */
function highlight(message, level) {
  const base = level === 'error' ? C.red : level === 'warn' ? C.yellow : null;

  let m = message.match(/^Transcription Text:\s*(?:\(([^)]+)\)\s+)?([\s\S]*)$/);
  if (m) {
    return m[1]
      ? [[`${m[1]}: `, C.magenta + C.bold], [m[2], C.cyan]]
      : [[m[2], C.cyan]];
  }
  if (/^Talk Group:/.test(message)) return [[message, C.yellow + C.bold]];
  if (/Extracted Address|Geocoded Address/.test(message)) return [[message, C.green]];

  if (message.startsWith('Dispatch tone detected')) {
    // "Dispatch tone detected on TG 40001! [hi-low: warble ...] Next 1 calls ..."
    m = message.match(/^(.*?)(\[[^\]]+\])(.*)$/);
    return m
      ? [[m[1], C.yellow + C.bold], [m[2], C.blue + C.bold], [m[3], C.yellow]]
      : [[message, C.yellow + C.bold]];
  }
  return [[message, base]];
}

/** Word-wrap colored spans to `width`, returning an array of painted lines. */
function wrapSpans(spans, width) {
  const lines = [];
  let line = '';
  let lineLen = 0;
  const push = () => { lines.push(line); line = ''; lineLen = 0; };

  for (const [text, color] of spans) {
    // Preserve explicit newlines (tracebacks, multi-line worker output)
    const paragraphs = String(text).split('\n');
    paragraphs.forEach((para, pi) => {
      if (pi > 0) push();
      // Keep leading indentation on continuation lines (tracebacks)
      const lead = pi > 0 ? para.match(/^\s*/)[0] : '';
      if (lead) { line += lead; lineLen += lead.length; }
      for (const word of para.slice(lead.length).split(/(\s+)/)) {
        if (!word) continue;
        if (/^\s+$/.test(word)) {
          if (lineLen > 0 && lineLen < width) { line += ' '; lineLen += 1; }
          continue;
        }
        let rest = word;
        while (rest.length) {
          const room = width - lineLen;
          if (rest.length <= room) {
            line += paint(color, rest); lineLen += rest.length; rest = '';
          } else if (lineLen > 0 && rest.length <= width) {
            push();
          } else {
            // Longer than a whole line (URLs, file names): hard-split
            const chunk = rest.slice(0, Math.max(1, room));
            line += paint(color, chunk); lineLen += chunk.length; rest = rest.slice(chunk.length);
            push();
          }
        }
      }
    });
  }
  if (lineLen > 0 || !lines.length) push();
  return lines;
}

/** Collapse repeats: same level/source/shape of message within REPEAT_WINDOW_MS. */
const recent = new Map();
function repeatKey(level, source, message) {
  const shape = message
    .replace(/\S*[_/\\]\S*/g, '*')   // file names, paths, storage keys
    .replace(/\d+(\.\d+)?/g, '#')
    .slice(0, 100);
  return `${level}|${source}|${shape}`;
}

// When a burst of repeats ends, say how many were hidden (otherwise the count
// would only appear if the same message came back later).
const repeatTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of recent) {
    if (now - entry.first < REPEAT_WINDOW_MS) continue;
    recent.delete(key);
    if (entry.count > 0) {
      const line = formatConsoleLine({
        level: entry.level,
        source: entry.source,
        message: `↳ ${entry.count} more like "${entry.preview}" in the last ${Math.round((now - entry.first) / 1000)}s`,
        skipRepeatCheck: true,
      });
      process.stdout.write(line + '\n');
    }
  }
}, 15 * 1000);
repeatTimer.unref();

/**
 * Returns the console line(s) for one log entry, or null to suppress it.
 */
function formatConsoleLine({ level, source, message, stack, timestamp, skipRepeatCheck }) {
  const text = typeof message === 'string' ? message : JSON.stringify(message);

  if (text === '--- Incoming Request ---') {
    const cols = Math.min(process.stdout.columns || 100, 100);
    return paint(C.gray, '─'.repeat(cols - 1));
  }

  if ((level === 'error' || level === 'warn') && !skipRepeatCheck) {
    const key = repeatKey(level, source, text);
    const now = Date.now();
    const entry = recent.get(key);
    if (entry && now - entry.first < REPEAT_WINDOW_MS) {
      entry.count += 1;
      return null;
    }
    recent.set(key, { first: now, count: 0, level, source, preview: text.slice(0, 60) + (text.length > 60 ? '…' : '') });
    if (recent.size > 500) recent.delete(recent.keys().next().value);
  }

  const lvl = LEVELS[level] || LEVELS.info;
  const time = timeFormatter.format(timestamp ? new Date(timestamp) : new Date());
  const prefix =
    `${paint(C.gray, time)}  ${paint(lvl.color, lvl.label.padEnd(5))}  ` +
    `${paint(C.dim, String(source || '').slice(0, SOURCE_WIDTH).padEnd(SOURCE_WIDTH))} `;
  const prefixWidth = 8 + 2 + 5 + 2 + SOURCE_WIDTH + 1;

  let body = text.trim();
  if (VERBOSE && stack && !body.includes(stack)) body += `\n${stack}`;

  const spans = highlight(body, level);

  const columns = process.stdout.isTTY ? process.stdout.columns || 120 : 160;
  const width = Math.max(40, columns - prefixWidth - 1);
  const lines = wrapSpans(spans, width);
  const indent = ' '.repeat(prefixWidth);
  return lines.map((l, i) => (i === 0 ? prefix : indent) + l).join('\n');
}

/**
 * winston format for a Console transport. `source` is the default column
 * label; an entry's own `module`/`source` field wins. `filter(info)` may
 * return false to hide an entry from the console (files are unaffected).
 */
function consoleFormat({ source = '', filter } = {}) {
  return winston.format((info) => {
    if (info.level === 'debug' && !VERBOSE) return false;
    if (filter && info.console !== true && !filter(info)) return false;
    const line = formatConsoleLine({
      level: info.level,
      source: info.module || info.source || source,
      message: info.message,
      stack: info.stack,
      timestamp: undefined,
    });
    if (line === null) return false;
    info[MESSAGE] = line;
    return info;
  })();
}

/**
 * Route console.log/info/warn/error through the shared layout (for code that
 * logs with console.* directly, e.g. webserver.js). `filter(level, message, source)`
 * can hide routine lines; LOG_CONSOLE_VERBOSE=true shows everything.
 */
function patchConsole(source, filter) {
  const write = (level) => (...args) => {
    const message = args
      .map((a) => (a instanceof Error ? (VERBOSE ? a.stack : a.message) : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    // A leading "[Webserver]" / "[Audio DB]" style tag becomes the source column
    const tag = message.match(/^\[([^\]]{1,24})\]:?\s*/);
    const lineSource = tag ? tag[1].toLowerCase().replace(/\s+/g, '-') : source;
    const text = tag ? message.slice(tag[0].length) : message;
    if (filter && !VERBOSE && !filter(level, text, lineSource)) return;
    const line = formatConsoleLine({ level, source: lineSource, message: text });
    if (line !== null) process[level === 'error' || level === 'warn' ? 'stderr' : 'stdout'].write(line + '\n');
  };
  console.log = write('info');
  console.info = write('info');
  console.warn = write('warn');
  console.error = write('error');
}

module.exports = { consoleFormat, formatConsoleLine, patchConsole, VERBOSE };
