// bot.js - Main Discord bot application with integrated webserver and initialization

require('dotenv').config();
// Direct console.* output (startup checks, geocoding) uses the shared log layout
require('./src/consoleFormat').patchConsole('bot');

// Settings from .env. They're re-read when the file changes (see
// applyLiveSettings), so most changes saved in Settings apply without a restart.
const liveEnv = require('./src/config/liveEnv');
liveEnv.init();
let PORT, PUBLIC_DOMAIN, DISCORD_TOKEN, mappedTalkGroupsString, ENABLE_MAPPED_TALK_GROUPS, TIMEZONE, API_KEY_FILE, SUMMARY_LOOKBACK_HOURS, TRANSCRIPTION_MODE, FASTER_WHISPER_SERVER_URL, WHISPER_MODEL, STORAGE_MODE, S3_ENDPOINT, S3_BUCKET_NAME, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, ASK_AI_LOOKBACK_HOURS, MAX_CONCURRENT_TRANSCRIPTIONS, AI_PROVIDER, OPENAI_API_KEY, OPENAI_MODEL, OLLAMA_URL, OLLAMA_MODEL, TRANSCRIPTION_DEVICE, PYTHON_COMMAND, AUTO_UPDATE_PYTHON_PACKAGES, ICAD_URL, ICAD_PROFILE, ICAD_API_KEY, OPENAI_TRANSCRIPTION_PROMPT, OPENAI_TRANSCRIPTION_MODEL, OPENAI_TRANSCRIPTION_TEMPERATURE, WEBSERVER_PORT, WEBSERVER_PASSWORD, ENABLE_AUTH, SESSION_DURATION_DAYS, MAX_SESSIONS_PER_USER, GOOGLE_MAPS_API_KEY, LOCATIONIQ_API_KEY, MAP_ONLY_MODE, ENABLE_SUMMARY_TALK_GROUPS, summaryTalkGroupsString, TRANSCRIBE_MODE, transcribeTalkGroupsString, ENABLE_TWO_TONE_MODE, twoToneTalkGroupsString, TWO_TONE_QUEUE_SIZE;
function readEnvSettings() {
  ({
    BOT_PORT: PORT,  
    PUBLIC_DOMAIN,
    DISCORD_TOKEN,
    MAPPED_TALK_GROUPS: mappedTalkGroupsString,
    ENABLE_MAPPED_TALK_GROUPS = 'true',
    TIMEZONE,
    API_KEY_FILE,
    SUMMARY_LOOKBACK_HOURS,
    TRANSCRIPTION_MODE,
    FASTER_WHISPER_SERVER_URL,
    WHISPER_MODEL,
    STORAGE_MODE,
    S3_ENDPOINT,
    S3_BUCKET_NAME,
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
    ASK_AI_LOOKBACK_HOURS,
    MAX_CONCURRENT_TRANSCRIPTIONS,
    // --- NEW: AI Provider Env Vars ---
    AI_PROVIDER,
    OPENAI_API_KEY,
    OPENAI_MODEL,
    OLLAMA_URL,
    OLLAMA_MODEL,
    TRANSCRIPTION_DEVICE,
    // --- NEW: Python Command Override ---
    PYTHON_COMMAND,
    // --- NEW: Auto-update Control ---
    AUTO_UPDATE_PYTHON_PACKAGES = 'true',
    // --- NEW: ICAD Transcription Env Vars ---
    ICAD_URL,
    ICAD_PROFILE,
    ICAD_API_KEY,
    // --- NEW: OpenAI Transcription Prompting ---
    OPENAI_TRANSCRIPTION_PROMPT,
    OPENAI_TRANSCRIPTION_MODEL,
    OPENAI_TRANSCRIPTION_TEMPERATURE,
    // --- Webserver Env Vars ---
    WEBSERVER_PORT = '3001',
    WEBSERVER_PASSWORD,
    ENABLE_AUTH = 'false',
    SESSION_DURATION_DAYS = '7',
    MAX_SESSIONS_PER_USER = '5',
    GOOGLE_MAPS_API_KEY = null,
    LOCATIONIQ_API_KEY = null,
    // --- Map-only mode (run without Discord) ---
    MAP_ONLY_MODE = 'false',
    // --- AI summary scoping ---
    ENABLE_SUMMARY_TALK_GROUPS = 'false',
    SUMMARY_TALK_GROUPS: summaryTalkGroupsString,
    // --- Transcription filtering (whitelist/blacklist for what gets transcribed) ---
    TRANSCRIBE_MODE = 'all', // 'all' | 'whitelist' | 'blacklist'
    TRANSCRIBE_TALK_GROUPS: transcribeTalkGroupsString,
    // --- NEW: Two-Tone Detection Env Vars ---
    ENABLE_TWO_TONE_MODE = 'false',
    TWO_TONE_TALK_GROUPS: twoToneTalkGroupsString,
    TWO_TONE_QUEUE_SIZE
    // Tone tuning vars (TONE_*, TWO_TONE_*, PULSED_*, LONG_TONE_*) are read by tone_detect.py
  } = process.env);
}
readEnvSettings();

// --- VALIDATE AI-RELATED ENV VARS ---
if (!AI_PROVIDER) {
  console.error("FATAL: AI_PROVIDER is not set in the .env file. Please specify 'ollama' or 'openai'.");
  process.exit(1);
}

if (AI_PROVIDER.toLowerCase() === 'openai') {
  if (!OPENAI_API_KEY || !OPENAI_MODEL) {
      console.error("FATAL: AI_PROVIDER is 'openai', but OPENAI_API_KEY or OPENAI_MODEL is missing in the .env file.");
      process.exit(1);
  }
} else if (AI_PROVIDER.toLowerCase() === 'ollama') {
  if (!OLLAMA_URL || !OLLAMA_MODEL) {
      console.error("FATAL: AI_PROVIDER is 'ollama', but OLLAMA_URL or OLLAMA_MODEL is missing in the .env file.");
      process.exit(1);
  }
} else {
  console.error(`FATAL: Invalid AI_PROVIDER specified in .env file: '${AI_PROVIDER}'. Must be 'openai' or 'ollama'.`);
  process.exit(1);
}
// --- END VALIDATION ---

// --- VALIDATE TRANSCRIPTION-RELATED ENV VARS ---
let effectiveTranscriptionMode = TRANSCRIPTION_MODE || 'local'; // Keep this to ensure a default
if (!['local', 'remote', 'openai', 'icad'].includes(effectiveTranscriptionMode)) {
  console.error(`FATAL: Invalid TRANSCRIPTION_MODE specified in .env file: '${TRANSCRIPTION_MODE}'. Must be 'local', 'remote', 'openai', or 'icad'.`);
  process.exit(1);
}
if (effectiveTranscriptionMode === 'local' && !TRANSCRIPTION_DEVICE) {
  console.error("FATAL: TRANSCRIPTION_MODE is 'local', but TRANSCRIPTION_DEVICE is missing in the .env file. Please set it to 'cuda' for a GPU or 'cpu' for CPU.");
  process.exit(1);
}
if (effectiveTranscriptionMode === 'remote' && !FASTER_WHISPER_SERVER_URL) {
  console.error("FATAL: TRANSCRIPTION_MODE is 'remote', but FASTER_WHISPER_SERVER_URL is missing in the .env file.");
  process.exit(1);
}
if (effectiveTranscriptionMode === 'openai' && !OPENAI_API_KEY) {
  console.error("FATAL: TRANSCRIPTION_MODE is 'openai', but OPENAI_API_KEY is missing in the .env file. This is required for OpenAI transcriptions.");
  process.exit(1);
}
if (effectiveTranscriptionMode === 'icad' && !ICAD_URL) {
  console.error("FATAL: TRANSCRIPTION_MODE is 'icad', but ICAD_URL is missing in the .env file. Please set it to your ICAD API endpoint URL.");
  process.exit(1);
}
// --- END VALIDATION ---

// Now initialize derived variables
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const bcrypt = require('bcryptjs');
const { createStorage, isDbMode, buildKey } = require('./src/storage');
const pendingUploads = require('./src/storage/pendingUploads');
const { runMigrations } = require('./src/db/migrations');
const llmQueue = require('./src/ai/llmQueue');
const { createCatchUp } = require('./src/ai/catchUp');
const { audioUrl: buildAudioUrl, getPublicBaseUrl } = require('./src/utils/publicUrl');
const callEmbeds = require('./src/discord/callEmbeds');
const summaryTriage = require('./src/summary/triage');
const streetMatching = require('./src/geocoding/streets');
// Skip the AI for calls that can't contain a location (no number, street or place word)
let ADDRESS_PREFILTER_ENABLED = String(process.env.ADDRESS_PREFILTER ?? 'true').toLowerCase() !== 'false';
const summaryIncidents = require('./src/summary/incidents');
const audioPreprocess = require('./src/transcription/audioPreprocess');
const hallucinationFilter = require('./src/transcription/hallucinationFilter');
const transcriptCorrections = require('./src/transcription/corrections');
const segmentAlign = require('./src/transcription/segmentAlign');
let SEGMENT_ALIGN_CONFIG = segmentAlign.loadConfig();
const { v4: uuidv4 } = require('uuid');
const busboy = require('busboy');
const sqlite3 = require('sqlite3').verbose();
const { spawn } = require('child_process');
const { Readable } = require('stream');
const fetch = require('node-fetch');
const winston = require('winston');
const { getFileTransports } = require('./src/logger');
const { consoleFormat, isVerbose: consoleShowsAllInfo } = require('./src/consoleFormat');
const moment = require('moment-timezone');
const TALK_GROUPS = {};
const readline = require('readline');
const FormData = require('form-data');
const csv = require('csv-parser');
const http = require('http');
const socketIo = require('socket.io');
const crypto = require('crypto');
let summaryChannel;
const SUMMARY_INTERVAL = 10 * 60 * 1000; // Changed from 5 to 10 minutes in milliseconds
let lastSummaryUpdate = 0;
let summaryMessage = null;

// Values derived from the settings above; recomputed by computeDerivedSettings()
// whenever .env changes.
let LOOKBACK_HOURS, LOOKBACK_PERIOD;
let MAPPED_TALK_GROUPS, IS_MAPPED_TALK_GROUPS_ENABLED;
let IS_SUMMARY_TALK_GROUPS_ENABLED, SUMMARY_TALK_GROUPS;
let TRANSCRIBE_MODE_VALUE, TRANSCRIBE_TALK_GROUPS;
let IS_TWO_TONE_MODE_ENABLED, TWO_TONE_TALK_GROUPS, TWO_TONE_QUEUE_SIZE_VALUE;
let MAX_CONCURRENT_TRANSCRIPTIONS_VALUE;
// Map-only mode decides at startup whether Discord is used, so it needs a restart
const IS_MAP_ONLY_MODE = String(MAP_ONLY_MODE).toLowerCase() === 'true';

function computeDerivedSettings() {
  effectiveTranscriptionMode = TRANSCRIPTION_MODE || 'local';

  // Summary lookback in hours, falling back to 1 hour
  const parsedLookbackHours = parseFloat(SUMMARY_LOOKBACK_HOURS);
  LOOKBACK_HOURS = isNaN(parsedLookbackHours) ? 1 : parsedLookbackHours;
  LOOKBACK_PERIOD = LOOKBACK_HOURS * 60 * 60 * 1000; // Convert hours to milliseconds

  MAPPED_TALK_GROUPS = mappedTalkGroupsString
    ? mappedTalkGroupsString.split(',').map(id => id.trim())
    : [];
  IS_MAPPED_TALK_GROUPS_ENABLED = String(ENABLE_MAPPED_TALK_GROUPS).toLowerCase() === 'true';

  // AI summary scoping: optionally restrict the dispatch-summary channel to a set
  // of talkgroups. Entries may be plain ids or "system:id" pairs.
  IS_SUMMARY_TALK_GROUPS_ENABLED = String(ENABLE_SUMMARY_TALK_GROUPS).toLowerCase() === 'true';
  SUMMARY_TALK_GROUPS = summaryTalkGroupsString
    ? summaryTalkGroupsString.split(',').map((id) => id.trim()).filter(Boolean)
    : [];

  // Transcription filtering: TrunkRecorder sends every call (it can't pre-filter
  // like SDRTrunk), so allow a whitelist/blacklist of talkgroups to transcribe.
  TRANSCRIBE_MODE_VALUE = ['all', 'whitelist', 'blacklist'].includes(String(TRANSCRIBE_MODE).toLowerCase())
    ? String(TRANSCRIBE_MODE).toLowerCase()
    : 'all';
  TRANSCRIBE_TALK_GROUPS = transcribeTalkGroupsString
    ? transcribeTalkGroupsString.split(',').map((id) => id.trim()).filter(Boolean)
    : [];

  IS_TWO_TONE_MODE_ENABLED = String(ENABLE_TWO_TONE_MODE).toLowerCase() === 'true';
  TWO_TONE_TALK_GROUPS = twoToneTalkGroupsString
    ? twoToneTalkGroupsString.split(',').map(id => id.trim())
    : [];
  TWO_TONE_QUEUE_SIZE_VALUE = parseInt(TWO_TONE_QUEUE_SIZE, 10) || 1;

  // MAX_CONCURRENT_TRANSCRIPTIONS from env, or the default
  const parsedMaxConcurrent = parseInt(MAX_CONCURRENT_TRANSCRIPTIONS, 10);
  MAX_CONCURRENT_TRANSCRIPTIONS_VALUE = !isNaN(parsedMaxConcurrent) && parsedMaxConcurrent > 0 ? parsedMaxConcurrent : 3;
}
computeDerivedSettings();

// Decide whether a given call should be transcribed at all.
function shouldTranscribe(talkGroupID, systemName) {
  if (TRANSCRIBE_MODE_VALUE === 'all' || !TRANSCRIBE_TALK_GROUPS.length) return true;
  const id = String(talkGroupID);
  const sys = String(systemName || '').trim().toLowerCase();
  const scoped = sys ? `${sys}:${id}` : null;
  const inList = TRANSCRIBE_TALK_GROUPS.includes(id) || (scoped && TRANSCRIBE_TALK_GROUPS.includes(scoped));
  return TRANSCRIBE_MODE_VALUE === 'whitelist' ? inList : !inList;
}

// Validate required two-tone environment variables if two-tone mode is enabled
if (IS_TWO_TONE_MODE_ENABLED) {
  const requiredTwoToneVars = [
    'ENABLE_TWO_TONE_MODE', 'TWO_TONE_TALK_GROUPS', 'TWO_TONE_QUEUE_SIZE',
    'TONE_DETECTION_TYPE', 'TWO_TONE_MIN_TONE_LENGTH', 'TWO_TONE_MAX_TONE_LENGTH',
    'PULSED_MIN_CYCLES', 'PULSED_MIN_ON_MS', 'PULSED_MAX_ON_MS',
    'PULSED_MIN_OFF_MS', 'PULSED_MAX_OFF_MS', 'PULSED_BANDWIDTH_HZ',
    'LONG_TONE_MIN_LENGTH', 'LONG_TONE_BANDWIDTH_HZ', 'TONE_DETECTION_THRESHOLD',
    'TONE_FREQUENCY_BAND', 'TONE_TIME_RESOLUTION_MS'
  ];
  
  const missingVars = requiredTwoToneVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    console.error(`FATAL: Two-tone mode is enabled but missing required environment variables: ${missingVars.join(', ')}`);
    console.error('Please add these variables to your .env file. See TWO_TONE_ENV_ADDITIONS.txt for the complete list.');
    process.exit(1);
  }
}

// High-volume system optimizations
const MAX_QUEUE_SIZE = 50; // Limit queue size to prevent memory issues
const QUEUE_DRAIN_THRESHOLD = 40; // Start warning when queue gets large
const PRIORITY_QUEUE_THRESHOLD = 30; // Start prioritizing newer items

// NOTE: For very busy systems with lots of concurrent calls, consider:
// 1. Increasing MAX_CONCURRENT_TRANSCRIPTIONS in .env (default is 3, try 5-8 for busy systems)
// 2. Using a faster GPU for local transcription or switching to 'remote' mode
// 3. Monitoring memory usage and adjusting MAX_QUEUE_SIZE if needed
// 4. Consider using 'openai' transcription mode for highest reliability under load

// Two-Tone Detection System
let twoToneQueue = []; // Queue to track calls after two-tone detection
let pendingToneDetections = new Map(); // Track ongoing tone detections
let lastTwoToneTime = 0; // Timestamp of last detected two-tone
let lastDetectedToneGroup = null; // Talk group where last tone was detected

// *** NEW: Tone Detection Queue to prevent race conditions ***
let toneDetectionQueue = []; // Queue for tone detection requests
let isProcessingToneDetection = false; // Flag to prevent concurrent processing

function addToTwoToneQueue(callInfo) {
  logger.info(`Adding call to two-tone queue: ${callInfo.id} (TG ${callInfo.talkGroupID})`);
  twoToneQueue.push({
    ...callInfo,
    addedAt: Date.now()
  });
  
  // Keep queue size manageable - remove old calls for the same talk group
  const sameTgCalls = twoToneQueue.filter(call => call.talkGroupID === callInfo.talkGroupID);
  if (sameTgCalls.length > TWO_TONE_QUEUE_SIZE_VALUE) {
    // Find and remove the oldest call for this talk group
    const oldestIndex = twoToneQueue.findIndex(call => call.talkGroupID === callInfo.talkGroupID);
    if (oldestIndex !== -1) {
      const removed = twoToneQueue.splice(oldestIndex, 1)[0];
      logger.info(`Removed old call from two-tone queue: ${removed.id} (TG ${removed.talkGroupID})`);
    }
  }
}

// Mapped talk groups (if enabled). Entries may be a plain id (matches that id
// on any system) or a system-scoped "system:id" pair, so overlapping ids
// across systems can be mapped independently.
function isMappedTalkGroup(talkGroupID, systemName) {
  if (!IS_MAPPED_TALK_GROUPS_ENABLED) return false;
  const sysKey = normalizeSystemLabel(systemName);
  const scoped = sysKey ? `${sysKey}:${talkGroupID}` : null;
  return MAPPED_TALK_GROUPS.includes(String(talkGroupID)) || !!(scoped && MAPPED_TALK_GROUPS.includes(scoped));
}

function shouldCheckForAddress(talkGroupID, transcriptionId, systemName) {
  let shouldCheck = false;

  // Check 1: Traditional mapped talk groups
  if (isMappedTalkGroup(talkGroupID, systemName)) {
    shouldCheck = true;
    const sysKey = normalizeSystemLabel(systemName);
    logger.info(`Address check: Talk group ${talkGroupID}${sysKey ? ` (system ${sysKey})` : ''} is in mapped talk groups`);
  }
  
  // Check 2: Two-tone queue (if two-tone mode is enabled)
  if (IS_TWO_TONE_MODE_ENABLED) {
    const queueIndex = twoToneQueue.findIndex(call => call.id === transcriptionId);
    if (queueIndex !== -1) {
      // Remove from queue since we're processing it
      twoToneQueue.splice(queueIndex, 1);
      shouldCheck = true;
      logger.info(`Address check: Call ${transcriptionId} found in two-tone queue`);
    }
  }
  
  if (!shouldCheck) {
    logger.info(`Address check: Skipping - not in mapped groups (${IS_MAPPED_TALK_GROUPS_ENABLED}) and not in two-tone queue`);
  }
  
  return shouldCheck;
}

// One-line summary of a tone hit from tone_detect.py (icad-tone-detection result dicts)
// Tones found per call (transcription ID -> { descriptions, at }), shown in its Discord message
const callTones = new Map();

function describeTone(tone) {
  const secs = (v) => (Number.isFinite(parseFloat(v)) ? `${parseFloat(v).toFixed(1)}s` : '?s');
  if (tone.type === 'hi-low' && Array.isArray(tone.detected)) {
    // Warble: two alternating tones
    return `warble ${Math.round(tone.detected[0])}/${Math.round(tone.detected[1])}Hz (${secs(tone.length)}, ${tone.alternations} alternations)`;
  }
  if (Array.isArray(tone.detected)) {
    // Two-tone sequence [A, B]
    return `${Math.round(tone.detected[0])}Hz (${secs(tone.tone_a_length)}) + ${Math.round(tone.detected[1])}Hz (${secs(tone.tone_b_length)})`;
  }
  if (tone.tone_a && tone.tone_b) {
    return `${tone.tone_a.toFixed(1)}Hz + ${tone.tone_b.toFixed(1)}Hz`;
  }
  const freq = tone.detected ?? tone.frequency;
  if (freq) {
    // Long or pulsed single tone
    return `${Math.round(freq)}Hz (${secs(tone.length)})${tone.cycles ? `, ${tone.cycles} pulses` : ''}`;
  }
  return null;
}

function handleToneDetectionResult(hasTwoTone, detectedTones, transcriptionId, talkGroupID, detectedType = 'unknown') {
  if (hasTwoTone) {
    callTones.set(String(transcriptionId), {
      descriptions: callEmbeds.describeTones(detectedType, (detectedTones || []).map(describeTone)),
      at: Date.now(),
    });
    lastTwoToneTime = Date.now();
    lastDetectedToneGroup = talkGroupID; // Store which talk group had the tone
    
    // Clear any existing queue entries for this talk group to start fresh
    const initialQueueLength = twoToneQueue.length;
    twoToneQueue = twoToneQueue.filter(call => call.talkGroupID !== talkGroupID);
    const removedCount = initialQueueLength - twoToneQueue.length;
    if (removedCount > 0) {
      logger.info(`Cleared ${removedCount} existing queue entries for TG ${talkGroupID} after new tone detection`);
    }
    
    // *** NEW: Check if this call needs address extraction ***
    // If this call was skipped for address extraction earlier, process it now
    if (IS_TWO_TONE_MODE_ENABLED && TWO_TONE_TALK_GROUPS.includes(talkGroupID)) {
      // Get the transcription text from the database to check if it has content
      db.get(`SELECT transcription, system FROM transcriptions WHERE id = ?`, [transcriptionId], async (err, row) => {
        if (!err && row && row.transcription && row.transcription.length >= 15) {
          logger.info(`Tone detected on call ID ${transcriptionId} - checking if address extraction was skipped`);
          
          // Check if this call already has coordinates (meaning address was already processed)
          db.get(`SELECT lat, lon FROM transcriptions WHERE id = ?`, [transcriptionId], async (err2, coordRow) => {
            if (!err2 && coordRow && (coordRow.lat === null || coordRow.lon === null)) {
              logger.info(`Address extraction was skipped for tone call ID ${transcriptionId} - processing now`);
              
              try {
                await extractAndProcessAddress(transcriptionId, row.transcription, talkGroupID, row.system);
                logger.info(`Successfully processed address extraction for tone call ID ${transcriptionId}`);
              } catch (addressError) {
                logger.error(`Error processing address extraction for tone call ID ${transcriptionId}: ${addressError.message}`);
              }
            } else if (!err2 && coordRow && coordRow.lat !== null && coordRow.lon !== null) {
              logger.info(`Address extraction already completed for tone call ID ${transcriptionId}`);
            }
          });
        }
      });
    }

    // Build tone details for the main message
    let toneDetails = '';
    if (detectedTones && detectedTones.length > 0) {
      // Build comprehensive tone details including all detected tones
      const toneDetailsList = [];
      
      detectedTones.forEach((tone) => {
        const description = describeTone(tone);
        if (description) toneDetailsList.push(description);
      });
      
      if (toneDetailsList.length > 0) {
        toneDetails = ` [${detectedType}: ${toneDetailsList.join(' | ')}]`;
      }
    }
    
    logger.info(`Dispatch tone detected on TG ${talkGroupID}!${toneDetails} Next ${TWO_TONE_QUEUE_SIZE_VALUE} calls from this talk group will be checked for addresses`);
    
    // Log additional detected tone frequencies if any
    if (detectedTones && detectedTones.length > 0) {
      detectedTones.forEach((tone, index) => {
        logger.info(`  Tone ${index + 1}: ${describeTone(tone) || JSON.stringify(tone)}`);
      });
    }
  } else {
    logger.info(`No dispatch tone detected for TG ${talkGroupID} (ID: ${transcriptionId})`);
    
    // Clean up stale queue entries when no tone is detected
    cleanStaleQueueEntries();
  }
}

// Clean up stale queue entries (older than 10 minutes)
function cleanStaleQueueEntries() {
  const now = Date.now();
  const staleThreshold = 10 * 60 * 1000; // 10 minutes
  const initialLength = twoToneQueue.length;
  
  twoToneQueue = twoToneQueue.filter(call => {
    const age = now - call.addedAt;
    return age < staleThreshold;
  });
  
  const removedCount = initialLength - twoToneQueue.length;
  if (removedCount > 0) {
    logger.info(`Cleaned ${removedCount} stale queue entries (older than 10 minutes)`);
  }
}

function detectTwoTone(audioFilePath, transcriptionId, talkGroupID, callback) {
  // For non-local modes, use a separate Python process for tone detection
  if (effectiveTranscriptionMode !== 'local') {
    logger.info(`Using standalone tone detection for ${effectiveTranscriptionMode} mode`);
    return detectTwoToneStandalone(audioFilePath, transcriptionId, talkGroupID, callback);
  }
  
  if (!transcriptionProcess) {
    logger.error('Transcription process not available for tone detection');
    if (callback) callback(false, null);
    return;
  }
  
  const requestId = uuidv4();
  pendingToneDetections.set(requestId, {
    transcriptionId,
    talkGroupID,
    audioFilePath,
    callback,
    startTime: Date.now()
  });
  
  logger.info(`Starting tone detection for ID ${transcriptionId} (request: ${requestId})`);
  
  const toneDetectionPayload = {
    command: 'detect_tones',
    id: requestId,
    path: audioFilePath
  };
  
  try {
    transcriptionProcess.stdin.write(JSON.stringify(toneDetectionPayload) + '\n');
  } catch (error) {
    logger.error(`Error sending tone detection command: ${error.message}`);
    pendingToneDetections.delete(requestId);
    if (callback) callback(false, error);
  }
}

// *** NEW: Queue-based tone detection to prevent race conditions ***
function detectTwoToneQueued(audioFilePath, transcriptionId, talkGroupID, callback) {
  // Add to queue instead of running immediately
  toneDetectionQueue.push({
    audioFilePath,
    transcriptionId,
    talkGroupID,
    callback,
    addedAt: Date.now()
  });
  
  logger.info(`Queued tone detection for ID ${transcriptionId} (queue length: ${toneDetectionQueue.length})`);
  
  // Start processing if not already running
  if (!isProcessingToneDetection) {
    processNextToneDetection();
  }
}

function processNextToneDetection() {
  if (toneDetectionQueue.length === 0 || isProcessingToneDetection) {
    return;
  }
  
  isProcessingToneDetection = true;
  const request = toneDetectionQueue.shift();
  
  logger.info(`Processing tone detection for ID ${request.transcriptionId} (queue length: ${toneDetectionQueue.length})`);
  
  // Use the standalone detection function
  detectTwoToneStandalone(request.audioFilePath, request.transcriptionId, request.talkGroupID, (hasTwoTone, detectedTones, detectedType) => {
    // Call the original callback
    if (request.callback) {
      request.callback(hasTwoTone, detectedTones, detectedType);
    }
    
    // Mark as done and process next
    isProcessingToneDetection = false;
    
    // Process next request if any
    if (toneDetectionQueue.length > 0) {
      setImmediate(() => processNextToneDetection());
    }
  });
}

function detectTwoToneStandalone(audioFilePath, transcriptionId, talkGroupID, callback) {
  const { spawn } = require('child_process');
  
  logger.info(`Starting standalone tone detection for ID ${transcriptionId}`);
  
  // Same interpreter resolution as the transcription worker: an explicit
  // PYTHON_COMMAND wins, otherwise prefer the project .venv over bare 'python'.
  let pythonCommand = PYTHON_COMMAND || 'python';
  const isBareDefault = !PYTHON_COMMAND || /^python(3(\.\d+)?)?$/i.test(String(PYTHON_COMMAND).trim());
  if (isBareDefault) {
    const { venvPython } = require('./src/setup/pythonEnv');
    if (fs.existsSync(venvPython())) pythonCommand = venvPython();
  }
  
  logger.info(`Using Python command: ${pythonCommand}`);
  logger.info(`Running: ${pythonCommand} tone_detect.py "${audioFilePath}"`);
  const toneArgs = [
    'tone_detect.py',
    audioFilePath
  ];
  
  // The child inherits process.env, so tone_detect.py reads the TONE_*,
  // TWO_TONE_*, PULSED_* and LONG_TONE_* settings directly. (Re-exporting the
  // parsed values here turned unset numbers into the string "NaN".)
  const env = { ...process.env };
  
  try {
    const toneProcess = spawn(pythonCommand, toneArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env,
      timeout: 30000 // 30 second timeout
    });
    
    let output = '';
    let errorOutput = '';
    
    toneProcess.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    toneProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    toneProcess.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(output);
          const hasTwoTone = result.has_two_tone || false;
          
          const detectedTones = Array.isArray(result.detected_tones) ? result.detected_tones : [];
          const detectedType = result.detected_type || 'unknown';
          if (result.error) {
            logger.warn(`Tone detection reported an error for ID ${transcriptionId}: ${result.error}`);
          }
          
          logger.info(`Standalone tone detection result for ID ${transcriptionId}: ${hasTwoTone} (${detectedTones.length} tones)`);
          
          // Log stderr output for debugging
          if (errorOutput.trim()) {
            logger.info(`Tone detection stderr output: ${errorOutput.trim()}`);
          }
          
          // Log stdout for debugging
          if (output.trim()) {
            logger.info(`Tone detection stdout output: ${output.trim()}`);
          }
          
          // Note: Don't process the result here - let the callback handle it via handleToneDetectionResult()
          
          if (callback) {
            callback(hasTwoTone, detectedTones, detectedType);
          }
        } catch (parseError) {
          logger.error(`Error parsing tone detection output: ${parseError.message}`);
          logger.error(`Raw output: ${output}`);
          if (callback) callback(false, null, 'unknown');
        }
      } else {
        logger.error(`Standalone tone detection failed with code ${code}`);
        logger.error(`Error output: ${errorOutput}`);
        if (callback) callback(false, null, 'unknown');
      }
    });
    
    toneProcess.on('error', (error) => {
      logger.error(`Standalone tone detection process error: ${error.message}`);
      if (callback) callback(false, null, 'unknown');
    });
    
  } catch (error) {
    logger.error(`Error starting standalone tone detection: ${error.message}`);
    if (callback) callback(false, null, 'unknown');
  }
}

function handleLocalToneDetectionResult(result) {
  const requestId = result.id;
  const pendingDetection = pendingToneDetections.get(requestId);
  
  if (!pendingDetection) {
    logger.warn(`Received tone detection result for unknown request: ${requestId}`);
    return;
  }
  
  pendingToneDetections.delete(requestId);
  
  const { transcriptionId, talkGroupID, callback } = pendingDetection;
  const hasTwoTone = result.has_two_tone || false;
  const detectedTones = result.detected_tones || [];
  
  logger.info(`Tone detection result for ID ${transcriptionId}: ${hasTwoTone} (${detectedTones.length} tones)`);
  
  if (hasTwoTone) {
    lastTwoToneTime = Date.now();
    lastDetectedToneGroup = talkGroupID; // Store which talk group had the tone
    logger.info(`Tone detected on TG ${talkGroupID}! Next ${TWO_TONE_QUEUE_SIZE_VALUE} calls from this talk group will be checked for addresses`);
    
    // Log detected tone frequencies
    detectedTones.forEach((tone, index) => {
      logger.info(`  Tone ${index + 1}: ${describeTone(tone) || JSON.stringify(tone)}`);
    });
  }
  
  if (callback) {
    callback(hasTwoTone, detectedTones, result.detected_type || 'unknown');
  }
}

// Whitelist patterns for console INFO messages
const allowedPatterns = [
  // Core dispatch information
  /^--- Incoming Request ---$/,
  /^Talk Group: .+ - .+$/,
  /^Geocoded Address: ".+" with coordinates \(.+, .+\) in .+$/,
  /^Extracted Address:/,

  // Startup & shutdown messages
  /^Shutting down gracefully...$/,
  /^Express server closed.$/,
  /^Discord bot disconnected.$/,
  /^Database connection closed.$/,
  /^Loaded \d+ talk groups from environment variables$/,
  /^Using upload directory: .+$/,
  /^Loaded \d+ API keys.$/,
  /^Starting persistent transcription process \(local mode\)...$/,
  /^Local transcription process spawned, waiting for ready signal...$/,
  /^Local transcription service ready$/,
  /^Bot server is running on port \d+$/,
  /^Connected to SQLite database.$/,
  /^Using talk groups from environment variables. Found \d+ talk groups$/,
  /^Loaded \d+ talk groups for geocoding$/,
  /^Logged in as .+!$/,
  /^Started refreshing application \(\/\) commands.$/,
  /^Successfully reloaded application \(\/\) commands.$/,
  /^Summary channel is ready.$/,
  /^Initializing local transcription process...$/,
  /^Transcription mode set to 'remote'/,
  /^FATAL: TRANSCRIPTION_MODE is remote, but FASTER_WHISPER_SERVER_URL is not set!/,

  // Transcription Text - KEEP THIS
  /^Transcription Text:/,

  // Essential Processing Messages (Uncomment the ones you want to see)
  // /^Received SDRTrunk audio:/,
  // /^Received TrunkRecorder audio:/,
  // /^Saved audio blob for transcription ID/,
  // /^Initiating transcription for/, // <--- COMMENTED OUT THIS LINE
  // /^Updated DB transcription for ID/,
  // /^Successfully processed:/,
  // /^Sent alert message/,
  // /^Playing audio for talk group/,
  // /^Updated summary embed message/,
  // /^Created new summary embed message/,
  // /^Requesting remote model:/,
  // /^Sending remote transcription request for/,
  // /^Received remote transcription for/,

  // Add specific essential INFO messages you *do* want to see below:
  
  // Two-tone detection messages (only the main alert)
  /^Dispatch tone detected on TG \d+!/,

];

