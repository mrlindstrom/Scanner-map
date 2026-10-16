'use strict';

/**
 * Shared structured logger for the modernized modules (storage, setup, security, db).
 * Mirrors the look of the existing winston setup but is self-contained so new
 * modules don't depend on bot.js/webserver.js internals.
 */

const fs = require('fs');
const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');
const { consoleFormat } = require('./consoleFormat');

const LOG_DIR = path.join(process.cwd(), 'logs');
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (_) {
  /* ignore */
}

const level = process.env.LOG_LEVEL || 'info';

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

// Daily log files in ./logs, shared by every logger in the process:
//   logs/combined-YYYY-MM-DD.log  (info and above)
//   logs/error-YYYY-MM-DD.log     (errors only)
// LOG_RETENTION_DAYS (default 3) sets how many days are kept; LOG_MAX_SIZE
// (e.g. "50m", default unlimited) starts a numbered extra file when a day's log hits that size.
const retentionDays = Math.max(1, parseInt(process.env.LOG_RETENTION_DAYS, 10) || 3);
const maxSize = (process.env.LOG_MAX_SIZE || '').trim() || undefined;

let fileTransports = null;

/** The shared rotating file transports (created once per process). */
function getFileTransports() {
  if (!fileTransports) {
    const rotating = (name, extra = {}) => new winston.transports.DailyRotateFile({
      dirname: LOG_DIR,
      filename: `${name}-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      maxFiles: `${retentionDays}d`,
      maxSize,
      auditFile: path.join(LOG_DIR, `.${name}-audit.json`),
      format: winston.format.json(),
      ...extra,
    });
    fileTransports = [rotating('combined'), rotating('error', { level: 'error' })];
    // Each logger that shares these adds a pipe; lift Node's default listener cap.
    fileTransports.forEach((t) => t.setMaxListeners(0));
  }
  return fileTransports;
}

const baseLogger = winston.createLogger({
  level,
  format: fileFormat,
  transports: [
    // Shared console layout; the entry's `module` fills the source column
    new winston.transports.Console({ format: consoleFormat() }),
    ...getFileTransports(),
  ],
});

/**
 * Returns a child-style logger tagged with a module name.
 * @param {string} moduleName
 */
function createLogger(moduleName) {
  return {
    info: (msg, meta = {}) => baseLogger.info(msg, { module: moduleName, ...meta }),
    warn: (msg, meta = {}) => baseLogger.warn(msg, { module: moduleName, ...meta }),
    error: (msg, meta = {}) => baseLogger.error(msg, { module: moduleName, ...meta }),
    debug: (msg, meta = {}) => baseLogger.debug(msg, { module: moduleName, ...meta }),
  };
}

module.exports = { baseLogger, createLogger, getFileTransports, LOG_DIR };
