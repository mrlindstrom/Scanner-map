'use strict';

/**
 * Cheap first-pass scoring for the dispatch summary.
 *
 * A busy hour has hundreds of calls, too many to hand an LLM in full, and most
 * are routine radio traffic ("10-4", "en route", "show me clear"). Every call is
 * scored from signals already on hand (tones, keyword matches, map category or
 * the call type named in the text, a located address, and high-priority radio
 * phrases), routine chatter is
 * penalized, and only the top candidates go on to the LLM.
 */

// [pattern, points]. Phrases a dispatcher or unit would use for a serious call.
const PRIORITY_TERMS = [
  // Life threat / violence
  [/\b(shots? fired|shooting|shot (him|her|them|someone)|gunshot|gsw|been shot)\b/i, 10],
  [/\b(officer down|officer needs (help|assistance)|need (help|backup) now|10-?99|signal 99|mayday)\b/i, 10],
  [/\b(stabb(ed|ing)|cut (his|her) throat|active (shooter|assailant))\b/i, 9],
  [/\b(armed|with a (gun|knife|weapon)|weapon|firearm|pistol|rifle|knife)\b/i, 5],
  [/\b(hostage|barricaded|kidnap(ped|ping)?|abduct(ed|ion)|amber alert)\b/i, 9],
  [/\b(pursuit|chase|fleeing|evading|bailed out|foot pursuit|took off running)\b/i, 6],
  [/\b(assault|robbery|carjack(ed|ing)|home invasion|domestic( violence)?|fight in progress)\b/i, 4],
  // Fire
  [/\b(working (structure )?fire|fully involved|flames (showing|visible)|smoke showing|heavy smoke)\b/i, 9],
  [/\b(structure fire|house fire|apartment fire|building fire|commercial fire|second alarm|2nd alarm|third alarm)\b/i, 8],
  [/\b(explosion|gas leak|hazmat|hazardous materials?|chemical (spill|leak))\b/i, 7],
  [/\b(vehicle fire|car fire|grass fire|brush fire|fire alarm)\b/i, 2],
  // Medical / rescue
  [/\b(cardiac arrest|not breathing|cpr|unresponsive|unconscious|doa|code (blue|black)|full arrest)\b/i, 8],
  [/\b(overdose|od\b|narcan|seizure|stroke|anaphyla|choking|drowning|hanging|suicid)/i, 6],
  [/\b(trapped|pinned|entrap(ped|ment)|extrication|ejected|rollover|roll ?over)\b/i, 7],
  [/\b(major (accident|crash)|multiple (vehicles|injuries|patients)|mass casualty|mci|fatal(ity)?|life flight|med ?flight)\b/i, 8],
  [/\b(missing (child|person|juvenile|elderly)|lost child|water rescue|swift water)\b/i, 6],
  [/\b(major|minor) (accident|crash)|\b(accident|crash|collision|mvc|mva) with injur/i, 4],
  // Urgency markers
  [/\b(emergency traffic|priority (one|1)|code ?3|all units|any unit|units? respond|expedite|step it up)\b/i, 4],
];

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

// Call types as a dispatcher announces them. Only mapped calls get an AI
// category (the web server categorizes after geocoding, and categorizing every
// call would add tens of thousands of Ollama requests a day), so for calls
// without one the strongest call type named in the text stands in for it,
// at about the weights of CATEGORY_POINTS. Crashes score lower than the
// Vehicle Collision category because units mention them long after ("crash
// report", "the crash earlier"); a serious crash still scores from PRIORITY_TERMS.
const CALL_TYPE_TERMS = [
  [/\b(carbon monoxide|co alarm|co detector|odor of gas|smell of gas|gas odor)\b/i, 6],
  [/\b(chest pains?|breathing (problems?|difficult(y|ies))|difficulty breathing|short(ness)? of breath|altered (mental|level)|passed out|faint(ed|ing)|syncope|injured (person|party)|bleeding|hemorrhag|diabetic|fight|missing (minor|teen|adult|female|male)|runaway)/i, 4],
  [/\b(disturbance|burglary|burglar alarm|theft|shoplift(er|ing)?|stolen|suspicious (person|vehicle|male|female|activity)|prowler|trespass(er|ing)?|vandalism|criminal mischief|reckless driv(er|ing)|intoxicated|drunk|animal bite|dog bite|welfare (check|concern)|psychiatric|mental health|sick (person|call)|fall victim|fallen|fell|crash|collision|accident|mvc|mva)\b/i, 2],
];

function callTypePoints(text) {
  for (const [re, pts] of CALL_TYPE_TERMS) {
    const m = text.match(re);
    if (m) return { pts, term: m[0].toLowerCase() };
  }
  return null;
}

function compileExtra(list) {
  return String(list || '')
    .split('|').map((s) => s.trim()).filter(Boolean)
    .map((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
}

/**
 * Score one call. Returns { score, reasons } where reasons are short labels
 * that are passed to the LLM and logged.
 * @param {object} call { transcription, category, address, lat, lon, tones: [string], keywords: [string] }
 */
function scoreCall(call, opts = {}) {
  const text = String(call.transcription || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim(); // strip address links
  const reasons = [];
  let score = 0;

  if (call.tones && call.tones.length) { score += 8; reasons.push('dispatch tone'); }
  if (call.keywords && call.keywords.length) { score += 5; reasons.push(`keyword: ${call.keywords.join(', ')}`); }

  let termPoints = 0;
  for (const [re, pts] of PRIORITY_TERMS) {
    const m = text.match(re);
    if (m) { termPoints += pts; reasons.push(m[0].toLowerCase()); }
  }
  for (const re of opts.extraPriority || []) {
    const m = text.match(re);
    if (m) { termPoints += 5; reasons.push(m[0].toLowerCase()); }
  }
  score += Math.min(termPoints, 16); // several weak words shouldn't outrank one strong phrase by much

  const cat = String(call.category || '').toUpperCase();
  if (cat) {
    const hit = CATEGORY_POINTS.find(([re]) => re.test(cat));
    if (hit && hit[1] > 0) { score += hit[1]; reasons.push(`category: ${call.category}`); }
  } else {
    const type = callTypePoints(text);
    if (type) { score += type.pts; reasons.push(`call type: ${type.term}`); }
  }
  if (call.lat != null && call.lon != null) { score += 2; reasons.push('located'); }

  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 4 || ROUTINE_ONLY.test(text)) { score -= 6; reasons.push('routine/short'); }
  if (ROUTINE_TERMS.test(text) && termPoints === 0) { score -= 3; reasons.push('routine'); }
  for (const re of opts.extraBenign || []) {
    if (re.test(text) && termPoints === 0) { score -= 4; reasons.push('benign term'); break; }
  }
  // A little credit for substance, capped so long rambling calls don't win
  score += Math.min(words, 40) / 20;

  return { score: Math.round(score * 10) / 10, reasons };
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

module.exports = { scoreCall, selectCandidates, compileExtra, PRIORITY_TERMS, CALL_TYPE_TERMS };
