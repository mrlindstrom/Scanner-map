'use strict';

/**
 * Text for the per-talkgroup Discord call messages.
 *
 * A message is a rolling log: calls on the same channel within a short window
 * are combined into one embed. Each call renders as its own block:
 *
 *   **Unit-1234** · 21:41:12 · 12s · [▶️ Audio](…)
 *   > transcript, with matched keywords in **bold**
 *   📍 [123 Main St, City](google maps) · [🗺️ Map](scanner map) · 🏷️ Structure Fire
 *   🔔 Two-tone 812Hz + 1516Hz · 🔑 fire, gun
 *
 * Detail lines are only added when there is something to show. The embed's
 * colour reflects the most serious call in it.
 */

const COLORS = {
  emergency: 0xdc2626, // red
  tone: 0xf97316,      // orange
  keyword: 0xeab308,   // amber
  located: 0x3b82f6,   // blue
  normal: 0x22c55e,    // green
};
const SEVERITY = ['normal', 'located', 'keyword', 'tone', 'emergency'];

const MAX_DESCRIPTION = 4096;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bold each matched keyword (whole words, case-insensitive), without nesting bold. */
function highlightKeywords(text, keywords) {
  if (!text || !keywords || keywords.length === 0) return text;
  const sorted = [...new Set(keywords.map((k) => String(k).trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length); // longest first so "shots fired" wins over "shots"
  if (sorted.length === 0) return text;
  const re = new RegExp(`(\\*\\*[^*]+\\*\\*|\\[[^\\]]*\\]\\([^)]*\\))|(${sorted.map(escapeRegExp).join('|')})`, 'gi');
  // Group 1 skips text that is already bold or a link; group 2 is a keyword
  return text.replace(re, (m, skip, kw) => (skip ? m : `**${kw}**`));
}

/** Keep transcript text from breaking the quote/markdown layout. */
function quoteLines(text) {
  return String(text).split(/\r?\n/).map((l) => `> ${l}`).join('\n');
}

function formatDuration(sec) {
  const s = Math.round(Number(sec));
  if (!Number.isFinite(s) || s <= 0) return null;
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function googleMapsUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

function severityOf(entry) {
  const d = entry.details || {};
  if (entry.emergency) return 'emergency';
  if (d.tones && d.tones.length) return 'tone';
  if (d.keywords && d.keywords.length) return 'keyword';
  if (d.lat != null && d.lon != null) return 'located';
  return 'normal';
}

/**
 * @param {object} entry
 *   id, time (unix seconds), durationSec, audioUrl, mapUrl (scanner map link or null),
 *   emergency, encrypted,
 *   speakers: [{ name, text, sq }]   (sq e.g. "2E/0S" or null)
 *   details: { address, lat, lon, category, tones: [string], keywords: [string] }
 */
function renderCall(entry) {
  const d = entry.details || {};
  const speakers = (entry.speakers || []).filter((s) => s.text && s.text.trim());
  const single = speakers.length <= 1;

  const head = [];
  if (entry.emergency) head.push('🚨 **EMERGENCY**');
  if (single) {
    const s = speakers[0] || { name: 'Unknown' };
    head.push(`**${s.name}**${s.sq ? ` _(SQ ${s.sq})_` : ''}`);
  } else {
    head.push(`**${new Set(speakers.map((s) => s.name)).size} radios**`);
  }
  if (entry.time) head.push(`<t:${Math.floor(entry.time)}:T>`);
  const dur = formatDuration(entry.durationSec);
  if (dur) head.push(dur);
  if (entry.encrypted) head.push('🔒 encrypted');
  if (entry.audioUrl) head.push(`[▶️ Audio](${entry.audioUrl})`);

  const lines = [head.join(' · ')];
  if (single) {
    lines.push(quoteLines(highlightKeywords((speakers[0] || {}).text || '', d.keywords)));
  } else {
    for (const s of speakers) {
      lines.push(quoteLines(`**${s.name}**${s.sq ? ` _(SQ ${s.sq})_` : ''}: ${highlightKeywords(s.text, d.keywords)}`));
    }
  }

  const where = [];
  if (d.address && d.lat != null && d.lon != null) {
    where.push(`📍 [${d.address}](${googleMapsUrl(d.lat, d.lon)})`);
    if (entry.mapUrl) where.push(`[🗺️ Map](${entry.mapUrl})`);
  } else if (d.address) {
    where.push(`📍 ${d.address}`);
  }
  if (d.category && String(d.category).toUpperCase() !== 'OTHER') where.push(`🏷️ ${d.category}`);
  if (where.length) lines.push(where.join(' · '));

  const alerts = [];
  if (d.tones && d.tones.length) alerts.push(`🔔 ${d.tones.join(' | ')}`);
  if (d.keywords && d.keywords.length) alerts.push(`🔑 ${[...new Set(d.keywords)].join(', ')}`);
  if (alerts.length) lines.push(alerts.join(' · '));

  return lines.join('\n');
}

/** Description, colour and footer for a message holding these calls (oldest first). */
function renderMessage(entries, { systemName } = {}) {
  const description = entries.map(renderCall).join('\n\n');
  const worst = entries.reduce((acc, e) => {
    const s = severityOf(e);
    return SEVERITY.indexOf(s) > SEVERITY.indexOf(acc) ? s : acc;
  }, 'normal');
  const footer = [systemName, `${entries.length} call${entries.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  return { description, color: COLORS[worst], footer };
}

/** Tone results (from tone_detect.py) as short readable strings. */
function describeTones(detectedType, toneDescriptions) {
  const label = {
    'two-tone': 'Two-tone', 'hi-low': 'Warble', pulsed: 'Pulsed tone', long: 'Long tone',
  }[detectedType] || 'Tone';
  // describeTone() already starts warble descriptions with "warble"
  const parts = (toneDescriptions || []).filter(Boolean).map((p) => String(p).replace(/^warble\s+/i, ''));
  return parts.length ? parts.map((p) => `${label} ${p}`) : [label];
}

module.exports = {
  COLORS, MAX_DESCRIPTION, renderCall, renderMessage, highlightKeywords, describeTones, severityOf,
};
