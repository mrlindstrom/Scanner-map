'use strict';

/**
 * Every .env setting the app reads, for the admin "All Settings" page.
 *
 * type:    text | number | bool | select | secret | list (comma-separated) | pipe (|-separated)
 * def:     the value used when the key is blank or missing
 * apply:   'live'    - takes effect within a few seconds of saving
 *          'restart' - read once at startup; restart Scanner Map to apply
 * guided:  the settings tab with a step-by-step workflow for this key, if any
 * web:     the web server (a separate process) reads it at startup, so the bot
 *          restarts the web server when it changes (a few seconds of downtime)
 */

const SECTIONS = [
  ['general', 'General'],
  ['network', 'Ports & Links'],
  ['discord', 'Discord'],
  ['security', 'Sign-in & Security'],
  ['storage', 'Audio Storage'],
  ['location', 'Location & Geocoding'],
  ['ai', 'AI Provider'],
  ['transcription', 'Transcription'],
  ['whisper', 'Local Whisper Decoding'],
  ['preprocess', 'Audio Cleanup'],
  ['filter', 'Transcript Filter'],
  ['merged', 'Merged Calls'],
  ['summary', 'Summaries & Ask AI'],
  ['talkgroups', 'Talkgroups'],
  ['tones', 'Tone Detection'],
  ['logging', 'Logging'],
  ['other', 'Other'],
];

// Keys the web server process reads at startup (see webserver.js and the
// modules it loads); a change restarts it.
const WEB_KEYS = new Set([
  'AI_PROVIDER', 'ENABLE_AUTH', 'GOOGLE_MAPS_API_KEY', 'LOCAL_AUDIO_DIR', 'LOCATIONIQ_API_KEY',
  'LOG_CONSOLE_VERBOSE', 'LOG_LEVEL', 'MAP_CENTER_LAT', 'MAP_CENTER_LON', 'MAP_DEFAULT_ZOOM',
  'MAX_SESSIONS_PER_USER', 'OLLAMA_MODEL', 'OLLAMA_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
  'PROTECT_AUDIO', 'PUBLIC_DOMAIN', 'S3_ACCESS_KEY_ID', 'S3_BUCKET_NAME', 'S3_ENDPOINT',
  'S3_FORCE_PATH_STYLE', 'S3_PUBLIC_BASE_URL', 'S3_REGION', 'S3_SECRET_ACCESS_KEY',
  'SESSION_DURATION_DAYS', 'SESSION_SECRET', 'STORAGE_FALLBACK_DIR', 'STORAGE_FALLBACK_MAX_MB', 'STORAGE_MODE',
  'STORAGE_OUTAGE_COOLDOWN_SEC', 'STORAGE_RETRY_DELAY_MS', 'STORAGE_SAVE_ATTEMPTS',
  'STORAGE_SAVE_TIMEOUT_MS', 'TIMEZONE', 'WEBSERVER_PASSWORD', 'WEBSERVER_PORT',
]);

const S = []; // filled below
function add(section, key, label, type, def, help, extra = {}) {
  S.push({ section, key, label, type, def: def == null ? '' : String(def), help, apply: 'live', ...extra });
}
const restart = { apply: 'restart' };

// ---- General
add('general', 'TIMEZONE', 'Time zone', 'text', 'America/New_York', 'IANA name, e.g. America/Chicago. Used for timestamps in Discord, logs and the map.', { guided: 'Map & Location' });
add('general', 'MAP_ONLY_MODE', 'Map-only mode (no Discord)', 'bool', 'false', 'Run without the Discord bot.', { ...restart, guided: 'Welcome' });
add('general', 'AUTO_UPDATE', 'Auto update', 'bool', 'false', 'Reserved; updates are run from the Updates tab.');
add('general', 'SETUP_COMPLETE', 'Setup complete', 'bool', 'false', 'false sends the next start to the first-run setup wizard.', restart);

// ---- Ports & links
add('network', 'PUBLIC_DOMAIN', 'Public address', 'text', '', 'Base of the 🗺️ and 🔊 links posted to Discord, with the scheme, e.g. https://scanner.example.com. Blank = http://localhost:<web port>.', { guided: 'Network & Auth' });
add('network', 'WEBSERVER_PORT', 'Web server port', 'number', '3001', 'Port for the map and this page. After a change, open the map on the new port.', { guided: 'Network & Auth' });
add('network', 'BOT_PORT', 'Upload port', 'number', '3306', 'Port SDRTrunk / TrunkRecorder / rdio-scanner upload calls to.', { ...restart, guided: 'Network & Auth' });

