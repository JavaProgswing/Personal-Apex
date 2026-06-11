// Apex routine guard.
//
// Stores a small daily routine config in settings, writes auditable events to
// routine_events, gates window closes behind a short-lived reason approval, and
// syncs the current day to the shared FastAPI service.

const os = require("node:os");
const db = require("./db.cjs");

const KEY_CONFIG = "routine.config.v1";
const KEY_SYNC_LAST = "routine.sync.lastAt";
const KEY_SYNC_ERROR = "routine.sync.lastError";
const KEY_CLOSE_UNTIL = "routine.close.allowUntil";
const KEY_CLOSE_REASON = "routine.close.lastReason";
const KEY_USER_ARMED = "routine.userArmed.v1";
const KEY_DESKTOP_GUARD = "routine.desktopGuardEnabled.v1";
const MIN_CLOSE_REASON_CHARS = 3;
const DEFAULT_CONFIG = {
  enabled: false,
  wakeTime: "07:00",
  wakeMode: "strict",
  sleepTime: "23:30",
  sleepMode: "strict",
  objective: "",
  linkedTaskId: "",
  closeGuard: false,
  // Guard window defaults to the whole day — closes always need a reason
  // unless the user narrows the hours in Settings.
  workStart: "00:00",
  workEnd: "23:59",
  reminderEveryMinutes: 10,
  syncEnabled: false,
  apiBase: "",
  deviceToken: "",
  deviceName: `${os.hostname()} desktop`,
};

function ensureTables() {
  const handle = db._db?.();
  if (!handle) return;
  handle.exec(`
    CREATE TABLE IF NOT EXISTS routine_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      kind TEXT NOT NULL,
      at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_routine_events_date ON routine_events(date);
    CREATE INDEX IF NOT EXISTS idx_routine_events_kind ON routine_events(kind);
  `);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function getConfig() {
  const saved = safeJson(db.getSetting(KEY_CONFIG), {});
  return normalizeConfig({ ...DEFAULT_CONFIG, ...saved });
}

function normalizeConfig(input = {}) {
  const nudge = Math.max(2, Math.min(120, Math.round(+input.reminderEveryMinutes || 10)));
  return {
    ...DEFAULT_CONFIG,
    ...input,
    enabled: input.enabled !== false && input.enabled !== "0",
    wakeTime: normalizeTime(input.wakeTime, DEFAULT_CONFIG.wakeTime),
    wakeMode: input.wakeMode === "relaxed" ? "relaxed" : "strict",
    sleepTime: normalizeTime(input.sleepTime, DEFAULT_CONFIG.sleepTime),
    sleepMode: input.sleepMode === "relaxed" ? "relaxed" : "strict",
    objective: String(input.objective || "").slice(0, 500),
    linkedTaskId: input.linkedTaskId ? String(input.linkedTaskId) : "",
    closeGuard: input.closeGuard !== false && input.closeGuard !== "0",
    workStart: normalizeTime(input.workStart, DEFAULT_CONFIG.workStart),
    workEnd: normalizeTime(input.workEnd, DEFAULT_CONFIG.workEnd),
    reminderEveryMinutes: nudge,
    syncEnabled: input.syncEnabled === true || input.syncEnabled === "1",
    apiBase: String(input.apiBase || "").trim().replace(/\/+$/, ""),
    deviceToken: String(input.deviceToken || "").trim(),
    deviceName: String(input.deviceName || DEFAULT_CONFIG.deviceName).trim().slice(0, 80),
  };
}

function normalizeTime(value, fallback) {
  const v = String(value || "").trim();
  if (/^\d{2}:\d{2}$/.test(v)) return v;
  if (/^\d{1}:\d{2}$/.test(v)) return `0${v}`;
  return fallback;
}

function saveConfig(patch = {}) {
  const next = normalizeConfig({ ...getConfig(), ...patch });
  db.setSetting(KEY_CONFIG, JSON.stringify(next));
  if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
    db.setSetting(KEY_USER_ARMED, next.enabled ? "1" : "0");
  } else if (
    next.enabled &&
    (String(next.objective || "").trim() || next.linkedTaskId || next.syncEnabled)
  ) {
    db.setSetting(KEY_USER_ARMED, "1");
  }
  return next;
}

