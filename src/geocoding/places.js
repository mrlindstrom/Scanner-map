'use strict';

/**
 * Local named places (schools, parks, hospitals, churches ...) from
 * OpenStreetMap, for places the geocoder can't find as spoken.
 *
 * Speech-to-text mishears place names as it does streets ("Twin Peaks Middle"
 * for Twin Creeks Middle School), and LocationIQ then returns only other
 * places sharing a word. The list is fetched from the Overpass API for the
 * search area, kept in data/places-cache.json and refreshed weekly.
 */

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const streets = require('./streets');

const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'places-cache.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

// OSM tag -> a kind word, so a place is the right kind even when its name
// doesn't say it ("Jesse Jones" tagged as a park)
const TAG_KINDS = [
  ['amenity', 'school', 'school'], ['amenity', 'college', 'school'], ['amenity', 'university', 'school'],
  ['amenity', 'hospital', 'hospital'], ['amenity', 'library', 'library'],
  ['amenity', 'place_of_worship', 'church'], ['leisure', 'park', 'park'], ['tourism', 'museum', 'museum'],
  ['amenity', 'fire_station', 'station'], ['amenity', 'police', 'police'], ['leisure', 'stadium', 'stadium'],
  ['shop', 'mall', 'mall'], ['tourism', 'hotel', 'hotel'], ['tourism', 'motel', 'motel'],
];

let places = []; // { name, lat, lon, kind, words }
let loading = null;

function placeWordsOf(name) {
  return String(name || '').toLowerCase().replace(/'s\b/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function prepare(list) {
  return list.map((p) => ({ ...p, words: placeWordsOf(p.name) }));
}

const tagKey = ([k, v]) => `${k}=${v}`;

// Cache: { box, tags: { "amenity=school": { fetchedAt, places: [...] }, ... } }
function readCache(box) {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return data && data.box === box && data.tags ? data : { box, tags: {} };
  } catch (_) {
    return { box, tags: {} };
  }
}

function writeCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

function fromCache(cache) {
  return prepare(Object.values(cache.tags).flatMap((t) => t.places || []));
}

// One tag at a time: the public Overpass server can take over a minute for
// all the schools in two counties, and a query for everything times out.
async function fetchTag([key, value, kind], box) {
  const [west, south, east, north] = box.split(',').map(Number);
  const query = `[out:json][timeout:180];nwr["${key}"="${value}"]["name"](${south},${west},${north},${east});out center tags;`;
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'scanner-map/2.0 (local place list)' },
    body: new URLSearchParams({ data: query }).toString(),
    timeout: 240000,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json();
  if (data.remark && /timed out|runtime error/i.test(data.remark)) throw new Error(`Overpass: ${data.remark.slice(0, 80)}`);
  const out = [];
  for (const e of data.elements || []) {
    const t = e.tags || {};
    const at = e.center || e;
    if (!t.name || !Number.isFinite(at.lat) || !Number.isFinite(at.lon)) continue;
    out.push({ name: t.name, lat: at.lat, lon: at.lon, kind });
  }
  return out;
}

/**
 * Load the place list for a search box ("minLon,minLat,maxLon,maxLat"): the
 * saved list at once, then any kind of place older than a week (or missing)
 * from Overpass. Never throws; logs and keeps what it has.
 */
function load(box, logger = console) {
  if (!box) return Promise.resolve(places.length);
  if (loading) return loading;
  loading = (async () => {
    const cache = readCache(box);
    places = fromCache(cache);
    const stale = TAG_KINDS.filter((t) => {
      const c = cache.tags[tagKey(t)];
      return !c || Date.now() - (c.fetchedAt || 0) > MAX_AGE_MS;
    });
    if (!stale.length) return places.length;
    const failed = [];
    for (const tag of stale) {
      try {
        const list = await fetchTag(tag, box);
        cache.tags[tagKey(tag)] = { fetchedAt: Date.now(), places: list };
        writeCache(cache);
        places = fromCache(cache);
      } catch (e) {
        failed.push(`${tagKey(tag)} (${e.message})`);
      }
      await new Promise((r) => setTimeout(r, 2000)); // be gentle with the public server
    }
    logger.info(`[Geocoding] Place list: ${places.length} named local places from OpenStreetMap`
      + (failed.length ? `; ${failed.length} kind(s) not fetched, retrying tomorrow: ${failed.slice(0, 3).join(', ')}` : ''));
    return places.length;
  })().finally(() => { loading = null; });
  return loading;
}

function count() {
  return places.length;
}

/**
 * The local place a spoken name means, or null. A place whose name matches
 * (streets.placeMatches) wins; otherwise a likely mishearing: same kind of
 * place, at least one distinctive word the same, the rest close, and clearly
 * better than any other candidate.
 * @returns {{name, lat, lon, corrected: boolean, score: number}|null}
 */
function findPlace(spokenPlace, { areaWords = new Set() } = {}) {
  if (!places.length || !spokenPlace) return null;
  const spokenWords = placeWordsOf(spokenPlace);
  // Town words count here ("Klein" tells Klein Oak from Grand Oaks); a name
  // with nothing but generic words ("the high school") can't say which place
  const distinctive = spokenWords.filter((w) => w.length >= 3 && !streets.GENERIC_PLACE_WORDS.has(w));
  if (!distinctive.length) return null;

  const withKind = (p) => (p.kind ? `${p.name} ${p.kind}` : p.name);
  const candidates = places.filter((p) => streets.kindsAgree(spokenPlace, withKind(p)));

  // 1. Named as spoken, fewest extra words first ("Jesse Jones Park" before
  // "Jesse H. Jones Park & Nature Center"). Several equally close (a chain)
  // are only trusted when they're the same place mapped twice.
  const extra = (p) => p.words.filter((w) => !spokenWords.includes(w)).length;
  const exact = candidates.filter((p) => streets.placeMatches(spokenPlace, withKind(p), { areaWords }));
  if (exact.length) {
    const fewest = Math.min(...exact.map(extra));
    const top = exact.filter((p) => extra(p) === fewest);
    const far = top.some((p) => Math.abs(p.lat - top[0].lat) > 0.01 || Math.abs(p.lon - top[0].lon) > 0.01);
    return far ? null : { name: top[0].name, lat: top[0].lat, lon: top[0].lon, corrected: false, score: 1 };
  }

  // 2. Misheard: compare distinctive words one to one
  let best = null, second = null;
  for (const p of candidates) {
    const theirs = p.words.filter((w) => w.length >= 3 && !streets.GENERIC_PLACE_WORDS.has(w));
    if (theirs.length !== distinctive.length) continue;
    const sims = distinctive.map((w, i) => streets.wordSimilarity(w, theirs[i]));
    const strong = sims.filter((s) => s >= 0.92).length;
    // Every word close, or all but one word the same and that one not far off
    const ok = sims.every((s) => s >= 0.86) || (strong >= 1 && strong === sims.length - 1 && Math.min(...sims) >= 0.6);
    if (!ok) continue;
    const score = sims.reduce((a, b) => a + b, 0) / sims.length;
    const entry = { ...p, score };
    if (!best || score > best.score) { second = best; best = entry; } else if (!second || score > second.score) second = entry;
  }
  if (!best) return null;
  const samePlace = (a, b) => a.name === b.name && Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;
  if (second && !samePlace(best, second) && best.score - second.score < 0.05) return null; // ambiguous
  return { name: best.name, lat: best.lat, lon: best.lon, corrected: true, score: Math.round(best.score * 1000) / 1000 };
}

module.exports = { load, count, findPlace, CACHE_FILE, _setPlaces: (list) => { places = prepare(list); } };