// ---- Discord
add('discord', 'DISCORD_TOKEN', 'Bot token', 'secret', '', 'The bot signs in again with the new token.', { guided: 'Discord' });
add('discord', 'CLIENT_ID', 'Application (client) ID', 'secret', '', 'Used to build the invite link.', { guided: 'Discord' });

// ---- Security
add('security', 'ENABLE_AUTH', 'Require sign-in', 'bool', 'false', 'Password-protect the map.', { guided: 'Network & Auth' });
add('security', 'WEBSERVER_PASSWORD', 'Admin password', 'secret', '', 'Password for the admin user.', { guided: 'Network & Auth' });
add('security', 'SESSION_SECRET', 'Session secret', 'secret', '', 'Signs sign-in sessions. Changing it signs everyone out.');
add('security', 'SESSION_DURATION_DAYS', 'Session length (days)', 'number', '7', 'How long a sign-in lasts.');
add('security', 'MAX_SESSIONS_PER_USER', 'Max sessions per user', 'number', '5', 'Oldest sessions are ended beyond this.');
add('security', 'PROTECT_AUDIO', 'Require sign-in for audio', 'bool', 'false', 'With sign-in on, audio links need a session too (Discord audio links stop working for others).');
add('security', 'API_KEY_FILE', 'Upload API key file', 'text', 'data/apikeys.json', 'Where upload API keys are stored.', restart);

// ---- Storage
add('storage', 'STORAGE_MODE', 'Storage backend', 'select', 'local', 'Where call audio is kept. Existing calls stay where they were saved.', { options: ['local', 's3', 'r2', 'b2', 'minio', 'db'], guided: 'Audio Storage' });
add('storage', 'LOCAL_AUDIO_DIR', 'Local audio folder', 'text', 'audio', 'Folder for local storage.', { guided: 'Audio Storage' });
add('storage', 'S3_ENDPOINT', 'S3 endpoint', 'text', '', 'e.g. https://<account>.r2.cloudflarestorage.com', { guided: 'Audio Storage' });
add('storage', 'S3_REGION', 'S3 region', 'text', 'auto', '', { guided: 'Audio Storage' });
add('storage', 'S3_BUCKET_NAME', 'S3 bucket', 'text', '', '', { guided: 'Audio Storage' });
add('storage', 'S3_ACCESS_KEY_ID', 'S3 access key ID', 'secret', '', '', { guided: 'Audio Storage' });
add('storage', 'S3_SECRET_ACCESS_KEY', 'S3 secret key', 'secret', '', '', { guided: 'Audio Storage' });
add('storage', 'S3_FORCE_PATH_STYLE', 'Path-style URLs', 'bool', 'false', 'Needed for MinIO and some B2 setups.', { guided: 'Audio Storage' });
add('storage', 'S3_PUBLIC_BASE_URL', 'Public bucket URL', 'text', '', 'Serve audio straight from this URL (public bucket or CDN).', { guided: 'Audio Storage' });
add('storage', 'AUDIO_RETENTION_DAYS', 'Keep audio (days)', 'number', '30', '0 = keep forever. Cleanup runs daily.', { guided: 'Audio Storage' });
add('storage', 'STORAGE_SAVE_ATTEMPTS', 'Upload attempts', 'number', '3', 'Tries per call before saving it locally.');
add('storage', 'STORAGE_RETRY_DELAY_MS', 'Retry delay (ms)', 'number', '2000', 'Pause before the 2nd attempt; doubles each time.');
add('storage', 'STORAGE_SAVE_TIMEOUT_MS', 'Upload timeout (ms)', 'number', '15000', 'Give up on one attempt after this long.');
add('storage', 'STORAGE_OUTAGE_COOLDOWN_SEC', 'Outage cool-down (s)', 'number', '120', 'After a failure, save new calls locally without retrying for this long.');
add('storage', 'STORAGE_FALLBACK_DIR', 'Local fallback folder', 'text', 'audio/pending-upload', 'Where audio waits while remote storage is down.');
add('storage', 'STORAGE_FALLBACK_MAX_MB', 'Fallback size cap (MB)', 'number', '2048', 'Above this, calls are kept without audio.');
add('storage', 'STORAGE_RETRY_INTERVAL_MIN', 'Re-upload every (min)', 'number', '5', 'How often parked audio is uploaded again.');

