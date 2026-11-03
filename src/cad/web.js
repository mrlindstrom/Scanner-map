'use strict';

/**
 * Web side of the CAD dashboard: the /cad page, its API, and live updates.
 * The bot's tracker (src/cad/tracker.js) writes cad_incidents; this module
 * reads it and pushes changed incidents to browsers over socket.io.
 */

const path = require('path');

const RECENT_CLOSED_SEC = 30 * 60; // closed incidents stay on the board this long
const POLL_MS = 3000;

function toClient(row) {
  let d = {};
  try { d = JSON.parse(row.data || '{}'); } catch { /* keep empty */ }
  return {
    id: row.id,
    opened: row.opened,
    updated: row.updated,
    closed: row.closed,
    priority: row.priority,
    status: row.status,
    board: row.board,
    minor: !!row.minor,
    dropped: !!row.dropped,
    type: d.type || 'Unknown',
    address: d.address || null,
    lat: d.lat ?? null,
    lon: d.lon ?? null,
    closedBy: d.closedBy || null,
    mergedInto: d.mergedInto || null,
    agencies: (d.agencies || []).map(([name, kind]) => ({ name, kind })),
    units: (d.units || []).map(([key, u]) => ({ key, name: u.name, status: u.status, at: u.at, agency: u.agency || null })),
    channels: d.tgNames || [],
    calls: (d.calls || []).map((c) => ({
      id: c.id, timestamp: c.timestamp, tg: c.tg, text: c.text, fromDispatcher: !!c.fromDispatcher,
      radios: (c.radios || []).map((r) => r.alias || `Radio ${r.src}`),
    })),
    events: d.events || [],
  };
}

function mountCad(app, { getDb, io, publicDir }) {
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => {
      if (err && /no such table/i.test(err.message)) return resolve([]); // bot hasn't created it yet
      if (err) return reject(err);
      resolve(rows || []);
    });
  });

  app.get('/cad', (req, res) => res.sendFile(path.join(publicDir, 'cad', 'index.html')));

  // Open incidents plus the ones closed in the last 30 minutes
  app.get('/api/cad/incidents', async (req, res) => {
    try {
      const since = Math.floor(Date.now() / 1000) - RECENT_CLOSED_SEC;
      const rows = await all(`SELECT * FROM cad_incidents WHERE dropped = 0 AND (closed IS NULL OR closed > ?)
        ORDER BY opened DESC LIMIT 400`, [since]);
      res.json({ now: Math.floor(Date.now() / 1000), incidents: rows.map(toClient) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/cad/incident/:id', async (req, res) => {
    try {
      const rows = await all('SELECT * FROM cad_incidents WHERE id = ?', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'not found' });
      res.json(toClient(rows[0]));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Push changes: the bot stamps each saved incident with `changed` (ms)
  let lastChanged = Date.now();
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const rows = await all('SELECT * FROM cad_incidents WHERE changed > ? ORDER BY changed LIMIT 200', [lastChanged]);
      if (rows.length) {
        lastChanged = Math.max(...rows.map((r) => r.changed));
        io.emit('cadUpdate', { now: Math.floor(Date.now() / 1000), incidents: rows.map(toClient) });
      }
    } catch (err) {
      console.error(`CAD poll failed: ${err.message}`);
    } finally {
      busy = false;
    }
  }, POLL_MS).unref?.();
}

module.exports = { mountCad, toClient };
