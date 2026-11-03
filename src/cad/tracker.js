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
];
const PHONETIC = /^(adam|boy|charles|david|edward|frank|george|henry|ida|john|king|lincoln|mary|nora|ocean|paul|queen|robert|sam|tom|union|victor|william|x-ray|young|zebra)$/i;
const TEXT_UNIT_RE = /\b(engine|eng|medic|ambulance|booster|ladder|truck|tower|squad|rescue|battalion|district|tanker|brush|adam|boy|charles|david|edward|frank|george|henry|ida|john|king|lincoln|mary|nora|ocean|paul|queen|robert|sam|tom|union|victor|william|x-ray|young|zebra)[\s-]?(\d{1,3})(?!\d)/gi;
const STREET_STOP = new Set(['street', 'road', 'drive', 'avenue', 'lane', 'boulevard', 'parkway', 'freeway', 'highway',
  'north', 'south', 'east', 'west', 'houston', 'texas', 'county', 'harris', 'court', 'place', 'circle', 'trail', 'spring']);
const STATUS_RE = /\b(show me (out|clear|on ?scene|en ?route|10-?\d+|arriv\w*)|showing out|on ?scene|en ?route|responding|arrived|arriving|clear(ed)?|in service|available|10-?8|10-?97|10-?23|10-?24|10-?7|transport(ing)?|to the hospital|disregard|cancel(led)?|under control|fire (is )?out|code 4|in custody|staging|staged|command|upgrade|downgrade)\b/i;
// Short status phrase -> unit status (checked in this order)
const QUICK_STATUS = [
  [/\b(clear(ed)?( from| of)?( the)? (call|scene)|show me clear|i'?m clear|back in service|in service|10-?8|available|clear on (it|that)|cancel(led)?|disregard)\b/i, 'clear'],
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
const CLOSE_RE = /\b(clear(ed)?( from| of)?( the)? (call|scene)|show me clear|in service|back in service|available|10-?8|disregard|cancel(led)?|no longer needed|10-?24|10-?42|terminat(e|ing) command)\b/i;
const FIRE_RE = /\b(fire|fd|vfd|esd|ems|medic|rescue|north ?comm?|northcom)\b/i;

const DISPATCH_VOICE_HINT = 'North Comm\'s automated dispatch voice reads: unit(s), call type, size, house number, street, "at" cross street, then the time as 4 digits ("Engine 74. Outside fire. Small. 23702 Stargazer PT at Jasmine Terrace Drive 1341" = 23702 Stargazer Point at Jasmine Terrace, dispatched 1:41 PM; 1341 is NOT part of the address). "We were trapped to comm 16" means moved to radio channel 16.';
const PRIORITY_SCALE = 'P1 immediate threat to life (shooting, stabbing, working structure fire, cardiac arrest, trapped person, major crash, pursuit, officer needs help); P2 serious (assault, weapon, crash with injuries, overdose, unconscious, breathing problem, gas leak, robbery or burglary in progress); P3 minor (disturbance, theft report, crash without injuries, alarm, suspicious person, small outside fire, welfare check); P4 routine service (traffic stop, flat tire, wrecker, information).';

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

function createCadTracker({ db, logger, ai, timeLabel, env = process.env, clock = () => Date.now() }) {
  const incidents = new Map(); // open (not closed, not dropped) incidents by id
  const lastDispatch = new Map(); // channel -> { incId, at } of the dispatcher's latest assignment on it
  const consoleRadios = new Map(); // radio id -> when it was found to act like a dispatcher console
  let queue = Promise.resolve();
  let lastReview = Date.now();
  let timer = null;
  let ready = null;

  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { if (e) rej(e); else res(this); }));
  const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r || []))));
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
          try { incidents.set(row.id, fromRow(row)); } catch (e) { logger.warn(`CAD: could not load incident ${row.id}: ${e.message}`); }
        }
        if (incidents.size) logger.info(`CAD: resumed ${incidents.size} open incident(s)`);
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

  async function closeIdle(now) {
    for (const inc of [...incidents.values()]) {
      const limit = IDLE_MIN[inc.priority] * 60;
      if (now - inc.updated > limit) {
        inc.closed = inc.updated + limit; inc.closedBy = 'quiet'; inc.status = 'closed';
        event(inc, inc.closed, `closed after ${IDLE_MIN[inc.priority]} quiet minutes`);
        await save(inc);
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
    return `You maintain a live CAD (computer-aided dispatch) board from scanner radio traffic. Transcripts are automatic speech-to-text: expect misheard words, unit numbers and street names. The dispatcher's stated call type is the best evidence of what an incident is. ${DISPATCH_VOICE_HINT}

Open incidents that might be related:
${cands.length ? cands.map(incLine).join('\n') : '(none)'}
${unitHint ? `\n${unitHint}\n` : ''}
New radio call:
${callHeader(call)} "${call.text.slice(0, 500)}"

Decide:
- "update": the call is about one of the open incidents above (same address, same units, or a clear follow-up such as a unit going en route, on scene, clear, or a size-up). A unit already on an open incident reporting an updated or corrected address is still that incident. Dispatchers often re-broadcast a call (asking for an available unit, adding details, or assigning it): the same kind of call on the same channel within about 15 minutes is that incident, even when the wording differs ("gunshots heard" / "discharge firearm") or the address is missing or garbled, unless the call gives a clearly different address.
- "new": the call dispatches or reports a new incident: it needs a call type AND either a location or a field unit being sent.
- "ignore": chatter with no incident, radio checks, acknowledgements, administrative talk, anything too vague, or a status update you cannot tie to one incident above.

Priority: ${PRIORITY_SCALE}

Return ONLY JSON:
{
  "action": "new | update | ignore",
  "incident_id": number for update, else null,
  "call_type": "short incident type, e.g. Outside fire (small)",
  "priority": "P1 | P2 | P3 | P4",
  "address": "address or location as stated, or null",
  "incident_status": "pending | dispatched | en route | on scene | under control | closed (only when units clear, cancel or disregard the call)",
  "units": [{"unit": "field unit as spoken, e.g. Engine 74, Medic 25, Charles 34 (never the dispatcher, a console, a channel or a talkgroup)", "status": "dispatched | en route | on scene | transporting | clear"}],
  "note": "one short line on what this call adds"
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
- Is this a real incident? Answer keep=false only if its calls show no actual incident (garbled words, chatter, an administrative remark).
- Do any of its calls clearly belong to a different incident? List their times in "wrong_calls".
- Priority from what the calls actually say: ${PRIORITY_SCALE} Lower it when the traffic shows all clear, nothing showing, no injuries, EMS refused, or a false alarm.
- Is it the same incident as one of the others? Same address, an updated address for the same units, or the same kind of call on the same channel within about 15 minutes where one address is missing or garbled (a dispatcher re-broadcasting a call for an available unit). Give that id in merge_with.

Return ONLY JSON:
{"keep": true, "priority": "P1 | P2 | P3 | P4", "priority_reason": "short", "call_type": "short type", "status": "dispatched | en route | on scene | under control | closed", "wrong_calls": ["2:23 PM"], "merge_with": null}`;
  }

  function applyUnits(inc, units, at, aliasUnits, prefixes) {
    const named = [];
    for (const u of Array.isArray(units) ? units : []) {
      const name = String(u.unit || '').trim(); const st = String(u.status || '').toLowerCase();
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
    const call = {
      id: row.id, timestamp: row.timestamp, tg: row.tg_name, agency: row.tg_cat || row.system || 'Unknown',
      tgKey: `${row.system || ''}:${row.talk_group_id}`, text, radios,
      address: row.address ? shortAddress(row.address) : null, lat: row.lat, lon: row.lon,
      fromDispatcher: /fire disp/i.test(row.tg_name) || (firstAlias != null && CONSOLE_RE.test(firstAlias)),
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
    const fieldRadios = radios.filter((r) => !(r.alias && CONSOLE_RE.test(r.alias)) && !isConsoleLike(r.src, call.timestamp)).map((r) => r.src);
    const byRadio = open.filter((inc) => fieldRadios.some((id) => {
      const seen = inc.radios.get(id);
      return seen && call.timestamp - seen.at < RADIO_WINDOW_SEC;
    }));
    call.fieldRadios = fieldRadios;

    // The first field radio to answer a dispatcher's assignment on the same channel is the assigned unit.
    // Acknowledgements ("copy", "10-4 en route") are too short for the AI gate, so take them here.
    const pending = lastDispatch.get(call.tgKey);
    if (pending && fieldRadios.length && !call.fromDispatcher && call.timestamp - pending.at <= ACK_WINDOW_SEC) {
      const target = incidents.get(pending.incId);
      if (target && fieldRadios.every((id) => !target.radios.has(id))) {
        lastDispatch.delete(call.tgKey);
        const named = unitKeys.filter((k) => target.units.has(k));
        for (const id of fieldRadios) target.radios.set(id, { at: call.timestamp, unit: named.length === 1 ? named[0] : null });
        event(target, call.timestamp, `radio ${fieldRadios.join(', ')} answered the dispatch`);
        const ackStatus = quickStatus(text) || 'dispatched';
        if (score < 2.5 && words <= 12) { // a plain acknowledgement: record it and stop
          await applyQuickStatus(target, call, ackStatus === 'clear' ? 'dispatched' : ackStatus, unitKeys);
          debug(`call ${row.id}: acknowledged #${target.id} (radio ${fieldRadios.join(',')})`);
          return;
        }
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

    const d = extractJson(await ai(decidePrompt(call, cands, hint), 600));
    const action = String(d.action || '').toLowerCase();
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

    inc.updated = Math.max(inc.updated, row.timestamp);
    inc.calls.push(call);
    inc.agencies.set(call.agency, agencyKind(`${call.agency} ${call.tg}`));
    for (const r of radios) {
      const a = r.alias && !CONSOLE_RE.test(r.alias) ? agencyForAlias(r.alias, prefixes) : null;
      if (a) inc.agencies.set(a, agencyKind(a));
    }
    inc.tgs.add(call.tgKey); inc.tgNames.add(call.tg);
    let p = PRI.includes(d.priority) ? d.priority : null;
    if (p === 'P1' && !call.fromDispatcher && !inc.calls.some((c) => c.fromDispatcher)) p = 'P2';
    if (p && (action === 'new' || PRI.indexOf(p) < PRI.indexOf(inc.priority))) { // updates only raise; reviews lower
      if (action !== 'new') event(inc, row.timestamp, `priority ${inc.priority} → ${p}`);
      inc.priority = p;
    }
    if (d.call_type && (action === 'new' || inc.type === 'Unknown')) inc.type = String(d.call_type).slice(0, 60);
    if (d.address && String(d.address).toLowerCase() !== 'null' && !inc.address) inc.address = String(d.address).slice(0, 80);
    if (row.lat != null && inc.lat == null) { inc.lat = row.lat; inc.lon = row.lon; }
    for (const t of streetTokens(inc.address || row.address)) inc.tokens.add(t);
    if (action === 'new') event(inc, row.timestamp, `opened: ${inc.type}${inc.address ? ` at ${inc.address}` : ''}`);
    const st = String(d.incident_status || '').toLowerCase();
    if (INC_STATUSES.includes(st) && st !== inc.status) {
      if (st === 'closed') {
        if (CLOSE_RE.test(text)) { inc.closed = row.timestamp; inc.closedBy = 'radio'; inc.status = 'closed'; event(inc, row.timestamp, 'closed on the radio'); }
      } else { event(inc, row.timestamp, `status → ${st}`); inc.status = st; }
    }
    const namedKeys = applyUnits(inc, d.units, row.timestamp, aliasUnits, prefixes);
    if (call.fromDispatcher && !isDispatchVoice && !inc.closed) lastDispatch.set(call.tgKey, { incId: inc.id || null, at: row.timestamp, inc });
    applyRadios(inc, call, namedKeys, st, row.timestamp);
    if (d.note) event(inc, row.timestamp, `note: ${String(d.note).slice(0, 160)}`);
    await save(inc);
    const ld = lastDispatch.get(call.tgKey);
    if (ld && ld.inc === inc) ld.incId = inc.id;
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

  /** A status-only call from a radio or unit already on this incident */
  async function applyQuickStatus(inc, call, status, unitKeys) {
    const at = call.timestamp;
    inc.updated = Math.max(inc.updated, at);
    inc.calls.push(call);
    inc.tgs.add(call.tgKey); inc.tgNames.add(call.tg);
    const unitStatus = status === 'under control' ? 'on scene' : status;
    // Which unit spoke: a named unit on this incident, else the radio's linked unit, else the radio itself
    const named = unitKeys.filter((k) => inc.units.has(k));
    const targets = named.length ? named : (call.fieldRadios || []).map((id) => (inc.radios.get(id) || {}).unit || `R${id}`);
    for (const id of call.fieldRadios || []) {
      const prev = inc.radios.get(id);
      inc.radios.set(id, { at, unit: (prev && prev.unit) || (named.length === 1 ? named[0] : null) });
    }
    for (const key of targets) {
      const u = inc.units.get(key);
      const radioId = key.startsWith('R') && /^R\d+$/.test(key) ? key.slice(1) : null;
      const alias = radioId ? (call.radios.find((r) => r.src === radioId) || {}).alias : null;
      const name = u ? u.name : (alias || (radioId ? `Radio ${radioId}` : key));
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
      return;
    }
    for (const id of ids) {
      const prev = inc.radios.get(id);
      const unitKey = (prev && prev.unit) || `R${id}`;
      inc.radios.set(id, { at, unit: prev ? prev.unit || null : null });
      if (!status) continue;
      const alias = (call.radios.find((r) => r.src === id) || {}).alias;
      const u = inc.units.get(unitKey);
      // A named unit already updated by this call keeps what the AI said
      if (u && u.at === at) continue;
      if (!u || u.status !== status) {
        const name = u ? u.name : (alias || `Radio ${id}`);
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
      const others = [...incidents.values()].filter((o) => o !== inc && (
        [...o.units.keys()].some((k) => inc.units.has(k)) || [...o.tokens].some((t) => inc.tokens.has(t)) || [...o.tgs].some((t) => inc.tgs.has(t)))).slice(0, 5);
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
          inc.removed += inc.calls.length - keep.length; inc.calls = keep; inc.reviewedCalls = keep.length;
        }
      }
      let p = PRI.includes(d.priority) ? d.priority : inc.priority;
      if (p === 'P1' && !inc.calls.some((c) => c.fromDispatcher)) p = 'P2';
      if (p !== inc.priority) { event(inc, now, `priority ${inc.priority} → ${p}${d.priority_reason ? `: ${String(d.priority_reason).slice(0, 120)}` : ''}`); inc.priority = p; }
      if (INC_STATUSES.includes(d.status) && d.status !== 'closed' && d.status !== inc.status) { event(inc, now, `status → ${d.status}`); inc.status = d.status; }
      const twin = incidents.get(Number(d.merge_with));
      if (twin && twin !== inc) {
        // The more serious incident survives, so its type and address name the result ("Gunshots heard", not
        // "Loud noise"); between equals, the older one. It keeps the earlier opened time either way.
        const rank = (x) => PRI.indexOf(x.priority);
        const [keepInc, gone] = rank(twin) !== rank(inc)
          ? (rank(twin) < rank(inc) ? [twin, inc] : [inc, twin])
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
