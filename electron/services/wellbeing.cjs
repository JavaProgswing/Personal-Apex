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
//   package=com.whatsapp totalTimeUsed="3h 12m"  lastTimeUsed="..."
// We sum totalTimeUsed across the last 24h window.
function parseUsagestats(dump) {
  const lines = dump.split(/\r?\n/);

  const active = new Map(); // pkg -> start timestamp (ms)
  const usage = new Map(); // pkg -> total ms

  function parseTime(str) {
    // "2026-04-19 18:26:47"
    return new Date(str.replace(" ", "T")).getTime();
  }

  for (const l of lines) {
    // Extract fields
    const timeMatch = l.match(/time="([^"]+)"/);
    const typeMatch = l.match(/type=([A-Z_]+)/);
    const pkgMatch = l.match(/package=([\w.]+)/);

    if (!timeMatch || !typeMatch || !pkgMatch) continue;

    const time = parseTime(timeMatch[1]);
    const type = typeMatch[1];
    const pkg = pkgMatch[1];

    // --- CORE LOGIC ---

    if (type === "ACTIVITY_RESUMED") {
      // Start tracking (overwrite if already active)
      active.set(pkg, time);
    } else if (type === "ACTIVITY_PAUSED" || type === "ACTIVITY_STOPPED") {
      if (active.has(pkg)) {
        const start = active.get(pkg);
        const duration = time - start;

        if (duration > 0) {
          usage.set(pkg, (usage.get(pkg) || 0) + duration);
        }

        active.delete(pkg);
      }
    }

    // Ignore everything else:
    // FOREGROUND_SERVICE, NOTIFICATION, USER_INTERACTION, etc.
  }

  // --- HANDLE APPS STILL ACTIVE AT END ---
  const endTime = getLastTimestamp(lines);

  for (const [pkg, start] of active.entries()) {
    const duration = endTime - start;
    if (duration > 0) {
      usage.set(pkg, (usage.get(pkg) || 0) + duration);
    }
  }

  // --- CONVERT TO MINUTES ---
  return [...usage.entries()]
    .map(([pkg, ms]) => ({
      package: pkg,
      minutes: Math.round(ms / 60000),
    }))
    .filter((x) => x.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes);
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
  const overrides = db.getSetting("wellbeing.overrides." + pkg);
  if (overrides) return overrides;
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
  const pkgs = parseUsagestats(dump);
  if (pkgs.length === 0)
    return {
      ok: false,
      error:
        "No usage data parsed. On some devices you must grant PACKAGE_USAGE_STATS via `adb shell pm grant`.",
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
