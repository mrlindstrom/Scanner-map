// geocoding.js - Address extraction and geocoding module (using LocationIQ)

require('dotenv').config();
const fetch = require('node-fetch');
const winston = require('winston');
const { getFileTransports } = require('./src/logger');
const { consoleFormat } = require('./src/consoleFormat');
const streets = require('./src/geocoding/streets');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');

// Environment variables - strict loading from .env only. Re-read when .env
// changes (see reloadSettings at the end of this file).
let LOCATIONIQ_API_KEY, GOOGLE_MAPS_API_KEY, GEOCODING_STATE, GEOCODING_COUNTRY, GEOCODING_TARGET_COUNTIES,
  GEOCODING_CITY, TIMEZONE, AI_PROVIDER, OPENAI_API_KEY, OPENAI_MODEL, OLLAMA_URL, OLLAMA_MODEL, TARGET_CITIES_LIST;
function readGeocodingEnv() {
  ({
    LOCATIONIQ_API_KEY = null,
    GOOGLE_MAPS_API_KEY = null, // Added for Google API support
    GEOCODING_STATE,
    GEOCODING_COUNTRY,
    GEOCODING_TARGET_COUNTIES,
    GEOCODING_CITY, // Still used as a fallback town name in LLM prompt
    TIMEZONE,
    // --- NEW: AI Provider Env Vars ---
    AI_PROVIDER,
    OPENAI_API_KEY,
    OPENAI_MODEL,
    OLLAMA_URL,
    OLLAMA_MODEL,
    TARGET_CITIES_LIST // Kept for potential future use or reference
  } = process.env);
}
readGeocodingEnv();

// --- VALIDATE AI-RELATED ENV VARS ---
if (!AI_PROVIDER) {
    console.error("FATAL: [Geocoding] AI_PROVIDER is not set in the .env file. Please specify 'ollama' or 'openai'.");
    process.exit(1);
}

if (AI_PROVIDER.toLowerCase() === 'openai') {
    if (!OPENAI_API_KEY || !OPENAI_MODEL) {
        console.error("FATAL: [Geocoding] AI_PROVIDER is 'openai', but OPENAI_API_KEY or OPENAI_MODEL is missing in the .env file.");
        process.exit(1);
    }
} else if (AI_PROVIDER.toLowerCase() === 'ollama') {
    if (!OLLAMA_URL || !OLLAMA_MODEL) {
        console.error("FATAL: [Geocoding] AI_PROVIDER is 'ollama', but OLLAMA_URL or OLLAMA_MODEL is missing in the .env file.");
        process.exit(1);
    }
} else {
    console.error(`FATAL: [Geocoding] Invalid AI_PROVIDER specified in .env file: '${AI_PROVIDER}'. Must be 'openai' or 'ollama'.`);
    process.exit(1);
}
// --- END VALIDATION ---

// Validate required environment variables
// Check if we have at least one geocoding API key
let hasGoogleMaps = !!GOOGLE_MAPS_API_KEY;
let hasLocationIQ = !!LOCATIONIQ_API_KEY;

if (!hasGoogleMaps && !hasLocationIQ) {
  console.error('ERROR: At least one geocoding API key is required (GOOGLE_MAPS_API_KEY or LOCATIONIQ_API_KEY)');
  process.exit(1);
}

// Determine which provider to use and validate required variables
let geocodingProvider = null;

function chooseGeocodingProvider() {
  if (hasGoogleMaps && hasLocationIQ) {
    // Both available - prefer LocationIQ for consistency with existing setup
    geocodingProvider = 'locationiq';
    console.log('[Geocoding] Both Google Maps and LocationIQ available, using LocationIQ');
  } else if (hasLocationIQ) {
    geocodingProvider = 'locationiq';
    console.log('[Geocoding] Using LocationIQ for geocoding');
  } else if (hasGoogleMaps) {
    geocodingProvider = 'google';
    console.log('[Geocoding] Using Google Maps for geocoding');
  }
}
chooseGeocodingProvider();