// Logger setup
const logger = winston.createLogger({
  level: 'info', // Log info and above to files
  format: winston.format.combine(
    // Default format for files (timestamp + standard json/logfmt)
    winston.format.timestamp({
      format: () => moment().tz(TIMEZONE).format('MM/DD/YYYY HH:mm:ss.SSS')
    }),
    winston.format.errors({ stack: true }), // Log stack traces for errors
    winston.format.splat(),
    winston.format.json() // Log to files as JSON
  ),
  transports: [
    // Daily-rotated JSON files in ./logs (see src/logger.js, LOG_RETENTION_DAYS)
    ...getFileTransports(),

    // Console: shared layout (src/consoleFormat.js); INFO lines only when they
    // match allowedPatterns, or when logged with { console: true }
    new winston.transports.Console({
      level: 'info',
      format: consoleFormat({
        source: 'bot',
        filter: (info) => info.level !== 'info' || consoleShowsAllInfo() ||
          allowedPatterns.some((pattern) => pattern.test(info.message)),
      }),
    })
  ]
});
llmQueue.setLogger({ warn: (m) => logger.warn(m), info: (m) => logger.info(m, { console: true }) });

// --- Storage backend (local | s3 | r2 | b2 | minio | db) ---
let storage = null;
let STORAGE_USES_DB, STORAGE_IS_LOCAL, STORAGE_DEFERS_TEMP_CLEANUP;
// (Re)create the storage backend from the current settings. Calls already
// saved keep the backend recorded on their row.
function initStorage() {
  STORAGE_USES_DB = isDbMode(process.env);
  try {
    storage = createStorage(process.env); // null only when STORAGE_MODE=db
    logger.info(`[Bot] Storage mode: ${STORAGE_MODE || 'local'}${storage ? ` (${storage.type})` : ' (sqlite blob)'}`);
  } catch (e) {
    logger.error(`[Bot] Storage init failed: ${e.message}. Falling back to local.`);
    storage = createStorage({ STORAGE_MODE: 'local' });
  }
  // True when audio lives on local disk (temp file becomes the permanent file).
  STORAGE_IS_LOCAL = !!storage && storage.type === 'local';
  // When NOT local (remote object storage OR sqlite blob), keep the temp file
  // until transcription finishes and use the in-memory buffer for local Whisper.
  STORAGE_DEFERS_TEMP_CLEANUP = !STORAGE_IS_LOCAL;
}
initStorage();
// --- END Storage Setup ---

// --- INITIALIZATION FUNCTIONS ---

// Function to check if talkgroups have been imported
function checkTalkGroupsImported() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM talk_groups', (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row.count > 0);
      }
    });
  });
}

// Function to import talkgroups from CSV
function importTalkGroups() {
  return new Promise((resolve, reject) => {
    const talkGroupsFile = path.join(__dirname, 'talkgroups.csv');
    
    if (!fs.existsSync(talkGroupsFile)) {
      logger.warn('talkgroups.csv not found. Skipping talkgroup import.');
      resolve();
      return;
    }

    logger.info('Importing talkgroups from CSV...');
    let importCount = 0;

    fs.createReadStream(talkGroupsFile)
      .pipe(csv({
        headers: ['DEC', 'HEX', 'Alpha Tag', 'Mode', 'Description', 'Tag', 'County'],
        skipLines: 0,
      }))
      .on('data', (row) => {
        const id = parseInt(row['DEC'], 10);
        const hex = row['HEX'];
        const alphaTag = row['Alpha Tag'];
        const mode = row['Mode'];
        const description = row['Description'];
        const tag = row['Tag'];
        const county = row['County'];

        db.run(
          `INSERT OR REPLACE INTO talk_groups (id, system, hex, alpha_tag, mode, description, tag, county) VALUES (?, '', ?, ?, ?, ?, ?, ?)`,
          [id, hex, alphaTag, mode, description, tag, county],
          (err) => {
            if (err) {
              logger.error('Error inserting talk group:', err.message);
            } else {
              importCount++;
            }
          }
        );
      })
      .on('end', () => {
        logger.info(`Successfully imported ${importCount} talkgroups.`);
        resolve();
      })
      .on('error', (err) => {
        logger.error('Error importing talkgroups:', err);
        reject(err);
      });
  });
}

// Function to ensure API key exists
function ensureApiKey() {
  return new Promise((resolve, reject) => {
    try {
      // Ensure directory exists
      const apiKeyDir = path.dirname(API_KEY_FILE);
      if (!fs.existsSync(apiKeyDir)) {
        fs.mkdirSync(apiKeyDir, { recursive: true });
      }

      if (!fs.existsSync(API_KEY_FILE)) {
        // Create a default API key
        const defaultKey = uuidv4();
        const hashedKey = bcrypt.hashSync(defaultKey, 10);
        const initialApiKeys = [{ 
          key: hashedKey, 
          name: 'Default', 
          disabled: false,
          created_at: new Date().toISOString(),
          description: 'Auto-generated API key for first boot'
        }];
        
        fs.writeFileSync(API_KEY_FILE, JSON.stringify(initialApiKeys, null, 2));
        
        logger.info(`Created default API key: ${defaultKey}`);
        logger.info(`API key saved to: ${API_KEY_FILE}`);
        logger.warn('IMPORTANT: Save this API key as it won\'t be shown again!');
        resolve(defaultKey);
      } else {
        logger.info('API key file already exists.');
        resolve(null);
      }
    } catch (err) {
      logger.error('Error ensuring API key:', err);
      reject(err);
    }
  });
}

// Function to initialize database tables
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    logger.info('Initializing database tables...');
    
    db.serialize(() => {
      let tablesCreated = 0;
      let totalTables = ENABLE_AUTH?.toLowerCase() === 'true' ? 7 : 5;
      
      const tableCreated = (err, tableName) => {
        if (err) {
          logger.error(`Error creating ${tableName} table:`, err);
          reject(err);
          return;
        }
        tablesCreated++;
        if (tablesCreated === totalTables) {
          logger.info('Database tables initialized successfully.');
          resolve();
        }
      };

      db.run(`CREATE TABLE IF NOT EXISTS transcriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        talk_group_id TEXT,
        system TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        transcription TEXT,
        audio_file_path TEXT,
        address TEXT,
        lat REAL,
        lon REAL,
        category TEXT
      )`, (err) => tableCreated(err, 'transcriptions'));

      db.run(`CREATE TABLE IF NOT EXISTS global_keywords (
        keyword TEXT UNIQUE,
        talk_group_id TEXT
      )`, (err) => tableCreated(err, 'global_keywords'));

      // Talkgroup IDs are only unique WITHIN a radio system, so the key is the
      // pair (system, id). 'system' defaults to '' for legacy/single-system data,
      // which the lookups treat as a wildcard for backward compatibility.
      db.run(`CREATE TABLE IF NOT EXISTS talk_groups (
        id TEXT NOT NULL,
        system TEXT NOT NULL DEFAULT '',
        hex TEXT,
        alpha_tag TEXT,
        mode TEXT,
        description TEXT,
        tag TEXT,
        county TEXT,
        PRIMARY KEY (system, id)
      )`, (err) => tableCreated(err, 'talk_groups'));

      db.run(`CREATE TABLE IF NOT EXISTS frequencies (
        id INTEGER PRIMARY KEY,
        frequency TEXT,
        description TEXT
      )`, (err) => tableCreated(err, 'frequencies'));

      db.run(`CREATE TABLE IF NOT EXISTS audio_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transcription_id INTEGER,
        audio_data BLOB,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(transcription_id) REFERENCES transcriptions(id)
      )`, (err) => tableCreated(err, 'audio_files'));

      // Authentication tables (if auth is enabled)
      if (ENABLE_AUTH?.toLowerCase() === 'true') {
        db.run(`CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          salt TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, (err) => tableCreated(err, 'users'));

        db.run(`CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          token TEXT UNIQUE NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NOT NULL,
          last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
          ip_address TEXT,
          user_agent TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`, (err) => tableCreated(err, 'sessions'));
      }
    });
  });
}

// Set the admin user's sign-in password to WEBSERVER_PASSWORD (after it changed
// in Settings), creating the user if needed.
function updateAdminPassword() {
  if (ENABLE_AUTH?.toLowerCase() !== 'true' || !WEBSERVER_PASSWORD) return;
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.pbkdf2Sync(WEBSERVER_PASSWORD, salt, 10000, 64, 'sha512').toString('hex');
  db.run('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?', [passwordHash, salt, 'admin'], function (err) {
    if (err) return logger.error(`Could not update the admin password: ${err.message}`);
    if (this.changes) logger.info('Admin password updated from Settings.', { console: true });
    else createAdminUser().catch((e) => logger.error(`Could not create the admin user: ${e.message}`));
  });
}

// Function to create admin user if authentication is enabled
function createAdminUser() {
  return new Promise((resolve, reject) => {
    if (ENABLE_AUTH?.toLowerCase() !== 'true') {
      logger.info('Authentication disabled, skipping admin user creation.');
      resolve();
      return;
    }

    if (!WEBSERVER_PASSWORD) {
      logger.error('WEBSERVER_PASSWORD not set but authentication is enabled!');
      reject(new Error('WEBSERVER_PASSWORD required when ENABLE_AUTH=true'));
      return;
    }

    // Check if admin user already exists
    db.get('SELECT id FROM users WHERE username = ?', ['admin'], (err, row) => {
      if (err) {
        logger.error('Error checking for admin user:', err);
        reject(err);
        return;
      }

      if (row) {
        logger.info('Admin user already exists in database.');
        resolve();
        return;
      }

      // Create admin user
      const salt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto
        .pbkdf2Sync(WEBSERVER_PASSWORD, salt, 10000, 64, 'sha512')
        .toString('hex');

      db.run(
        'INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)',
        ['admin', passwordHash, salt],
        function(err) {
          if (err) {
            logger.error('Error creating admin user:', err);
            reject(err);
          } else {
            logger.info('Created admin user for webserver authentication (username=admin).');
            resolve();
          }
        }
      );
    });
  });
}

// Function to start webserver as child process
let webserverChild = null;
function startWebserver() {
  return new Promise((resolve, reject) => {
    logger.info('Starting webserver...');
    
    const webserverProcess = spawn(process.execPath, [path.join(__dirname, 'webserver.js')], {
      stdio: 'inherit',
      env: { ...process.env, SCANNER_ENV_OVERRIDDEN: liveEnv.overriddenKeys().join(',') }
    });
    webserverChild = webserverProcess;

    webserverProcess.on('error', (err) => {
      logger.error('Failed to start webserver:', err);
      reject(err);
    });

    // Give the webserver a moment to start
    setTimeout(() => {
      logger.info(`Webserver started on port ${WEBSERVER_PORT}`);
      resolve(webserverProcess);
    }, 2000);
  });
}

// Restart the web server so it picks up changed settings (it reads them once
// at startup). Browsers reconnect on their own.
async function restartWebserver() {
  const old = webserverChild;
  if (!old) return;
  webserverChild = null;
  logger.info('Restarting the web server to apply changed settings...', { console: true });
  await new Promise((resolve) => {
    const done = setTimeout(resolve, 5000);
    old.once('exit', () => { clearTimeout(done); resolve(); });
    try { old.kill(); } catch (_) { clearTimeout(done); resolve(); }
  });
  await startWebserver();
}

// Main initialization function
async function initializeBot() {
  try {
    logger.info('Starting bot initialization...');

    // Step 1: Initialize database
    await initializeDatabase();

    // Step 1b: Ensure performance indexes + storage columns
    await runMigrations(db).catch((e) => logger.error(`Migrations failed: ${e.message}`));

    // Step 2: Ensure API key exists
    const newApiKey = await ensureApiKey();
    if (newApiKey) {
      // Log the new API key one more time for visibility
      console.log('='.repeat(60));
      console.log('NEW API KEY GENERATED:');
      console.log(newApiKey);
      console.log('Please save this key - it will not be shown again!');
      console.log('='.repeat(60));
    }

    // Step 3: Check and import talkgroups if needed
    const talkGroupsExist = await checkTalkGroupsImported();
    if (!talkGroupsExist) {
      await importTalkGroups();
    } else {
      logger.info('Talkgroups already imported, skipping CSV import.');
    }

    // Step 4: Load talkgroups for geocoding
    const { loadTalkGroups, loadStreetGazetteer, loadPlaceList } = require('./geocoding');
    const talkGroups = await loadTalkGroups(db);
    Object.assign(TALK_GROUPS, talkGroups);
    logger.info(`Loaded ${Object.keys(TALK_GROUPS).length} talk groups for geocoding`);
    // Local street names for correcting misheard streets; refreshed daily as more calls are geocoded
    await loadStreetGazetteer(db);
    setInterval(() => loadStreetGazetteer(db), 24 * 60 * 60 * 1000);
    // Local named places for places the geocoder can't find (fetched in the
    // background; refreshed weekly)
    loadPlaceList().catch(() => {});
    setInterval(() => loadPlaceList().catch(() => {}), 24 * 60 * 60 * 1000);
    // Missed calls still to look up from before a restart (src/ai/catchUp.js)
    setTimeout(() => aiCatchUp.run(), 30000);

    // Step 5: Load API keys
    loadApiKeys();

    // Step 6: Create admin user for webserver if auth is enabled
    await createAdminUser();

    // Step 7: Start bot services (Discord and Express API)
    await startBotServices();

    // Step 8: Start webserver last (always start it - it serves the map UI and
    // the setup wizard; geocoding is optional and only affects address search).
    if (WEBSERVER_PORT) {
      if (!GOOGLE_MAPS_API_KEY && !LOCATIONIQ_API_KEY) {
        logger.warn('No geocoding API key set - address search disabled, but the map will still run.');
      }
      await startWebserver();
    } else {
      logger.warn('Webserver not started: WEBSERVER_PORT not configured');
    }

    logger.info('Bot initialization completed successfully!');
    return true;
  } catch (error) {
    logger.error('Bot initialization failed:', error);
    throw error;
  }
}

// --- END INITIALIZATION FUNCTIONS ---

const {
  Client,
  IntentsBitField,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  Collection,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,       // <-- Add this
  TextInputBuilder,   // <-- Add this
  TextInputStyle,     // <-- Add this
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  NoSubscriberBehavior,
  entersState,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { MessageFlags } = require('discord.js');

// Import the geocoding module
const geocodingModule = require('./geocoding');
const { extractAddress, geocodeAddress, hyperlinkAddress, loadTalkGroups } = geocodingModule;

// Express app setup
const app = express();
const PORT_NUM = parseInt(PORT, 10);

// Discord client setup
const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildVoiceStates,
  ],
});

// Global variables
let alertChannel;
const UPLOAD_DIR = path.join(__dirname, 'audio');
let transcriptionQueue = [];
let activeTranscriptions = 0;
let isBootComplete = false;
const messageCache = new Map(); // Stores the latest message for each channel
const MESSAGE_COOLDOWN = 15000; // 15 seconds in milliseconds
let transcriptionProcess = null;
let isProcessingTranscription = false;
let currentTranscriptionId = null; // Track current transcription for timeout
let transcriptionTimeout = null; // Timeout for current transcription
const TRANSCRIPTION_TIMEOUT_MS = 90000; // 1.5 minutes timeout per transcription (reduced for busy systems)
let processHealthCheck = null; // Health check interval
let lastProcessActivity = Date.now(); // Track when we last heard from Python process
let queueWarningLogged = false; // Prevent spam logging of queue warnings
let lastQueueSizeLog = 0; // Track last queue size for change detection

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

logger.info(`Using upload directory: ${UPLOAD_DIR}`);

// Database setup (will be initialized properly in initializeBot function)
const db = new sqlite3.Database('./botdata.db', (err) => {
  if (err) {
    logger.error('Error opening database:', err.message);
    process.exit(1);
  } else {
    logger.info('Connected to SQLite database.');
    // Trigger initialization after database connection
    initializeBot().catch((error) => {
      logger.error('Fatal error during bot initialization:', error);
      process.exit(1);
    });
  }
});

// Load API keys (will be called from initialization)
let apiKeys = [];
const loadApiKeys = () => {
  try {
    if (fs.existsSync(API_KEY_FILE)) {
      const data = fs.readFileSync(API_KEY_FILE, 'utf8');
      apiKeys = JSON.parse(data);
      logger.info(`Loaded ${apiKeys.length} API keys.`);
    } else {
      logger.warn('API key file not found. This should have been created during initialization.');
      apiKeys = [];
    }
  } catch (err) {
    logger.error('Error loading API keys:', err);
    apiKeys = [];
  }
};

// Helper Functions
const validateApiKey = async (key) => {
  //logger.info(`Validating API key: ${key.substring(0, 3)}...`);
  for (let apiKey of apiKeys) {
    if (!apiKey.disabled) {
      const match = await bcrypt.compare(key, apiKey.key);
      if (match) {
        //logger.info('API key validation successful');
        return apiKey;
      }
    }
  }
  logger.error('API key validation failed');
  return null;
};

const generateCustomFilename = (fields, originalFilename) => {
  const date = new Date(parseInt(fields.dateTime) * 1000);
  const dateStr = date
    .toISOString()
    .replace(/[-:]/g, '')
    .split('.')[0]
    .replace('T', '_');
  const systemName = fields.systemLabel
    ? fields.systemLabel.replace(/[^a-zA-Z0-9]/g, '_')
    : 'Unknown_System';
  const talkgroupInfo = fields.talkgroupLabel
    ? fields.talkgroupLabel.replace(/[^a-zA-Z0-9]/g, '_')
    : 'Unknown_Talkgroup';
  const talkgroup = fields.talkgroup || 'Unknown';
  const source = fields.source || 'Unknown';
  
  // Get the file extension - either from the original file or use appropriate default
  // TrunkRecorder sends M4A files, others typically send MP3
  let extension;
  if (originalFilename) {
    extension = path.extname(originalFilename).toLowerCase();
    if (!extension || extension === '.') {
      // If we're missing a valid extension
      extension = fields.audioType === 'audio/mp4' ? '.m4a' : '.mp3';
    }
  } else {
    extension = fields.audioType === 'audio/mp4' ? '.m4a' : '.mp3';
  }
  
  // Force mp3 extension for PCM files
  if (isIgnoredFileType(originalFilename)) {
    extension = '.mp3';
  }

  return `${dateStr}_${systemName}_${talkgroupInfo}_TO_${talkgroup}_FROM_${source}${extension}`;
};

// Express Middleware
app.use(express.json());

app.use((req, res, next) => {
  // Avoid logging full headers (they can contain API keys / auth tokens).
  logger.debug(`Incoming ${req.method} ${req.url} from ${req.ip || req.connection?.remoteAddress || 'unknown'}`);
  next();
});

const isIgnoredFileType = (filename) => {
  const extension = path.extname(filename).toLowerCase();
  return extension === '.pcm'; // Only ignore PCM files, allow MP3 and M4A
};

// Route: /api/call-upload
app.post('/api/call-upload', (req, res) => {
  logger.info(`Handling /api/call-upload`);
  
  // Create a simple flag to track if we've sent a response
  let hasResponded = false;
  
  // Function to safely send a response (prevents multiple response errors)
  const sendResponse = (status, message) => {
    if (!hasResponded) {
      hasResponded = true;
      res.status(status).send(message);
    }
  };
  
  // Create a very simple test request detector
  if (req.headers['user-agent'] === 'sdrtrunk') {
    // Set up a parser just for SDRTrunk requests
    const bb = busboy({ headers: req.headers });
    let isTestRequest = false;
    let hasFields = false;
    let hasFile = false;
    let fields = {};
    let fileInfo = null;
    let fileBuffer = null;
    
    // Fast detection of test field
    bb.on('field', (name, val) => {
      hasFields = true;
      fields[name] = val;
      
      if (name === 'test' && val === '1') {
        isTestRequest = true;
        // Immediately respond to test requests
        logger.info('SDRTrunk test request detected, sending response');
        sendResponse(200, 'incomplete call data: no talkgroup');
        bb.destroy(); // Stop parsing
      }
    });
    
    bb.on('file', (name, file, info) => {
      hasFile = true;
      fileInfo = { originalFilename: info.filename };
      
      if (isTestRequest) {
        file.resume(); // Skip processing for test requests
        return;
      }
      
      // ADD CHECK for field name
      if (name !== 'file' && name !== 'audio') {
          logger.warn(`Ignoring unexpected file part with fieldname: ${name}`);
          file.resume(); // Consume the stream but do nothing
          return;
      }
      // END ADD CHECK

      if (isIgnoredFileType(info.filename)) {
        logger.info(`Ignoring unsupported file type: ${info.filename}`);
        file.resume();
        return;
      }
      
      const chunks = [];
      file.on('data', (chunk) => {
        chunks.push(chunk);
      });
      file.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });
    
    bb.on('close', async () => {
      // If we already responded to a test request, just return
      if (hasResponded) return;
      
      // If it's a test request or has no fields/file, respond with no talkgroup
      if (isTestRequest || !hasFields || !hasFile) {
        logger.info('SDRTrunk request without proper data, sending test response');
        return sendResponse(200, 'incomplete call data: no talkgroup');
      }
      
      // This is a real SDRTrunk upload, process it
      logger.info('Processing SDRTrunk audio upload');
      
      // Extract source from filename if it's in the SDRTrunk format
      if (fileInfo && fileInfo.originalFilename && fileInfo.originalFilename.includes('FROM_')) {
        const fromMatch = fileInfo.originalFilename.match(/FROM_(\d+)/);
        if (fromMatch && fromMatch[1]) {
          fields.source = fromMatch[1];
        }
      }
      
      // API key validation
      if (!fields.key) {
        return sendResponse(400, 'API key is missing.');
      }
      
      try {
        const apiKey = await validateApiKey(fields.key);
        if (!apiKey) {
          return sendResponse(401, 'Invalid or disabled API key.');
        }
        
        if (fileInfo && fileBuffer) {
          const customFilename = generateCustomFilename(fields, fileInfo.originalFilename);
          const saveTo = path.join(UPLOAD_DIR, customFilename);
          
          fs.writeFile(saveTo, fileBuffer, (err) => {
            if (err) {
              logger.error('Error saving file:', err);
              return sendResponse(500, 'Error saving file');
            }
            
            logger.info(`Received SDRTrunk audio: ${customFilename}`);
            
            handleNewAudio({
              filename: customFilename,
              path: saveTo,
              talkGroupID: fields.talkgroup,
              systemName: fields.systemLabel,
              talkGroupName: fields.talkgroupLabel,
              dateTime: fields.dateTime, // Pass the original fields.dateTime for SDRTrunk
              source: fields.source,
              talkerAlias: fields.talkerAlias, // Add talkerAlias field from SDRTrunk
              frequency: fields.frequency,
              talkGroupGroup: fields.talkgroupGroup,
              isTrunkRecorder: false
            });
            
            return sendResponse(200, 'Call imported successfully.');
          });
        } else {
          return sendResponse(200, 'incomplete call data: no audio file');
        }
      } catch (error) {
        logger.error('Error processing SDRTrunk request:', error);
        return sendResponse(500, 'Error processing request');
      }
    });
    
    req.pipe(bb);
  } else {
    // Handle TrunkRecorder or other uploads
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: 2 * 1024 * 1024 * 1024 }
    });
    
    let fields = {};
    let fileInfo = null;
    let fileBuffer = null;
    let isTrunkRecorder = true; // Default to TrunkRecorder for non-SDRTrunk requests
    
    bb.on('file', (name, file, info) => {
      fileInfo = { originalFilename: info.filename };
      
      if (isIgnoredFileType(info.filename)) {
        logger.info(`Ignoring unsupported file type: ${info.filename}`);
        file.resume();
        return;
      }
      
      const chunks = [];
      file.on('data', (chunk) => {
        chunks.push(chunk);
      });
      file.on('end', () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });
    
    bb.on('field', (name, val) => {
      fields[name] = val;
      
      // Log all field names to see what we're receiving (for debugging)
      if (name === 'meta' || name === 'srcList' || name === 'freqList' || name === 'sources') {
        logger.info(`[FIELD RECEIVED] Field: ${name}, length: ${val ? val.length : 0}, preview: ${val ? val.substring(0, 200) : 'null'}`);
      }
      
      // Log first few fields to understand the structure
      const fieldCount = Object.keys(fields).length;
      if (fieldCount <= 5) {
        logger.info(`[FIELDS PROGRESS] Received ${fieldCount} fields so far: ${Object.keys(fields).join(', ')}`);
      }
      
      // Handle TrunkRecorder's meta field (full JSON metadata)
      if (name === 'meta' && val && val.trim() !== '') {
        try {
          const metaData = JSON.parse(val);
          logger.info(`[META PARSE] Parsed TrunkRecorder meta field, has srcList: ${!!metaData.srcList}, has freqList: ${!!metaData.freqList}`);
          if (metaData.srcList) {
            logger.info(`[META PARSE] srcList is array: ${Array.isArray(metaData.srcList)}, length: ${metaData.srcList.length}`);
          }
          
          // Extract all useful metadata from the JSON
          if (metaData.freq) fields.frequency = metaData.freq;
          if (metaData.freq_error !== undefined) fields.freq_error = metaData.freq_error;
          if (metaData.signal !== undefined) fields.signal = metaData.signal;
          if (metaData.noise !== undefined) fields.noise = metaData.noise;
          if (metaData.emergency !== undefined) fields.emergency = metaData.emergency;
          if (metaData.priority !== undefined) fields.priority = metaData.priority;
          if (metaData.encrypted !== undefined) fields.encrypted = metaData.encrypted;
          if (metaData.call_length !== undefined) fields.call_length = metaData.call_length;
          if (metaData.start_time) fields.start_time = metaData.start_time;
          if (metaData.stop_time) fields.stop_time = metaData.stop_time;
          if (metaData.tdma_slot !== undefined) fields.tdma_slot = metaData.tdma_slot;
          if (metaData.phase2_tdma !== undefined) fields.phase2_tdma = metaData.phase2_tdma;
          if (metaData.color_code !== undefined) fields.color_code = metaData.color_code;
          
          // Store the full meta JSON for later processing
          fields.meta = val;
          
          // Extract source from srcList (better than sources field)
          if (metaData.srcList && Array.isArray(metaData.srcList) && metaData.srcList.length > 0) {
            // Find the first valid source (not -1)
            const validSource = metaData.srcList.find(src => src.src && src.src !== -1);
            if (validSource) {
              fields.source = validSource.src.toString();
              logger.info(`Extracted source ID from srcList: ${fields.source}`);
              
              // Extract OTA alias tag if available (Motorola OTA feature)
              if (validSource.tag && validSource.tag.trim() !== '') {
                fields.talkerAlias = validSource.tag.trim();
                logger.info(`Extracted OTA alias from srcList: ${fields.talkerAlias}`);
              }
            }
            
            // Store srcList for detailed source tracking
            fields.srcList = JSON.stringify(metaData.srcList);
            logger.info(`[META PARSE] Stored srcList with ${metaData.srcList.length} entries for merged call detection`);
          } else {
            logger.warn(`[META PARSE] srcList not found or empty in meta field`);
          }
          
          // Extract freqList for error/spike analysis
          if (metaData.freqList && Array.isArray(metaData.freqList)) {
            fields.freqList = JSON.stringify(metaData.freqList);
            logger.info(`Extracted freqList with ${metaData.freqList.length} entries`);
          }
          
        } catch (error) {
          logger.error('Error parsing TrunkRecorder meta JSON:', error);
        }
      }
      
      // Handle TrunkRecorder's sources JSON field
      // IMPORTANT: TrunkRecorder sends "sources" field, not "srcList"!
      if (name === 'sources') {
        logger.info(`[SOURCES FIELD] Received sources field, length: ${val ? val.length : 0}, preview: ${val ? val.substring(0, 150) : 'null'}`);
        if (val && val.trim() !== '' && val.trim() !== '[]') {
          try {
            const sources = JSON.parse(val);
            if (sources && Array.isArray(sources) && sources.length > 0) {
              // Store as srcList for merged call detection
              fields.srcList = val;
              logger.info(`[SOURCES FIELD] Stored sources as srcList with ${sources.length} entries for merged call detection`);
            
            // Extract source if not already set
            if (!fields.source && sources[0].src) {
              fields.source = sources[0].src.toString();
              logger.info(`Extracted source ID from TrunkRecorder sources field: ${fields.source}`);
              
              // Extract OTA alias tag if available (Motorola OTA feature)
              if (sources[0].tag && sources[0].tag.trim() !== '') {
                fields.talkerAlias = sources[0].tag.trim();
                logger.info(`Extracted OTA alias from TrunkRecorder sources: ${fields.talkerAlias}`);
              }
            }
          }
        } catch (error) {
          logger.error('Error parsing TrunkRecorder sources JSON:', error);
        }
        } else {
          logger.warn(`[SOURCES FIELD] sources field is empty or just "[]"`);
        }
      }
      
      // Also check for srcList as a direct field (alternative format - NOT used by TrunkRecorder)
      // NOTE: TrunkRecorder transforms its internal srcList into "sources" field format.
      // This check is only for other potential upload formats that might send srcList directly.
      if (name === 'srcList' && val && val.trim() !== '' && val.trim() !== '[]') {
        try {
          const srcList = JSON.parse(val);
          if (Array.isArray(srcList) && srcList.length > 0) {
            // Only extract source if not already set
            if (!fields.source) {
              const validSource = srcList.find(src => src.src && src.src !== -1);
              if (validSource) {
                fields.source = validSource.src.toString();
                logger.info(`Extracted source ID from srcList field: ${fields.source}`);
                
                if (validSource.tag && validSource.tag.trim() !== '') {
                  fields.talkerAlias = validSource.tag.trim();
                  logger.info(`Extracted OTA alias from srcList field: ${fields.talkerAlias}`);
                }
              }
            }
            // Always store srcList for merged call detection, even if source was already set
            fields.srcList = val;
            logger.info(`[DIRECT FIELD] Stored srcList from direct field with ${srcList.length} entries`);
          }
        } catch (error) {
          logger.error('Error parsing TrunkRecorder srcList JSON:', error);
        }
      }
      
      // Handle frequencies field (TrunkRecorder sends "frequencies", not "freqList")
      // IMPORTANT: TrunkRecorder sends "frequencies" field, not "freqList"!
      if (name === 'frequencies' && val && val.trim() !== '' && val.trim() !== '[]') {
        try {
          const freqList = JSON.parse(val);
          if (Array.isArray(freqList)) {
            // Store as freqList for consistency
            fields.freqList = val;
            // Also store as frequencies for backward compatibility
            fields.frequencies = val;
            logger.info(`[FREQUENCIES FIELD] Stored frequencies as freqList with ${freqList.length} entries`);
          }
        } catch (error) {
          logger.error('Error parsing TrunkRecorder frequencies JSON:', error);
        }
      }
      
      // Also check for freqList as a direct field (alternative format - if someone sends it)
      if (name === 'freqList' && val && val.trim() !== '' && val.trim() !== '[]') {
        try {
          const freqList = JSON.parse(val);
          if (Array.isArray(freqList)) {
            fields.freqList = val;
            logger.info(`Extracted freqList field with ${freqList.length} entries`);
          }
        } catch (error) {
          logger.error('Error parsing TrunkRecorder freqList JSON:', error);
        }
      }
    });
    
    bb.on('close', async () => {
      // Log all fields we received for debugging
      const allFieldNames = Object.keys(fields);
      logger.info(`[FIELDS SUMMARY] Total fields received: ${allFieldNames.length}`);
      logger.info(`[FIELDS SUMMARY] Field names: ${allFieldNames.join(', ')}`);
      logger.info(`[FIELDS SUMMARY] Has meta: ${!!fields.meta}, Has srcList: ${!!fields.srcList}, Has freqList: ${!!fields.freqList}, Has sources: ${!!fields.sources}`);
      if (fields.meta) {
        logger.info(`[FIELDS SUMMARY] meta field length: ${fields.meta.length}, preview: ${fields.meta.substring(0, 200)}`);
      }
      
      // Fallback: If we have meta but srcList wasn't extracted, try to extract it now
      if (fields.meta && !fields.srcList) {
        try {
          logger.info(`[FALLBACK] Attempting to extract srcList from meta field (meta length: ${fields.meta.length})`);
          const metaData = JSON.parse(fields.meta);
          logger.info(`[FALLBACK] Parsed meta, has srcList: ${!!metaData.srcList}, isArray: ${Array.isArray(metaData.srcList)}`);
          if (metaData.srcList && Array.isArray(metaData.srcList)) {
            fields.srcList = JSON.stringify(metaData.srcList);
            logger.info(`[FALLBACK] Extracted srcList from meta field on close with ${metaData.srcList.length} entries`);
          } else {
            logger.warn(`[FALLBACK] meta.srcList is not an array or doesn't exist`);
          }
          if (metaData.freqList && Array.isArray(metaData.freqList) && !fields.freqList) {
            fields.freqList = JSON.stringify(metaData.freqList);
            logger.info(`[FALLBACK] Extracted freqList from meta field on close with ${metaData.freqList.length} entries`);
          }
        } catch (error) {
          logger.warn(`[FALLBACK] Error extracting srcList/freqList from meta on close: ${error.message}`);
        }
      } else if (!fields.meta && !fields.srcList) {
        // Only warn if srcList is actually missing (not just that meta is missing)
        // TrunkRecorder sends sources directly, not in meta, so this is normal
        logger.debug(`[FALLBACK] No meta field and no srcList - TrunkRecorder may send sources directly (this is normal)`);
      } else if (fields.srcList) {
        logger.debug(`[FALLBACK] srcList already exists, no fallback needed`);
      }
      
      // API key validation
      if (!fields.key) {
        return sendResponse(400, 'API key is missing.');
      }
      
      try {
        const apiKey = await validateApiKey(fields.key);
        if (!apiKey) {
          return sendResponse(401, 'Invalid or disabled API key.');
        }

        // --- START: dateTime Parsing Logic ---
        let callDateTime;
        let inferredSourceSystem = 'TrunkRecorder'; // Default assumption
        if (fields.dateTime) {
            // Try parsing as Unix timestamp (seconds)
            const timestampSeconds = parseInt(fields.dateTime, 10);
            if (!isNaN(timestampSeconds) && timestampSeconds > 1000000000) { // Basic sanity check for Unix timestamp
                callDateTime = new Date(timestampSeconds * 1000);
                // Keep inferredSourceSystem as 'TrunkRecorder'
            } else {
                // Try parsing as ISO/RFC3339 string
                callDateTime = new Date(fields.dateTime);
                if (!isNaN(callDateTime.getTime())) {
                    // Successfully parsed as ISO string, likely rdio-scanner
                    inferredSourceSystem = 'rdio-scanner';
                }
            }
            // Final validation
            if (isNaN(callDateTime.getTime())) {
                logger.warn(`Could not parse dateTime field: ${fields.dateTime}. Using current time.`);
                callDateTime = new Date(); // Fallback to now if parsing fails
                inferredSourceSystem = 'Unknown (dateTime parse failed)'; // Update source if parsing failed
            }
        } else {
             logger.warn('dateTime field missing. Using current time.');
             callDateTime = new Date(); // Fallback if field is missing
             inferredSourceSystem = 'Unknown (dateTime missing)';
        }
        // --- END: dateTime Parsing Logic ---
        
        // Handle source field explicitly
        // ... (rest of the existing logic for source, audioName) ...
        // Map audioName to filename for TrunkRecorder if original isn't available
        if (fields.audioName && (!fileInfo || !fileInfo.originalFilename)) {
          fileInfo = fileInfo || {};
          fileInfo.originalFilename = fields.audioName;
        }
        
        if (fileInfo && fileBuffer) {
          // Use the parsed callDateTime when generating filename and calling handleNewAudio
          const customFilename = generateCustomFilename({...fields, dateTime: callDateTime.getTime() / 1000}, fileInfo.originalFilename); // Pass seconds for filename generator
          const saveTo = path.join(UPLOAD_DIR, customFilename);
          
          fs.writeFile(saveTo, fileBuffer, (err) => {
            if (err) {
              logger.error('Error saving file:', err);
              return sendResponse(500, 'Error saving file');
            }
            
            // Use the inferred source system for logging
            logger.info(`Received audio via ${inferredSourceSystem}: ${customFilename}`);
            
            // Log fields before passing to handleNewAudio
            logger.info(`[UPLOAD] Preparing to call handleNewAudio, fields.srcList=${fields.srcList ? (typeof fields.srcList === 'string' ? `string(${fields.srcList.length} chars)` : `object`) : 'null/undefined'}, fields.freqList=${fields.freqList ? 'exists' : 'null/undefined'}`);
            
            handleNewAudio({
              filename: customFilename,
              path: saveTo,
              talkGroupID: fields.talkgroup,
              systemName: fields.systemLabel,
              talkGroupName: fields.talkgroupLabel,
              dateTime: Math.floor(callDateTime.getTime() / 1000), // Pass Unix timestamp (seconds)
              source: fields.source,
              talkerAlias: fields.talkerAlias, // <-- OTA alias from Trunk Recorder
              frequency: fields.frequency,
              talkGroupGroup: fields.talkgroupGroup,
              // Detect TrunkRecorder more reliably: check for TrunkRecorder-specific fields
              isTrunkRecorder: inferredSourceSystem === 'TrunkRecorder' || 
                               (fields.srcList && fields.srcList.trim() !== '' && fields.srcList.trim() !== '[]') ||
                               (fields.freqList && fields.freqList.trim() !== '' && fields.freqList.trim() !== '[]'),
              frequencies: fields.frequencies, // <-- Legacy frequencies field
              freqList: fields.freqList, // <-- New freqList field (preferred)
              srcList: fields.srcList, // <-- New srcList field
              emergency: fields.emergency,
              priority: fields.priority,
              encrypted: fields.encrypted,
              call_length: fields.call_length,
              freq_error: fields.freq_error,
              signal: fields.signal,
              noise: fields.noise,
              start_time: fields.start_time,
              stop_time: fields.stop_time,
              tdma_slot: fields.tdma_slot,
              phase2_tdma: fields.phase2_tdma,
              color_code: fields.color_code
            });
            
            return sendResponse(200, 'Call imported successfully.');
          });
        } else {
          return sendResponse(200, 'incomplete call data: no audio file');
        }
      } catch (error) {
        logger.error('Error processing TrunkRecorder request:', error);
        return sendResponse(500, 'Error processing request');
      }
    });
    
    req.pipe(bb);
  }
});

