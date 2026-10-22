'use strict';

/**
 * Cheap first-pass scoring for the dispatch summary.
 *
 * A busy hour has hundreds of calls, too many to hand an LLM in full, and most
 * are routine radio traffic ("10-4", "en route", "show me clear"). Every call is
 * scored from signals already on hand (tones, keyword matches, the call types
 * its text names (callTypes.js), its map category, a located address), routine
 * chatter is penalized, and only the top candidates go on to the LLM.
 */

const { tagCall } = require('./callTypes');

// Routine traffic. A call that is ONLY this (or very short) is pushed down.
const ROUTINE_ONLY = /^(\W|\b(10-?4|10-?8|10-?7|10-?6|10-?23|10-?97|copy( that)?|copy,? clear|received|roger|affirm(ative)?|negative|ok(ay)?|thanks?( you)?|clear|go ahead|en ?route|on scene|show me|i'?m|we'?re|be advised|standby|stand by|disregard|thank you|yes( sir| ma'?am)?|no( sir| ma'?am)?|\d+|[a-z]+ \d+)\b)+$/i;
const ROUTINE_TERMS = /\b(radio check|test(ing)? (test|1 2 3)|out of service|in service|back in service|available|clear (from|of) (the )?(call|scene)|return(ing)? to (service|station|quarters)|traffic stop|show me (out|clear)|lunch|break|fuel|car wash|subject in custody|1st call|first call)\b/i;

// Category weights (labels come from the web server's categorizer)
const CATEGORY_POINTS = [
  [/PERSON WITH A GUN|ABDUCTION|STRUCTURE FIRE|BUILDING FIRE|HAZMAT|CARBON MONOXIDE/, 6],
  [/ASSAULT|FIGHT|MEDICAL EMERGENCY|UNCONSCIOUS|BREATHING|COLLISION|MVC|INJURED|MISSING|PASSED OUT|CONSCIOUSNESS/, 4],
  [/BURGLARY|STOLEN|DISTURBANCE|RECKLESS|INTOXICATED|ANIMAL BITE|MEDICAL CALL|FIRE ALARM/, 2],
  [/SERVICE CALL|ASSIST|TRAFFIC HAZARD|VEHICLE STOP|OTHER/, 0],
];

function compileExtra(list) {
  return String(list || '')
    .split('|').map((s) => s.trim()).filter(Boolean)
    .map((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
}

/**
 * Score one call. Returns { score, reasons, tags }: reasons are short labels
 * for the log and the fallback summary, tags the call types it names
 * (callTypes.tagCall, plus any extra priority phrases), passed to the LLM.
 * @param {object} call { transcription, category, address, lat, lon, tones: [string], keywords: [string] }
 */
function scoreCall(call, opts = {}) {
  const text = String(call.transcription || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim(); // strip address links
  const reasons = [];
  let score = 0;

  if (call.tones && call.tones.length) { score += 8; reasons.push('dispatch tone'); }
  if (call.keywords && call.keywords.length) { score += 5; reasons.push(`keyword: ${call.keywords.join(', ')}`); }

  const tags = tagCall(text);
  for (const re of opts.extraPriority || []) {
    const m = text.match(re);
    if (m) tags.push({ label: m[0].toLowerCase(), tier: 'high', points: 5, base: false, match: m[0].toLowerCase() });
  }

  // Types that make a call more serious (a weapon, a pursuit, someone trapped) add up
  let termPoints = 0;
  for (const t of tags.filter((x) => !x.base && x.points > 0)) { termPoints += t.points; reasons.push(t.match); }
  score += Math.min(termPoints, 16); // several weak words shouldn't outrank one strong phrase by much

  // The call's main type: the map category or the strongest type named in the
  // text, whichever says more, and a point for each other type it names
  // ("fight" and "intoxicated")
  const baseTags = tags.filter((x) => x.base && x.points > 0).sort((a, b) => b.points - a.points);
  const cat = String(call.category || '').toUpperCase();
  const catHit = cat ? CATEGORY_POINTS.find(([re]) => re.test(cat)) : null;
  const catPoints = catHit ? catHit[1] : 0;
  const typePoints = baseTags.length ? baseTags[0].points : 0;
  if (catPoints > 0 && catPoints >= typePoints) { score += catPoints; reasons.push(`category: ${call.category}`); }
  else if (typePoints > 0) { score += typePoints; reasons.push(`call type: ${baseTags[0].match}`); }
  score += Math.max(0, Math.min(baseTags.length - 1, 2));
  if (call.lat != null && call.lon != null) { score += 2; reasons.push('located'); }

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 4 || ROUTINE_ONLY.test(text)) { score -= 6; reasons.push('routine/short'); }
  if (ROUTINE_TERMS.test(text) && termPoints === 0) { score -= 3; reasons.push('routine'); }
  for (const re of opts.extraBenign || []) {
    if (re.test(text) && termPoints === 0) { score -= 4; reasons.push('benign term'); break; }
  }
  // A little credit for substance, capped so long rambling calls don't win
  score += Math.min(words, 40) / 20;

  return { score: Math.round(score * 10) / 10, reasons, tags: tags.map(({ label, tier }) => ({ label, tier })) };
}

/**
 * Pick the calls worth sending to the LLM, highest score first.
 * Calls at the same address are kept together (an incident often spans several).
 */
function selectCandidates(calls, { max = 50, minScore = 1, extraPriority = [], extraBenign = [] } = {}) {
  const scored = calls.map((c) => ({ ...c, ...scoreCall(c, { extraPriority, extraBenign }) }));
  const picked = scored.filter((c) => c.score >= minScore).sort((a, b) => b.score - a.score).slice(0, max);
  return { candidates: picked, scored };
}

module.exports = { scoreCall, selectCandidates, compileExtra };
