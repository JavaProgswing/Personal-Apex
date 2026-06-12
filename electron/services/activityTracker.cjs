// Apex — desktop active-window tracker.
//
// Polls the foreground window every ~30 seconds and rolls up contiguous
// same-(app,window_title) samples into a single activity_sessions row.
// Purely optional — user must toggle it on in Settings.
//
// Windows: uses PowerShell + Win32 GetForegroundWindow. We avoid bringing in
// heavy native deps (ffi / active-win) to keep the build simple.

const { BrowserWindow, powerMonitor } = require('electron');
const { exec } = require('node:child_process');
const db = require('./db.cjs');

const POLL_MS = 30_000;
const NUDGE_AFTER_MIN = 45;   // nudge when the same app has run 45+ minutes
const DISTRACT_NUDGE_MIN = 15; // distraction sessions get called out sooner

// Idle detection: after this many seconds without keyboard/mouse input the
// desk is considered abandoned, and time stops accruing to whatever window
// happens to be focused. Idle gets its own session row instead, so "4h of
// VS Code" can't be 3h of an empty chair.
const IDLE_AFTER_SEC = 240;
const IDLE_APP = 'Idle (away)';

function idleSeconds() {
  try { return powerMonitor.getSystemIdleTime() || 0; } catch { return 0; }
}

let timer = null;
let currentSession = null;    // { app, title, category, startedAt, lastTickAt }
let emitter = null;
let nudgedFor = null;         // the sessionId we already nudged about
let distractNudgedFor = null; // session already agenda-nudged for drifting
let lastPsError = null;       // surfaced via status() so UI can show cause

// PowerShell script. NOTE: do NOT use $pid — it's a read-only automatic
// variable in PowerShell (current process id). We use $procId instead.
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$sig = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint procId);
}
"@
Add-Type -TypeDefinition $sig -Language CSharp
$h = [W]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 1024
[W]::GetWindowText($h, $sb, 1024) | Out-Null
$procId = [uint32]0
[W]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
$proc = $null
try { $proc = Get-Process -Id $procId -ErrorAction Stop } catch { $proc = $null }
$exe = if ($proc) { $proc.ProcessName } else { $null }
[PSCustomObject]@{ exe = $exe; title = $sb.ToString() } | ConvertTo-Json -Compress
`.trim();

// Use -EncodedCommand with a base64-encoded UTF-16LE string. This sidesteps
// all the Windows quote-escaping pain (the old \" approach was unreliable
// and frequently produced empty stdout — which silently disabled tracking).
const PS_ENCODED = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');

function getForegroundWindow() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    exec(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${PS_ENCODED}`,
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 256 },
      (err, stdout, stderr) => {
        if (err) {
          lastPsError = (stderr || err.message || '').toString().slice(0, 240);
          return resolve(null);
        }
        const trimmed = (stdout || '').trim();
        if (!trimmed) {
          lastPsError = (stderr || 'powershell returned empty output').toString().slice(0, 240);
          return resolve(null);
        }
        try {
          const parsed = JSON.parse(trimmed);
          lastPsError = null;
          resolve(parsed);
        } catch (e) {
          lastPsError = `json parse: ${e.message}`;
          resolve(null);
        }
      }
    );
  });
}