app.get('/audio/:id', (req, res) => {
  const audioId = req.params.id;
  db.get('SELECT audio_data, transcription_id FROM audio_files WHERE transcription_id = ?', [audioId], (err, row) => {
    if (err) {
      logger.error('Error fetching audio:', err);
      return res.status(500).send('Error fetching audio');
    }
    if (!row) {
      return res.status(404).send('Audio not found');
    }
    
    // Get the file extension from the original file path
    db.get('SELECT audio_file_path FROM transcriptions WHERE id = ?', [row.transcription_id], (err, pathRow) => {
      // Set the appropriate content type based on file extension
      const filePath = pathRow ? pathRow.audio_file_path : '';
      const extension = path.extname(filePath).toLowerCase();
      
      if (extension === '.m4a') {
        res.set('Content-Type', 'audio/mp4');
      } else {
        res.set('Content-Type', 'audio/mpeg');
      }
      
      res.send(row.audio_data);
    });
  });
});

// Function to start the transcription process
// Function to start the transcription process
async function startTranscriptionProcess() {
  // *** ADD THIS CHECK AT THE TOP ***
  if (effectiveTranscriptionMode !== 'local') {
    logger.info('Transcription mode is not local, skipping Python process start.');
    return; // Don't start if mode is remote
  }
  // *** END ADDED CHECK ***

  // Clean up existing process if it exists
  if (transcriptionProcess) {
    logger.info('Cleaning up existing transcription process before restart');
    cleanupTranscriptionProcess();
  }

  logger.info('🚀 Starting persistent transcription process (local mode)...');
  logger.info('⏳ Checking Python environment and packages...'); // Updated log message

  // Reset state variables
  isProcessingTranscription = false;
  currentTranscriptionId = null;
  if (transcriptionTimeout) {
    clearTimeout(transcriptionTimeout);
    transcriptionTimeout = null;
  }

  // Spawn the Python process with better error handling and version detection
  let pythonCommand = PYTHON_COMMAND || 'python';

  // Auto-heal: if PYTHON_COMMAND is unset or just a bare default (e.g. after a
  // reset wiped .env but kept the project .venv), prefer a working local .venv.
  const isBareDefault = !PYTHON_COMMAND || /^python(3(\.\d+)?)?$/i.test(String(PYTHON_COMMAND).trim());
  if (isBareDefault) {
    try {
      const { detectExistingVenv } = require('./src/setup/pythonEnv');
      const venvPy = detectExistingVenv();
      if (venvPy) {
        pythonCommand = venvPy;
        logger.info(`Using detected project .venv Python: ${venvPy}`);
      }
    } catch (e) {
      logger.warn(`venv auto-detect skipped: ${e.message}`);
    }
  }

  // If user specified a custom Python command, use it directly
  if (PYTHON_COMMAND && pythonCommand === PYTHON_COMMAND) {
    logger.info(`Using user-specified Python command: ${PYTHON_COMMAND}`);
  } else if (pythonCommand !== (PYTHON_COMMAND || 'python')) {
    // Already resolved to a detected .venv above.
  } else {
    // Try different Python commands to find the right version
    // On Windows, also try the full path to Python 3.12
    const pythonCommands = [
      'python3.12', 
      'python3', 
      'C:\\Users\\maste\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
      'python'
    ];
    
    logger.info(`AUTO_UPDATE_PYTHON_PACKAGES is set to: ${AUTO_UPDATE_PYTHON_PACKAGES}`);
  
    // Function to test Python version and dependencies
    const testPythonVersion = (cmd) => {
      return new Promise((resolve) => {
        const testProcess = spawn(cmd, ['--version'], { stdio: 'pipe' });
        let output = '';
        
        testProcess.stdout.on('data', (data) => {
          output += data.toString();
        });
        
        testProcess.stderr.on('data', (data) => {
          output += data.toString();
        });
        
        testProcess.on('close', (code) => {
          if (code === 0) {
            const versionMatch = output.match(/Python (\d+)\.(\d+)/);
            if (versionMatch) {
              const major = parseInt(versionMatch[1]);
              const minor = parseInt(versionMatch[2]);
              logger.info(`Detected ${cmd}: Python ${major}.${minor} (major: ${major}, minor: ${minor})`);
              resolve({ cmd, version: `${major}.${minor}`, major, minor });
            } else {
              logger.warn(`Could not parse version from output: ${output}`);
            }
          } else {
            logger.info(`Command ${cmd} failed with code ${code}`);
          }
          resolve(null);
        });
        
        testProcess.on('error', () => {
          resolve(null);
        });
      });
    };
    
    // Function to test if Python has required packages
    const testPythonPackages = (cmd) => {
      return new Promise((resolve) => {
        const testProcess = spawn(cmd, ['-c', 'import torch, pydub, faster_whisper; print("OK")'], { stdio: 'pipe' });
        let output = '';
        
        testProcess.stdout.on('data', (data) => {
          output += data.toString();
        });
        
        testProcess.stderr.on('data', (data) => {
          output += data.toString();
        });
        
        testProcess.on('close', (code) => {
          if (code === 0 && output.includes('OK')) {
            logger.info(`✓ Package test passed for ${cmd}`);
            resolve(true);
          } else {
            logger.info(`✗ Package test failed for ${cmd} (code: ${code}, output: '${output.trim()}')`);
            resolve(false);
          }
        });
        
        testProcess.on('error', () => {
          resolve(false);
        });
      });
    };
    
    // Function to auto-install Python packages
    const autoInstallPythonPackages = (cmd) => {
      return new Promise((resolve) => {
        logger.info(`Installing required Python packages using ${cmd}...`);
        
        // Detect CUDA availability for appropriate PyTorch installation
        const commands = [
          // Try CUDA first (most common for transcription)
          `${cmd} -m pip install --upgrade pip`,
          // Try PyTorch nightly first for better RTX 5090 support, fallback to stable
          `${cmd} -m pip install --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu121 || ${cmd} -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121`,
          `${cmd} -m pip install faster-whisper>=0.10.0`,
          `${cmd} -m pip install pydub>=0.25.0`,
          `${cmd} -m pip install python-dotenv>=1.0.0`,
          `${cmd} -m pip install numpy>=1.24.0`
        ];
        
        // If CUDA fails, fallback to CPU
        const fallbackCommands = [
          `${cmd} -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu`,
          `${cmd} -m pip install faster-whisper>=0.10.0`,
          `${cmd} -m pip install pydub>=0.25.0`,
          `${cmd} -m pip install python-dotenv>=1.0.0`,
          `${cmd} -m pip install numpy>=1.24.0`
        ];
        
        let currentCommandIndex = 0;
        let usingFallback = false;
        
        const runNextCommand = () => {
          const commandList = usingFallback ? fallbackCommands : commands;
          
          if (currentCommandIndex >= commandList.length) {
            // All commands completed, test if packages are now available
            testPythonPackages(cmd).then(hasPackages => {
              if (hasPackages) {
                logger.info(`✓ Successfully installed all required packages for ${cmd}`);
                resolve(true);
              } else if (!usingFallback) {
                // Try fallback to CPU-only PyTorch
                logger.warn('CUDA PyTorch installation may have failed, trying CPU version...');
                usingFallback = true;
                currentCommandIndex = 1; // Skip pip upgrade for fallback
                runNextCommand();
              } else {
                logger.error(`Failed to install required packages for ${cmd}`);
                resolve(false);
              }
            });
            return;
          }
          
          const command = commandList[currentCommandIndex];
          logger.info(`Running: ${command}`);
          
          const installProcess = spawn(command, { 
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            timeout: 300000 // 5 minute timeout for each command
          });
          
          let output = '';
          let errorOutput = '';
          
          installProcess.stdout.on('data', (data) => {
            const text = data.toString();
            output += text;
            // Log installation progress for user feedback
            if (text.includes('Successfully installed') || text.includes('Requirement already satisfied')) {
              logger.info(`Package install progress: ${text.trim()}`);
            }
          });
          
          installProcess.stderr.on('data', (data) => {
            const text = data.toString();
            errorOutput += text;
            // Log important errors during installation
            if (text.includes('ERROR') || text.includes('FAILED')) {
              logger.warn(`Package install error: ${text.trim()}`);
            }
          });
          
          installProcess.on('close', (code) => {
            if (code === 0) {
              logger.info(`✓ Command completed successfully`);
            } else {
              logger.warn(`Command failed with code ${code}: ${errorOutput.slice(0, 200)}...`);
              if (currentCommandIndex === 1 && !usingFallback) {
                // PyTorch CUDA install failed, switch to fallback
                logger.warn('CUDA PyTorch installation failed, switching to CPU version...');
                usingFallback = true;
                currentCommandIndex = 0; // Reset to start fallback sequence
              }
            }
            currentCommandIndex++;
            setTimeout(runNextCommand, 2000); // Slightly longer delay between commands
          });
          
          installProcess.on('error', (err) => {
            logger.error(`Error running command: ${err.message}`);
            currentCommandIndex++;
            setTimeout(runNextCommand, 2000);
          });
        };
        
        runNextCommand();
      });
    };
    
    // Function to auto-update Python packages
    const autoUpdatePythonPackages = (cmd) => {
      return new Promise((resolve) => {
        logger.info(`🔄 Updating Python packages to latest versions using ${cmd}...`);
        
        const updateCommands = [
          `${cmd} -m pip install --upgrade pip`,
          // Try PyTorch nightly first for better RTX 5090 support, fallback to stable
          `${cmd} -m pip install --upgrade --pre torch torchvision torchaudio --index-url https://download.pytorch.org/whl/nightly/cu121 || ${cmd} -m pip install --upgrade torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121`,
          `${cmd} -m pip install --upgrade faster-whisper`,
          `${cmd} -m pip install --upgrade pydub`,
          `${cmd} -m pip install --upgrade python-dotenv`,
          `${cmd} -m pip install --upgrade numpy`
        ];
        
        let currentCommandIndex = 0;
        
        const runNextUpdate = () => {
          if (currentCommandIndex >= updateCommands.length) {
            logger.info(`✅ Package updates completed for ${cmd}`);
            resolve(true);
            return;
          }
          
          const command = updateCommands[currentCommandIndex];
          logger.info(`Updating: ${command}`);
          
          const updateProcess = spawn(command, { 
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true 
          });
          
          updateProcess.on('close', (code) => {
            if (code === 0) {
              logger.info(`✅ Update step ${currentCommandIndex + 1}/${updateCommands.length} completed`);
            } else {
              logger.warn(`⚠️ Update step ${currentCommandIndex + 1}/${updateCommands.length} failed (code ${code}), continuing...`);
            }
            currentCommandIndex++;
            setTimeout(runNextUpdate, 1000);
          });
          
          updateProcess.on('error', (err) => {
            logger.error(`Error during update: ${err.message}`);
            currentCommandIndex++;
            setTimeout(runNextUpdate, 1000);
          });
        };
        
        runNextUpdate();
      });
    };
    
    // Find the best Python version and auto-install/update packages
    logger.info('Detecting Python version and checking packages...');
    let foundValidPython = false;
    
    for (const cmd of pythonCommands) {
      logger.info(`Checking Python command: ${cmd}`);
      const result = await testPythonVersion(cmd);
      if (result && result.major >= 3 && result.minor >= 8) {
        logger.info(`✓ Found compatible Python: ${result.cmd} (version ${result.version})`);
        logger.info(`Testing ${result.cmd} (version ${result.version}) for required packages...`);
        
        // Test if this Python has the required packages
        const hasPackages = await testPythonPackages(result.cmd);
        if (hasPackages) {
          pythonCommand = result.cmd;
          logger.info(`✓ Found Python with all required packages: ${pythonCommand} (version ${result.version})`);
          
          // Auto-update packages to latest versions (if enabled)
          if (AUTO_UPDATE_PYTHON_PACKAGES?.toLowerCase() === 'true') {
            logger.info('🔄 Checking for Python package updates (this may take a moment)...');
            await autoUpdatePythonPackages(result.cmd);
            logger.info('✅ Package update check completed');
          } else {
            logger.info('Auto-update disabled, skipping package updates');
          }
          
          foundValidPython = true;
          break;
        } else {
          logger.warn(`${result.cmd} (version ${result.version}) is missing required packages.`);
          
          // Try to auto-install packages (if enabled)
          if (AUTO_UPDATE_PYTHON_PACKAGES?.toLowerCase() === 'true') {
            logger.info('📦 Installing required Python packages (this will take several minutes)...');
            logger.info('⏳ Please wait while PyTorch, faster-whisper, and dependencies are downloaded...');
            const installed = await autoInstallPythonPackages(result.cmd);
            if (installed) {
              pythonCommand = result.cmd;
              logger.info(`✅ Successfully auto-installed all packages for: ${pythonCommand} (version ${result.version})`);
              foundValidPython = true;
              break;
            } else {
              logger.warn(`❌ Failed to auto-install packages for ${result.cmd}, trying next Python...`);
            }
          } else {
            logger.warn('Auto-install disabled, skipping package installation for this Python');
          }
        }
      } else if (result) {
        logger.warn(`Found ${result.cmd} version ${result.version} but need Python 3.8+`);
      } else {
        logger.info(`Command ${cmd} not found or failed to execute`);
      }
    }
    
    if (!foundValidPython) {
      logger.error('No suitable Python installation found and auto-installation failed!');
      logger.error('Please manually install Python 3.8+ and required packages.');
      logger.error('Or set PYTHON_COMMAND in .env to specify the correct Python executable');
    }
  }
  
  try {
    transcriptionProcess = spawn(pythonCommand, ['transcribe.py'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
      cwd: __dirname // Ensure we're in the right directory
    });
    
    logger.info(`Spawned Python process with PID: ${transcriptionProcess.pid} using command: ${pythonCommand}`);
  } catch (err) {
    logger.error(`Failed to spawn transcription process: ${err.message}`);
    transcriptionProcess = null;
    return;
  }

  // A process stopped on purpose (settings change, timeout, health check) has
  // already been replaced; its exit must not tear down the new one.
  const thisTranscriptionProcess = transcriptionProcess;

  // Set up process error handling first
  transcriptionProcess.on('error', (err) => {
    logger.error(`Failed to start local transcription process: ${err.message}`);
    cleanupTranscriptionProcess();
    if (effectiveTranscriptionMode === 'local') {
        logger.info('Will attempt to restart local transcription process in 10 seconds due to spawn error...');
        setTimeout(startTranscriptionProcess, 10000);
    }
  });

  // Create interface to read line-by-line from stdout
  const rl = readline.createInterface({
    input: transcriptionProcess.stdout,
    crlfDelay: Infinity
  });

  // Handle each line of output with improved error handling
  rl.on('line', (line) => {
    try {
      // Update activity timestamp (process is alive and responding)
      lastProcessActivity = Date.now();
      
      // Check if line is empty or just whitespace before parsing
      if (!line || line.trim() === '') {
          return;
      }

      logger.info(`Local transcription process output: ${line}`);
      const response = JSON.parse(line);

      if (response.ready) {
        logger.info('Local transcription service ready');
        // Start health check monitoring after ready signal
        startProcessHealthCheck();
        processNextTranscription(); // Process queue on ready
      } else if (response.heartbeat) {
        // Heartbeat received - process is alive during radio silence
        logger.debug(`Transcription process heartbeat received (${new Date(response.timestamp * 1000).toLocaleTimeString()})`);
        // Activity is already updated above, no need to do anything else
      } else if (response.id && response.has_two_tone !== undefined) {
        // Handle tone detection result
        logger.info(`Received tone detection result for ID: ${response.id}`);
        handleLocalToneDetectionResult(response);
      } else if (response.id && response.transcription !== undefined) {
        logger.info(`Received local transcription for ID: ${response.id}`);

        // Clear timeout if this is the current transcription
        if (currentTranscriptionId === response.id) {
          clearTranscriptionTimeout();
        }

        // Find the item and its callback in the queue
        const pendingItemIndex = transcriptionQueue.findIndex(item => item.id === response.id);

        if (pendingItemIndex !== -1) {
            const pendingItem = transcriptionQueue[pendingItemIndex];
            logger.info(`Found callback for local transcription ID: ${response.id}, executing`);

            // Execute the callback defined in handleNewAudio
            // Pass both transcription text and segments (if available) for source matching
            if (pendingItem.callback) {
                try {
                  pendingItem.callback(response.transcription, response.segments);
                } catch (callbackError) {
                  logger.error(`Error executing callback for ID ${response.id}: ${callbackError.message}`);
                }
            } else {
                 logger.error(`No callback function found for local transcription ID: ${response.id}`);
            }

            // Remove this item from the queue
            transcriptionQueue.splice(pendingItemIndex, 1);

            // Reset processing state and process next item
            resetProcessingState();
            processNextTranscription();
        } else {
          logger.error(`No pending item found for local transcription ID: ${response.id}`);
          // Still allow queue to continue if an unexpected ID comes back
          resetProcessingState();
          processNextTranscription();
        }
      } else if (response.error) {
         logger.error(`Local transcription error for ID ${response.id}: ${response.error}`);

         // Clear timeout if this is the current transcription
         if (currentTranscriptionId === response.id) {
           clearTranscriptionTimeout();
         }

         const pendingItemIndex = transcriptionQueue.findIndex(item => item.id === response.id);
         if (pendingItemIndex !== -1) {
             const pendingItem = transcriptionQueue[pendingItemIndex];
             // Execute callback with empty string on error
             if (pendingItem.callback) {
                 try {
                   pendingItem.callback(""); // Indicate failure
                 } catch (callbackError) {
                   logger.error(`Error executing error callback for ID ${response.id}: ${callbackError.message}`);
                 }
             }
             // Remove problematic item from queue
             transcriptionQueue.splice(pendingItemIndex, 1);
             logger.info(`Removed item with error from local queue: ID ${response.id}`);
         } else {
              logger.error(`Received error for unknown local transcription ID: ${response.id}`);
         }

         // Reset processing state and allow queue to continue
         resetProcessingState();
         processNextTranscription();

      } else {
        logger.warn(`Unrecognized response from local transcription process: ${line}`);
        // Reset processing state just in case to prevent stall
        resetProcessingState();
        processNextTranscription();
      }
    } catch (err) {
      logger.error(`Error parsing local transcription process output: ${err.message}, line: ${line}`);
      // Reset processing state and allow queue to continue on parsing error
      resetProcessingState();
      processNextTranscription();
    }
  });

  // Handle stderr with selective logging - only show important messages
  transcriptionProcess.stderr.on('data', (data) => {
    const errorMsg = data.toString().trim();
    if (errorMsg) {
       // Only log important messages, not routine processing info
       const isImportant = errorMsg.includes('ERROR') || 
                          errorMsg.includes('FATAL') || 
                          errorMsg.includes('WARNING') ||
                          errorMsg.includes('WARN') ||
                          errorMsg.includes('Exception') ||
                          errorMsg.includes('Traceback') ||
                          errorMsg.includes('ModuleNotFoundError') ||
                          errorMsg.includes('ImportError') ||
                          errorMsg.includes('CUDA') ||
                          errorMsg.includes('torch') ||
                          errorMsg.includes('faster_whisper') ||
                          errorMsg.includes('Environment validation') ||
                          errorMsg.includes('available') ||
                          errorMsg.includes('Loaded model') ||
                          errorMsg.includes('Using device');
       
       if (isImportant) {
         // Python's logging lines are "<time> [LEVEL] message"; keep their level
         // instead of reporting every stderr chunk as a warning.
         for (const line of errorMsg.split(/\r?\n/).filter(Boolean)) {
           const m = line.match(/^\S+ \S+ \[(\w+)\] (.*)$/);
           const pyLevel = m ? m[1].toLowerCase() : '';
           const level = /error|critical|traceback|exception/i.test(pyLevel || line) ? 'error'
             : /warn/i.test(pyLevel || line) ? 'warn' : 'info';
           logger.log({ level, message: m ? m[2] : line, source: 'whisper', console: true });
         }
       }
       
       // Check for specific Python errors that indicate critical issues
       if (errorMsg.includes('ModuleNotFoundError') || errorMsg.includes('ImportError')) {
         logger.error('PYTHON IMPORT ERROR DETECTED - Missing required Python packages!');
       } else if (errorMsg.includes('CUDA') && errorMsg.includes('error')) {
         logger.error('CUDA ERROR DETECTED - GPU may not be available or drivers are outdated!');
       } else if (errorMsg.includes('torch') && errorMsg.includes('error')) {
         logger.error('PYTORCH ERROR DETECTED - Check PyTorch installation!');
       } else if (errorMsg.includes('faster_whisper') && errorMsg.includes('error')) {
         logger.error('FASTER-WHISPER ERROR DETECTED - Check faster-whisper installation!');
       }
    }
  });

  // Handle process exit with cleanup and better diagnostics
  transcriptionProcess.on('close', (code, signal) => {
    if (transcriptionProcess !== thisTranscriptionProcess) {
      logger.info(`Previous transcription process exited (${signal || code})`);
      return;
    }
    logger.error(`Local transcription process exited with code ${code}, signal: ${signal}`);
    
    // More specific error handling based on exit conditions
    if (code === null && signal) {
      logger.error(`Python process was killed by signal: ${signal}`);
    } else if (code === 1) {
      logger.error('Python process exited with error code 1 - likely a Python runtime error');
    } else if (code === null) {
      logger.error('Python process exited unexpectedly (code null) - likely crashed during startup');
      logger.error('This usually indicates missing dependencies or environment issues');
      logger.error('Check that Python, faster-whisper, torch, and other dependencies are properly installed');
    }
    
    cleanupTranscriptionProcess();

    // Only restart if not too many recent failures
    if (effectiveTranscriptionMode === 'local') {
      if (code === null) {
        // For null exit codes (startup crashes), wait longer and provide guidance
        logger.error('STARTUP CRASH DETECTED - Will NOT automatically restart to prevent loop');
        logger.error('Please check Python environment and dependencies manually');
        logger.error('Run "python transcribe.py" manually to see the full error');
      } else {
        logger.info('Will attempt to restart local transcription process in 15 seconds...');
        setTimeout(startTranscriptionProcess, 15000);
      }
    }
  });

  logger.info('🔄 Python transcription process started, loading AI model...');
  logger.info('⏳ Please wait while the large-v3 model loads (this takes 10-30 seconds)...');
  
  // Add a timeout to detect if Python process never sends ready signal
  const readyTimeout = setTimeout(() => {
    if (transcriptionProcess && transcriptionProcess.pid) {
      logger.error('TIMEOUT: Python process started but never sent ready signal after 30 seconds');
      logger.error('This indicates the Python process is stuck during model loading or initialization');
      logger.error('Common causes: GPU memory issues, model download problems, or dependency conflicts');
      logger.error('Try running: python transcribe.py manually to see detailed error output');
      cleanupTranscriptionProcess();
    }
  }, 60000); // 60 second timeout for ready signal (increased for busy systems)
  
  // Clear the timeout when we receive any valid JSON response (including ready signal)
  const originalHandler = rl.listeners('line')[0];
  if (originalHandler) {
    rl.removeListener('line', originalHandler);
    rl.on('line', (line) => {
      // Clear timeout on any valid JSON response from Python
      try {
        if (line && line.trim()) {
          const response = JSON.parse(line);
          if (response.ready || response.id) {
            clearTimeout(readyTimeout);
          }
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
      // Call the original handler
      originalHandler(line);
    });
  }
}

// Helper function to cleanup transcription process and state
function cleanupTranscriptionProcess() {
  // Stop health check
  if (processHealthCheck) {
    clearInterval(processHealthCheck);
    processHealthCheck = null;
  }

  // Clear current transcription timeout
  clearTranscriptionTimeout();

  // Handle any pending items (call callbacks with empty string)
  if (transcriptionQueue.length > 0) {
      logger.warn(`${transcriptionQueue.length} local transcription requests were pending when process was cleaned up. Failing them.`);
      for (const item of transcriptionQueue) {
          if (item.callback) {
              try {
                  item.callback(""); // Indicate failure
              } catch (callbackError) {
                   logger.error(`Error executing pending callback on cleanup for ID ${item.id}: ${callbackError.message}`);
              }
          }
      }
      transcriptionQueue = []; // Clear the queue
  }

  // Reset all state variables
  resetProcessingState();
  
  // Clean up process reference
  if (transcriptionProcess) {
    try {
      transcriptionProcess.kill('SIGTERM');
    } catch (err) {
      logger.warn(`Error killing transcription process: ${err.message}`);
    }
    transcriptionProcess = null;
  }
}

// Restart the local transcriber with changed settings (model, device,
// decoding options). It waits for the call in progress; calls arriving
// meanwhile wait in the queue and go to the new process.
let transcriberRestartPending = false;
function restartTranscriberWhenIdle() {
  transcriberRestartPending = true;
  maybeRestartTranscriber();
}

function maybeRestartTranscriber() {
  if (!transcriberRestartPending || isProcessingTranscription) return;
  transcriberRestartPending = false;
  if (effectiveTranscriptionMode !== 'local') {
    if (transcriptionProcess) {
      logger.info(`Transcription mode is now '${effectiveTranscriptionMode}'; stopping the local transcriber`, { console: true });
      cleanupTranscriptionProcess();
    }
    return;
  }
  const waiting = transcriptionQueue;
  transcriptionQueue = []; // keep queued calls from being failed by the cleanup
  if (transcriptionProcess) cleanupTranscriptionProcess();
  transcriptionQueue = waiting.concat(transcriptionQueue);
  logger.info('Restarting the local transcriber with the new settings...', { console: true });
  startTranscriptionProcess();
}

// Helper function to reset processing state
function resetProcessingState() {
  isProcessingTranscription = false;
  currentTranscriptionId = null;
  clearTranscriptionTimeout();
}

// Helper function to clear transcription timeout
function clearTranscriptionTimeout() {
  if (transcriptionTimeout) {
    clearTimeout(transcriptionTimeout);
    transcriptionTimeout = null;
  }
}

// Helper function to start process health check
function startProcessHealthCheck() {
  if (processHealthCheck) {
    clearInterval(processHealthCheck);
  }
  
  processHealthCheck = setInterval(() => {
    const timeSinceActivity = Date.now() - lastProcessActivity;
    const queueSize = transcriptionQueue.length;
    
    // Only restart if there's BOTH no activity AND items in queue (indicating a real problem)
    // Radio silence (no queue items) is normal and shouldn't trigger restart
    if (timeSinceActivity > 600000 && queueSize > 0) { // 10 minutes + queue items = real problem
      logger.error(`Transcription process appears stuck (no activity for 10 minutes with ${queueSize} items queued). Restarting...`);
      cleanupTranscriptionProcess();
      if (effectiveTranscriptionMode === 'local') {
        setTimeout(startTranscriptionProcess, 5000);
      }
      return;
    } else if (timeSinceActivity > 1800000) { // 30 minutes with no activity at all (safety net)
      logger.warn(`Very long radio silence detected (30+ minutes). Performing health check restart as precaution...`);
      cleanupTranscriptionProcess();
      if (effectiveTranscriptionMode === 'local') {
        setTimeout(startTranscriptionProcess, 5000);
      }
      return;
    }
    
    // High-volume system monitoring
    if (queueSize > QUEUE_DRAIN_THRESHOLD && !queueWarningLogged) {
      logger.warn(`HIGH VOLUME: Transcription queue is backing up with ${queueSize} items. Consider increasing MAX_CONCURRENT_TRANSCRIPTIONS or checking system resources.`);
      queueWarningLogged = true;
    } else if (queueSize <= QUEUE_DRAIN_THRESHOLD / 2) {
      queueWarningLogged = false; // Reset warning when queue drains
    }
    
    // Log queue status with more detail for busy systems
    if (queueSize > 0 && Math.abs(queueSize - lastQueueSizeLog) >= 5) {
      const oldestItem = transcriptionQueue[0];
      const queueAge = oldestItem ? Math.round((Date.now() - oldestItem.queuedAt) / 1000) : 0;
      logger.info(`Transcription queue: ${queueSize} items pending, processing: ${isProcessingTranscription}, oldest item: ${queueAge}s`);
      lastQueueSizeLog = queueSize;
    }
    
    // Force restart if queue is definitely stuck (more conservative)
    if (queueSize > 15 && !isProcessingTranscription && timeSinceActivity > 300000) { // 5 minutes + 15+ items = real stuck
      logger.error(`Queue definitely stuck with ${queueSize} items and no processing for 5 minutes. Force restarting transcription process...`);
      cleanupTranscriptionProcess();
      if (effectiveTranscriptionMode === 'local') {
        setTimeout(startTranscriptionProcess, 2000);
      }
    }
  }, 60000); // Check every 60 seconds (less frequent)
}

// Function to process the next transcription in the queue
function processNextTranscription() {
  // Add a check for the process existence early
  if (!transcriptionProcess) {
      logger.warn('Local transcription process not running. Cannot process queue.');
      return;
  }

  if (isProcessingTranscription) {
    return;
  }
  // Settings changed: restart the transcriber now that it's idle
  if (transcriberRestartPending) {
    maybeRestartTranscriber();
    return;
  }
  if (transcriptionQueue.length === 0) {
    return;
  }

  // Get the next item but don't remove it from the queue yet
  const nextItem = transcriptionQueue[0];

  // Additional validation for file-based transcriptions
  if (nextItem.payload && nextItem.payload.path) {
    if (!fs.existsSync(nextItem.payload.path)) {
      logger.error(`Audio file missing when processing queue: ${nextItem.payload.path}. Skipping item.`);
      // Remove the item and try next
      transcriptionQueue.shift();
      if (nextItem.callback) {
        try {
          nextItem.callback(""); // Indicate failure
        } catch (callbackError) {
          logger.error(`Error executing callback for missing file: ${callbackError.message}`);
        }
      }
      processNextTranscription(); // Try next item
      return;
    }
  }

  // Validate payload size for buffer-based transcriptions  
  if (nextItem.payload && nextItem.payload.audio_data_base64) {
    const estimatedSize = nextItem.payload.audio_data_base64.length * 0.75; // Rough base64 to binary size
    if (estimatedSize > 50 * 1024 * 1024) { // 50MB limit
      logger.error(`Audio buffer too large for transcription: ${Math.round(estimatedSize / 1024 / 1024)}MB. Skipping item.`);
      transcriptionQueue.shift();
      if (nextItem.callback) {
        try {
          nextItem.callback(""); // Indicate failure
        } catch (callbackError) {
          logger.error(`Error executing callback for oversized file: ${callbackError.message}`);
        }
      }
      processNextTranscription(); // Try next item
      return;
    }
  }

  // Mark as processing and set timeout
  isProcessingTranscription = true;
  currentTranscriptionId = nextItem.id;
  
  // Set timeout for this transcription
  transcriptionTimeout = setTimeout(() => {
    logger.error(`Transcription timeout for ID ${currentTranscriptionId}. Restarting process...`);
    // Force restart the process on timeout
    cleanupTranscriptionProcess();
    if (effectiveTranscriptionMode === 'local') {
      setTimeout(startTranscriptionProcess, 5000);
    }
  }, TRANSCRIPTION_TIMEOUT_MS);

  // Send the pre-constructed payload to the python process
  try {
    const payload = JSON.stringify(nextItem.payload) + '\n';
    transcriptionProcess.stdin.write(payload);
    logger.info(`Sent payload to local transcription process for ID: ${nextItem.id} (payload size: ${payload.length} chars)`);
    lastProcessActivity = Date.now(); // Update activity timestamp
  } catch (error) {
      logger.error(`Error writing to local transcription process stdin for ID ${nextItem.id}: ${error.message}`);
      // Clear timeout and reset state
      clearTranscriptionTimeout();
      resetProcessingState();
      
      // Remove the failed item from queue
      transcriptionQueue.shift();
      if (nextItem.callback) {
        try {
          nextItem.callback(""); // Indicate failure
        } catch (callbackError) {
          logger.error(`Error executing callback for stdin error: ${callbackError.message}`);
        }
      }
      
      // Try next item
      processNextTranscription();
  }
}

// *** NEW FUNCTION for Remote Transcription ***
async function transcribeAudioRemotely(filePath, callback) {
  // Ensure URL is configured for remote mode
  if (!FASTER_WHISPER_SERVER_URL) {
    logger.error('FATAL: FASTER_WHISPER_SERVER_URL is not configured for remote mode.');
    if (callback) callback(""); // Fail gracefully
    return;
  }

  // Check file existence
  if (!fs.existsSync(filePath)) {
    logger.warn(`Remote Transcription: Audio file does not exist: ${filePath}`);
    if (callback) callback("");
    return;
  }

  // Optional: Check file size (prevent sending tiny/empty files)
  try {
      const stats = fs.statSync(filePath);
      if (stats.size < 1000) { // Example threshold: 1KB
          logger.warn(`Remote Transcription: Audio file too small, skipping: ${filePath} (${stats.size} bytes)`);
          if (callback) callback("");
          return;
      }
  } catch (statError) {
       logger.error(`Remote Transcription: Error getting file stats for ${filePath}: ${statError.message}`);
       if (callback) callback(""); // Fail if stats cannot be read
       return;
  }


  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    // Append model if specified in environment
    if (WHISPER_MODEL) {
      form.append('model', WHISPER_MODEL);
      logger.info(`Requesting remote model: ${WHISPER_MODEL}`);
    }
    // Add language parameter if needed
    // form.append('language', 'en');

    const apiEndpoint = `${FASTER_WHISPER_SERVER_URL}/v1/audio/transcriptions`;
    const filenameForLog = path.basename(filePath);
    logger.info(`Sending remote transcription request for ${filenameForLog} to ${apiEndpoint}`);

    // Configure fetch options, including timeout (e.g., 120 seconds)
    const fetchOptions = {
         method: 'POST',
         body: form,
         headers: {
             // Add Authorization header ONLY if your remote server requires it
             // 'Authorization': `Bearer YOUR_SERVER_API_KEY_IF_NEEDED`,
             ...form.getHeaders() // Necessary for form-data
         },
         // signal: AbortSignal.timeout(120000) // Requires Node 16+
    };

    // Use a manual timeout for broader Node version compatibility
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        logger.error(`Remote transcription request timed out after 120s for ${filenameForLog}`);
        controller.abort();
    }, 120000); // 120 seconds


    fetchOptions.signal = controller.signal; // Assign the signal

    const response = await fetch(apiEndpoint, fetchOptions);

    clearTimeout(timeoutId); // Clear the timeout if fetch completes

    if (!response.ok) {
      let errorBody = `Status: ${response.status} ${response.statusText}`;
      try {
          errorBody = await response.text();
      } catch (e) { /* ignore */ }
      logger.error(`Remote transcription server error for ${filenameForLog}: ${errorBody}`);
      if (callback) callback(""); // Indicate failure
      return;
    }

    const result = await response.json();
    // Assuming OpenAI compatible response { "text": "..." }
    const transcriptionText = result.text || "";

    logger.info(`Received remote transcription for ${filenameForLog} (${transcriptionText.length} chars)`);
    if (callback) {
      callback(transcriptionText);
    }

  } catch (error) {
     if (error.name === 'AbortError') {
         // Timeout already logged by the timeout handler
         if (callback) callback(""); // Indicate failure on timeout
     } else {
        const filenameForLog = path.basename(filePath);
        logger.error(`Error during remote transcription API call for ${filenameForLog}: ${error.message}`, { stack: error.stack });
        if (callback) callback(""); // Indicate failure on other errors
     }
  }
}