// ---- Location
add('location', 'GOOGLE_MAPS_API_KEY', 'Google Maps API key', 'secret', '', 'Geocoder (LocationIQ is preferred when both are set).', { guided: 'Geocoding' });
add('location', 'LOCATIONIQ_API_KEY', 'LocationIQ API key', 'secret', '', 'Geocoder.', { guided: 'Geocoding' });
add('location', 'GEOCODING_CITY', 'Main city', 'text', '', 'Fallback town for addresses with no city.', { guided: 'Map & Location' });
add('location', 'GEOCODING_STATE', 'State', 'text', '', 'Two-letter state code.', { guided: 'Map & Location' });
add('location', 'GEOCODING_COUNTRY', 'Country', 'text', 'us', 'Two-letter country code.', { guided: 'Map & Location' });
add('location', 'GEOCODING_TARGET_COUNTIES', 'Counties', 'list', '', 'Addresses outside these counties are not mapped.', { guided: 'Map & Location' });
add('location', 'TARGET_CITIES_LIST', 'Cities', 'list', '', 'If set, only addresses in these cities are mapped.', { guided: 'Target Cities' });
add('location', 'MAP_CENTER_LAT', 'Map center latitude', 'number', '', '', { guided: 'Map & Location' });
add('location', 'MAP_CENTER_LON', 'Map center longitude', 'number', '', '', { guided: 'Map & Location' });
add('location', 'MAP_DEFAULT_ZOOM', 'Map zoom', 'number', '13', 'Starting zoom level.');
add('location', 'ADDRESS_PREFILTER', 'Skip calls with no location words', 'bool', 'true', "Don't ask the AI about calls with no number, street or place word.");
add('location', 'AI_VERIFY_ADDRESS', 'Double-check places with the AI', 'bool', 'true', 'Second AI pass for named places and intersections.');
add('location', 'AI_EXTRACT_TIMEOUT_MS', 'AI timeout (ms)', 'number', '30000', 'Max wait for one extraction or check.');

// ---- AI provider
add('ai', 'AI_PROVIDER', 'AI provider', 'select', 'ollama', 'Used for addresses, summaries and Ask AI.', { options: ['ollama', 'openai'], guided: 'AI Features' });
add('ai', 'OLLAMA_URL', 'Ollama URL', 'text', 'http://localhost:11434', '', { guided: 'AI Features' });
add('ai', 'OLLAMA_MODEL', 'Ollama model', 'text', 'llama3.1:8b', '', { guided: 'AI Features' });
add('ai', 'OPENAI_API_KEY', 'OpenAI API key', 'secret', '', 'Also used by OpenAI transcription.', { guided: 'AI Features' });
add('ai', 'OPENAI_MODEL', 'OpenAI model', 'text', 'gpt-4o-mini', '', { guided: 'AI Features' });

