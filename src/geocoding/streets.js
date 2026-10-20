'use strict';

/**
 * Street-name matching for geocoding.
 *
 * Speech-to-text often mishears local street names ("Tombo Parkway" for Tomball
 * Parkway, "Kirkendall" for Kuykendahl), and geocoders then either find nothing
 * or match the house number on some other street. This module:
 *   - normalizes street names for comparison (suffixes, directions, FM roads);
 *   - checks whether a geocoder's road is the street that was spoken;
 *   - corrects a misheard street against a gazetteer of real local streets,
 *     built from the addresses Scanner Map has already geocoded.
 */

const SUFFIXES = {
  street: 'st', st: 'st', road: 'rd', rd: 'rd', drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln',
  avenue: 'ave', ave: 'ave', av: 'ave', boulevard: 'blvd', blvd: 'blvd', parkway: 'pkwy', pkwy: 'pkwy',
  highway: 'hwy', hwy: 'hwy', freeway: 'fwy', fwy: 'fwy', court: 'ct', ct: 'ct', circle: 'cir', cir: 'cir',
  place: 'pl', pl: 'pl', trail: 'trl', trl: 'trl', way: 'way', loop: 'loop', terrace: 'ter', ter: 'ter',
  crossing: 'xing', xing: 'xing', square: 'sq', sq: 'sq', point: 'pt', pt: 'pt', bend: 'bnd', cove: 'cv',
  run: 'run', row: 'row', path: 'path', pass: 'pass', ridge: 'rdg', creek: 'crk', glen: 'gln',
  expressway: 'expy', expy: 'expy', walk: 'walk',
};
// Suffix words that are often part of the name itself; only stripped at the very end
const DIRECTIONS = { n: 'north', s: 'south', e: 'east', w: 'west', north: 'north', south: 'south', east: 'east', west: 'west',
  ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest' };

/** Split a street into { dir, name, suffix } in a comparable form. */
function parseStreet(street) {
  let words = String(street || '').toLowerCase()
    .replace(/\bf\.?\s?m\.?\s+(\d+)/g, 'fm $1') // "F.M. 1960" -> "fm 1960"
    .replace(/\bfarm to market( road)?\s+(\d+)/g, 'fm $2')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean);
  const dirs = [];
  while (words.length > 1 && DIRECTIONS[words[0]]) dirs.push(DIRECTIONS[words.shift()]);
  while (words.length > 1 && DIRECTIONS[words[words.length - 1]]) dirs.push(DIRECTIONS[words.pop()]);
  let suffix = '';
  if (words.length > 1 && SUFFIXES[words[words.length - 1]]) suffix = SUFFIXES[words.pop()];
  // "fm 1960 road" -> name "fm 1960"
  return { dir: dirs.join(' '), name: words.join(' '), suffix };
}

/** Rough "sounds like" key: keeps the consonant shape, merges letters speech recognition confuses. */
function soundKey(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/ph/g, 'f').replace(/ck|q/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/[sz]h/g, 's').replace(/x/g, 'ks').replace(/dt|th/g, 't').replace(/w(?=[^aeiou]|$)/g, '')
    .replace(/(.)\1+/g, '$1')
    .replace(/(?!^)[aeiouyhw]/g, '');
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; matches++; break; }
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// "fm 1960", "hwy 249", "state highway 99", "us 59", "interstate 45" -> the number
const NUMBERED_ROAD = /^(fm|rm|hwy|highway|state highway|sh|us|us highway|interstate|i|loop|spur|beltway|county road|cr)\s*(\d+)$/;

function wordSimilarity(a, b) {
  if (a === b) return 1;
  if (/\d/.test(a) || /\d/.test(b)) return 0; // numbers must match exactly
  const letters = jaroWinkler(a, b);
  const ka = soundKey(a), kb = soundKey(b);
  // Short sound keys ("sd", "r") match far too easily; rely on spelling for those.
  // a is the spoken word: speech often clips an ending ("tombo" for tomball), but
  // a candidate that drops part of what was said ("cutten" for cottonwood) is wrong.
  if (ka.length < 3 || kb.length < 3) return letters;
  const ratio = Math.min(ka.length, kb.length) / Math.max(ka.length, kb.length);
  if (ratio < (ka.length < kb.length ? 0.75 : 0.8)) return letters;
  return Math.max(letters, jaroWinkler(ka, kb) * 0.97);
}