async function transcribeWithOpenAIAPI(filePath, callback) {
  // Check for API Key
  if (!OPENAI_API_KEY) {
    logger.error('FATAL: TRANSCRIPTION_MODE is openai, but OPENAI_API_KEY is not configured.');
    if (callback) callback(""); // Fail gracefully
    return;
  }

  // Check file existence
  if (!fs.existsSync(filePath)) {
    logger.warn(`OpenAI Transcription: Audio file does not exist: ${filePath}`);
    if (callback) callback("");
    return;
  }

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    
    // Use the model from environment variable, fallback to whisper-1 if not set
    const modelToUse = OPENAI_TRANSCRIPTION_MODEL || 'whisper-1';
    form.append('model', modelToUse);
    
    // Force language to English for better scanner audio transcription
    form.append('language', 'en');
    
    // Add temperature parameter for transcription consistency (if supported)
    const temperature = OPENAI_TRANSCRIPTION_TEMPERATURE || '0.0';
    form.append('temperature', temperature);
    
    const filenameForLog = path.basename(filePath);
    
    // Add custom prompt if configured to improve scanner audio transcription
    if (OPENAI_TRANSCRIPTION_PROMPT) {
      form.append('prompt', OPENAI_TRANSCRIPTION_PROMPT);
      logger.info(`Using custom OpenAI transcription prompt for ${filenameForLog}`);
    }
    
    logger.info(`Using temperature ${temperature} for transcription consistency`);

    const apiEndpoint = `https://api.openai.com/v1/audio/transcriptions`;
    logger.info(`Sending OpenAI transcription request for ${filenameForLog} to ${apiEndpoint} using model: ${modelToUse} with temperature: ${temperature}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        logger.error(`OpenAI transcription request timed out after 120s for ${filenameForLog}`);
        controller.abort();
    }, 120000); // 120 seconds

    const response = await fetch(apiEndpoint, {
         method: 'POST',
         body: form,
         headers: {
             'Authorization': `Bearer ${OPENAI_API_KEY}`,
             ...form.getHeaders()
         },
         signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorBody = `Status: ${response.status} ${response.statusText}`;
      try {
          errorBody = await response.text();
      } catch (e) { /* ignore */ }
      logger.error(`OpenAI transcription API error for ${filenameForLog}: ${errorBody}`);
      if (callback) callback("");
      return;
    }

    const result = await response.json();
    const transcriptionText = result.text || "";

    logger.info(`Received OpenAI transcription for ${filenameForLog} (${transcriptionText.length} chars)`);
    if (callback) {
      callback(transcriptionText);
    }

  } catch (error) {
     if (error.name === 'AbortError') {
         if (callback) callback("");
     } else {
        const filenameForLog = path.basename(filePath);
        logger.error(`Error during OpenAI transcription API call for ${filenameForLog}: ${error.message}`, { stack: error.stack });
        if (callback) callback("");
     }
  }
}

async function transcribeWithICADAPI(filePath, callback) {
  // Check for ICAD URL
  if (!ICAD_URL) {
    logger.error('FATAL: TRANSCRIPTION_MODE is icad, but ICAD_URL is not configured.');
    if (callback) callback(""); // Fail gracefully
    return;
  }

  // Check file existence
  if (!fs.existsSync(filePath)) {
    logger.warn(`ICAD Transcription: Audio file does not exist: ${filePath}`);
    if (callback) callback("");
    return;
  }

  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    
    // Set model based on ICAD_PROFILE if provided, otherwise use default
    const modelToUse = ICAD_PROFILE || 'whisper-1';
    form.append('model', modelToUse);
    
    // Add standard OpenAI Whisper API parameters that ICAD should understand
    form.append('response_format', 'json');
    form.append('language', 'en');
    
    // Explicitly disable clip_timestamps to override any profile settings
    form.append('clip_timestamps', '');

    const apiEndpoint = `${ICAD_URL}/v1/audio/transcriptions`;
    const filenameForLog = path.basename(filePath);
    const authStatus = ICAD_API_KEY ? 'with authentication' : 'without authentication';
    logger.info(`Sending ICAD transcription request for ${filenameForLog} to ${apiEndpoint} using model/profile: ${modelToUse} (${authStatus})`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        logger.error(`ICAD transcription request timed out after 120s for ${filenameForLog}`);
        controller.abort();
    }, 120000); // 120 seconds

    const headers = {
      ...form.getHeaders()
    };
    
    // Add authorization header if ICAD_API_KEY is provided
    if (ICAD_API_KEY) {
      headers['Authorization'] = `Bearer ${ICAD_API_KEY}`;
    }

    const response = await fetch(apiEndpoint, {
         method: 'POST',
         body: form,
         headers: headers,
         signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorBody = `Status: ${response.status} ${response.statusText}`;
      try {
          errorBody = await response.text();
      } catch (e) { /* ignore */ }
      logger.error(`ICAD transcription API error for ${filenameForLog}: ${errorBody}`);
      if (callback) callback("");
      return;
    }

    const result = await response.json();
    const transcriptionText = result.text || "";

    logger.info(`Received ICAD transcription for ${filenameForLog} (${transcriptionText.length} chars)`);
    if (callback) {
      callback(transcriptionText);
    }

  } catch (error) {
     if (error.name === 'AbortError') {
         if (callback) callback("");
     } else {
        const filenameForLog = path.basename(filePath);
        logger.error(`Error during ICAD transcription API call for ${filenameForLog}: ${error.message}`, { stack: error.stack });
        if (callback) callback("");
     }
  }
}

// --- Transcription quality pipeline (adapted from RadioTranscriber) ---
// Configured via AUDIO_PREPROCESS_* and TRANSCRIPT_FILTER_* in .env.
let AUDIO_PREPROCESS_CONFIG = audioPreprocess.loadConfig();
let TRANSCRIPT_FILTER_CONFIG = hallucinationFilter.loadConfig();

// Send a file to the API-based transcription modes (local mode queues its own payload).
function transcribeByMode(audioPath, callback) {
  if (effectiveTranscriptionMode === 'openai') {
    transcribeWithOpenAIAPI(audioPath, callback);
  } else if (effectiveTranscriptionMode === 'remote') {
    transcribeAudioRemotely(audioPath, callback);
  } else if (effectiveTranscriptionMode === 'icad') {
    transcribeWithICADAPI(audioPath, callback);
  } else {
    transcribeAudio(audioPath, callback);
  }
}

// Clean up the audio, run `transcribeFn(audioPath, wasPreprocessed, done)`,
// then strip hallucinations and apply transcript fixes before handing the text to `callback`.
async function runTranscriptionPipeline(sourcePath, knownDurationSec, callback, transcribeFn) {
  const pre = await audioPreprocess.preprocessAudio(sourcePath, AUDIO_PREPROCESS_CONFIG);
  const durationSec = pre ? pre.durationSec : knownDurationSec;

  transcribeFn(pre ? pre.path : sourcePath, !!pre, (text) => {
    if (pre) pre.cleanup();
    const { text: cleaned, reason } = hallucinationFilter.filterTranscript(text, durationSec, TRANSCRIPT_FILTER_CONFIG);
    if (reason) {
      logger.info(`Transcript filter (${reason}) on ${path.basename(sourcePath)}: "${text}" -> "${cleaned}"`);
    }
    // Fix words the transcriber reliably mishears (data/transcript_corrections.txt)
    const fixed = transcriptCorrections.applyCorrections(cleaned, logger);
    if (fixed.applied.length) {
      logger.info(`Transcript fixes on ${path.basename(sourcePath)}: ${fixed.applied.map((a) => `${a.heard} -> ${a.replacement}`).join(', ')}`);
    }
    callback(fixed.text);
  });
}

// Function to handle new audio (routes to local or remote transcription)
// Normalize a radio system label so it matches consistently between incoming
// calls (fields.systemLabel) and imported talkgroups (talk_groups.system).
// Empty/unknown -> '' which the lookups treat as a legacy wildcard.
function normalizeSystemLabel(s) {
  return String(s || '').trim().toLowerCase();
}

function handleNewAudio(audioData) {
  const {
    filename, // The custom generated filename (e.g., with timestamp)
    path: tempPath, // The temporary path where the file was saved (KEEP AS CONST)
    talkGroupID,
    systemName,
    talkGroupName,
    dateTime,
    source,
    talkerAlias, // Add talkerAlias field
    frequency,
    talkGroupGroup,
    isTrunkRecorder,
    freqList, // New: freqList field (preferred over frequencies)
    srcList, // New: srcList field
    emergency,
    priority,
    encrypted,
    call_length,
    freq_error,
    signal,
    noise,
    start_time,
    stop_time,
    tdma_slot,
    phase2_tdma,
    color_code
  } = audioData;
  
  // Log srcList for debugging
  logger.info(`[handleNewAudio] Received audio data for ${filename}, srcList=${srcList ? (typeof srcList === 'string' ? `string(${srcList.substring(0, 100)}...)` : `object`) : 'null/undefined'}, isTrunkRecorder=${isTrunkRecorder}`);

  // --- Enhanced: Parse Frequencies for Errors/Spikes (Trunk Recorder) --- 
  let totalErrors = 0;
  let totalSpikes = 0;
  let signalQuality = null;
  
  // Prefer freqList over frequencies (freqList uses snake_case: error_count, spike_count)
  if (isTrunkRecorder && freqList) {
    try {
      const freqListData = JSON.parse(freqList);
      if (Array.isArray(freqListData)) {
        freqListData.forEach(freqInfo => {
          // Use snake_case field names from TrunkRecorder JSON
          totalErrors += freqInfo.error_count || 0;
          totalSpikes += freqInfo.spike_count || 0;
        });
        if (totalErrors > 0 || totalSpikes > 0) {
          logger.info(`Parsed signal quality from freqList: ${totalErrors} errors, ${totalSpikes} spikes`);
        }
      }
    } catch (parseError) {
      logger.warn(`Failed to parse freqList JSON for ${filename}: ${parseError.message}`);
    }
  }
  // Fallback to legacy frequencies field (camelCase)
  else if (isTrunkRecorder && audioData.frequencies) {
    try {
      const frequenciesData = JSON.parse(audioData.frequencies);
      if (Array.isArray(frequenciesData)) {
        frequenciesData.forEach(freqInfo => {
          totalErrors += freqInfo.errorCount || freqInfo.error_count || 0;
          totalSpikes += freqInfo.spikeCount || freqInfo.spike_count || 0;
        });
      if (totalErrors > 0 || totalSpikes > 0) {
          logger.info(`Parsed signal quality from frequencies field: ${totalErrors} errors, ${totalSpikes} spikes`);
        }
      }
    } catch (parseError) {
      logger.warn(`Failed to parse frequencies JSON for ${filename}: ${parseError.message}`);
    }
  }
  
  // Calculate signal quality metrics if available
  if (signal !== undefined && noise !== undefined) {
    signalQuality = {
      signal: signal,
      noise: noise,
      snr: signal !== 999 && noise !== 999 ? (signal - noise) : null // Calculate SNR if valid values
    };
  }
  // --- END Enhanced --- 

  // Double-check file extension before processing (keep this validation)
  if (isIgnoredFileType(filename)) {
    logger.info(`Skipping processing of unsupported file type: ${filename}`);
    fs.unlink(tempPath, (err) => {
      if (err) logger.error(`Error deleting unsupported file ${tempPath}:`, err);
      else logger.info(`Deleted unsupported file: ${filename}`);
    });
    return;
  }

  // Verify the file exists before proceeding (Moved here from processNextTranscription)
  if (!fs.existsSync(tempPath)) {
    logger.error(`Audio file doesn't exist when starting handleNewAudio: ${tempPath}`);
    return;
  }

  // Read file into buffer (This is needed for DB blob AND for S3->Local transcription)
  fs.readFile(tempPath, (err, fileBuffer) => {
    if (err) {
      logger.error(`Error reading audio file ${tempPath}:`, err);
      // Clean up temp file if read fails
       fs.unlink(tempPath, (errUnlink) => {
           if (errUnlink) logger.error(`Error deleting temp file after read error ${tempPath}:`, errUnlink);
       });
      return;
    }

    // --- Start DB Operations ---
    // Storage object key / local relative path (same value for all backends).
    // Date/hour-partitioned (YYYY/MM/DD/HH/) so object-store backends don't pile
    // every recording into the bucket root, where their list/scanner/heal passes
    // degrade. Reads always resolve the key from the DB (storage_key /
    // audio_file_path), so pre-existing flat keys keep working unchanged.
    const keyDate = Number(dateTime) > 0 ? new Date(Number(dateTime) * 1000) : new Date();
    const storagePath = buildKey(filename, keyDate);
    logger.debug(`[Storage] key for new call: ${storagePath}`);

    // Insert initial record into transcriptions table
    const unixTimestampSeconds = Number(dateTime); // Directly use dateTime, ensuring it's a number
    if (isNaN(unixTimestampSeconds)) {
      logger.error(`Invalid dateTime encountered in handleNewAudio: ${dateTime} for filename ${filename}. Cannot insert into DB.`);
      // Clean up temp file if timestamp is invalid
      fs.unlink(tempPath, (errUnlink) => {
          if (errUnlink) logger.error(`Error deleting temp file after invalid dateTime ${tempPath}:`, errUnlink);
      });
      return;
    }

    db.run(
      `INSERT INTO transcriptions (talk_group_id, system, timestamp, transcription, audio_file_path, address, lat, lon) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [talkGroupID, normalizeSystemLabel(systemName), unixTimestampSeconds, '', storagePath], // Use the Unix timestamp
      function (err) {
        if (err) {
          logger.error(`Error inserting initial transcription record for ${filename}:`, err);
          // If DB insert fails, delete the temp file
          fs.unlink(tempPath, (errUnlink) => {
              if (errUnlink) logger.error(`Error deleting temp file after initial insert error ${tempPath}:`, errUnlink);
          });
          return;
        }

        const transcriptionId = this.lastID; // Get the ID from the database insert
        logger.info(`Created transcription record ID ${transcriptionId} using storage path: ${storagePath}`);

        // Only store an audio BLOB in SQLite for the legacy "db" storage mode.
        // File/object backends (local/s3/r2/b2/minio) keep audio out of the DB
        // to avoid database bloat (audio is served via the storage backend).
        if (STORAGE_USES_DB) {
            db.run(
              `INSERT INTO audio_files (transcription_id, audio_data) VALUES (?, ?)`,
              [transcriptionId, fileBuffer],
              (err) => {
                if (err) {
                  logger.error(`Error inserting audio blob for transcription ID ${transcriptionId}:`, err);
                } else {
                  logger.info(`Saved audio blob for transcription ID ${transcriptionId}`);
                }
              }
            );
        }

        // --- NEW: Define function to handle transcription *after* storage is complete ---
        const afterStorageComplete = (finalPathIfLocal) => { // finalPathIfLocal is null for S3, path string for local

            // Check if this is a merged call (multiple sources)
            // Also check if srcList exists even if isTrunkRecorder is false (might be mis-detected)
            // IMPORTANT: srcList is captured from the outer scope (handleNewAudio parameters)
            logger.info(`[MERGED CHECK] Starting merged call check for ID ${transcriptionId}`);
            logger.info(`[MERGED CHECK] isTrunkRecorder=${isTrunkRecorder}, srcList=${srcList ? (typeof srcList === 'string' ? `string(${srcList.length} chars, preview: ${srcList.substring(0, 100)})` : `object(${JSON.stringify(srcList).substring(0, 100)})`) : 'null/undefined'}`);
            logger.info(`[MERGED CHECK] srcList variable exists: ${typeof srcList !== 'undefined'}, value: ${srcList === null ? 'null' : srcList === undefined ? 'undefined' : 'has value'}`);
            
            const hasSrcList = srcList && (typeof srcList === 'string' ? srcList.trim() !== '' && srcList.trim() !== '[]' : (srcList !== null && srcList !== undefined));
            /* logger.info(`[MERGED CHECK] hasSrcList=${hasSrcList}, srcList type=${typeof srcList}`); */
            
            if (!hasSrcList) {
              /* logger.warn(`[MERGED CHECK] No srcList available for ID ${transcriptionId}, skipping merged call detection`); */
            }
            
            // MERGED_CALL_SPLIT=false transcribes multi-speaker calls as one piece
            // (srcList positions don't line up exactly with the recorded audio)
            const merged = MERGED_CALL_SPLIT && (isTrunkRecorder || hasSrcList) && isMergedCall(srcList);
            logger.info(`[MERGED CHECK] Result for ID ${transcriptionId}: merged=${merged}`);
            
            if (merged) {
              // Handle merged call: split audio and transcribe each segment separately
              logger.info(`Detected merged call for ID ${transcriptionId}, splitting audio into segments`);
              logger.info(`srcList: ${srcList ? (typeof srcList === 'string' ? srcList.substring(0, 200) : JSON.stringify(srcList).substring(0, 200)) : 'null'}`);
              
              const segmentDefinitions = createSegmentDefinitions(srcList, freqList, source, talkerAlias);
              
              if (!segmentDefinitions || segmentDefinitions.length === 0) {
                logger.warn(`Could not create segment definitions for merged call ${transcriptionId}, falling back to normal processing`);
                logger.warn(`srcList: ${srcList}, freqList: ${freqList}`);
                // Fall through to normal processing
              } else {
                logger.info(`Created ${segmentDefinitions.length} segment definitions for merged call ${transcriptionId}`);
                segmentDefinitions.forEach((seg, idx) => {
                  logger.info(`Segment ${idx}: ${seg.sourceDisplay} (${seg.sourceId}) from ${seg.startPos}s to ${seg.endPos}s (${seg.errors}E/${seg.spikes}S)`);
                });
                // Use the final path for splitting (or tempPath if S3)
                const audioPathForSplitting = finalPathIfLocal || tempPath;
                
                // Split the audio file
                splitAudioFile(audioPathForSplitting, segmentDefinitions, async (segmentsWithAudio) => {
                  if (segmentsWithAudio.length < 2) {
                    // Nothing worth splitting (e.g. the only other source keyed up after the audio ended)
                    logger.warn(`Merged call ${transcriptionId} has ${segmentsWithAudio.length} usable segment(s); transcribing the whole call instead`);
                    segmentsWithAudio.forEach((seg) => fs.unlink(seg.audioPath, () => {}));
                    processWholeCall();
                    return;
                  }
                  
                  // Sort segments by position since ffmpeg runs in parallel and may complete out of order
                  segmentsWithAudio.sort((a, b) => (a.startPos || 0) - (b.startPos || 0));
                  logger.info(`Successfully split audio into ${segmentsWithAudio.length} segments for ID ${transcriptionId} (sorted by position)`);
                  
                  // Transcribe each segment separately
                  const segmentTranscriptions = [];
                  let completedTranscriptions = 0;
                  
                  segmentsWithAudio.forEach((segment, index) => {
                    // Transcribe this segment
                    const segmentCallback = (segmentTranscription) => {
                      completedTranscriptions++;
                      fs.unlink(segment.audioPath, () => {}); // transcription finished with this file
                      
                      if (segmentTranscription) {
                        segmentTranscriptions.push({
                          ...segment,
                          transcription: segmentTranscription
                        });
                      }
                      
                      // When all segments are transcribed, process them
                      if (completedTranscriptions === segmentsWithAudio.length) {
                        processMergedCallSegments(
                          transcriptionId,
                          segmentTranscriptions,
                          talkGroupID,
                          systemName,
                          talkGroupName,
                          talkGroupGroup,
                          storagePath,
                          audioPathForSplitting,
                          tempPath,
                          finalPathIfLocal
                        );
                      }
                    };
                    
                    // Transcribe based on mode (use the same mode as the main call)
                    const segmentDuration = (segment.endPos || 0) - (segment.startPos || 0);
                    runTranscriptionPipeline(segment.audioPath, segmentDuration, segmentCallback,
                      (audioPath, _wasPreprocessed, done) => transcribeByMode(audioPath, done));
                  });
                });
                
                return; // Don't process normally for merged calls
              }
            }
            
            // Normal (whole-call) processing. A function declaration so the merged-call
            // path can fall back to it when splitting yields fewer than two usable segments.
            function processWholeCall() {
              // Define the common callback for processing transcription results
              const processingCallback = async (transcriptionText) => {
                  if (!transcriptionText) {
                    // Check if this might be a tone file by looking at the talk group
                    const possibleToneFile = IS_TWO_TONE_MODE_ENABLED && TWO_TONE_TALK_GROUPS.includes(talkGroupID);
                    const warningMsg = possibleToneFile ? 
                      `No transcription obtained for ID ${transcriptionId} (${filename}) - likely tone file or too short` :
                      `No transcription obtained for ID ${transcriptionId} (${filename}) - file too short or no speech`;
                  
                    logger.warn(warningMsg);
                    updateTranscription(transcriptionId, "", async () => {
                      logger.info(`Updated DB with empty transcription for ID ${transcriptionId}`);
                    
                      // *** IMPORTANT: Check for two-tone even with empty transcription ***
                      // Tone files might contain only tones without voice content
                      if (IS_TWO_TONE_MODE_ENABLED && TWO_TONE_TALK_GROUPS.includes(talkGroupID)) {
                        logger.info(`Checking for two-tone in talk group ${talkGroupID} (ID: ${transcriptionId}) - empty transcription`);
                      
                        // Use a local audio path for tone detection (works for all
                        // storage backends because the temp file is still present).
                        const audioPathForTones = finalPathIfLocal || tempPath;
                      
                        // Wait for tone detection to complete before continuing
                        await new Promise((resolve) => {
                          detectTwoToneQueued(audioPathForTones, transcriptionId, talkGroupID, (hasTwoTone, detectedTones, detectedType) => {
                            handleToneDetectionResult(hasTwoTone, detectedTones, transcriptionId, talkGroupID, detectedType);
                            resolve();
                          });
                        });
                      
                        logger.info(`Tone detection completed for ID ${transcriptionId} (empty transcription)`);
                      }
                    
                      // Clean up temp file for non-local storage (local already moved it)
                      if (STORAGE_DEFERS_TEMP_CLEANUP) {
                        // Use setImmediate to avoid file handle race conditions
                        setImmediate(() => {
                           fs.unlink(tempPath, (errUnlink) => {
                             if (errUnlink && errUnlink.code !== 'ENOENT') {
                               logger.error(`Error deleting temp file (after empty transcription) ${tempPath}:`, errUnlink);
                             } else if (!errUnlink) {
                               logger.info(`Deleted temp file (after empty transcription): ${path.basename(tempPath)}`);
                             }
                           });
                        });
                      }
                    });
                    return;
                  }

                  // Format talker alias for display - use talkerAlias if available, otherwise use source, fallback to talkgroup
                  const displayAlias = talkerAlias || (source && source !== 'Unknown' ? `Unit-${source}` : `TG-${talkGroupID}`);
                  logCallHeader(talkGroupID, talkGroupName, transcriptionId);
                  logger.info(`Transcription Text: (${displayAlias}) ${transcriptionText}`);
                  // We got transcription text, update the database
                  updateTranscription(transcriptionId, transcriptionText, async () => {
                    logger.info(`Updated DB transcription for ID ${transcriptionId}`);

                    // Now handle the logic that uses the transcription - WAIT for it to complete
                    // rdio-scanner uploads don't include call_length; measure the audio
                    let callLengthForMessage = call_length;
                    if (!(parseFloat(callLengthForMessage) > 0)) {
                      callLengthForMessage = await new Promise((resolve) => {
                        getAudioDuration(finalPathIfLocal || tempPath, (durErr, dur) => resolve(durErr ? null : dur));
                      });
                    }

                    await handleNewTranscription(
                      transcriptionId, transcriptionText, talkGroupID, systemName,
                      talkGroupName, source, talkerAlias, talkGroupGroup, storagePath, // Pass storagePath
                      totalErrors, totalSpikes, // <-- Pass error/spike counts
                      emergency, priority, encrypted, callLengthForMessage, // <-- Pass call metadata
                      freq_error, signalQuality, // <-- Pass signal quality
                      frequency, start_time, stop_time, // <-- Pass timing/frequency
                      tdma_slot, phase2_tdma, color_code // <-- Pass TDMA/color code
                    );

                    // Clean up temp file for non-local storage (local already moved it)
                    if (STORAGE_DEFERS_TEMP_CLEANUP) {
                      // Use setImmediate to avoid file handle race conditions
                      setImmediate(() => {
                        fs.unlink(tempPath, (errUnlink) => {
                           if (errUnlink && errUnlink.code !== 'ENOENT') {
                             logger.error(`Error deleting temp file (after successful transcription) ${tempPath}:`, errUnlink);
                           } else if (!errUnlink) {
                             logger.info(`Deleted temp file (after successful transcription): ${path.basename(tempPath)}`);
                           }
                        });
                      });
                    }
                    logger.info(`Successfully processed: ${filename}`);
                  });
              };
              // --- End common callback definition ---

              // --- Transcription whitelist/blacklist gate ---
              // Lets TrunkRecorder users (who can't pre-filter what they upload)
              // skip transcribing noisy/irrelevant talkgroups. The call record and
              // audio are still stored; we just don't run AI transcription on it.
              if (!shouldTranscribe(talkGroupID, systemName)) {
                logger.info(`Skipping transcription for ID ${transcriptionId} (TG ${talkGroupID}${systemName ? '/' + systemName : ''}) per TRANSCRIBE_MODE=${TRANSCRIBE_MODE_VALUE}`);
                processingCallback('');
                return;
              }

              // --- Choose transcription method based on mode ---
              logger.info(`Initiating transcription for ID ${transcriptionId} using mode: ${effectiveTranscriptionMode}`);

              // Audio cleanup + hallucination filtering wrap every mode.
              const sourceAudioPath = finalPathIfLocal || tempPath;
              runTranscriptionPipeline(sourceAudioPath, parseFloat(call_length), processingCallback, (audioPath, wasPreprocessed, done) => {
                if (effectiveTranscriptionMode !== 'local') {
                  transcribeByMode(audioPath, done);
                  return;
                }

                // 'local' transcription mode
                  const localRequestId = uuidv4();
                  let payload;

                  if (STORAGE_DEFERS_TEMP_CLEANUP && !wasPreprocessed) {
                      // Remote object storage / DB blob + Local Transcription: Send buffer
                      logger.info(`Queueing local transcription (ID: ${localRequestId}) for DB ID ${transcriptionId} using BASE64 BUFFER`);
                    
                      // Check buffer size before encoding to prevent memory issues
                      const bufferSizeMB = fileBuffer.length / (1024 * 1024);
                      if (bufferSizeMB > 45) { // Leave some headroom under the 50MB limit
                        logger.error(`Audio buffer too large for local transcription: ${bufferSizeMB.toFixed(2)}MB. Failing transcription for ID ${transcriptionId}.`);
                        done(""); // Fail the transcription
                        return;
                      }
                    
                      payload = {
                          command: 'transcribe',
                          id: localRequestId,
                          audio_data_base64: fileBuffer.toString('base64') // Send the buffer directly
                      };
                      // NOTE: tempPath will be deleted later in processingCallback
                  } else {
                      // Local Storage (or preprocessed audio) + Local Transcription: Send path
                      // Preprocessed WAV if cleanup ran, otherwise the stored/temp file
                      const pathToUse = audioPath;
                    
                      // Double-check file exists before queuing (race condition protection)
                      if (!fs.existsSync(pathToUse)) {
                           logger.error(`Local audio file ${pathToUse} missing before queuing for local transcription (ID ${transcriptionId}). Aborting.`);
                           done(""); // Fail the transcription
                           return; // Don't queue
                      }
                    
                      // Verify file is readable
                      try {
                        fs.accessSync(pathToUse, fs.constants.R_OK);
                      } catch (accessError) {
                        logger.error(`Local audio file ${pathToUse} not readable before queuing: ${accessError.message}`);
                        done(""); // Fail the transcription
                        return;
                      }
                    
                      logger.info(`Queueing local transcription (ID: ${localRequestId}) for DB ID ${transcriptionId} using PATH: ${pathToUse}`);
                      payload = {
                          command: 'transcribe',
                          id: localRequestId,
                          path: pathToUse // Send the final path or temp path
                      };
                  }

                  // Check if queue is getting too large (high-volume protection)
                  if (transcriptionQueue.length >= MAX_QUEUE_SIZE) {
                    logger.error(`Transcription queue full (${MAX_QUEUE_SIZE} items). Dropping oldest items to prevent memory issues.`);
                  
                    // Remove oldest items beyond threshold, keeping newer ones
                    const itemsToRemove = transcriptionQueue.length - PRIORITY_QUEUE_THRESHOLD;
                    for (let i = 0; i < itemsToRemove; i++) {
                      const droppedItem = transcriptionQueue.shift();
                      if (droppedItem && droppedItem.callback) {
                        try {
                          droppedItem.callback(""); // Fail the dropped transcription
                          logger.warn(`Dropped transcription ID ${droppedItem.dbTranscriptionId} due to queue overflow`);
                        } catch (callbackError) {
                          logger.error(`Error executing callback for dropped item: ${callbackError.message}`);
                        }
                      }
                    }
                  }

                  // Add the job with its specific payload to the queue
                  const queueItem = {
                     id: localRequestId, // ID for matching response from Python
                     payload: payload, // Contains either path or base64 data
                     callback: done,
                     dbTranscriptionId: transcriptionId,
                     queuedAt: Date.now(), // Track when item was queued for debugging
                     priority: Date.now() // Use timestamp as priority (newer = higher priority for busy systems)
                  };
                
                  // For very busy systems, add to front if queue is large (prioritize recent calls)
                  if (transcriptionQueue.length > PRIORITY_QUEUE_THRESHOLD) {
                    transcriptionQueue.unshift(queueItem); // Add to front
                    logger.info(`HIGH VOLUME: Added transcription to front of queue (current size: ${transcriptionQueue.length})`);
                  } else {
                    transcriptionQueue.push(queueItem); // Normal operation
                  }
                
                  // Use setImmediate to avoid potential race conditions in queue processing
                  setImmediate(() => {
                    processNextTranscription(); // Trigger the local queue processor
                  });
              });
              // --- End mode choice ---
            }

            processWholeCall();
        };
        // --- End afterStorageComplete function definition ---

        // --- Handle Audio Storage via the storage abstraction ---
        // STORAGE_USES_DB: audio already lives in the SQLite blob (inserted above).
        // Temp file is kept (not deleted here) so transcription can read it;
        // it is cleaned up later in processingCallback.
        if (STORAGE_USES_DB) {
          afterStorageComplete(null);
        } else {
          const ext = path.extname(storagePath).toLowerCase();
          const contentType = ext === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
          if (!STORAGE_IS_LOCAL) {
            // Remote object storage: retry, then park the file locally for the
            // re-upload job (pendingUploads.flushPending) instead of dropping the
            // call. The temp file stays as transcription input either way.
            pendingUploads.saveWithFallback(storage, storagePath, fileBuffer, contentType)
              .then((result) => {
                if (result.location === 'remote') {
                  db.run('UPDATE transcriptions SET storage_key = ?, storage_mode = ? WHERE id = ?',
                    [storagePath, storage.type, transcriptionId], () => {});
                  logger.info(`Stored audio for ID ${transcriptionId} in ${storage.type}: ${storagePath}`);
                } else if (result.location === 'pending') {
                  db.run('UPDATE transcriptions SET storage_key = ?, storage_mode = ? WHERE id = ?',
                    [storagePath, pendingUploads.PENDING_MODE, transcriptionId], () => {});
                  logger.warn(`${storage.type} unavailable for ID ${transcriptionId}; audio saved locally and will be re-uploaded`);
                } else {
                  db.run('UPDATE transcriptions SET storage_key = NULL, audio_file_path = NULL WHERE id = ?',
                    [transcriptionId], () => {});
                  logger.error(`Audio for ID ${transcriptionId} could not be stored anywhere; keeping the call and transcript without audio`);
                }
                afterStorageComplete(null);
              })
              .catch((storeErr) => {
                logger.error(`Unexpected storage error for ID ${transcriptionId}: ${storeErr.message}; transcribing anyway`);
                afterStorageComplete(null);
              });
          } else {
          // Local disk storage
          storage
            .save(storagePath, fileBuffer, contentType)
            .then(() => {
              db.run(
                'UPDATE transcriptions SET storage_key = ?, storage_mode = ? WHERE id = ?',
                [storagePath, storage.type, transcriptionId],
                () => {}
              );
              logger.info(`Stored audio for ID ${transcriptionId} in ${storage.type}: ${storagePath}`);
              if (STORAGE_IS_LOCAL) {
                const finalLocal = path.join(storage.baseDir, storagePath);
                // The upload is written straight into the audio dir, so tempPath
                // is usually the SAME file as the stored destination. Only delete
                // it when it's a genuinely separate temp copy — otherwise we'd be
                // deleting the very file the transcriber is about to read.
                if (path.resolve(tempPath) !== path.resolve(finalLocal)) {
                  fs.unlink(tempPath, () => {});
                }
                afterStorageComplete(finalLocal);
              } else {
                // Remote object storage: keep temp file for transcription input.
                afterStorageComplete(null);
              }
            })
            .catch((storeErr) => {
              logger.error(`Error storing audio for ID ${transcriptionId} (${storage.type}, key ${storagePath}): ${storeErr.message}`);
              db.run('DELETE FROM transcriptions WHERE id = ?', [transcriptionId], () => {});
              fs.unlink(tempPath, () => {});
            });
          }
        }
        // --- End Storage Handling ---

        // REMOVED: Original transcription initiation logic moved inside handleStorageAndTranscription

      } // End of db.run callback for transcriptions insert
    ); // End of db.run call for transcriptions
  }); // End of fs.readFile
}

// Helper function to validate individual fields
function isValidField(name, value) {
  return typeof name === 'string' && name.trim() !== '' &&
         typeof value === 'string' && value.trim() !== '';
}

// Function to validate and add fields to the embed
function validateAndAddFields(embed, fields) {
  // Maximum length for field values in Discord embeds is 1024 characters
  const MAX_FIELD_LENGTH = 1024;

  fields.forEach(field => {
    // Ensure name and value are strings and not empty
    const name = String(field.name || 'Unnamed Field').trim();
    let value = String(field.value || 'No information available').trim();
    
    // Truncate value if it exceeds Discord's limit
    if (value.length > MAX_FIELD_LENGTH) {
      value = value.substring(0, MAX_FIELD_LENGTH - 3) + '...';
    }

    // Only add field if both name and value are non-empty
    if (name && value) {
      try {
        embed.addFields({
          name: name,
          value: value,
          inline: Boolean(field.inline)
        });
      } catch (error) {
        console.error(`Failed to add field: ${name}`, error);
      }
    }
  });

  return embed;
}

// Function to update transcription
function updateTranscription(id, transcriptionText, callback) {
  logger.info(`Calling updateTranscription for ID ${id}`);
  db.run(
    `UPDATE transcriptions SET transcription = ? WHERE id = ?`,
    [transcriptionText, id],
    (err) => {
      if (err) {
        logger.error('Error updating transcription:', err);
      } else {
        logger.info(`Updated transcription for ID ${id}`);
      }
      if (callback) callback();
    }
  );
}

// Retention window for audio (days). 0 = keep forever.
const retentionDaysSetting = () => {
  const days = parseInt(process.env.AUDIO_RETENTION_DAYS, 10);
  return Number.isFinite(days) ? days : 30;
};
let RETENTION_DAYS = retentionDaysSetting();

// Function to cleanup old audio files (DB blobs AND objects in the storage backend)
// Remove merged-call segment files a crash or restart left behind (normally
// deleted as soon as their transcription finishes).
function cleanupStaleSegmentFiles() {
  try {
    const staleBefore = Date.now() - 60 * 60 * 1000;
    let removed = 0;
    for (const name of fs.readdirSync(UPLOAD_DIR)) {
      if (!name.startsWith('segment_')) continue;
      const file = path.join(UPLOAD_DIR, name);
      if (fs.statSync(file).mtimeMs < staleBefore) { fs.unlinkSync(file); removed++; }
    }
    if (removed) logger.info(`Removed ${removed} stale merged-call segment files`);
  } catch (e) {
    logger.warn(`Segment file cleanup failed: ${e.message}`);
  }
}

function cleanupOldAudioFiles() {
  cleanupStaleSegmentFiles();

  // Always prune the legacy listen-live blobs after 7 days.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  db.run(`DELETE FROM audio_files WHERE created_at < ?`, [sevenDaysAgo], (err) => {
    if (err) logger.error('Error cleaning up old audio blobs:', err);
    else logger.debug('Pruned old audio blobs.');
  });

  // Prune stored audio objects/files older than the retention window.
  //
  // Batched loop rather than a single fixed LIMIT: a backlog (ingest rate
  // higher than one run clears, or a period where the job didn't run) is
  // actually drained instead of falling permanently behind. Both key columns
  // are cleared after a confirmed delete so pruned rows aren't re-selected on
  // every subsequent run.
  if (RETENTION_DAYS > 0 && storage) {
    const cutoffSec = Math.floor((Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000);
    const RETENTION_BATCH = 1000;
    const RETENTION_MAX_BATCHES = 1000; // safety cap: <= 1M objects per run
    let totalRemoved = 0;

    const runRetentionBatch = (batchNum) => {
      if (batchNum >= RETENTION_MAX_BATCHES) {
        logger.warn(`Retention: reached batch cap (${RETENTION_MAX_BATCHES}); removed ${totalRemoved} this run, remainder deferred to next run.`);
        return;
      }
      db.all(
        `SELECT id, storage_key, audio_file_path FROM transcriptions
           WHERE timestamp < ? AND (storage_key IS NOT NULL OR audio_file_path IS NOT NULL)
           LIMIT ?`,
        [cutoffSec, RETENTION_BATCH],
        async (err, rows) => {
          if (err) { logger.error(`Retention query failed: ${err.message}`); return; }
          if (!rows || !rows.length) {
            if (totalRemoved) logger.info(`Retention: removed ${totalRemoved} audio objects older than ${RETENTION_DAYS} days.`);
            return;
          }
          let removedThisBatch = 0;
          for (const row of rows) {
            const key = row.storage_key || row.audio_file_path;
            if (!key) continue;
            try {
              await storage.delete(key);
            } catch (e) {
              logger.warn(`Retention: could not delete ${key}: ${e.message}`);
              continue; // leave the row for a later retry
            }
            db.run('UPDATE transcriptions SET storage_key = NULL, audio_file_path = NULL WHERE id = ?', [row.id], () => {});
            removedThisBatch += 1;
            totalRemoved += 1;
          }
          if (removedThisBatch === 0) {
            logger.warn(`Retention: batch of ${rows.length} made no progress (all deletes failed/skipped); stopping this run.`);
            if (totalRemoved) logger.info(`Retention: removed ${totalRemoved} audio objects older than ${RETENTION_DAYS} days.`);
            return;
          }
          setImmediate(() => runRetentionBatch(batchNum + 1));
        }
      );
    };

    runRetentionBatch(0);
  }
}

// Run cleanup every day
setInterval(cleanupOldAudioFiles, 24 * 60 * 60 * 1000);
cleanupStaleSegmentFiles(); // also clear leftovers from before this start

// --- Re-upload audio parked locally while remote storage was unreachable ---
// Calls whose upload failed were saved under STORAGE_FALLBACK_DIR with
// storage_mode='pending'. This job uploads them, marks them as stored, and
// deletes the local copies (or just deletes them if the call is gone).
const pendingUploadIntervalMs = () => Math.max(1, parseInt(process.env.STORAGE_RETRY_INTERVAL_MIN, 10) || 5) * 60 * 1000;

async function runPendingUploadJob() {
  if (!storage || STORAGE_IS_LOCAL) return;
  try {
    const stats = await pendingUploads.flushPending(storage, {
      // Row still waiting for this file? (null = call deleted/purged, drop the copy)
      getRow: (key) => new Promise((resolve, reject) => db.get(
        'SELECT id FROM transcriptions WHERE storage_key = ? AND storage_mode = ?',
        [key, pendingUploads.PENDING_MODE],
        (err, row) => (err ? reject(err) : resolve(row || null)))),
      markUploaded: (key) => new Promise((resolve, reject) => db.run(
        'UPDATE transcriptions SET storage_mode = ? WHERE storage_key = ? AND storage_mode = ?',
        [storage.type, key, pendingUploads.PENDING_MODE],
        (err) => (err ? reject(err) : resolve()))),
    });
    if (!stats || !(stats.uploaded || stats.removed || stats.failed)) return;
    const summary = `Pending uploads: ${stats.uploaded} re-uploaded to ${storage.type}, ${stats.removed} orphaned copies removed, ` +
      `${stats.failed} failed, ${stats.remaining} still waiting`;
    if (stats.failed && !stats.uploaded) logger.warn(summary);
    else logger.log({ level: 'info', message: summary, console: true });
  } catch (err) {
    logger.error(`Pending upload job failed: ${err.message}`);
  }
}

let pendingUploadTimer = setInterval(runPendingUploadJob, pendingUploadIntervalMs());
function reschedulePendingUploads() {
  clearInterval(pendingUploadTimer);
  pendingUploadTimer = setInterval(runPendingUploadJob, pendingUploadIntervalMs());
}
setTimeout(runPendingUploadJob, 60 * 1000); // first pass shortly after startup

// Function to transcribe audio
function transcribeAudio(filePath, callback) {
  // First check if the file exists before attempting transcription
  if (!fs.existsSync(filePath)) {
    logger.warn(`Audio file does not exist when starting transcription: ${filePath}`);
    if (callback) {
      callback(""); // Return empty string for non-existent files
    }
    return;
  }
  
  // Add file validation step
  try {
    // Check file size - skip files that are too small or too large
    const stats = fs.statSync(filePath);
    if (stats.size < 1000) { // Less than 1KB
      logger.warn(`Audio file too small, likely corrupted: ${filePath} (${stats.size} bytes)`);
      if (callback) callback("");
      return;
    }
    
    // You could add additional validation here if needed
  } catch (error) {
    logger.error(`Error validating audio file: ${error.message}`);
    if (callback) callback("");
    return;
  }
  
  if (!transcriptionProcess) {
    startTranscriptionProcess();
  }
  
  const requestId = uuidv4();
  
  // Create a wrapper callback to match your existing flow
  const processCallback = (transcriptionText) => {
    if (callback) {
      callback(transcriptionText);
    }
  };
  
  // Add to queue with a payload matching what processNextTranscription expects
  // ({ id, payload, callback }). Previously this pushed { path } which produced
  // an undefined payload and broke merged-call segment transcription.
  transcriptionQueue.push({
    id: requestId,
    payload: { command: 'transcribe', id: requestId, path: filePath },
    callback: processCallback,
    retries: 0,
    maxRetries: 2
  });
  
  // Try to process
  processNextTranscription();
}

// Function to get category name based on talkgroupGroup or systemName
function getCategoryName(systemName, talkgroupGroup) {
  if (talkgroupGroup) {
    return talkgroupGroup.trim();
  }

  if (systemName) {
    return systemName.trim();
  }

  return 'Other';
}

// Helper function to check if a call is merged (has multiple sources)
function isMergedCall(srcList) {
  if (!srcList) {
    logger.debug('isMergedCall: No srcList provided');
    return false;
  }
  
  try {
    const srcListData = typeof srcList === 'string' ? JSON.parse(srcList) : srcList;
    
    if (!Array.isArray(srcListData) || srcListData.length === 0) {
      logger.debug('isMergedCall: srcList is not a valid array or is empty');
      return false;
    }
    
    // Get unique valid sources (excluding -1)
    const uniqueSources = new Set();
    for (const srcEntry of srcListData) {
      if (srcEntry.src && srcEntry.src !== -1) {
        uniqueSources.add(srcEntry.src);
      }
    }
    
    const isMerged = uniqueSources.size > 1;
    logger.info(`isMergedCall: Found ${uniqueSources.size} unique sources: ${Array.from(uniqueSources).join(', ')} - Merged: ${isMerged}`);
    
    // If we have more than one unique source, it's a merged call
    return isMerged;
    
  } catch (error) {
    logger.warn(`Error checking if call is merged: ${error.message}`);
    return false;
  }
}

// Helper function to create segment definitions from srcList and freqList
function createSegmentDefinitions(srcList, freqList, defaultSource, defaultTalkerAlias) {
  if (!srcList || !freqList) {
    return null;
  }
  
  try {
    const srcListData = typeof srcList === 'string' ? JSON.parse(srcList) : srcList;
    const freqListData = typeof freqList === 'string' ? JSON.parse(freqList) : freqList;
    
    if (!Array.isArray(srcListData) || !Array.isArray(freqListData) || srcListData.length === 0) {
      return null;
    }
    
    // Create segments: group consecutive srcList entries with the same source
    const segments = [];
    let currentSegment = null;
    
    for (let i = 0; i < srcListData.length; i++) {
      const srcEntry = srcListData[i];
      
      // Skip invalid sources (-1 means unknown/unavailable)
      if (!srcEntry.src || srcEntry.src === -1) {
        continue;
      }
      
      // Get source display name - prioritize tag (OTA alias) over source ID
      const sourceDisplay = srcEntry.tag && srcEntry.tag.trim() !== '' 
        ? srcEntry.tag.trim() 
        : (srcEntry.src ? `Unit-${srcEntry.src}` : defaultSource);
      
      // Calculate end position: use len if available, otherwise use next entry's pos, or estimate
      let segmentEndPos;
      if (srcEntry.len && srcEntry.len > 0) {
        // Use explicit length
        segmentEndPos = (srcEntry.pos || 0) + srcEntry.len;
      } else {
        // No len field - find the next entry with a different source or use next entry's pos
        let nextPos = null;
        for (let j = i + 1; j < srcListData.length; j++) {
          const nextEntry = srcListData[j];
          if (nextEntry.src && nextEntry.src !== -1) {
            // If different source, use its position as end
            if (nextEntry.src !== srcEntry.src) {
              nextPos = nextEntry.pos || 0;
              break;
            }
            // If same source, continue to find where it changes
          }
        }
        
        if (nextPos !== null && nextPos > (srcEntry.pos || 0)) {
          segmentEndPos = nextPos;
        } else {
          // No next entry found - estimate 5 seconds as default duration
          // This will be adjusted when we have the actual audio file duration
          segmentEndPos = (srcEntry.pos || 0) + 5.0;
        }
      }
      
      // Find freqList entries that overlap with this srcEntry's position
      const segmentFreqs = freqListData.filter(freq => {
        const freqStart = freq.pos || 0;
        const freqEnd = freqStart + (freq.len || 0);
        const srcPos = srcEntry.pos || 0;
        return freqStart <= srcPos && freqEnd > srcPos;
      });
      
      // Calculate errors and spikes for this segment's frequency entries
      // Handle both camelCase (TrunkRecorder) and snake_case formats
      let segmentErrors = 0;
      let segmentSpikes = 0;
      segmentFreqs.forEach(freq => {
        segmentErrors += freq.errorCount || freq.error_count || 0;
        segmentSpikes += freq.spikeCount || freq.spike_count || 0;
      });
      
      // Check if this is a continuation of the current segment (same source)
      // For same source, we extend the segment to include all entries from that source
      const isSameSource = currentSegment && 
                           currentSegment.sourceId === srcEntry.src;
      
      if (isSameSource) {
        // Extend current segment - update end position to include this entry
        // The endPos will be set to the next different source's position (or estimated)
        currentSegment.endPos = Math.max(currentSegment.endPos || 0, segmentEndPos);
        // Accumulate errors/spikes from overlapping freqs for this entry
        // Handle both camelCase (TrunkRecorder) and snake_case formats
        segmentFreqs.forEach(freq => {
          currentSegment.errors += freq.errorCount || freq.error_count || 0;
          currentSegment.spikes += freq.spikeCount || freq.spike_count || 0;
        });
      } else {
        // Start new segment (different source, first segment, or gap too large)
        if (currentSegment) {
          segments.push(currentSegment);
        }
        currentSegment = {
          sourceDisplay: sourceDisplay,
          sourceId: srcEntry.src,
          startPos: srcEntry.pos || 0,
          endPos: segmentEndPos,
          errors: segmentErrors,
          spikes: segmentSpikes
        };
      }
    }
    
    // Add the last segment
    if (currentSegment) {
      segments.push(currentSegment);
    }
    
    return segments.length > 1 ? segments : null;
    
  } catch (error) {
    logger.warn(`Error creating segment definitions: ${error.message}`);
    return null;
  }
}

// Helper function to get audio file duration using ffprobe
function getAudioDuration(audioFilePath, callback) {
  const { spawn } = require('child_process');
  const ffprobeArgs = [
    '-v', 'quiet',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioFilePath
  ];
  
  const ffprobeProcess = spawn('ffprobe', ffprobeArgs);
  let output = '';
  let errorOutput = '';
  
  ffprobeProcess.stdout.on('data', (data) => {
    output += data.toString();
  });
  
  ffprobeProcess.stderr.on('data', (data) => {
    errorOutput += data.toString();
  });
  
  ffprobeProcess.on('close', (code) => {
    if (code === 0) {
      const duration = parseFloat(output.trim());
      if (!isNaN(duration) && duration > 0) {
        callback(null, duration);
      } else {
        callback(new Error(`Invalid duration: ${output.trim()}`));
      }
    } else {
      callback(new Error(`ffprobe failed with code ${code}: ${errorOutput}`));
    }
  });
  
  ffprobeProcess.on('error', (error) => {
    callback(error);
  });
}

// Merged-call speaker segments shorter than this are dropped (key-ups, kerchunks)
// Split multi-speaker (merged) calls per speaker; false = transcribe the whole recording at once
let MERGED_CALL_SPLIT = String(process.env.MERGED_CALL_SPLIT || 'true').toLowerCase() !== 'false';

const mergedCallMinSegmentSec = () => {
  const v = parseFloat(process.env.MERGED_CALL_MIN_SEGMENT_SEC);
  return Number.isFinite(v) && v >= 0 ? v : 0.5;
};
let MERGED_CALL_MIN_SEGMENT_SEC = mergedCallMinSegmentSec();

// Function to split audio file into segments using ffmpeg
function splitAudioFile(audioFilePath, segments, callback) {
  if (!segments || segments.length === 0) {
    callback([]);
    return;
  }
  
  const { spawn } = require('child_process');
  const tempSegments = [];
  let completedSegments = 0;
  // Every segment (created, skipped or failed) counts once; report when all are done.
  const segmentDone = () => {
    completedSegments++;
    if (completedSegments === segments.length) callback(tempSegments);
  };
  
  // First, get the audio file duration to fix the last segment's endPos if needed
  getAudioDuration(audioFilePath, async (err, audioDuration) => {
    if (err) {
      logger.warn(`Could not get audio duration: ${err.message}, proceeding with segments as-is`);
    }

    // Snap each speaker change to a real silence in the recording. Older
    // TrunkRecorder Pro positions are whole wall-clock seconds that drift past
    // the audio; audio positions (Trunk Recorder, newer Pro) are only nudged.
    if (audioDuration && SEGMENT_ALIGN_CONFIG.enabled) {
      try {
        const silences = await segmentAlign.detectSilences(audioFilePath, SEGMENT_ALIGN_CONFIG);
        const aligned = segmentAlign.alignSegments(segments, silences, audioDuration, { minSegmentSec: MERGED_CALL_MIN_SEGMENT_SEC });
        if (aligned) {
          aligned.forEach((s) => {
            if (s.foldedSources) s.sourceDisplay = `${s.sourceDisplay} (+${s.foldedSources.join(', ')})`;
          });
          logger.info(`Aligned speaker changes to audio (${aligned.mode}): ${segments.slice(1).map((s) => s.startPos).join(', ')}s -> ` +
            `${aligned.slice(1).map((s) => s.startPos.toFixed(2)).join(', ')}s` +
            (aligned.length < segments.length ? ` (${segments.length - aligned.length} too short to separate)` : ''));
          segments = aligned;
        }
      } catch (alignErr) {
        logger.warn(`Could not align merged-call segments to audio (${alignErr.message}); using TrunkRecorder positions`);
      }
    }

    segments.forEach((segment, index) => {
      let startTime = segment.startPos || 0;
      let endTime = segment.endPos || 0;
      
      // If this is the last segment and endPos seems wrong (estimated), use actual audio duration
      if (index === segments.length - 1 && audioDuration && endTime < audioDuration && (endTime - startTime) < 1.0) {
        endTime = audioDuration;
        logger.info(`Adjusting last segment endPos from ${segment.endPos} to ${audioDuration} (actual audio duration)`);
      }
      // srcList positions (and the 5s estimate for entries without len) can run past
      // the recording; ffmpeg's copy mode then writes a header-only file with no audio.
      if (audioDuration && endTime > audioDuration) endTime = audioDuration;
      
      const duration = endTime - startTime;
      
      // Skip segments that are empty or too short to transcribe
      if (duration < MERGED_CALL_MIN_SEGMENT_SEC) {
        logger.info(`Skipping segment ${index} (${segment.sourceDisplay}): ${duration.toFixed(2)}s is under ${MERGED_CALL_MIN_SEGMENT_SEC}s (start: ${startTime}, end: ${endTime}, audio: ${audioDuration || '?'}s)`);
        segmentDone();
        return;
      }
      
      // Create temp file for this segment
      const tempSegmentPath = path.join(UPLOAD_DIR, `segment_${Date.now()}_${index}_${path.basename(audioFilePath)}`);
      
      // Use ffmpeg to extract the segment
      const ffmpegArgs = [
        '-i', audioFilePath,
        '-ss', startTime.toString(),
        '-t', duration.toString(),
        '-c', 'copy', // Copy codec (faster, no re-encoding)
        '-y', // Overwrite output file
        tempSegmentPath
      ];
      
      const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
      // 'error' and 'close' can both fire when spawning fails; count the segment once
      let counted = false;
      const finishSegment = () => { if (!counted) { counted = true; segmentDone(); } };
      
      ffmpegProcess.on('close', (code) => {
        // Copy mode can exit 0 yet write a header-only file; real AAC audio is well over 1 KB
        const segmentBytes = fs.existsSync(tempSegmentPath) ? fs.statSync(tempSegmentPath).size : 0;
        if (code === 0 && segmentBytes < 1000) {
          logger.warn(`Discarding audio segment ${index} (${segment.sourceDisplay}): output has no audio (${segmentBytes} bytes)`);
          fs.unlink(tempSegmentPath, () => {});
        } else if (code === 0 && segmentBytes > 0) {
          tempSegments.push({
            ...segment,
            audioPath: tempSegmentPath
          });
          logger.info(`Created audio segment ${index}: ${segment.sourceDisplay} (${startTime.toFixed(2)}s-${endTime.toFixed(2)}s, ${duration.toFixed(2)}s)`);
        } else {
          logger.warn(`Failed to create audio segment ${index} (${segment.sourceDisplay}): ffmpeg exited with code ${code}`);
        }
        finishSegment();
      });
      
      ffmpegProcess.on('error', (error) => {
        logger.error(`Error spawning ffmpeg for segment ${index} (${segment.sourceDisplay}): ${error.message}`);
        finishSegment();
      });
      
      // Suppress ffmpeg output
      ffmpegProcess.stdout.on('data', () => {});
      ffmpegProcess.stderr.on('data', () => {});
    });
  });
}

// Function to process merged call segments after transcription
// Start a call's block in the console: divider + talkgroup header. Logged
// right before the transcription so address/tone lines that follow sit under it.
// The call ID matches "Extracted Address for ID ..." when calls overlap.
function logCallHeader(talkGroupID, talkGroupName, callId) {
  logger.info('--- Incoming Request ---');
  logger.info(`Talk Group: ${talkGroupID} - ${talkGroupName || 'Unknown'} (call ${callId})`);
}

async function processMergedCallSegments(
  transcriptionId,
  segmentTranscriptions,
  talkGroupID,
  systemName,
  talkGroupName,
  talkGroupGroup,
  storagePath,
  audioPathForSplitting,
  tempPath,
  finalPathIfLocal
) {
  logger.info(`Processing ${segmentTranscriptions.length} segments for merged call ID ${transcriptionId}`);
  
  // Sort segments by their start position to ensure correct order
  const sortedSegments = [...segmentTranscriptions].sort((a, b) => (a.startPos || 0) - (b.startPos || 0));
  logger.info(`Sorted ${sortedSegments.length} segments by position for merged call ID ${transcriptionId}`);
  
  // Same console block as single-speaker calls: header, then one line per speaker
  logCallHeader(talkGroupID, talkGroupName, transcriptionId);
  for (const segment of sortedSegments) {
    if (segment.transcription && segment.transcription.trim()) {
      logger.info(`Transcription Text: (${segment.sourceDisplay}) ${segment.transcription.trim()}`);
    }
  }
  
  // Combine all transcriptions for the database (full call transcription)
  const fullTranscription = sortedSegments
    .map(seg => seg.transcription || '')
    .filter(text => text.trim() !== '')
    .join(' ')
    .trim();
  
  // One speaker line per segment in the Discord message
  const speakers = sortedSegments
    .filter((seg) => seg.transcription && seg.transcription.trim() !== '')
    .map((seg) => ({
      name: seg.sourceDisplay,
      text: seg.transcription.trim(),
      sq: seg.errors > 0 || seg.spikes > 0 ? `${seg.errors}E/${seg.spikes}S` : null,
    }));

  // Update database with combined transcription
  updateTranscription(transcriptionId, fullTranscription, async () => {
    logger.info(`Updated DB transcription for merged call ID ${transcriptionId}`);
    
    // Same address/tone handling as single-speaker calls, on the combined text and full recording
    let lateLocation = null;
    try {
      lateLocation = await analyzeCall(transcriptionId, fullTranscription, talkGroupID, talkGroupName, systemName, storagePath);
    } catch (error) {
      logger.error(`Error analyzing merged call ID ${transcriptionId}: ${error.message}`, { stack: error.stack });
    }
    
    // Send ONE message with all segments combined
    // Use the first segment's source for display, but the combined transcription
    const firstSegment = sortedSegments.find(seg => seg.transcription && seg.transcription.trim() !== '');
    if (!firstSegment) {
      logger.warn(`No valid segments with transcription for merged call ID ${transcriptionId}`);
      return;
    }
    
    const details = await gatherCallDetails(transcriptionId, fullTranscription, talkGroupID);
    const lastSegment = sortedSegments[sortedSegments.length - 1];
    const entry = buildCallEntry({
      id: transcriptionId,
      speakers,
      details,
      durationSec: lastSegment && lastSegment.endPos,
      startTime: null,
    });
    const mergedMessageUrl = await postCallMessage(entry, talkGroupID, talkGroupName, systemName);
    scheduleCategoryRefresh(entry);
    if (lateLocation) lateLocation.lookup.then((outcome) => { if (outcome === 'found') return addLateLocation(entry); }).catch(() => {});

    // Keyword alerts on the combined text
    try {
      await alertOnKeywords(entry, talkGroupName, systemName, mergedMessageUrl || null);
    } catch (error) {
      logger.error(`Error checking keywords for merged call ID ${transcriptionId}: ${error.message}`, { stack: error.stack });
    }

    if (isTalkGroupLive(talkGroupID)) {
      playAudioForTalkGroup(talkGroupID, transcriptionId);
    }
    
    // Clean up temp file for non-local storage (local already moved it)
    if (STORAGE_DEFERS_TEMP_CLEANUP) {
      setImmediate(() => {
        fs.unlink(tempPath, (errUnlink) => {
          if (errUnlink && errUnlink.code !== 'ENOENT') {
            logger.error(`Error deleting temp file (after merged call processing) ${tempPath}:`, errUnlink);
          } else if (!errUnlink) {
            logger.info(`Deleted temp file (after merged call processing): ${path.basename(tempPath)}`);
          }
        });
      });
    }
    
    logger.info(`Successfully processed merged call: ${transcriptionId}`);
  });
}

// Post-transcription analysis shared by normal and merged (per-speaker) calls:
// two-tone follow-up queueing, address extraction/geocoding and tone detection.
// audioFilePath is the storage key / path of the full call recording.
// Resolves with a promise for an address lookup still waiting on the AI (see
// addLateLocation), or null.
async function analyzeCall(id, transcriptionText, talkGroupID, talkGroupName, systemName, audioFilePath) {
  // Auto-queue calls after two-tone detection (if in two-tone mode)
  if (IS_TWO_TONE_MODE_ENABLED && lastTwoToneTime > 0 && lastDetectedToneGroup) {
    const timeSinceTwoTone = Date.now() - lastTwoToneTime;
    const isSameTalkGroup = talkGroupID === lastDetectedToneGroup;
    const sameTgQueueCount = twoToneQueue.filter(call => call.talkGroupID === talkGroupID).length;
    
    const shouldAutoQueue = timeSinceTwoTone < 60000 && // Within 1 minute of two-tone
                           isSameTalkGroup && // Same talk group as tone detection
                           sameTgQueueCount < TWO_TONE_QUEUE_SIZE_VALUE; // Queue not full for this TG
    
    if (shouldAutoQueue) {
      logger.info(`Auto-queuing call ID ${id} from TG ${talkGroupID} for address extraction (${timeSinceTwoTone}ms after tone)`);
      addToTwoToneQueue({
        id: id,
        talkGroupID: talkGroupID,
        talkGroupName: talkGroupName,
        transcriptionText: transcriptionText
      });
    } else if (IS_TWO_TONE_MODE_ENABLED && lastTwoToneTime > 0) {
      if (!isSameTalkGroup) {
        logger.info(`Skipping auto-queue for ID ${id}: Different talk group (${talkGroupID} vs ${lastDetectedToneGroup})`);
      } else if (sameTgQueueCount >= TWO_TONE_QUEUE_SIZE_VALUE) {
        logger.info(`Skipping auto-queue for ID ${id}: Queue full for TG ${talkGroupID}`);
      }
    }
  }

  // Handle address extraction based on mode
  const locationPossible = !ADDRESS_PREFILTER_ENABLED || streetMatching.mightContainLocation(transcriptionText);
  let lateLocation = null;
  if (transcriptionText.length >= 15 && locationPossible && shouldCheckForAddress(talkGroupID, id, systemName)) {
    if (llmQueue.isPausedByHand()) {
      // Nothing is sent while paused; the call is looked up when the AI is resumed (aiCatchUp)
      logger.info(`AI is paused; posting call ${id} now and looking up its location when the AI is resumed`);
    } else if (llmQueue.isAvailable()) {
      await extractAndProcessAddress(id, transcriptionText, talkGroupID, systemName);
    } else {
      // The AI isn't answering: post the call now instead of holding it, and
      // add the location once the queued request is answered.
      logger.info(`AI is not answering; posting call ${id} now and adding its location when the AI is back`);
      // Wrapped: an async function's return value would wait for a bare promise
      lateLocation = { lookup: extractAndProcessAddress(id, transcriptionText, talkGroupID, systemName) };
    }
  } else if (transcriptionText.length < 15) {
    logger.info(`Skipping address extraction for short transcription (ID ${id}): ${transcriptionText.length} characters`);
  } else if (!locationPossible) {
    logger.debug(`Skipping address extraction for ID ${id}: no number, street or place mentioned`);
  } else if (!IS_TWO_TONE_MODE_ENABLED) {
    logger.info(`Skipping address extraction for non-whitelisted talk group: ${talkGroupID}`);
  }

  // Handle two-tone detection if enabled and this is a monitored talk group
  if (IS_TWO_TONE_MODE_ENABLED && TWO_TONE_TALK_GROUPS.includes(talkGroupID) && audioFilePath) {
    logger.info(`Checking for two-tone in talk group ${talkGroupID} (ID: ${id})`);

    // Tone detection needs a local file. For local storage use it directly;
    // for remote object storage, materialize a short-lived temp copy.
    const localBase = (storage && storage.baseDir) ? storage.baseDir : path.join(__dirname, 'audio');
    let audioPathForTones = path.join(localBase, audioFilePath);
    let toneTempToClean = null;
    let parkedCopy = null;
    try { parkedCopy = pendingUploads.pendingPath(audioFilePath); } catch (_) { /* invalid key */ }
    if (!STORAGE_IS_LOCAL && parkedCopy && fs.existsSync(parkedCopy)) {
      // Upload failed and the audio is parked locally awaiting re-upload
      audioPathForTones = parkedCopy;
    } else if (!STORAGE_IS_LOCAL && storage) {
      try {
        const buf = await storage.getBuffer(audioFilePath);
        const tmp = path.join(localBase, `.tone_${id}_${path.basename(audioFilePath)}`);
        fs.writeFileSync(tmp, buf);
        audioPathForTones = tmp;
        toneTempToClean = tmp;
      } catch (e) {
        logger.warn(`Could not fetch audio for tone detection (ID ${id}): ${e.message}`);
      }
    }

    // Wait for tone detection to complete before continuing
    await new Promise((resolve) => {
      detectTwoToneQueued(audioPathForTones, id, talkGroupID, (hasTwoTone, detectedTones, detectedType) => {
        handleToneDetectionResult(hasTwoTone, detectedTones, id, talkGroupID, detectedType);
        resolve();
      });
    });
    if (toneTempToClean) fs.unlink(toneTempToClean, () => {});

    logger.info(`Tone detection completed for ID ${id}`);
  }
  return lateLocation; // { lookup } when the location is added after posting, else null
}

// For a call posted while the AI was not answering: once its address lookup
// finishes, add the location (and map link) to the call's Discord message.
async function addLateLocation(entry) {
  const row = await new Promise((resolve) => {
    db.get('SELECT address, lat, lon, category FROM transcriptions WHERE id = ?', [entry.id],
      (err, r) => resolve(err ? null : r));
  });
  if (!row || row.lat == null || row.lon == null) return;
  Object.assign(entry.details, { address: row.address, lat: row.lat, lon: row.lon, category: row.category });
  entry.mapUrl = scannerMapCallUrl(entry.id);
  const state = callMessageStates.get(String(entry.id));
  if (state && state.message) {
    try {
      state.message = await state.message.edit({ embeds: [buildCallEmbed(state)] });
      syncStateCacheFields(state);
      logger.info(`Added the location to the Discord message for call ${entry.id}`);
    } catch (e) {
      logger.warn(`Could not add the location to the Discord message for call ${entry.id}: ${e.message}`);
    }
  }
  scheduleCategoryRefresh(entry);
}

// Keyword alerts shared by normal and merged calls; messageUrl links the alert
// back to the call's Discord message.
async function alertOnKeywords(entry, talkGroupName, systemName, messageUrl) {
  const matched = (entry.details && entry.details.keywords) || [];
  logger.info(`Matched keywords for ID ${entry.id}: ${matched.join(', ') || 'None'}`);
  if (matched.length > 0 && alertChannel) {
    await sendAlertMessage(entry, talkGroupName, systemName, messageUrl);
  }
}

// TrunkRecorder/SDRTrunk flags arrive as booleans, numbers or strings
function isFlagSet(value) {
  return value === true || value === 1 || /^(true|1|yes)$/i.test(String(value ?? '').trim());
}

// Everything a call's Discord block shows (see src/discord/callEmbeds.js)
function buildCallEntry({ id, speakers, details, durationSec, startTime, emergency, encrypted }) {
  const start = parseInt(startTime ?? details.timestamp, 10);
  return {
    id,
    time: Number.isFinite(start) && start > 1e9 ? start : Math.floor(Date.now() / 1000),
    durationSec: parseFloat(durationSec),
    audioUrl: buildAudioUrl(id),
    mapUrl: details.lat != null && details.lon != null ? scannerMapCallUrl(id) : null,
    emergency: isFlagSet(emergency),
    encrypted: isFlagSet(encrypted),
    speakers,
    details,
  };
}

async function handleNewTranscription(
  id,
  transcriptionText,
  talkGroupID,
  systemName,
  talkGroupName,
  source,
  talkerAlias,
  talkGroupGroup,
  audioFilePath,
  totalErrors,
  totalSpikes,
  emergency,
  priority,
  encrypted,
  call_length,
  freq_error,
  signalQuality,
  frequency,
  start_time,
  stop_time,
  tdma_slot,
  phase2_tdma,
  color_code
) {
  logger.info(`Starting handleNewTranscription for ID ${id}`);
  logger.info(`Transcription text length: ${transcriptionText.length} characters`);

  const timeout = setTimeout(() => {
    logger.error(`Timeout occurred in handleNewTranscription for ID ${id}`);
  }, 40000); // Increased timeout from 15 to 40 seconds

  try {
    // Two-tone queueing, address extraction and tone detection
    const lateLocation = await analyzeCall(id, transcriptionText, talkGroupID, talkGroupName, systemName, audioFilePath);

    const details = await gatherCallDetails(id, transcriptionText, talkGroupID);
    const entry = buildCallEntry({
      id,
      speakers: [{
        name: sourceDisplayName(source, talkerAlias),
        text: transcriptionText,
        sq: totalErrors > 0 || totalSpikes > 0 ? `${totalErrors}E/${totalSpikes}S` : null,
      }],
      details,
      durationSec: call_length,
      startTime: start_time,
      emergency,
      encrypted,
    });
    const messageUrl = await postCallMessage(entry, talkGroupID, talkGroupName, systemName);
    scheduleCategoryRefresh(entry);
    if (lateLocation) lateLocation.lookup.then((outcome) => { if (outcome === 'found') return addLateLocation(entry); }).catch(() => {});

    // Keyword alert linking back to the message
    await alertOnKeywords(entry, talkGroupName, systemName, messageUrl);

    if (isTalkGroupLive(talkGroupID)) {
      playAudioForTalkGroup(talkGroupID, id);
    }

    logger.info(`Finished handling transcription for ID ${id}`);
  } catch (error) {
    logger.error(`Error in handleNewTranscription for ID ${id}: ${error.message}`, { stack: error.stack });
  } finally {
    clearTimeout(timeout);
  }
}

// Calls whose address lookup is running or waiting on the AI, so a tone
// follow-up doesn't queue a second lookup for the same call.
const addressLookupsInFlight = new Set();

// Resolves 'found', 'none', 'unavailable' (the AI was paused or not answering:
// nothing is saved, and the catch-up looks the call up again) or 'busy'.
// opts.priority goes to the AI queue ('low' for catching up).
async function extractAndProcessAddress(id, transcriptionText, talkGroupID, systemName, opts = {}) {
  const key = String(id);
  if (addressLookupsInFlight.has(key)) {
    logger.info(`Address extraction for ID ${id} is already in progress`);
    return 'busy';
  }
  addressLookupsInFlight.add(key);
  try {
    return await extractAndProcessAddressNow(id, transcriptionText, talkGroupID, systemName, opts);
  } finally {
    addressLookupsInFlight.delete(key);
  }
}

async function extractAndProcessAddressNow(id, transcriptionText, talkGroupID, systemName, opts = {}) {
  logger.info(`Starting address extraction for ID ${id}`);
  let outcome = 'none';

  try {
    const extractedAddress = await extractAddress(transcriptionText, talkGroupID, systemName, opts);

    if (extractedAddress) {
      logger.info(`Extracted Address for ID ${id}: ${extractedAddress}`);
      const geocodeResult = await geocodeAddress(extractedAddress);
      
      if (geocodeResult) {
        await updateDatabaseWithCoordinates(id, geocodeResult);
        logger.info(`Successfully geocoded address for ID ${id}: ${geocodeResult.formatted_address}`);
        
        // Hyperlink the address that actually appears in the transcript (the
        // LLM-extracted text), with the geocoded coordinates for the map link.
        const linkedTranscriptionText = hyperlinkAddress(
          transcriptionText,
          extractedAddress,
          geocodeResult.lat,
          geocodeResult.lng
        );
        await updateTranscriptionWithLinkedText(id, linkedTranscriptionText);
        outcome = 'found';
      } else {
        logger.info(`Failed to geocode address for ID ${id}: ${extractedAddress}`);
        await updateDatabaseWithNullCoordinates(id);
      }
    } else {
      logger.info(`No address found for ID ${id}. Skipping geocoding.`);
      await updateDatabaseWithNullCoordinates(id);
    }
  } catch (error) {
    if (error.name === 'LlmUnavailableError') {
      logger.warn(`Address extraction for ID ${id} is waiting for the AI (${error.message}); it's looked up again when the AI is back`);
      return 'unavailable';
    }
    logger.error(`Error in address extraction for ID ${id}: ${error.message}`, {
      stack: error.stack,
      transcriptionTextLength: transcriptionText.length,
      transcriptionTextSample: transcriptionText.substring(0, 100)
    });
    await updateDatabaseWithNullCoordinates(id);
  }

  logger.info(`Finished address extraction and processing for ID ${id}`);
  return outcome;
}

// Calls missed while the AI was paused or down are looked up when it's back,
// oldest first and behind live calls (src/ai/catchUp.js). The same rules as a
// live call decide which ones need it; calls picked only by two-tone mode
// can't be told apart afterwards, so they're left out.
function callNeedsAddressLookup(row) {
  const text = String(row.transcription || '');
  return row.lat == null && text.length >= 15
    && (!ADDRESS_PREFILTER_ENABLED || streetMatching.mightContainLocation(text))
    && isMappedTalkGroup(row.talk_group_id, row.system);
}

const aiCatchUp = createCatchUp({
  db: { all: (...a) => db.all(...a), get: (...a) => db.get(...a) },
  logger,
  needsLookup: callNeedsAddressLookup,
  isReady: () => llmQueue.isAvailable(),
  lookup: async (row) => {
    const outcome = await extractAndProcessAddress(row.id, row.transcription, String(row.talk_group_id), row.system, { priority: 'low' });
    if (outcome === 'found') addLocationToPostedCall(row.id);
    return outcome === 'unavailable' ? 'unavailable' : 'done';
  },
});
llmQueue.onResume((info) => aiCatchUp.enqueue(info));

// Add a caught-up location to the call's Discord message, if it's still known
function addLocationToPostedCall(id) {
  const state = callMessageStates.get(String(id));
  const entry = state && state.entries && state.entries.find((e) => String(e.id) === String(id));
  if (entry) addLateLocation(entry).catch(() => {});
}

async function updateDatabaseWithCoordinates(id, geocodeResult) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE transcriptions SET lat = ?, lon = ?, address = ? WHERE id = ?`,
      [geocodeResult.lat, geocodeResult.lng, geocodeResult.formatted_address, id],
      (err) => {
        if (err) {
          logger.error('Error updating transcription with coordinates:', err);
          reject(err);
        } else {
          logger.info(`Updated transcription ID ${id} with coordinates`);
          resolve();
        }
      }
    );
  });
}

async function updateDatabaseWithNullCoordinates(id) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE transcriptions SET address = NULL, lat = NULL, lon = NULL WHERE id = ?`,
      [id],
      (err) => {
        if (err) {
          logger.error('Error updating transcription to null coordinates:', err);
          reject(err);
        } else {
          logger.info(`Updated transcription ID ${id} with null coordinates`);
          resolve();
        }
      }
    );
  });
}

