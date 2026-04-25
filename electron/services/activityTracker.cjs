// Apex — desktop active-window tracker.
//
// Polls the foreground window every ~30 seconds and rolls up contiguous
// same-(app,window_title) samples into a single activity_sessions row.
// Purely optional — user must toggle it on in Settings.
//
// Windows: uses PowerShell + Win32 GetForegroundWindow. We avoid bringing in
// heavy native deps (ffi / active-win) to keep the build simple.

const { BrowserWindow } = require('electron');
const { exec } = require('node:child_process');
const db = require('./db.cjs');

const POLL_MS = 30_000;
const NUDGE_AFTER_MIN = 45;   // nudge when the same app has run 45+ minutes

let timer = null;
let currentSession = null;    // { app, title, category, startedAt, lastTickAt }
let emitter = null;
let nudgedFor = null;         // the sessionId we already nudged about
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
  const rules = [
    // ── PRODUCTIVE ───────────────────────────────────────────────────
    // IDEs / editors
    { cat: 'productive', re: /(code|idea64|webstorm|pycharm|clion|rider|goland|datagrip|rubymine|phpstorm|appcode|androidstudio|xcode|vim|nvim|emacs|cursor|sublime|neovim|atom|fleet|zed)/ },
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

async function tick() {
  const now = Date.now();
  const fg = await getForegroundWindow();
  if (!fg || !fg.exe) return rollover(now); // no foreground window → rollover current session

  const app = fg.exe;
  const title = fg.title || '';
  const category = inferCategory(app, title);

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

    // Soft nudge if we've been in the same session for >= NUDGE_AFTER_MIN min
    if (mins >= NUDGE_AFTER_MIN && nudgedFor !== currentSession.startedAt) {
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

module.exports = { start, stop, status, tick, inferCategory };