// ---- Transcription
add('transcription', 'TRANSCRIPTION_MODE', 'Transcriber', 'select', 'local', 'local = faster-whisper on this PC.', { options: ['local', 'remote', 'openai', 'icad'], guided: 'Transcription' });
add('transcription', 'TRANSCRIPTION_DEVICE', 'Compute device', 'select', 'cpu', 'Local mode.', { options: ['cuda', 'cpu', 'mps'], guided: 'Transcription' });
add('transcription', 'WHISPER_MODEL', 'Whisper model', 'text', 'large-v3-turbo', 'Local mode.', { guided: 'Transcription' });
add('transcription', 'PYTHON_COMMAND', 'Python command', 'text', 'python', 'Python used for transcription and tone detection.', { guided: 'Transcription' });
add('transcription', 'AUTO_UPDATE_PYTHON_PACKAGES', 'Install missing Python packages', 'bool', 'true', 'When the local transcriber starts.');
add('transcription', 'MAX_CONCURRENT_TRANSCRIPTIONS', 'Parallel transcriptions', 'number', '3', 'Calls transcribed at once.', { guided: 'Transcription' });
add('transcription', 'TRANSCRIBE_MODE', 'Which talkgroups to transcribe', 'select', 'all', '', { options: ['all', 'whitelist', 'blacklist'], guided: 'Transcription' });
add('transcription', 'TRANSCRIBE_TALK_GROUPS', 'Talkgroups (white/blacklist)', 'list', '', 'IDs or system:id.', { guided: 'Transcription' });
add('transcription', 'FASTER_WHISPER_SERVER_URL', 'Remote server URL', 'text', '', 'Remote mode.', { guided: 'Transcription' });
add('transcription', 'ICAD_URL', 'ICAD URL', 'text', '', 'ICAD mode.', { guided: 'Transcription' });
add('transcription', 'ICAD_PROFILE', 'ICAD profile', 'text', '', 'ICAD mode.', { guided: 'Transcription' });
add('transcription', 'ICAD_API_KEY', 'ICAD API key', 'secret', '', 'ICAD mode.', { guided: 'Transcription' });
add('transcription', 'OPENAI_TRANSCRIPTION_MODEL', 'OpenAI transcription model', 'text', 'whisper-1', 'OpenAI mode.', { guided: 'Transcription' });
add('transcription', 'OPENAI_TRANSCRIPTION_TEMPERATURE', 'OpenAI temperature', 'number', '0', 'OpenAI mode.');
add('transcription', 'OPENAI_TRANSCRIPTION_PROMPT', 'Transcription prompt', 'text', '', 'Hint text given to the transcriber (OpenAI and local modes).');
add('transcription', 'TRANSCRIPT_CORRECTIONS_FILE', 'Transcript fixes file', 'text', 'data/transcript_corrections.txt', 'Edit the fixes on the Transcript Fixes tab.', { ...restart, guided: 'Transcript Fixes' });

// ---- Local whisper decoding (transcribe.py; the transcriber restarts to apply)
add('whisper', 'WHISPER_BEAM_SIZE', 'Beam size', 'number', '3', 'Higher = slower, slightly more accurate.');
add('whisper', 'WHISPER_PATIENCE', 'Patience', 'number', '1.0', '');
add('whisper', 'WHISPER_TEMPERATURE', 'Temperature', 'text', '', 'Blank = fallback list; 0 = greedy.');
add('whisper', 'WHISPER_NO_SPEECH_THRESHOLD', 'No-speech threshold', 'number', '0.6', '');
add('whisper', 'WHISPER_SEGMENT_NO_SPEECH_DROP', 'Drop segments above no-speech', 'number', '0', '0 = off.');
add('whisper', 'WHISPER_VAD_FILTER', 'Voice activity filter', 'bool', 'true', '');
add('whisper', 'WHISPER_VAD_MIN_SILENCE_MS', 'VAD min silence (ms)', 'number', '750', '');
add('whisper', 'WHISPER_RETRY_WITHOUT_VAD', 'Retry without VAD', 'bool', 'true', 'false = leave tone/noise-only clips empty.');

// ---- Audio cleanup
add('preprocess', 'AUDIO_PREPROCESS_ENABLED', 'Clean up audio first', 'bool', 'true', 'Before any transcriber.');
add('preprocess', 'AUDIO_PREPROCESS_HIGHPASS_HZ', 'High-pass (Hz)', 'number', '100', '0 = off.');
add('preprocess', 'AUDIO_PREPROCESS_LOWPASS_HZ', 'Low-pass (Hz)', 'number', '0', '0 = off.');
add('preprocess', 'AUDIO_PREPROCESS_NORMALIZE_PERCENTILE', 'Normalize percentile', 'number', '0', '0 = off.');
add('preprocess', 'AUDIO_PREPROCESS_NORMALIZE_TARGET', 'Normalize target', 'number', '0.9', '0-1 of full scale.');
add('preprocess', 'AUDIO_PREPROCESS_MAX_GAIN', 'Max gain', 'number', '20', '');