async function updateTranscriptionWithLinkedText(id, linkedText) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE transcriptions SET transcription = ? WHERE id = ?`,
      [linkedText, id],
      (err) => {
        if (err) {
          logger.error('Error updating transcription with linked text:', err);
          reject(err);
        } else {
          logger.info(`Updated transcription ID ${id} with linked text`);
          resolve();
        }
      }
    );
  });
}

function checkForKeywords(talkGroupID, transcriptionText, callback) {
  db.all(
    `SELECT keyword FROM global_keywords WHERE talk_group_id = ? OR talk_group_id IS NULL`,
    [talkGroupID],
    (err, rows) => {
      if (err) {
        logger.error('Error fetching global keywords', err.message);
        callback([]);
      } else {
        const matchedKeywords = rows
          .map((row) => row.keyword)
          .filter((keyword) =>
            transcriptionText.toLowerCase().includes(keyword.toLowerCase())
          );
        callback(matchedKeywords);
      }
    }
  );
}

// Keyword alert: the call's block (same as in its channel) plus a link to it
function sendAlertMessage(entry, talkGroupName, systemName, messageUrl) {
  const keywords = (entry.details && entry.details.keywords) || [];
  let description = callEmbeds.renderCall(entry);
  if (messageUrl) description += `\n\n[↗️ Jump to message](${messageUrl})`;
  const embed = new EmbedBuilder()
    .setTitle(`🔑 ${keywords.join(', ')} · ${talkGroupName}`.slice(0, 256))
    .setDescription(description.slice(0, callEmbeds.MAX_DESCRIPTION))
    .setColor(entry.emergency ? callEmbeds.COLORS.emergency : 0xff0000)
    .setFooter({ text: systemName || 'Unknown system' })
    .setTimestamp();
  return alertChannel
    .send({ embeds: [embed] })
    .then(() => logger.info(`Alert message sent for call ${entry.id}`))
    .catch((err) => logger.error('Error sending alert message:', err));
}

// --- Call messages ------------------------------------------------------------
// Each talkgroup channel gets a rolling message: calls within MESSAGE_COOLDOWN
// of the previous one are appended to the same embed. The message keeps its
// calls as structured entries (see src/discord/callEmbeds.js) and is re-rendered
// on every change, so details that arrive later (the map category) can be
// filled in by editing it.

const callMessageStates = new Map(); // transcription ID -> message state, for later edits
const callMessageUrls = new Map(); // transcription ID -> { url, at }, linked from the dispatch summary
const CATEGORY_REFRESH_DELAYS_MS = [8000, 20000, 45000]; // the web server categorizes mapped calls a few seconds after geocoding

function sourceDisplayName(source, talkerAlias) {
  if (talkerAlias && talkerAlias.trim() !== '') return talkerAlias.trim();
  if (!source || source === 'Unknown') return 'Unknown radio';
  if (source.startsWith('TR-')) return `TrunkRec-${source.substring(3)}`;
  if (/^\d+$/.test(source)) return `Unit-${source}`;
  return `ID-${source}`;
}

function scannerMapCallUrl(transcriptionId) {
  return `${getPublicBaseUrl()}/?call=${encodeURIComponent(transcriptionId)}`;
}

// Address, category, tones and keywords known for a call right now.
async function gatherCallDetails(id, transcriptionText, talkGroupID) {
  const row = await new Promise((resolve) => {
    db.get('SELECT address, lat, lon, category, timestamp FROM transcriptions WHERE id = ?', [id],
      (err, r) => resolve(err ? null : r));
  });
  const keywords = await new Promise((resolve) => checkForKeywords(talkGroupID, transcriptionText, resolve));
  const tone = callTones.get(String(id));
  return {
    address: row ? row.address : null,
    lat: row ? row.lat : null,
    lon: row ? row.lon : null,
    category: row ? row.category : null,
    timestamp: row ? row.timestamp : null, // call start (unix seconds)
    tones: tone ? tone.descriptions : [],
    keywords: keywords || [],
  };
}

// The talkgroup's text channel (and its display name), creating it if needed.
function resolveCallChannel(talkGroupID, talkGroupName, systemName) {
  return new Promise((resolve) => {
    // Scoped to the originating system (falls back to legacy ''-system rows for single-system)
    const sysKey = normalizeSystemLabel(systemName);
    db.get(
      `SELECT alpha_tag, county FROM talk_groups
       WHERE id = ? AND (system = ? OR system = '')
       ORDER BY CASE WHEN system = ? THEN 0 ELSE 1 END LIMIT 1`,
      [talkGroupID, sysKey, sysKey],
      (err, row) => {
        if (err) {
          logger.error('Error fetching talkgroup info:', err);
          return resolve(null);
        }
        if (!row) {
          // Not in the imported CSV(s): post under "Uncategorized" with the scanner's name
          logger.warn(`Talkgroup ${talkGroupID} (system: ${sysKey || 'n/a'}) not in DB — posting under "Uncategorized" using scanner-provided name. Import its CSV for proper mapping.`);
          row = { alpha_tag: talkGroupName || `TG ${talkGroupID}`, county: null };
        }
        const fullTalkGroupName = row.alpha_tag || talkGroupName || `TG ${talkGroupID}`;
        getOrCreateCategory(row.county || 'Uncategorized', (category) => {
          if (!category) {
            logger.error('Failed to get or create category.');
            return resolve(null);
          }
          getOrCreateChannel(getChannelName(fullTalkGroupName), category.id, (channel) => {
            if (!channel) {
              logger.error('Failed to get or create channel.');
              return resolve(null);
            }
            resolve({ channel, fullTalkGroupName });
          });
        });
      }
    );
  });
}

function callMessageButtons(talkGroupID) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`listen_live_${talkGroupID}`).setLabel('🎧 Listen Live').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ask_ai_${talkGroupID}`).setLabel('🤖 Ask AI').setStyle(ButtonStyle.Secondary),
  );
}

