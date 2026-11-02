'use strict';

/**
 * Third pass of the dispatch summary: each incident the first pass picked is
 * checked against the radio traffic around it (same talkgroup a few minutes
 * either side, plus calls naming the same street). The model then re-describes
 * it: a corrected severity with a reason, status, units and a better
 * description. In testing this fixed most over-rated incidents, such as a
 * "shooting" that was a misheard "shooting her out" (sending it over), or an
 * "injury crash" whose follow-ups said minor, all contained.
 *
 * Thinking mode is deliberately not used: with re-rating instructions some
 * models (gemma-4-12B) reason until they hit the token limit and never answer.
 */

const { shortAddress, extractJson } = require('./incidents');

const ALL_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'ROUTINE'];
const STATUSES = ['dispatched', 'en route', 'on scene', 'under control', 'cleared'];
const BEFORE_SEC = 5 * 60;      // same-talkgroup traffic before the first call
const AFTER_SEC = 15 * 60;      // and after the last one (capped at the window end)
const STREET_BEFORE_SEC = 30 * 60;
const MAX_CONTEXT_CALLS = 45;
const MAX_LINE_CHARS = 400;

// Words too common in street names to identify one
const STREET_STOP = new Set(['street', 'road', 'drive', 'avenue', 'lane', 'boulevard', 'parkway', 'freeway', 'highway',
  'north', 'south', 'east', 'west', 'houston', 'texas', 'county', 'harris', 'court', 'place', 'circle', 'trail']);

function streetTokens(location) {
  return String(location || '').split(',')[0].toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 5 && !STREET_STOP.has(w));
}

// An incident may only leave the summary when the traffic says so outright.
// Anything else the model calls ROUTINE stays in as MEDIUM, with its reason shown.
const CLEARS_IT = new RegExp([
  'false alarm', 'accidental', 'cancel', 'disregard', 'unfounded', 'no injur', 'not injured', 'no one (was )?(hurt|injured)',
  '\\bno (shooting|shots|weapon|fire|smoke|crash|accident|emergency)\\b', 'located', '\\bfound\\b', 'testing', 'drill',
  'gone on arrival', '\\bgoa\\b', 'nothing (found|located|showing)', 'all (ok|okay|good)', 'misheard', 'mistranscri',
  'transcription error', 'misunderst', 'not an? (emergency|actual)', 'civil (matter|standby)', 'resolved',
].join('|'), 'i');

/**
 * Calls around an incident, oldest first, with the incident's own calls kept.
 * @param {(sql: string, params: any[]) => Promise<object[]>} all  sqlite query helper
 * @param {object} incident  from incidents.parseIncidents (calls carry id, timestamp, talk_group_id, system)
 * @param {{windowStart: number, windowEnd: number, filter: {sql: string, params: any[]}}} o
 *   filter: the summary talkgroup filter, as an AND clause on alias t
 */
async function buildContext(all, incident, o) {
  const coreIds = new Set(incident.calls.map((c) => String(c.id)));
  const tmin = Math.min(...incident.calls.map((c) => c.timestamp));
  const tmax = Math.max(...incident.calls.map((c) => c.timestamp));
  const select = `SELECT t.id, t.talk_group_id, t.system, t.timestamp, t.transcription, t.address,
      COALESCE(
        (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = COALESCE(t.system,'') LIMIT 1),
        (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id LIMIT 1)) AS talk_group_name
    FROM transcriptions t`;

  const found = [];
  const pairs = new Map(incident.calls.map((c) => [`${c.system || ''}|${c.talk_group_id}`, c]));
  for (const c of pairs.values()) {
    found.push(...await all(`${select} WHERE t.talk_group_id = ? AND COALESCE(t.system,'') = ?
      AND t.timestamp BETWEEN ? AND ? AND t.transcription != ''`,
    [c.talk_group_id, c.system || '', Math.max(o.windowStart, tmin - BEFORE_SEC), Math.min(o.windowEnd, tmax + AFTER_SEC)]));
  }
  const tokens = streetTokens(incident.location || (incident.calls.find((c) => c.address) || {}).address);
  if (tokens.length) {
    found.push(...await all(`${select} WHERE t.timestamp BETWEEN ? AND ? AND t.transcription != ''${o.filter.sql}
      AND (${tokens.map(() => "(lower(t.transcription) LIKE ? OR lower(COALESCE(t.address,'')) LIKE ?)").join(' OR ')})`,
    [Math.max(o.windowStart, tmin - STREET_BEFORE_SEC), o.windowEnd, ...o.filter.params, ...tokens.flatMap((w) => [`%${w}%`, `%${w}%`])]));
  }

  const byId = new Map();
  for (const c of [...incident.calls, ...found]) if (!byId.has(String(c.id))) byId.set(String(c.id), c);
  let calls = [...byId.values()];
  if (calls.length > MAX_CONTEXT_CALLS) {
    const core = calls.filter((c) => coreIds.has(String(c.id)));
    const rest = calls.filter((c) => !coreIds.has(String(c.id)))
      .sort((a, b) => Math.abs(a.timestamp - tmin) - Math.abs(b.timestamp - tmin))
      .slice(0, Math.max(0, MAX_CONTEXT_CALLS - core.length));
    calls = [...core, ...rest];
  }
  calls.sort((a, b) => a.timestamp - b.timestamp);
  return { calls, coreIds };
}