// ---- Transcript filter
add('filter', 'TRANSCRIPT_FILTER_ENABLED', 'Filter hallucinations', 'bool', 'true', '');
add('filter', 'TRANSCRIPT_FILTER_MAX_WORDS_PER_SEC', 'Max words per second', 'number', '8', 'Faster text is discarded; 0 = off.');
add('filter', 'TRANSCRIPT_FILTER_CASCADE_MIN_REPEATS', 'Trim repeats after', 'number', '4', '"copy copy copy copy"; 0 = off.');
add('filter', 'TRANSCRIPT_FILTER_TONE_MARKERS', 'Mark tones/noise', 'bool', 'true', 'BEEEP -> [beeps].');
add('filter', 'TRANSCRIPT_FILTER_REPEAT_BUSTER', 'Cut repeated phrases', 'bool', 'false', 'Dispatch repeats addresses, so off.');
add('filter', 'TRANSCRIPT_FILTER_BLOCK_PHRASES', 'Discard if it contains', 'pipe', '', 'Blank = built-in list.');
add('filter', 'TRANSCRIPT_FILTER_CUTOFF_PHRASES', 'Cut text from', 'pipe', '', 'Blank = built-in list.');
add('filter', 'TRANSCRIPT_UNIT_MAPPINGS', 'Spoken unit rewrites', 'pipe', '', 'spoken=written pairs, e.g. eight one=A1.');

// ---- Merged calls
add('merged', 'MERGED_CALL_SPLIT', 'Split per speaker', 'bool', 'true', '');
add('merged', 'MERGED_CALL_MIN_SEGMENT_SEC', 'Shortest segment (s)', 'number', '0.5', '');
add('merged', 'MERGED_CALL_ALIGN_SILENCE', 'Snap to silences', 'bool', 'true', '');
add('merged', 'MERGED_CALL_SILENCE_DB', 'Silence level (dB)', 'number', '-40', '');
add('merged', 'MERGED_CALL_SILENCE_MIN_SEC', 'Shortest pause (s)', 'number', '0.08', '');

// ---- Summaries
add('summary', 'SUMMARY_LOOKBACK_HOURS', 'Summary covers (hours)', 'number', '1', '', { guided: 'AI Features' });
add('summary', 'ASK_AI_LOOKBACK_HOURS', 'Ask AI covers (hours)', 'number', '8', '', { guided: 'AI Features' });
add('summary', 'ENABLE_SUMMARY_TALK_GROUPS', 'Only summarize some talkgroups', 'bool', 'false', '', { guided: 'AI Features' });
add('summary', 'SUMMARY_TALK_GROUPS', 'Summary talkgroups', 'list', '', 'IDs or system:id.', { guided: 'AI Features' });
add('summary', 'SUMMARY_MAX_INCIDENTS', 'Incidents shown', 'number', '6', '');
add('summary', 'SUMMARY_MAX_CANDIDATES', 'Calls sent to the AI', 'number', '40', '');
add('summary', 'SUMMARY_MIN_SCORE', 'Minimum score', 'number', '2.5', '');
add('summary', 'SUMMARY_AI_TIMEOUT_SEC', 'AI timeout (s)', 'number', '180', '');
add('summary', 'SUMMARY_EXTRA_PRIORITY_TERMS', 'Extra priority phrases', 'pipe', '', 'e.g. signal 9|code 30');
add('summary', 'SUMMARY_EXTRA_BENIGN_TERMS', 'Extra routine phrases', 'pipe', '', 'e.g. bike patrol');

// ---- Talkgroups
add('talkgroups', 'ENABLE_MAPPED_TALK_GROUPS', 'Only map some talkgroups', 'bool', 'true', '', { guided: 'Talkgroups' });
add('talkgroups', 'MAPPED_TALK_GROUPS', 'Mapped talkgroups', 'list', '', 'Calls on these are geocoded.', { guided: 'Talkgroups' });

