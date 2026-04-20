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

const PS_SCRIPT = `
$sig = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
Add-Type -TypeDefinition $sig -Language CSharp
$h = [W]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 1024
[W]::GetWindowText($h, $sb, 1024) | Out-Null
$pid = 0
[W]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
try { $p = Get-Process -Id $pid -ErrorAction Stop } catch { $p = $null }
$exe = if ($p) { $p.ProcessName } else { $null }
[PSCustomObject]@{ exe = $exe; title = $sb.ToString() } | ConvertTo-Json -Compress
`;

function getForegroundWindow() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    exec(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${PS_SCRIPT.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const trimmed = stdout.trim();
          if (!trimmed) return resolve(null);
          resolve(JSON.parse(trimmed));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// Category inference. Keep it conservative; the user can override via
// Settings → Activity categories.
function inferCategory(exe, title) {
  const lower = (exe + ' ' + (title || '')).toLowerCase();
  const cat = db.getSetting('activity.overrides.' + (exe || '').toLowerCase());
  if (cat) return cat;
  const rules = [
    { cat: 'productive', re: /(code|idea64|webstorm|pycharm|clion|rider|goland|vim|emacs|cursor|sublime|neovim|atom)/ },
    { cat: 'productive', re: /(terminal|wt|windowsterminal|powershell|cmd|bash|wsl|kitty|alacritty)/ },
    { cat: 'productive', re: /(docs|sheets|slides|notion|obsidian|typora|word|excel|powerpoint)/ },
    { cat: 'productive', re: /(leetcode|codeforces|codechef|hackerrank|atcoder)/ },
    { cat: 'productive', re: /(github|gitlab|bitbucket)/ },
    { cat: 'distraction', re: /(youtube|netflix|disney|hotstar|primevideo|twitch)/ },
    { cat: 'distraction', re: /(instagram|facebook|twitter|reddit|tiktok|discord)/ },
    { cat: 'distraction', re: /(whatsapp|telegram)/ },
    { cat: 'leisure', re: /(spotify|apple music|vlc|musicbee)/ },
    { cat: 'leisure', re: /(steam|epicgameslauncher|battle\.net|riot|league|valorant|dota|minecraft)/ },
  ];
  for (const r of rules) if (r.re.test(lower)) return r.cat;
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

  // Soft nudge if we've been in the same session for >= NUDGE_AFTER_MIN min
  if (currentSession) {
    const mins = Math.round((now - currentSession.startedAt) / 60000);
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
    db.addActivitySession({
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

  return { running, current, last, todayDesktop };
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
