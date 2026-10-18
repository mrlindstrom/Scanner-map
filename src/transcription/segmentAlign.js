'use strict';

/**
 * Line up merged-call speaker changes with the actual recording.
 *
 * Three kinds of per-source `pos` values arrive:
 *
 *   - Fractional audio positions (Trunk Recorder, and TrunkRecorder Pro if it
 *     sends sub-second positions): seconds into the saved file. They are
 *     already close, so each change is only nudged to a silence within
 *     NUDGE_WINDOW of it, and kept where it is otherwise.
 *   - Whole-second audio positions (TrunkRecorder Pro today): seconds into the
 *     saved file, but whole seconds. In a sample of 250 calls speech started
 *     between ~0.75s before and ~1.5s after `pos` (most often ~0.3s after), and
 *     7% of changes shared a second with the one before (a turn under a
 *     second). Each change is placed on its own silence in that window, in
 *     order (see alignWholeSeconds), or on its estimated start when none fits.
 *   - Wall-clock positions (older TrunkRecorder Pro): whole seconds since the
 *     call was granted, counting the dead air the recording leaves out, so the
 *     further into a call, the later `pos` runs ahead of the audio (often past
 *     its end). Each transmission does start with a short silence, though, so
 *     every speaker change is snapped to a real silence:
 *
 *   - silences are found with ffmpeg's silencedetect;
 *   - boundaries are assigned to silences in order (dynamic programming),
 *     preferring the assignment whose drift (pos - audio time) grows the least,
 *     since dead air between transmissions is usually short;
 *   - a boundary with no plausible silence (a key-up too short to leave one)
 *     is skipped, so that transmission stays with the previous speaker.
 */

const { spawn } = require('child_process');

function envNum(name, fallback) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function loadConfig(env = process.env) {
  return {
    enabled: String(env.MERGED_CALL_ALIGN_SILENCE ?? 'true').toLowerCase() !== 'false',
    noiseDb: envNum('MERGED_CALL_SILENCE_DB', -40),
    minSilenceSec: envNum('MERGED_CALL_SILENCE_MIN_SEC', 0.08),
  };
}

/** Silences in an audio file: [{ start, end }] in seconds. */
function detectSilences(filePath, { noiseDb = -40, minSilenceSec = 0.08 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-nostats', '-i', filePath,
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`, '-f', 'null', '-'];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg silencedetect exited ${code}`));
      const silences = [];
      let start = null;
      for (const line of stderr.split(/\r?\n/)) {
        const s = line.match(/silence_start: (-?[\d.]+)/);
        if (s) { start = Math.max(0, parseFloat(s[1])); continue; }
        const e = line.match(/silence_end: ([\d.]+)/);
        if (e && start !== null) { silences.push({ start, end: parseFloat(e[1]) }); start = null; }
      }
      if (start !== null) silences.push({ start, end: Infinity }); // runs to end of file
      resolve(silences);
    });
  });
}

const SKIP_COST = 4.0;          // cost of leaving a speaker change unplaced (answer delays of 2-3s are normal)
const POS_ROUNDING_SLACK = 1.0; // pos is whole seconds, so audio may sit up to ~1s "ahead"

/**
 * Pick an audio time for each speaker change.
 * @param {number[]} positions  wall-clock pos (seconds) of each speaker change, ascending
 * @param {{start:number,end:number}[]} silences
 * @param {number} duration     audio length in seconds
 * @returns {(number|null)[]}   audio cut time per change, or null when skipped
 */
