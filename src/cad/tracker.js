'use strict';

/**
 * CAD incident tracker: turns dispatch radio traffic into live incidents with
 * units, statuses and agencies, for the /cad dashboard.
 *
 * Each finished transcription on a CAD talkgroup goes through:
 *   1. a cheap gate (no AI): the summary's call scoring, status words, or the
 *      automated dispatch voice; status calls with no identifiable unit are skipped
 *   2. matching: a call from a unit already on an open incident goes to that
 *      incident; otherwise nearby/related open incidents are offered
 *   3. one small AI decision (new / update / ignore, type, priority, units)
 * Every 5 minutes each changed incident is reviewed (re-rate, drop junk, remove
 * unrelated calls, merge duplicates), and quiet incidents close on their own.
 * Priority 1 only comes from the dispatcher.
 *
 * Incidents live in the cad_incidents table (one row each, details as JSON);
 * the web server reads that table and pushes changes to browsers.
 */

const triage = require('../summary/triage');
const { tagCall } = require('../summary/callTypes');
const { shortAddress, extractJson } = require('../summary/incidents');
const radioAliases = require('../radio/aliases');

const PRI = ['P1', 'P2', 'P3', 'P4'];
const INC_STATUSES = ['pending', 'dispatched', 'en route', 'on scene', 'under control', 'closed'];
const UNIT_STATUSES = ['dispatched', 'en route', 'on scene', 'transporting', 'clear'];
const IDLE_MIN = { P1: 60, P2: 45, P3: 30, P4: 20 };
const REVIEW_EVERY_MS = 5 * 60 * 1000;
const MAX_CALL_AGE_SEC = 10 * 60; // after an AI pause, skip calls too old to matter
const MAX_CALLS_KEPT = 60;
const ACK_WINDOW_SEC = 45; // the unit that answers a dispatch within this long is the one assigned
const RADIO_WINDOW_SEC = 60 * 60; // a radio's last call on an incident ties its next status to it for an hour
// Incident status the AI read from a radio's own call -> that radio's unit status
const RADIO_STATUS = { dispatched: 'dispatched', 'en route': 'en route', 'on scene': 'on scene', 'under control': 'on scene', closed: 'clear' };

// Dispatcher consoles and channels, never field units
const CONSOLE_RE = /\b(op\s?\d*|north comm|disp(atch)?|console|com\s?\d+)\b|^hc sheriff|^hcc\d/i;
const UNIT_TYPES = [
  [/^(e|eng|engine)$/i, 'E'], [/^(l|ladder|truck|t|tower|tw)$/i, 'L'], [/^(m|medic|ambulance|amb)$/i, 'M'],
  [/^(b|booster)$/i, 'B'], [/^(sq|squad|r|rescue)$/i, 'R'], [/^(bc|battalion|dist|district|d)$/i, 'D'],
  [/^(tk|tanker)$/i, 'TK'], [/^(br|brush)$/i, 'BR'],
  [/^fox$/i, 'FOX'], // HCSO helicopter ("Fox 10"); its own key so it isn't Frank 10
];
const PHONETIC = /^(adam|boy|charles|david|edward|frank|george|henry|ida|john|king|lincoln|mary|nora|ocean|paul|queen|robert|sam|tom|union|victor|william|x-ray|young|zebra)$/i;
const TEXT_UNIT_RE = /\b(fox|engine|eng|medic|ambulance|booster|ladder|truck|tower|squad|rescue|battalion|district|tanker|brush|adam|boy|charles|david|edward|frank|george|henry|ida|john|king|lincoln|mary|nora|ocean|paul|queen|robert|sam|tom|union|victor|william|x-ray|young|zebra)[\s-]?(\d{1,3})(?!\d)/gi;
const STREET_STOP = new Set(['street', 'road', 'drive', 'avenue', 'lane', 'boulevard', 'parkway', 'freeway', 'highway',
  'north', 'south', 'east', 'west', 'houston', 'texas', 'county', 'harris', 'court', 'place', 'circle', 'trail', 'spring',
  'apartments', 'apartment', 'complex', 'building', 'suites', 'estates', 'village', 'center', 'centre', 'plaza', 'address', 'location']);
