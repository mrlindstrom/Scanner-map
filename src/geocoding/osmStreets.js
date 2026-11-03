'use strict';

/**
 * Every named road in the search area, from OpenStreetMap, for correcting
 * misheard street names ("Glenluck Forest" for Gleannloch Forest Drive).
 *
 * The street list built from past geocodes only knows streets Scanner Map has
 * already found (a few thousand); this adds the rest (tens of thousands). Only
 * the names are kept. Fetched from the Overpass API, saved in
 * data/osm-streets-cache.json and refreshed weekly.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'osm-streets-cache.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

let names = [];
let loading = null;

function readCache(box) {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return data && data.box === box && Array.isArray(data.names) ? data : null;
  } catch (_) {
    return null;
  }
}

async function fetchNames(box) {
  const [west, south, east, north] = box.split(',').map(Number);
  // Names only (CSV): the whole area is ~200k road segments but only a few MB this way
  const query = `[out:csv(name;false)][timeout:300];way["highway"]["name"](${south},${west},${north},${east});out tags;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'scanner-map/2.0 (local street list)' },
    body: new URLSearchParams({ data: query }).toString(),
    timeout: 400000,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const text = await res.text();
  if (/runtime error|timed out/i.test(text.slice(0, 500))) throw new Error(`Overpass: ${text.slice(0, 80)}`);
  return [...new Set(text.split('\n').map((s) => s.trim()).filter(Boolean))].sort();
}

/**
 * Load the street names for a search box ("minLon,minLat,maxLon,maxLat"): the
 * saved list at once, refetched when older than a week. Never throws; logs and
 * keeps what it has.
 */
function load(box, logger = console) {
  if (!box) return Promise.resolve(names.length);
  if (loading) return loading;
  loading = (async () => {
    const cache = readCache(box);
    if (cache) names = cache.names;
    if (cache && Date.now() - (cache.fetchedAt || 0) < MAX_AGE_MS) return names.length;
    try {
      const list = await fetchNames(box);
      if (list.length) {
        names = list;
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ box, fetchedAt: Date.now(), names }));
      }
      logger.info(`[Geocoding] OpenStreetMap street names: ${names.length} in the search area`);
    } catch (e) {
      logger.warn(`[Geocoding] Could not fetch OpenStreetMap street names (${e.message}); ${names.length ? 'using the saved list' : 'retrying tomorrow'}`);
    }
    return names.length;
  })().finally(() => { loading = null; });
  return loading;
}

module.exports = { load, names: () => names, CACHE_FILE };