// Category inference. Keep it conservative; the user can override via
// Settings → Activity categories. Browser windows are categorised by the
// title (which includes the page title and host), so YouTube-in-Chrome
// reliably ends up as "distraction" while GitHub-in-Chrome is "productive".
function inferCategory(exe, title) {
  const lower = (exe + ' ' + (title || '')).toLowerCase();
  const cat = db.getSetting('activity.overrides.' + (exe || '').toLowerCase());
  if (cat) return cat;
  const educationalVideo =
    /(youtube|youtu\.be)/.test(lower) &&
    /(lecture|course|tutorial|lesson|programming|coding|leetcode|codeforces|dbms|dsa|operating system|computer network|compiler|math|calculus|linear algebra|mit ocw|stanford|cs50|freecodecamp|khan academy|nptel|gate cse)/.test(lower);
  if (educationalVideo) return 'productive';
  const intentionalResearch =
    /(chrome|firefox|brave|edge|opera|vivaldi|arc|safari)/.test(lower) &&
    /(documentation|docs\.|mdn|stackoverflow|stack overflow|github|gitlab|arxiv|paper|research|course|syllabus|assignment|leetcode|codeforces|codechef|nptel|geeksforgeeks|wikipedia)/.test(lower);
  if (intentionalResearch) return 'productive';
  const workChat =
    /(slack|teams|discord)/.test(lower) &&
    /(meeting|standup|class|course|project|assignment|github|pull request|pr |issue|nexttech|srm|lab|study)/.test(lower);
  if (workChat) return 'productive';
  const rules = [
    // ── PRODUCTIVE ───────────────────────────────────────────────────
    // IDEs / editors
    { cat: 'productive', re: /(code|idea64|webstorm|pycharm|clion|rider|goland|datagrip|rubymine|phpstorm|appcode|androidstudio|xcode|vim|nvim|emacs|sublime|neovim|atom|fleet|zed)/ },
    // Terminals
    { cat: 'productive', re: /(terminal|wt|windowsterminal|powershell|pwsh|cmd|bash|zsh|wsl|kitty|alacritty|hyper|tabby|warp|iterm)/ },
    // Office / docs / notes / writing
    { cat: 'productive', re: /(docs\.|sheets\.|slides\.|notion|obsidian|logseq|typora|joplin|onenote|word|excel|powerpoint|keynote|numbers|pages|libreoffice|writer|calc|impress|overleaf)/ },
    // CP & coding sites (page titles via browser)
    { cat: 'productive', re: /(leetcode|codeforces|codechef|hackerrank|atcoder|kattis|topcoder)/ },
    // Source control & code-hosting (page titles)
    { cat: 'productive', re: /(github|gitlab|bitbucket|sourcegraph|stackoverflow|stack overflow)/ },
    // Design / engineering
    { cat: 'productive', re: /(figma|miro|excalidraw|whimsical|drawio|lucidchart)/ },
    // Data & DB
    { cat: 'productive', re: /(jupyter|colab|kaggle|tableau|powerbi|dbeaver|postgres|mysql workbench|mongodb compass|redis insight|tableplus)/ },
    // Reading / docs / dev tools
    { cat: 'productive', re: /(devdocs|mdn|read the docs|chatgpt|claude\.ai|gemini\.google|perplexity)/ },
    // ── DISTRACTION ──────────────────────────────────────────────────
    // Streaming
    { cat: 'distraction', re: /(youtube|netflix|disney|hotstar|primevideo|twitch|crunchyroll|hulu|jiocinema)/ },
    // Social
    { cat: 'distraction', re: /(instagram|facebook|twitter|x\.com|reddit|tiktok|discord|snapchat|threads|pinterest|linkedin)/ },
    // Shopping / gambling / endless feeds
    { cat: 'distraction', re: /(amazon|flipkart|myntra|nykaa|ajio|ebay|temu|shein|bet365|stake\.com|dream11|fantasy|casino|sportsbook)/ },
    // Messaging that tends to spiral
    { cat: 'distraction', re: /(whatsapp|telegram|signal|messenger|slack|teams)/ },
    // News / aggregator timesinks
    { cat: 'distraction', re: /(hackernews|news\.ycombinator|9gag|imgur|tumblr|quora)/ },
    // ── LEISURE ──────────────────────────────────────────────────────
    // Music
    { cat: 'leisure', re: /(spotify|apple music|tidal|deezer|youtubemusic|youtube music|vlc|musicbee|foobar|pandora|soundcloud)/ },
    // Games / launchers
    { cat: 'leisure', re: /(steam|epicgameslauncher|battle\.net|riot|league of legends|valorant|dota|minecraft|origin|gog galaxy|ubisoft|rockstar)/ },
    // ── REST (explicit) ──────────────────────────────────────────────
    { cat: 'rest', re: /(meditation|calm|headspace|breathe)/ },
  ];
  for (const r of rules) if (r.re.test(lower)) return r.cat;
  // Bare browser without a recognisable host ⇒ "neutral" (could be
  // anything from Wikipedia to a forum). The user can override per-app.
  if (/(chrome|firefox|brave|edge|opera|vivaldi|arc|safari)/.test(lower)) return 'neutral';
  return 'neutral';
}