function alignBoundaries(positions, silences, duration) {
  // Cut just before the next speech starts; ignore the lead-in and trailing silence
  const cuts = silences
    .filter((s) => s.start > 0.05 && s.end < duration - 0.05)
    .map((s) => Math.max(s.start, s.end - 0.1));

  const K = positions.length;
  const M = cuts.length;
  // best[k][j]: lowest cost with change k placed at cut j; j = M means "skipped"
  // State carries the drift of the last placed change and the last cut index used.
  let states = [{ cost: 0, drift: 0, last: -1, picks: [] }];
  for (let k = 0; k < K; k++) {
    const next = new Map(); // key: last cut index -> best state
    const keep = (st) => {
      const prev = next.get(st.last);
      if (!prev || st.cost < prev.cost) next.set(st.last, st);
    };
    for (const st of states) {
      // Option 1: skip this change
      keep({ cost: st.cost + SKIP_COST, drift: st.drift, last: st.last, picks: [...st.picks, null] });
      // Option 2: place it on a later cut
      for (let j = st.last + 1; j < M; j++) {
        const drift = positions[k] - cuts[j];
        if (drift < -POS_ROUNDING_SLACK) break; // cut is later than the speaker could have started
        if (drift < st.drift - POS_ROUNDING_SLACK) continue; // drift can't shrink
        keep({ cost: st.cost + Math.abs(drift - st.drift), drift, last: j, picks: [...st.picks, cuts[j]] });
      }
    }
    states = [...next.values()];
  }
  let best = states[0];
  for (const st of states) if (st.cost < best.cost) best = st;
  return best.picks;
}

/** True when positions look like times in the audio rather than wall-clock seconds. */
function isAudioRelative(positions, duration) {
  if (positions.length === 0) return false;
  const fractional = positions.some((p) => Math.abs(p - Math.round(p)) > 1e-6);
  return fractional && Math.max(...positions) <= duration + 0.25;
}

/** Positions given in whole seconds (no fractional part on any of them). */
function isWholeSeconds(positions) {
  return positions.length > 0 && positions.every((p) => Math.abs(p - Math.round(p)) < 1e-6);
}

// Where to cut for each silence: just before the next speech starts. The
// lead-in and trailing silence are not speaker changes.
function silenceCuts(silences, duration) {
  return silences
    .filter((s) => s.start > 0.05 && s.end < duration - 0.05)
    .map((s) => Math.max(s.start, s.end - 0.1));
}

const NUDGE_WINDOW = 0.5; // seconds an audio position may move to reach a silence

/**
 * Fractional audio positions: move each change to the nearest silence close by,
 * or keep it. A turn shorter than minSegmentSec is folded (null) rather than
 * cut out, since a clip that short is dropped before transcription.
 */
function nudgeBoundaries(positions, silences, duration, minSegmentSec = 0) {
  const cuts = silenceCuts(silences, duration);
  let prev = 0;
  return positions.map((pos) => {
    let best = null;
    for (const c of cuts) {
      if (c <= prev || Math.abs(c - pos) > NUDGE_WINDOW) continue;
      if (best === null || Math.abs(c - pos) < Math.abs(best - pos)) best = c;
    }
    const cut = Math.min(Math.max(best ?? pos, prev), duration);
    if (minSegmentSec > 0 && (cut - prev < minSegmentSec || duration - cut < minSegmentSec)) return null;
    prev = cut;
    return cut;
  });
}

// Whole-second positions: where speech starts relative to `pos` (measured on TRP calls)
const WHOLE_SEC_OFFSET = 0.3;   // most likely start: pos + 0.3s
const WHOLE_SEC_EARLY = 1.0;    // earliest cut considered: pos - 1s
const WHOLE_SEC_LATE = 1.75;    // latest cut considered: pos + 1.75s
const ESTIMATE_COST = 1.0;      // extra cost of cutting where there's no silence (may split a word)
const WHOLE_SEC_SKIP_COST = 4.0;

/**
 * Whole-second audio positions: give each change its own silence in its window,
 * keeping order and at least minSegmentSec per turn, at the lowest total
 * distance from pos + WHOLE_SEC_OFFSET. A change with no free silence is cut at
 * its estimated start; it is folded into the previous turn (null) only when
 * even that leaves no room.
 * @returns {(number|null)[]} audio cut time per change, or null when folded
 */
