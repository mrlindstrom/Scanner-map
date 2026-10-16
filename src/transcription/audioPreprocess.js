'use strict';

/**
 * Audio cleanup before transcription, adapted from RadioTranscriber
 * (https://github.com/Nite01007/RadioTranscriber, MIT):
 *   - high-pass filter to strip rumble/hum (RadioTranscriber: 100 Hz Butterworth)
 *   - optional low-pass to strip hiss above the voice band
 *   - percentile normalization so squelch pops don't set the gain
 *   - 16 kHz mono 16-bit output (what Whisper uses internally)
 *
 * Filtering and resampling run in ffmpeg; normalization runs here on the raw
 * PCM because ffmpeg has no percentile-based normalizer.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createLogger } = require('../logger');

const log = createLogger('audio-preprocess');

const SAMPLE_RATE = 16000;

function num(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  return {
    enabled: String(env.AUDIO_PREPROCESS_ENABLED || 'false').toLowerCase() === 'true',
    highpassHz: num(env.AUDIO_PREPROCESS_HIGHPASS_HZ, 100),
    // Low-pass and normalization default off: on decoded P25 audio sent to
    // ICAD they dropped words and added hallucinations more often than they helped.
    lowpassHz: num(env.AUDIO_PREPROCESS_LOWPASS_HZ, 0),
    normalizePercentile: num(env.AUDIO_PREPROCESS_NORMALIZE_PERCENTILE, 0),
    normalizeTarget: num(env.AUDIO_PREPROCESS_NORMALIZE_TARGET, 0.9),
    maxGain: num(env.AUDIO_PREPROCESS_MAX_GAIN, 20),
  };
}

function buildFilterChain(cfg) {
  const filters = [];
  // ffmpeg's highpass/lowpass are 2-pole; two passes give a 4th-order slope,
  // close to RadioTranscriber's 5th-order Butterworth.
  if (cfg.highpassHz > 0) filters.push(`highpass=f=${cfg.highpassHz}`, `highpass=f=${cfg.highpassHz}`);
  if (cfg.lowpassHz > 0) filters.push(`lowpass=f=${cfg.lowpassHz}`, `lowpass=f=${cfg.lowpassHz}`);
  return filters;
}

/** Decode any input to filtered 16 kHz mono s16le PCM. */
function decodeToPcm(inputPath, filters) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', inputPath];
    if (filters.length) args.push('-af', filters.join(','));
    args.push('-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', 'pipe:1');

    const proc = spawn('ffmpeg', args);
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60000);
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
      const buf = Buffer.concat(chunks);
      // Copy into an aligned buffer so Int16Array can view it.
      const aligned = new Int16Array(Math.floor(buf.length / 2));
      for (let i = 0; i < aligned.length; i++) aligned[i] = buf.readInt16LE(i * 2);
      resolve(aligned);
    });
  });
}

/**
 * Scale so the given percentile of |sample| lands at `target` of full scale,
 * then hard-clip. Gain is capped so near-silent clips aren't blown up into noise.
 */
function percentileNormalize(samples, cfg) {
  if (!(cfg.normalizePercentile > 0) || samples.length === 0) return { samples, gain: 1 };

  const abs = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) abs[i] = Math.abs(samples[i]);
  abs.sort();
  const idx = Math.min(abs.length - 1, Math.floor((cfg.normalizePercentile / 100) * abs.length));
  const ref = abs[idx];
  if (ref <= 0) return { samples, gain: 1 };

  const gain = Math.min(cfg.maxGain, (cfg.normalizeTarget * 32767) / ref);
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * gain);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return { samples: out, gain };
}

function wavBuffer(samples) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // fmt chunk size
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(1, 22);           // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], 44 + i * 2);
  return buf;
}

/**
 * Produce a cleaned-up WAV next to the OS temp dir.
 * Resolves to { path, durationSec, cleanup() } or null when disabled/failed,
 * in which case the caller should transcribe the original file.
 */
async function preprocessAudio(inputPath, cfg = loadConfig()) {
  if (!cfg.enabled) return null;
  const started = Date.now();
  try {
    const pcm = await decodeToPcm(inputPath, buildFilterChain(cfg));
    if (pcm.length === 0) return null;
    const { samples, gain } = percentileNormalize(pcm, cfg);

    const outPath = path.join(os.tmpdir(), `scanner-pre-${crypto.randomBytes(6).toString('hex')}.wav`);
    await fs.promises.writeFile(outPath, wavBuffer(samples));
    const durationSec = samples.length / SAMPLE_RATE;
    log.debug(`Preprocessed ${path.basename(inputPath)} (${durationSec.toFixed(1)}s, gain x${gain.toFixed(2)}) in ${Date.now() - started}ms`);

    return {
      path: outPath,
      durationSec,
      cleanup: () => fs.unlink(outPath, () => {}),
    };
  } catch (err) {
    log.warn(`Preprocessing failed for ${path.basename(inputPath)}, using original audio: ${err.message}`);
    return null;
  }
}

module.exports = { loadConfig, preprocessAudio, percentileNormalize, buildFilterChain };
