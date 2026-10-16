'use strict';

/**
 * Post-transcription guards against Whisper hallucinations, adapted from
 * RadioTranscriber (https://github.com/Nite01007/RadioTranscriber, MIT).
 *
 * filterTranscript(text, durationSec) returns { text, reason }. `text` is the
 * cleaned transcript ('' means "discard"); `reason` names the rule that fired
 * (null when the text passed through unchanged).
 */

const DEFAULT_BLOCK_PHRASES = [
  'CastingWords', 'Rev.com', 'amara.org', 'ESA, Inc.', 'U.S. Department of',
  'Transcripts translated by', 'Transcription Outsourcing',
];

// RadioTranscriber's list minus phrases that are real radio traffic
// ("you're under arrest", "this is a test").
const DEFAULT_CUTOFF_PHRASES = [
  "We'll be right back", 'We will be right back', 'Thank you for watching',
  'Thanks for watching', 'Thank you for your patience', 'Stay tuned',
  'Commercial break', 'Transcription by', 'Translation by', 'Captions by',
  'Subtitles by', "I'll narrate everything", 'the following is a',
];

function list(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).split('|').map((s) => s.trim()).filter(Boolean);
}

function num(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

/** "eight one=A1|5 2 8 1=52A1" -> [['eight one','A1'], ...], longest first */
function parseUnitMappings(value) {
  return list(value, [])
    .map((pair) => pair.split('=').map((s) => s.trim()))
    .filter(([from, to]) => from && to !== undefined)
    .sort((a, b) => b[0].length - a[0].length);
}

function loadConfig(env = process.env) {
  return {
    enabled: bool(env.TRANSCRIPT_FILTER_ENABLED, true),
    blockPhrases: list(env.TRANSCRIPT_FILTER_BLOCK_PHRASES, DEFAULT_BLOCK_PHRASES),
    cutoffPhrases: list(env.TRANSCRIPT_FILTER_CUTOFF_PHRASES, DEFAULT_CUTOFF_PHRASES),
    maxWordsPerSec: num(env.TRANSCRIPT_FILTER_MAX_WORDS_PER_SEC, 8),
    cascadeMinRepeats: num(env.TRANSCRIPT_FILTER_CASCADE_MIN_REPEATS, 4),
    toneMarkers: bool(env.TRANSCRIPT_FILTER_TONE_MARKERS, true),
    repeatBuster: bool(env.TRANSCRIPT_FILTER_REPEAT_BUSTER, false),
    unitMappings: parseUnitMappings(env.TRANSCRIPT_UNIT_MAPPINGS),
  };
}

const normWord = (w) => w.toLowerCase().replace(/[^\w'-]/g, '');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Digits and spoken numbers repeat legitimately ("1-1-1-1 Main", "one one one
// one"), so a numeric phrase needs twice as many repeats to count as a loop.
const NUMBER_WORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'twenty', 'thirty', 'forty', 'fifty', 'hundred', 'thousand']);
const isNumberish = (w) => /^\d+[a-z]?$/.test(w) || NUMBER_WORDS.has(w);

/**
 * Find a 1-3 word phrase repeated >= minRepeats times back to back.
 * Returns { start, end, size } (word indexes, end exclusive) or null.
 */
function findCascade(norm, minRepeats) {
  for (let start = 0; start < norm.length; start++) {
    for (let size = 1; size <= 3; size++) {
      const unitWords = norm.slice(start, start + size);
      const unit = unitWords.join(' ');
      if (!unit) continue;
      const needed = unitWords.every(isNumberish) ? minRepeats * 2 : minRepeats;
      let reps = 1;
      while (norm.slice(start + reps * size, start + (reps + 1) * size).join(' ') === unit) reps++;
      if (reps >= needed) return { start, end: start + reps * size, size };
    }
  }
  return null;
}

function filterTranscript(rawText, durationSec, cfg = loadConfig()) {
  let text = String(rawText || '').trim();
  if (!cfg.enabled || !text) return { text, reason: null };
  let reason = null;

  // Dot-only / ellipsis output
  if (/^[.\s…]+$/.test(text)) return { text: '', reason: 'dots-only' };

  // "BANG BANG BANG"
  if (/^(bang)+$/i.test(text.replace(/\W/g, ''))) return { text: '', reason: 'bang' };

  // Whisper turns static into Icelandic/Faroese ("Það er það er það"); þ/ð never
  // occur in English or Spanish radio traffic
  if (/[þðÞÐ]/.test(text)) return { text: '', reason: 'foreign-script' };

  // Alert tones and static come back as stretched letters
  if (cfg.toneMarkers) {
    const shortClip = !(durationSec > 0) || durationSec < 10;
    if (shortClip && text.length > 10 && /\bB+E{2,}P+\b|\b(?:A{4,}|E{4,})\b/i.test(text)) {
      return { text: '[beeps]', reason: 'tone-marker' };
    }
    if (/([A-Za-z])\1{10,}/.test(text)) return { text: '[noise]', reason: 'noise-marker' };
  }

  let words = text.split(/\s+/);
  let norm = words.map(normWord);

  // Repetition loops: collapse each run to a single instance and keep the
  // speech on both sides of it (only a call that is nothing but the loop is dropped)
  if (cfg.cascadeMinRepeats > 1) {
    for (let pass = 0; pass < 5; pass++) {
      const c = findCascade(norm, cfg.cascadeMinRepeats);
      if (!c) break;
      if (c.start === 0 && c.end === words.length) return { text: '', reason: 'full-cascade' };
      words = [...words.slice(0, c.start + c.size), ...words.slice(c.end)];
      norm = words.map(normWord);
      reason = 'repeat-collapsed';
    }
    text = words.join(' ');
  }

  // One short word making up most of a line ("you you thank you you you").
  // Needs 6+ words so short real replies ("North or North River? North.") survive.
  if (words.length >= 6) {
    const counts = new Map();
    norm.forEach((w) => { if (w && w.length <= 10) counts.set(w, (counts.get(w) || 0) + 1); });
    for (const [w, c] of counts) {
      if (c > words.length * 0.6) {
        text = words[norm.indexOf(w)];
        words = [text];
        norm = [w];
        reason = 'dominant-word';
        break;
      }
    }
  }

  // Implausible speech rate means Whisper invented text
  if (cfg.maxWordsPerSec > 0 && durationSec > 0 && words.length / durationSec > cfg.maxWordsPerSec) {
    return { text: '', reason: `speech-rate ${(words.length / durationSec).toFixed(1)} w/s` };
  }

  // Feed-specific spoken-unit mappings (opt-in)
  for (const [from, to] of cfg.unitMappings) {
    const re = new RegExp(`\\b${escapeRe(from)}\\b`, 'gi');
    if (re.test(text)) {
      text = text.replace(re, to);
      reason = reason || 'unit-mapping';
    }
  }

  // Caption/credit hallucinations
  const lower = text.toLowerCase();
  const blocked = cfg.blockPhrases.find((p) => lower.includes(p.toLowerCase()));
  if (blocked) return { text: '', reason: `block-phrase "${blocked}"` };

  // Sign-off hallucinations appended to real speech. Only cut when the phrase
  // sits at the end (at most a few words after it); with real speech following,
  // it was probably said on air ("Stay tuned, George. You can show both ...").
  let cutAt = -1;
  let cutPhrase = null;
  for (const p of cfg.cutoffPhrases) {
    const i = lower.indexOf(p.toLowerCase());
    if (i === -1) continue;
    const after = text.slice(i + p.length).replace(new RegExp(escapeRe(p), 'gi'), ' ');
    const wordsAfter = after.split(/\s+/).filter((w) => /\w/.test(w)).length;
    if (wordsAfter <= 4 && (cutAt === -1 || i < cutAt)) { cutAt = i; cutPhrase = p; }
  }
  if (cutAt !== -1) {
    text = text.slice(0, cutAt).replace(/[\s,;:.-]+$/, '').trim();
    reason = `cutoff-phrase "${cutPhrase}"`;
  }

  // A 3-word group immediately repeated (off by default: dispatchers repeat addresses)
  if (cfg.repeatBuster) {
    words = text.split(/\s+/);
    norm = words.map(normWord);
    if (words.length > 6) {
      for (let i = 0; i + 6 <= norm.length; i++) {
        if (norm.slice(i, i + 3).join(' ') === norm.slice(i + 3, i + 6).join(' ')) {
          text = `${words.slice(0, i + 3).join(' ')} [repeated]`;
          reason = 'repeat-buster';
          break;
        }
      }
    }
  }

  return { text: text.trim(), reason };
}

module.exports = { loadConfig, filterTranscript, findCascade, DEFAULT_BLOCK_PHRASES, DEFAULT_CUTOFF_PHRASES };
