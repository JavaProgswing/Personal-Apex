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

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db.cjs");
const routine = require("./routine.cjs");

const ADB_CANDIDATES = [
  "%LOCALAPPDATA%\\Android\\Sdk\\platform-tools\\adb.exe",
  "C:\\Program Files (x86)\\Minimal ADB and Fastboot\\adb.exe",
  "C:\\Program Files\\Android\\platform-tools\\adb.exe",
  "C:\\platform-tools\\adb.exe",
];

function expandEnv(input) {
  return String(input || "").replace(/%([^%]+)%/g, (_m, name) => process.env[name] || "");
}

function stripOuterQuotes(input) {
  let value = String(input || "").trim();
  while (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function candidateFiles(raw) {
  const value = stripOuterQuotes(expandEnv(raw));
  if (!value) return [];
  const list = [value];
  const looksLikeDir =
    /[\\/]$/.test(value) ||
    !/\.(exe|cmd|bat)$/i.test(path.basename(value));
  if (looksLikeDir) {
    list.push(path.join(value, "adb.exe"));
    list.push(path.join(value, "platform-tools", "adb.exe"));
  }
  return list;
}

function resolveAdb() {
  const configuredRaw = String(db.getSetting("wellbeing.adbPath") || "").trim();
  const attempted = [];
  const add = (value, source) => {
    for (const file of candidateFiles(value)) {
      if (!file || attempted.some((x) => x.path === file)) continue;
      attempted.push({ path: file, source, exists: fs.existsSync(file) });
    }
  };

  if (configuredRaw) add(configuredRaw, "configured");
  if (process.env.ADB_PATH) add(process.env.ADB_PATH, "ADB_PATH");
  if (process.env.ANDROID_HOME) add(path.join(process.env.ANDROID_HOME, "platform-tools", "adb.exe"), "ANDROID_HOME");
  if (process.env.ANDROID_SDK_ROOT) add(path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", "adb.exe"), "ANDROID_SDK_ROOT");
  for (const candidate of ADB_CANDIDATES) add(candidate, "auto");

  const found = attempted.find((item) => item.exists);
  if (found) {
    return {
      command: found.path,
      source: found.source,
      configured: configuredRaw,
      attempted,
      viaPath: false,
    };
  }

  return {
    command: "adb",
    source: configuredRaw ? "path-fallback-after-configured-miss" : "PATH",
    configured: configuredRaw,
    attempted,
    viaPath: true,
  };
}

function runAdb(args, timeoutMs = 20_000) {
  const adb = resolveAdb();
  return new Promise((resolve, reject) => {
    execFile(
      adb.command,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          err.stdout = stdout;
          err.adb = adb;
          return reject(err);
        }
        resolve({ stdout, stderr, adb });
      },
    );
  });
}

async function devices() {
  try {
    const { stdout } = await runAdb(["devices"]);
    const lines = stdout
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith("List of"));
    return lines
      .map((l) => {
        const [serial, state] = l.trim().split(/\s+/);
        return { serial, state };
      })
      .filter((d) => d.serial && d.state === "device");
  } catch (err) {
    console.log("[wellbeing] adb devices failed:", err.message);
    return [];
  }
}

async function diagnose() {
  const adb = resolveAdb();
  try {
    const { stdout, stderr } = await runAdb(["devices", "-l"], 12_000);
    const rows = parseDevices(stdout);
    return {
      ok: true,
      adb,
      stdout,
      stderr,
      devices: rows,
      authorized: rows.filter((d) => d.state === "device"),
    };
  } catch (err) {
    return {
      ok: false,
      adb: err.adb || adb,
      error: err.stderr || err.message,
      stdout: err.stdout || "",
      devices: [],
      authorized: [],
    };
  }
}