function buildCallEmbed(state) {
  const { description, color, footer } = callEmbeds.renderMessage(state.entries, { systemName: state.systemName });
  return new EmbedBuilder()
    .setTitle(state.title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: footer })
    .setTimestamp();
}

// Fields getMessageUrlForTranscription() reads from the cache
function syncStateCacheFields(state) {
  state.transcriptions = state.entries.map(callEmbeds.renderCall).join('\n\n');
  state.transcriptionIds = state.entries.map((e) => e.id);
}

/**
 * Post a call to its talkgroup channel, appending to the recent message when it
 * fits. Resolves with the message URL (or undefined on failure).
 */
async function postCallMessage(entry, talkGroupID, talkGroupName, systemName) {
  const target = await resolveCallChannel(talkGroupID, talkGroupName, systemName);
  if (!target) return undefined;
  const { channel, fullTalkGroupName } = target;

  const cached = messageCache.get(channel.id);
  const now = Date.now();
  if (cached && cached.entries && now - cached.timestamp < MESSAGE_COOLDOWN) {
    const candidate = [...cached.entries, entry];
    const { description } = callEmbeds.renderMessage(candidate, { systemName: cached.systemName });
    if (description.length <= callEmbeds.MAX_DESCRIPTION) {
      cached.entries = candidate;
      try {
        const edited = await cached.message.edit({ embeds: [buildCallEmbed(cached)] });
        cached.message = edited;
        cached.timestamp = now;
        syncStateCacheFields(cached);
        callMessageStates.set(String(entry.id), cached);
        callMessageUrls.set(String(entry.id), { url: edited.url, at: now });
        logger.info(`Updated message with transcription ID ${entry.id}, URL: ${edited.url}`);
        return edited.url;
      } catch (err) {
        logger.error(`Error editing message for transcription ID ${entry.id}: ${err.message}; sending a new one`);
        cached.entries = cached.entries.filter((e) => e !== entry);
      }
    } else {
      logger.info(`Message for ${channel.name} is full (${description.length} > ${callEmbeds.MAX_DESCRIPTION}); starting a new one`);
    }
  }

  const state = {
    title: fullTalkGroupName,
    systemName,
    entries: [entry],
    message: null,
    timestamp: now,
    url: null,
  };
  try {
    const msg = await channel.send({ embeds: [buildCallEmbed(state)], components: [callMessageButtons(talkGroupID)] });
    state.message = msg;
    state.url = msg.url;
    syncStateCacheFields(state);
    messageCache.set(channel.id, state);
    callMessageStates.set(String(entry.id), state);
    callMessageUrls.set(String(entry.id), { url: msg.url, at: now });
    logger.info(`Created new message with transcription ID ${entry.id}, URL: ${msg.url}`);
    return msg.url;
  } catch (err) {
    logger.error('Error sending new transcription message:', err);
    return undefined;
  }
}

// Mapped calls get a category from the web server shortly after geocoding;
// check back a few times and add it to the message.
function scheduleCategoryRefresh(entry) {
  const d = entry.details || {};
  if (d.category || d.lat == null || d.lon == null) return;
  let attempt = 0;
  const check = () => {
    db.get('SELECT category FROM transcriptions WHERE id = ?', [entry.id], async (err, row) => {
      const state = callMessageStates.get(String(entry.id));
      if (!state || !state.message) return;
      if (!err && row && row.category) {
        entry.details.category = row.category;
        try {
          state.message = await state.message.edit({ embeds: [buildCallEmbed(state)] });
          syncStateCacheFields(state);
          logger.debug(`Added category "${row.category}" to the Discord message for call ${entry.id}`);
        } catch (e) {
          logger.warn(`Could not add category to the Discord message for call ${entry.id}: ${e.message}`);
        }
        return;
      }
      attempt++;
      if (attempt < CATEGORY_REFRESH_DELAYS_MS.length) {
        setTimeout(check, CATEGORY_REFRESH_DELAYS_MS[attempt] - CATEGORY_REFRESH_DELAYS_MS[attempt - 1]);
      }
    });
  };
  setTimeout(check, CATEGORY_REFRESH_DELAYS_MS[0]);
}

// Add a cleanup function to prevent memory leaks
function cleanupMessageCache() {
  const currentTime = Date.now();
  for (const [key, value] of messageCache.entries()) {
    if (currentTime - value.timestamp > MESSAGE_COOLDOWN * 2) {
      messageCache.delete(key);
    }
  }
  // Messages stop being edited (category follow-ups) after a few minutes
  for (const [id, state] of callMessageStates.entries()) {
    if (currentTime - state.timestamp > 5 * 60 * 1000) callMessageStates.delete(id);
  }
  // Kept for the summary's lookback window
  const summaryKeepMs = LOOKBACK_PERIOD + 30 * 60 * 1000;
  for (const [id, tone] of callTones.entries()) {
    if (currentTime - tone.at > summaryKeepMs) callTones.delete(id);
  }
  for (const [id, link] of callMessageUrls.entries()) {
    if (currentTime - link.at > summaryKeepMs) callMessageUrls.delete(id);
  }
}

// Function to create or get the summary channel
async function getOrCreateSummaryChannel(guild) {
  let channel = guild.channels.cache.find(
    (channel) => channel.name === 'dispatch-summary' && channel.type === ChannelType.GuildText
  );

  if (!channel) {
    try {
      channel = await guild.channels.create({
        name: 'dispatch-summary',
        type: ChannelType.GuildText,
        topic: 'AI-generated summary of recent interesting transmissions',
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: ['ViewChannel', 'ReadMessageHistory'],
            deny: ['SendMessages'],
          },
        ],
      });
      logger.info('Created dispatch-summary channel.');
    } catch (err) {
      logger.error('Error creating summary channel:', err);
      return null;
    }
  }

  return channel;
}

// Function to fetch recent transcriptions from the database
function getRecentTranscriptions() {
  return new Promise((resolve, reject) => {
    const thirtyMinutesAgoMs = Date.now() - LOOKBACK_PERIOD;
    // Convert to Unix timestamp (seconds) for the query
    const thirtyMinutesAgoUnix = Math.floor(thirtyMinutesAgoMs / 1000);
    
    logger.info(`Fetching transcriptions since Unix timestamp ${thirtyMinutesAgoUnix} (lookback: ${LOOKBACK_HOURS} hours)`);
    
    // Add some debug output
    logger.info(`LOOKBACK_PERIOD in milliseconds: ${LOOKBACK_PERIOD}`);

    // Optionally restrict the AI summary to specific talkgroups. We strip any
    // "system:" prefix here and match on the bare id (summary is descriptive, so
    // cross-system id overlap is acceptable and keeps the query simple).
    const summaryParams = [thirtyMinutesAgoUnix];
    let summaryFilterSql = '';
    if (IS_SUMMARY_TALK_GROUPS_ENABLED && SUMMARY_TALK_GROUPS.length) {
      const ids = SUMMARY_TALK_GROUPS.map((e) => (e.includes(':') ? e.split(':').pop() : e));
      summaryFilterSql = ` AND t.talk_group_id IN (${ids.map(() => '?').join(',')})`;
      summaryParams.push(...ids);
    }

    db.all(
      `SELECT t.id, t.talk_group_id, t.timestamp, t.transcription, t.address, t.lat, t.lon, t.category,
              COALESCE(
                (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = COALESCE(t.system,'') LIMIT 1),
                (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = '' LIMIT 1),
                (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id LIMIT 1)
              ) AS talk_group_name,
              COALESCE(
                (SELECT description FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = COALESCE(t.system,'') LIMIT 1),
                (SELECT description FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = '' LIMIT 1),
                (SELECT description FROM talk_groups tg WHERE tg.id = t.talk_group_id LIMIT 1)
              ) AS talk_group_description,
              COALESCE(
                (SELECT county FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = COALESCE(t.system,'') LIMIT 1),
                (SELECT county FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = '' LIMIT 1),
                (SELECT county FROM talk_groups tg WHERE tg.id = t.talk_group_id LIMIT 1)
              ) AS county
       FROM transcriptions t
       WHERE t.timestamp > ?
       AND t.transcription != ''${summaryFilterSql}
       ORDER BY t.timestamp DESC`,
      // Unix timestamp + optional summary talkgroup filter params
      summaryParams,
      (err, rows) => {
        if (err) {
          logger.error('Error fetching recent transcriptions:', err);
          reject(err);
        } else {
          logger.info(`Retrieved ${rows.length} transcriptions spanning from ${thirtyMinutesAgoUnix} to now`);
          // Add some sample data to debug
          if (rows.length > 0) {
            logger.info(`Earliest transcription: ${rows[rows.length-1].timestamp}`);
            logger.info(`Latest transcription: ${rows[0].timestamp}`);
            logger.info(`Sample timestamp format in DB: ${rows[0].timestamp}`);
          } else {
            // Debug by querying without time filter to see what's in the database
            db.get('SELECT COUNT(*) AS count, MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM transcriptions WHERE transcription != ""', [], (err, info) => {
              if (!err && info) {
                logger.info(`Database has ${info.count} total transcriptions from ${info.oldest} to ${info.newest}`);
              }
            });
          }
          // Convert timestamp strings to Unix timestamps (seconds)
           const processedRows = rows.map(row => {
             let numericTimestampSeconds;
             if (typeof row.timestamp === 'string') {
                 const tsDate = new Date(row.timestamp);
                 if (!isNaN(tsDate.getTime())) {
                     numericTimestampSeconds = Math.floor(tsDate.getTime() / 1000);
                 } else {
                     logger.warn(`[getRecentTranscriptions] Failed to parse timestamp string: '${row.timestamp}' for row ID: ${row.id}. Setting to 0.`);
                     numericTimestampSeconds = 0;
                 }
             } else if (typeof row.timestamp === 'number') {
                 // If the number is very large (e.g. > 100000000000, which is roughly year 5138 in seconds), assume it's milliseconds.
                 // A more common threshold might be around 30_000_000_000 (year 2920 in seconds) if only expecting up to ms.
                 // For this context, timestamps from DB are expected to be seconds primarily.
                 // If a number is much larger than typical seconds timestamps (e.g. > 3 * 10^9, roughly year 2065), it might be ms.
                 if (row.timestamp > 4000000000) { // Heuristic: if it's a large number (e.g. > year 2096 in secs), likely ms
                      numericTimestampSeconds = Math.floor(row.timestamp / 1000);
                 } else { // Assumed to be seconds
                      numericTimestampSeconds = row.timestamp;
                 }
             } else {
                 logger.warn(`[getRecentTranscriptions] Unexpected timestamp type for row ID ${row.id}: ${typeof row.timestamp} value: ${row.timestamp}. Setting to 0.`);
                 numericTimestampSeconds = 0;
             }
             return { ...row, timestamp: numericTimestampSeconds };
           });
           resolve(processedRows);
        }
      }
    );
  });
}

function getMessageUrlForTranscription(transcriptionId, suppressWarnings = false) {
  return new Promise((resolve) => {
    // First try to find the URL directly from the database
    db.get(
      `SELECT t.talk_group_id,
              COALESCE(
                (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = COALESCE(t.system,'') LIMIT 1),
                (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id AND tg.system = '' LIMIT 1),
                (SELECT alpha_tag FROM talk_groups tg WHERE tg.id = t.talk_group_id LIMIT 1)
              ) AS alpha_tag
       FROM transcriptions t
       WHERE t.id = ?`,
      [transcriptionId],
      async (err, row) => {
        if (err || !row) {
          if (!suppressWarnings) {
            logger.error(`Error or no results fetching talk group for transcription ${transcriptionId}:`, err);
          }
          resolve(null);
          return;
        }
        
        // Got the talk group, now try to find a message in that talk group's channel
        const talkGroupID = row.talk_group_id;
        const talkGroupName = row.alpha_tag || `TG ${talkGroupID}`;
        const channelName = getChannelName(talkGroupName);
        
        // Try to find the channel
        const guild = client.guilds.cache.first();
        const channel = guild?.channels.cache.find(
          ch => ch.name === channelName && ch.type === ChannelType.GuildText
        );
        
        if (!channel) {
          if (!suppressWarnings) {
            logger.warn(`Couldn't find channel for talk group ${talkGroupName}`);
          }
          resolve(null);
          return;
        }
        
        // Look through cached messages for this channel
        for (const [channelId, cachedData] of messageCache.entries()) {
          if (channelId === channel.id && 
              cachedData.transcriptions && 
              cachedData.url) {
            // Check if this message contains our transcription ID
            if (cachedData.transcriptionIds && cachedData.transcriptionIds.includes(transcriptionId)) {
              logger.info(`Found message URL for transcription ${transcriptionId} in channel cache`);
              resolve(cachedData.url);
              return;
            }
          }
        }
        
        // If not found in cache, try fetching recent messages from the channel
        try {
          const messages = await channel.messages.fetch({ limit: 10 });
          for (const [_, message] of messages) {
            if (message.author.id === client.user.id && 
                message.embeds.length > 0) {
              // Use the transcriptionIds array we store in the cache
              const cachedData = messageCache.get(channel.id);
              if (cachedData && cachedData.transcriptionIds && cachedData.transcriptionIds.includes(transcriptionId)) {
                logger.info(`Found message URL for transcription ${transcriptionId} in channel history`);
                resolve(message.url);
                return;
              }
            }
          }
        } catch (error) {
          if (!suppressWarnings) {
            logger.error(`Error fetching messages for transcription ${transcriptionId}:`, error);
          }
        }
        
        // If we still haven't found it, return null
        if (!suppressWarnings) {
          logger.warn(`Couldn't find message URL for transcription ${transcriptionId}`);
        }
        resolve(null);
      }
    );
  });
}

