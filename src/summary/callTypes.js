'use strict';

/**
 * Common dispatch call types, matched in any transcript.
 *
 * Every call is tagged with all the types its text names ("shots fired",
 * "chest pains", "wreck"), whether or not it has an address or a map category.
 * The tags feed the dispatch summary twice: triage.js scores calls from them,
 * and the AI sees them next to each call as hints for grouping and rating.
 *
 * Each type: [label, tier, points, pattern, base].
 * - tier: the severity this kind of call usually is (critical, high, medium,
 *   routine), on the same scale as the summary's rubric.
 * - base: the call's main type, the same information as a map category, so
 *   only the strongest one counts fully and a category replaces it. The other
 *   types make a call more serious than its base type (a weapon, a pursuit,
 *   someone trapped) and add up.
 */
const CALL_TYPES = [
  // Life threat / violence
  ['Shooting', 'critical', 10, /\b(shots? fired|shooting|shot (him|her|them|someone|at)|gunshots?( wound)?|gsw|been shot)\b/i],
  ['Active shooter', 'critical', 10, /\bactive (shooter|assailant)\b/i],
  ['Officer needs help', 'critical', 10, /\b(officer down|officer needs (help|assistance)|need (help|backup) now|10-99|signal 99|mayday)\b/i], // not "1099": tax forms come up on records checks
  ['Stabbing', 'critical', 9, /\b(stabb(ed|ing)|cut (his|her) throat)\b/i],
  ['Hostage / barricade', 'critical', 9, /\b(hostage|barricaded)\b/i],
  ['Kidnapping', 'critical', 9, /\b(kidnap(ped|ping)?|abduct(ed|ion)|amber alert)\b/i],
  ['Pursuit', 'critical', 6, /\b(pursuit|(in a|high[- ]speed|vehicle|police|foot) chase|fleeing|evading|bailed out|took off running)\b/i], // not Chase Bank
  ['Weapon', 'high', 5, /\b(armed|with a (gun|knife|weapon)|weapon|firearm|pistol|rifle|knife)\b/i],
  ['Robbery', 'high', 5, /\b(robbery|robbed|carjack(ed|ing)|home invasion)\b/i],
  ['Sexual assault', 'high', 6, /\b(sexual assault|rape|raped|sexually assaulted)\b/i],
  ['Assault', 'high', 4, /\b(assault(ed)?|fight in progress|beat(ing)? (him|her|them) up)\b/i],
  ['Domestic', 'high', 4, /\bdomestic( violence| disturbance| assault)?\b/i],
  ['Child abuse', 'high', 4, /\b(child (abuse|neglect)|abused child|cps)\b/i],
  ['Bomb threat', 'high', 7, /\b(bomb threat|suspicious (package|device)|explosive device)\b/i],
  ['Fight', 'high', 4, /\bfight(ing)?\b/i, true],
  ['Threats', 'medium', 2, /\b(terroristic threat|threaten(ed|ing)|harass(ed|ing|ment))\b/i, true],
  // Fire
  ['Working fire', 'critical', 9, /\b(working (structure )?fire|fully involved|flames (showing|visible)|smoke showing|heavy smoke)\b/i],
  ['Structure fire', 'critical', 8, /\b(structure fire|house fire|apartment fire|building fire|commercial fire|residential fire|second alarm|2nd alarm|third alarm|3rd alarm|(house|home|building|warehouse|apartment|business|garage|structure) (is )?on fire)\b/i],
  ['Explosion', 'critical', 7, /\bexplosion\b/i],
  ['Gas leak / hazmat', 'high', 7, /\b(gas leak(ing)?|hazmat|hazardous materials?|chemical (spill|leak))\b/i],
  ['Gas odor / CO', 'high', 6, /\b(carbon monoxide|co alarm|co detector|odor of gas|smell of gas|gas odor|smell(s|ing)? gas)\b/i, true],
  ['Smoke investigation', 'medium', 3, /\b(smoke in the (area|building|house|home|residence)|odor of smoke|smell of smoke|smoke investigation|smoke coming from|check(ing)? for (a )?fire)\b/i, true],
  ['Vehicle fire', 'medium', 2, /\b(vehicle fire|car fire|truck fire)\b/i],
  ['Outside fire', 'medium', 2, /\b(grass fire|brush fire|dumpster fire|trash fire|outside (small )?fire|small outside fire|transformer fire|(dumpster|trash)( trash)? (and|on) fire|illegal burn(ing)?)\b/i],
  ['Fire alarm', 'medium', 2, /\b(fire alarm|automat(ic|e) alarm|water ?flow alarm)\b/i],
  // Medical / rescue
  ['Cardiac arrest', 'critical', 8, /\b(cardiac arrest|not breathing|cpr|doa|code (blue|black)|full arrest)\b/i],
  ['Unconscious person', 'high', 6, /\b(unresponsive|unconscious)\b/i],
  ['Trapped / extrication', 'critical', 7, /\b(trapped|pinned|entrap(ped|ment)|extrication)\b/i],
  ['Major crash', 'critical', 8, /\b(multiple (vehicles|injuries|patients)|mass casualty|mci|fatal(ity)?|life ?flight|med ?flight)\b/i],
  ['Rollover / ejection', 'high', 6, /\b(ejected|rollover|rolled over)\b/i],
  ['Crash with injuries', 'high', 4, /\b(major|minor) (accident|crash|wreck)|\b(accident|crash|collision|wreck|mvc|mva) with injur/i],
  ['Water rescue', 'critical', 7, /\b(water rescue|swift water|drowning)\b/i],
  ['Missing child', 'critical', 6, /\b(missing (child|juvenile|kid)|lost child)\b/i],
  ['Overdose', 'high', 6, /\b(overdose|od\b|narcan)/i],
  ['Suicide threat', 'high', 6, /\b(suicid(e|al)|(found|attempted) hanging|hanging (himself|herself|themselves))/i],
  ['Choking', 'high', 6, /\bchoking\b/i],
  ['Stroke', 'high', 6, /\bstroke\b/i],
  ['Seizure', 'high', 5, /\bseiz(ure|ing)/i],
  ['Allergic reaction', 'high', 5, /\b(anaphyla|allergic reaction)/i],
  ['Heart problem / chest pain', 'high', 4, /\b(chest pains?|heart problems?|(hard|car|our) problems?,? (chest|chess|chad))/i, true],
  ['Breathing problem', 'high', 4, /\b((breathing|reading|breeding|freezing|rooting) problems?|breathing difficult(y|ies)|difficulty breathing|short(ness)? of breath|trouble breathing)\b/i, true],
  ['Altered / fainting', 'medium', 4, /\b(altered (mental|level)|passed out|faint(ed|ing)|syncop[ey])\b/i, true],
  ['Injured person / bleeding', 'medium', 4, /\b(injured (person|party)|bleeding|hemorrhag|lacerat|(injury|entry|entering) (maceration|moderation|operation)|fracture)/i, true],
  ['Pedestrian struck', 'high', 5, /\b(pedestrian( struck| hit| incident)?|auto[- ]ped|hit by a (car|vehicle|truck))\b/i, true],
  ['Unknown problem / person down', 'medium', 3, /\b(unknown (event|problem|medical)|person down|man down)\b/i, true],
  ['Medical alert', 'medium', 2, /\b(medical alert|life alert)\b/i, true],
  ['Diabetic', 'medium', 4, /\bdiabetic\b/i, true],
  ['Missing person', 'high', 4, /\b(missing (person|minor|teen|adult|female|male|elderly)|runaway)\b/i, true],
  ['Childbirth', 'medium', 3, /\b(in labor|childbirth|giving birth|pregnan(t|cy)|obstetrical)\b/i, true],
  ['Abdominal / back pain', 'medium', 2, /\b(abdominal (pain|name|lane)|stomach pain|back ?pain|backpane)\b/i, true],
  ['Headache', 'medium', 1, /\bheadache\b/i, true],
  ['Sick person', 'medium', 2, /\b((sick|six|tick) (person|prison|call)|general illness|pediatric fever|medical call)\b/i, true],
  ['Check patient', 'medium', 1, /\bcheck ?patien(t|ce)\b/i, true],
  ['Fall', 'medium', 2, /\b(fall victim|fallen|fell)\b|(^|[.,!?]\s*)falls?\s*[.,]/i, true], // "Fall. Ambulance 90", not "fall back\"
  ['Mental health', 'medium', 2, /\b(psychiatric|psych problem|mental health|mental (crisis|patient)|emotionally disturbed)\b/i, true],
  ['Welfare check', 'medium', 2, /\bwelfare (check|concern)\b/i, true],
  // Crime reports and disturbances
  ['Disturbance', 'medium', 2, /\bdisturbance\b/i, true],
  ['Burglary', 'medium', 2, /\b(burglary|burglarized|break(ing)? in(to)?|broke in(to)?)\b/i, true],
  ['Theft', 'medium', 2, /\b(theft|shoplift(er|ing)?|stolen|stole)\b/i, true],
  ['Suspicious', 'medium', 2, /\b(suspicious (person|vehicle|male|female|activity|subject)|prowler)\b/i, true],
  ['Trespassing', 'medium', 2, /\btrespass(er|ers|ing)?\b/i, true],
  ['Vandalism', 'medium', 2, /\b(vandalism|criminal mischief|graffiti)\b/i, true],
  ['Intoxicated', 'medium', 2, /\b(intoxicated|drunk|public intox|alcohol[- ]related)\b/i, true],
  ['Animal bite', 'medium', 2, /\b(animal bite|dog bite|bitten by)\b/i, true],
  // Traffic
  ['Hit and run', 'medium', 3, /\bhit (and|&) run\b/i, true],
  ['Crash', 'medium', 2, /\b(crash|collision|accident|wreck|mvc|mva|(motor|mother|outer|other|water) vehicle incident|motorcycle incident)\b/i, true],
  ['Reckless driver', 'medium', 2, /\b(reckless driv(er|ing)|wrong way driver|driving erratic(ally)?|swerving)\b/i, true],
  ['Wires down', 'medium', 2, /\b((power )?lines? down|wires? down|downed (power )?lines?)\b/i, true],
  ['Elevator rescue', 'medium', 1, /\b((trapped|stuck) in (an|the) elevator|elevator (rescue|entrapment))\b/i, true],
  ['Traffic hazard', 'routine', 1, /\b(traffic hazard|road hazard|debris in the (road|roadway|lane)|stalled vehicle|tree (down|in the road)|flooded (road|roadway|street))\b/i, true],
  ['Loose livestock', 'routine', 1, /\bloose (cattle|cows?|horses?|livestock|goats?)\b/i, true],
  // Routine kinds, tagged so the AI can see them for what they are
  ['Alarm', 'routine', 1, /\b(burglar alarm|alarm call|intrusion alarm|panic alarm|audible alarm)\b/i, true],
  ['Traffic stop', 'routine', 0, /\btraffic stop\b/i, true],
  ['Assist / non-emergency', 'routine', 0, /\b(lift assist|public assist|assist(ed)? (a )?citizen|non-emergency)\b/i, true],
  ['Smoke detector check', 'routine', 0, /\bcheck(ing)? for (a )?smoke detector\b/i, true],
  ['Lockout', 'routine', 0, /\b(lock ?out|locked out)\b/i, true],
  ['Noise complaint', 'routine', 0, /\b(noise complaint|loud (music|party|noise))\b/i, true],
  ['Abandoned vehicle', 'routine', 0, /\babandoned vehicle\b/i, true],
].map(([label, tier, points, re, base = false]) => ({ label, tier, points, re, base }));

const TIER_ORDER = ['critical', 'high', 'medium', 'routine'];

/**
 * All the call types a transcript names, most serious first.
 * @returns {{label, tier, points, base, match}[]}
 */
function tagCall(text) {
  const plain = String(text || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // strip address links
  const tags = [];
  for (const t of CALL_TYPES) {
    const m = plain.match(t.re);
    if (m) tags.push({ label: t.label, tier: t.tier, points: t.points, base: t.base, match: m[0].toLowerCase() });
  }
  // Keep the more specific type: a crash that names its injuries, people
  // stuck in an elevator rather than trapped in a wreck
  const labels = new Set(tags.map((t) => t.label));
  const drop = new Set();
  if (labels.has('Crash with injuries') || labels.has('Major crash') || labels.has('Hit and run')) drop.add('Crash');
  if (labels.has('Elevator rescue')) drop.add('Trapped / extrication');
  const out = tags.filter((t) => !drop.has(t.label));
  return out.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || b.points - a.points);
}

module.exports = { CALL_TYPES, TIER_ORDER, tagCall };