function parseDevices(out) {
  return out
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("List of"))
    .map((l) => {
      const parts = l.trim().split(/\s+/);
      const serial = parts.shift();
      const state = parts.shift();
      return {
        serial,
        state,
        detail: parts.join(" "),
      };
    })
    .filter((d) => d.serial);
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
    "com.amazon.avod.thirdpartyclient": "Prime Video",
    "com.instagram.barcelona": "Threads",
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
    /whatsapp|instagram|twitter|reddit|tiktok|snapchat|youtube|netflix|hotstar|discord|telegram|facebook|avod|primevideo|disney|jiocinema|crunchyroll|barcelona/i;
  if (distractions.test(pkg)) return "distraction";
  const leisure = /spotify|music|audible|kindle|books|podcast/i;
  if (leisure.test(pkg)) return "leisure";
  const productive =
    /code|editor|ide|email|mail|calendar|drive|notion|obsidian/i;
  if (productive.test(pkg)) return "productive";
  return "mobile";
}

// Discover the date range covered by the dumpsys log so we can bucket
// per-day. Returns { firstMs, lastMs } in local time. Falls back to the
// last 7 days if no usable timestamps were found.
function _dumpDateRange(dump) {
  const lines = dump.split(/\r?\n/);
  let first = null, last = null;
  for (const l of lines) {
    const m = l.match(/time="([^"]+)"/);
    if (!m) continue;
    const t = new Date(m[1].replace(" ", "T")).getTime();
    if (!Number.isFinite(t)) continue;
    if (first == null || t < first) first = t;
    if (last == null || t > last) last = t;
  }
  if (first == null) {
    last = Date.now();
    first = last - 7 * 86400_000;
  }
  return { firstMs: first, lastMs: last };
}