// Validate required environment variables based on provider
const requiredVars = ['GEOCODING_STATE', 'GEOCODING_COUNTRY', 'GEOCODING_CITY', 'GEOCODING_TARGET_COUNTIES'];
const missingVars = requiredVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error(`ERROR: Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// Set default values for any missing optional variables
if (!process.env.GEOCODING_STATE) process.env.GEOCODING_STATE = 'MD';
if (!process.env.GEOCODING_COUNTRY) process.env.GEOCODING_COUNTRY = 'us';
if (!process.env.GEOCODING_CITY) process.env.GEOCODING_CITY = 'Baltimore';
if (!process.env.GEOCODING_TARGET_COUNTIES) process.env.GEOCODING_TARGET_COUNTIES = 'Baltimore,Baltimore City,Anne Arundel,Howard,Carroll,Harford';

// Parse target counties into array
let TARGET_COUNTIES = process.env.GEOCODING_TARGET_COUNTIES.split(',').map(county => county.trim());
let COUNTRY_CODES = process.env.GEOCODING_COUNTRY; // LocationIQ uses country codes

// Console shows only the extracted and geocoded addresses (plus warnings and
// errors); the log files keep every step so extraction can be reviewed later.
const CONSOLE_INFO_PATTERNS = [
  /^Geocoded Address: ".+" with coordinates \(.+, .+\) in .+$/,
  /^LLM Extracted Address:/,
];
function geocodeConsoleFilter(info) {
  if (info.level !== 'info') return true;
  const message = String(info.message || '');
  if (/^LLM Extracted Address: "No address found\.?"$/.test(message)) return false;
  return CONSOLE_INFO_PATTERNS.some((pattern) => pattern.test(message));
}

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: () => moment().tz(TIMEZONE).format('MM/DD/YYYY HH:mm:ss.SSS')
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    // Daily-rotated JSON files in ./logs, shared with bot.js (see src/logger.js)
    ...getFileTransports(),
    new winston.transports.Console({ format: consoleFormat({ source: 'geocode', filter: geocodeConsoleFilter }) })
  ]
});

// Build TALK_GROUPS from environment variables (remains the same)
const TALK_GROUPS = {};
function readTalkGroupHints() {
  Object.keys(TALK_GROUPS).forEach((id) => { delete TALK_GROUPS[id]; });
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('TALK_GROUP_')) {
      const talkGroupId = key.replace('TALK_GROUP_', '');
      TALK_GROUPS[talkGroupId] = process.env[key];
    }
  });
}
readTalkGroupHints();
logger.info(`Loaded ${Object.keys(TALK_GROUPS).length} talk groups from environment variables`);

// Target cities that are allowed to plot. If non-empty, an address whose city
// is NOT in this list is rejected (it won't appear on the map).
let TARGET_CITIES = process.env.TARGET_CITIES_LIST
  ? process.env.TARGET_CITIES_LIST.split(',').map(city => city.trim()).filter(Boolean)
  : [];

// --- Normalization helpers so matching is forgiving (case + suffixes) ---
function normalizeCounty(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(county|parish|borough)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function normalizePlace(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(city|town|township|village)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

let TARGET_COUNTY_SET = new Set(TARGET_COUNTIES.map(normalizeCounty).filter(Boolean));
let TARGET_CITY_SET = new Set(TARGET_CITIES.map(normalizePlace).filter(Boolean));

function isTargetCounty(county) {
  if (!TARGET_COUNTY_SET.size) return true; // no counties configured -> allow
  return TARGET_COUNTY_SET.has(normalizeCounty(county));
}
function isTargetCity(city) {
  if (!TARGET_CITY_SET.size) return true; // empty list -> allow all (county still gates)
  if (!city) return false;
  return TARGET_CITY_SET.has(normalizePlace(city));
}

/**
 * Per-talkgroup metadata, primarily populated from the imported `talk_groups`
 * SQLite table (the same data the Setup Wizard imports). Maps talkgroup id ->
 * { town, county }. This replaces the old, rarely-used TALK_GROUP_<id> env vars
 * and gives the LLM/geocoder accurate per-channel county context.
 */
const TALK_GROUP_META = {};

/**
 * Load talkgroup metadata. Prefers the DB `talk_groups` table; falls back to
 * (and merges with) any legacy TALK_GROUP_<id> environment variables.
 * @param {import('sqlite3').Database} [db]
 */
let talkGroupDb = null; // kept so changed TALK_GROUP_<id> hints can be re-merged
function loadTalkGroups(db) {
  if (db) talkGroupDb = db;
  // Seed from legacy env vars first (so DB can override with richer data).
  Object.keys(TALK_GROUPS).forEach((id) => {
    TALK_GROUP_META[id] = { town: TALK_GROUPS[id], county: null };
  });

  if (!db || typeof db.all !== 'function') {
    logger.info(`Loaded ${Object.keys(TALK_GROUP_META).length} talk groups (env only; no DB handle)`);
    return Promise.resolve(TALK_GROUP_META);
  }

  return new Promise((resolve) => {
    db.all('SELECT id, system, alpha_tag, county FROM talk_groups', (err, rows) => {
      if (err) {
        logger.warn(`Could not load talk_groups from DB: ${err.message}. Using env vars only.`);
        return resolve(TALK_GROUP_META);
      }
      (rows || []).forEach((row) => {
        const id = String(row.id);
        const sys = String(row.system || '').trim().toLowerCase();
        const meta = {
          town: (TALK_GROUPS[id] || row.alpha_tag || '').trim(),
          county: (row.county || '').trim() || null,
        };
        // Store under a system-scoped key so overlapping ids across systems keep
        // their own county hint, plus a plain-id key as a best-effort fallback
        // for callers that don't know the system.
        if (sys) TALK_GROUP_META[`${sys}:${id}`] = meta;
        if (!TALK_GROUP_META[id] || sys === '') TALK_GROUP_META[id] = meta;
      });
      logger.info(`Loaded ${Object.keys(TALK_GROUP_META).length} talk group entries (DB + env) for geocoding context`);
      resolve(TALK_GROUP_META);
    });
  });
}

/**
 * Helper Functions
 */

/**
 * Escapes special characters in a string for use in a regular expression. (remains the same)
 * @param {string} string - The string to escape.
 * @returns {string} - The escaped string.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Street-type tokens — used for format checks and transcript anchoring. */
const STREET_SUFFIX_WORDS = new Set([
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane',
  'blvd', 'boulevard', 'pkwy', 'parkway', 'hwy', 'highway', 'way', 'circle',
  'cir', 'court', 'ct', 'place', 'pl', 'terrace', 'trl', 'trail', 'loop',
  'run', 'row', 'crossing', 'xing', 'square', 'sq', 'block',
]);
const STREET_SUFFIX_RE = /\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|pkwy|parkway|hwy|highway|way|circle|cir|court|ct|place|pl|terrace|trl|trail|loop|run|row|square|sq)\b/i;

/**
 * Strip trailing city/state from a normalized address for structural checks.
 */
function addressCorePart(address) {
  let core = String(address || '').trim();
  core = core.replace(new RegExp(`,\\s*${escapeRegExp(GEOCODING_STATE)}\\s*$`, 'i'), '').trim();
  core = core.replace(new RegExp(`,\\s*${escapeRegExp(GEOCODING_CITY)}\\s*$`, 'i'), '').trim();
  // Drop any other trailing ", City" segments the model may have added.
  const parts = core.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) core = parts[0];
  return core.trim();
}

/**
 * Reject LLM output that is only numbers, timing references, or lacks a real street/place.
 */
function looksLikePlausibleAddress(address) {
  const core = addressCorePart(address);
  if (!core) return false;

  // Bare numbers: "723", "723. 622", "723, 622"
  if (/^\d{1,6}([.\s,]+\d{1,6})*$/.test(core)) return false;

  // Intersections are valid even without a house number.
  if (/\s&\s/.test(core) || /\band\b/i.test(core)) return true;

  // House number + street suffix (e.g. "723 Main St", "300 Maple Dr")
  if (/^\d{1,6}\s+.+/i.test(core) && STREET_SUFFIX_RE.test(core)) return true;

  // Named place / POI with multiple words and no leading bare number.
  const words = core.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && !/^\d{1,6}$/.test(words[0])) return true;

  // House number + alphabetic street name without suffix ("7908 Cindy Lane" before normalization)
  if (/^\d{1,6}\s+[a-z]{2,}/i.test(core)) {
    const afterNum = words.slice(1);
    if (afterNum.some((w) => /^[a-z]{3,}$/i.test(w) && !STREET_SUFFIX_WORDS.has(w.toLowerCase()))) {
      return true;
    }
  }

  return false;
}

/**
 * Anti-hallucination: at least one significant place/street word in the LLM output
 * must appear in the original transcript (prevents inventing "Main St" for "723").
 */
function addressAnchoredInTranscript(address, transcript) {
  const core = addressCorePart(address).toLowerCase();
  const transcriptLower = String(transcript || '').toLowerCase();
  if (!core || !transcriptLower) return false;

  const tokens = core.split(/[^a-z0-9]+/i).filter((t) => t.length >= 3);
  const placeWords = tokens.filter((t) => !STREET_SUFFIX_WORDS.has(t) && !/^\d+$/.test(t));

  if (placeWords.length === 0) return false;

  // Sound-alike spellings count: the model may correct a misheard name
  // ("Tombo Parkway" in the transcript -> "Tomball Parkway").
  const transcriptWords = transcriptLower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const inTranscript = (w) => transcriptLower.includes(w)
    || (w.length >= 4 && transcriptWords.some((t) => t.length >= 4 && streets.wordSimilarity(t, w) >= 0.88)); // spoken word first
  const matched = placeWords.filter(inTranscript);
  if (matched.length === 0) return false;

  // Intersections: need evidence of two different street names in the transcript.
  if (/\s&\s/.test(core) || /\band\b/.test(core)) {
    const sides = core.split(/\s+(?:&|and)\s+/i);
    if (sides.length >= 2) {
      const sideHits = sides.map((side) => {
        const sideWords = side.split(/[^a-z0-9]+/i)
          .filter((t) => t.length >= 3 && !STREET_SUFFIX_WORDS.has(t) && !/^\d+$/.test(t));
        return sideWords.some(inTranscript);
      });
      return sideHits.filter(Boolean).length >= 2;
    }
  }

  return true;
}

/**
 * Low-level LLM call shared by extraction and verification. Returns trimmed text
 * (with any <think> block stripped) or null on error/timeout. Honors AI_PROVIDER.
 * @param {string} prompt
 * @param {{maxTokens?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<string|null>}
 */
async function callLLM(prompt, opts = {}) {
  const maxTokens = opts.maxTokens || 800;
  const timeoutMs = opts.timeoutMs || (parseInt(process.env.AI_EXTRACT_TIMEOUT_MS, 10) || 30000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    logger.warn(`[Geocoding] AI request timed out after ${timeoutMs / 1000}s.`);
    controller.abort();
  }, timeoutMs);
  try {
    let text = '';
    if (AI_PROVIDER.toLowerCase() === 'openai') {
      if (!OPENAI_API_KEY) {
        logger.error('[Geocoding] AI_PROVIDER is openai but OPENAI_API_KEY is not configured!');
        return null;
      }
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`OpenAI API error! status: ${response.status}. Body: ${errorBody}`);
      }
      const result = await response.json();
      if (result.choices && result.choices.length > 0 && result.choices[0].message) {
        text = result.choices[0].message.content.trim();
      }
    } else {
      const response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt,
          stream: false,
          think: false,
          options: { temperature: 0, top_p: 0.1, num_predict: maxTokens, num_ctx: 8192 },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Ollama API error! status: ${response.status}`);
      const result = await response.json();
      text = (result.response || '').trim();
    }

    // Strip reasoning-model <think> blocks (closed or truncated/open).
    text = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
    const openThink = text.search(/<think>/i);
    if (openThink >= 0) text = text.slice(0, openThink).trim();
    return text;
  } catch (error) {
    if (error.name === 'AbortError') {
      logger.error(`[Geocoding] AI request timed out: ${error.message}`);
    } else {
      logger.error(`[Geocoding] AI request failed: ${error.message}`);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Second-pass sanity check: ask the LLM whether the extracted address is really the
 * incident location described in the transcript. Defaults ON; disable with
 * AI_VERIFY_ADDRESS=false. On error/timeout it fails OPEN (keeps the address) so a
 * flaky AI never silently drops every plot.
 * @param {string} address - The normalized address we're about to geocode.
 * @param {string} transcript - The original transcript.
 * @returns {Promise<boolean>} - true if the address should be kept.
 */
async function verifyAddressWithLLM(address, transcript) {
  if (String(process.env.AI_VERIFY_ADDRESS || 'true').toLowerCase() === 'false') return true;

  // Verify only the street/place part. The trailing city/state was likely
  // auto-added to complete the address and usually isn't spoken in the
  // transcript, so including it would cause false rejections.
  const core = addressCorePart(address) || address;

  const prompt = `You are checking whether a street/place was correctly extracted from a first-responder dispatch transcript.

TRANSCRIPT:
"${transcript}"

EXTRACTED STREET/PLACE:
"${core}"

A city and state may have been added automatically to complete the address — IGNORE the city/state and judge only the street, intersection, or named place above.
The transcript is automatic speech-to-text, so judge the street/place NAME, not how the house number was written: "10-11" may become 1011, "1944 to Archer Glen" may become 1944 Archer Glen, and names may be spelled differently ("Tombo Parkway" for Tomball Parkway).
Answer NO if any of these are true:
- The street/place name does NOT appear in the transcript, even misspelled (it was invented or hallucinated).
- It is actually a unit number, radio code, ETA/time, signal report, patient age, callsign, or other number — not a real location.
- The transcript contains no real street, intersection, or named place at all.
Answer YES if the transcript mentions this street, intersection, or named place (even loosely) as a location.

Respond with exactly one word: YES or NO.`;

  const answer = await callLLM(prompt, { maxTokens: 200 });
  if (answer === null) {
    logger.warn(`[Geocoding] Address verification unavailable (AI error/timeout); keeping "${address}".`);
    return true; // fail open
  }
  const verdict = answer.toUpperCase();
  const isYes = /\bYES\b/.test(verdict) && !/\bNO\b/.test(verdict);
  if (!isYes) {
    logger.info(`[Geocoding] Verification rejected "${address}" for transcript snippet: "${String(transcript).slice(0, 120)}" (LLM said: "${answer.slice(0, 40)}")`);
  } else {
    logger.info(`[Geocoding] Verification passed for "${address}".`);
  }
  return isYes;
}

/**
 * Uses local LLM to extract and complete addresses from the full transcript. (remains the same)
 * @param {string} transcript - The full transcript text.
 * @param {string} town - The town associated with the transcript.
 * @returns {Promise<string|null>} - The extracted and completed address or null if not found.
 */
async function extractAddressWithLLM(transcript, town) {
  try {
    const countiesString = TARGET_COUNTIES.join(', ');
    const commonPrompt = `You extract the incident LOCATION from a first-responder dispatch transcript.
The transcript mixes radio codes, unit numbers, call types, and chatter together with the address — ignore the codes and find the location of the incident.

What counts as a location: a street with a house number, an intersection of two streets, or a specific named place (mall, park, school, hospital, building).
What does NOT count: bare numbers, unit IDs (e.g. "ALS-742", "Engine 7"), call types, ETA/timing phrases, signal-strength numbers, or radio chatter with no street/place name.

Rules:
- Normalize spelled-out or hyphenated house numbers ("7-9-0-8 Cindy Lane" -> "7908 Cindy Lane").
- If a house number is present, output ONLY that one street (e.g. "7908 Cindy Lane"). Do NOT append the cross street.
- "Cross street X", "cross of X", or a second street listed after the main one is just a nearby reference — IGNORE it and keep only the street that has the house number.
- Use the "&" intersection format ONLY when there is NO house number and the location is genuinely described as the corner of two streets.
- Never invent a street that is not spoken in the transcript. Every street/place word in your answer MUST appear in the transcript.
- Add a city ONLY if it is spoken in the transcript. Never guess or add a default city; the search is already limited to the coverage area. Never output a city alone.
- Coverage counties: ${countiesString}.
${TARGET_CITIES.length ? `- Known cities/towns in the area: ${TARGET_CITIES.join(', ')}.` : ''}

Examples that are NOT locations (respond: No address found):
- "I made time for 723. 622." (timing/ETA numbers, no street)
- "Copy that, unit 5 responding, 10-4 received"
- "Reference 7-9-0-8" (digits alone, no street name follows)
- "723" (a number without a street or place name)

Formatting:
- Address: 123 Main St (add ", City" only when the city is spoken: 123 Main St, Tomball)
- Block ("300 block of Maple Dr") -> 300 Maple Dr
- Spoken digit groups are one house number ("10-11 Village Square" -> 1011 Village Square; "27, 419 Tomball Parkway" -> 27419 Tomball Parkway)
- Intersection (no house number only): use "&" between the two streets -> Main St & Oak Ave
- Address WITH a house number plus a cross street -> keep only the numbered street. ("71003 Luttrell Lane, cross street Westchester Drive" -> 71003 Luttrell Lane)
- When the address is repeated, use the clearest complete version.

Respond with ONLY the location on one line (for example: 7908 Cindy Lane), or exactly: No address found
Do not wrap the answer in quotes and do not add any commentary.

Transcript (from ${town}):
"${transcript}"`;

    // Add AbortController for timeout
    const controller = new AbortController();
    const AI_TIMEOUT_MS = parseInt(process.env.AI_EXTRACT_TIMEOUT_MS, 10) || 30000;
    const timeoutId = setTimeout(() => {
        logger.warn(`[Geocoding] AI request timed out after ${AI_TIMEOUT_MS / 1000}s for address extraction.`);
        controller.abort();
    }, AI_TIMEOUT_MS);

    let extractedAddress = '';

    if (AI_PROVIDER.toLowerCase() === 'openai') {
        if (!OPENAI_API_KEY) {
            logger.error("[Geocoding] FATAL: AI_PROVIDER is set to openai, but OPENAI_API_KEY is not configured!");
            return null;
        }
        logger.info(`[Geocoding] Extracting address with OpenAI model: ${OPENAI_MODEL}`);

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages: [{ role: 'user', content: commonPrompt }],
                temperature: 0.1, // Very low temp for extraction
                max_tokens: 50
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`OpenAI API error! status: ${response.status}. Body: ${errorBody}`);
        }
        const result = await response.json();
        if (result.choices && result.choices.length > 0 && result.choices[0].message) {
            extractedAddress = result.choices[0].message.content.trim();
        }

    } else { // Default to Ollama
        logger.info(`[Geocoding] Extracting address with Ollama model: ${OLLAMA_MODEL}`);

        const response = await fetch(`${OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: commonPrompt,
            stream: false,
            // Disable chain-of-thought for reasoning models (qwen3, deepseek-r1, …).
            // Address extraction is a simple task; thinking just adds 8-15s/call
            // (which blows the timeout) and is no more accurate. Unknown to older
            // Ollama builds, which harmlessly ignore the field.
            think: false,
            // Deterministic, low-creativity decoding for reliable extraction.
            // Without this, Ollama uses the model default (~0.8) and the same
            // transcript intermittently yields "No address found".
            options: { temperature: 0, top_p: 0.1, num_predict: 800, num_ctx: 8192 }
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`Ollama API error! status: ${response.status}`);
        }

        const result = await response.json();
        extractedAddress = result.response.trim();
    }
    
    clearTimeout(timeoutId);

    // --- ADDED: Remove <think> block (reasoning models: qwen3, deepseek-r1, …) ---
    // Some Ollama builds also return reasoning in a separate "thinking" field and
    // leave only the answer in "response"; in that case there's nothing to strip.
    const thinkBlockRegex = /<think>[\s\S]*?<\/think>\s*/gi;
    extractedAddress = extractedAddress.replace(thinkBlockRegex, '').trim();
    // If a think block was truncated (open tag, no close), drop everything after it.
    const openThink = extractedAddress.search(/<think>/i);
    if (openThink >= 0) extractedAddress = extractedAddress.slice(0, openThink).trim();
    // --- END ADDED ---

    // Strip surrounding quotes the model sometimes adds (e.g. "7908 Cindy Lane, ...")
    // and collapse to a single line; otherwise the literal quotes break geocoding.
    extractedAddress = extractedAddress.split('\n')[0].trim();
    extractedAddress = extractedAddress.replace(/^["'`]+|["'`]+$/g, '').trim();

    logger.info(`LLM Extracted Address: \"${extractedAddress}\"`);

    if (/^no address found\.?$/i.test(extractedAddress)) {
      return null;
    }

    // --- ADDED: Check for overly generic LLM response ---
    const trimmedLlmOutput = extractedAddress.trim();
    const genericCityStatePattern = new RegExp(`^${escapeRegExp(GEOCODING_CITY)},\\s*${escapeRegExp(GEOCODING_STATE)}$`, 'i');
    const justCityPattern = new RegExp(`^${escapeRegExp(GEOCODING_CITY)}$`, 'i');

    if (genericCityStatePattern.test(trimmedLlmOutput) || justCityPattern.test(trimmedLlmOutput)) {
      logger.info(`LLM returned a generic city/state or just city: "${trimmedLlmOutput}". Treating as no address found.`);
      return null;
    }
    // --- END ADDED ---

    return extractedAddress;
  } catch (error) {
    // Check specifically for AbortError (timeout)
    if (error.name === 'AbortError') {
         logger.error(`[Geocoding] AI request timed out during address extraction: ${error.message}`);
         return null; // Return null on timeout
    }
    logger.error(`Error extracting address with LLM: ${error.message}`);
    return null;
  }
}

/**
 * Geocodes an address using LocationIQ's Geocoding API, filtering for specific results.
 * @param {string} address - The address query string.
 * @returns {Promise<{ lat: number, lng: number, formatted_address: string, county: string } | null>} - Geocoded data or null.
 */
async function geocodeAddress(address) {
  // 1. Input Validation
  if (!address || address.trim() === '') {
    logger.info('No address provided for geocoding.');
    return null;
  }

  // Check which geocoding provider to use
  if (geocodingProvider === 'locationiq') {
    return await geocodeAddressWithLocationIQ(address);
  } else if (geocodingProvider === 'google') {
    return await geocodeAddressWithGoogleMaps(address);
  } else {
    logger.error('No geocoding API key available');
    return null;
  }
}

// --- Search area and street list ---------------------------------------------
// Searches are limited to a box around the target counties instead of naming a
// city (appending GEOCODING_CITY sent Houston streets to "Spring" and some to
// Big Spring, TX). The street list holds real local road names from past
// geocodes, used to correct misheard streets (see src/geocoding/streets.js).

let targetViewbox = null;        // "minLon,minLat,maxLon,maxLat" for LocationIQ
let targetViewboxPromise = null;
let streetGazetteer = [];

async function getTargetViewbox() {
  if (targetViewbox !== null || !LOCATIONIQ_API_KEY) return targetViewbox || null;
  if (!targetViewboxPromise) {
    targetViewboxPromise = (async () => {
      const boxes = [];
      for (const county of TARGET_COUNTIES) {
        const name = /county|parish/i.test(county) ? county : `${county} County`;
        const params = new URLSearchParams({ q: `${name}, ${GEOCODING_STATE}`, key: LOCATIONIQ_API_KEY, format: 'json', limit: '1', countrycodes: COUNTRY_CODES });
        try {
          const res = await fetch(`https://us1.locationiq.com/v1/search?${params}`);
          const data = res.ok ? await res.json() : [];
          const bb = Array.isArray(data) && data[0] && data[0].boundingbox; // [south, north, west, east]
          if (bb) boxes.push(bb.map(Number));
          await new Promise((r) => setTimeout(r, 600)); // free plan: 2 requests/second
        } catch (e) {
          logger.warn(`[Geocoding] Could not look up the area of ${name}: ${e.message}`);
        }
      }
      if (boxes.length === 0) {
        logger.warn('[Geocoding] No target county areas found; searching without an area limit');
        targetViewbox = '';
        return null;
      }
      const pad = 0.02; // ~2 km so addresses on a county line aren't cut off
      const south = Math.min(...boxes.map((b) => b[0])) - pad, north = Math.max(...boxes.map((b) => b[1])) + pad;
      const west = Math.min(...boxes.map((b) => b[2])) - pad, east = Math.max(...boxes.map((b) => b[3])) + pad;
      targetViewbox = `${west},${south},${east},${north}`;
      logger.info(`[Geocoding] Searching within ${TARGET_COUNTIES.join(' + ')}: ${targetViewbox}`);
      return targetViewbox;
    })();
  }
  return targetViewboxPromise;
}

/** Build the street list from addresses already geocoded (call at startup and daily). */
function loadStreetGazetteer(db) {
  return new Promise((resolve) => {
    db.all('SELECT address FROM transcriptions WHERE address IS NOT NULL AND lat IS NOT NULL', [], (err, rows) => {
      if (err) {
        logger.warn(`[Geocoding] Could not build the street list: ${err.message}`);
        return resolve(streetGazetteer.length);
      }
      streetGazetteer = streets.buildGazetteer(rows.map((r) => r.address));
      logger.info(`[Geocoding] Street list: ${streetGazetteer.length} local streets from ${rows.length} past geocodes`);
      resolve(streetGazetteer.length);
    });
  });
}

function houseNumberOf(address) {
  const m = String(address || '').match(/^\s*(\d+)[a-z]?\s/i);
  return m ? m[1] : null;
}

async function locationIqSearch(query, viewbox) {
  const params = new URLSearchParams({
    q: query,
    key: LOCATIONIQ_API_KEY,
    format: 'json',
    addressdetails: '1',
    normalizeaddress: '1',
    countrycodes: COUNTRY_CODES,
    limit: '10',
    dedupe: '1',
  });
  if (viewbox) { params.set('viewbox', viewbox); params.set('bounded', '1'); }
  const response = await fetch(`https://us1.locationiq.com/v1/search?${params.toString()}`);
  if (response.status === 404) return []; // LocationIQ answers "no results" with 404
  if (!response.ok) {
    logger.error(`LocationIQ API error: ${response.status} ${response.statusText} for query: "${query}"`);
    return [];
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Check one LocationIQ result. Returns { ok, reason, exactHouse, result }.
 * spokenStreet is the street as extracted (or corrected); results on another
 * street are rejected so a matching house number elsewhere can't win.
 */
function judgeLocationIqResult(result, spokenStreet, houseNumber, spokenPlace) {
  const lat = parseFloat(result.lat), lon = parseFloat(result.lon);
  const details = result.address || {};
  if (isNaN(lat) || isNaN(lon) || !result.display_name) return { ok: false, reason: 'missing coordinates' };

  const isAdmin = ['city', 'town', 'village', 'municipality', 'administrative', 'county', 'state', 'postcode'].includes(result.type);
  const isHighway = result.class === 'highway' || result.type === 'intersection';
  const isPlace = result.class === 'place' && !isAdmin;
  if (!details.road && !isPlace && !isHighway) return { ok: false, reason: `too vague (${result.type})` };

  if (!details.county || !isTargetCounty(details.county)) {
    return { ok: false, reason: `outside target counties (${details.county || 'no county'})` };
  }
  const cityName = details.city || details.town || details.village || details.hamlet || details.municipality || '';
  if (TARGET_CITY_SET.size && !isTargetCity(cityName)) {
    return { ok: false, reason: `city "${cityName || 'unknown'}" not in TARGET_CITIES_LIST` };
  }
  const exactHouse = !!(houseNumber && details.house_number && String(details.house_number) === String(houseNumber));
  if (spokenStreet && details.road) {
    // A matching house number backs up a loose spelling match; a street-level
    // result (house number not found) has to match the name more closely.
    const needed = houseNumber && !exactHouse ? 0.95 : 0.88;
    if (!streets.roadMatches(spokenStreet, details.road, needed)) {
      return { ok: false, reason: `different street (${details.road})` };
    }
  } else if (!spokenStreet && spokenPlace) {
    // Named place or intersection: the result has to be that place / one of those streets
    const sides = spokenPlace.split(/\s+(?:&|and)\s+/i);
    // normalizeaddress=1 leaves out class/type: a street result leads with the
    // road name or a house number, a place leads with its own name
    const leading = result.display_name.split(',')[0].trim();
    const isStreetResult = result.class === 'highway'
      || (!!details.road && (leading === details.road || /^\d/.test(leading)));
    let ok;
    if (sides.length > 1) {
      // Intersection: on one of the two streets
      ok = sides.some((side) => details.road && streets.roadMatches(side, details.road));
    } else if (streets.parseStreet(spokenPlace).suffix || streets.isNumberedRoad(spokenPlace)) {
      // A street with no house number ("Spring Cypress Road"): must be that street
      ok = !!details.road && streets.roadMatches(spokenPlace, details.road, 0.95);
    } else {
      // A named place (school, store, park): the place itself, never a street
      // that shares a word with it ("Lucas Auto Care" is not Lucas Street)
      const placeName = [details.name, result.display_name.split(',')[0]].filter(Boolean).join(' ');
      ok = !isStreetResult && streets.placeMatches(spokenPlace, placeName);
    }
    if (!ok) return { ok: false, reason: `different place (${result.display_name.split(',')[0]})` };
  }
  return {
    ok: true,
    exactHouse,
    result: { lat, lng: lon, formatted_address: result.display_name, county: details.county },
  };
}

/** Best acceptable result for a query: exact house number first, then the geocoder's order. */
async function bestLocationIqMatch(query, spokenStreet, houseNumber, viewbox) {
  const results = await locationIqSearch(query, viewbox);
  const spokenPlace = query.split(',')[0].trim();
  const judged = results.map((r) => judgeLocationIqResult(r, spokenStreet, houseNumber, spokenPlace));
  const good = judged.filter((j) => j.ok);
  const pick = good.find((j) => j.exactHouse) || good[0];
  return { pick: pick ? pick.result : null, exactHouse: !!(pick && pick.exactHouse), judged, count: results.length };
}

async function geocodeAddressWithLocationIQ(address) {
  try {
    const viewbox = await getTargetViewbox();
    const spokenStreet = streets.streetOf(address);
    const houseNumber = houseNumberOf(address);

    let { pick, exactHouse, judged, count } = await bestLocationIqMatch(address, spokenStreet, houseNumber, viewbox);
    let usedQuery = address;

    // Not found as spoken: try the closest real local street (speech-to-text
    // often mishears names, e.g. "Tombo Parkway" for Tomball Parkway)
    if (!pick && spokenStreet) {
      const corrected = streets.correctStreet(spokenStreet, streetGazetteer);
      if (corrected) {
        const correctedAddress = address.replace(spokenStreet, corrected.road);
        logger.info(`[Geocoding] "${spokenStreet}" not found; trying likely street "${corrected.road}" (match ${corrected.score})`);
        await new Promise((r) => setTimeout(r, 500)); // free plan: 2 requests/second
        ({ pick, exactHouse, judged, count } = await bestLocationIqMatch(correctedAddress, corrected.road, houseNumber, viewbox));
        usedQuery = correctedAddress;
      }
    }

    if (!pick) {
      const reasons = [...new Set(judged.map((j) => j.reason))].slice(0, 3).join('; ');
      logger.warn(`[Filter Action] No usable geocode for "${usedQuery}": ${count ? `${count} result(s) rejected (${reasons})` : 'no results in the target area'}`);
      return null;
    }
    logger.info(`Geocoded Address: "${pick.formatted_address}" with coordinates (${pick.lat}, ${pick.lng}) in ${pick.county}` +
      (houseNumber && !exactHouse ? ' (street-level, house number not found)' : ''));
    return pick;
  } catch (error) {
    logger.error(`Unexpected error in geocodeAddressWithLocationIQ for query "${address}": ${error.message}`, { stack: error.stack });
    return null;
  }
}

async function geocodeAddressWithGoogleMaps(address) {
  const endpoint = `https://maps.googleapis.com/maps/api/geocode/json`;
  // Extraction no longer guesses a city; Google has no area limit here, so
  // fall back to the default city when none was spoken ("123 Main St, TX").
  if (address.split(',').map((p) => p.trim()).filter(Boolean).length <= 2) {
    address = address.replace(new RegExp(`,\\s*${escapeRegExp(GEOCODING_STATE)}\\s*$`, 'i'), `, ${GEOCODING_CITY}, ${GEOCODING_STATE}`);
  }

  const params = new URLSearchParams({
    address: address,
    key: GOOGLE_MAPS_API_KEY,
    components: `country:${process.env.GEOCODING_COUNTRY}|administrative_area:${process.env.GEOCODING_STATE}`
  });

  try {
    const response = await fetch(`${endpoint}?${params.toString()}`);
    if (!response.ok) {
      logger.error(`Geocoding API error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      logger.warn(`Geocoding API returned status: ${data.status} for address: "${address}"`);
      return null;
    }
    
    // Find the most specific result (preferring street_address over locality)
    const preferredTypes = ['street_address', 'premise', 'subpremise', 'route', 'intersection', 'establishment', 'point_of_interest'];
    let bestResult = null;
    
    // First try to find results with preferred types
    for (const type of preferredTypes) {
      const matchingResult = data.results.find(r => r.types.includes(type));
      if (matchingResult) {
        bestResult = matchingResult;
        break;
      }
    }
    
    // If no preferred type found, use the first result
    const result = bestResult || data.results[0];
    const { lat, lng } = result.geometry.location;
    const formatted_address = result.formatted_address;
    const resultTypes = result.types;

    // Skip generic city-level results
    if (formatted_address.match(new RegExp(`^${process.env.GEOCODING_CITY}, ${process.env.GEOCODING_STATE} \\d{5}, USA$`))) {
      logger.info(`Skipping city-level result for ${process.env.GEOCODING_CITY}: "${formatted_address}"`);
      return null;
    }

    // Skip only generic city-level results while keeping useful partial matches
    if (resultTypes.includes('locality') && resultTypes.length <= 3 && !formatted_address.includes('Caravan')) {
      logger.info(`Skipping city-level result: "${formatted_address}"`);
      return null;
    }
    
    // Check for county-level results
    if (TARGET_COUNTIES.some(county => formatted_address === `${county}, ${process.env.GEOCODING_STATE}, USA`) || 
        (resultTypes.includes('administrative_area_level_2') && resultTypes.length <= 3)) {
      logger.info(`Skipping county-level result: "${formatted_address}"`);
      return null;
    }

    // Verify that the result is in one of the target counties (normalized match).
    const countyComponent = result.address_components.find(component =>
      component.types.includes('administrative_area_level_2')
    );
    const county = countyComponent ? countyComponent.long_name : null;

    if (!county || !isTargetCounty(county)) {
      const countiesList = TARGET_COUNTIES.join(' or ');
      logger.warn(`Geocoded address "${formatted_address}" (county: ${county || 'unknown'}) is not within ${countiesList}.`);
      return null;
    }

    // Target City Filtering (only when a TARGET_CITIES_LIST is configured).
    if (TARGET_CITY_SET.size) {
      const localityComponent = result.address_components.find(component =>
        component.types.includes('locality') || component.types.includes('sublocality')
        || component.types.includes('administrative_area_level_3')
      );
      const cityName = localityComponent ? localityComponent.long_name : '';
      if (!isTargetCity(cityName)) {
        logger.warn(`Address "${formatted_address}" is in target county but city "${cityName || 'unknown'}" is not in TARGET_CITIES_LIST. Skipping (won't plot).`);
        return null;
      }
    }

    logger.info(`Geocoded Address: "${formatted_address}" with coordinates (${lat}, ${lng}) in ${county}`);
    return { lat, lng, formatted_address, county };
  } catch (error) {
    logger.error(`Error geocoding address "${address}": ${error.message}`);
    return null;
  }
}


/**
 * Hyperlinks an address within the transcript text using coordinates.
 * @param {string} transcript - The transcript text.
 * @param {string} address - The address text to find and replace.
 * @param {number} lat - Latitude.
 * @param {number} lng - Longitude.
 * @returns {string} - Transcription with hyperlinked address.
 */
function hyperlinkAddress(transcript, address, lat, lng) {
  // Use a generic Google Maps URL with coordinates for the link
  if (!address || address.trim() === '' || lat === null || lng === null) {
    return transcript;
  }

  const encodedCoords = `${lat},${lng}`;
  // Link to Google Maps centered on the coordinates
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodedCoords}`;

  try {
      // Use a global, case-insensitive regex to replace all instances of the plain address text
      // Escape special regex characters in the address string
      const escapedAddress = escapeRegExp(address);
      const regex = new RegExp(`\\b${escapedAddress}\\b`, 'gi');
      // Replace with Markdown link using the coordinate-based URL
      return transcript.replace(regex, `[${address}](${mapUrl})`);
  } catch (e) {
      logger.error(`Error creating regex for hyperlinking address "${address}": ${e.message}`);
      return transcript; // Return original transcript if regex fails
  }
}


/**
 * Extracts potential addresses from a transcript using local LLM. (remains the same)
 * @param {string} transcript - The transcript text.
 * @param {string} talkGroupId - The talk group ID associated with the transcript.
 * @param {string} [systemName] - Radio system label (disambiguates overlapping ids).
 * @returns {Promise<string|null>} - Extracted and completed addresses or null if none are found.
 */
async function extractAddress(transcript, talkGroupId, systemName) {
  // Pull per-talkgroup context (county from the imported talk_groups table),
  // preferring the system-scoped entry so overlapping ids resolve correctly.
  const sysKey = String(systemName || '').trim().toLowerCase();
  const meta = (sysKey && TALK_GROUP_META[`${sysKey}:${talkGroupId}`]) || TALK_GROUP_META[talkGroupId] || {};
  const legacyTown = TALK_GROUPS[talkGroupId]; // explicit TALK_GROUP_<id> env override (rare)

  const descriptiveTownForLog = meta.county
    ? `${meta.county}, ${GEOCODING_STATE}`
    : (legacyTown || `${TARGET_COUNTIES.join(' or ')}, ${GEOCODING_STATE}`);
  logger.info(`Extracting address for talk group ID: ${talkGroupId} (${descriptiveTownForLog})`);

  // Town used by the LLM to COMPLETE partial addresses. Only trust an explicit
  // env-provided town; a talkgroup's alpha_tag (e.g. "City PD Dispatch") is a
  // channel name, not a place, so we default to the primary GEOCODING_CITY.
  let townForLLMPrompt = GEOCODING_CITY;
  if (legacyTown &&
      !legacyTown.toLowerCase().includes('county') &&
      !legacyTown.toLowerCase().includes(' or ')) {
    townForLLMPrompt = legacyTown;
  }

  let extractedAddress = await extractAddressWithLLM(transcript, townForLLMPrompt);

  if (!extractedAddress) {
    return null;
  }

  // Clean up potentially messy LLM responses (remains the same)
  extractedAddress = extractedAddress
    .replace(/\([^)]*\)/g, '')
    .replace(/Note:.*$/i, '')
    .replace(/Town Not Specified/gi, GEOCODING_CITY)
    .trim();

  if (extractedAddress.split(',').length > 3 || extractedAddress.includes('\n')) {
    const firstLine = extractedAddress.split('\n')[0].trim();
    const firstPart = extractedAddress.split(',').slice(0, 3).join(',').trim();
    extractedAddress = firstLine.length < firstPart.length ? firstLine : firstPart;
    logger.warn(`Fixed malformed address response from LLM: "${extractedAddress}"`);
  }

  extractedAddress = extractedAddress.replace(/(?<=\d),(?=\d)/g, '');
  extractedAddress = extractedAddress.replace(/(?<=\d)-(?=\d)/g, '');
  extractedAddress = extractedAddress
    .replace(/\bAvenue\b/gi, 'Ave')
    .replace(/\bRoad\b/gi, 'Rd')
    .replace(/\bStreet\b/gi, 'St')
    .replace(/\bDrive\b/gi, 'Dr')
    .replace(/\bBoulevard\b/gi, 'Blvd')
    .replace(/\bLane\b/gi, 'Ln')
    .replace(/\bPlace\b/gi, 'Pl')
    .replace(/\bParkway\b/gi, 'Pkwy')
    .replace(/\bHighway\b/gi, 'Hwy');

  if (!extractedAddress.includes(GEOCODING_STATE)) {
    extractedAddress += `, ${GEOCODING_STATE}`;
  }
  extractedAddress = extractedAddress.trim();

  if (!looksLikePlausibleAddress(extractedAddress)) {
    logger.info(`Rejected implausible LLM address (no street/place structure): "${extractedAddress}"`);
    return null;
  }
  if (!addressAnchoredInTranscript(extractedAddress, transcript)) {
    logger.info(`Rejected LLM address not anchored in transcript (possible hallucination): "${extractedAddress}"`);
    return null;
  }

  // Second-pass LLM sanity check (does this address actually make sense for the
  // transcript?). A house number on a street named in the transcript is already
  // well supported, and the geocoder must then find that same street, so only
  // named places and intersections (where the model is likelier to misread
  // chatter as a location) get the extra AI request.
  const hasHouseNumberAndStreet = /^\s*\d+[a-z]?\s+\S/i.test(addressCorePart(extractedAddress))
    && !/\s(&|and)\s/i.test(addressCorePart(extractedAddress));
  if (!hasHouseNumberAndStreet) {
    const verified = await verifyAddressWithLLM(extractedAddress, transcript);
    if (!verified) {
      return null;
    }
  }

  // LLM extraction log moved inside extractAddressWithLLM
  // logger.info(`Extracted Address for ID ${talkGroupId}: ${extractedAddress}`);
  return extractedAddress;
}


/**
 * Processes a transcript to extract and geocode addresses.
 * Note: Now relies on the updated geocodeAddress and hyperlinkAddress.
 * @param {string} transcript - The transcript text.
 * @param {string} talkGroupId - The talk group ID associated with the transcript.
 * @returns {Promise<{ geocodedResult: { lat: number, lng: number, formatted_address: string, county: string }, linkedTranscript: string } | null>} - Geocoded data and updated transcript or null.
 */
async function processTranscriptAndLink(transcript, talkGroupId) {
  // Verify the AI backend is reachable (only relevant for local Ollama).
  if (AI_PROVIDER.toLowerCase() === 'ollama') {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/version`);
      if (!response.ok) {
        logger.error('Ollama server is not responding properly');
        return null;
      }
    } catch (error) {
      logger.error(`Ollama server connection error: ${error.message}. Make sure Ollama is running at ${OLLAMA_URL}`);
      return null;
    }
  }

  const extractedAddress = await extractAddress(transcript, talkGroupId);

  if (!extractedAddress) {
    logger.info('No valid address extracted from transcript.');
    return null; // Return null if no address extracted
  }

  // Geocode the single extracted address
  const geocodeResult = await geocodeAddress(extractedAddress);

  if (geocodeResult) {
    // Hyperlink the address in the original transcript using the geocoded coordinates
    const linkedTranscript = hyperlinkAddress(transcript, geocodeResult.formatted_address, geocodeResult.lat, geocodeResult.lng);
    return { geocodedResult: geocodeResult, linkedTranscript: linkedTranscript };
  } else {
    logger.warn(`Failed to geocode extracted address: "${extractedAddress}"`);
    return null; // Return null if geocoding failed
  }
}


// Apply settings changed in .env while running (called by bot.js)
function reloadSettings(changedKeys = []) {
  readGeocodingEnv();
  hasGoogleMaps = !!GOOGLE_MAPS_API_KEY;
  hasLocationIQ = !!LOCATIONIQ_API_KEY;
  const previousProvider = geocodingProvider;
  if (changedKeys.some((k) => k === 'GOOGLE_MAPS_API_KEY' || k === 'LOCATIONIQ_API_KEY')) {
    geocodingProvider = null;
    chooseGeocodingProvider();
    if (!geocodingProvider) {
      logger.error('[Geocoding] No geocoding API key is set; keeping the previous provider');
      geocodingProvider = previousProvider;
    }
  }
  TARGET_COUNTIES = String(GEOCODING_TARGET_COUNTIES || '').split(',').map((county) => county.trim()).filter(Boolean);
  COUNTRY_CODES = GEOCODING_COUNTRY;
  TARGET_CITIES = TARGET_CITIES_LIST ? TARGET_CITIES_LIST.split(',').map((city) => city.trim()).filter(Boolean) : [];
  TARGET_COUNTY_SET = new Set(TARGET_COUNTIES.map(normalizeCounty).filter(Boolean));
  TARGET_CITY_SET = new Set(TARGET_CITIES.map(normalizePlace).filter(Boolean));
  if (changedKeys.some((k) => ['GEOCODING_TARGET_COUNTIES', 'GEOCODING_STATE', 'GEOCODING_COUNTRY', 'LOCATIONIQ_API_KEY'].includes(k))) {
    targetViewbox = null; // search area is looked up again on the next geocode
    targetViewboxPromise = null;
  }
  if (changedKeys.some((k) => k.startsWith('TALK_GROUP_'))) {
    readTalkGroupHints();
    Object.keys(TALK_GROUP_META).forEach((id) => { delete TALK_GROUP_META[id]; });
    loadTalkGroups(talkGroupDb);
  }
}

module.exports = {
  reloadSettings,
  loadStreetGazetteer,
  extractAddress,
  geocodeAddress,
  hyperlinkAddress, // Note: Signature changed slightly if used directly
  processTranscriptAndLink, // Renamed for clarity, returns linked text now
  processTranscript: processTranscriptAndLink, // Alias for backward compatibility
  loadTalkGroups
};