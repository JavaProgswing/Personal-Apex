// Apex — mobile Digital Wellbeing import via ADB.
//
// How it works:
//   1. User connects their Android phone over USB with USB Debugging enabled.
//   2. User runs `adb devices` once to authorize.
//   3. Apex shells out to `adb shell dumpsys usagestats` and parses the block
//      at the top showing per-package total time in the foreground over the
//      last 24 hours.
//   4. Each package becomes an activity_sessions row with source='mobile'
//      and category='mobile' (or a user override via settings).
//
// Windows-only setup: user installs adb (platform-tools) and adds it to PATH.
// The path to adb can be overridden via settings key 'wellbeing.adbPath'.

const { exec } = require("node:child_process");
const db = require("./db.cjs");

function adbCmd() {
  return db.getSetting("wellbeing.adbPath") || "adb";
}

function run(cmd, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        resolve(stdout);
      },
    );
  });
}

async function devices() {
  try {
    const out = await run(`"${adbCmd()}" devices`);
    const lines = out
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("List of"));
    return lines
      .map((l) => {
        const [serial, state] = l.trim().split(/\s+/);
        return { serial, state };
      })
      .filter((d) => d.serial && d.state === "device");
  } catch (err) {
    console.log(err);
    return [];
  }
}

// Parse the "Usage stats for user 0" section of `dumpsys usagestats`.
// Lines look like:
//   time="2026-04-24 01:03:10" type=ACTIVITY_RESUMED package=com.whatsapp
//
// Sums per-package foreground time, optionally clipped to a [windowStart,
// windowEnd] range. Sessions that span the window boundary are split so only
// the portion inside the window is counted — this is what fixes the
// "Instagram 2h at 01:04" bug where yesterday's evening usage was being
// attributed to today.
function parseUsagestats(dump, windowStart = -Infinity, windowEnd = Infinity) {
  const lines = dump.split(/\r?\n/);

  const active = new Map(); // pkg -> start timestamp (ms)
  const usage = new Map(); // pkg -> total ms

  function parseTime(str) {
    // "2026-04-19 18:26:47" — treat as local time (no trailing Z).
    return new Date(str.replace(" ", "T")).getTime();
  }

  // Credit `pkg` for overlap of [start, end] with the window.
  function credit(pkg, start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const a = Math.max(start, windowStart);
    const b = Math.min(end, windowEnd);
    const dur = b - a;
    if (dur > 0) usage.set(pkg, (usage.get(pkg) || 0) + dur);
  }

  for (const l of lines) {
    const timeMatch = l.match(/time="([^"]+)"/);
    const typeMatch = l.match(/type=([A-Z_]+)/);
    const pkgMatch = l.match(/package=([\w.]+)/);

    if (!timeMatch || !typeMatch || !pkgMatch) continue;

    const time = parseTime(timeMatch[1]);
    const type = typeMatch[1];
    const pkg = pkgMatch[1];

    if (type === "ACTIVITY_RESUMED") {
      // If another resume fires without a pause, close the previous one at
      // this time so we don't double-count or drop a session.
      if (active.has(pkg)) credit(pkg, active.get(pkg), time);
      active.set(pkg, time);
    } else if (type === "ACTIVITY_PAUSED" || type === "ACTIVITY_STOPPED") {
      if (active.has(pkg)) {
        credit(pkg, active.get(pkg), time);
        active.delete(pkg);
      }
    }
  }

  // Apps still "active" at end of log: close at min(now, windowEnd, lastLog).
  const lastLog = getLastTimestamp(lines);
  const now = Date.now();
  const endTime = Math.min(now, windowEnd, Math.max(lastLog, now));
  for (const [pkg, start] of active.entries()) credit(pkg, start, endTime);

  return [...usage.entries()]
    .map(([pkg, ms]) => ({
      package: pkg,
      minutes: Math.round(ms / 60000),
    }))
    .filter((x) => x.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
}

