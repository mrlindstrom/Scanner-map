<div align="center">

# 📡 Scanner Map 2.0

### Real-time emergency-scanner mapping, transcription & dispatch intelligence

> **This is a fork** of [poisonednumber/Scanner-map](https://github.com/poisonednumber/Scanner-map) (branch `2.0`). See [What this fork adds](#-what-this-fork-adds) for the changes.

Ingest radio calls from **SDRTrunk**, **TrunkRecorder**, or any **rdio-scanner-compatible** source — then transcribe them with AI, extract & geocode the address, and watch them appear **live on an interactive map** with optional **Discord** integration.

![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.9–3.12-3776AB?logo=python&logoColor=white)
![Platforms](https://img.shields.io/badge/Windows%20%7C%20Linux%20%7C%20Docker-informational)
![License](https://img.shields.io/badge/License-MIT-green)

</div>

---

## ✨ What's new in 2.0

Version 2.0 is a ground-up modernization of the original [Scanner-map](https://github.com/poisonednumber/Scanner-map). The biggest change: **you no longer hand-edit `.env`**. Everything is driven by a guided web setup wizard and a live settings page.

| Area | 2.0 highlight |
|------|---------------|
| 🧙 **Install** | One file to launch (`start.bat` / `start.sh`), a **web Setup Wizard** for first-time config, and **auto-restart** straight into the app when setup finishes. |
| ⚙️ **Settings** | A retro-themed **live Settings page** on the map — change config, manage users/sessions, view DB stats & logs, back up the database, and run updates without touching files. |
| 🛰️ **Multi-system talkgroups** | Talkgroups are now scoped per **radio system** `(system, id)`, so overlapping IDs across multiple systems/counties no longer collide. |
| 🤖 **Smarter geocoding** | Target-county/city enforcement, DB-driven talkgroup metadata, and enriched LLM prompts for more accurate address extraction. |
| 🎤 **Transcription filtering** | Whitelist/blacklist which talkgroups get transcribed — perfect for TrunkRecorder, which sends *everything*. |
| 💬 **Discord tools** | De-duplicated channel creation (no more duplicate channels), plus a filterable, checkbox-based tool to bulk-delete channels & categories. |
| 📍 **Manual plotting** | Pin any transcribed call that didn't auto-geocode, by address or `lat, lon`. |
| ☁️ **Storage** | Local disk, **S3 / Cloudflare R2 / Backblaze B2 / MinIO**, or in-DB blobs. |
| 🔄 **Updates** | Built-in update checker + one-click self-update (`git pull` + deps + migrations). |

---

## 🍴 What this fork adds

Everything in upstream 2.0, plus the changes below. Every new behaviour is configurable in `.env`; `.env.example` documents each setting and its default.

### 🎤 Transcription quality
Ideas adapted from [RadioTranscriber](https://github.com/Nite01007/RadioTranscriber) (MIT).

- **Audio cleanup before transcription** (all modes): ffmpeg high-pass filter (default 100 Hz) to remove rumble and hum, converted to 16 kHz mono. An optional low-pass filter and percentile normalization are included but off by default; on decoded P25 audio they dropped words. `AUDIO_PREPROCESS_*`
- **Made-up-text filter** (all modes) removes Whisper's usual hallucinations:
  - text from silence ("Thanks for watching", subtitle credits)
  - "copy copy copy copy" loops, collapsed to one
  - beeps and long letter runs, replaced with `[beeps]` / `[noise]`
  - text spoken faster than a person can talk
  - dots-only or foreign-script output

  Real speech is never cut short: a cutoff phrase only trims when it's near the end. `TRANSCRIPT_FILTER_*`, `TRANSCRIPT_UNIT_MAPPINGS`
- **Tunable local Whisper**: beam size, patience, temperature, no-speech threshold, VAD silence, segment dropping, and a retry without VAD. The defaults keep the previous behaviour. `WHISPER_*`
- **Waits for the full transcript** before addressing, alerting and posting, so long calls aren't handled from partial text.

### 🔔 Tone detection
- **Fixed [icad-tone-detection](https://github.com/TheGreatCodeholio/icad_tone_detection)**. It now calls the Python API directly from the project venv instead of a CLI that was often missing from `PATH`. This fixes the frequency-band crash, result parsing, and a 5-second B-tone minimum that rejected real pages.
- **Hi-low warble detection** (e.g. Houston FD citywide alerts), alongside two-tone, pulsed and long tones. `TONE_DETECT_HI_LOW`, `HI_LOW_*`
- **Two-tone tuning**: `TWO_TONE_B_MIN_LENGTH`, `TWO_TONE_MAX_GAP_S`. Logs show which tone type was detected.

### 🔀 Merged calls
TrunkRecorder sometimes sends several radios in one recording.

- **Safer per-speaker splitting:**
  - **speaker changes are snapped to real silences in the recording.** TrunkRecorder's positions are whole wall-clock seconds and drift past the audio; in a test on 20 calls only 7 of 32 of its cut points landed in a pause. `MERGED_CALL_ALIGN_SILENCE`, `MERGED_CALL_SILENCE_*`
  - segments are clamped to the real audio length
  - key-ups, kerchunks and empty pieces are dropped
  - if fewer than two usable segments are left, the whole call is transcribed as one
  - `MERGED_CALL_MIN_SEGMENT_SEC`; `MERGED_CALL_SPLIT=false` turns splitting off
- **Merged calls now get the same processing as normal calls:** address extraction and geocoding, tone detection, keyword alerts, and Discord Listen Live.
- Leftover segment files are cleaned up at startup and daily.

### ☁️ Storage resilience
For S3 / R2 / B2 / MinIO:

- **Saves retry** with backoff and a per-attempt timeout. During an outage, new calls skip straight to local storage for a cooldown period.
- **Local fallback**: if remote storage is down, audio is parked in `audio/pending-upload` and the call is still transcribed and mapped. A size cap keeps it from filling the disk.
- **Re-upload job**: a maintenance job uploads parked audio every `STORAGE_RETRY_INTERVAL_MIN` and deletes the local copy once uploaded.
- Parked audio still plays in the map and in Discord.

Settings: `STORAGE_SAVE_*`, `STORAGE_FALLBACK_*`, `STORAGE_OUTAGE_COOLDOWN_SEC`.

### 🎨 Themes
- **Five themes** for the map and the Settings page: **Original** (the classic black and green), **Amber**, **Windows 95**, **Midnight** and **Daylight**.
- Pick one under *Settings → Theme*. Your choice is remembered per browser, and the site default is `ui.defaultTheme` in `public/config.js`.
- The **Windows 95** theme has bevelled windows and title bars, and its audio player looks like the classic Sound Recorder.

### 🗺️ Map
- **One call plays at a time.** Live audio, talkgroup autoplay and tracked calls share a single queue. When the map is tracking new calls, it lets the current call finish before moving to the next.
- **More useful heatmap** (panel at the bottom right):
  - **Weight by:** all calls, recent activity, or emergency severity
  - **Sensitivity** slider and a colour legend
  - **Dim markers** option
  - **Busiest areas** list: click an entry to zoom there
  - Stays readable at every zoom level

### 💬 Discord
- **More useful call messages.** Each call in a channel's rolling message shows:
  - the speaker, the time (in each viewer's own timezone), the length and an audio link
  - the transcript, with matched keywords in **bold**
  - 📍 the extracted address (opens Google Maps) and a 🗺️ link that opens Scanner Map on that call (`/?call=<id>`)
  - 🏷️ the call category, added a few seconds later once the map has assigned it
  - 🔔 any detected tone and 🔑 any matched keywords

  The embed colour shows the most serious call in it: red for an emergency flag, orange for a tone, amber for a keyword, blue for a located call. Merged calls use the same layout, with one line per speaker, and now get the Listen Live / Ask AI buttons too. Keyword alerts show the same call details plus a jump link.
- **Listen Live works again.** Upgraded to `@discordjs/voice` 0.19, which supports Discord's DAVE voice encryption; without it the bot joins voice but nobody hears it.
- Playback is more reliable:
  - waits for the voice connection to be ready
  - plays `.m4a` files reliably
  - doesn't skip queued calls
  - logs errors instead of hiding them
- **Listen Live events.** Clicking 🎧 Listen Live asks for an event name, and that becomes the voice channel's name. If an event is already running, you can **add the talk group to it**, so one channel plays calls from several talk groups, or **start a new event**, which ends the current one. Discord allows a bot only one voice channel per server, so there is one event at a time. Calls that waited more than 5 minutes in the queue are skipped so the event stays live. The bot ends the event about 2 minutes after the last listener leaves.
- Keyword alerts now also fire for merged calls.

### 📻 Dispatch summary
- **Finds the calls that matter.** The old summary took the longest transcript from each quarter of the hour, so a rambling traffic stop beat a 5-second "shots fired". Now every call is scored from the signals Scanner Map already has: dispatch tones, keyword matches, the map category, a located address, and high-priority radio phrases. Routine chatter ("10-4", "en route", "show me clear", radio checks) scores low.
- **The AI triages incidents.** The top candidates go to the AI with a clear severity rubric. It groups related calls into one incident (same address, same units, a dispatch and its follow-ups) and returns only critical, high and medium incidents; routine ones are left out instead of used as padding.
- **The embed** lists incidents most severe first (🔴 / 🟠 / 🟡), each with the latest status, time, talk group, audio, a link to its Discord message and map, and how many related calls it covers.
- If the AI is down, the summary shows the highest-scoring calls instead of an error.
- Uses the same Ollama model and context size as the rest of Scanner Map, so it doesn't make Ollama reload the model. `SUMMARY_MAX_INCIDENTS`, `SUMMARY_MAX_CANDIDATES`, `SUMMARY_MIN_SCORE`, `SUMMARY_EXTRA_PRIORITY_TERMS`, `SUMMARY_EXTRA_BENIGN_TERMS`

### 📜 Logs
- **Daily rotation**: a new log file each day, keeping `LOG_RETENTION_DAYS` days (default 3). `LOG_MAX_SIZE` sets an optional per-file size cap.
- **Readable console**: one aligned layout (time, level, source, message). Each call gets a header with talkgroup and call ID, followed by its transcript. Repeated errors are collapsed into a summary line. `LOG_CONSOLE_VERBOSE=true` shows everything; `NO_COLOR=1` turns off colours.
- The Settings → Maintenance log viewer lists the dated files, newest first.

### 🔐 Settings & auth
- Logging in with basic auth reuses your existing session instead of creating a new one on every request, which could hit the session limit and log you out.
- The Settings page shows a warning and disables Save if its config fails to load, instead of wrongly saying authentication is off.
- The Updates tab shows which repo and branch updates come from (this fork).

---

## 🧠 How it works

```
┌──────────────┐   call+audio    ┌───────────────┐   transcribe    ┌──────────────┐
│  SDRTrunk /  │ ──────────────► │   Bot server  │ ──────────────► │  Whisper /   │
│ TrunkRecorder│  (HTTP upload)  │   (bot.js)    │                 │  OpenAI/ICAD │
│ rdio-scanner │                 └──────┬────────┘                 └──────┬───────┘
└──────────────┘                        │ transcript                      │ text
                                        ▼                                 ▼
                                 ┌───────────────┐  geocode (LLM +  ┌──────────────┐
                                 │  geocoding.js │  Google/Location │   SQLite DB  │
                                 │ address→coords│ ◄──────────────► │ (botdata.db) │
                                 └──────┬────────┘                  └──────┬───────┘
                                        │ coords                          │
                                        ▼                                 ▼
                          ┌───────────────────────┐  live (Socket.IO) ┌──────────┐
                          │  Web server (webserver)│ ────────────────► │  Browser │
                          │  map • API • settings  │                   │   map    │
                          └───────────┬────────────┘                   └──────────┘
                                      │ post transcripts / summaries
                                      ▼
                                 ┌──────────┐
                                 │ Discord  │
                                 └──────────┘
```

Two Node processes run together from a single launcher: the **bot** (call ingestion, transcription, Discord, geocoding) and the **web server** (map UI, REST API, setup wizard, settings). They share one SQLite database.

---

## 🚀 Quick start

### Prerequisites

- **Node.js ≥ 18** — <https://nodejs.org>
- **FFmpeg** on your `PATH` (audio handling)
- **Python 3.9–3.12** *(only for local transcription / tone detection)*
- A radio source: **SDRTrunk**, **TrunkRecorder**, or **rdio-scanner**
- At least one geocoding key: **Google Maps** or **LocationIQ** (a keyless OpenStreetMap fallback exists, but a key is strongly recommended)
- *(Optional)* an **NVIDIA GPU** for fast local transcription
- *(Optional)* a **Discord bot** application

### 1. Get the code

```bash
git clone -b 2.0 https://github.com/mrlindstrom/Scanner-map.git
cd Scanner-map
```

### 2. Launch

| OS | Command |
|----|---------|
| **Windows** | double-click **`start.bat`** (or run it in a terminal) |
| **Linux / macOS** | `bash start.sh` |

The launcher installs Node dependencies if needed, then starts the **Setup Wizard**.

### 3. Complete the Setup Wizard

Open **<http://localhost:8080/setup>** and follow the steps (details below). When you click **🚀 Start Scanner Map** at the end, the app **automatically restarts into full mode** — no manual commands.

Your map is then live at **<http://localhost>** (or whatever web port you chose).

> 💡 Already configured by hand? Set `SETUP_COMPLETE=true` in `.env` to skip the wizard.

---

## 🐳 Docker

```bash
cp .env.example .env      # optional: pre-seed values
docker compose up -d
```

Then browse to `http://<host>:8080/setup` for first-time setup, or mount an existing `.env` to skip it. Audio, database, models, and logs are persisted via volumes defined in `docker-compose.yml`.

---

## 🧙 The Setup Wizard, step by step

The wizard writes a fully-commented `.env` for you and validates each section with live health checks.

1. **Welcome & API key** — generates the API key your radio sources will use to upload calls. **Copy it** — you'll need it in SDRTrunk/TrunkRecorder.
2. **Map & location** — auto-detects your location (with a manual address-search fallback if location is off or returns `0,0`) and sets the map's default center/zoom.
3. **Geocoding** — choose Google Maps or LocationIQ, set your **target counties** and **cities** (auto-populate every city in a county with one click). *Only listed cities/counties get plotted* — this keeps the map focused and the AI efficient.
4. **Transcription** — pick a provider:
   - **Local (faster-whisper)** — GPU auto-detection and **one-click install** of the right PyTorch + dependencies into a project virtual environment.
   - **Remote faster-whisper**, **OpenAI Whisper**, or **ICAD** — with connection tests.
   - Optional **whitelist/blacklist** of talkgroups to transcribe.
5. **AI features** — OpenAI or **Ollama** (which can run on another machine; the wizard lists its installed models). Configure address extraction and summaries, and optionally scope summaries to specific talkgroups.
6. **Discord** *(optional)* — step-by-step bot creation, with the exact **intents/permissions** to enable in the Developer Portal.
7. **Network & auth** — web port (default **80**), upload port (default **3306**), and optional login protection.
8. **Talkgroups** — import one or more RadioReference CSVs **per system**, search/sort, and tick which talkgroups should be mapped. A **“Check dispatch only”** helper selects just the dispatch channels (where addresses are actually announced).

---

## ⚙️ The live Settings page

After setup, open **Settings** from the map's menu (or go to `/settings`). It uses the same theme as the map (see [Themes](#-themes)) and merges every admin tool into one place:

- **API keys & health** — view/rotate keys, run live checks on geocoding, AI, transcription, and Discord.
- **Transcription / AI** — change providers and the talkgroup whitelist/blacklist on the fly.
- **Talkgroups** — re-import, filter by system, and toggle mapping.
- **Discord tools** — filter & sort channels, then **bulk-delete** selected channels and/or categories (rate-limit aware), or sweep empty channels.
- **Manual plot** — find transcribed calls with no location and pin them by address or `lat, lon`.
- **Users & sessions** — create admins, revoke sessions.
- **Call purge** — bulk-remove calls by talkgroup/time with undo.
- **Maintenance** — database stats, **one-click DB backup**, and a log viewer.
- **Updates** — check for new releases from this fork and self-update.

---

## 📡 Connecting your radio source

Use the **API key** generated during setup and your **upload port** (default `3306`).

### SDRTrunk
`Playlist → Streaming → +rdio-scanner` → set the server to `http://<server>:3306`, enter your **System ID** and **API key**, and enable per-alias streaming.

### TrunkRecorder
Add an upload server to `config.json` (TrunkRecorder sends *all* audio — use the transcription whitelist to filter):

```json
"uploadServer": "http://<server>:3306",
"uploadServerKey": "<your-api-key>",
"shortName": "<your-system-name>"
```

> The `shortName` becomes the **system** name — match it when importing that system's talkgroup CSV so overlapping IDs map correctly.

### rdio-scanner (downstream)
Add Scanner Map as a downstream server with the URL `http://<server>:3306` and your API key.

---

## 🔧 Configuration reference

Everything lives in `.env` (generated by the wizard). Highlights:

| Key | Purpose |
|-----|---------|
| `WEBSERVER_PORT` / `BOT_PORT` | Web UI port (default 80) / call-upload port (default 3306) |
| `PUBLIC_DOMAIN` | Public URL for share/playback links. Leave blank for local (`http://localhost:<port>`) |
| `TRANSCRIPTION_MODE` | `local` \| `remote` \| `openai` \| `icad` |
| `PYTHON_COMMAND` | Python interpreter for local transcription (auto-set to the project `.venv`) |
| `TRANSCRIBE_MODE` / `TRANSCRIBE_TALK_GROUPS` | `all` \| `whitelist` \| `blacklist` + the talkgroup list |
| `AI_PROVIDER` | `ollama` \| `openai` for address extraction & summaries |
| `STORAGE_MODE` | `local` \| `s3` \| `r2` \| `b2` \| `minio` \| `db` |
| `GEOCODING_TARGET_COUNTIES` / `TARGET_CITIES_LIST` | Where calls are allowed to plot |
| `ENABLE_AUTH` | Require login to view the map |
| `AUDIO_PREPROCESS_*` / `TRANSCRIPT_FILTER_*` / `WHISPER_*` | Audio cleanup, made-up-text filter, local Whisper decoding *(fork)* |
| `ENABLE_TWO_TONE_MODE` / `TWO_TONE_TALK_GROUPS` / `TONE_DETECT_HI_LOW` | Tone detection and which talkgroups get it *(fork: warble)* |
| `MERGED_CALL_SPLIT` / `MERGED_CALL_MIN_SEGMENT_SEC` | Per-speaker splitting of merged calls *(fork)* |
| `STORAGE_SAVE_*` / `STORAGE_FALLBACK_*` / `STORAGE_RETRY_INTERVAL_MIN` | Remote storage retry, local fallback and re-upload *(fork)* |
| `LOG_RETENTION_DAYS` / `LOG_MAX_SIZE` / `LOG_CONSOLE_VERBOSE` | Log rotation and console detail *(fork)* |

Map look-and-feel (icons, default layers, default theme) lives in `public/config.js`.

---

## 🔄 Updating

From the **Settings → Updates** tab, or manually:

```bash
# Windows
scripts\update.ps1
# Linux / macOS
bash scripts/update.sh
```

This pulls the latest code, installs dependencies, and runs database migrations. Updates come from the branch your checkout tracks (this fork's `2.0`).

To bring in changes from the original project:

```bash
git remote add upstream https://github.com/poisonednumber/Scanner-map.git   # once
git fetch upstream
git merge upstream/2.0
git push
```

---

## 🗂️ Project structure

```
Scanner-map/
├─ start.js / start.bat / start.sh   # launcher + auto-restart
├─ bot.js                            # call ingestion, transcription, Discord, geocoding
├─ webserver.js                      # map UI, REST API, settings, setup mount
├─ geocoding.js                      # address extraction + geocoding
├─ transcribe.py / tone_detect.py    # local Whisper + tone detection (two-tone, warble, pulsed, long)
├─ import_csv.js                     # talkgroup CSV importer (system-aware)
├─ src/
│  ├─ setup/      # setup wizard server, routes, env writer, python env, maintenance
│  ├─ db/         # migrations
│  ├─ storage/    # local / S3-compatible / db backends + pending-upload fallback
│  ├─ transcription/  # audio preprocessing + made-up-text filter
│  ├─ consoleFormat.js  # console log layout
│  ├─ security/   # auth, sessions, API keys
│  └─ utils/      # helpers (public URL, etc.)
├─ public/        # map UI, setup wizard, settings page, themes (theme.js / themes.css)
├─ scripts/       # migrate, reset-setup, update, syntax-check
└─ installers/    # install.ps1 / install.sh
```

---

## 🛠️ Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ModuleNotFoundError: No module named 'torch'` | Local transcription needs its Python deps. Re-run the Transcription step's installer, or point `PYTHON_COMMAND` at a Python 3.9–3.12 with `faster-whisper` installed. |
| `CUDA capability sm_120 is not compatible` warning | Harmless — torch is only used to *detect* the GPU; inference runs on CTranslate2. |
| Audio links use the wrong port | Set `PUBLIC_DOMAIN`, or leave it blank to derive `http://localhost:<WEBSERVER_PORT>`. |
| Port 80 won't bind | Use a different `WEBSERVER_PORT`, or run elevated (Linux) / free the port (Windows IIS/Skype). |
| Bot joins Discord voice but you hear nothing | Make sure `@discordjs/voice` is 0.19+ (`npm install`); older versions lack Discord's required DAVE encryption. |
| Calls missing remote audio after a storage outage | They're parked in `audio/pending-upload` and re-uploaded automatically every `STORAGE_RETRY_INTERVAL_MIN`. |
| Need to redo first-time setup | `node scripts/reset-setup.js` (add `--hard` to also wipe the database). |
| Logs | `logs/combined-YYYY-MM-DD.log` and `logs/error-YYYY-MM-DD.log` (rotated daily, `LOG_RETENTION_DAYS` kept, default 3), or the Settings → Maintenance log viewer. |

---

## 🤝 Contributing & support

For this fork's changes, open an issue on [mrlindstrom/Scanner-map](https://github.com/mrlindstrom/Scanner-map). For the core project, see the original [poisonednumber/Scanner-map](https://github.com/poisonednumber/Scanner-map), or reach **poisonednumber** on Discord.

## 📜 License

[MIT](LICENSE) © the Scanner Map contributors.