// PowerShell that returns ALL top-level visible non-minimized windows
// (the focused one PLUS every other open window with a real title bar).
// We use this for the "presence" tracker — apps that are open and on
// screen but not currently focused (e.g. Spotify in another window,
// Chrome on a second monitor, an IDE you stepped away from).
const PS_VISIBLE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$sig = @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class W2 {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
Add-Type -TypeDefinition $sig -Language CSharp
$shell = [W2]::GetShellWindow()
$fg = [W2]::GetForegroundWindow()
$out = New-Object System.Collections.Generic.List[object]
[W2]::EnumWindows({ param($h,$l)
  if (-not [W2]::IsWindowVisible($h)) { return $true }
  if ([W2]::IsIconic($h)) { return $true }
  if ($h -eq $shell) { return $true }
  $len = [W2]::GetWindowTextLength($h)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [W2]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $pid2 = [uint32]0
  [W2]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  $exe = $null
  try { $exe = (Get-Process -Id $pid2 -ErrorAction Stop).ProcessName } catch {}
  if ($exe) {
    $out.Add(([PSCustomObject]@{ exe = $exe; title = $title; focused = ($h -eq $fg) })) | Out-Null
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
$out | ConvertTo-Json -Compress
`.trim();
const PS_VISIBLE_ENCODED = Buffer.from(PS_VISIBLE_SCRIPT, 'utf16le').toString('base64');

function getVisibleWindows() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    exec(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${PS_VISIBLE_ENCODED}`,
      { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 512 },
      (err, stdout) => {
        if (err) return resolve([]);
        const trimmed = (stdout || '').trim();
        if (!trimmed) return resolve([]);
        try {
          const parsed = JSON.parse(trimmed);
          // PowerShell's ConvertTo-Json can return either an object or an array
          // depending on count. Normalise.
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch { resolve([]); }
      }
    );
  });
}

// Per-app "presence" sessions — separate in-memory state so a window
// staying open (even without focus) gets its own session row. Keyed by
// exe; merging when the same exe stays visible across ticks.
//   { exe → { app, title, category, startedAt, lastTickAt } }
const presenceSessions = new Map();

async function tickPresence() {
  if (process.platform !== 'win32') return;
  const wins = await getVisibleWindows();
  if (!Array.isArray(wins)) return;
  const now = Date.now();
  const seen = new Set();
  for (const w of wins) {
    if (!w.exe) continue;
    // Skip the focused window — the focused tracker (`tick`) already
    // records it under source='desktop'. Including it here would double-
    // count whenever the user is actively using an app.
    if (w.focused) continue;
    const exe = String(w.exe);
    seen.add(exe.toLowerCase());
    const title = String(w.title || '');
    const category = inferCategory(exe, title);
    const key = exe.toLowerCase();
    const existing = presenceSessions.get(key);
    if (existing && existing.category === category) {
      existing.lastTickAt = now;
      existing.title = title;
    } else {
      // Either new app or category flipped (e.g. browser tab changed) —
      // close out the old session and start a fresh one.
      if (existing) finalisePresenceSession(existing, now);
      presenceSessions.set(key, {
        app: exe,
        title,
        category,
        startedAt: now,
        lastTickAt: now,
      });
    }
  }
  // Window closed / minimized → finalise its session.
  for (const [key, s] of [...presenceSessions.entries()]) {
    if (!seen.has(key)) {
      finalisePresenceSession(s, now);
      presenceSessions.delete(key);
    }
  }
  // Checkpoint each active session so today's totals reflect it in real time.
  for (const s of presenceSessions.values()) {
    const mins = Math.max(1, Math.round((now - s.startedAt) / 60000));
    if (mins < 1) continue;
    try {
      db.upsertActivitySession({
        date: toIsoDate(new Date(s.startedAt)),
        source: 'desktop-open',
        app: s.app,
        window_title: s.title,
        category: s.category,
        started_at: new Date(s.startedAt).toISOString(),
        ended_at: new Date(now).toISOString(),
        minutes: mins,
      });
    } catch { /* non-fatal */ }
  }
}

function finalisePresenceSession(s, now) {
  if (!s) return;
  const ended = new Date(s.lastTickAt || now);
  const mins = Math.max(1, Math.round((ended - new Date(s.startedAt)) / 60000));
  if (mins < 1) return;
  try {
    db.upsertActivitySession({
      date: toIsoDate(new Date(s.startedAt)),
      source: 'desktop-open',
      app: s.app,
      window_title: s.title,
      category: s.category,
      started_at: new Date(s.startedAt).toISOString(),
      ended_at: ended.toISOString(),
      minutes: mins,
    });
  } catch { /* non-fatal */ }
}

// Windows system processes that take foreground when the user isn't
// actually using their computer. We skip these entirely so the timeline
// doesn't fill with cryptic "LockApp" / "ApplicationFrameHost" rows when
// the screen is locked or transitioning. Match is case-insensitive on
// either the full exe or just the basename (no extension).
const SYSTEM_PROCESS_RX = /^(lockapp|lock\s?app|applicationframehost|searchhost|searchui|shellexperiencehost|startmenuexperiencehost|wfsforeground|csrss|smss|wininit|winlogon|dwm|fontdrvhost|systemsettings|textinputhost|taskmgr-bridge)\.?(exe)?$/i;
function isSystemProcess(exe) {
  if (!exe) return true;
  const base = String(exe).split(/[\\/]/).pop().toLowerCase();
  return SYSTEM_PROCESS_RX.test(base);
}

async function tick() {
  const now = Date.now();
  // Run the presence tracker in parallel — it manages its own state and
  // writes to source='desktop-open' so it doesn't collide with the
  // focused-only 'desktop' rows.
  tickPresence().catch(() => {});

  // Away from the desk? Track it as its own "Idle (away)" lane instead of
  // crediting the focused window. The first idle tick backdates the session
  // start to when input actually stopped, and closes the previous app
  // session at that same moment so wall-clock time isn't double-counted.
  const idleFor = idleSeconds();
  let app; let title; let category;
  if (idleFor >= IDLE_AFTER_SEC) {
    const idleStart = now - idleFor * 1000;
    if (currentSession && currentSession.app !== IDLE_APP) {
      currentSession.lastTickAt = Math.max(currentSession.startedAt, idleStart);
      rollover(now);
    }
    app = IDLE_APP;
    title = 'No keyboard / mouse input';
    category = 'neutral';
    if (!currentSession) {
      currentSession = { app, title, category, startedAt: idleStart, lastTickAt: now };
    }
  } else {
    const fg = await getForegroundWindow();
    if (!fg || !fg.exe) return rollover(now); // no foreground window → rollover current session

    // Skip Windows system processes — LockApp (lock screen), Shell
    // experience hosts, search bars taking focus, etc. These were
    // appearing as mysterious "lock app" rows in the activity log.
    if (isSystemProcess(fg.exe)) return rollover(now);

    app = fg.exe;
    title = fg.title || '';
    category = inferCategory(app, title);
  }

  if (currentSession && currentSession.app === app && currentSession.category === category) {
    // Extend current session
    currentSession.lastTickAt = now;
    currentSession.title = title; // track latest title
  } else {
    rollover(now);
    currentSession = { app, title, category, startedAt: now, lastTickAt: now };
  }

  if (currentSession) {
    const mins = Math.round((now - currentSession.startedAt) / 60000);

    // Checkpoint long-running sessions so they appear in Top apps / trail
    // BEFORE the user switches apps. Idempotent upsert keyed on started_at.
    if (mins >= 1) {
      try {
        const started = new Date(currentSession.startedAt);
        db.upsertActivitySession({
          date: toIsoDate(started),
          source: 'desktop',
          app: currentSession.app,
          window_title: currentSession.title,
          category: currentSession.category,
          started_at: started.toISOString(),
          ended_at: new Date(now).toISOString(),
          minutes: mins,
        });
      } catch { /* non-fatal */ }
    }

    // 10-minute bucket write — adds the elapsed minutes since the last
    // tick to whichever 10-min window we're currently in. addBucketMinutes
    // clamps the total per bucket at 10, so noisy ticks can't blow past
    // wall-clock time. This drives the new dashboard timeline.
    const lastTick = currentSession._lastBucketWriteAt || currentSession.startedAt;
    const deltaMin = Math.max(0, Math.round((now - lastTick) / 60000));
    if (deltaMin >= 1) {
      try {
        const d = new Date(now);
        const bucketStartMin = Math.floor((d.getHours() * 60 + d.getMinutes()) / 10) * 10;
        db.addBucketMinutes({
          date: toIsoDate(d),
          bucketStartMin,
          app: currentSession.app,
          category: currentSession.category,
          minutes: deltaMin,
        });
        currentSession._lastBucketWriteAt = now;
      } catch { /* non-fatal */ }
    }

    // Distraction drift: after 15 min on a distraction app, remind the user
    // what today is actually for (their top open task) — once per session.
    if (
      category === 'distraction' &&
      mins >= DISTRACT_NUDGE_MIN &&
      distractNudgedFor !== currentSession.startedAt
    ) {
      distractNudgedFor = currentSession.startedAt;
      let agenda = '';
      try {
        const open = (db.listTasks?.({ kind: 'task', completed: false }) || [])
          .sort((a, b) => (a.priority || 3) - (b.priority || 3));
        if (open[0]) agenda = ` Today's agenda: ${open[0].title}.`;
      } catch { /* agenda is decoration */ }
      sendRendererEvent('activity:nudge', {
        app, title, category, minutes: mins,
        message: `${mins} min on ${app} — that's a distraction.${agenda}`,
      });
    }

    // Soft nudge if we've been in the same session for >= NUDGE_AFTER_MIN min
    // (never for the idle lane — nobody's there to read it).
    if (mins >= NUDGE_AFTER_MIN && nudgedFor !== currentSession.startedAt && currentSession.app !== IDLE_APP) {
      nudgedFor = currentSession.startedAt;
      sendRendererEvent('activity:nudge', {
        app, title, category, minutes: mins,
        message: `You've been on ${app} for ${mins} min — take a 5-min break?`,
      });
    }
  }
}

function rollover(now) {
  if (!currentSession) return;
  const started = new Date(currentSession.startedAt);
  const ended = new Date(currentSession.lastTickAt || now);
  const mins = Math.max(1, Math.round((ended - started) / 60000));
  if (mins >= 1) {
    // Upsert — checkpoints during tick() may already have inserted a row
    // keyed on started_at; rollover gives it its final ended_at + minutes.
    db.upsertActivitySession({
      date: toIsoDate(started),
      source: 'desktop',
      app: currentSession.app,
      window_title: currentSession.title,
      category: currentSession.category,
      started_at: started.toISOString(),
      ended_at: ended.toISOString(),
      minutes: mins,
    });
    sendRendererEvent('activity:sessionEnded', { app: currentSession.app, minutes: mins, category: currentSession.category });
  }
  currentSession = null;
  nudgedFor = null;
  distractNudgedFor = null;
}

function start(send) {
  if (timer) return { ok: true, already: true };
  emitter = send;
  // Kick off an immediate tick so the current foreground window is recorded
  // right away — otherwise the user sees "nothing tracked" for the first 30s.
  tick().catch(() => {});
  timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
  db.setSetting('activity.tracking', '1');
  return { ok: true };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  rollover(Date.now());
  // Finalise all presence sessions so their final ended_at is correct
  // and their rows aren't left mid-flight in activity_sessions.
  const now = Date.now();
  for (const s of presenceSessions.values()) finalisePresenceSession(s, now);
  presenceSessions.clear();
  db.setSetting('activity.tracking', '0');
  return { ok: true };
}

function status() {
  const running = !!timer;
  const current = currentSession ? {
    app: currentSession.app,
    title: currentSession.title,
    category: currentSession.category,
    startedAt: new Date(currentSession.startedAt).toISOString(),
    minutes: Math.round((Date.now() - currentSession.startedAt) / 60000),
  } : null;

  // Most recent finished desktop session, so the UI can still show what the
  // user was doing after they stop the tracker.
  let last = null;
  try {
    const row = db
      ._db()
      .prepare(
        `SELECT app, category, minutes, started_at, ended_at
         FROM activity_sessions
         WHERE source = 'desktop' AND ended_at IS NOT NULL
         ORDER BY ended_at DESC LIMIT 1`,
      )
      .get();
    if (row) last = row;
  } catch { /* table may not exist on very first run */ }

  // Today's desktop totals (minutes + top-category), also useful post-stop.
  let todayDesktop = { minutes: 0, topCategory: null };
  try {
    const rows = db
      ._db()
      .prepare(
        `SELECT category, SUM(minutes) AS mins
         FROM activity_sessions
         WHERE source = 'desktop' AND date = date('now','localtime')
         GROUP BY category ORDER BY mins DESC`,
      )
      .all();
    todayDesktop.minutes = rows.reduce((s, r) => s + (r.mins || 0), 0);
    todayDesktop.topCategory = rows[0]?.category || null;
  } catch {}

  return { running, current, last, todayDesktop, lastError: lastPsError };
}

async function currentWindow() {
  const fg = await getForegroundWindow();
  if (!fg || !fg.exe || isSystemProcess(fg.exe)) return null;
  const app = String(fg.exe);
  const title = fg.title || "";
  return {
    app,
    title,
    category: inferCategory(app, title),
  };
}

function toIsoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sendRendererEvent(channel, payload) {
  if (emitter) { try { emitter(channel, payload); } catch {} return; }
  // Fallback: broadcast to all windows
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    }
  } catch {}
}

module.exports = { start, stop, status, tick, inferCategory, currentWindow, getVisibleWindows };