/**
 * 0..1 similarity of two street names, ignoring suffix and direction. Compared
 * word by word: the names need the same number of words, each looking or
 * sounding alike ("tombo" ~ "tomball", "cuckendall" ~ "kuykendahl"). Names that
 * differ only in spacing ("earl miss" ~ "earlmist") are compared joined up.
 */
function nameSimilarity(a, b) {
  const pa = parseStreet(a), pb = parseStreet(b);
  if (!pa.name || !pb.name) return 0;
  if (pa.name === pb.name) return 1;
  const ra = pa.name.match(NUMBERED_ROAD), rb = pb.name.match(NUMBERED_ROAD);
  if (ra || rb) return ra && rb && ra[2] === rb[2] ? 1 : 0;
  const wa = pa.name.split(' '), wb = pb.name.split(' ');
  if (wa.length !== wb.length) {
    // Only for spacing differences ("earl miss" ~ "earlmist"), not extra words ("william six" vs "williams")
    const ja = wa.join(''), jb = wb.join('');
    if (Math.abs(ja.length - jb.length) > 1) return 0;
    const joined = jaroWinkler(ja, jb);
    return joined >= 0.93 ? joined : 0;
  }
  const scores = wa.map((w, i) => wordSimilarity(w, wb[i]));
  if (Math.min(...scores) < 0.88) return 0;
  return scores.reduce((s, x) => s + x, 0) / scores.length;
}

/** Spoken numbered highways often come back under another name (Hwy 249 = Tomball Pkwy). */
function isNumberedRoad(street) {
  return NUMBERED_ROAD.test(parseStreet(street).name);
}

/**
 * Is the geocoder's road the street that was spoken? Lenient about suffixes,
 * directions and spelling; strict about it being a different street.
 */
function roadMatches(spokenStreet, geocodedRoad, threshold = 0.88) {
  if (!spokenStreet || !geocodedRoad) return true; // nothing to compare
  if (isNumberedRoad(spokenStreet)) return true;
  return nameSimilarity(spokenStreet, geocodedRoad) >= threshold;
}

// Words that say what kind of place it is, not which one
const GENERIC_PLACE_WORDS = new Set(('the of and at in on park hospital medical center centre memorial clinic school '
  + 'elementary middle high college university church station gas auto care store shop mall plaza apartments apartment '
  + 'complex village estates subdivision house home inn hotel motel restaurant bank library office building north south '
  + 'east west saint st health urgent emergency er department fire police sheriff county city').split(' '));

// Words that say what kind of place it is. A spoken word from a group needs a
// word from the same group in the result (school levels are kept apart).
const PLACE_KINDS = [
  ['elementary'], ['middle', 'junior'], ['intermediate'], ['high'],
  ['school', 'elementary', 'middle', 'intermediate', 'junior', 'high', 'academy', 'isd'],
  ['hospital', 'medical', 'er', 'emergency'],
  ['park'], ['church', 'chapel', 'baptist', 'methodist', 'catholic', 'lutheran', 'ministries', 'fellowship'],
  ['library'], ['museum'], ['apartments', 'apartment', 'apts'], ['hotel', 'inn', 'motel', 'suites'],
].map((g) => new Set(g));