const STATUS_RE = /\b(show me (out|clear|on ?scene|en ?route|10-?\d+|arriv\w*)|showing out|on ?scene|en ?route|responding|arrived|arriving|clear(ed)?|in service|available|10-?8|10-?97|10-?23|10-?24|10-?7|transport(ing)?|to the hospital|disregard|cancel(led)?|under control|fire (is )?out|code 4|in custody|staging|staged|command|upgrade|downgrade)\b/i;
// Short status phrase -> unit status (checked in this order)
const QUICK_STATUS = [
  [/\b(clear(ed)?( from| of)?( the)? (call|scene)|show me clear|i'?m clear|back in service|in service|10-?8|(?:i'?m|i am|show me|10-?8,?|now|be|back) available|available (?:for calls|in the area)|clear on (it|that)|cancel(led)?|disregard)\b/i, 'clear'],
  [/\b(transport(ing)?|en ?route to (the )?hospital|to the hospital)\b/i, 'transporting'],
  [/\b(under control|code 4|scene (is )?secure)\b/i, 'under control'],
  [/\b(on ?scene|arrived|arriving|10-?97|10-?23|show me (on ?scene|arriv\w*)|show me out (at|with|on|in)|showing out|i'?m (out )?here)\b/i, 'on scene'],
  [/\b(en ?route|responding|10-?76|on (my|the) way|headed that way)\b/i, 'en route'],
];
const STATUS_ORDER = ['pending', 'dispatched', 'en route', 'on scene', 'under control', 'closed'];
function quickStatus(text) {
  for (const [re, st] of QUICK_STATUS) if (re.test(text)) return st;
  return null;
}
// Call-type families: a re-broadcast may be worded differently ("gunshots heard" / "discharge firearm")
const TYPE_FAMILY = {
  Shooting: 'firearm', 'Active shooter': 'firearm', Weapon: 'firearm',
  Disturbance: 'disturbance', Domestic: 'disturbance', Fight: 'disturbance', Assault: 'disturbance', Threats: 'disturbance',
  Crash: 'crash', 'Major crash': 'crash', 'Crash with injuries': 'crash', 'Rollover / ejection': 'crash', 'Hit and run': 'crash', 'Pedestrian struck': 'crash',
  'Working fire': 'fire', 'Structure fire': 'fire', 'Outside fire': 'fire', 'Vehicle fire': 'fire', 'Smoke investigation': 'fire',
  Suspicious: 'suspicious', Trespassing: 'suspicious',
  Burglary: 'theft', Theft: 'theft', Robbery: 'theft',
};
function families(text) {
  return new Set(tagCall(String(text || '')).map((t) => TYPE_FAMILY[t.label] || t.label));
}
// A real street address: house number plus a street-type word ("5014 Hickory Gate"), not "2-month-43"
const STREET_ADDR_RE = /\b\d{2,6}\s+([a-z]+\s+){0,3}(st|street|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pkwy|parkway|fwy|freeway|hwy|highway|trail|trl|circle|cir|place|pl|gate|loop|run|bend|path|ave|avenue|crossing|point|pt|terrace|park)\b/i;
// Dispatch reference numbers ("reference number 188", "ref 319"): different numbers = different calls
function referenceNumbers(text) {
  return new Set([...String(text || '').matchAll(/\b(?:reference|ref)\.?(?:\s+(?:number|no\.?|#))?\s*(\d{2,5})\b/gi)].map((m) => m[1]));
}
/** A location of its own: not missing and not garbled (digits but no street, like "2-month-43"). Area names count. */
const NUMBERED_ROAD_RE = /\b(fm|farm to market|hwy|highway|sh|state highway|us|i|interstate|beltway|spur|loop)[ -]?\d{1,4}\b|\b(fm )?1960\b/i;
function realLocation(addr) {
  const a = String(addr || '').toLowerCase() === 'null' ? '' : String(addr || '');
  if (/^\s*(unknown|not (specified|stated|given)|n\/?a|none|no address|unspecified|location unknown)\b/i.test(a)) return false;
  if (/^\s*(adam|boy|charles|david|edward|frank|george|henry|ida|john|king|lincoln|mary|nora|ocean|paul|queen|robert|sam|tom|union|victor|william|x-ray|young|zebra|engine|medic|ladder|truck|unit|car)[\s-]*\d{1,4}[a-z]?\s*$/i.test(a)) return false;
  if (NUMBERED_ROAD_RE.test(a)) return true;
  if (!a || !/[a-z]{3,}/i.test(a)) return false;
  const garbled = /\d/.test(a) && !STREET_ADDR_RE.test(a) && !/[a-z]{4,}\s+[a-z]{4,}/i.test(a);
  return !garbled;
}
function onlyAckClear(text) {
  const t = String(text || '');
  if (!/\b(that'?s|that is|it'?s) clear\b/i.test(t)) return false;
  const rest = t.replace(/\b(that'?s|that is|it'?s) clear\b/gi, '');
  return !/\b(clear(ed)?( from| of)?( the)? (call|scene)|i'?m clear|we'?re clear|show me clear|in service|10-?8|clear on (it|that|this)|available)\b/i.test(rest);
}
const CLOSE_RE = /\b(clear(ed)?( from| of)?( the)? (call|scene)|show me clear|in service|back in service|(?:i'?m|i am|show me|10-?8,?|now|be|back) available|available (?:for calls|in the area)|10-?8|disregard|cancel(led)?|no longer needed|10-?24|10-?42|terminat(e|ing) command)\b/i;
const FIRE_RE = /\b(fire|fd|vfd|esd|ems|medic|rescue|north ?comm?|northcom)\b/i;

const DISPATCH_VOICE_HINT = 'North Comm\'s automated dispatch voice reads: unit(s), call type, size, house number, street, "at" cross street, then the time as 4 digits ("Engine 74. Outside fire. Small. 23702 Stargazer PT at Jasmine Terrace Drive 1341" = 23702 Stargazer Point at Jasmine Terrace, dispatched 1:41 PM; 1341 is NOT part of the address). "We were trapped to comm 16" means moved to radio channel 16.';
const PRIORITY_SCALE = 'P1 immediate threat to life (shooting, stabbing, working structure fire, cardiac arrest, trapped person, crash with someone trapped, ejected or not breathing, pursuit, officer needs help); P2 serious (assault, weapon, crash with injuries, overdose, unconscious, breathing problem, gas leak, robbery or burglary in progress); P3 minor (disturbance, theft report, crash without injuries, alarm, suspicious person, small outside fire, welfare check); P4 routine service (traffic stop, flat tire, wrecker, information). A runaway or missing teen is P3 (P2 if endangered, suicidal or very young). A fall or injured person is P3 (P2 if seriously hurt or unconscious). A vehicle lockout or someone locked in a car is P4 (P2 if a child or animal is locked inside). An open door, or someone inside a vacant or abandoned house, is P3 (P2 if a burglary is in progress). A dispatched "major accident" is a crash with injuries: P2 (P1 only when someone is trapped, ejected, not breathing, or it is a rollover or fatality). A threat or terroristic threat is P2 (P1 only if a weapon is shown or someone is being attacked now). A unit called out to investigate a death or fatality that already happened is P2. A victim who arrives at a hospital after being shot or stabbed elsewhere is P2 unless the attacker is still active or the scene is unsecured.';

function unitKey(type, num) {
  for (const [re, k] of UNIT_TYPES) if (re.test(type)) return `${k}${num}`;
  if (PHONETIC.test(type)) return `${type[0].toUpperCase()}${num}`;
  return null;
}
function unitsFromText(text) {
  const out = new Map();
  for (const m of String(text).matchAll(TEXT_UNIT_RE)) {
    const k = unitKey(m[1], m[2]);
    if (k) out.set(k, `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`);
  }
  return out;
}
// "17-211, North Freeway" -> "17211 North Freeway" for comparing house numbers
const houseNums = (a) => String(a || '').replace(/(\d)[-,](?=\d)/g, '$1').replace(/,/g, '');
// House numbers only: not road numbers ("FM 1960", "Highway 249", "7-10-FM-1960")
const houseNumbers = (a) => houseNums(a).match(/(?<!\b(?:fm|farm to market|highway|hwy|sh|state highway|route|interstate|i|us|loop|beltway|spur|county road|cr)[\s-]?)(?<![\d-])\b\d{3,6}\b(?![\s-]?(?:fm|feeder))/gi) || [];
const shareHouseNumber = (a, b) => { const x = houseNumbers(a); const y = new Set(houseNumbers(b)); return x.some((n) => y.has(n)); };
function aliasKey(call, id) {
  const alias = ((call.radios || []).find((r) => r.src === id) || {}).alias;
  return alias ? [...unitsFromAliases([alias]).keys()][0] || null : null;
}
function unitsFromAliases(tags) {
  const out = new Map();
  for (const tag of tags) {
    if (CONSOLE_RE.test(tag)) continue;
    const m = tag.match(/\b([a-z]+)\s?-?\s?(\d{1,3})[a-z]?\b/i) || tag.match(/\b([a-z]{1,3})(\d{1,3})[a-z]?\b/i);
    if (!m) continue;
    const k = unitKey(m[1], m[2]);
    if (k) out.set(k, tag);
  }
  return out;
}
const streetTokens = (s) => String(s || '').split(',')[0].toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/)
  .filter((w) => w.length >= 5 && !STREET_STOP.has(w));

/** "CCFD=Cy-Creek FD|SFD=Spring FD" -> [[prefix, agency]] longest prefix first */
function parseAgencyPrefixes(value) {
  return String(value || '').split('|').map((p) => p.split('=').map((s) => s.trim()))
    .filter(([k, v]) => k && v).sort((a, b) => b[0].length - a[0].length);
}
function agencyForAlias(alias, prefixes) {
  const a = String(alias || '').toUpperCase();
  const hit = prefixes.find(([p]) => a.startsWith(p.toUpperCase()));
  return hit ? hit[1] : null;
}
function agencyKind(name) {
  if (/\b(ems|medic|ambulance)\b/i.test(name)) return 'ems';
  if (FIRE_RE.test(name)) return 'fire';
  return 'law';
}

/** CAD_TALK_GROUPS (or the summary set) as an SQL clause on alias t */
function talkGroupFilter(env) {
  const list = String(env.CAD_TALK_GROUPS || env.SUMMARY_TALK_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return null;
  const bare = []; const pairs = [];
  for (const e of list) {
    const i = e.lastIndexOf(':');
    if (i > 0) pairs.push([e.slice(0, i).trim(), e.slice(i + 1).trim()]); else bare.push(e);
  }
  return { bare: new Set(bare), pairs: new Set(pairs.map(([s, id]) => `${s}:${id}`)) };
}

function createCadTracker({ db, logger, ai, timeLabel, env = process.env, clock = () => Date.now(), fixStreets = null }) {
  // Misheard street names corrected against the real street list (geocoding's fixStreets); as heard without one
  const realStreets = (addr) => { try { return fixStreets ? fixStreets(addr).text : addr; } catch { return addr; } };
  const incidents = new Map(); // open (not closed, not dropped) incidents by id
  const lastDispatch = new Map(); // channel -> { incId, at } of the dispatcher's latest assignment on it
  const consoleRadios = new Map(); // radio id -> when it was found to act like a dispatcher console
  // radio id -> { key, name, at }: the unit a radio has identified as this shift ("Edward 13" answering a call-up)
  const radioUnits = new Map();
  const RADIO_UNIT_TTL = 12 * 3600;
  function learnRadio(id, key, name, at, inc) {
    const prev = radioUnits.get(id);
    radioUnits.set(id, { key, name, at });
    if (!prev || prev.key !== key) debug(`radio ${id} is ${name}${prev ? ` (was ${prev.name})` : ''}`);
    if (inc && (!prev || prev.key !== key)) event(inc, at, `radio ${id} is ${name}`);
  }
  const learnedKey = (id, at) => { const r = radioUnits.get(id); return r && at - r.at < RADIO_UNIT_TTL ? r.key : null; };
  const learnedName = (id, at) => { const r = radioUnits.get(id); return r && at - r.at < RADIO_UNIT_TTL ? r.name : null; };
  const radioUnitKey = (call, id) => aliasKey(call, id) || learnedKey(id, call.timestamp);
  // The unit a transmission opens with ("Edward 13", "Edward 13, go ahead", "Charles 14. Go ahead"): at most two words before it
  function openingUnit(text) {
    const t = String(text || '');
    for (const m of t.matchAll(TEXT_UNIT_RE)) {
      if (t.slice(0, m.index).trim().split(/\s+/).filter(Boolean).length > 2) return null;
      const k = unitKey(m[1], m[2]);
      if (k) return { key: k, name: `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}` };
    }
    return null;
  }
  const callups = new Map(); // channel -> { key, name, at }: the unit the dispatcher just called
  let queue = Promise.resolve();
  let lastReview = Date.now();
  let timer = null;
  let ready = null;

  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { if (e) rej(e); else res(this); }));
  const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));

  // The radio that does most of the talking on a channel is its dispatcher console, even without an alias
  // (a fire dispatcher on 25 calls in six hours when the busiest unit has 9). Re-counted every 5 minutes.
  const talkerCache = new Map();
  async function channelConsole(row) {
    const key = `${row.system || ''}:${row.talk_group_id}`;
    const c = talkerCache.get(key);
    if (c && Math.abs(row.timestamp - c.at) < 300) return c.top;
    let top = null;
    try {
      const rows = await all(`SELECT src_list FROM transcriptions WHERE talk_group_id = ? AND timestamp BETWEEN ? AND ?
        AND COALESCE(system, '') = ? AND src_list IS NOT NULL AND src_list <> ''`, [row.talk_group_id, row.timestamp - 6 * 3600, row.timestamp, row.system || '']);
      const n = new Map();
      for (const r of rows) for (const id of new Set(radioAliases.parseSrcList(r.src_list).map((x) => x.src))) n.set(id, (n.get(id) || 0) + 1);
      const [a, b] = [...n.entries()].sort((x, y) => y[1] - x[1]);
      if (a && a[1] >= 15 && a[1] >= 2.5 * ((b && b[1]) || 0)) top = a[0];
    } catch (e) { debug(`channel console count failed: ${e.message}`); }
    if (top && (!c || c.top !== top)) debug(`radio ${top} is the console on ${key} (busiest talker)`);
    talkerCache.set(key, { at: row.timestamp, top });
    return top;
  }
  const debug = (m) => (logger.debug ? logger.debug(`CAD: ${m}`) : null);
  const enabled = () => String(env.CAD_ENABLED ?? 'true').toLowerCase() !== 'false';

  function init() {
    if (!ready) {
      ready = (async () => {
        await run(`CREATE TABLE IF NOT EXISTS cad_incidents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          opened INTEGER, updated INTEGER, closed INTEGER,
          priority TEXT, status TEXT, board TEXT, minor INTEGER DEFAULT 0, dropped INTEGER DEFAULT 0,
          changed INTEGER, data TEXT)`);
        await run('CREATE INDEX IF NOT EXISTS idx_cad_changed ON cad_incidents(changed)');
        await run('CREATE INDEX IF NOT EXISTS idx_cad_open ON cad_incidents(closed, dropped)');
        for (const row of await all('SELECT * FROM cad_incidents WHERE closed IS NULL AND dropped = 0')) {
          try { const inc = fromRow(row); inc.reviewedCalls = -1; incidents.set(row.id, inc); } catch (e) { logger.warn(`CAD: could not load incident ${row.id}: ${e.message}`); }
        }
        if (incidents.size) logger.info(`CAD: resumed ${incidents.size} open incident(s)`);
        // incidents closed for quiet in the last two hours can still be reopened by a re-read pending call
        const since = Math.floor(clock() / 1000) - 2 * 3600;
        for (const row of await all('SELECT * FROM cad_incidents WHERE closed > ? AND dropped = 0', [since])) {
          try { const inc = fromRow(row); if (inc.closedBy === 'quiet') quietClosed.set(row.id, inc); } catch { /* skip */ }
        }
      })().catch((e) => { ready = null; throw e; });
    }
    return ready;
  }

  function fromRow(row) {
    const d = JSON.parse(row.data || '{}');
    return {
      id: row.id, opened: row.opened, updated: row.updated, closed: row.closed, priority: row.priority, status: row.status,
      type: d.type || 'Unknown', address: d.address || null, lat: d.lat ?? null, lon: d.lon ?? null,
      units: new Map(d.units || []), agencies: new Map(d.agencies || []), tgs: new Set(d.tgs || []), tgNames: new Set(d.tgNames || []),
      tokens: new Set(d.tokens || []), radios: new Map(d.radios || []), calls: d.calls || [], events: d.events || [], reviewedCalls: d.reviewedCalls || 0,
      removed: d.removed || 0, closedBy: d.closedBy || null, mergedFrom: d.mergedFrom || [],
    };
  }

  function boardOf(inc) {
    const kinds = new Set([...inc.agencies.values()]);
    return kinds.has('fire') || kinds.has('ems') ? 'fire' : 'law';
  }
  function isMinor(inc) {
    return inc.priority === 'P4' || (inc.calls.length <= 1 && !inc.address);
  }

  async function save(inc, { dropped = false, mergedInto = null } = {}) {
    const data = {
      type: inc.type, address: inc.address, lat: inc.lat, lon: inc.lon,
      units: [...inc.units], agencies: [...inc.agencies], tgs: [...inc.tgs], tgNames: [...inc.tgNames], tokens: [...inc.tokens], radios: [...inc.radios],
      calls: inc.calls.slice(-MAX_CALLS_KEPT), events: inc.events.slice(-150), reviewedCalls: inc.reviewedCalls, removed: inc.removed,
      closedBy: inc.closedBy, mergedFrom: inc.mergedFrom, mergedInto,
    };
    const vals = [inc.opened, inc.updated, inc.closed, inc.priority, inc.status, boardOf(inc), isMinor(inc) ? 1 : 0, dropped ? 1 : 0, Date.now(), JSON.stringify(data)];
    if (inc.id) {
      await run('UPDATE cad_incidents SET opened=?, updated=?, closed=?, priority=?, status=?, board=?, minor=?, dropped=?, changed=?, data=? WHERE id=?', [...vals, inc.id]);
    } else {
      inc.id = (await run('INSERT INTO cad_incidents (opened, updated, closed, priority, status, board, minor, dropped, changed, data) VALUES (?,?,?,?,?,?,?,?,?,?)', vals)).lastID;
    }
    if (inc.closed || dropped) incidents.delete(inc.id); else incidents.set(inc.id, inc);
  }

  const event = (inc, at, text) => inc.events.push({ at, text });

  // Incidents closed for quiet in the last two hours: a pending call the dispatcher reads again reopens its incident
  const quietClosed = new Map();
  async function closeIdle(now) {
    for (const [id, inc] of quietClosed) if (now - inc.closed > 2 * 3600) quietClosed.delete(id);
    for (const inc of [...incidents.values()]) {
      const limit = IDLE_MIN[inc.priority] * 60;
      if (now - inc.updated > limit) {
        inc.closed = inc.updated + limit; inc.closedBy = 'quiet'; inc.status = 'closed';
        event(inc, inc.closed, `closed after ${IDLE_MIN[inc.priority]} quiet minutes`);
        await save(inc);
        quietClosed.set(inc.id, inc);
      }
    }
  }

  function incLine(inc) {
    const u = [...inc.units.values()].map((v) => `${v.name}=${v.status}`).join(', ');
    const last = inc.calls.slice(-2).map((c) => `${timeLabel(c.timestamp)} "${String(c.text).slice(0, 140)}"`).join(' / ');
    return `#${inc.id} ${inc.priority} ${inc.type} | ${inc.address || 'no address'} | channel ${[...inc.tgNames].join(', ')} | status ${inc.status} | units ${u || 'none'} | last: ${last}`;
  }
  function callHeader(c) {
    const radios = (c.radios || []).map((r) => r.alias || `radio ${r.src}`).join(', ');
    return `[${timeLabel(c.timestamp)} | ${c.tg} | ${c.agency}${radios ? ` | radios: ${radios}` : ''}${c.address ? ` | address: ${c.address}` : ''}${c.fromDispatcher ? ' | dispatcher speaking' : ''}]`;
  }

  function decidePrompt(call, cands, unitHint) {
    return `You maintain a live CAD (computer-aided dispatch) board from scanner radio traffic. Transcripts are automatic speech-to-text: expect misheard words, unit numbers and street names. The dispatcher's stated call type is the best evidence of what an incident is. ${DISPATCH_VOICE_HINT} "That's clear" on its own means "understood" (an acknowledgement); a unit is clear only when it says so ("clear from the call", "show me clear", "10-8", "in service").

Open incidents that might be related:
${cands.length ? cands.map(incLine).join('\n') : '(none)'}
${unitHint ? `\n${unitHint}\n` : ''}
New radio call:
${callHeader(call)} "${call.text.slice(0, 500)}"

Decide:
- "update": the call is about one of the open incidents above (same address, same units, or a clear follow-up such as a unit going en route, on scene, clear, or a size-up). A unit already on an open incident reporting an updated or corrected address is still that incident. Dispatchers often re-broadcast a call (asking for an available unit, adding details, or assigning it): the same kind of call on the same channel within about 15 minutes is that incident, even when the wording differs ("gunshots heard" / "discharge firearm") or the address is missing or garbled, unless the call gives a clearly different address.
- "new": the call dispatches or reports a new incident: it needs a call type AND either a location or a field unit being sent.
- "ignore": chatter with no incident, radio checks, acknowledgements, administrative talk, anything too vague, or a status update you cannot tie to one incident above.
- Dispatchers sometimes read several separate calls in one transmission ("Adam 12 for a disturbance, 316 Hill Road. 123B for a runaway, 4103 Silver Ranch"). Then describe the first call in the fields below and list each other call in "other_calls", each with its own type, priority and address. Never mix details of different calls.

Priority: ${PRIORITY_SCALE}

Return ONLY JSON:
{
  "action": "new | update | ignore",
  "incident_id": number for update, else null,
  "call_type": "short incident type, e.g. Outside fire (small)",
  "priority": "P1 | P2 | P3 | P4",
  "address": "where the incident happened, as stated (not a hospital a patient was taken to), or null",
  "incident_status": "pending | dispatched | en route | on scene | under control | closed (only when units clear, cancel or disregard the call)",
  "units": [{"unit": "field unit as spoken, e.g. Engine 74, Medic 25, Charles 34 (never the dispatcher, a console, a channel or a talkgroup)", "status": "dispatched | en route | on scene | transporting | clear"}],
  "note": "one short line on what this call adds",
  "other_calls": [{"call_type": "...", "priority": "P1 | P2 | P3 | P4", "address": "...", "units": ["unit sent to it, if named"]}] or [] when the transmission is about one call
}`;
  }

  function reviewPrompt(inc, others) {
    return `You review one incident on a live CAD board built from scanner radio traffic (automatic speech-to-text, expect misheard words). ${DISPATCH_VOICE_HINT}

Incident #${inc.id}: ${inc.priority} ${inc.type} at ${inc.address || 'unknown'} (status ${inc.status})
Its calls, oldest first:
${inc.calls.map((c) => `${callHeader(c)} "${String(c.text).slice(0, 350)}"`).join('\n')}

Other open incidents that might be the same one:
${others.length ? others.map(incLine).join('\n') : '(none)'}

Check:
- What is it really, and where did it happen? Later calls often correct the first one (a "shooting at the hospital" may be a victim who was shot somewhere else and drove in).
- Is this a real incident? Answer keep=false only if its calls show no actual incident (garbled words, chatter, an administrative remark).
- Do any of its calls clearly belong to a different incident? List their times in "wrong_calls".
- Priority from what the calls actually say: ${PRIORITY_SCALE} Lower it when the traffic shows all clear, nothing showing, no injuries, EMS refused, or a false alarm.
- Is it the same incident as one of the others? Same address, an updated address for the same units, or the same kind of call on the same channel within about 15 minutes where one address is missing or garbled (a dispatcher re-broadcasting a call for an available unit). Give that id in merge_with.

Return ONLY JSON:
{"keep": true, "priority": "P1 | P2 | P3 | P4", "priority_reason": "short", "call_type": "short type, corrected if later calls show what it really is", "location": "where it happened per the calls (not a hospital the patient was taken to), or null", "status": "dispatched | en route | on scene | under control | closed", "wrong_calls": ["2:23 PM"], "merge_with": null}`;
  }

  function applyUnits(inc, units, at, aliasUnits, prefixes, text = '') {
    const named = [];
    const ackOnly = onlyAckClear(text);
    for (const u of Array.isArray(units) ? units : []) {
      const name = String(u.unit || '').trim(); let st = String(u.status || '').toLowerCase();
      if (st === 'clear' && ackOnly) st = 'dispatched'; // "William 72, that's clear" acknowledges, it doesn't clear
      if (!name || !UNIT_STATUSES.includes(st) || CONSOLE_RE.test(name)) continue;
      const m = name.match(/^([a-z-]+)\s?-?\s?(\d{1,3})\b/i);
      const k = m ? unitKey(m[1], m[2]) : null;
      if (!k) continue; // bare numbers and other unidentifiable "units"
      named.push(k);
      const prev = inc.units.get(k);
      const alias = aliasUnits.get(k);
      const display = alias || (prev && prev.name) || name;
      const agency = (alias && agencyForAlias(alias, prefixes)) || (prev && prev.agency) || null;
      if (!prev || prev.status !== st) { inc.units.set(k, { name: display, status: st, at, agency }); event(inc, at, `${display} ${st}`); }
    }
    // A unit whose radio talked on the call is at least involved
    for (const [k, tag] of aliasUnits) {
      if (!inc.units.has(k)) {
        inc.units.set(k, { name: tag, status: 'en route', at, agency: agencyForAlias(tag, prefixes) });
        event(inc, at, `${tag} on the air`);
      }
    }
    return named;
  }

  async function processCall(id) {
    await init();
    const row = await get(`SELECT t.id, t.talk_group_id, t.system, t.timestamp, t.transcription, t.address, t.lat, t.lon, t.category, t.src_list,
        COALESCE((SELECT alpha_tag FROM talk_groups g WHERE g.id = t.talk_group_id AND g.system = COALESCE(t.system,'') LIMIT 1), 'TG ' || t.talk_group_id) AS tg_name,
        COALESCE((SELECT county FROM talk_groups g WHERE g.id = t.talk_group_id AND g.system = COALESCE(t.system,'') LIMIT 1), '') AS tg_cat
      FROM transcriptions t WHERE t.id = ?`, [id]);
    if (!row || !String(row.transcription || '').trim()) return;
    const filter = talkGroupFilter(env);
    if (!filter || !(filter.pairs.has(`${row.system || ''}:${row.talk_group_id}`) || filter.bare.has(String(row.talk_group_id)))) return;
    const nowSec = Math.floor(clock() / 1000);
    if (nowSec - row.timestamp > MAX_CALL_AGE_SEC) return;
    await closeIdle(nowSec);

    const prefixes = parseAgencyPrefixes(env.CAD_AGENCY_PREFIXES);
    const text = String(row.transcription).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
    // One entry per radio: trunk-recorder repeats a radio on each transmission but sends its alias only once
    const radios = [];
    for (const r of await radioAliases.radiosForCall(db, row.system || '', row.src_list)) {
      const seen = radios.find((x) => x.src === r.src);
      if (!seen) radios.push({ src: r.src, alias: r.alias });
      else if (!seen.alias && r.alias) seen.alias = r.alias;
    }
    const firstAlias = radios.length ? radios[0].alias : null;
    const consoleId = await channelConsole(row);
    if (consoleId && radios.some((r) => r.src === consoleId) && !consoleRadios.has(consoleId)) await forgetConsole(consoleId);
    const call = {
      id: row.id, timestamp: row.timestamp, tg: row.tg_name, agency: row.tg_cat || row.system || 'Unknown',
      tgKey: `${row.system || ''}:${row.talk_group_id}`, text, radios,
      address: row.address ? shortAddress(row.address) : null, lat: row.lat, lon: row.lon,
      // the dispatcher's console is anywhere in this recording (it may not be the first voice)
      dispatcherOnAir: /fire disp/i.test(row.tg_name) || radios.some((r) => (r.alias && CONSOLE_RE.test(r.alias)) || r.src === consoleId),
      fromDispatcher: /fire disp/i.test(row.tg_name) || (firstAlias != null && CONSOLE_RE.test(firstAlias)) || (radios.length > 0 && radios[0].src === consoleId),
    };
    const isDispatchVoice = /fire disp/i.test(row.tg_name);
    const aliasUnits = unitsFromAliases(radios.map((r) => r.alias).filter(Boolean));
    const unitKeys = [...new Set([...aliasUnits.keys(), ...unitsFromText(text).keys()])];
    const { score } = triage.scoreCall({ transcription: text, category: row.category, address: row.address, lat: row.lat, lon: row.lon, tones: [], keywords: [] });
    const words = text.split(/\s+/).length;
    const statusy = STATUS_RE.test(text);

    // Field radios on this call (by radio number, alias or not) and the open incidents they have talked on.
    // Police radios rarely send aliases, so the number is what ties "show me on scene" to its call.
    const open = [...incidents.values()];
    for (const r of radios) if (!consoleRadios.has(r.src) && isConsoleLike(r.src, call.timestamp)) await forgetConsole(r.src);
    const fieldRadios = radios.filter((r) => r.src !== consoleId && !(r.alias && CONSOLE_RE.test(r.alias)) && !isConsoleLike(r.src, call.timestamp)).map((r) => r.src);
    const byRadio = open.filter((inc) => fieldRadios.some((id) => {
      const seen = inc.radios.get(id);
      return seen && call.timestamp - seen.at < RADIO_WINDOW_SEC;
    }));
    call.fieldRadios = fieldRadios;
    // A single field radio that opens with a unit name, or answers ("go ahead", "copy") right after the dispatcher
    // called that unit, is that unit. Several field radios in one recording are ambiguous, so they teach nothing.
    {
      const opening = openingUnit(text);
      if (call.fromDispatcher && !isDispatchVoice && opening && fieldRadios.length === 0) callups.set(call.tgKey, { ...opening, at: call.timestamp });
      if (fieldRadios.length === 1 && !isDispatchVoice) {
        const up = callups.get(call.tgKey);
        const answer = !call.fromDispatcher && up && call.timestamp - up.at <= 20 && words <= 8
          && /^\W*(go ahead|copy|10-?4|yes|yeah|affirm|en route|on the way|i'?m here|here)\b/i.test(text) ? up : null;
        const who = opening || answer;
        // a radio with its own alias ("CC 22OIC") already says who it is
        if (who && !(radios.find((r) => r.src === fieldRadios[0]) || {}).alias) learnRadio(fieldRadios[0], who.key, who.name, call.timestamp, null);
        if (opening && !call.fromDispatcher) callups.delete(call.tgKey);
      }
    }

    // The first field radio to answer a dispatcher's assignment on the same channel is the assigned unit.
    // Acknowledgements ("copy", "10-4 en route") are too short for the AI gate, so take them here.
    const pending = lastDispatch.get(call.tgKey);
    if (pending && fieldRadios.length && !call.fromDispatcher && call.timestamp - pending.at <= ACK_WINDOW_SEC) {
      const target = incidents.get(pending.incId);
      if (target && fieldRadios.every((id) => !target.radios.has(id)) && score < 2.5 && words <= 12) {
        lastDispatch.delete(call.tgKey);
        const named = unitKeys.filter((k) => target.units.has(k));
        for (const id of fieldRadios) target.radios.set(id, { at: call.timestamp, unit: named.length === 1 ? named[0] : null });
        event(target, call.timestamp, `radio ${fieldRadios.join(', ')} answered the dispatch`);
        const ackStatus = quickStatus(text) || 'dispatched';
        // a plain acknowledgement: record it and stop
        await applyQuickStatus(target, call, ackStatus === 'clear' ? 'dispatched' : ackStatus, unitKeys);
        debug(`call ${row.id}: acknowledged #${target.id} (radio ${fieldRadios.join(',')})`);
        return;
      }
    }
    if (!(isDispatchVoice || score >= 2.5 || (statusy && (words >= 3 || byRadio.length)))) { debug(`call ${row.id}: skipped (score ${score}, no status words)`); return; }

    const byUnit = open.filter((inc) => unitKeys.some((k) => inc.units.has(k) && inc.units.get(k).status !== 'clear'));
    const known = [...new Set([...byUnit, ...byRadio])];

    // A short status ("show me on scene", "I'm under control", "10-8") from a radio or unit that is on
    // exactly one open incident: apply it directly. No AI guess needed, and it never gets "ignored".
    const quick = quickStatus(text);
    if (quick && known.length === 1 && !isDispatchVoice && words <= 16 && score < 4) {
      await applyQuickStatus(known[0], call, quick, unitKeys);
      debug(`call ${row.id}: status "${quick}" → #${known[0].id} (by ${byRadio.includes(known[0]) ? 'radio' : 'unit'})`);
      return;
    }
    let cands; let hint = '';
    if (known.length && !isDispatchVoice) {
      cands = known.slice(0, 3);
      const why = [
        byUnit.length ? `units ${unitKeys.join(', ')} are assigned to ${byUnit.slice(0, 3).map((c) => `#${c.id}`).join(', ')}` : '',
        byRadio.length ? `the same radio${fieldRadios.length > 1 ? 's' : ''} (${fieldRadios.map((id) => `radio ${id}`).join(', ')}) already talked on ${byRadio.slice(0, 3).map((c) => `#${c.id}`).join(', ')}` : '',
      ].filter(Boolean).join(', and ');
      hint = `On this call, ${why}. Treat it as an update to that incident (a status such as en route, on scene, or clear) unless it clearly dispatches a different, new incident.`;
    } else {
      if (statusy && !unitKeys.length && !row.address && score < 2.5) { debug(`call ${row.id}: skipped (status with no known unit or radio)`); return; } // a "clear" nobody can be tied to
      const toks = streetTokens(row.address || text);
      // A dispatch that sends a unit already working an incident is often more help or a corrected address for it
      if (isDispatchVoice && byUnit.length) {
        hint = `Units on this dispatch (${unitKeys.join(', ')}) are already working ${byUnit.slice(0, 3).map((c) => `#${c.id}`).join(', ')}. If this dispatch adds units to that incident or gives it a corrected address, it is an update; if it sends them to a different incident at another location, it is new.`;
      }
      cands = open.map((inc) => {
        if (isDispatchVoice && byUnit.includes(inc)) return { inc, s: 10 };
        let s = 0;
        if (toks.some((t) => inc.tokens.has(t))) s += 4;
        if (call.lat != null && inc.lat != null && Math.hypot((call.lat - inc.lat) * 111, (call.lon - inc.lon) * 96) < 0.3) s += 5;
        if (inc.tgs.has(call.tgKey) && call.timestamp - inc.updated < 15 * 60) s += 2;
        s += Math.max(0, 1 - (call.timestamp - inc.updated) / 1800);
        return { inc, s };
      }).filter((x) => x.s >= 2).sort((a, b) => b.s - a.s).slice(0, 6).map((x) => x.inc);
    }

    const assignments = (text.match(/\b(for|4) (an? )?[a-z]{3,}/gi) || []).length; // "Adam 12 for a disturbance", "123B for runaway"
    if (call.fromDispatcher && !isDispatchVoice && (families(text).size >= 2 || assignments >= 2) && (text.match(/\b\d{3,6}\b/g) || []).length >= 2) {
      const parts = await splitTransmission(call);
      // Really several calls only when at least two of them have their own, different place
      const placed = parts.filter((x) => !/^\s*(service|unknown|call|other|info(rmation)?|none|n\/?a|follow[- ]?up)\s*$/i.test(String(x.call_type))).filter((x) => realLocation(String(x.address || '')) || /\b\d{3,6}\s+[a-z]{3,}/i.test(String(x.address || '')));
      const places = new Set(placed.map((x) => (String(x.address).match(/\b\d{3,6}\b/) || streetTokens(x.address))[0] || String(x.address).toLowerCase()));
      if (parts.length >= 2 && places.size < 2) debug(`call ${row.id}: split gave ${parts.length} items but ${places.size} distinct place(s); reading it as one call`);
      if (parts.length >= 2 && places.size >= 2) {
        debug(`call ${row.id}: dispatcher read ${parts.length} separate calls`);
        for (const x of parts.slice(0, 5)) await openOtherCall(row, call, x, null);
        return;
      }
    }
    const d = extractJson(await ai(decidePrompt(call, cands, hint), 600));
    let action = String(d.action || '').toLowerCase();
    if (action === 'new' && !isDispatchVoice && call.fromDispatcher) {
      const twin = rebroadcastOf(call, d, open);
      if (twin) { debug(`call ${row.id}: re-broadcast of #${twin.id}, updating it instead of opening a new incident`); action = 'update'; d.incident_id = twin.id; }
    }
    if (action === 'new' && !isDispatchVoice && call.fromDispatcher && quietClosed.size) {

      const old = rebroadcastOf(call, d, [...quietClosed.values()].map((x) => ({ ...x, updated: call.timestamp })));
      const inc = old && quietClosed.get(old.id);
      if (inc && shareHouseNumber(d.address, inc.address)) {
        quietClosed.delete(inc.id);
        inc.closed = null; inc.closedBy = null; inc.status = 'dispatched';
        event(inc, call.timestamp, 'reopened: the dispatcher read the call again');
        incidents.set(inc.id, inc);
        debug(`call ${row.id}: pending call read again, reopening #${inc.id}`);
        action = 'update'; d.incident_id = inc.id;
      }
    }
    // "It's going to be a disturbance..." read by the dispatcher is a new call, not more on a different kind of incident
    if (action === 'update' && call.fromDispatcher && !isDispatchVoice && /\b(it'?s|there'?s|it is|there is) going to be\b/i.test(text)) {
      const target = incidents.get(Number(d.incident_id));
      const callFam = families(`${d.call_type || ''} ${text}`);
      const incFam = target ? families(`${target.type} ${(target.calls[0] || {}).text || ''}`) : new Set();
      if (target && callFam.size && incFam.size && ![...callFam].some((x) => incFam.has(x)) && d.call_type) {
        debug(`call ${row.id}: dispatcher reads a new ${d.call_type}; not adding it to #${target.id} (${target.type})`);
        action = 'new';
      }
    }
    // A holding notice for another area ("Eastside ... holding a minor accident" vs a Westside one) is another call
    if (action === 'update' && isHoldingCall(call)) {
      const target = incidents.get(Number(d.incident_id));
      const area = holdingArea(call);
      const areas = target ? incAreas(target) : new Set();
      if (target && area && areas.size && !areas.has(area)) {
        debug(`call ${row.id}: holding for ${area}, #${target.id} is held for ${[...areas].join('/')}; new incident`);
        action = 'new';
      }
    }
    // An incident opened from an update answer must not borrow the other incident's address
    if (action === 'new' && d.incident_id && d.address && !streetTokens(String(d.address)).some((t) => text.toLowerCase().includes(t))
      && !(String(d.address).match(/\b\d{3,6}\b/g) || []).some((n) => text.includes(n))) d.address = null;
    debug(`call ${row.id}: ${action}${d.incident_id ? ` #${d.incident_id}` : ''} (candidates ${cands.map((c) => `#${c.id}`).join(',') || 'none'}; by unit ${byUnit.map((c) => `#${c.id}`).join(',') || '-'}; by radio ${byRadio.map((c) => `#${c.id}`).join(',') || '-'}; field radios ${fieldRadios.join(',') || '-'})`);
    let inc;
    if (action === 'update') {
      inc = incidents.get(Number(d.incident_id));
      if (!inc) return;
    } else if (action === 'new') {
      inc = { id: null, opened: row.timestamp, updated: row.timestamp, closed: null, priority: 'P3', status: 'pending', type: 'Unknown',
        address: null, lat: null, lon: null, units: new Map(), agencies: new Map(), tgs: new Set(), tgNames: new Set(), tokens: new Set(), radios: new Map(),
        calls: [], events: [], reviewedCalls: 0, removed: 0, closedBy: null, mergedFrom: [] };
    } else return;

    const wasHolding = action === 'update' && isHolding(inc);
    inc.updated = Math.max(inc.updated, row.timestamp);
    inc.calls.push(call);
    inc.agencies.set(call.agency, agencyKind(`${call.agency} ${call.tg}`));
    for (const r of radios) {
      const a = r.alias && !CONSOLE_RE.test(r.alias) ? agencyForAlias(r.alias, prefixes) : null;
      if (a) inc.agencies.set(a, agencyKind(a));
    }
    inc.tgs.add(call.tgKey); inc.tgNames.add(call.tg);
    let p = PRI.includes(d.priority) ? d.priority : null;
    if (p === 'P1' && !call.dispatcherOnAir && !inc.calls.some((c) => c.fromDispatcher || c.dispatcherOnAir)) p = 'P2';
    if (p && (action === 'new' || (PRI.indexOf(p) < PRI.indexOf(inc.priority) && call.fromDispatcher))) { // the dispatcher raises; reviews lower
      if (action !== 'new') event(inc, row.timestamp, `priority ${inc.priority} → ${p}`);
      inc.priority = p;
    }
    if (d.call_type && (action === 'new' || inc.type === 'Unknown')) inc.type = String(d.call_type).slice(0, 60);
    const unitAsAddress = /^\s*(adam|boy|charles|david|edward|frank|george|henry|ida|john|king|lincoln|mary|nora|ocean|paul|queen|robert|sam|tom|union|victor|william|x-ray|young|zebra|engine|medic|ladder|truck|unit|car)[\s-]*\d{1,4}[a-z]?\s*$/i.test(String(d.address || ''));
    if (d.address && !unitAsAddress && String(d.address).toLowerCase() !== 'null' && (!inc.address || (wasHolding && realLocation(d.address)))) {
      if (wasHolding && inc.address) event(inc, row.timestamp, `location → ${String(d.address).slice(0, 80)} (dispatched)`);
      for (const t of streetTokens(d.address)) inc.tokens.add(t); // as heard, so later calls misheard the same way still match
      inc.address = realStreets(String(d.address)).slice(0, 80);
    }
    if (row.lat != null && inc.lat == null) { inc.lat = row.lat; inc.lon = row.lon; }
    for (const t of streetTokens(inc.address || row.address)) inc.tokens.add(t);
    if (action === 'new') event(inc, row.timestamp, `opened: ${inc.type}${inc.address ? ` at ${inc.address}` : ''}`);
    const st = String(d.incident_status || '').toLowerCase();
    if (INC_STATUSES.includes(st) && st !== inc.status) {
      if (st === 'closed') {
        if (CLOSE_RE.test(text)) { inc.closed = row.timestamp; inc.closedBy = 'radio'; inc.status = 'closed'; event(inc, row.timestamp, 'closed on the radio'); }
      } else { event(inc, row.timestamp, `status → ${st}`); inc.status = st; }
    }
    const namedKeys = applyUnits(inc, d.units, row.timestamp, aliasUnits, prefixes, text);
    if (call.fromDispatcher && !isDispatchVoice && !inc.closed) lastDispatch.set(call.tgKey, { incId: inc.id || null, at: row.timestamp, inc });
    applyRadios(inc, call, namedKeys, st, row.timestamp);
    if (d.note) event(inc, row.timestamp, `note: ${String(d.note).slice(0, 160)}`);
    await save(inc);
    const ld = lastDispatch.get(call.tgKey);
    if (ld && ld.inc === inc) ld.incId = inc.id;
    if (Array.isArray(d.other_calls) && d.other_calls.length && (action === 'new' || call.fromDispatcher)) {
      for (const x of d.other_calls.slice(0, 4)) await openOtherCall(row, call, x, inc);
    }
  }

  /** Does this address point at the incident's place? Same house number, or a street word with the same start. */
  function samePlace(addr, inc) {
    const nums = (String(addr || '').match(/\b\d{3,6}\b/g) || []);
    const incText = `${inc.address || ''} ${inc.calls.map((c) => c.text).join(' ')}`;
    if (nums.some((n) => new RegExp(`\\b${n}\\b`).test(String(inc.address || '')))) return true;
    const stems = streetTokens(addr).map((t) => t.slice(0, 5));
    const incStems = new Set([...inc.tokens].map((t) => t.slice(0, 5)));
    return stems.some((t) => incStems.has(t)) && (!nums.length || nums.some((n) => incText.includes(n)));
  }

  /** Ask only: which separate calls does this dispatcher transmission contain? */
  async function splitTransmission(call) {
    const prompt = `A police dispatcher's radio transmission (automatic speech-to-text, expect misheard words). Dispatchers sometimes read several separate pending calls at once, each with a unit, a call type and an address.

"${call.text.slice(0, 600)}"

List each separate call in this transmission. Keep each call's own type and address together; never mix them. Write call types as dispatch would, fixing obvious mishearings ("family servants" = family disturbance). If it is really one call, return a single item.

Priority: ${PRIORITY_SCALE}

Return ONLY JSON: {"calls": [{"call_type": "short type", "priority": "P1 | P2 | P3 | P4", "address": "address exactly as heard, even if garbled (e.g. '2631 successful'), or null", "units": ["unit sent to it, if named"]}]}`;
    try {
      const j = extractJson(await ai(prompt, 400));
      return (Array.isArray(j.calls) ? j.calls : []).filter((x) => x && x.call_type);
    } catch (e) {
      debug(`split failed: ${e.message}`);
      return [];
    }
  }

  /**
   * Another call read in the same transmission: add it to a matching open incident (same kind of call at the
   * same street), or open a new incident for it.
   */
  async function openOtherCall(row, call, x, mainInc) {
    const type = String((x && x.call_type) || '').trim().slice(0, 60);
    const addr = String((x && x.address) || '').trim().slice(0, 80);
    if (!type || (!realLocation(addr) && mainInc)) return; // too vague to open on its own (a split item may still open)
    const fam = families(`${type}`);
    const toks = streetTokens(addr);
    const sameKind = (o) => (!fam.size && realLocation(addr)) || [...families(`${o.type} ${(o.calls[0] || {}).text || ''}`)].some((y) => fam.has(y));
    const existing = [...incidents.values()].find((o) => o !== mainInc && !o.calls.some((c) => c.id === call.id) && sameKind(o)
      && (samePlace(addr, o) || (!realLocation(addr) && !toks.length && o.tgs.has(call.tgKey) && row.timestamp - o.updated < 15 * 60)));
    let inc = existing;
    // a pending call read again after its incident closed for quiet reopens it
    const old = !inc && call.fromDispatcher && fam.size && houseNumbers(addr).length ? [...quietClosed.values()].find((o) => o.tgs.has(call.tgKey) && sameKind(o)
      && shareHouseNumber(addr, o.address) && (samePlace(addr, o) || toks.some((t) => o.tokens.has(t)) || !toks.length)) : null;
    if (old) {
      quietClosed.delete(old.id);
      old.closed = null; old.closedBy = null; old.status = 'dispatched';
      event(old, row.timestamp, 'reopened: the dispatcher read the call again');
      incidents.set(old.id, old);
      debug(`call ${row.id}: pending call read again, reopening #${old.id}`);
      inc = old;
    }
    if (!inc && !mainInc && !realLocation(addr) && !/\b\d{3,6}\s+[a-z]{3,}/i.test(addr) && !['P1', 'P2'].includes(x.priority)) {
      debug(`call ${row.id}: skipped split item "${type}" (no usable address, nothing open matches)`);
      return;
    }
    if (!inc) {
      inc = { id: null, opened: row.timestamp, updated: row.timestamp, closed: null, priority: 'P3', status: 'dispatched', type,
        address: realLocation(addr) || /\b\d{3,6}\s+[a-z]{3,}/i.test(addr) ? realStreets(addr) : null, lat: null, lon: null, units: new Map(), agencies: new Map(), tgs: new Set(), tgNames: new Set(), tokens: new Set(toks), radios: new Map(),
        calls: [], events: [], reviewedCalls: 0, removed: 0, closedBy: null, mergedFrom: [] };
      let p = PRI.includes(x.priority) ? x.priority : 'P3';
      if (p === 'P1' && !call.dispatcherOnAir) p = 'P2';
      inc.priority = p;
      event(inc, row.timestamp, `opened: ${type}${inc.address ? ` at ${inc.address}` : ''} (read with other calls)`);
      event(inc, row.timestamp, 'status → dispatched');
    } else {
      event(inc, row.timestamp, 'mentioned again by dispatch');
    }
    inc.updated = Math.max(inc.updated, row.timestamp);
    if (!inc.calls.some((c) => c.id === call.id)) {
      inc.calls.push({ ...call, text: `${type}${realLocation(addr) ? ` at ${addr}` : ''}`, heard: call.text, part: true });
    }
    inc.agencies.set(call.agency, agencyKind(`${call.agency} ${call.tg}`));
    inc.tgs.add(call.tgKey); inc.tgNames.add(call.tg);
    const prefixes = parseAgencyPrefixes(env.CAD_AGENCY_PREFIXES);
    applyUnits(inc, (Array.isArray(x.units) ? x.units : []).map((u) => ({ unit: typeof u === 'string' ? u : u && u.unit, status: 'dispatched' })), row.timestamp, new Map(), prefixes);
    await save(inc);
    debug(`call ${row.id}: other call in the same transmission → ${existing ? 'updated' : 'opened'} #${inc.id} (${type} at ${addr})`);
  }

  async function forgetConsole(radioId) {
    for (const inc of [...incidents.values()]) {
      if (!inc.radios.has(radioId)) continue;
      inc.radios.delete(radioId);
      if (inc.units.has(`R${radioId}`)) inc.units.delete(`R${radioId}`);
      await save(inc);
    }
    consoleRadios.set(radioId, Math.floor(clock() / 1000));
  }

  /**
   * The open incident this "new" call repeats, if any: same channel, within 15 minutes, same kind of call,
   * and the call gives no real street address of its own (or the same street).
   */
  function rebroadcastOf(call, d, open) {
    const fam = families(`${call.text} ${d.call_type || ''}`);
    if (!fam.size) return null;
    const addr = String(d.address || '').toLowerCase() === 'null' ? '' : String(d.address || '');
    // Its own location counts unless it is missing or garbled (digits but no street: "2-month-43");
    // an area name ("Westside, Fairfield") is a real location and must match
    const garbled = /\d/.test(addr) && !STREET_ADDR_RE.test(addr) && !/[a-z]{4,}\s+[a-z]{4,}/i.test(addr);
    const hasOwnAddress = (!!addr && /[a-z]{3,}/i.test(addr) && !garbled) || STREET_ADDR_RE.test(call.text);
    const myTokens = [...streetTokens(addr), ...streetTokens(call.address || '')];
    const myRefs = referenceNumbers(call.text);
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const matches = open.filter((inc) => {
      // the same house number and street is the same call while the incident is open, however long ago it was read
      const sameAddress = shareHouseNumber(addr, inc.address)
        && (myTokens.some((t) => inc.tokens.has(t)) || norm(addr) === norm(inc.address)); // 'North Freeway' has no distinctive word
      if (!inc.tgs.has(call.tgKey) || (call.timestamp - inc.updated > 15 * 60 && !sameAddress)) return false;
      const incRefs = referenceNumbers(inc.calls.map((c) => c.text).join(' '));
      if (myRefs.size && incRefs.size && ![...myRefs].some((r) => incRefs.has(r))) return false;
      const incFam = families(`${inc.type} ${(inc.calls[0] || {}).text || ''}`);
      if (![...fam].some((x) => incFam.has(x))) return false;
      return !hasOwnAddress || isHolding(inc) || sameAddress || myTokens.some((t) => inc.tokens.has(t));
    });
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * An open incident that this one repeats: same channel, opened within 8 minutes of each other, same kind of
   * call, no conflicting reference numbers, and at least one of the two has no real location of its own
   * (or both name the same street).
   */
  function duplicateOf(inc) {
    const mine = duplicateCandidates(inc);
    if (mine.length !== 1) return null;
    const theirs = duplicateCandidates(mine[0]);
    return theirs.length === 1 && theirs[0] === inc ? mine[0] : null; // each is the other's only match
  }

  // "North Central, holding a runaway": a short dispatcher notice of a pending call (not "holding a knife")
  const HOLDING_RE = /\bholding (an? )?([a-z]+ ){0,2}(call|disturbance|runaway|alarm|fire|theft|burglary|welfare|suspicious|accident|crash|collision|assault|domestic|noise|trespass|check|person|vehicle|mischief|harassment|missing)/i;
  const isHoldingCall = (c) => {
    const t = c.heard || c.text || '';
    return HOLDING_RE.test(t) && !/\bholding (an? |the |his |her |their )?(knife|gun|weapon|firearm|bat|hand|baby|child|door)/i.test(t) && t.split(/\s+/).length < 25;
  };
  const isHolding = (inc) => inc.calls.length > 0 && inc.calls.every(isHoldingCall);
  // The area a holding notice is for: "Eastside Station 2, holding a minor accident" -> "eastside"
  const holdingArea = (c) => {
    if (!isHoldingCall(c)) return null;
    const m = String(c.heard || c.text || '').match(/^\W*([a-z][a-z ]{2,40}?)(?:\s+station\s*\d+)?\s*,?\s+(?:is\s+)?holding\b/i);
    return m ? m[1].toLowerCase().replace(/\s+/g, ' ').trim() : null;
  };
  // Dispatch areas an incident was read for ("Westside, holding ...", "North Central, ...")
  const callArea = (c) => holdingArea(c) || ((String(c.heard || c.text || '').match(/^\W*((?:north|south|east|west)\s?side|north central|central north forest)\b/i) || [])[1] || '')
    .toLowerCase().replace(/\s+/g, ' ').replace(/(north|south|east|west) side/, '$1side') || null;
  const incAreas = (inc) => new Set(inc.calls.map(callArea).filter(Boolean));
  const differentAreas = (a, b) => { const x = incAreas(a); const y = incAreas(b); return x.size > 0 && y.size > 0 && ![...x].some((v) => y.has(v)); };
  const hasOwnPlace = (inc) => realLocation(inc.address) && !isHolding(inc);

  /**
   * A unit's first report from the scene ("Tower 36, one car, major damage"; "we have an entrapment") can come
   * before the tracker knows which call the unit was sent to, so it opens on its own with no address. It belongs
   * to the one open incident of the same kind on the same board that was dispatched within 10 minutes; merged
   * there, its units carry their later traffic to it.
   */
  function unitOrphanOf(inc) {
    if (hasOwnPlace(inc) || /\b\d{3,6}\s+[a-z]{3,}/i.test(String(inc.address || ''))) return null;
    // fire/EMS units report from the scene this way; a law call read with a vague location (and a reference number) is a call of its own
    if (boardOf(inc) !== 'fire' || referenceNumbers(inc.calls.map((c) => c.heard || c.text || '').join(' ')).size) return null;
    const kind = (x) => {
      const f = families(`${x.type} ${x.calls.map((c) => c.heard || c.text || '').join(' ')}`);
      if (f.has('Trapped / extrication')) f.add('crash'); // entrapment on the fire side is a crash rescue
      return f;
    };
    const fam = kind(inc);
    if (!fam.size) return null;
    const board = boardOf(inc);
    const matches = [...incidents.values()].filter((o) => o !== inc && boardOf(o) === board && hasOwnPlace(o)
      && Math.abs(o.opened - inc.opened) <= 10 * 60 && [...kind(o)].some((x) => fam.has(x)));
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * The same call dispatched on both boards (fire/EMS and law), often spelled differently ("Wonderluck" /
   * "Wonderland", "Stubner" / "Stuebner"): the same house number and the same kind of call within 20 minutes,
   * or the same fire unit named on both. Medical calls count as one kind ("unconscious" / "not breathing").
   */
  const MEDICAL_RE = /unconscious|cardiac|breathing|medical|not responding|unresponsive|fall\b|injur|overdose|seizure|stroke|chest|bleeding|sick|diabetic|cpr/i;
  function crossBoardTwin(inc) {
    const kind = (x) => {
      const f = families(`${x.type} ${(x.calls[0] || {}).heard || (x.calls[0] || {}).text || ''}`);
      if (MEDICAL_RE.test(`${x.type} ${[...f].join(' ')}`)) f.add('medical');
      if (f.has('Crash with injuries') || f.has('Trapped / extrication')) f.add('crash');
      return f;
    };
    const fam = kind(inc);
    const board = boardOf(inc);
    // fire apparatus by name ("Engine 46", "E35-A", "TW36-A"), not police phonetic units ("Edward 39" is also E39)
    const fireUnits = (x) => [...x.units].filter(([, u]) => /\b(engine|eng|e|ladder|tower|tw|truck|medic|m|ambulance|rescue|squad|district|battalion|bc|tanker|tk|booster|brush)\s?-?\d/i.test(String(u.name || ''))).map(([k]) => k);
    const mine = new Set(fireUnits(inc));
    const matches = [...incidents.values()].filter((o) => {
      if (o === inc || boardOf(o) === board) return false;
      if (fireUnits(o).some((k) => mine.has(k)) && Math.abs(o.opened - inc.opened) <= 30 * 60) return true;
      return Math.abs(o.opened - inc.opened) <= 20 * 60 && shareHouseNumber(inc.address, o.address) && [...kind(o)].some((x) => fam.has(x));
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function duplicateCandidates(inc) {
    const fam = families(`${inc.type} ${(inc.calls[0] || {}).text || ''}`);
    if (!fam.size) return [];
    const refs = referenceNumbers(inc.calls.map((c) => c.text).join(' '));
    const matches = [...incidents.values()].filter((o) => {
      if (o === inc || ![...o.tgs].some((t) => inc.tgs.has(t)) || Math.abs(o.opened - inc.opened) > 8 * 60) return false; // re-broadcasts come within minutes
      const oFam = families(`${o.type} ${(o.calls[0] || {}).text || ''}`);
      if (![...fam].some((x) => oFam.has(x))) return false;
      const oRefs = referenceNumbers(o.calls.map((c) => c.text).join(' '));
      if (refs.size && oRefs.size && ![...refs].some((r) => oRefs.has(r))) return false;
      const nums = (x) => new Set((String(x.address || '').replace(/,/g, '').match(/\b\d{3,6}\b/g) || []));
      const a = nums(inc); const b = nums(o);
      if (a.size && b.size && ![...a].some((n) => b.has(n))) return false; // different house numbers
      const sameStreet = [...o.tokens].some((t) => inc.tokens.has(t));
      return sameStreet || !hasOwnPlace(inc) || !hasOwnPlace(o);
    });
    return matches;
  }

  /** A status-only call from a radio or unit already on this incident */
  async function applyQuickStatus(inc, call, status, unitKeys) {
    const at = call.timestamp;
    inc.updated = Math.max(inc.updated, at);
    inc.calls.push(call);
    inc.tgs.add(call.tgKey); inc.tgNames.add(call.tg);
    const unitStatus = status === 'under control' ? 'on scene' : status;
    // Which unit spoke: a named unit on this incident, else the radio's linked unit, else the radio itself
    const named = unitKeys.filter((k) => inc.units.has(k));
    const radioKeys = (call.fieldRadios || []).map((id) => (inc.radios.get(id) || {}).unit || radioUnitKey(call, id) || `R${id}`);
    // several radios in one recording: only those already showing as units on this incident (see applyRadios)
    const targets = named.length ? named : radioKeys.length > 1 ? radioKeys.filter((k) => inc.units.has(k)) : radioKeys;
    for (const id of call.fieldRadios || []) {
      const prev = inc.radios.get(id);
      inc.radios.set(id, { at, unit: (prev && prev.unit) || (named.length === 1 ? named[0] : radioUnitKey(call, id)) });
    }
    for (const key of targets) {
      const u = inc.units.get(key);
      const radioId = key.startsWith('R') && /^R\d+$/.test(key) ? key.slice(1) : null;
      const alias = (radioId ? (call.radios.find((r) => r.src === radioId) || {}).alias : (call.radios.find((r) => r.alias && aliasKey(call, r.src) === key) || {}).alias) || null;
      const learned = (call.fieldRadios || []).find((id) => learnedKey(id, at) === key);
      const name = u ? u.name : (alias || (radioId ? `Radio ${radioId}` : (learned && learnedName(learned, at)) || key));
      if (!u || u.status !== unitStatus) {
        inc.units.set(key, { ...(u || {}), name, status: unitStatus, at, ...(radioId ? { radio: radioId } : {}) });
        event(inc, at, `${name} ${unitStatus}`);
      }
    }
    // The incident moves forward with its units; it closes when every unit has cleared on the radio
    const active = [...inc.units.values()].filter((u) => u.status !== 'clear');
    if (status === 'clear' && active.length === 0) {
      inc.closed = at; inc.closedBy = 'radio'; inc.status = 'closed'; event(inc, at, 'closed on the radio (all units clear)');
    } else {
      const next = status === 'clear' ? null : status === 'transporting' ? 'on scene' : status === 'dispatched' ? 'dispatched' : status;
      if (next && STATUS_ORDER.indexOf(next) > STATUS_ORDER.indexOf(inc.status)) { event(inc, at, `status → ${next}`); inc.status = next; }
    }
    await save(inc);
  }

  // A radio that talked on many different open incidents in the last hour is a dispatcher console, not a unit
  function isConsoleLike(radioId, at) {
    const flagged = consoleRadios.get(radioId);
    if (flagged && at - flagged < 2 * 3600) return true; // re-checked every 2 hours, so a busy unit isn't ignored for good
    let n = 0;
    for (const inc of incidents.values()) {
      const seen = inc.radios.get(radioId);
      if (seen && at - seen.at < RADIO_WINDOW_SEC) n++;
    }
    return n >= 4;
  }

  /**
   * Record the call's field radios on the incident and track their status.
   * A radio is linked to a named unit when the call has one field radio and
   * names one unit ("Charles 34, en route"); then that unit carries the status.
   * Otherwise the radio shows as its own unit ("Radio 1215361").
   */
  function applyRadios(inc, call, namedKeys, incStatus, at) {
    const ids = call.fieldRadios || [];
    if (!ids.length) return;
    const status = RADIO_STATUS[incStatus] || null;
    if (ids.length === 1 && namedKeys.length === 1) {
      const key = namedKeys[0];
      const prev = inc.radios.get(ids[0]);
      inc.radios.set(ids[0], { at, unit: key });
      const radioUnit = `R${ids[0]}`;
      if (inc.units.has(radioUnit) && radioUnit !== key) inc.units.delete(radioUnit); // now known by name
      if (!prev || prev.unit !== key) event(inc, at, `radio ${ids[0]} is ${inc.units.get(key)?.name || key}`);
      if (!/^R\d+$/.test(key)) learnRadio(ids[0], key, inc.units.get(key)?.name || key, at, null);
      return;
    }
    // A recording with several field radios mixes transmissions (often other units on other calls),
    // so an unnamed radio there is remembered for matching but not shown as a unit of its own.
    for (const id of ids) {
      const prev = inc.radios.get(id);
      const unitKey = (prev && prev.unit) || radioUnitKey(call, id) || `R${id}`;
      inc.radios.set(id, { at, unit: (prev && prev.unit) || radioUnitKey(call, id) });
      if (!status) continue;
      if (ids.length > 1 && !inc.units.has(unitKey)) continue;
      const alias = (call.radios.find((r) => r.src === id) || {}).alias;
      const u = inc.units.get(unitKey);
      // A named unit already updated by this call keeps what the AI said
      if (u && u.at === at) continue;
      if (!u || u.status !== status) {
        const name = u ? u.name : (alias || learnedName(id, at) || `Radio ${id}`);
        inc.units.set(unitKey, { name, status, at, agency: u ? u.agency : null, radio: id });
        event(inc, at, `${name} ${status}`);
      }
    }
  }

  async function review() {
    await init();
    const now = Math.floor(clock() / 1000);
    for (const inc of [...incidents.values()]) {
      if (!incidents.has(inc.id) || inc.reviewedCalls === inc.calls.length) continue;
      if (inc.calls.every((c) => c.part)) { inc.reviewedCalls = inc.calls.length; continue; } // only split parts so far
      const incFam = families(`${inc.type} ${(inc.calls[0] || {}).text || ''}`);
      const others = [...incidents.values()].filter((o) => o !== inc && (
        [...o.units.keys()].some((k) => inc.units.has(k)) || [...o.tokens].some((t) => inc.tokens.has(t)) || [...o.tgs].some((t) => inc.tgs.has(t))))
        .map((o) => ({ o, same: [...families(`${o.type} ${(o.calls[0] || {}).text || ''}`)].some((x) => incFam.has(x)) }))
        .sort((a, b) => (b.same - a.same) || Math.abs(a.o.opened - inc.opened) - Math.abs(b.o.opened - inc.opened))
        .slice(0, 5).map((x) => x.o);
      const orphanOf = duplicateOf(inc) ? null : unitOrphanOf(inc);
      if (orphanOf) debug(`review: #${inc.id} (no address of its own) is the unit report for #${orphanOf.id}`);
      const crossTwin = duplicateOf(inc) || orphanOf ? null : crossBoardTwin(inc);
      if (crossTwin) debug(`review: #${inc.id} is the other board's side of #${crossTwin.id}`);
      const codeTwin = duplicateOf(inc) || orphanOf || crossTwin;
      if (codeTwin && !orphanOf) debug(`review: #${inc.id} repeats #${codeTwin.id} (same kind of call, same channel, no separate location)`);
      let d;
      try { d = extractJson(await ai(reviewPrompt(inc, others), 400)); } catch (e) { logger.warn(`CAD: review of #${inc.id} failed: ${e.message}`); continue; }
      inc.reviewedCalls = inc.calls.length;
      if (d.keep === false) {
        event(inc, now, 'removed: the review found no real incident');
        await save(inc, { dropped: true });
        continue;
      }
      const wrong = new Set((Array.isArray(d.wrong_calls) ? d.wrong_calls : []).map(String));
      if (wrong.size && inc.calls.length > 1) {
        const keep = inc.calls.filter((c, i) => i === 0 || !wrong.has(timeLabel(c.timestamp)));
        if (keep.length < inc.calls.length) {
          event(inc, now, `removed ${inc.calls.length - keep.length} unrelated call(s)`);
          const gone = inc.calls.filter((c) => !keep.includes(c));
          inc.removed += inc.calls.length - keep.length; inc.calls = keep; inc.reviewedCalls = keep.length;
          // units that came only from the removed calls go with them
          const goneAt = new Set(gone.map((c) => c.timestamp));
          const keptAt = new Set(keep.map((c) => c.timestamp));
          const keptRadios = new Set(keep.flatMap((c) => (c.radios || []).map((r) => r.src)));
          const keptNamed = new Set(keep.flatMap((c) => [...unitsFromText(c.text || '').keys()]));
          for (const [key, u] of [...inc.units]) {
            if (!goneAt.has(u.at) || keptAt.has(u.at) || keptNamed.has(key) || (u.radio && keptRadios.has(u.radio))) continue;
            inc.units.delete(key); event(inc, now, `${u.name} removed with those calls`);
          }
          for (const [id, r] of [...inc.radios]) if (goneAt.has(r.at) && !keptRadios.has(id)) inc.radios.delete(id);
        }
      }
      let p = PRI.includes(d.priority) ? d.priority : inc.priority;
      if (p === 'P1' && !inc.calls.some((c) => c.fromDispatcher || c.dispatcherOnAir)) p = 'P2';
      if (p !== inc.priority) { event(inc, now, `priority ${inc.priority} → ${p}${d.priority_reason ? `: ${String(d.priority_reason).slice(0, 120)}` : ''}`); inc.priority = p; }
      if (INC_STATUSES.includes(d.status) && d.status !== 'closed' && d.status !== inc.status) { event(inc, now, `status → ${d.status}`); inc.status = d.status; }
      // Later traffic can correct what it is and where it happened
      const newType = String(d.call_type || '').trim().slice(0, 60);
      const oldFam = families(inc.type); const newFam = families(newType);
      const reallyDifferent = /^unknown/i.test(inc.type) || (newFam.size > 0 && ![...newFam].some((x) => oldFam.has(x)));
      if (newType && newType.toLowerCase() !== 'x' && newType.toLowerCase() !== String(inc.type).toLowerCase() && reallyDifferent) {
        event(inc, now, `type → ${newType}`); inc.type = newType;
      }
      const loc = String(d.location || '').trim().slice(0, 80);
      const ownText = inc.calls.map((c) => c.heard || c.text || '').join(' ').toLowerCase();
      const locFromOwnCalls = streetTokens(loc).some((t) => ownText.includes(t)) || (loc.match(/\b\d{3,6}\b/g) || []).some((n) => ownText.includes(n));
      if (realLocation(loc) && locFromOwnCalls && loc.toLowerCase() !== String(inc.address || '').toLowerCase()
        && (!realLocation(inc.address) || /hospital|medical cent|emergency room/i.test(inc.address))) {
        event(inc, now, `location → ${loc}`);
        inc.address = realStreets(loc); inc.lat = null; inc.lon = null; // the old pin was for the old location
        for (const t of streetTokens(loc)) inc.tokens.add(t);
        for (const t of streetTokens(inc.address)) inc.tokens.add(t);
      }
      let twin = codeTwin || incidents.get(Number(d.merge_with));
      if (twin && twin !== inc && differentAreas(inc, twin)) {
        debug(`review: refused merging #${inc.id} with #${twin.id} (read for different areas)`);
        twin = null;
      }
      // The AI may merge different kinds of call only when they share a place ("Runaway @ ?" is not "Fatality crash @ ?")
      if (twin && !codeTwin && ![...twin.tokens].some((t) => inc.tokens.has(t))
        && ![...families(`${inc.type}`)].some((x) => families(`${twin.type}`).has(x))) {
        debug(`review: refused merging #${inc.id} with #${twin.id} (different calls at different streets)`);
        twin = null;
      }
      // Different kinds of call at different numbers (house or apartment: "apartment 116" vs "apartment 516") stay apart
      const addrNums = (x) => new Set(String(x.address || '').replace(/,/g, '').match(/\b\d{2,6}\b/g) || []);
      if (twin && !codeTwin && twin !== inc) {
        const a = addrNums(inc); const b = addrNums(twin);
        const fa = families(`${inc.type}`); const fb = families(`${twin.type}`);
        if (a.size && b.size && [...a].some((n) => !b.has(n)) && [...b].some((n) => !a.has(n))
          && fa.size && fb.size && ![...fa].some((x) => fb.has(x))) {
          debug(`review: refused merging #${inc.id} with #${twin.id} (different kinds of call at different numbers)`);
          twin = null;
        }
      }
      if (twin && twin !== inc) {
        // The more serious incident survives, so its type and address name the result ("Gunshots heard", not
        // "Loud noise"); between equals, the older one. It keeps the earlier opened time either way.
        const rank = (x) => PRI.indexOf(x.priority);
        const located = (x) => (hasOwnPlace(x) ? 0 : 1);
        const [keepInc, gone] = rank(twin) !== rank(inc)
          ? (rank(twin) < rank(inc) ? [twin, inc] : [inc, twin])
          : located(twin) !== located(inc)
            ? (located(twin) < located(inc) ? [twin, inc] : [inc, twin])
            : (twin.opened <= inc.opened ? [twin, inc] : [inc, twin]);
        keepInc.opened = Math.min(keepInc.opened, gone.opened);
        if (!keepInc.address && gone.address) keepInc.address = gone.address;
        if (keepInc.lat == null && gone.lat != null) { keepInc.lat = gone.lat; keepInc.lon = gone.lon; }
        keepInc.calls = [...keepInc.calls, ...gone.calls].sort((a, b) => a.timestamp - b.timestamp);
        for (const [k, v] of gone.units) if (!keepInc.units.has(k)) keepInc.units.set(k, v);
        for (const [k, v] of gone.agencies) keepInc.agencies.set(k, v);
        for (const [k, v] of gone.radios) if (!keepInc.radios.has(k) || keepInc.radios.get(k).at < v.at) keepInc.radios.set(k, v);
        gone.tokens.forEach((t) => keepInc.tokens.add(t)); gone.tgs.forEach((t) => keepInc.tgs.add(t)); gone.tgNames.forEach((t) => keepInc.tgNames.add(t));
        if (PRI.indexOf(gone.priority) < PRI.indexOf(keepInc.priority)) keepInc.priority = gone.priority;
        keepInc.updated = Math.max(keepInc.updated, gone.updated);
        keepInc.mergedFrom.push(gone.id);
        event(keepInc, now, `merged #${gone.id} (${gone.type}${gone.address ? ` at ${gone.address}` : ''})`);
        event(gone, now, `merged into #${keepInc.id}`);
        await save(gone, { dropped: true, mergedInto: keepInc.id });
        await save(keepInc);
        continue;
      }
      await save(inc);
    }
  }

  function enqueue(job, label) {
    queue = queue.then(job).catch((e) => logger.warn(`CAD: ${label} failed: ${e.message}`));
    return queue;
  }

  return {
    init,
    /** Called with each finished transcription's id */
    onCall(id) {
      if (!enabled()) return;
      enqueue(() => processCall(id), `call ${id}`);
    },
    start() {
      if (timer) return;
      init().catch((e) => logger.error(`CAD: setup failed: ${e.message}`));
      timer = setInterval(() => {
        if (!enabled()) return;
        enqueue(() => closeIdle(Math.floor(clock() / 1000)), 'idle check');
        if (Date.now() - lastReview >= REVIEW_EVERY_MS) { lastReview = Date.now(); enqueue(review, 'review'); }
      }, 60 * 1000);
      timer.unref?.();
    },
    openCount: () => incidents.size,
    /** Run a review pass now (tests and manual triggers); resolves when queued work is done */
    reviewNow: () => enqueue(review, 'review'),
    idle: () => queue,
  };
}

module.exports = { createCadTracker, unitKey, unitsFromText, unitsFromAliases, parseAgencyPrefixes, agencyForAlias, agencyKind, talkGroupFilter };