// ---- Tones
add('tones', 'ENABLE_TWO_TONE_MODE', 'Tone detection', 'bool', 'false', '');
add('tones', 'TWO_TONE_TALK_GROUPS', 'Tone talkgroups', 'list', '', '');
add('tones', 'TWO_TONE_QUEUE_SIZE', 'Calls tagged after a tone', 'number', '1', '');
add('tones', 'TONE_DETECTION_TYPE', 'Tone types', 'select', 'auto', '', { options: ['auto', 'both', 'pulsed', 'long'] });
add('tones', 'TONE_DETECTION_THRESHOLD', 'Match threshold', 'number', '0.3', '');
add('tones', 'TONE_FREQUENCY_BAND', 'Frequency band (Hz)', 'text', '300,1500', 'low,high');
add('tones', 'TONE_TIME_RESOLUTION_MS', 'Time resolution (ms)', 'number', '15', '');
add('tones', 'TWO_TONE_MIN_TONE_LENGTH', 'A-tone min length (s)', 'number', '0.7', '');
add('tones', 'TWO_TONE_MAX_TONE_LENGTH', 'B-tone min length (s, legacy)', 'number', '3.0', 'Use the next setting instead.');
add('tones', 'TWO_TONE_B_MIN_LENGTH', 'B-tone min length (s)', 'number', '', 'Overrides the legacy one.');
add('tones', 'TWO_TONE_MAX_GAP_S', 'Max A-B gap (s)', 'number', '', '');
add('tones', 'TWO_TONE_BW_HZ', 'Two-tone bandwidth (Hz)', 'number', '50', '');
add('tones', 'TWO_TONE_MIN_PAIR_SEPARATION_HZ', 'A/B min separation (Hz)', 'number', '100', '');
add('tones', 'PULSED_MIN_CYCLES', 'Pulsed: min cycles', 'number', '3', '');
add('tones', 'PULSED_MIN_ON_MS', 'Pulsed: min on (ms)', 'number', '50', '');
add('tones', 'PULSED_MAX_ON_MS', 'Pulsed: max on (ms)', 'number', '500', '');
add('tones', 'PULSED_MIN_OFF_MS', 'Pulsed: min off (ms)', 'number', '25', '');
add('tones', 'PULSED_MAX_OFF_MS', 'Pulsed: max off (ms)', 'number', '800', '');
add('tones', 'PULSED_BANDWIDTH_HZ', 'Pulsed: bandwidth (Hz)', 'number', '50', '');
add('tones', 'LONG_TONE_MIN_LENGTH', 'Long tone: min length (s)', 'number', '0.5', '');
add('tones', 'LONG_TONE_BANDWIDTH_HZ', 'Long tone: bandwidth (Hz)', 'number', '75', '');
add('tones', 'TONE_DETECT_HI_LOW', 'Detect hi-low warble', 'bool', 'false', '');
add('tones', 'HI_LOW_INTERVAL_S', 'Hi-low: max gap (s)', 'number', '0.2', '');
add('tones', 'HI_LOW_MIN_ALTERNATIONS', 'Hi-low: min alternations', 'number', '6', '');
add('tones', 'HI_LOW_BANDWIDTH_HZ', 'Hi-low: bandwidth (Hz)', 'number', '25', '');
add('tones', 'HI_LOW_MIN_PAIR_SEPARATION_HZ', 'Hi-low: min separation (Hz)', 'number', '40', '');

// ---- Logging
add('logging', 'LOG_LEVEL', 'Log level', 'select', 'info', '', { options: ['error', 'warn', 'info', 'debug'] });
add('logging', 'LOG_CONSOLE_VERBOSE', 'Verbose console', 'bool', 'false', 'Also show routine info, debug lines and stack traces.');
add('logging', 'LOG_RETENTION_DAYS', 'Keep logs (days)', 'number', '3', '', restart);
add('logging', 'LOG_MAX_SIZE', 'Max log file size', 'text', '', 'e.g. 50m; blank = no cap.', restart);
add('logging', 'NO_COLOR', 'No console colors', 'text', '', 'Any value turns colors off.', restart);
add('logging', 'FORCE_COLOR', 'Force console colors', 'text', '', 'Any value forces colors on.', restart);

// ---- Other
add('other', 'IMPORT_SYSTEM', 'Default system for CSV import', 'text', '', 'Used by import_csv.js.');

const BY_KEY = new Map(S.map((s) => [s.key, s]));
for (const s of S) s.web = WEB_KEYS.has(s.key);

// TALK_GROUP_<id>=Town hints are dynamic keys
const DYNAMIC = [{ prefix: 'TALK_GROUP_', section: 'talkgroups', label: 'Town hint for talkgroup', type: 'text', apply: 'live', help: 'Town/county the address AI assumes for this talkgroup.' }];

// Set by the launcher scripts, never by hand
const INTERNAL_KEYS = new Set(['SCANNER_LAUNCHER']);

function describe(key) {
  if (BY_KEY.has(key)) return BY_KEY.get(key);
  const dyn = DYNAMIC.find((d) => key.startsWith(d.prefix));
  if (dyn) return { ...dyn, key, label: `${dyn.label} ${key.slice(dyn.prefix.length)}`, def: '', web: false, dynamic: true };
  return null;
}

function isSecret(key) {
  const d = describe(key);
  return !!d && d.type === 'secret';
}

module.exports = { SECTIONS, SETTINGS: S, WEB_KEYS, INTERNAL_KEYS, describe, isSecret };