function alignWholeSeconds(positions, silences, duration, minSegmentSec = 0) {
  const cuts = silenceCuts(silences, duration);
  const gap = Math.max(minSegmentSec, 0.05);
  const lastIdxAtOrBefore = (t) => {
    let i = -1;
    while (i + 1 < cuts.length && cuts[i + 1] <= t) i++;
    return i;
  };
  let states = [{ cost: 0, lastCut: 0, lastIdx: -1, picks: [] }];
  for (const p of positions) {
    const target = p + WHOLE_SEC_OFFSET;
    const next = new Map();
    const keep = (st) => {
      const key = `${st.lastIdx}:${st.lastCut.toFixed(2)}`;
      const prev = next.get(key);
      if (!prev || st.cost < prev.cost) next.set(key, st);
    };
    for (const st of states) {
      // Fold into the previous turn
      keep({ ...st, cost: st.cost + WHOLE_SEC_SKIP_COST, picks: [...st.picks, null] });
      // A silence in the window
      for (let j = st.lastIdx + 1; j < cuts.length; j++) {
        const c = cuts[j];
        if (c > p + WHOLE_SEC_LATE) break;
        if (c < p - WHOLE_SEC_EARLY || c < st.lastCut + gap || c > duration - gap) continue;
        keep({ cost: st.cost + Math.abs(c - target), lastCut: c, lastIdx: j, picks: [...st.picks, c] });
      }
      // No silence: the estimated start
      const e = Math.max(target, st.lastCut + gap);
      if (e <= p + WHOLE_SEC_LATE && e <= duration - gap) {
        keep({
          cost: st.cost + ESTIMATE_COST + Math.abs(e - target),
          lastCut: e,
          lastIdx: Math.max(st.lastIdx, lastIdxAtOrBefore(e)),
          picks: [...st.picks, e],
        });
      }
    }
    states = [...next.values()];
  }
  let best = states[0];
  for (const st of states) if (st.cost < best.cost) best = st;
  return best.picks;
}

/**
 * Adjust merged-call segments ({startPos, endPos, ...}) to the recording.
 * Returns new segment objects; changes that couldn't be placed are folded into
 * the previous segment. Returns null if nothing could be aligned.
 */
function alignSegments(segments, silences, duration, { minSegmentSec = 0 } = {}) {
  if (!segments || segments.length < 2 || !Number.isFinite(duration) || duration <= 0) return null;
  const positions = segments.slice(1).map((s) => s.startPos || 0);
  // Any fractional second: audio positions. Whole seconds inside the recording:
  // TrunkRecorder Pro audio positions. Whole seconds running past the end: the
  // older wall-clock positions.
  let mode;
  let picks;
  if (isAudioRelative(positions, duration)) {
    mode = 'audio positions';
    picks = nudgeBoundaries(positions, silences, duration, minSegmentSec);
  } else if (isWholeSeconds(positions) && Math.max(...positions) <= duration + 0.5) {
    mode = 'whole-second audio positions';
    picks = alignWholeSeconds(positions, silences, duration, minSegmentSec);
  } else {
    mode = 'wall-clock positions';
    picks = alignBoundaries(positions, silences, duration);
  }
  const audioRelative = mode !== 'wall-clock positions';

  const out = [{ ...segments[0], startPos: 0, alignedFrom: segments[0].startPos }];
  picks.forEach((cut, i) => {
    const seg = segments[i + 1];
    if (cut === null) {
      const prev = out[out.length - 1];
      prev.foldedSources = [...(prev.foldedSources || []), seg.sourceDisplay];
      return;
    }
    out.push({ ...seg, startPos: cut, alignedFrom: seg.startPos });
  });
  for (let i = 0; i < out.length; i++) {
    out[i].endPos = i + 1 < out.length ? out[i + 1].startPos : duration;
  }
  out.audioRelative = audioRelative;
  out.mode = mode;
  return out;
}

module.exports = {
  loadConfig, detectSilences, alignBoundaries, nudgeBoundaries, alignWholeSeconds,
  isAudioRelative, isWholeSeconds, alignSegments,
};