const placeWords = (s) => String(s || '').toLowerCase().replace(/'s\b/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/** The kind words in a place name ("Jesse Jones Park" -> ["park"]). */
function placeKindWords(name) {
  return placeWords(name).filter((w) => PLACE_KINDS.some((k) => k.has(w)));
}

/** Does the result name agree with every kind of place the spoken name says? */
function kindsAgree(spokenPlace, resultName) {
  const spoken = placeWords(spokenPlace), target = placeWords(resultName);
  return PLACE_KINDS.every((kind) => !spoken.some((w) => kind.has(w)) || target.some((t) => kind.has(t)));
}

/**
 * Does a geocoder's place name match the place that was spoken? Every
 * distinctive word ("P&L", "Joseph's", "Devonshire") must appear, spelling
 * allowed to vary slightly; generic words ("park", "hospital") don't count.
 *
 * opts.areaWords: words of the local town and county names. They aren't
 * distinctive either ("Spring" in Spring High School is also in Spring
 * Hospital and Spring Branch), so a name made only of those and generic words
 * has to match word for word, generic words included. A town word next to a
 * distinctive one must still be found, in the name or in opts.town.
 */
function placeMatches(spokenPlace, resultName, opts = {}) {
  const words = placeWords;
  const area = opts.areaWords || new Set();
  const target = words(resultName);
  // Spelling may vary, but not the length: "marsh" is not "marshall"
  const found = (w) => target.some((t) => t === w || (w.length >= 5
    && Math.min(w.length, t.length) / Math.max(w.length, t.length) >= 0.8 && jaroWinkler(w, t) >= 0.92));
  // The kind of place, when the spoken name says it, has to agree ("Lewis
  // Elementary" is not Lewis Middle School, "Jesse Jones Park" not a library)
  if (!kindsAgree(spokenPlace, resultName)) return false;
  const spoken = words(spokenPlace).filter((w) => w.length >= 3);
  const distinctive = spoken.filter((w) => !GENERIC_PLACE_WORDS.has(w) && !area.has(w));
  if (distinctive.length) {
    // A town word that was spoken still has to be there, in the name or the
    // result's town ("Klein Oaks High School" is not Grand Oaks High School)
    const town = words(opts.town || '');
    const areaOk = spoken.filter((w) => area.has(w)).every((w) => found(w) || town.includes(w));
    return areaOk && distinctive.every(found);
  }
  // Only town and generic words ("Spring High School"): every one of them, so
  // a different kind of place in the same town doesn't pass
  const named = spoken.filter((w) => !['the', 'and'].includes(w));
  if (!named.some((w) => area.has(w))) return false; // only generic words: too vague to trust a fuzzy match
  return named.every(found);
}

/** The street part of an extracted address: "7216 Spring Cypress Rd, Spring, TX" -> "Spring Cypress Rd". */
function streetOf(address) {
  const first = String(address || '').split(',')[0].trim();
  if (/\s(&|and)\s/i.test(first)) return null; // intersection
  const m = first.match(/^\s*\d+[a-z]?\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Gazetteer of real local streets: road name -> how often it was geocoded.
 * Built from geocoder-formatted addresses ("918, Gulf Bank Road, Houston, ...").
 */
function buildGazetteer(formattedAddresses, minCount = 2) {
  const counts = new Map();
  for (const addr of formattedAddresses) {
    const parts = String(addr || '').split(',').map((s) => s.trim());
    const road = /^\d+[a-z]?$/i.test(parts[0]) ? parts[1] : parts[0];
    if (!road || /county|texas|usa|^\d/i.test(road) || !/[a-z]{3}/i.test(road)) continue;
    counts.set(road, (counts.get(road) || 0) + 1);
  }
  const entries = [];
  for (const [road, count] of counts) {
    if (count < minCount) continue; // one-off results are more likely to be wrong matches
    const p = parseStreet(road);
    if (p.name) entries.push({ road, count, parsed: p, key: soundKey(p.name) });
  }
  return entries;
}

/**
 * A correction changes what was said, so it needs more than similar spelling:
 * each differing word must also sound alike (at least 3 consonants to compare),
 * or the names must differ only in spacing ("earl miss" / "earlmist").
 */
function soundsAlike(spokenName, candidateName) {
  const wa = spokenName.split(' '), wb = candidateName.split(' ');
  if (wa.length !== wb.length) return Math.abs(wa.join('').length - wb.join('').length) <= 1 && jaroWinkler(wa.join(''), wb.join('')) >= 0.93;
  return wa.every((w, i) => {
    if (w === wb[i]) return true;
    const ka = soundKey(w), kb = soundKey(wb[i]);
    if (ka.length < 3 || kb.length < 3) return false;
    const ratio = Math.min(ka.length, kb.length) / Math.max(ka.length, kb.length);
    if (ratio < (ka.length < kb.length ? 0.75 : 0.8)) return false;
    return jaroWinkler(ka, kb) >= 0.9;
  });
}

/**
 * Best real street for a (possibly misheard) spoken street, or null if there is
 * no confident match. The spoken suffix must agree when both have one, and the
 * winner must clearly beat the runner-up.
 */
function correctStreet(spokenStreet, gazetteer, { minScore = 0.9, margin = 0.02 } = {}) {
  const spoken = parseStreet(spokenStreet);
  if (!spoken.name || !gazetteer || gazetteer.length === 0) return null;
  let best = null, second = null;
  for (const g of gazetteer) {
    if (spoken.suffix && g.parsed.suffix && spoken.suffix !== g.parsed.suffix) continue;
    if (spoken.dir && g.parsed.dir && spoken.dir !== g.parsed.dir) continue;
    if (!soundsAlike(spoken.name, g.parsed.name)) continue;
    let score = nameSimilarity(spokenStreet, g.road);
    score += Math.min(Math.log10(g.count + 1), 3) * 0.004; // tiny nudge toward commonly dispatched streets
    if (!best || score > best.score) { second = best; best = { ...g, score }; } else if (!second || score > second.score) second = { ...g, score };
  }
  if (!best || best.score < minScore) return null;
  if (second && second.parsed.name !== best.parsed.name && best.score - second.score < margin) return null; // ambiguous
  if (best.parsed.name === spoken.name) return null; // already right
  return { road: best.road, score: Math.round(best.score * 1000) / 1000 };
}

// --- Pre-filter -------------------------------------------------------------
// Most radio traffic ("10-4, show me en route") has no location at all. Calls
// with no number, street word, place word or named place are skipped instead of
// being sent to the AI. Checked against a week of calls: skips ~28% of AI
// requests and none of the calls that were plotted.
const LOCATION_SUFFIX = /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|pkwy|parkway|hwy|highway|fwy|freeway|way|cir|circle|ct|court|pl|place|trl|trail|loop|xing|crossing|sq|square|ter|terrace|cove|bend|path|run|row|pass|ridge|creeks?|beltway|tollway|feeder|service road|frontage)\b/i;
const LOCATION_PLACE = /\b(school|elementary|high|middle|college|university|park|mall|hospital|memorial|methodist|hermann|church|apartments?|complex|plaza|center|centre|walmart|wal-mart|target|h-?e-?b|kroger|costco|home depot|lowe'?s|mcdonald'?s|whataburger|burger|taco|pizza|caesars|wendy'?s|sonic|popeyes|chick|starbucks|shell|exxon|valero|chevron|buc-?ee'?s|motel|hotel|inn|station|airport|stadium|library|courthouse|jail|store|restaurant|bank|clinic|bar|club|lake|bayou|cemetery|subdivision|village|estates|meadows|woods|oaks|townhomes|marketplace|outlet|parking lot)\b/i;
const LOCATION_NAMED = /\b(at|on|in|to|by|near|behind|outside)\s+(the\s+)?(uh,?\s+)?[A-Z][a-z]{2,}/;
const LOCATION_PHRASE = /\b(corner of|intersection|block of|cross street)\b/i;

function mightContainLocation(text) {
  const t = String(text || '');
  return /\d/.test(t) || LOCATION_SUFFIX.test(t) || LOCATION_PLACE.test(t) || LOCATION_NAMED.test(t) || LOCATION_PHRASE.test(t);
}

module.exports = { mightContainLocation, placeMatches, placeKindWords, kindsAgree, GENERIC_PLACE_WORDS, wordSimilarity, parseStreet, soundKey, nameSimilarity, roadMatches, isNumberedRoad, streetOf, buildGazetteer, correctStreet };