function _isoDateLocal(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function _startOfDayLocal(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
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
    const result = await runAdb(["shell", "dumpsys", "usagestats"]);
    dump = result.stdout;
  } catch (err) {
    return {
      ok: false,
      error: "adb dumpsys failed: " + (err.stderr || err.message),
      adb: err.adb || resolveAdb(),
    };
  }

  // The dump carries multi-day events. Bucket per package per day so
  // selecting yesterday in Top apps still shows mobile data — the old
  // implementation only kept today's slice and threw the rest away.
  const range = _dumpDateRange(dump);
  const today = new Date();
  const todayStart = startOfTodayLocal();
  const now = Date.now();

  // Window we'll consider — earliest of (first event, today - 14d) up to now.
  const horizonMs = Math.max(range.firstMs, todayStart - 14 * 86400_000);
  const endMs = Math.min(range.lastMs, now);

  // Walk day-by-day, calling parseUsagestats with that day's window.
  const perDay = []; // [{ date, pkgs: [{package, minutes}], totalMin }]
  const datesWritten = new Set();
  let cursor = _startOfDayLocal(horizonMs);
  const lastCursor = _startOfDayLocal(endMs);
  // Hard cap to avoid runaway loops if timestamps are bogus.
  const MAX_DAYS = 30;
  let safety = 0;
  while (cursor <= lastCursor && safety++ < MAX_DAYS) {
    const dayStart = cursor;
    const dayEnd = cursor + 86400_000;
    const pkgs = parseUsagestats(dump, dayStart, Math.min(dayEnd, now));
    if (pkgs.length > 0) {
      perDay.push({
        date: _isoDateLocal(dayStart),
        pkgs,
        totalMin: pkgs.reduce((s, p) => s + p.minutes, 0),
      });
    }
    cursor += 86400_000;
  }

  if (perDay.length === 0) {
    return {
      ok: false,
      error:
        "No usage data found in dumpsys. On some devices you must grant " +
        "PACKAGE_USAGE_STATS via `adb shell pm grant`, or dumpsys hasn't " +
        "rolled over since boot.",
    };
  }

  // Write per-day rows. Replace existing mobile rows for each day we have
  // fresh data for — dumpsys is authoritative within its window.
  const dbh = db._db();
  const wipe = dbh.prepare(
    `DELETE FROM activity_sessions WHERE date = ? AND source = 'mobile'`,
  );
  const tx = dbh.transaction((days) => {
    for (const day of days) {
      wipe.run(day.date);
      for (const p of day.pkgs) {
        db.addActivitySession({
          date: day.date,
          source: "mobile",
          app: humanizePackage(p.package),
          window_title: p.package,
          category: inferCategory(p.package),
          started_at: null,
          ended_at: null,
          minutes: p.minutes,
        });
        datesWritten.add(day.date);
      }
    }
  });
  tx(perDay);
  db.setSetting("wellbeing.lastSyncAt", new Date().toISOString());

  // Backwards-compatible response shape: `count`/`total_minutes`/`top`
  // describe TODAY (which is what the dashboard cared about), while the
  // new `days` array tells the UI exactly which dates got refreshed.
  const todayIso = _isoDateLocal(todayStart);
  const todayPkgs =
    perDay.find((d) => d.date === todayIso)?.pkgs || [];
  return {
    ok: true,
    device: devs[0].serial,
    count: todayPkgs.length,
    total_minutes: todayPkgs.reduce((s, p) => s + p.minutes, 0),
    window: { start: new Date(horizonMs).toISOString(), end: new Date(endMs).toISOString() },
    days: perDay.map((d) => ({ date: d.date, count: d.pkgs.length, total_minutes: d.totalMin })),
    daysWritten: datesWritten.size,
    top: todayPkgs
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 10)
      .map((p) => ({
        app: humanizePackage(p.package),
        minutes: p.minutes,
        category: inferCategory(p.package),
      })),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Cloud pull — the "no USB needed" path. The Android app pushes its Digital
// Wellbeing usage to the shared sync API; the desktop pulls it back here and
// writes the same activity_sessions(source='mobile') rows the ADB importer
// produces. Credentials (apiBase + device token) are shared with the routine
// guard, so a single desktop pairing covers both.
// ────────────────────────────────────────────────────────────────────────────
function _isoDateToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function cloudConfigured() {
  const cfg = routine.getConfig();
  return {
    paired: !!(cfg.apiBase && cfg.deviceToken),
    apiBase: cfg.apiBase || "",
    auto: db.getSetting("wellbeing.cloud.auto") === "1",
    lastSyncAt: db.getSetting("wellbeing.cloud.lastSyncAt") || null,
    lastError: db.getSetting("wellbeing.cloud.lastError") || null,
  };
}

async function pullFromCloud({ since } = {}) {
  const cfg = routine.getConfig();
  const base = String(cfg.apiBase || "").trim().replace(/\/+$/, "");
  const token = String(cfg.deviceToken || "").trim();
  if (!base || !token) return { ok: false, error: "cloud-not-paired" };

  let body;
  try {
    const url = new URL(base + "/sync/pull");
    if (since) url.searchParams.set("since", since);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
  } catch (err) {
    db.setSetting("wellbeing.cloud.lastError", err.message);
    return { ok: false, error: err.message };
  }

  // ── Task round-trip ───────────────────────────────────────────────────
  // The phone can complete desktop tasks and quick-add its own. Cloud ids:
  //   desktop-task-<n>  → completion flows back onto local task n
  //   anything else     → phone-created; imported once (mapping kept in
  //                       settings key cloudtask.map.<cloudId>)
  const taskStats = { completed: 0, imported: 0 };
  try {
    for (const t of Array.isArray(body.tasks) ? body.tasks : []) {
      if (!t || !t.id || !t.title) continue;
      const desktopMatch = /^desktop-task-(\d+)$/.exec(t.id);
      if (desktopMatch) {
        if (t.status === "done") {
          const local = db._db()
            .prepare("SELECT id, completed FROM tasks WHERE id = ?")
            .get(Number(desktopMatch[1]));
          if (local && !local.completed) {
            db.toggleTask(local.id);
            taskStats.completed += 1;
          }
        }
        continue;
      }
      if (t.source !== "mobile" && t.source !== "web") continue; // ignore other agents' rows
      const mapKey = "cloudtask.map." + t.id;
      const mappedId = db.getSetting(mapKey);
      if (!mappedId) {
        const row = db.createTask({
          title: t.title,
          deadline: t.due_at || null,
          category: t.payload?.category || "Personal",
          priority: t.payload?.priority || 3,
          tags: [t.source],
          kind: "task",
          source: t.source,
        });
        db.setSetting(mapKey, String(row.id));
        taskStats.imported += 1;
        if (t.status === "done") db.toggleTask(row.id);
      } else if (t.status === "done") {
        const local = db._db()
          .prepare("SELECT id, completed FROM tasks WHERE id = ?")
          .get(Number(mappedId));
        if (local && !local.completed) {
          db.toggleTask(local.id);
          taskStats.completed += 1;
        }
      }
    }
  } catch { /* task import is best-effort; usage import continues */ }

  // ── Phone notes → desktop Day Notes ───────────────────────────────────
  // Phone capture should land where the desktop already reviews the day. We
  // append once per cloud note using a marker so repeated sync pulls are safe.
  const noteStats = { imported: 0 };
  try {
    for (const n of Array.isArray(body.notes) ? body.notes : []) {
      if (!n || !n.id || !n.date || !String(n.body || "").trim()) continue;
      if (n.source && n.source !== "mobile" && n.source !== "web") continue;
      const mapKey = "cloudnote.map." + n.id;
      if (db.getSetting(mapKey)) continue;

      const date = String(n.date).slice(0, 10);
      const marker = `<!-- apex-mobile-note:${n.id} -->`;
      const existing = db.getDayNote(date);
      const existingBody = String(existing?.body || "");
      if (existingBody.includes(marker)) {
        db.setSetting(mapKey, date);
        continue;
      }

      const from = n.source === "web" ? "Web" : "Phone";
      const title = String(n.title || `${from} note`).trim().slice(0, 120);
      const at = String(n.updated_at || n.created_at || "").slice(11, 16);
      const header = at ? `[${from} ${at}] ${title}` : `[${from}] ${title}`;
      const addition = `${marker}\n${header}\n${String(n.body || "").trim()}`;
      db.upsertDayNote({
        date,
        body: existingBody.trim()
          ? `${existingBody.trimEnd()}\n\n${addition}`
          : addition,
        isPrivate: existing?.private !== 0,
      });
      db.setSetting(mapKey, date);
      noteStats.imported += 1;
    }
  } catch { /* note import is best-effort; usage import continues */ }

  // ── Routine adoption ──────────────────────────────────────────────────
  // The phone can edit wake/sleep with its clock pickers. Those edits are
  // tagged lastEditedBy:'mobile'; adopt them into the desktop config so the
  // desktop's next push doesn't overwrite them.
  try {
    const r = await fetch(base + "/routine/today", {
      headers: { Authorization: `Bearer ${token}` },
    }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    const pl = r?.payload || {};
    if (pl.lastEditedBy === "mobile" && pl.editedAt) {
      const applied = db.getSetting("routine.mobileEditApplied") || "";
      if (pl.editedAt > applied && (r.wake_time || r.sleep_time)) {
        routine.saveConfig({
          ...(r.wake_time ? { wakeTime: r.wake_time } : {}),
          ...(r.sleep_time ? { sleepTime: r.sleep_time } : {}),
        });
        db.setSetting("routine.mobileEditApplied", pl.editedAt);
      }
    }
  } catch { /* best-effort */ }

  // ── Routine-event adoption ────────────────────────────────────────────
  // "I'm awake ✓" / "Going to bed ✓" pressed on the phone's alarm become
  // local routine_events, which silences the desktop's own nudges. The first
  // wake_done import of the day is surfaced so main can fire a morning brief.
  let wokeUp = false;
  try {
    const todayIso = _isoDateToday();
    for (const ev of Array.isArray(body.events) ? body.events : []) {
      if (ev?.kind !== "wake_done" && ev?.kind !== "sleep_done") continue;
      const evDate = ev.date ? ev.date : (ev.at ? _isoDateLocal(new Date(ev.at).getTime()) : todayIso);
      if (evDate !== todayIso) continue;
      const seenKey = `routine.phoneEvent.${ev.kind}.${todayIso}`;
      if (db.getSetting(seenKey)) continue;
      db.setSetting(seenKey, ev.at || new Date().toISOString());
      const already = db
        ._db()
        .prepare(`SELECT 1 FROM routine_events WHERE date = ? AND kind = ? LIMIT 1`)
        .get(todayIso, ev.kind);
      if (!already) routine.logEvent(ev.kind, { source: "mobile", at: ev.at, date: todayIso });
      if (ev.kind === "wake_done") wokeUp = true;
    }
  } catch { /* best-effort */ }

  // OS plumbing the phone may have synced before it learned to filter:
  // launchers, system UI, IMEs, OEM service shims. Never count these.
  // NB: com.amazon.avod.thirdpartyclient is Prime Video — looks like a
  // service shim but is a real streaming app; keep it.
  const JUNK_PKG_RX = /^(android|com\.android\.systemui)$|launcher|trichrome|webview|inputmethod|packageinstaller|permissioncontroller|com\.(oplus|coloros|heytap|miui)\./i;

  const wellbeing = Array.isArray(body.wellbeing) ? body.wellbeing : [];
  // Group by date → package, keeping the MAX minutes per (date, package).
  // The phone reports a running daily total each sync, so taking the max
  // (rather than summing) is correct even if the same day was pushed twice.
  const byDate = new Map();
  for (const w of wellbeing) {
    const date = w.date;
    if (!date) continue;
    const pkg = w.package_name || w.window_title || "unknown";
    if (JUNK_PKG_RX.test(pkg)) continue; // drops "android 1h 57m" & friends
    const minutes = Math.round(Number(w.minutes) || 0);
    if (minutes <= 0) continue;
    if (!byDate.has(date)) byDate.set(date, new Map());
    const m = byDate.get(date);
    const prev = m.get(pkg);
    if (!prev || minutes > prev.minutes) {
      m.set(pkg, {
        minutes,
        appName: w.app_name || humanizePackage(pkg),
        phoneCategory: w.category || null,
        started_at: w.started_at || null,
        ended_at: w.ended_at || null,
      });
    }
  }

  if (byDate.size === 0) {
    db.setSetting("wellbeing.cloud.lastSyncAt", new Date().toISOString());
    db.setSetting("wellbeing.cloud.lastError", "");
    return { ok: true, days: [], daysWritten: 0, count: 0, total_minutes: 0, top: [], tasks: taskStats, notes: noteStats, note: "no-mobile-data" };
  }

  const dbh = db._db();
  const wipe = dbh.prepare(
    `DELETE FROM activity_sessions WHERE date = ? AND source = 'mobile'`,
  );
  const days = [];
  const tx = dbh.transaction((entries) => {
    for (const [date, pkgs] of entries) {
      wipe.run(date);
      let total = 0;
      for (const [pkg, info] of pkgs) {
        // Honour a user override first; else the desktop pattern; else the
        // category the phone inferred; else the generic 'mobile' bucket.
        const hasOverride = !!db.getSetting("activity.overrides." + pkg.toLowerCase());
        const desktopCat = inferCategory(pkg);
        const category = hasOverride
          ? desktopCat
          : desktopCat !== "mobile"
            ? desktopCat
            : info.phoneCategory || "mobile";
        db.addActivitySession({
          date,
          source: "mobile",
          app: info.appName,
          window_title: pkg,
          category,
          started_at: info.started_at,
          ended_at: info.ended_at,
          minutes: info.minutes,
        });
        total += info.minutes;
      }
      days.push({ date, count: pkgs.size, total_minutes: total });
    }
  });
  tx([...byDate.entries()]);
  db.setSetting("wellbeing.cloud.lastSyncAt", new Date().toISOString());
  db.setSetting("wellbeing.cloud.lastError", "");
  // Mirror legacy ADB key too so existing "last sync" displays update.
  db.setSetting("wellbeing.lastSyncAt", new Date().toISOString());

  const todayIso = _isoDateToday();
  const today = byDate.get(todayIso);
  const todayPkgs = today
    ? [...today.entries()].map(([pkg, info]) => ({
        app: info.appName,
        minutes: info.minutes,
        category: inferCategory(pkg) !== "mobile" ? inferCategory(pkg) : info.phoneCategory || "mobile",
      }))
    : [];
  return {
    ok: true,
    source: "cloud",
    tasks: taskStats,
    notes: noteStats,
    wokeUp,
    days,
    daysWritten: days.length,
    count: todayPkgs.length,
    total_minutes: todayPkgs.reduce((s, p) => s + p.minutes, 0),
    top: todayPkgs.sort((a, b) => b.minutes - a.minutes).slice(0, 10),
  };
}

module.exports = { syncNow, devices, diagnose, pullFromCloud, cloudConfigured };