// Function to send data to Ollama and get summary
// Dispatch summary in two passes: score every call cheaply (src/summary/triage.js),
// then have the LLM group and rate the top candidates as incidents
// (src/summary/incidents.js). Routine traffic never reaches the summary.
let SUMMARY_MAX_INCIDENTS, SUMMARY_MAX_CANDIDATES, SUMMARY_MIN_SCORE, SUMMARY_AI_TIMEOUT_MS;
let SUMMARY_EXTRA_PRIORITY, SUMMARY_EXTRA_BENIGN;
function loadSummarySettings() {
  SUMMARY_MAX_INCIDENTS = Math.max(1, parseInt(process.env.SUMMARY_MAX_INCIDENTS, 10) || 6);
  SUMMARY_MAX_CANDIDATES = process.env.SUMMARY_MAX_CANDIDATES; // blank: scales with OLLAMA_NUM_CTX
  SUMMARY_MIN_SCORE = Number.isFinite(parseFloat(process.env.SUMMARY_MIN_SCORE)) ? parseFloat(process.env.SUMMARY_MIN_SCORE) : 2.5;
  SUMMARY_AI_TIMEOUT_MS = (parseFloat(process.env.SUMMARY_AI_TIMEOUT_SEC) || 180) * 1000;
  SUMMARY_EXTRA_PRIORITY = summaryTriage.compileExtra(process.env.SUMMARY_EXTRA_PRIORITY_TERMS);
  SUMMARY_EXTRA_BENIGN = summaryTriage.compileExtra(process.env.SUMMARY_EXTRA_BENIGN_TERMS);
}
loadSummarySettings();

function summaryTimeLabel(ts) {
  return new Date(ts * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TIMEZONE });
}

// One JSON completion from the configured provider. Ollama uses the same model
// and num_ctx (OLLAMA_NUM_CTX) as Scanner Map's other requests, so the loaded model is reused
// rather than reloaded.
async function summaryAiCompletion(prompt) {
  // Lowest priority in the shared AI queue: live address extraction goes first.
  const queueOpts = { label: 'Summary', timeoutMs: SUMMARY_AI_TIMEOUT_MS, priority: 'low' };
  try {
    if (AI_PROVIDER.toLowerCase() === 'openai') {
      if (!OPENAI_API_KEY) throw new Error('OpenAI API key is not configured.');
      const response = await llmQueue.request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          response_format: { type: 'json_object' },
        }),
      }, queueOpts);
      if (!response.ok) throw new Error(`OpenAI API error ${response.status}: ${await response.text()}`);
      const result = await response.json();
      return result.choices?.[0]?.message?.content || '';
    }
    const response = await llmQueue.request(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: 'json',
        // num_ctx must match Scanner Map's other Ollama requests or the model reloads.
        // Ollama serves one request at a time, so cap the reply to keep address extraction from waiting long.
        options: { num_ctx: llmQueue.ollamaNumCtx(), temperature: 0.2, num_predict: 900 },
      }),
    }, queueOpts);
    if (!response.ok) throw new Error(`Ollama API error ${response.status}`);
    return (await response.json()).response || '';
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`AI request timed out after ${SUMMARY_AI_TIMEOUT_MS / 1000}s`);
    throw error;
  }
}

async function generateSummary(transcriptions) {
  const timeframe = `${LOOKBACK_HOURS} ${LOOKBACK_HOURS === 1 ? 'hour' : 'hours'}`;
  const stats = { total: transcriptions.length, candidates: 0 };
  if (transcriptions.length === 0) {
    return { summary: `No transmissions in the past ${timeframe}.`, incidents: [], highlights: [], stats, source: 'none' };
  }

  // Signals for scoring: matched keywords and detected tones
  const keywordRows = await new Promise((resolve) => {
    db.all('SELECT keyword, talk_group_id FROM global_keywords', [], (err, rows) => resolve(err ? [] : rows || []));
  });
  const calls = transcriptions.map((t) => {
    const lower = String(t.transcription || '').toLowerCase();
    const tone = callTones.get(String(t.id));
    return {
      ...t,
      talk_group: t.talk_group_name || `TG ${t.talk_group_id}`,
      keywords: keywordRows
        .filter((k) => (k.talk_group_id == null || String(k.talk_group_id) === String(t.talk_group_id))
          && lower.includes(String(k.keyword).toLowerCase()))
        .map((k) => k.keyword),
      tones: tone ? tone.descriptions : [],
    };
  });

  const { candidates } = summaryTriage.selectCandidates(calls, {
    max: summaryIncidents.maxCandidates(SUMMARY_MAX_CANDIDATES),
    minScore: SUMMARY_MIN_SCORE,
    extraPriority: SUMMARY_EXTRA_PRIORITY,
    extraBenign: SUMMARY_EXTRA_BENIGN,
  });
  stats.candidates = candidates.length;
  logger.info(`Summary: ${calls.length} calls, ${candidates.length} candidates after scoring` +
    (candidates.length ? ` (top: ${candidates.slice(0, 3).map((c) => `${c.id}=${c.score}`).join(', ')})` : ''));
  if (candidates.length === 0) {
    return { summary: `Routine traffic only in the past ${timeframe} (${calls.length} transmissions).`, incidents: [], highlights: [], stats, source: 'none' };
  }

  const times = calls.map((c) => c.timestamp);
  const prompt = summaryIncidents.buildPrompt(candidates, {
    lookbackHours: LOOKBACK_HOURS,
    startLabel: summaryTimeLabel(Math.min(...times)),
    endLabel: summaryTimeLabel(Math.max(...times)),
    totalCalls: calls.length,
    maxIncidents: SUMMARY_MAX_INCIDENTS,
    timeLabel: summaryTimeLabel,
    onTrim: (kept, total) => logger.info(`Summary: sending the top ${kept} of ${total} candidates to fit the AI context`),
  });

  try {
    const started = Date.now();
    logger.info(`Summary: asking ${AI_PROVIDER.toLowerCase() === 'openai' ? OPENAI_MODEL : OLLAMA_MODEL} to triage ${candidates.length} candidates`);
    const reply = await summaryAiCompletion(prompt);
    const { summary, incidents } = summaryIncidents.parseIncidents(reply, candidates, SUMMARY_MAX_INCIDENTS);
    logger.info(`Summary: ${incidents.length} incident(s) in ${((Date.now() - started) / 1000).toFixed(1)}s: ` +
      (incidents.map((i) => `${i.severity} ${i.title}`).join('; ') || 'none'));
    return {
      summary: summary || (incidents.length ? `${incidents.length} notable incident(s) in the past ${timeframe}.` : `Routine traffic only in the past ${timeframe}.`),
      incidents,
      highlights: summaryIncidents.toHighlights(incidents),
      stats,
      source: 'ai',
    };
  } catch (error) {
    logger.error(`Summary: AI triage failed (${error.message}); showing the highest-scoring calls instead`);
    const incidents = summaryIncidents.fallbackIncidents(candidates, SUMMARY_MAX_INCIDENTS);
    return {
      summary: `AI summary unavailable (${error.message}). Showing the highest-priority calls by keyword scoring.`,
      incidents,
      highlights: summaryIncidents.toHighlights(incidents),
      stats,
      source: 'fallback',
    };
  }
}

// Add this function to save the summary to a JSON file
function saveSummaryToJson(summary, highlights) {
  try {
    // Make sure the directory exists
    const publicDir = path.join(__dirname, 'public');
    if (!fs.existsSync(publicDir)) {
      fs.mkdirSync(publicDir, { recursive: true });
    }
    
    // Format highlights for the website (omitting audio links)
    const formattedHighlights = highlights.map(highlight => {
      let timestampDisplay;
      // Ensure highlight.timestamp is a number and not NaN
      if (typeof highlight.timestamp === 'number' && !isNaN(highlight.timestamp)) {
        try {
          const originalTimestamp = new Date(highlight.timestamp * 1000); // Multiply by 1000
          timestampDisplay = originalTimestamp.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });

          if (timestampDisplay === 'Invalid Date') {
            logger.warn(`[saveSummaryToJson] Formatted time is \'Invalid Date\' for highlight ID ${highlight.id} (timestamp value: ${highlight.timestamp}). Original Date obj was: ${originalTimestamp.toISOString()}`);
            timestampDisplay = 'Time N/A';
          }
        } catch (err) {
          logger.error(`[saveSummaryToJson] Error formatting timestamp for highlight ID ${highlight.id} (timestamp value: ${highlight.timestamp}): ${err.message}`);
          timestampDisplay = 'Time N/A';
        }
      } else {
        logger.warn(`[saveSummaryToJson] highlight.timestamp (\'${highlight.timestamp}\') is invalid or missing for highlight ID ${highlight.id}. Full highlight: ${JSON.stringify(highlight)}`);
        timestampDisplay = 'Time N/A';
      }
      
      return {
        id: highlight.id,
        talk_group: highlight.talk_group,
        importance: highlight.importance,
        description: highlight.description,
        time: timestampDisplay // Use the processed timestampDisplay
      };
    });
    
    // Create the JSON object with timestamp
    const jsonData = {
      summary: summary,
      highlights: formattedHighlights,
      updated: new Date().toISOString(),
      time_range: `Past ${LOOKBACK_HOURS} ${LOOKBACK_HOURS === 1 ? 'Hour' : 'Hours'}`
    };
    
    // Write to file
    const jsonPath = path.join(publicDir, 'summary.json');
    fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
    
    logger.info(`Saved summary to ${jsonPath}`);
  } catch (error) {
    logger.error(`Error saving summary to JSON file: ${error.message}`);
  }
}

// Function to create or update the summary embed
async function updateSummaryEmbed() {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) {
      logger.error('No guild found for the bot.');
      return;
    }
    
    // Get or create the summary channel
    if (!summaryChannel) {
      summaryChannel = await getOrCreateSummaryChannel(guild);
      if (!summaryChannel) {
        logger.error('Failed to get or create summary channel.');
        return;
      }
    }
    
    // Get recent transcriptions
    const transcriptions = await getRecentTranscriptions();
    logger.info(`Found ${transcriptions.length} recent transcriptions for summary spanning past ${LOOKBACK_HOURS} hour(s).`);
    
    // Add time span information
    let timeSpanInfo = "";
    if (transcriptions.length > 0) {
      const sortedTranscriptions = [...transcriptions].sort((a, b) => new Date(a.timestamp * 1000) - new Date(b.timestamp * 1000)); // Multiply by 1000
      const earliest = new Date(sortedTranscriptions[0].timestamp * 1000); // Multiply by 1000
      const latest = new Date(sortedTranscriptions[sortedTranscriptions.length - 1].timestamp * 1000); // Multiply by 1000
      
      const formatTime = (date) => date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true,
        timeZone: TIMEZONE
      });
      
      timeSpanInfo = `(${formatTime(earliest)} to ${formatTime(latest)})`;
      logger.info(`Summary time span: ${timeSpanInfo}`);
    }
    
    // Generate summary
    let summary;
    try {
      summary = await generateSummary(transcriptions);
    } catch (summaryError) {
      logger.error(`Error in summary generation: ${summaryError.message}`);
      summary = {
        summary: `Error generating summary: ${summaryError.message}. Please try again later.`,
        incidents: [], highlights: [], stats: { total: transcriptions.length, candidates: 0 }, source: 'error',
      };
    }

    // Save the summary to JSON file for the website
    saveSummaryToJson(summary.summary, summary.highlights);

    const incidents = summary.incidents || [];
    const counts = summaryIncidents.SEVERITIES
      .map((sev) => [sev, incidents.filter((i) => i.severity === sev).length])
      .filter(([, n]) => n > 0)
      .map(([sev, n]) => `${summaryIncidents.SEVERITY_ICON[sev]} ${n} ${sev.toLowerCase()}`);
    const statsLine = `${counts.length ? counts.join(' · ') + ' · ' : ''}from ${summary.stats ? summary.stats.total : transcriptions.length} transmissions`;
    const worst = incidents.length ? incidents[0].severity : 'NONE';

    const embed = new EmbedBuilder()
      .setTitle(`📻 Dispatch Summary - Past ${LOOKBACK_HOURS} ${LOOKBACK_HOURS === 1 ? 'Hour' : 'Hours'} ${timeSpanInfo}`.slice(0, 256))
      .setDescription(`${summary.summary}\n\n${statsLine}`.slice(0, 1500))
      .setTimestamp()
      .setColor(summaryIncidents.SEVERITY_COLOR[worst])
      .setFooter({ text: summary.source === 'fallback'
        ? 'Updates every 10 minutes • AI unavailable, ranked by keyword scoring'
        : 'Updates every 10 minutes • Ranked by AI from pre-scored calls' });

    // One field per incident, most severe first. Embeds are capped at 6000 characters overall.
    let budget = 6000 - 300 - (embed.data.title || '').length - (embed.data.description || '').length;
    for (const inc of incidents) {
      const lead = inc.calls[0];
      const name = `${summaryIncidents.SEVERITY_ICON[inc.severity]} ${inc.title}${inc.location ? ` — ${inc.location}` : ''}`.slice(0, 256);
      const links = [`<t:${Math.floor(lead.timestamp)}:t>`, lead.talk_group || `TG ${lead.talk_group_id}`, `[▶️ Audio](${buildAudioUrl(lead.id)})`];
      const messageUrl = callMessageUrls.get(String(lead.id));
      if (messageUrl) links.push(`[💬 Message](${messageUrl.url})`);
      if (lead.lat != null && lead.lon != null) links.push(`[🗺️ Map](${scannerMapCallUrl(lead.id)})`);
      if (inc.calls.length > 1) links.push(`+${inc.calls.length - 1} related call${inc.calls.length === 2 ? '' : 's'}`);
      const value = `${inc.description}\n${links.join(' · ')}`.slice(0, 1024);
      if (name.length + value.length > budget) break;
      budget -= name.length + value.length;
      embed.addFields({ name, value, inline: false });
    }
    if (incidents.length === 0) {
      embed.addFields({
        name: '✅ Nothing notable',
        value: `No incidents rated medium or higher in the past ${LOOKBACK_HOURS === 1 ? 'hour' : `${LOOKBACK_HOURS} hours`}.`,
        inline: false,
      });
    }

    // Create refresh button
    const refreshButton = new ButtonBuilder()
      .setCustomId('refresh_summary')
      .setLabel('🔄 Refresh Now')
      .setStyle(ButtonStyle.Secondary);
    
    const row = new ActionRowBuilder().addComponents(refreshButton);
    
    // Update or send the message
    if (summaryMessage) {
      try {
        await summaryMessage.edit({ embeds: [embed], components: [row] });
        logger.info('Updated summary embed message.');
      } catch (err) {
        logger.error('Error updating summary message, will create new one:', err);
        summaryMessage = await summaryChannel.send({ embeds: [embed], components: [row] });
      }
    } else {
      // Find the most recent message in the channel
      const messages = await summaryChannel.messages.fetch({ limit: 1 });
      if (messages.size > 0 && messages.first().author.id === client.user.id) {
        summaryMessage = messages.first();
        await summaryMessage.edit({ embeds: [embed], components: [row] });
        logger.info('Updated existing summary message found in channel.');
      } else {
        // Create a new message
        summaryMessage = await summaryChannel.send({ embeds: [embed], components: [row] });
        logger.info('Created new summary embed message.');
      }
    }
    
    lastSummaryUpdate = Date.now();
    
  } catch (error) {
    logger.error('Error updating summary embed:', error);
  }
}
// Scheduler to update summary
function startSummaryScheduler() {
  // Run initial summary
  updateSummaryEmbed();
  
  // Set up the interval
  setInterval(async () => {
    const timeSinceLastUpdate = Date.now() - lastSummaryUpdate;
    if (timeSinceLastUpdate >= SUMMARY_INTERVAL) {
      logger.info('Running scheduled summary update...');
      await updateSummaryEmbed();
    }
  }, 60000); // Check every minute
}

// Add this to your existing interval cleanups
setInterval(cleanupMessageCache, 3600000); // Clean up every hour

function getChannelName(talkGroupName) {
  // Use the full Talk Group Name as the channel name, sanitized to match what
  // Discord actually stores. Critically, trim trailing/leading hyphens AFTER the
  // 32-char cut: Discord strips trailing hyphens on create, so if we keep one we
  // never find our own channel again and keep creating duplicates.
  return String(talkGroupName || '')
    .toLowerCase()
    .replace(/\s+/g, '-')          // spaces -> hyphens
    .replace(/[^a-z0-9-]/g, '')    // keep only a-z, 0-9, hyphen
    .replace(/-+/g, '-')           // collapse repeated hyphens
    .substring(0, 32)              // Discord 32-char channel name limit
    .replace(/^-+|-+$/g, '')       // strip leading/trailing hyphens (Discord does this)
    || 'unknown';
}

const categoryCache = new Map();
const categoryLocks = new Map(); // name -> Promise<category> (prevents duplicate categories under concurrency)

function getOrCreateCategory(categoryName, callback) {
  if (categoryCache.has(categoryName)) {
    return callback(categoryCache.get(categoryName));
  }
  // If another call is already finding/creating this category, await it.
  if (categoryLocks.has(categoryName)) {
    categoryLocks.get(categoryName).then((c) => callback(c)).catch(() => callback(null));
    return;
  }

  const guild = client.guilds.cache.first();
  if (!guild) {
    logger.error('No guild found for the bot.');
    return callback(null);
  }

  const p = (async () => {
    if (categoryCache.has(categoryName)) return categoryCache.get(categoryName);
    let category = guild.channels.cache.find(
      (channel) => channel.name === categoryName && channel.type === ChannelType.GuildCategory
    );
    if (!category) {
      category = await guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });
    }
    categoryCache.set(categoryName, category);
    return category;
  })();

  categoryLocks.set(categoryName, p);
  p.then((c) => callback(c))
    .catch((err) => { logger.error('Error creating category:', err); callback(null); })
    .finally(() => categoryLocks.delete(categoryName));
}

const channelCache = new Map();
const channelLocks = new Map(); // cacheKey -> Promise<channel> (prevents duplicate text channels under concurrency)

function getOrCreateChannel(channelName, categoryId, callback) {
  const cacheKey = `${categoryId}-${channelName}`;
  if (channelCache.has(cacheKey)) {
    return callback(channelCache.get(cacheKey));
  }
  // Serialize concurrent requests for the same channel. Without this, several
  // calls for the same talkgroup arriving within milliseconds each miss the
  // cache (the first create hasn't resolved yet) and each create a NEW channel,
  // which is exactly the long-standing "duplicate channel" bug.
  if (channelLocks.has(cacheKey)) {
    channelLocks.get(cacheKey).then((ch) => callback(ch)).catch(() => callback(null));
    return;
  }

  const guild = client.guilds.cache.first();
  if (!guild) {
    logger.error('No guild found for the bot.');
    return callback(null);
  }

  const p = (async () => {
    if (channelCache.has(cacheKey)) return channelCache.get(cacheKey);
    let channel = guild.channels.cache.find(
      (ch) => ch.name === channelName && ch.parentId === categoryId && ch.type === ChannelType.GuildText
    );
    if (!channel) {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        topic: `Transcriptions for ${channelName.replace(/-/g, ' ')}`,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: ['ViewChannel', 'ReadMessageHistory'],
            deny: ['SendMessages'],
          },
        ],
      });
    }
    channelCache.set(cacheKey, channel);
    return channel;
  })();

  channelLocks.set(cacheKey, p);
  p.then((ch) => callback(ch))
    .catch((err) => { logger.error('Error creating channel:', err); callback(null); })
    .finally(() => channelLocks.delete(cacheKey));
}

// Voice channel and audio playback management ("Listen Live" events)
//
// Discord allows a bot one voice connection per server, so each server has at
// most one live *event*: a named voice channel that plays new calls from one or
// more talk groups. Clicking Listen Live asks for an event name, or, if an event
// is already running, offers to add the talk group to it or replace it with a
// new event. Each event has one connection and one player; the player's
// listeners are attached once, and going Idle plays the next queued call.
const liveEvents = new Map(); // guildId -> event
const VOICE_READY_TIMEOUT_MS = 20000;
const VOICE_IDLE_CLEANUP_MS = 2 * 60 * 1000;
const VOICE_MAX_QUEUE_AGE_MS = 5 * 60 * 1000; // skip calls that waited this long; keeps the event live
const VOICE_TMP_DIR = path.join(os.tmpdir(), 'scanner-map-voice');

function liveEventsForTalkGroup(talkGroupID) {
  talkGroupID = String(talkGroupID);
  return [...liveEvents.values()].filter((ev) => ev.talkGroups.has(talkGroupID));
}

function isTalkGroupLive(talkGroupID) {
  return liveEventsForTalkGroup(talkGroupID).length > 0;
}

function playAudioForTalkGroup(talkGroupID, transcriptionId) {
  talkGroupID = String(talkGroupID);
  for (const event of liveEventsForTalkGroup(talkGroupID)) {
    if (!event.player) continue;
    event.queue.push({ transcriptionId, talkGroupID, queuedAt: Date.now() });
    if (event.player.state.status === AudioPlayerStatus.Idle && !event.loading) {
      processAudioQueue(event);
    } else {
      logger.info(`Listen Live: queued call ${transcriptionId} (TG ${talkGroupID}) for event "${event.name}" ` +
        `(${event.queue.length} waiting)`);
    }
  }
}

// Copy a call's audio into a temp file. ffmpeg can't reliably read .m4a from a
// pipe (the moov atom is usually at the end of the file), so it gets a real file.
async function fetchCallAudioToTempFile(transcriptionId) {
  const row = await new Promise((resolve) => {
    db.get('SELECT storage_key, audio_file_path, storage_mode FROM transcriptions WHERE id = ?',
      [transcriptionId], (err, r) => resolve(err ? null : r));
  });
  const key = row && (row.storage_key || row.audio_file_path);
  const ext = key && path.extname(key) ? path.extname(key) : '.audio';
  await fs.promises.mkdir(VOICE_TMP_DIR, { recursive: true });
  const tmpFile = path.join(VOICE_TMP_DIR, `${transcriptionId}-${Date.now()}${ext}`);

  const writeStream = async (readable) => {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmpFile);
      readable.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      readable.pipe(out);
    });
    return tmpFile;
  };

  if (key && storage) {
    try {
      // Saves that hit a storage outage are parked locally until re-uploaded
      if (row.storage_mode === pendingUploads.PENDING_MODE) {
        const parked = pendingUploads.pendingPath(key);
        if (fs.existsSync(parked)) return await writeStream(fs.createReadStream(parked));
      }
      const readable = storage.type === 'local'
        ? storage.createReadStream(key)
        : await storage.getReadStream(key);
      return await writeStream(readable);
    } catch (e) {
      logger.warn(`Listen Live: storage read failed for call ${transcriptionId} (${e.message}); trying DB copy`);
    }
  }

  const blob = await new Promise((resolve) => {
    db.get('SELECT audio_data FROM audio_files WHERE transcription_id = ?',
      [transcriptionId], (err, r) => resolve(err || !r ? null : r.audio_data));
  });
  if (!blob) return null;
  await fs.promises.writeFile(tmpFile, Buffer.from(blob));
  return tmpFile;
}

async function processAudioQueue(event) {
  if (!event.player || event.loading || event.player.state.status !== AudioPlayerStatus.Idle) return;

  let item = event.queue.shift();
  let skipped = 0;
  while (item && Date.now() - item.queuedAt > VOICE_MAX_QUEUE_AGE_MS) {
    skipped++;
    item = event.queue.shift();
  }
  if (skipped) logger.info(`Listen Live: skipped ${skipped} stale call(s) on event "${event.name}" to catch up`);
  if (!item) return;

  event.loading = true;
  let tmpFile = null;
  try {
    tmpFile = await fetchCallAudioToTempFile(item.transcriptionId);
  } catch (e) {
    logger.error(`Listen Live: could not load audio for call ${item.transcriptionId}: ${e.message}`);
  }
  event.loading = false;

  // The event may have ended while the audio was loading
  if (liveEvents.get(event.guildId) !== event) {
    if (tmpFile) fs.unlink(tmpFile, () => {});
    return;
  }
  if (!tmpFile) {
    logger.error(`Listen Live: no audio found for call ${item.transcriptionId}`);
    return processAudioQueue(event);
  }

  const transcoder = new prism.FFmpeg({
    args: ['-analyzeduration', '0', '-loglevel', 'error', '-i', tmpFile,
      '-f', 's16le', '-ar', '48000', '-ac', '2'],
  });
  transcoder.on('error', (e) => logger.error(`Listen Live: ffmpeg failed for call ${item.transcriptionId}: ${e.message}`));
  transcoder.once('close', () => fs.unlink(tmpFile, () => {}));

  const resource = createAudioResource(transcoder, {
    inputType: StreamType.Raw,
    metadata: { transcriptionId: item.transcriptionId },
  });
  event.lastActivity = Date.now();
  event.player.play(resource);
  logger.info(`Listen Live: playing call ${item.transcriptionId} (TG ${item.talkGroupID}) on event "${event.name}"`);
}

function eventTalkGroupList(event) {
  return [...event.talkGroups.entries()].map(([id, name]) => `• ${name} (${id})`).join('\n');
}

function eventNameModal(talkGroupID, suggestedName, replacing) {
  const nameInput = new TextInputBuilder()
    .setCustomId('ll_event_name')
    .setLabel('Event name (becomes the voice channel name)')
    .setPlaceholder('e.g. "Structure fire on Main St"')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(90)
    .setRequired(true);
  if (suggestedName) nameInput.setValue(suggestedName.slice(0, 90));
  return new ModalBuilder()
    .setCustomId(`ll_event_modal_${talkGroupID}`)
    .setTitle(replacing ? `New event (ends "${replacing}")`.slice(0, 45) : 'Start a Listen Live event')
    .addComponents(new ActionRowBuilder().addComponents(nameInput));
}

// Button: 🎧 Listen Live on a talk group's message
async function handleListenLive(interaction, talkGroupID) {
  talkGroupID = String(talkGroupID);
  const event = liveEvents.get(interaction.guild.id);
  const talkGroupInfo = await getTalkGroupName(talkGroupID);

  if (!event) {
    await interaction.showModal(eventNameModal(talkGroupID, talkGroupInfo.name));
    return;
  }

  if (event.talkGroups.has(talkGroupID)) {
    await interaction.reply({
      content: `🎧 **${talkGroupInfo.name}** is already playing in event **${event.name}**: ${event.voiceChannel}`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ll_add_${talkGroupID}`)
      .setLabel(`Add to "${event.name}"`.slice(0, 80))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ll_new_${talkGroupID}`)
      .setLabel('Start a new event')
      .setStyle(ButtonStyle.Danger),
  );
  await interaction.reply({
    content: `🎧 Event **${event.name}** is live in ${event.voiceChannel} with:\n${eventTalkGroupList(event)}\n\n` +
      `Add **${talkGroupInfo.name}** to it, or start a new event? ` +
      '(Discord allows only one voice channel per server, so a new event ends the current one.)',
    components: [row],
    flags: [MessageFlags.Ephemeral],
  });
}

// Button: "Add to <event>"
async function handleListenLiveAdd(interaction, talkGroupID) {
  talkGroupID = String(talkGroupID);
  const event = liveEvents.get(interaction.guild.id);
  const talkGroupInfo = await getTalkGroupName(talkGroupID);
  if (!event) {
    // The event ended since the prompt was shown
    await interaction.showModal(eventNameModal(talkGroupID, talkGroupInfo.name));
    return;
  }
  event.talkGroups.set(talkGroupID, talkGroupInfo.name);
  logger.info(`Listen Live: added TG ${talkGroupID} to event "${event.name}"`);
  await interaction.update({
    content: `✅ Added **${talkGroupInfo.name}** to event **${event.name}**: ${event.voiceChannel}\n` +
      `Now playing:\n${eventTalkGroupList(event)}`,
    components: [],
  });
}

// Button: "Start a new event"
async function handleListenLiveNew(interaction, talkGroupID) {
  const event = liveEvents.get(interaction.guild.id);
  const talkGroupInfo = await getTalkGroupName(talkGroupID);
  // The current event only ends once the new name is submitted, so cancelling the form changes nothing
  await interaction.showModal(eventNameModal(String(talkGroupID), talkGroupInfo.name, event && event.name));
}

// Modal submit: event name entered
async function handleListenLiveEventModal(interaction, talkGroupID) {
  talkGroupID = String(talkGroupID);
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const guild = interaction.guild;
  const name = interaction.fields.getTextInputValue('ll_event_name').replace(/\s+/g, ' ').trim().slice(0, 90)
    || 'Listen Live';
  const talkGroupInfo = await getTalkGroupName(talkGroupID);

  const previous = liveEvents.get(guild.id);
  if (previous) {
    logger.info(`Listen Live: event "${previous.name}" replaced by "${name}"`);
    endLiveEvent(guild.id);
  }

  const event = await createLiveEvent(guild, name);
  if (!event) {
    await interaction.editReply('❌ Failed to create the voice channel.');
    return;
  }
  event.talkGroups.set(talkGroupID, talkGroupInfo.name);

  try {
    await entersState(event.connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);
  } catch (e) {
    logger.error(`Listen Live: voice connection for event "${name}" never became ready ` +
      `(state: ${event.connection.state.status})`);
    endLiveEvent(guild.id);
    await interaction.editReply('❌ The bot could not connect to voice. Check that it has Connect and Speak ' +
      'permissions, then try again.');
    return;
  }

  monitorLiveEvent(event);
  logger.info(`Listen Live: event "${name}" started with TG ${talkGroupID}`);
  await interaction.editReply(
    `🎧 Event **${name}** is live. Join ${event.voiceChannel}\nPlaying: ${talkGroupInfo.name}\n` +
    'New calls play there as they come in. Click 🎧 Listen Live on another talk group to add it.' +
    (previous ? `\nℹ️ Ended event **${previous.name}**.` : '')
  );
}

function getTalkGroupName(talkGroupID) {
  return new Promise((resolve) => {
    db.get(
      `SELECT alpha_tag FROM talk_groups WHERE id = ?`,
      [talkGroupID],
      (err, row) => {
        if (err) {
          logger.error('Database error:', err);
          resolve({ name: `TG ${talkGroupID}`, group: 'Unknown' });
        } else if (row) {
          resolve({ name: row.alpha_tag || `TG ${talkGroupID}`, group: 'Unknown' });
        } else {
          logger.error(`No data found for talk group ID ${talkGroupID}`);
          resolve({ name: `TG ${talkGroupID}`, group: 'Unknown' });
        }
      }
    );
  });
}

async function createLiveEvent(guild, name) {
  let voiceChannel;
  try {
    voiceChannel = await guild.channels.create({
      name: `🔊 ${name}`,
      type: ChannelType.GuildVoice,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: ['ViewChannel', 'Connect', 'Speak'],
        },
      ],
    });
  } catch (err) {
    logger.error('Error creating voice channel:', err);
    return null;
  }

  const event = {
    guildId: guild.id,
    name,
    voiceChannel,
    talkGroups: new Map(), // talkGroupID -> display name
    connection: null,
    player: null,
    queue: [],
    loading: false,
    monitor: null,
    lastActivity: Date.now(),
  };

  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  player.on('stateChange', (oldState, newState) => {
    if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
      processAudioQueue(event);
    }
  });
  player.on('error', (error) => {
    // The player goes Idle after an error, which moves on to the next call
    const id = error.resource && error.resource.metadata ? error.resource.metadata.transcriptionId : '?';
    logger.error(`Listen Live: player error on event "${event.name}" (call ${id}): ${error.message}`);
  });
  event.player = player;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true, // the bot only sends audio
  });
  connection.subscribe(player);
  connection.on('stateChange', (oldState, newState) => {
    if (oldState.status !== newState.status) {
      logger.debug(`Listen Live: voice connection "${event.name}" ${oldState.status} -> ${newState.status}`);
    }
  });
  connection.on('error', (error) => {
    logger.error(`Listen Live: voice connection error on event "${event.name}": ${error.message}`);
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // A channel move or region change reconnects on its own; give it a moment
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch (error) {
      if (liveEvents.get(event.guildId) === event) {
        logger.warn(`Listen Live: voice connection for event "${event.name}" dropped; ending event`);
        endLiveEvent(event.guildId);
      }
    }
  });
  event.connection = connection;

  liveEvents.set(guild.id, event);
  return event;
}

function monitorLiveEvent(event) {
  if (event.monitor) return;
  event.monitor = setInterval(() => {
    if (liveEvents.get(event.guildId) !== event) {
      clearInterval(event.monitor);
      return;
    }
    const listeners = event.voiceChannel.members.filter((member) => !member.user.bot);
    if (listeners.size > 0) {
      event.lastActivity = Date.now();
    } else if (Date.now() - event.lastActivity >= VOICE_IDLE_CLEANUP_MS) {
      logger.info(`Listen Live: nobody listening to event "${event.name}"; ending it`);
      endLiveEvent(event.guildId);
    }
  }, 30 * 1000);
}

