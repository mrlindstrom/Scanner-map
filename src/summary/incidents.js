'use strict';

/**
 * Second pass of the dispatch summary: the LLM groups the pre-scored candidate
 * calls (see triage.js) into incidents and rates them against a fixed rubric.
 * Routine incidents are dropped, so the summary shows what actually matters.
 */

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM'];
const SEVERITY_ICON = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡' };
const SEVERITY_COLOR = { CRITICAL: 0xdc2626, HIGH: 0xf97316, MEDIUM: 0xeab308, NONE: 0x3b82f6 };

function stripLinks(text) {
  return String(text || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
}

// "1450 Westheimer Rd, Montrose, Houston, Harris County, Texas, 77006, USA" -> "1450 Westheimer Rd, Montrose"
function shortAddress(address) {
  if (!address) return null;
  const parts = String(address).split(/,(?!\d)/).map((p) => p.trim()).filter(Boolean)
    .filter((p) => !/county|parish|^(usa|united states)$|^\d{5}(-\d{4})?$|^[A-Z]{2}( \d{5})?$/i.test(p)
      && !/^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)$/i.test(p));
  return parts.slice(0, 2).join(', ') || null;
}

function candidateLine(c, timeLabel) {
  const meta = [`id ${c.id}`, timeLabel(c.timestamp), c.talk_group || `TG ${c.talk_group_id}`];
  if (c.address) meta.push(`address: ${shortAddress(c.address)}`);
  if (c.category && String(c.category).toUpperCase() !== 'OTHER') meta.push(`category: ${c.category}`);
  if (c.tones && c.tones.length) meta.push('dispatch tone');
  if (c.keywords && c.keywords.length) meta.push(`keywords: ${c.keywords.join(', ')}`);
  const tags = (c.tags || []).filter((t) => t.tier !== 'routine').slice(0, 4);
  if (tags.length) meta.push(`tags: ${tags.map((t) => `${t.label} (${t.tier})`).join(', ')}`);
  else if ((c.tags || []).length) meta.push(`tags: ${c.tags[0].label} (routine)`);
  return `[${meta.join(' | ')}] "${stripLinks(c.transcription).slice(0, 300)}"`;
}

/**
 * @param {object[]} candidates  scored calls (id, timestamp, talk_group, transcription, address, category, tones, keywords, tags)
 * @param {object} o  { lookbackHours, startLabel, endLabel, totalCalls, maxIncidents, timeLabel(ts) }
 */
// The prompt shares Scanner Map's Ollama context (OLLAMA_NUM_CTX, 8192 tokens by default, roughly
// 4 characters each); keep the calls under this so the reply still fits.
const MAX_CALL_CHARS = 16000;

function buildPrompt(candidates, o) {
  const hours = `${o.lookbackHours} ${o.lookbackHours === 1 ? 'hour' : 'hours'}`;
  // Highest score first: drop the weakest candidates if the list is too long
  const kept = [];
  let chars = 0;
  for (const c of [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0))) {
    const line = candidateLine(c, o.timeLabel);
    if (chars + line.length > (o.maxCallChars || MAX_CALL_CHARS)) break;
    kept.push({ c, line });
    chars += line.length + 1;
  }
  if (o.onTrim && kept.length < candidates.length) o.onTrim(kept.length, candidates.length);
  const lines = kept.sort((a, b) => a.c.timestamp - b.c.timestamp).map((k) => k.line);
  return `You are a senior 911 dispatch supervisor reviewing the last ${hours} of radio traffic (${o.startLabel} to ${o.endLabel}) so on-duty staff can see at a glance what actually matters.

The ${lines.length} calls below were pre-filtered from ${o.totalCalls} transmissions. Obvious chatter was removed, but many remaining calls are still routine. Transcripts are automatic speech-to-text of radio audio: expect misheard words, unit numbers and street names. Use only details that appear in the calls; never invent addresses, injuries or outcomes.

Some calls carry tags: call types matched by keyword in the transcript, with the severity that kind of call usually is. Use them as hints for grouping and rating, not as the answer: a tag can come from a misheard word, a question, or a mention of an earlier call, so rate each incident on what its calls actually say.

Steps:
1. Group calls about the same incident into one incident: same address, the same units, or a dispatch followed by unit updates and outcomes.
2. Rate each incident:
   - CRITICAL: immediate threat to life or a major event. Shooting or stabbing, officer needs help, working structure fire, cardiac arrest or CPR, people trapped, fatal or multi-vehicle major crash, pursuit, hostage or barricade, missing child.
   - HIGH: serious but contained. Assault with injuries, weapon reported, crash with injuries, overdose, unconscious person, gas leak or hazmat, robbery or burglary in progress.
   - MEDIUM: worth knowing but not urgent. Disturbance, theft or burglary report, crash without injuries, fire alarm, suspicious person, welfare check with a stated concern.
   - ROUTINE: everything else. Status updates, acknowledgements, traffic stops, service calls, radio checks, units clearing or returning to service.
3. Return at most ${o.maxIncidents} incidents rated CRITICAL, HIGH or MEDIUM, most severe first, then most recent. Leave ROUTINE incidents out completely. If nothing qualifies, return an empty list; never pad it with routine calls.

Return ONLY this JSON, with no other text:
{
  "summary": "2-3 sentences on the most important activity, naming locations. If it was quiet, say so plainly.",
  "incidents": [
    {
      "severity": "CRITICAL | HIGH | MEDIUM",
      "title": "incident type in at most 6 words, e.g. Gunshot wound victim",
      "location": "address or area as stated in the calls, or null",
      "description": "1 sentence (2 at most): what happened and the latest known status. Keep specifics such as addresses, vehicle descriptions, plates, injuries and units.",
      "call_ids": [ids of every call in this incident, most important first]
    }
  ]
}

Calls, oldest first:
${lines.join('\n')}`;
}