function eventRowToObject(row) {
  return {
    ...row,
    payload: safeJson(row.payload, {}),
  };
}

function logEvent(kind, payload = {}) {
  ensureTables();
  const date = payload.date || today();
  const at = payload.at || nowIso();
  const info = db._db().prepare(
    `INSERT INTO routine_events (date, kind, at, payload) VALUES (?, ?, ?, ?)`,
  ).run(date, kind, at, JSON.stringify(payload || {}));
  return eventRowToObject(
    db._db().prepare(`SELECT * FROM routine_events WHERE id = ?`).get(info.lastInsertRowid),
  );
}

function eventsForDate(date = today()) {
  ensureTables();
  return db._db()
    .prepare(`SELECT * FROM routine_events WHERE date = ? ORDER BY at DESC LIMIT 200`)
    .all(date)
    .map(eventRowToObject);
}

function getState() {
  const config = getConfig();
  return {
    config,
    armed: routineIsArmed(config),
    events: eventsForDate(),
    close: closeState(),
    sync: {
      lastAt: db.getSetting(KEY_SYNC_LAST),
      lastError: db.getSetting(KEY_SYNC_ERROR),
      ready: !!(config.apiBase && config.deviceToken),
    },
  };
}

function closeState() {
  const allowUntil = db.getSetting(KEY_CLOSE_UNTIL);
  const untilMs = allowUntil ? new Date(allowUntil).getTime() : 0;
  return {
    allowUntil,
    allowedNow: Number.isFinite(untilMs) && untilMs > Date.now(),
    lastReason: safeJson(db.getSetting(KEY_CLOSE_REASON), null),
  };
}

function shouldBlockClose() {
  // The close-reason gate stands on its own switch (default ON, explicit
  // opt-out in Settings) — NOT on the routine config flags, whose saved
  // defaults had silently disabled it for every existing install.
  if (!desktopRoutineGuardEnabled()) return false;
  // Only gate closes inside work hours — a 1 AM shutdown shouldn't need a
  // written justification.
  const config = getConfig();
  const nowMin = minutesNow();
  const start = parseMinutes(config.workStart);
  const end = parseMinutes(config.workEnd);
  if (start != null && end != null && (nowMin < start || nowMin > end)) return false;
  return !closeState().allowedNow;
}

function closeBlocked(payload = {}) {
  const row = logEvent("close_blocked", {
    ...payload,
    date: today(),
    at: nowIso(),
  });
  return {
    blocked: true,
    event: row,
    config: getConfig(),
  };
}

function approveCloseReason({ reason, category, ...meta } = {}) {
  const clean = String(reason || "").trim().replace(/\s+/g, " ");
  if (clean.length < MIN_CLOSE_REASON_CHARS) {
    return { ok: false, error: "reason-too-short", minLength: MIN_CLOSE_REASON_CHARS };
  }
  const allowedUntil = new Date(Date.now() + 90_000).toISOString();
  const classification = classifyCloseReason(clean, category, meta);
  const payload = {
    date: today(),
    at: nowIso(),
    reason: clean.slice(0, 500),
    category: classification.category,
    classification,
    allowUntil: allowedUntil,
    appSessionId: meta.appSessionId || meta.sessionId || null,
    appOpenAt: meta.appOpenAt || null,
    closeRequestedAt: meta.closeRequestedAt || null,
    closeApprovedAt: meta.closeApprovedAt || nowIso(),
    blockedEventId: meta.blockedEventId || null,
    source: meta.source || null,
    uptimeMs: Number.isFinite(meta.uptimeMs) ? meta.uptimeMs : null,
    foreground: meta.foreground || null,
  };
  db.setSetting(KEY_CLOSE_UNTIL, allowedUntil);
  db.setSetting(KEY_CLOSE_REASON, JSON.stringify(payload));
  const event = logEvent("close_reason", payload);
  return { ok: true, allowUntil: allowedUntil, event };
}