function endLiveEvent(guildId) {
  const event = liveEvents.get(guildId);
  if (!event) return;
  liveEvents.delete(guildId);

  if (event.monitor) clearInterval(event.monitor);
  event.queue.length = 0;
  try { event.player.stop(true); } catch (error) {
    logger.error(`Error stopping player for event "${event.name}":`, error.message);
  }
  if (event.connection && event.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    try { event.connection.destroy(); } catch (error) {
      logger.error(`Error destroying connection for event "${event.name}":`, error.message);
    }
  }
  event.voiceChannel
    .delete()
    .then(() => logger.info(`Deleted voice channel for event "${event.name}"`))
    .catch((err) => logger.error('Error deleting voice channel:', err));
}

// Define the slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('alert')
    .setDescription('Manage alert keywords')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Add a keyword for alerts')
        .addStringOption((option) =>
          option.setName('keyword').setDescription('The keyword to add').setRequired(true)
        )
        .addStringOption((option) =>
          option.setName('talkgroup').setDescription('Optional talk group name').setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Remove a keyword from alerts')
        .addStringOption((option) =>
          option.setName('keyword').setDescription('The keyword to remove').setRequired(true)
        )
        .addStringOption((option) =>
          option.setName('talkgroup').setDescription('Optional talk group name').setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('List all alert keywords')
    ),
  
  // New summary command
  new SlashCommandBuilder()
    .setName('summary')
    .setDescription('Manage the dispatch summary')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('refresh')
        .setDescription('Refresh the summary now')
    )
];

// Discord client setup
client.commands = new Collection();

client.once('clientReady', async () => {
  logger.info(`Logged in as ${client.user.tag}!`);

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    logger.info('Started refreshing application (/) commands.');

    await rest.put(Routes.applicationCommands(client.user.id), {
      body: commands.map((command) => command.toJSON()),
    });

    logger.info('Successfully reloaded application (/) commands.');
  } catch (error) {
    logger.error(error);
  }

  const guild = client.guilds.cache.first(); // Adjust if needed

  // Set up the alert channel
  if (guild) {
    alertChannel = guild.channels.cache.find(
      (channel) => channel.name === 'alerts' && channel.isTextBased()
    );
    if (!alertChannel) {
      alertChannel = await guild.channels.create({
        name: 'alerts',
        type: ChannelType.GuildText,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: ['ViewChannel', 'ReadMessageHistory'],
            deny: ['SendMessages'],
          },
        ],
      });
      logger.info('Created alerts channel.');
    }
    
    // Set up the summary channel
    summaryChannel = await getOrCreateSummaryChannel(guild);
    if (summaryChannel) {
      logger.info('Summary channel is ready.');
    }
  } else {
    logger.error('Bot is not in any guilds.');
  }

  // Start the summary scheduler
  startSummaryScheduler();
  
  // Start transcription process if needed
  if (effectiveTranscriptionMode === 'local') {
    logger.info('Initializing local transcription process...');
    startTranscriptionProcess();
  } else {
    logger.info(`Transcription mode set to '${effectiveTranscriptionMode}'. Local Python process will not be started.`);
  }
  
  isBootComplete = true;
});

client.on('interactionCreate', async (interaction) => {
  // Handle Slash Commands
  if (interaction.isCommand()) {
    const { commandName, options } = interaction;

    if (commandName === 'alert') {
      // --- Start Alert Command Logic ---
      const subcommand = interaction.options.getSubcommand();
      const keyword = options.getString('keyword');
      const talkGroupInput = options.getString('talkgroup');

      if (subcommand === 'add') {
        if (!keyword) {
          // Use flags instead of ephemeral: true
          return interaction.reply({ content: 'Please provide a keyword to add.', flags: [MessageFlags.Ephemeral] });
        }

        let talkGroupID = null;
        if (talkGroupInput) {
          db.get(
            `SELECT id FROM talk_groups WHERE alpha_tag = ?`,
            [talkGroupInput],
            (err, row) => {
              if (err) {
                logger.error('Database error adding keyword:', err);
                // Use flags instead of ephemeral: true
                return interaction.reply({ content: 'Error adding keyword due to database issue.', flags: [MessageFlags.Ephemeral] });
              } else if (row) {
                talkGroupID = row.id;
                addGlobalKeyword(keyword, talkGroupID, interaction);
              } else {
                // Use flags instead of ephemeral: true
                return interaction.reply({ content: `Talk group \\"${talkGroupInput}\\" not found.`, flags: [MessageFlags.Ephemeral] });
              }
            }
          );
        } else {
          addGlobalKeyword(keyword, talkGroupID, interaction);
        }

        function addGlobalKeyword(keyword, talkGroupID, interaction) {
          db.run(
            `INSERT OR IGNORE INTO global_keywords (keyword, talk_group_id) VALUES (?, ?)`,
            [keyword, talkGroupID],
            function (err) {
              if (err) {
                logger.error('Error inserting keyword:', err.message);
                // Use flags instead of ephemeral: true
                return interaction.reply({ content: 'Error adding keyword.', flags: [MessageFlags.Ephemeral] });
              }
              // Use flags instead of ephemeral: true
              interaction.reply({ content: `✅ Keyword \\"${keyword}\\" added for alerts${talkGroupID ? ` (for TG ${talkGroupID})` : ''}.`, flags: [MessageFlags.Ephemeral] });
            }
          );
        }
      } else if (subcommand === 'remove') {
        if (!keyword) {
          // Use flags instead of ephemeral: true
          return interaction.reply({ content: 'Please provide a keyword to remove.', flags: [MessageFlags.Ephemeral] });
        }

        let talkGroupID = null;
        if (talkGroupInput) {
          db.get(
            `SELECT id FROM talk_groups WHERE alpha_tag = ?`,
            [talkGroupInput],
            (err, row) => {
              if (err) {
                logger.error('Database error removing keyword:', err);
                // Use flags instead of ephemeral: true
                return interaction.reply({ content: 'Error removing keyword due to database issue.', flags: [MessageFlags.Ephemeral] });
              } else if (row) {
                talkGroupID = row.id;
                removeGlobalKeyword(keyword, talkGroupID, interaction);
              } else {
                // Use flags instead of ephemeral: true
                return interaction.reply({ content: `Talk group \\"${talkGroupInput}\\" not found.`, flags: [MessageFlags.Ephemeral] });
              }
            }
          );
        } else {
          removeGlobalKeyword(keyword, null, interaction);
        }

        function removeGlobalKeyword(keyword, talkGroupID, interaction) {
          const sql = talkGroupID
            ? `DELETE FROM global_keywords WHERE keyword = ? AND talk_group_id = ?`
            : `DELETE FROM global_keywords WHERE keyword = ? AND talk_group_id IS NULL`;
          const params = talkGroupID ? [keyword, talkGroupID] : [keyword];

          db.run(sql, params, function (err) {
            if (err) {
              logger.error('Error deleting keyword:', err.message);
              // Use flags instead of ephemeral: true
              return interaction.reply({ content: 'Error removing keyword.', flags: [MessageFlags.Ephemeral] });
            }
            if (this.changes > 0) {
               // Use flags instead of ephemeral: true
               interaction.reply({ content: `🗑️ Keyword \\"${keyword}\\" removed from alerts${talkGroupID ? ` (for TG ${talkGroupID})` : ' (global)'}.`, flags: [MessageFlags.Ephemeral] });
            } else {
               // Use flags instead of ephemeral: true
               interaction.reply({ content: `Keyword \\"${keyword}\\" not found for the specified scope.`, flags: [MessageFlags.Ephemeral]});
            }
          });
        }
      } else if (subcommand === 'list') {
        db.all(`SELECT keyword, talk_group_id FROM global_keywords ORDER BY talk_group_id, keyword`, [], (err, rows) => {
          if (err) {
            logger.error('Error fetching keywords:', err.message);
            // Use flags instead of ephemeral: true
            return interaction.reply({ content: 'Error fetching keywords.', flags: [MessageFlags.Ephemeral] });
          }

          if (rows.length === 0) {
            // Use flags instead of ephemeral: true
            return interaction.reply({ content: '❌ No global keywords set.', flags: [MessageFlags.Ephemeral] });
          }

          // Use Promise.all to handle async talk group lookups cleanly
          Promise.all(rows.map(async (row) => {
            // ... (inner promise logic remains the same)
            if (row.talk_group_id) {
              try {
                const tgRow = await new Promise((resolve, reject) => {
                  db.get(`SELECT alpha_tag FROM talk_groups WHERE id = ?`, [row.talk_group_id], (err, tgRow) => {
                    if (err) reject(err);
                    else resolve(tgRow);
                  });
                });
                const tgName = tgRow ? tgRow.alpha_tag : `TG ${row.talk_group_id} (Not Found)`;
                return `- **${row.keyword}** (Talk Group: ${tgName})`;
              } catch (dbErr) {
                 logger.error('Error fetching talk group name during list:', dbErr);
                 return `- **${row.keyword}** (Talk Group ID: ${row.talk_group_id} - Error looking up name)`;
              }
            } else {
              return `- **${row.keyword}** (Global)`;
            }
          })).then(lines => {
             // Fix: Use single backslash for newline
             const reply = '📝 **Global Keywords:\n' + lines.join('\n');
             // Handle potential message length limits
             if (reply.length > 2000) {
                 // Use flags instead of ephemeral: true
                 interaction.reply({ content: 'Too many keywords to display. Please refine your query or manage via database.', flags: [MessageFlags.Ephemeral] });
             } else {
                 // Use flags instead of ephemeral: true
                 interaction.reply({ content: reply, flags: [MessageFlags.Ephemeral] });
             }
          });
        });
      }
      // --- End Alert Command Logic ---

    } else if (commandName === 'summary') {
      // --- Start Summary Command Logic ---
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'refresh') {
        // Use flags instead of ephemeral: true
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            await updateSummaryEmbed();
            await interaction.editReply('✅ Summary has been refreshed!');
        } catch (error) {
            logger.error("Error during manual summary refresh:", error);
            await interaction.editReply('❌ Failed to refresh summary. Please check logs.').catch(console.error);
        }
      }
      // --- End Summary Command Logic ---
    }

  // Handle Button Interactions
  } else if (interaction.isButton()) {
    const customId = interaction.customId;

    try {
      if (customId.startsWith('listen_live_')) {
        await handleListenLive(interaction, customId.replace('listen_live_', ''));

      } else if (customId.startsWith('ll_add_')) {
        await handleListenLiveAdd(interaction, customId.replace('ll_add_', ''));

      } else if (customId.startsWith('ll_new_')) {
        await handleListenLiveNew(interaction, customId.replace('ll_new_', ''));

      } else if (customId === 'refresh_summary') {
        // Use flags instead of ephemeral: true
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        await updateSummaryEmbed();
        await interaction.editReply('✅ Summary has been refreshed!');
      
      } else if (customId.startsWith('ask_ai_')) {
        const talkGroupID = customId.replace('ask_ai_', '');
        const modal = new ModalBuilder()
          .setCustomId(`ask_ai_modal_${talkGroupID}`)
          .setTitle(`Ask AI about TG ${talkGroupID}`);
        
        // Create the text input component
        const questionInput = new TextInputBuilder()
          .setCustomId('ai_question')
          .setLabel("Your question about this talk group:") // Shortened label
          .setPlaceholder('e.g., "Were there any fire-related incidents?", "List major events."')
          .setStyle(TextInputStyle.Paragraph) // Use Paragraph for potentially longer questions
          .setRequired(true);

        // Add the input to an action row and add to the modal
        const firstActionRow = new ActionRowBuilder().addComponents(questionInput);
        modal.addComponents(firstActionRow);
        
        // Show the modal to the user
        await interaction.showModal(modal);
      }

    } catch (error) {
      logger.error(`Error handling button interaction ${customId}:`, error);
      try {
        const errorMessage = (error.code === 10062)
         ? '❌ This interaction has expired. Please try the command again or use a newer message.'
         : '❌ There was an error processing your request.';

        if (interaction.deferred || interaction.replied) {
          // Use flags instead of ephemeral: true
          await interaction.followUp({ content: errorMessage, flags: [MessageFlags.Ephemeral] });
        } else {
          // Use flags instead of ephemeral: true
          await interaction.reply({ content: errorMessage, flags: [MessageFlags.Ephemeral] });
        }
      } catch (followUpError) {
        logger.error(`Failed to send error follow-up/reply for interaction ${interaction.id}:`, followUpError);
      }
    }
  // Handle Modal Submissions
  } else if (interaction.isModalSubmit()) {
    const customId = interaction.customId;

    if (customId.startsWith('ll_event_modal_')) {
      try {
        await handleListenLiveEventModal(interaction, customId.replace('ll_event_modal_', ''));
      } catch (error) {
        logger.error(`Listen Live: error starting event: ${error.message}`, { stack: error.stack });
        const msg = '❌ There was an error starting the Listen Live event.';
        try {
          if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
          else await interaction.reply({ content: msg, flags: [MessageFlags.Ephemeral] });
        } catch (_) { /* interaction expired */ }
      }
    } else if (customId.startsWith('ask_ai_modal_')) {
      // Make the reply PUBLIC by removing ephemeral flag/option
      await interaction.deferReply(); // No ephemeral flag needed here
      const talkGroupID = customId.replace('ask_ai_modal_', '');
      const userQuestion = interaction.fields.getTextInputValue('ai_question');

      try {
        // --- Read lookback from .env, default to 8 hours --- 
        const askAiLookbackHours = parseFloat(ASK_AI_LOOKBACK_HOURS) || 8;
        const now = new Date(); 
        const queryStartDate = new Date(now.getTime() - askAiLookbackHours * 60 * 60 * 1000); 
        // Convert start date to Unix seconds for the query
        const startTimeUnix = Math.floor(queryStartDate.getTime() / 1000);
        
        // --- End Time Window Change --- 

        // 1. Fetch transcriptions using the configured window
        logger.info(`Ask AI: Fetching last ${askAiLookbackHours} hours transcriptions for TG ${talkGroupID} (since ${startTimeUnix})`); // Updated log
        const transcriptions = await new Promise((resolve, reject) => {
          db.all(
            `SELECT timestamp, transcription 
             FROM transcriptions 
             WHERE talk_group_id = ? AND timestamp > ? AND transcription != '' 
             ORDER BY timestamp ASC`, 
            // Use Unix timestamp for query parameter
            [talkGroupID, startTimeUnix], 
            (err, rows) => {
              if (err) {
                logger.error(`Error fetching transcriptions for Ask AI (TG: ${talkGroupID}):`, err);
                reject(err);
              } else {
                logger.info(`Ask AI: Retrieved ${rows.length} transcriptions for TG ${talkGroupID}.`);
                if (rows.length > 0) {
                    logger.info(` -> First timestamp: ${rows[0].timestamp}`);
                    logger.info(` -> Last timestamp: ${rows[rows.length - 1].timestamp}`);
                }
                resolve(rows);
              }
            }
          );
        });

        // Format the actual start/end time of the *fetched data* for user message
        const actualStartTime = transcriptions.length > 0 ? new Date(transcriptions[0].timestamp * 1000) : queryStartDate;
        const actualEndTime = transcriptions.length > 0 ? new Date(transcriptions[transcriptions.length - 1].timestamp * 1000) : now; // End time is now
        
        if (transcriptions.length === 0) {
            // Updated message to use variable
            await interaction.editReply(`No transcriptions found for talk group ${talkGroupID} in the last ${askAiLookbackHours} hours (since ${queryStartDate.toLocaleString('en-US', {timeZone: TIMEZONE})}).`);
            return;
        }
        
        // 2. Get Talk Group Name for context
        const talkGroupInfo = await getTalkGroupName(talkGroupID);
        const talkGroupName = talkGroupInfo.name || `TG ${talkGroupID}`;

        // Format start/end times for the prompt (using actual data times)
        const promptStartTimeFormatted = actualStartTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TIMEZONE });
        const promptEndTimeFormatted = actualEndTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TIMEZONE });
        
        // 3. Format transcriptions using simple toLocaleString
        const formattedTranscriptions = transcriptions.map(t => {
          const formattedDateTime = new Date(t.timestamp * 1000).toLocaleString('en-US', {
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: '2-digit', second: '2-digit',
            hour12: true,
            timeZone: TIMEZONE 
          });
          return `[${formattedDateTime}] ${t.transcription}`; 
        }).join('\n'); // Join with newline
        
        // 4. Create the simplified prompt for AI
        // Get timezone abbreviation 
        let tzAbbreviation = '';
        try {
            const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, timeZoneName: 'short' });
            const parts = dateFormatter.formatToParts(new Date());
            const tzPart = parts.find(part => part.type === 'timeZoneName');
            tzAbbreviation = tzPart ? tzPart.value : moment.tz(TIMEZONE).format('z');
        } catch (e) {
            logger.warn(`Could not get timezone abbreviation for ${TIMEZONE}, using moment fallback: ${e.message}`);
            tzAbbreviation = moment.tz(TIMEZONE).format('z');
        }

        // Prompt updated to use variable lookback period
        const commonPrompt = `You are an AI assistant analyzing radio transcriptions for the talk group "${talkGroupName}".

The following is a log of radio transmissions from the last ${askAiLookbackHours} hours (approximately ${promptStartTimeFormatted} to ${promptEndTimeFormatted} ${tzAbbreviation}):
---
${formattedTranscriptions}
---

Using only the transcriptions provided above, please answer the user's question concisely:
User Question: ${userQuestion}

**Instructions:**
- Answer concisely based *only* on the provided transcriptions.
- Focus on events and details directly relevant to the user's question.
- Avoid including minor details or unrelated events unless specifically asked.
- If you cannot find a relevant information for the question within the provided log, state that clearly.`;

        logger.info(`Ask AI Prompt for TG ${talkGroupID} (Length: ${commonPrompt.length}, First 100 chars): ${commonPrompt.substring(0, 100)}...`);

        // 5. Call AI Provider (through the shared AI queue; someone is waiting, so it goes first).
        // While an admin has paused the AI, say so now rather than after a long wait.
        const queueOpts = { label: 'Ask AI', timeoutMs: 60000, priority: 'high', queueWhenDown: !llmQueue.isPausedByHand() };

        let aiResponseText = 'Error: Could not get response from AI.';
        try {
            if (AI_PROVIDER.toLowerCase() === 'openai') {
                if (!OPENAI_API_KEY) {
                    throw new Error("OpenAI API key is not configured.");
                }
                logger.info(`[Bot] Answering question with OpenAI model: ${OPENAI_MODEL}`);

                const response = await llmQueue.request('https://api.openai.com/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${OPENAI_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: OPENAI_MODEL,
                        messages: [{ role: 'user', content: commonPrompt }],
                        temperature: 0.5,
                        max_tokens: 500
                    }),
                }, queueOpts);
                if (!response.ok) {
                    const errorBody = await response.text();
                    throw new Error(`OpenAI API error! status: ${response.status}. Body: ${errorBody}`);
                }
                const result = await response.json();
                if (result.choices && result.choices.length > 0 && result.choices[0].message) {
                    aiResponseText = result.choices[0].message.content;
                }

            } else { // Default to Ollama
                logger.info(`[Bot] Answering question with Ollama model: ${OLLAMA_MODEL}`);

                const response = await llmQueue.request(`${OLLAMA_URL}/api/generate`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                      model: OLLAMA_MODEL,
                      prompt: commonPrompt,
                      stream: false,
                      options: { num_ctx: llmQueue.ollamaNumCtx() }
                    }),
                }, queueOpts);
                if (!response.ok) {
                    throw new Error(`Ollama API error! status: ${response.status}`);
                }
                const data = await response.json();
                aiResponseText = data.response || 'Error: AI returned an empty response.';
            }

            // --- ADDED: Remove <think> block from both providers ---
            const thinkBlockRegex = /<think>[\s\S]*?<\/think>\s*/;
            aiResponseText = aiResponseText.replace(thinkBlockRegex, '').trim();
            // --- END ADDED ---

        } catch (fetchError) {
            if (fetchError.name === 'AbortError') {
                logger.error(`Ask AI Error: Request timed out (60s) for TG ${talkGroupID}`);
                aiResponseText = 'Error: The request to the AI timed out.';
            } else if (fetchError.name === 'LlmUnavailableError') {
                logger.warn(`Ask AI for TG ${talkGroupID}: ${fetchError.message}`);
                aiResponseText = llmQueue.isPausedByHand()
                    ? 'Error: The AI is paused by an admin right now. Please try again later.'
                    : "Error: The AI isn't answering right now. Please try again in a few minutes.";
            } else {
                logger.error(`Ask AI Fetch Error for TG ${talkGroupID}:`, fetchError);
                aiResponseText = 'Error: Could not connect to the AI service.';
            }
        }

        // 6. Send the response back to the user (publicly, in an embed)
        const replyEmbed = new EmbedBuilder()
          .setTitle(`AI Analysis for ${talkGroupName}`)
          .setColor(0x5865F2) // Discord blurple color
          // Updated description to use variable
          .setDescription(`**Your Question:**\n${userQuestion}\n\n**AI Answer (based on last ${askAiLookbackHours} hours):**\n>>> ${aiResponseText}`)
          .setTimestamp();

        // Truncate description if too long for Discord embed
        if (replyEmbed.data.description.length > 4096) {
            const truncatedDesc = replyEmbed.data.description.substring(0, 4093) + '...';
            replyEmbed.setDescription(truncatedDesc);
        }

        await interaction.editReply({ embeds: [replyEmbed] });

      } catch (error) {
        logger.error(`Error handling Ask AI modal submission for TG ${talkGroupID}:`, error);
        // Keep error message ephemeral
        await interaction.followUp({ content: '❌ An error occurred while processing your request. Please check the bot logs.', flags: [MessageFlags.Ephemeral] });
      }
    }
  }
  // Handle other interaction types (select menus, modals) if needed...
});

// ===========================================================================
// Internal Discord admin endpoints (localhost-only)
// These run inside the bot process where the Discord `client` lives. The
// webserver (a separate process) proxies the Settings page's /api/setup/discord
// calls here. We restrict to loopback so they can't be hit from outside.
// ===========================================================================
function isLoopback(req) {
  const ip = (req.ip || req.connection?.remoteAddress || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function discordGuild() {
  return client && client.guilds ? client.guilds.cache.first() : null;
}

// The AI queue's state, for the Pause AI button in Settings.
app.get('/internal/ai/status', (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  res.json({ ok: true, status: { ...llmQueue.status(), catchUp: aiCatchUp.status() } });
});

// List the bot's text channels and categories so the UI can filter/sort and
// select items to delete.
app.get('/internal/discord/channels', (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  if (!discordClientReady) return res.json({ ok: false, error: 'Discord not connected' });
  const guild = discordGuild();
  if (!guild) return res.json({ ok: false, error: 'No guild' });
  const channels = Array.from(guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildText)
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      category: ch.parent ? ch.parent.name : null,
      parentId: ch.parentId || null,
      position: ch.rawPosition != null ? ch.rawPosition : (ch.position || 0),
      createdTimestamp: ch.createdTimestamp || 0,
    }))
    .values())
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));

  // Categories (channel groups), with a count of how many text channels live in each.
  const childCounts = {};
  for (const ch of channels) if (ch.parentId) childCounts[ch.parentId] = (childCounts[ch.parentId] || 0) + 1;
  const categories = Array.from(guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildCategory)
    .map((ch) => ({ id: ch.id, name: ch.name, channelCount: childCounts[ch.id] || 0 }))
    .values())
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ ok: true, guild: guild.name, channels, categories });
});

// Bulk-delete selected channels and/or categories (rate-limit aware). When a
// category is selected with deleteCategoryChildren, its child channels go too.
app.post('/internal/discord/delete', express.json(), async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  if (!discordClientReady) return res.json({ ok: false, error: 'Discord not connected' });
  const guild = discordGuild();
  if (!guild) return res.json({ ok: false, error: 'No guild' });

  const body = req.body || {};
  const channelIds = Array.isArray(body.channelIds) ? body.channelIds.map(String) : [];
  const categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds.map(String) : [];
  const deleteCategoryChildren = body.deleteCategoryChildren !== false; // default true
  const confirm = body.confirm === true;

  // Build the ordered set: child channels first, then categories last.
  const channelSet = new Set(channelIds);
  if (deleteCategoryChildren) {
    for (const ch of guild.channels.cache.values()) {
      if (ch.parentId && categoryIds.includes(ch.parentId)) channelSet.add(ch.id);
    }
  }
  // Don't try to delete a category as if it were a channel.
  for (const cid of categoryIds) channelSet.delete(cid);

  const channelTargets = Array.from(channelSet)
    .map((id) => guild.channels.cache.get(id))
    .filter(Boolean);
  const categoryTargets = categoryIds
    .map((id) => guild.channels.cache.get(id))
    .filter((ch) => ch && ch.type === ChannelType.GuildCategory);

  if (!confirm) {
    return res.json({
      ok: true,
      dryRun: true,
      channels: channelTargets.map((ch) => ({ id: ch.id, name: ch.name })),
      categories: categoryTargets.map((ch) => ({ id: ch.id, name: ch.name })),
    });
  }

  try {
    let removedChannels = 0;
    let removedCategories = 0;
    const errors = [];
    for (const ch of channelTargets) {
      try {
        for (const key of Array.from(channelCache.keys())) {
          if (channelCache.get(key)?.id === ch.id) channelCache.delete(key);
        }
        messageCache.delete(ch.id);
        await ch.delete('Deleted via Settings → Discord Tools');
        removedChannels += 1;
        await new Promise((r) => setTimeout(r, 600)); // rate-limit friendly
      } catch (e) { errors.push(`#${ch.name}: ${e.message}`); }
    }
    for (const cat of categoryTargets) {
      try {
        for (const key of Array.from(categoryCache.keys())) {
          if (categoryCache.get(key)?.id === cat.id) categoryCache.delete(key);
        }
        await cat.delete('Deleted via Settings → Discord Tools');
        removedCategories += 1;
        await new Promise((r) => setTimeout(r, 600));
      } catch (e) { errors.push(`category ${cat.name}: ${e.message}`); }
    }
    logger.info(`[discord] deleted ${removedChannels} channel(s) and ${removedCategories} category(ies)`);
    res.json({ ok: true, removedChannels, removedCategories, errors });
  } catch (e) {
    logger.error(`[discord] delete failed: ${e.message}`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Delete empty/orphaned talkgroup channels (those with no recent messages).
app.post('/internal/discord/cleanup-empty', express.json(), async (req, res) => {
  if (!isLoopback(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  if (!discordClientReady) return res.json({ ok: false, error: 'Discord not connected' });
  const guild = discordGuild();
  if (!guild) return res.json({ ok: false, error: 'No guild' });
  const dryRun = !(req.body && req.body.confirm === true);
  try {
    const text = guild.channels.cache.filter((ch) => ch.type === ChannelType.GuildText && ch.name !== 'dispatch-summary');
    const candidates = [];
    for (const ch of text.values()) {
      const msgs = await ch.messages.fetch({ limit: 1 }).catch(() => null);
      if (msgs && msgs.size === 0) candidates.push({ id: ch.id, name: ch.name });
    }
    if (dryRun) return res.json({ ok: true, dryRun: true, candidates });
    let removed = 0;
    for (const c of candidates) {
      const ch = guild.channels.cache.get(c.id);
      if (ch) { try { await ch.delete('Empty channel cleanup'); removed += 1; await new Promise((r) => setTimeout(r, 600)); } catch { /* ignore */ } }
    }
    logger.info(`[discord] cleaned up ${removed} empty channels`);
    res.json({ ok: true, removed, candidates });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Global Error Handler for Express
app.use((err, req, res, next) => {
  logger.error('Global Error Handler:', { 
    error: err.message, 
    stack: err.stack,
    method: req.method,
    url: req.url
  });
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).send('File size is too large.');
  }
  return res.status(500).send('Internal Server Error.');
});

// Start the Express server and Discord bot (only after initialization is complete)
let server;
let discordClientReady = false;

async function startBotServices() {
  try {
    // Start the Express server for bot API endpoints (call ingestion)
    server = app.listen(PORT_NUM, () => {
      logger.info(`Bot server is running on port ${PORT_NUM}`);
    });

    if (IS_MAP_ONLY_MODE) {
      logger.info('MAP_ONLY_MODE enabled - running without Discord.');
      startMapOnlyServices();
      return;
    }

    // Login to Discord
    await client.login(DISCORD_TOKEN);
    discordClientReady = true;
    logger.info('Discord bot logged in successfully.');

  } catch (error) {
    logger.error('Error starting bot services:', error);
    throw error;
  }
}

// --- Settings changed in .env while running --------------------------------
// liveEnv re-reads .env every few seconds (and right after Settings saves it).
// Values are re-derived here; things that hold a connection or a process are
// restarted only when their own settings changed.
const settingsSchema = require('./src/config/settingsSchema');
const TRANSCRIBER_KEYS = new Set([
  'TRANSCRIPTION_MODE', 'TRANSCRIPTION_DEVICE', 'WHISPER_MODEL', 'PYTHON_COMMAND',
  'OPENAI_TRANSCRIPTION_PROMPT', 'AUTO_UPDATE_PYTHON_PACKAGES',
]);
const STORAGE_KEYS = new Set(['STORAGE_MODE', 'LOCAL_AUDIO_DIR', 'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET_NAME',
  'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE', 'S3_PUBLIC_BASE_URL']);

function applyLiveSettings(changed) {
  const names = changed.map((k) => {
    if (process.env[k] === undefined) return `${k} removed`;
    return settingsSchema.isSecret(k) ? `${k} (secret)` : `${k}=${process.env[k]}`;
  });
  logger.info(`Settings changed: ${names.join(', ')}`, { console: true });

  readEnvSettings();
  computeDerivedSettings();
  ADDRESS_PREFILTER_ENABLED = String(process.env.ADDRESS_PREFILTER ?? 'true').toLowerCase() !== 'false';
  SEGMENT_ALIGN_CONFIG = segmentAlign.loadConfig();
  AUDIO_PREPROCESS_CONFIG = audioPreprocess.loadConfig();
  TRANSCRIPT_FILTER_CONFIG = hallucinationFilter.loadConfig();
  RETENTION_DAYS = retentionDaysSetting();
  MERGED_CALL_SPLIT = String(process.env.MERGED_CALL_SPLIT || 'true').toLowerCase() !== 'false';
  MERGED_CALL_MIN_SEGMENT_SEC = mergedCallMinSegmentSec();
  loadSummarySettings();
  pendingUploads.reloadConfig();
  geocodingModule.reloadSettings(changed);
  const has = (test) => changed.some(test);

  if (has((k) => k === 'LOG_LEVEL')) require('./src/logger').applyLevel();
  // A new AI server, model or key deserves a fresh try rather than waiting out an old backoff
  if (has((k) => AI_CONNECTION_KEYS.has(k))) llmQueue.reset();
  if (has((k) => k === 'WEBSERVER_PASSWORD')) updateAdminPassword();
  else if (has((k) => k === 'ENABLE_AUTH')) createAdminUser().catch((e) => logger.error(`Could not create the admin user: ${e.message}`));
  if (has((k) => k === 'STORAGE_RETRY_INTERVAL_MIN')) reschedulePendingUploads();
  if (has((k) => STORAGE_KEYS.has(k))) initStorage();
  if (has((k) => TRANSCRIBER_KEYS.has(k) || k.startsWith('WHISPER_'))) restartTranscriberWhenIdle();
  if (has((k) => k === 'DISCORD_TOKEN') && !IS_MAP_ONLY_MODE) {
    discordClientReady = false;
    Promise.resolve(client.destroy())
      .then(() => client.login(DISCORD_TOKEN))
      .then(() => { discordClientReady = true; logger.info('Discord bot signed in with the new token.', { console: true }); })
      .catch((e) => logger.error(`Discord sign-in with the new token failed: ${e.message}`));
  }
  if (has((k) => settingsSchema.WEB_KEYS.has(k))) {
    restartWebserver().catch((e) => logger.error(`Web server restart failed: ${e.message}`));
  }
  const needRestart = changed.filter((k) => settingsSchema.describe(k)?.apply === 'restart');
  if (needRestart.length) logger.warn(`Restart Scanner Map to apply: ${needRestart.join(', ')}`);
}

const AI_CONNECTION_KEYS = new Set(['AI_PROVIDER', 'OLLAMA_URL', 'OLLAMA_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL']);
liveEnv.onChange((changed) => applyLiveSettings(changed));
liveEnv.watch();

// In map-only mode we still ingest calls, transcribe, geocode and serve the
// web map - we just skip everything that requires a Discord connection.
function startMapOnlyServices() {
  if (effectiveTranscriptionMode === 'local') {
    logger.info('Initializing local transcription process (map-only mode)...');
    startTranscriptionProcess();
  } else {
    logger.info(`Transcription mode '${effectiveTranscriptionMode}' - no local Python process needed.`);
  }
  isBootComplete = true;
  logger.info('Map-only services started. Ingestion + web map are live.');
}

// Transcription process will be started in the Discord ready event

// Handle process termination
process.on('SIGINT', () => {
  logger.info('Shutting down gracefully...');
  
  const shutdownPromises = [];
  
  // Clean up transcription process first
  if (transcriptionProcess) {
    logger.info('Cleaning up transcription process...');
    cleanupTranscriptionProcess();
  }
  
  // Close bot server if it exists
  if (server) {
    shutdownPromises.push(new Promise((resolve) => {
      server.close(() => {
        logger.info('Bot Express server closed.');
        resolve();
      });
    }));
  }
  
  // Disconnect Discord client if ready
  if (discordClientReady) {
    client.destroy();
    logger.info('Discord bot disconnected.');
  }
  
  // Wait for server shutdown, then close database
  Promise.all(shutdownPromises).then(() => {
    db.close((err) => {
      if (err) {
        logger.error('Error closing database connection:', err);
      } else {
        logger.info('Database connection closed.');
      }
      process.exit(0);
    });
  });
});