# Apex — usage & technical guide

Setup, architecture, integrations, and internals. For the app overview see the [main README](../README.md).

---

## Feature tour

**Dashboard.** Today's classes, today's tasks, a 7-day streak, a weekly-goals card with preset chips (LeetCode problems, DSA revision hours, side-project commits, pages read, gym sessions, deep-work hours), a now-playing strip for the desktop tracker, top apps across desktop + mobile + battery-report sources, a 7-day activity trail, a collapsible activity feed, a compact burnout read, an Ask-Apex chat box, and a private day-note card.

**Tasks.** A single table that absorbs tasks, interests, habits, and class templates via a `kind` column. Priorities 1–5, deadlines, categories (DSA / Academics / Project / Personal / Leisure), course codes for anything tied to a class, tags, estimated minutes, links, and recurrence rules. Completion writes `completed_at` so the streak and analytics work.

**Timetable.** The source of truth is the `classes` table, editable from the Schedule Editor. Seed it three ways: hand-edit in the UI, re-sync from `AcademiaScraper/data/timetable.json`, or drop an image of your timetable and let a vision-capable Ollama model OCR it. The calendar page (SRM academic calendar) overrides the day-order for holidays and make-up days.

**Upcoming.** A 7-day lookahead that merges day-order classes with task deadlines, calendar events, and exam kinds.

**People (classmate radar).** Import people by profile link (GitHub, LeetCode, Codeforces, CodeChef). Apex syncs their repos, language breakdown, and competitive-programming stats, builds a similarity score against your own profile, and opens a per-person detail modal with their project list and a per-repo markdown README preview. The NextTechLab scraper pulls the current member roster. A leaderboard view ranks peers on LC, CF, and CC.

**Interests.** A lightweight exploration tracker with status (idea → exploring → building → shipped → paused), progress %, and links.

**Activity tracking.** Three sources feed the same `activity_sessions` table:
- **Desktop**: PowerShell-polled foreground window title on Windows (30-s ticks), with 45-min nudges. Distraction vs focus vs neutral is set per app with manual override support. After ~4 min without keyboard/mouse input, time stops accruing to the focused window and lands in an **"Idle (away)"** lane instead — "4h of VS Code" can't be 3h of an empty chair.
- **Mobile**: cloud sync from the Android app (no cable), with ADB `dumpsys usagestats` as the USB fallback. Package names are rendered through a `prettyAppName()` helper that strips `com.example.` prefixes and splits concatenated lowercase runs ("bloonstdbattles2" → "Bloons TD Battles 2").
- **Battery report**: `powercfg /batteryreport` parsed with cheerio, giving you per-day active + standby minutes without needing any tracker running. One-click "Sync desktop" pushes the last 14 days into the activity stream.

**Live timer + focus blocks.** A universal "what am I doing now" timer with category presets, break suggestions sized to the block you just finished, and a one-click "Go again" resume after the bell. Productive timers are mirrored to the phone over the sync API — start a task block on desktop and the Android app's blocker nudges (or bounces) Instagram-class apps until the block ends. Zen mode is the stricter cousin: locked sessions, drift detection, the works.

**Day summary.** A per-day debrief modal: tracked/focus/distraction/idle/done stats, a clickable minute-by-minute timeline, focus *sittings* (contiguous same-task timer blocks merged, expandable into segments, resumable), distractions grouped per app with severity bars, wins (completed tasks + routine milestones), and exit notes.

**Cross-device.** Desktop, phone, and browser pair against the same FastAPI sync service (`sync_api/`) with one-shot six-digit codes / QR. Tasks, notes, routine times, focus state, and phone screen time flow both ways. The web app at `{api}/web` is a single self-contained file — Three.js particle background, GSAP motion, full task/note/activity views.

**Close the day (private journal).** One entry per day, stored locally, optionally passcode-gated. The passcode uses `scryptSync` + `timingSafeEqual`; when you set one, both today's note AND the history modal require unlock (15-min in-memory TTL). Previous days are read-only once unlocked. A "Summarise" action hands the entry to Ollama for a gentle end-of-day reflection.

**Burnout.** Compact check-in tied to a work-history rollup - sleep, clarity, dread, energy. Ollama produces a short read of your current state using the last week of check-ins + activity + task completion.

**Ask Apex.** A chat panel that forwards your question to Ollama with your personal profile (name, college, major, year, interests, goals, tone) auto-prepended. Replies render as markdown.

**Weekly goals.** Set a handful of weekly targets (from presets or custom), tick progress with -1/+1/+5/Done, reset at the start of the week.

**Pomodoro + Time log.** Standard 25/5 timer with optional session logging.

**Backup.** Export / import the whole SQLite database with one click.

---

---

## Architecture