// Start of today in local time, as a unix ms timestamp.
function startOfTodayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Helper: get last timestamp in file
function getLastTimestamp(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/time="([^"]+)"/);
    if (m) {
      return new Date(m[1].replace(" ", "T")).getTime();
    }
  }
  return Date.now();
}

function humanizePackage(pkg) {
  const map = {
    "com.whatsapp": "WhatsApp",
    "com.instagram.android": "Instagram",
    "com.twitter.android": "Twitter",
    "com.reddit.frontpage": "Reddit",
    "com.google.android.youtube": "YouTube",
    "com.spotify.music": "Spotify",
    "com.netflix.mediaclient": "Netflix",
    "com.discord": "Discord",
    "org.telegram.messenger": "Telegram",
    "in.startv.hotstar": "Hotstar",
  };
  if (map[pkg]) return map[pkg];
  const tail = pkg.split(".").pop();
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

function inferCategory(pkg) {
  // Unified override namespace with the desktop tracker: clicking the
  // category chip in Top apps writes `activity.overrides.<lowercased>`,
  // and we read the same key here so a single override works across both
  // desktop and mobile data sources. Legacy `wellbeing.overrides.*` is
  // still honoured for users with old data, but the new flow uses
  // `activity.overrides.*`.
  const lower = (pkg || "").toLowerCase();
  const newKey = db.getSetting("activity.overrides." + lower);
  if (newKey) return newKey;
  const legacy = db.getSetting("wellbeing.overrides." + pkg);
  if (legacy) return legacy;
  const distractions =
    /whatsapp|instagram|twitter|reddit|tiktok|snapchat|youtube|netflix|hotstar|discord|telegram|facebook/i;
  if (distractions.test(pkg)) return "distraction";
  const leisure = /spotify|music|audible|kindle|books|podcast/i;
  if (leisure.test(pkg)) return "leisure";
  const productive =
    /code|editor|ide|email|mail|calendar|drive|notion|obsidian/i;
  if (productive.test(pkg)) return "productive";
  return "mobile";
}

async function syncNow() {
  const devs = await devices();
  if (devs.length === 0) {
    return {
      ok: false,
      error: "No Android device detected. Run `adb devices` and authorize.",
    };
  }
  let dump;
  try {
    dump = await run(`"${adbCmd()}" shell dumpsys usagestats`);
  } catch (err) {
    return {
      ok: false,
      error: "adb dumpsys failed: " + (err.stderr || err.message),
    };
  }
  // Clip to today's local window so events from yesterday evening don't
  // leak into today's totals after midnight.
  const todayStart = startOfTodayLocal();
  const now = Date.now();
  const pkgs = parseUsagestats(dump, todayStart, now);
  if (pkgs.length === 0)
    return {
      ok: false,
      error:
        "No usage data for today yet. On some devices you must grant PACKAGE_USAGE_STATS via `adb shell pm grant`, or dumpsys hasn't rolled over since midnight.",
    };

  // Wipe today's mobile sessions and re-insert — we treat dumpsys as authoritative.
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  db._db()
    .prepare(
      `DELETE FROM activity_sessions WHERE date = ? AND source = 'mobile'`,
    )
    .run(iso);
  for (const p of pkgs) {
    db.addActivitySession({
      date: iso,
      source: "mobile",
      app: humanizePackage(p.package),
      window_title: p.package,
      category: inferCategory(p.package),
      started_at: null,
      ended_at: null,
      minutes: p.minutes,
    });
  }
  db.setSetting("wellbeing.lastSyncAt", new Date().toISOString());
  return {
    ok: true,
    device: devs[0].serial,
    count: pkgs.length,
    total_minutes: pkgs.reduce((s, p) => s + p.minutes, 0),
    window: { start: new Date(todayStart).toISOString(), end: new Date(now).toISOString() },
    top: pkgs
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 10)
      .map((p) => ({
        app: humanizePackage(p.package),
        minutes: p.minutes,
        category: inferCategory(p.package),
      })),
  };
}

module.exports = { syncNow, devices };