/** Pull the JSON object out of a model reply (tolerates <think> blocks and code fences). */
function extractJson(text) {
  const cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in AI reply');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Validate the model's incidents against the candidates it was given.
 * Unknown ids and ROUTINE incidents are dropped; each call is used once.
 */
function parseIncidents(replyText, candidates, maxIncidents) {
  const parsed = extractJson(replyText);
  const byId = new Map(candidates.map((c) => [String(c.id), c]));
  const used = new Set();
  const incidents = [];
  // Most severe first, so a call listed under two incidents stays with the more serious one
  const rawIncidents = (Array.isArray(parsed.incidents) ? parsed.incidents : [])
    .map((raw) => ({ raw, severity: String(raw.severity || '').toUpperCase().trim() }))
    .filter((r) => SEVERITIES.includes(r.severity))
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  for (const { raw, severity } of rawIncidents) {
    const calls = (Array.isArray(raw.call_ids) ? raw.call_ids : [raw.call_ids])
      .map((id) => String(id).replace(/\D/g, ''))
      .filter((id) => byId.has(id) && !used.has(id))
      .map((id) => byId.get(id));
    if (calls.length === 0) continue;
    calls.forEach((c) => used.add(String(c.id)));
    incidents.push({
      severity,
      title: stripLinks(raw.title || calls[0].category || 'Incident').slice(0, 80),
      location: raw.location && String(raw.location).toLowerCase() !== 'null'
        ? shortAddress(stripLinks(raw.location)).slice(0, 120)
        : shortAddress((calls.find((c) => c.address) || {}).address),
      description: stripLinks(raw.description || calls[0].transcription).slice(0, 600),
      calls,
    });
  }
  incidents.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
    || Math.max(...b.calls.map((c) => c.timestamp)) - Math.max(...a.calls.map((c) => c.timestamp)));
  return {
    summary: stripLinks(parsed.summary || ''),
    incidents: incidents.slice(0, maxIncidents),
  };
}

/** Used when the AI is unavailable: the highest-scoring calls, rated by score. */
function fallbackIncidents(candidates, maxIncidents) {
  const strong = candidates.filter((c) => c.score >= 8).slice(0, maxIncidents);
  return strong.map((c) => ({
    severity: c.score >= 14 ? 'CRITICAL' : c.score >= 10 ? 'HIGH' : 'MEDIUM',
    title: ((c.tags && c.tags[0] && c.tags[0].label) || c.reasons.find((r) => !/^(located|category:|keyword:|routine)/.test(r)) || c.category || 'Priority call').slice(0, 80),
    location: shortAddress(c.address),
    description: stripLinks(c.transcription).slice(0, 300),
    calls: [c],
  }));
}

/** The website ticker's existing highlight format. */
function toHighlights(incidents) {
  return incidents.map((inc) => ({
    id: inc.calls[0].id,
    talk_group: inc.calls[0].talk_group || `TG ${inc.calls[0].talk_group_id}`,
    importance: inc.severity.charAt(0) + inc.severity.slice(1).toLowerCase(),
    description: `${inc.title}${inc.location ? ` (${inc.location})` : ''}: ${inc.description}`,
    timestamp: inc.calls[0].timestamp,
  }));
}

module.exports = {
  SEVERITIES, SEVERITY_ICON, SEVERITY_COLOR, shortAddress, buildPrompt, parseIncidents, fallbackIncidents, toHighlights, extractJson,
};