```
Apex/
├── electron/
│   ├── main.cjs            - app bootstrap, IPC routing, dialogs, protocol handlers
│   ├── preload.cjs         - the typed `window.apex.*` bridge surface
│   └── services/
│       ├── db.cjs            better-sqlite3 wrapper + migrations
│       ├── timetable.cjs     day-order math, JSON & image import
│       ├── activity.cjs      activity_sessions CRUD + rollups
│       ├── activityTracker.cjs PowerShell-based foreground-window poller
│       ├── batteryReport.cjs powercfg parser + syncToActivity
│       ├── wellbeing.cjs     ADB digital-wellbeing pull
│       ├── calendar.cjs      SRM calendar HTML → date→dayOrder map
│       ├── github.cjs        user/repo/languages fetch
│       ├── cp.cjs            LeetCode / Codeforces / CodeChef stats
│       ├── nexttechlab.cjs   NTL roster scraper
│       ├── importLinks.cjs   bulk import of people by link
│       ├── ollama.cjs        chat, plan, burnout, evening-review, OCR, auto-start
│       └── backup.cjs        export/import
├── db/
│   └── schema.sql          - applied on first boot
├── src/
│   ├── App.jsx             - router & providers
│   ├── main.jsx
│   ├── components/
│   │   ├── Sidebar.jsx
│   │   ├── CommandPalette.jsx
│   │   ├── ActivityFeed.jsx
│   │   ├── MoodTrend.jsx
│   │   ├── Pomodoro.jsx
│   │   ├── ScheduleEditor.jsx
│   │   ├── TimeLog.jsx
│   │   ├── WeeklyGoalsEditor.jsx
│   │   └── pages/
│   │       ├── Dashboard.jsx
│   │       ├── Tasks.jsx
│   │       ├── Timetable.jsx
│   │       ├── Upcoming.jsx
│   │       ├── People.jsx
│   │       ├── Interests.jsx
│   │       ├── Planner.jsx
│   │       └── Settings.jsx
│   ├── lib/
│   │   ├── appName.js      - prettyAppName(raw) for desktop + Android
│   │   └── markdown.jsx    - MarkdownBlock renderer used by Ask Apex
│   └── styles/             - index.css: tokens + 5 curated themes
├── sync_api/
│   ├── apex_sync_api.py    - FastAPI sync service (pairing, tasks, notes,
│   │                         routine, focus state, wellbeing) — see its README
│   └── web_app.html        - the /web browser app (Three.js + GSAP, single file)
├── mobile_android/         - Kotlin Android app (pairing, tasks, notes,
│                             alarms, screen-time upload, Zen mirror)
├── build/                  - app + tray icons (icon.svg is the source of truth)
└── package.json
```

### Theming

Five curated themes in `src/styles/index.css` — Apex (graphite + teal, default), Library (warm amber), Tokyo Night (indigo), Obsidian (OLED black), Daylight (light). Each defines the full token contract (bg/text ramps, category colors, `--grad-accent`, an ambient `--grad-bg` wash). Fonts are unified app-wide: Inter for UI, Sora for the wordmark + page titles (same display face as the web app and Android header), JetBrains Mono for numbers. Legacy theme keys stored in settings are migrated to the nearest survivor on boot.

### Database

SQLite via `better-sqlite3`, stored at `Documents/Apex/apex.sqlite`. Schema applied from `db/schema.sql` on every launch via `IF NOT EXISTS`, with column-level migrations in `db.cjs::runMigrations()`.

Main tables: `tasks`, `checkins`, `daily_focus`, `weekly_focus`, `weekly_goals`, `classes`, `day_order_overrides`, `people`, `repos`, `cp_stats`, `cp_submissions`, `interests`, `settings`, `time_entries`, `burnout_reports`, `activity_sessions`, `repo_summaries`, `activity_feed`, `day_notes`.

`activity_sessions` is the one to know: `(date, source, app, window_title, category, started_at, ended_at, minutes)` with a `(source, started_at)` uniqueness key so repeated syncs are idempotent.

### IPC

The preload script (`electron/preload.cjs`) exposes a single `window.apex` object grouped by domain. Every group is a thin `ipcRenderer.invoke(channel, ...args)` forwarder; one-way event streams (sync progress, activity nudges, session-ended) use `ipcRenderer.on` with an unsubscribe closure.

Groups exposed: `settings`, `tasks`, `checkins`, `dayNotes`, `streak`, `goals`, `schedule`, `timetable`, `ollama`, `burnout`, `github`, `people`, `cp`, `ntl`, `interests`, `backup`, `activity`, `tracker`, `wellbeing`, `battery`, `calendar`, `import`, `repo`, `ext`.

### Ollama integration

`electron/services/ollama.cjs` is the single entry point for anything LLM-shaped.