function contextLine(c, isCore, timeLabel) {
  const meta = [`id ${c.id}`, timeLabel(c.timestamp), c.talk_group_name || c.talk_group || `TG ${c.talk_group_id}`];
  if (c.address) meta.push(`address: ${shortAddress(c.address)}`);
  const text = String(c.transcription || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  return `${isCore ? '* ' : '  '}[${meta.join(' | ')}] "${text.slice(0, MAX_LINE_CHARS)}"`;
}

function buildPrompt(incident, context, timeLabel) {
  return `You are a senior 911 dispatch supervisor. A first pass over the last hour of radio traffic flagged the incident below. Your job is to describe it accurately using the surrounding radio traffic.

Flagged incident (first pass):
- severity: ${incident.severity}
- title: ${incident.title}
- location: ${incident.location || 'unknown'}
- description: ${incident.description}

Radio traffic around it, oldest first. Lines starting with * are the calls the first pass grouped into this incident; the others are nearby calls on the same channels or mentioning the same street, and many are about OTHER incidents. Transcripts are automatic speech-to-text of radio audio: expect misheard words, unit numbers and street names.

${context.calls.map((c) => contextLine(c, context.coreIds.has(String(c.id)), timeLabel)).join('\n')}

Rules:
- Use only details stated in the calls. Never invent addresses, injuries, units or outcomes.
- Only use a nearby call if it is clearly about this same incident (same address, same units, or an obvious follow-up).
- The dispatcher's call type (for example "outside fire, small" or "auto-pedestrian, EMS refused") is the best evidence of what the incident is. Weigh it over one odd phrase, which may be misheard: "we were trapped to comm 16" means the units were moved to radio channel 16, not that anyone is trapped.
- Re-rate severity from what the calls actually say, using this scale:
  - CRITICAL: immediate threat to life or a major event. Shooting or stabbing, officer needs help, working structure fire, cardiac arrest or CPR, people trapped, fatal or multi-vehicle major crash, pursuit, hostage or barricade, missing child.
  - HIGH: serious but contained. Assault with injuries, weapon reported, crash with injuries, overdose, unconscious person, gas leak or hazmat, robbery or burglary in progress.
  - MEDIUM: worth knowing but not urgent. Disturbance, theft or burglary report, crash without injuries, fire alarm, suspicious person, welfare check with a stated concern.
  - ROUTINE: not worth a summary entry. Status updates, traffic stops, service calls, false alarms, cancelled calls.
- Lower the severity, or use ROUTINE, only when the traffic shows it: a false alarm, a cancellation, no injuries or EMS refused, or the words were misheard. Raise it only if the calls show it. Otherwise keep the first-pass severity.

Return ONLY this JSON:
{
  "severity": "CRITICAL | HIGH | MEDIUM | ROUTINE",
  "severity_reason": "short reason, especially if it changed",
  "title": "incident type in at most 6 words",
  "location": "address or area as stated, or null",
  "status": "dispatched | en route | on scene | under control | cleared | unknown",
  "units": ["unit identifiers mentioned for this incident"],
  "description": "2 sentences at most: what happened and the latest known status, with specifics (addresses, vehicles, injuries, units).",
  "call_ids": [ids of every call you used for this incident]
}`;
}

function clean(text, max) {
  return String(text || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Merge the model's reply into the incident. Returns the updated incident,
 * or null when the traffic clearly shows it does not belong in the summary.
 * Throws when the reply is not usable, so the caller keeps the original.
 */
function applyReply(replyText, incident, context) {
  const j = extractJson(replyText);
  let severity = String(j.severity || '').toUpperCase().trim();
  if (!ALL_SEVERITIES.includes(severity)) throw new Error(`bad severity "${j.severity}"`);
  const reason = clean(j.severity_reason, 200);
  const description = clean(j.description, 600);
  if (!description) throw new Error('empty description');

  if (severity === 'ROUTINE') {
    if (CLEARS_IT.test(`${reason} ${description} ${j.status || ''}`)) return null;
    severity = 'MEDIUM';
  }

  // Keep the incident's own calls (the first stays the lead for links), add the nearby ones the model used
  const byId = new Map(context.calls.map((c) => [String(c.id), c]));
  const calls = [...incident.calls];
  const seen = new Set(calls.map((c) => String(c.id)));
  for (const raw of Array.isArray(j.call_ids) ? j.call_ids : []) {
    const id = String(raw).replace(/\D/g, '');
    if (byId.has(id) && !seen.has(id)) { seen.add(id); calls.push(byId.get(id)); }
  }

  const status = String(j.status || '').toLowerCase().trim();
  const location = j.location && String(j.location).toLowerCase() !== 'null' ? shortAddress(clean(j.location, 200)) : null;
  return {
    ...incident,
    severity,
    title: clean(j.title, 80) || incident.title,
    location: location ? location.slice(0, 120) : incident.location,
    description,
    status: STATUSES.includes(status) ? status : null,
    units: (Array.isArray(j.units) ? j.units : []).map((u) => clean(u, 24)).filter(Boolean).slice(0, 8),
    severityChange: severity !== incident.severity ? { from: incident.severity, reason } : null,
    calls,
    enriched: true,
  };
}

/**
 * After checking, two first-pass incidents can turn out to be the same one
 * (the model used one's calls for the other). Keep the more severe version
 * and fold the other's calls into it. Input must be sorted most severe first.
 */
function mergeDuplicates(incidents) {
  const out = [];
  for (const inc of incidents) {
    const own = new Set(inc.calls.map((c) => String(c.id)));
    const twin = out.find((o) => o.calls.some((c) => own.has(String(c.id))));
    if (!twin) { out.push(inc); continue; }
    const seen = new Set(twin.calls.map((c) => String(c.id)));
    for (const c of inc.calls) if (!seen.has(String(c.id))) { seen.add(String(c.id)); twin.calls.push(c); }
    twin.mergedCount = (twin.mergedCount || 0) + 1;
  }
  return out;
}

module.exports = { buildContext, buildPrompt, applyReply, mergeDuplicates, streetTokens, CLEARS_IT, MAX_CONTEXT_CALLS };