function classifyCloseReason(reason, category, meta = {}) {
  const text = String(`${category || ""} ${reason || ""}`).toLowerCase();
  const fg = meta.foreground || {};
  const foregroundCategory = String(fg.category || "").toLowerCase();
  const rules = [
    {
      category: "done-for-day",
      re: /\b(done|finished|complete|completed|wrapped|wrap up|logging off|offline)\b/,
      advice: "Finished intentionally.",
      confidence: 0.82,
    },
    {
      category: "sleep",
      re: /\b(sleep|bed|night|nap|tired|wind down|shutdown for the night)\b/,
      advice: "Rest exit.",
      confidence: 0.85,
    },
    {
      category: "break",
      re: /\b(break|food|eat|dinner|lunch|walk|gym|shower|outside|stretch)\b/,
      advice: "Break exit.",
      confidence: 0.78,
    },
    {
      category: "switch-device",
      re: /\b(phone|mobile|android|laptop|tablet|other device|heading out|commute)\b/,
      advice: "Device switch.",
      confidence: 0.74,
    },
    {
      category: "maintenance",
      re: /\b(restart|update|install|crash|bug|lag|hang|freeze|battery|charging|shutdown|reboot)\b/,
      advice: "System maintenance.",
      confidence: 0.84,
    },
    {
      category: "distraction-risk",
      re: /\b(scroll|doom|youtube|instagram|reddit|netflix|game|gaming|distract|procrastinat|waste)\b/,
      advice: "Distraction risk.",
      confidence: 0.86,
    },
  ];
  let hit = rules.find((r) => r.re.test(text));
  if (!hit && foregroundCategory === "distraction") {
    hit = {
      category: "distraction-risk",
      advice: "Foreground app was distracting.",
      confidence: 0.66,
    };
  }
  if (!hit && category && category !== "other") {
    hit = {
      category: String(category).slice(0, 80),
      advice: "User-selected category.",
      confidence: 0.55,
    };
  }
  const out = hit || {
    category: "other",
    advice: "Unclassified exit.",
    confidence: 0.35,
  };
  return {
    category: out.category,
    advice: out.advice,
    confidence: out.confidence,
    foregroundCategory: foregroundCategory || null,
    foregroundApp: fg.app || null,
    foregroundTitle: fg.title || null,
  };
}