- **Auto-start on launch.** On `app.whenReady()` (when `ollama.autoStart` is on), `ensureRunning()` pings `/api/tags`; if that fails on Windows it tries, in order, `%LOCALAPPDATA%\Programs\Ollama\ollama app.exe`, `Ollama.exe`, `ollama.exe`, and finally the Start-Menu `Ollama.lnk` via `powershell.exe Start-Process`. On macOS/Linux it spawns `ollama serve`. Then it polls `ping()` every 750 ms up to 15 s.
- **Auto-pick best model.** `autoPickBest()` walks a ranked list - `gpt-oss:120b-cloud > gpt-oss:20b-cloud > llama3.* > qwen2.5 > mistral > phi3 > gemma` - and returns the highest-ranked installed model. Your pinned setting (`ollama.model`) always wins.
- **Personal context.** `personalContext()` reads `user.profile` (JSON: name, college, major, year, interests, goals, tone) and `user.extraContext` from settings, with sensible defaults. `buildSystem(rolePrompt)` prefixes every system prompt with a USER PROFILE + HOUSE RULES block so replies are in your voice and about your life.
- **Specialised flows.** `planDay`, `burnoutSuggest`, `burnoutCheck`, `eveningReview`, `summarizeRepo`, `ocrTimetable` - each builds its system prompt through `buildSystem()` and enforces JSON output where expected.

### Activity tracker (Windows)

`activityTracker.cjs` runs a 30-second PowerShell poll for the foreground window. It uses `-EncodedCommand` to avoid quoting hell, deliberately renames the `$pid` automatic variable to `$procId`, and writes directly to `activity_sessions` via the idempotent `(source, started_at)` upsert so checkpoint writes don't duplicate rows.

---

## Setup

```bash
# install
npm install
# rebuild better-sqlite3 for your Electron version (if node versions mismatch)
npm run rebuild

# dev (spawns Vite + Electron concurrently)
npm run dev

# prod build
npm run build
npm start

# Windows installer (nsis)
npm run dist
```

### Optional integrations

**Ollama** - install from [ollama.com](https://ollama.com) and pull at least one model, e.g. `ollama pull llama3` or `ollama pull gpt-oss:20b-cloud`. For timetable-from-image OCR, pull a vision-capable model such as `llava` or `minicpm-v`. Apex will auto-start the Ollama service if it isn't running.

**AcademiaScraper** - point the timetable folder setting at your SRM AcademiaScraper clone (contains `data/timetable.json` and `calendar.html`). "Re-sync from Academia" will rebuild the classes table from `timetable.json`.

**ADB (Android digital wellbeing)** - connect your phone with USB debugging; the Settings tab exposes a "Sync now" button that shells out to `adb shell dumpsys usagestats`.

**GitHub** - set a GitHub token in Settings to raise the rate limit and allow private-repo lookups; otherwise unauthenticated public access works for most flows.

### Personal context

Open **Settings → Ollama** and fill in the Personal context card: name, college (defaults to SRM), major, year, interests (comma-separated), goals, tone, and any extra context. Apex prepends this to every LLM prompt.

---

## Keyboard shortcuts

- **⌘K / Ctrl+K** - open the command palette (quick task add, navigation).
- **⌘/** - focus the Ask Apex chat box on the Dashboard.
- **Esc** - close any modal.

---

## Privacy

Everything core is local. The SQLite file, the battery-report parse, the activity data, the day notes - none of it leaves your machine. The only outbound calls are:
- GitHub API (only when you trigger a sync),
- LeetCode / Codeforces / CodeChef (only when you trigger a sync),
- NextTechLab website (only when you trigger a scrape),
- Ollama on `localhost:11434` (always local, even for `*-cloud` models - those tokens go Ollama → cloud, not Apex → cloud),
- the **self-hosted sync API** (opt-in, only after pairing): tasks, notes, routine times, focus state, and phone screen time — your server, your data. Day notes and the journal are never synced.

The day-note passcode uses `scryptSync` (N = 2^15, r = 8, p = 1) and `timingSafeEqual`. Unlocking is held in the main process only; it expires automatically after 15 minutes of inactivity.

---

## Known platform limits

- The desktop activity tracker and battery-report screentime are **Windows-only**. On macOS / Linux the UI hides those cards.
- `AcademiaScraper` paths default to `C:\Users\yashasvi\Documents\Python\AcademiaScraper`; change this in Settings if your path differs.
- Ollama auto-start covers Windows (Start-Menu `.lnk` + known exe paths) and `ollama serve` on macOS/Linux.

---

## Project status

Apex is a single-user project - mine. It's not packaged for distribution or reused by anyone else; it's a living tool that evolves as my college workflow does. If you're reading this as a fork, expect paths, course codes, and the NTL scraper to be SRM-specific.
