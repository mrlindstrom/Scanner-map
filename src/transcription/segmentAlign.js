'use strict';

/**
 * Line up merged-call speaker changes with the actual recording.
 *
 * Two kinds of per-source `pos` values arrive:
 *
 *   - Audio positions (Trunk Recorder, and TrunkRecorder Pro since the release
 *     that put srcList positions "in the audio"): fractional seconds into the
 *     saved file. They are already close, so each change is only nudged to a
 *     silence within NUDGE_WINDOW of it, and kept where it is otherwise.
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

const NUDGE_WINDOW = 0.5; // seconds an audio position may move to reach a silence

/** Audio positions: move each change to the nearest silence close by, or keep it. */
function nudgeBoundaries(positions, silences, duration) {
  const cuts = silences
    .filter((s) => s.start > 0.05 && s.end < duration - 0.05)
    .map((s) => Math.max(s.start, s.end - 0.1));
  let prev = 0;
  return positions.map((pos) => {
    let best = null;
    for (const c of cuts) {
      if (c <= prev || Math.abs(c - pos) > NUDGE_WINDOW) continue;
      if (best === null || Math.abs(c - pos) < Math.abs(best - pos)) best = c;
    }
    const cut = Math.min(Math.max(best ?? pos, prev), duration);
    prev = cut;
    return cut;
  });
}

/**
 * Adjust merged-call segments ({startPos, endPos, ...}) to the recording.
 * Returns new segment objects; changes that couldn't be placed are folded into
 * the previous segment. Returns null if nothing could be aligned.
 */
function alignSegments(segments, silences, duration) {
  if (!segments || segments.length < 2 || !Number.isFinite(duration) || duration <= 0) return null;
  const positions = segments.slice(1).map((s) => s.startPos || 0);
  const audioRelative = isAudioRelative(positions, duration);
  const picks = audioRelative
    ? nudgeBoundaries(positions, silences, duration)
    : alignBoundaries(positions, silences, duration);

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
  return out;
}

module.exports = { loadConfig, detectSilences, alignBoundaries, nudgeBoundaries, isAudioRelative, alignSegments };