function parseMinutes(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map((x) => parseInt(x, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function minutesNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function hasEvent(kind, date = today()) {
  ensureTables();
  const row = db._db()
    .prepare(`SELECT 1 FROM routine_events WHERE date = ? AND kind = ? LIMIT 1`)
    .get(date, kind);
  return !!row;
}

function nextNudge() {
  if (!desktopRoutineGuardEnabled()) return null;
  const config = getConfig();
  if (!config.enabled || !routineIsArmed(config)) return null;
  const todayKey = today();
  const nowMin = minutesNow();
  const intervalMs = config.reminderEveryMinutes * 60_000;
  const wakeDue = parseMinutes(config.wakeTime);
  const sleepDue = parseMinutes(config.sleepTime);
  const wakeItem = {
    key: "wake",
    doneKind: "wake_done",
    time: config.wakeTime,
    mode: config.wakeMode,
    title: "Wake routine",
    body: config.objective || "Start the day routine.",
  };
  const sleepItem = {
    key: "sleep",
    doneKind: "sleep_done",
    time: config.sleepTime,
    mode: config.sleepMode,
    title: "Sleep wind-down",
    body: config.objective || "Wrap up and get offline.",
  };
  const candidates = sleepDue != null && nowMin >= sleepDue
    ? [sleepItem, wakeItem]
    : [wakeItem, sleepItem];
  for (const item of candidates) {
    const due = parseMinutes(item.time);
    if (due == null || nowMin < due) continue;
    if (item.key === "wake" && wakeDue != null && sleepDue != null) {
      const wakeWindowEnd = Math.min(sleepDue, wakeDue + 240);
      if (nowMin > wakeWindowEnd) continue;
    }
    if (hasEvent(item.doneKind, todayKey)) continue;
    const lastKey = `routine.nudge.${item.key}.${todayKey}`;
    const last = db.getSetting(lastKey);
    const lastMs = last ? new Date(last).getTime() : 0;
    if (lastMs && Date.now() - lastMs < intervalMs) continue;
    db.setSetting(lastKey, nowIso());
    const event = logEvent("routine_nudge", {
      date: todayKey,
      kind: item.key,
      mode: item.mode,
      at: nowIso(),
    });
    return {
      ...item,
      event,
      strict: item.mode === "strict",
      config,
    };
  }
  return null;
}

function routineIsArmed(config = getConfig()) {
  const marker = db.getSetting(KEY_USER_ARMED);
  if (marker === "1") return true;
  if (marker === "0") return false;
  return !!(
    String(config.objective || "").trim() ||
    config.linkedTaskId ||
    config.syncEnabled ||
    config.apiBase ||
    config.deviceToken
  );
}

function desktopRoutineGuardEnabled() {
  // Default ON — only an explicit "0" (Settings toggle) disables the guard.
  return db.getSetting(KEY_DESKTOP_GUARD) !== "0";
}

function taskForSync(taskId) {
  if (!taskId) return null;
  try {
    const tasks = db.listTasks({ kind: "all" }) || [];
    return tasks.find((t) => String(t.id) === String(taskId)) || null;
  } catch {
    return null;
  }
}

// Top open tasks + recent completions, shaped for the sync API. The phone's
// Tasks tab reads these; completions flow back via wellbeing.pullFromCloud.
function tasksPayload(linkedTask) {
  let rows = [];
  try {
    const all = (db.listTasks({ kind: "task" }) || []);
    const open = all
      .filter((t) => !t.completed)
      .sort((a, b) => (a.priority || 3) - (b.priority || 3))
      .slice(0, 20);
    // Recently-completed too, so the phone list reflects checked-off items.
    const doneRecent = all
      .filter((t) => t.completed && t.completed_at &&
        Date.now() - new Date(t.completed_at).getTime() < 3 * 86400_000)
      .slice(0, 10);
    rows = [...open, ...doneRecent];
  } catch { rows = []; }
  if (linkedTask && !rows.some((t) => t.id === linkedTask.id)) rows.push(linkedTask);
  return rows.map((t) => ({
    id: `desktop-task-${t.id}`,
    title: t.title,
    status: t.completed ? "done" : "open",
    due_at: t.deadline || null,
    source: "desktop",
    payload: {
      priority: t.priority,
      category: t.category,
      course_code: t.course_code,
      recurrence: t.recurrence_rule || null,
    },
  }));
}

async function syncNow() {
  const config = getConfig();
  if (!config.syncEnabled) return { ok: false, error: "sync-disabled" };
  if (!config.apiBase || !config.deviceToken) return { ok: false, error: "sync-not-configured" };
  const date = today();
  const linkedTask = taskForSync(config.linkedTaskId);
  const routineId = `desktop-${date}`;
  const objectiveId = config.objective ? `desktop-objective-${date}` : null;
  const payload = {
    routines: [
      {
        id: routineId,
        date,
        name: "Apex daily routine",
        wake_time: config.wakeTime,
        sleep_time: config.sleepTime,
        objective_id: objectiveId,
        linked_task_id: linkedTask ? `desktop-task-${linkedTask.id}` : null,
        payload: {
          objective: config.objective,
          wakeMode: config.wakeMode,
          sleepMode: config.sleepMode,
          closeGuard: config.closeGuard,
          reminderEveryMinutes: config.reminderEveryMinutes,
          source: "desktop",
        },
      },
    ],
    objectives: objectiveId
      ? [
          {
            id: objectiveId,
            title: config.objective,
            kind: "daily",
            status: hasEvent("objective_done", date) ? "done" : "active",
            linked_task_id: linkedTask ? `desktop-task-${linkedTask.id}` : null,
            routine_id: routineId,
            due_date: date,
            payload: { source: "desktop" },
          },
        ]
      : [],
    tasks: tasksPayload(linkedTask),
    events: eventsForDate(date).map((event) => ({
      id: `desktop-routine-event-${event.id}`,
      kind: event.kind,
      at: event.at,
      payload: event.payload,
    })),
    wellbeing: [],
  };
  try {
    const res = await fetch(`${config.apiBase}/sync/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.deviceToken}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
    db.setSetting(KEY_SYNC_LAST, nowIso());
    db.setSetting(KEY_SYNC_ERROR, "");
    return { ok: true, ...body };
  } catch (err) {
    db.setSetting(KEY_SYNC_ERROR, err.message);
    return { ok: false, error: err.message };
  }
}

async function createPairingCode({ apiBase, adminToken } = {}) {
  const base = String(apiBase || getConfig().apiBase || "").trim().replace(/\/+$/, "");
  const token = String(adminToken || "").trim();
  if (!base || !token) return { ok: false, error: "api-base-and-admin-token-required" };
  try {
    const res = await fetch(`${base}/pairing-codes`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
    saveConfig({ apiBase: base });
    return { ok: true, ...body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function pairDesktop({ apiBase, code, deviceName } = {}) {
  const base = String(apiBase || getConfig().apiBase || "").trim().replace(/\/+$/, "");
  const cleanCode = String(code || "").trim();
  if (!base || !cleanCode) return { ok: false, error: "api-base-and-code-required" };
  const name = String(deviceName || getConfig().deviceName || DEFAULT_CONFIG.deviceName).trim();
  try {
    const res = await fetch(`${base}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: cleanCode,
        device_name: name,
        device_type: "desktop",
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
    const config = saveConfig({
      apiBase: body.api_base || base,
      deviceToken: body.token,
      deviceName: name,
      syncEnabled: true,
    });
    if (body.device?.id) db.setSetting("routine.deviceId", body.device.id);
    return { ok: true, config, device: body.device };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Authed fetch against the sync API using this desktop's device token.
async function apiFetch(path, options = {}) {
  const config = getConfig();
  if (!config.apiBase || !config.deviceToken) throw new Error("not-paired");
  const res = await fetch(`${config.apiBase}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.deviceToken}`,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
  return body;
}

// All paired devices (phones + this desktop), with `self` marking us.
async function listDevices() {
  try {
    const body = await apiFetch("/devices");
    // Older pairings predate the persisted device id — backfill via /me.
    let selfId = body.self || db.getSetting("routine.deviceId") || null;
    if (!selfId) {
      try { selfId = (await apiFetch("/me")).id || null; } catch { /* fine */ }
    }
    if (selfId) db.setSetting("routine.deviceId", selfId);
    return { ok: true, devices: body.devices || [], self: selfId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Unlink any paired device. Unlinking *this* desktop also clears the local
// token so the UI flips to "not paired" instead of erroring on next sync.
async function revokeDevice(deviceId) {
  try {
    const body = await apiFetch(`/devices/${deviceId}`, { method: "DELETE" });
    const selfId = db.getSetting("routine.deviceId");
    if (body.was_self || (selfId && selfId === deviceId)) {
      saveConfig({ deviceToken: "", syncEnabled: false });
      db.setSetting("routine.deviceId", "");
    }
    return { ok: true, ...body };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Publish desktop focus state (Zen mode) so the phone can mirror it with a
// mobile distraction blocker. Best-effort: never throws.
async function pushFocus({ active, title, mode, endsAt } = {}) {
  try {
    await apiFetch("/focus", {
      method: "PUT",
      body: JSON.stringify({
        active: !!active,
        title: title || null,
        mode: mode || "zen",
        ends_at: endsAt || null,
      }),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getConfig,
  saveConfig,
  getState,
  logEvent,
  eventsForDate,
  shouldBlockClose,
  closeBlocked,
  approveCloseReason,
  closeState,
  routineIsArmed,
  nextNudge,
  syncNow,
  createPairingCode,
  pairDesktop,
  listDevices,
  revokeDevice,
  pushFocus,
};
