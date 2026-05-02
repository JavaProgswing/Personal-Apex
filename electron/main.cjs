// Apex — Electron main process.
// Boots a BrowserWindow, wires all IPC handlers, owns all Node-side services.

const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  dialog,
  shell,
  net,
  session,
  Notification,
  globalShortcut,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const isDev = process.env.NODE_ENV === "development";

// ---- Services (lazy-loaded so startup stays snappy) --------------------------
const db = require("./services/db.cjs");
const timetable = require("./services/timetable.cjs");
const calendar = require("./services/calendar.cjs");
const ollama = require("./services/ollama.cjs");
const github = require("./services/github.cjs");
const nexttechlab = require("./services/nexttechlab.cjs");
const backup = require("./services/backup.cjs");
const activity = require("./services/activity.cjs");
const activityTracker = require("./services/activityTracker.cjs");
const wellbeing = require("./services/wellbeing.cjs");
const batteryReport = require("./services/batteryReport.cjs");
const importLinks = require("./services/importLinks.cjs");
const cp = require("./services/cp.cjs");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0a0a0b",
    title: "Apex",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // Open http/https links externally instead of inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

// Register a custom `apex-img://` protocol so the renderer can display
// timetable PNGs that live outside the app bundle without triggering
// file:// restrictions. Uses the modern protocol.handle API (Electron 32+).
function registerTimetableProtocol() {
  protocol.handle("apex-img", (request) => {
    try {
      const raw = decodeURIComponent(request.url.replace(/^apex-img:\/\//, ""));
      // Normalize: strip leading slashes, convert back-slashes to forward.
      const cleaned = raw.replace(/^\/+/, "").replace(/\\/g, "/");
      const fileUrl = pathToFileURL(cleaned).toString();
      return net.fetch(fileUrl);
    } catch (err) {
      console.error("[apex-img] protocol error", err);
      return new Response("protocol error: " + err.message, { status: 500 });
    }
  });
}
// Schemes that serve local resources must be declared privileged before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "apex-img",
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

app.whenReady().then(async () => {
  registerTimetableProtocol();
  try {
    await db.init();
  } catch (err) {
    // Don't let a broken DB boot silently — the user needs to know why the
    // app won't open. We log and surface a dialog, then quit cleanly.
    console.error("[db] init failed:", err);
    try {
      const { dialog } = require("electron");
      dialog.showErrorBox("Apex — database error", String(err?.stack || err));
    } catch {}
    app.exit(1);
    return;
  }
  // db.init() already seeds classes + weekly_goals + course habits on first
  // run. Nothing to do here.
  createWindow();

  // Auto-resume activity tracker. Default = on: if the setting has never been
  // written, we still start it so "today's apps" isn't empty on first launch.
  // Only explicit "0" (user turned it off) suppresses the auto-start.
  try {
    const pref = db.getSetting("activity.tracking");
    if (pref !== "0") {
      activityTracker.start((ch, p) => emit(ch, p));
    }
  } catch (e) { console.warn("[tracker] autostart skipped:", e.message); }

  // Global Ctrl/Cmd+Shift+N — pop the quick-capture modal in the renderer
  // even when Apex is in the background. We don't bind plain Ctrl+N so we
  // don't fight common browser/OS shortcuts.
  try {
    const accelerators = ["CommandOrControl+Shift+N", "Alt+Shift+N"];
    for (const acc of accelerators) {
      globalShortcut.register(acc, () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
          emit("quick-capture:open", { source: acc });
        }
      });
    }
  } catch (e) { console.warn("[shortcuts] register failed:", e.message); }

  // Boot the in-app notification scheduler. Polls every 60s for class
  // start-of-period, task deadlines, and live-timer expiry; respects the
  // `notifications.enabled` setting (defaults ON).
  try {
    const notifier = require("./services/notifier.cjs");
    notifier.attach(Notification);
    notifier.onClick(({ kind, payload }) => {
      // Bring the main window forward so the user lands somewhere useful.
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
          if (kind === "deadline" && payload?.taskId) {
            emit("nav:goto", { route: "tasks", taskId: payload.taskId });
          } else if (kind === "class") {
            emit("nav:goto", { route: "upcoming" });
          }
        }
      } catch { /* ignore */ }
    });
    notifier.start();
  } catch (e) { console.warn("[notifier] startup skipped:", e.message); }

  // Auto-launch Ollama daemon in the background so the user doesn't have to
  // click the Start-menu shortcut before the app can do AI work. Controlled
  // by the `ollama.autoStart` setting (defaults to on).
  try {
    const autoStart = (db.getSetting("ollama.autoStart") ?? "true") === "true"
                   || db.getSetting("ollama.autoStart") === "1";
    if (autoStart) {
      // Fire-and-forget: don't block the UI if Ollama takes a few seconds.
      ollama.ensureRunning({ timeoutMs: 15000 })
        .then((r) => console.log("[ollama] ensureRunning:", r.ok ? (r.already ? "already up" : "launched") : `failed: ${r.error}`))
        .catch((e) => console.warn("[ollama] ensureRunning threw:", e.message));
    }
  } catch (e) { console.warn("[ollama] autostart skipped:", e.message); }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => {
  console.error("[apex] whenReady failed:", err);
  app.exit(1);
});

app.on("will-quit", () => {
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Helpers to push progress events to the renderer.
function emit(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch {}
}

// ---- IPC surface -------------------------------------------------------------
// Keep all channel names namespaced: <domain>:<action>. Preload mirrors these.

// --- settings ---
ipcMain.handle("settings:get", (_e, key) => db.getSetting(key));
ipcMain.handle("settings:set", (_e, key, value) => db.setSetting(key, value));
ipcMain.handle("settings:all", () => db.allSettings());

ipcMain.handle("dialog:pickDirectory", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});
ipcMain.handle("dialog:pickFile", async (_e, filters) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: filters || [{ name: "JSON", extensions: ["json"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

// --- tasks ---
ipcMain.handle("tasks:list", (_e, filter) => db.listTasks(filter));
ipcMain.handle("tasks:create", (_e, task) => db.createTask(task));
ipcMain.handle("tasks:update", (_e, id, patch) => db.updateTask(id, patch));
ipcMain.handle("tasks:delete", (_e, id) => db.deleteTask(id));
ipcMain.handle("tasks:toggle", (_e, id) => db.toggleTask(id));
ipcMain.handle("tasks:habitStreak", (_e, id) => db.habitStreak(id));
ipcMain.handle("tasks:habitStreaksFor", (_e, ids) => db.habitStreaksFor(ids || []));
ipcMain.handle("tasks:today", () => db.tasksForToday());
ipcMain.handle("tasks:upcoming", (_e, days) => db.tasksUpcoming(days ?? 7));
ipcMain.handle("tasks:completedOn", (_e, isoDate) => db.tasksCompletedOn(isoDate));

// --- burnout checkins ---
ipcMain.handle("checkins:today", () => db.getCheckinByDate(today()));
ipcMain.handle("checkins:upsert", (_e, payload) =>
  db.upsertCheckin({ ...payload, date: today() }),
);
ipcMain.handle("checkins:last", (_e, days) => db.lastCheckins(days ?? 14));

// --- day notes (private journal) -------------------------------------------
// Past-entry access is gated by a passcode. We hold the unlock flag in
// process memory only — it resets whenever the app restarts.
let _dayNotesUnlockedUntil = 0;
const DAY_NOTES_UNLOCK_TTL_MS = 15 * 60 * 1000; // 15 minutes
function dayNotesIsUnlocked() { return Date.now() < _dayNotesUnlockedUntil; }
// guardAny — once a passcode is configured, EVERY day note (today included)
// needs an active unlock session. If no passcode is configured, nothing is
// gated. During the first setup we open the unlock window ourselves.
function guardAny(_date) {
  if (!db.hasDayNotePasscode()) return true;
  return dayNotesIsUnlocked();
}

ipcMain.handle("dayNotes:get", (_e, date) => {
  const iso = date || today();
  if (!guardAny(iso)) return { locked: true };
  return db.getDayNote(iso);
});
ipcMain.handle("dayNotes:upsert", (_e, payload) => {
  const p = payload || {};
  if (!guardAny(p.date)) {
    return { ok: false, locked: true, error: "Unlock first" };
  }
  return db.upsertDayNote(p);
});
ipcMain.handle("dayNotes:list", (_e, limit) => {
  if (!guardAny()) return { locked: true, dates: [] };
  return { locked: false, dates: db.listDayNoteDates(limit ?? 60) };
});
ipcMain.handle("dayNotes:delete", (_e, date) => {
  if (!guardAny(date)) return { ok: false, locked: true };
  db.deleteDayNote(date);
  return { ok: true };
});
ipcMain.handle("dayNotes:hasPasscode", () => ({ set: db.hasDayNotePasscode() }));
ipcMain.handle("dayNotes:setPasscode", (_e, { passcode }) => {
  try {
    db.setDayNotePasscode(passcode);
    _dayNotesUnlockedUntil = Date.now() + DAY_NOTES_UNLOCK_TTL_MS;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("dayNotes:unlock", (_e, { passcode }) => {
  if (!db.hasDayNotePasscode()) return { ok: false, error: "No passcode set" };
  if (db.verifyDayNotePasscode(passcode)) {
    _dayNotesUnlockedUntil = Date.now() + DAY_NOTES_UNLOCK_TTL_MS;
    return { ok: true, ttlMs: DAY_NOTES_UNLOCK_TTL_MS };
  }
  return { ok: false, error: "Incorrect passcode" };
});
ipcMain.handle("dayNotes:lock", () => { _dayNotesUnlockedUntil = 0; return { ok: true }; });
ipcMain.handle("dayNotes:isUnlocked", () => ({ unlocked: dayNotesIsUnlocked() }));
// Hard-reset path — used when the user has FORGOTTEN the passcode. Since
// notes are gated by the passcode (and we can't recover them), this nukes
// every day_notes row + clears the passcode setting. Caller MUST pass
// `confirm: "DELETE"` so an accidental click can't trigger it.
ipcMain.handle("dayNotes:resetPasscode", (_e, { confirm } = {}) => {
  if (confirm !== "DELETE") {
    return { ok: false, error: "Reset requires confirm=\"DELETE\"" };
  }
  try {
    const dbh = db._db();
    const before = dbh
      .prepare(`SELECT COUNT(*) AS c FROM day_notes`)
      .get();
    dbh.exec(`DELETE FROM day_notes`);
    db.clearDayNotePasscode?.();
    db.setSetting("dayNotes.passcodeHash", null);
    db.setSetting("dayNotes.passcodeSalt", null);
    _dayNotesUnlockedUntil = 0;
    return { ok: true, deletedNotes: before?.c || 0 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("dayNotes:clearPasscode", (_e, { passcode }) => {
  // Require current passcode to clear, so a shoulder-surfer can't just wipe it.
  if (db.hasDayNotePasscode() && !db.verifyDayNotePasscode(passcode)) {
    return { ok: false, error: "Incorrect passcode" };
  }
  db.clearDayNotePasscode();
  _dayNotesUnlockedUntil = 0;
  return { ok: true };
});
ipcMain.handle("dayNotes:summarize", async (_e, payload) => {
  const { date, model } = payload || {};
  if (!guardAny(date || today())) return { ok: false, locked: true, error: "Unlock first" };
  const note = db.getDayNote(date || today());
  if (!note || !(note.body || "").trim()) return { ok: false, error: "empty note" };
  const prompt =
    `Summarise this personal diary entry in one concise sentence (<= 30 words), third person, factual.\n\nEntry:\n${note.body}`;
  const res = await ollama.chat({
    model,
    system: "You are a terse summariser. Output only the summary sentence, no preface.",
    user: prompt,
  });
  if (!res.ok) return res;
  const summary = String(res.content || "").trim().replace(/^["'`]|["'`]$/g, "");
  db.setDayNoteSummary(date || today(), summary);
  return { ok: true, summary };
});

// --- streak / weekly goals (replaces weekly_focus) ---
ipcMain.handle("streak:status", () => db.streakStatus());
ipcMain.handle("goals:list", () => db.listWeeklyGoals());
ipcMain.handle("goals:upsert", (_e, goal) => db.upsertWeeklyGoal(goal));
ipcMain.handle("goals:delete", (_e, id) => db.deleteWeeklyGoal(id));
ipcMain.handle("goals:incrementProgress", (_e, id, by) => db.incrementGoalProgress(id, by ?? 1));
ipcMain.handle("goals:resetWeek", () => db.resetWeeklyGoals());

// --- schedule (timetable replacement) ---
ipcMain.handle("schedule:today", () => timetable.today());
ipcMain.handle("schedule:upcoming", (_e, days) => timetable.upcoming(days ?? 7));
ipcMain.handle("schedule:list", () => db.listClasses());
ipcMain.handle("schedule:forDayOrder", (_e, d) => db.classesForDayOrder(d));
ipcMain.handle("schedule:upsert", (_e, row) => db.upsertClass(row));
ipcMain.handle("schedule:delete", (_e, id) => db.deleteClass(id));
ipcMain.handle("schedule:replaceAll", (_e, rows) => db.replaceAllClasses(rows));
// SRM Academia — primary flow is browser-based: open a real BrowserWindow
// pointed at academia.srmist.edu.in (with a persistent partition so cookies
// survive across launches), the user signs in once, we harvest cookies
// and use them for every subsequent fetch. Captcha, MFA, password changes
// — all handled by the user's actual browser session.
//
// The legacy NetID/password headless flow is kept as a fallback but most
// accounts will hit Zoho's HIP captcha and bounce.
const srm = require("./services/srm.cjs");
const SRM_PARTITION = "persist:srm";

// Attach the persistent session to the SRM service so it can read cookies
// for every fetch. Done lazily on first use because `session.fromPartition`
// can only be called after `app.whenReady()`.
function _ensureSrmSessionAttached() {
  if (!app.isReady()) return null;
  const s = session.fromPartition(SRM_PARTITION);
  srm.attachElectronSession(s);
  return s;
}

ipcMain.handle("srm:saveCreds", (_e, { username, password } = {}) => {
  if (!username || !password) {
    return { ok: false, error: "Username and password are required." };
  }
  db.setSetting("srm.netid", String(username).trim());
  db.setSetting("srm.password", String(password));
  return { ok: true };
});
ipcMain.handle("srm:clearCreds", () => {
  db.setSetting("srm.netid", null);
  db.setSetting("srm.password", null);
  return { ok: true };
});
ipcMain.handle("srm:hasCreds", async () => {
  _ensureSrmSessionAttached();
  let loggedIn = false;
  try { loggedIn = await srm.isLoggedIn(); } catch { /* ignore */ }
  return {
    ok: true,
    saved: !!(db.getSetting("srm.netid") && db.getSetting("srm.password")),
    username: db.getSetting("srm.netid") || null,
    sessionActive: loggedIn,
  };
});
ipcMain.handle("srm:syncNow", async (_e, opts = {}) => {
  try {
    _ensureSrmSessionAttached();
    return await srm.syncAll(opts || {});
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Open a child BrowserWindow pointed at the SRM Academia login. Uses the
// persistent `persist:srm` partition so cookies stick across restarts.
// Resolves with `{ ok: true, loggedIn }` once the window closes (whether
// the user signed in or just dismissed it).
let _srmLoginWin = null;
ipcMain.handle("srm:openLoginWindow", async () => {
  if (_srmLoginWin && !_srmLoginWin.isDestroyed()) {
    _srmLoginWin.focus();
    return { ok: true, alreadyOpen: true };
  }
  _ensureSrmSessionAttached();
  _srmLoginWin = new BrowserWindow({
    width: 980,
    height: 760,
    title: "Sign in to SRM Academia",
    autoHideMenuBar: true,
    parent: mainWindow,
    modal: false,
    webPreferences: {
      partition: SRM_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Watch for navigation into the post-login redirect; auto-close once
  // the user lands on the academia portal page.
  let resolved = false;
  const finish = (extra = {}) =>
    new Promise(async (resolve) => {
      try {
        const loggedIn = await srm.isLoggedIn();
        resolve({ ok: true, loggedIn, ...extra });
      } catch (err) {
        resolve({ ok: true, loggedIn: false, error: err.message, ...extra });
      }
    });
  return await new Promise((resolve) => {
    _srmLoginWin.webContents.on("did-navigate", async (_evt, url) => {
      if (
        !resolved &&
        /academia\.srmist\.edu\.in\/portal\/academia-academic-services/.test(url)
      ) {
        resolved = true;
        // Give Zoho a moment to flush cookies, then close.
        setTimeout(async () => {
          try { _srmLoginWin?.close?.(); } catch {}
          resolve(await finish({ closedBy: "auto" }));
        }, 1500);
      }
    });
    _srmLoginWin.on("closed", async () => {
      _srmLoginWin = null;
      if (!resolved) {
        resolved = true;
        resolve(await finish({ closedBy: "user" }));
      }
    });
    _srmLoginWin.loadURL(
      "https://academia.srmist.edu.in/accounts/p/10002227248/signin?hide_fp=true&servicename=ZohoCreator&service_language=en&serviceurl=https%3A%2F%2Facademia.srmist.edu.in%2Fportal%2Facademia-academic-services%2FredirectFromLogin",
    );
  });
});

ipcMain.handle("srm:logout", async () => {
  _ensureSrmSessionAttached();
  return await srm.clearCookies();
});

// Surfaces the deep-debug payload used by Settings → Schedule's "Diagnose"
// button. Saves a copy of the report to the user's home dir so they can
// share it via paste / file upload when SRM throws something we haven't
// seen before.
ipcMain.handle("srm:diagnose", async () => {
  _ensureSrmSessionAttached();
  const report = await srm.diagnose();
  try {
    const out = path.join(app.getPath("userData"), "srm-diagnose.json");
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    report.savedTo = out;
  } catch { /* ignore — diagnostics still useful in-memory */ }
  return report;
});

// --- course materials (syllabi etc as Ollama context) ---
ipcMain.handle("courseMaterials:list", (_e, opts = {}) =>
  db.listCourseMaterials(opts || {}),
);
ipcMain.handle("courseMaterials:upsert", (_e, p) =>
  ({ ok: true, id: db.upsertCourseMaterial(p || {}) }),
);
ipcMain.handle("courseMaterials:delete", (_e, id) => {
  db.deleteCourseMaterial(id);
  return { ok: true };
});
ipcMain.handle("courseMaterials:setAi", (_e, id, on) => {
  db.setCourseMaterialAi(id, !!on);
  return { ok: true };
});
// Distinct course list pulled from the timetable so the user can attach
// materials per course without typing the code by hand.
ipcMain.handle("courseMaterials:knownCourses", () => {
  const dbh = db._db();
  const rows = dbh
    .prepare(
      `SELECT DISTINCT code, subject FROM classes
         WHERE code IS NOT NULL AND TRIM(code) != ''
         ORDER BY code ASC`,
    )
    .all();
  return rows;
});
ipcMain.handle("courseMaterials:readFile", async (_e, filePath) => {
  try {
    const txt = fs.readFileSync(filePath, "utf8");
    return { ok: true, body: txt.slice(0, 500_000) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- in-app notifications (class starts, deadlines, timer expiry) ---
const notifier = require("./services/notifier.cjs");
ipcMain.handle("notifier:status", () => notifier.getStatus());
ipcMain.handle("notifier:setEnabled", (_e, on) => notifier.setEnabled(on));
ipcMain.handle("notifier:setLeads", (_e, opts) => notifier.setLeads(opts || {}));
ipcMain.handle("notifier:test", () => {
  const ok = notifier.fire({
    title: "Apex test notification",
    body: "If you see this, system notifications are working.",
    kind: "test",
  });
  return { ok };
});

ipcMain.handle("schedule:resyncFromAcademia", async (_e, folder) => {
  return timetable.resyncFromAcademia(folder);
});
ipcMain.handle("schedule:parseJson", (_e, jsonPath) => timetable.parseFromJson(jsonPath));
ipcMain.handle("schedule:pickImages", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
  });
  if (res.canceled) return null;
  return res.filePaths || [];
});
ipcMain.handle("schedule:parseImages", async (_e, payload) => {
  return timetable.parseFromImages(payload || {});
});
ipcMain.handle("schedule:importImageRows", (_e, rows) => timetable.importFromImageRows(rows));
ipcMain.handle("schedule:setDayOrderForDate", (_e, isoDate, dayOrder) =>
  db.setDayOrderForDate(isoDate, dayOrder),
);
// legacy compatibility
ipcMain.handle("timetable:load", (_e, folder) => timetable.load(folder));
ipcMain.handle("timetable:today", () => timetable.today());

// --- ollama ---
ipcMain.handle("ollama:listModels", () => ollama.listModels());
ipcMain.handle("ollama:plan", (_e, ctx) => {
  // Augment plan context with live-timer + today's effective schedule so the
  // model plans around what's actually happening right now.
  const activeTimer = db.getActiveTimer();
  const isoToday = new Date().toISOString().slice(0, 10);
  const recent = db._db()
    .prepare(
      `SELECT app, category, minutes, started_at, ended_at, note
         FROM activity_sessions
        WHERE date = ? AND source = 'timer'
        ORDER BY started_at DESC
        LIMIT 12`,
    )
    .all(isoToday);
  return ollama.planDay({
    ...(ctx || {}),
    activeTimer,
    recentTimerSessions: recent,
    nowIso: new Date().toISOString(),
  });
});
ipcMain.handle("ollama:chat", (_e, { model, system, user }) =>
  // Wrap the UI-supplied role prompt with the shared personal-context layer
  // so even Ask-Apex gets the profile + house rules.
  ollama.chat({ model, system: ollama.buildSystem(system || "You are Apex, a helpful personal assistant."), user }),
);
// What should I do next? Pulls all relevant state on the backend so the
// renderer can fire-and-forget without assembling 6 different fetches.
ipcMain.handle("ollama:recommend", async (_e, opts = {}) => {
  try {
    const isoToday = new Date().toISOString().slice(0, 10);
    const tasks = db.listTasks({ kind: "task", completed: false }) || [];
    const tt = timetable.today();
    const activeTimer = db.getActiveTimer();
    const recentTimerSessions = db._db()
      .prepare(
        `SELECT app, category, minutes, started_at, ended_at
           FROM activity_sessions
          WHERE date = ? AND source = 'timer'
          ORDER BY started_at DESC LIMIT 8`,
      )
      .all(isoToday);
    const todayTotals = db.activityTotalsOn(isoToday);
    const burnoutRow = db.latestBurnoutReport();
    const burnoutReport = burnoutRow
      ? { ...burnoutRow.payload, generated_at: burnoutRow.created_at }
      : null;
    const weeklyGoals = db.listWeeklyGoals();
    // Best-effort CP self snapshot from cache.
    let cpSelf = null;
    try {
      const cpRow = db.getSetting("cp.self.snapshot");
      cpSelf = cpRow ? JSON.parse(cpRow) : null;
    } catch { cpSelf = null; }

    return await ollama.recommendNow({
      classes: tt.classes || [],
      tasks,
      activeTimer,
      recentTimerSessions,
      todayTotals,
      burnoutReport,
      weeklyGoals,
      cpSelf,
      nowIso: new Date().toISOString(),
      model: opts.model,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("ollama:burnoutSuggest", (_e, ctx = {}) => {
  // Augment renderer-supplied context with academic data so suggestions
  // are grounded in actual coursework instead of generic advice.
  try {
    const isoToday = new Date().toISOString().slice(0, 10);
    const dbh = db._db();
    // Open tasks with a course_code OR Academics category in the next 14d.
    const openAcademicTasks = dbh
      .prepare(
        `SELECT id, title, priority, deadline, course_code, category
           FROM tasks
          WHERE completed = 0
            AND (course_code IS NOT NULL OR category = 'Academics')
          ORDER BY
            CASE WHEN deadline IS NULL THEN 1 ELSE 0 END,
            deadline ASC, priority ASC LIMIT 12`,
      )
      .all();
    const upcomingDeadlines = dbh
      .prepare(
        `SELECT id, title, priority, deadline, course_code
           FROM tasks
          WHERE completed = 0
            AND deadline IS NOT NULL
            AND date(deadline) >= date(?)
            AND date(deadline) <= date(?, '+7 days')
          ORDER BY deadline ASC LIMIT 12`,
      )
      .all(isoToday, isoToday);
    const recentCompletedAcademic = dbh
      .prepare(
        `SELECT id, title, course_code FROM tasks
          WHERE completed = 1
            AND date(completed_at) = date(?)
            AND (course_code IS NOT NULL OR category = 'Academics')
          ORDER BY completed_at DESC LIMIT 8`,
      )
      .all(isoToday);
    return ollama.burnoutSuggest({
      ...ctx,
      openAcademicTasks,
      upcomingDeadlines,
      recentCompletedAcademic,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("ollama:burnoutCheck", (_e, ctx) => ollama.burnoutCheck(ctx));
ipcMain.handle("ollama:eveningReview", async (_e, opts = {}) => {
  // Assemble the full end-of-day context server-side so the renderer just
  // says "give me the review" — no need to gather completed tasks, time
  // totals etc. on the JSX side.
  try {
    const isoToday = new Date().toISOString().slice(0, 10);
    const dbh = db._db();
    const completedToday = dbh
      .prepare(
        `SELECT id, title, category, course_code
           FROM tasks
          WHERE completed = 1
            AND date(completed_at) = date(?)
          ORDER BY completed_at DESC LIMIT 30`,
      )
      .all(isoToday);
    const openTasks = db.listTasks({ kind: "task", completed: false }) || [];
    const checkin = db.getCheckinByDate(isoToday) || null;
    const timeTotals = db.activityTotalsOn(isoToday) || {};
    return await ollama.eveningReview({
      checkin,
      completedToday,
      timeTotals,
      openTasks,
      model: opts.model,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// Return the best installed chat model (so the renderer can default to it).
ipcMain.handle("ollama:best", async () => ({ model: await ollama.autoPickBest() }));
// Manual "Start Ollama" button in Settings.
ipcMain.handle("ollama:start", () => ollama.ensureRunning({ timeoutMs: 15000 }));
ipcMain.handle("ollama:ping", () => ollama.ping().then((ok) => ({ ok })));
ipcMain.handle("burnout:latestReport", () => db.latestBurnoutReport());
ipcMain.handle("burnout:recent", (_e, days) => db.recentBurnoutReports(days || 7));

// --- github ---
ipcMain.handle("github:fetchUser", (_e, username) =>
  github.fetchUser(username),
);
ipcMain.handle("github:fetchRepos", (_e, username) =>
  github.fetchRepos(username),
);
ipcMain.handle("github:fetchLanguages", (_e, fullName) =>
  github.fetchLanguages(fullName),
);
ipcMain.handle("github:rateLimit", () => github.rateLimit());

// --- people / repos ---
ipcMain.handle("people:list", (_e, filter) => db.listPeople(filter));
ipcMain.handle("people:upsert", (_e, person) => db.upsertPerson(person));
ipcMain.handle("people:delete", (_e, id) => db.deletePerson(id));
ipcMain.handle("people:repos", (_e, personId) => db.listRepos(personId));
ipcMain.handle("people:sync", (_e, personId) => github.syncPerson(personId));
ipcMain.handle("people:syncAll", () =>
  github.syncAll((p) => emit("people:syncProgress", p)),
);

// --- CP (competitive programming) ---
ipcMain.handle("cp:fetchPerson", (_e, personId) => cp.fetchAllForPerson(personId));
ipcMain.handle("cp:fetchAll", () =>
  cp.fetchAllPeople((p) => emit("cp:progress", p)),
);
ipcMain.handle("cp:stats", (_e, personId) => db.listCpStats(personId));
ipcMain.handle("cp:submissions", (_e, personId, limit) =>
  db.recentCpSubmissions(personId, limit ?? 20),
);
ipcMain.handle("cp:self", () => cp.fetchSelf());
ipcMain.handle("cp:selfCached", () => cp.selfCached());
ipcMain.handle("cp:leaderboard", (_e, platform) => db.cpLeaderboard(platform));

// --- nexttechlab ---
ipcMain.handle("ntl:scrape", (_e, lab) => nexttechlab.scrapeLab(lab));
ipcMain.handle("ntl:scrapeAll", () => nexttechlab.scrapeAll());
ipcMain.handle("ntl:import", (_e, members) => db.importPeople(members));

// --- interests / projects (still in db; Interests page was merged into Tasks) ---
ipcMain.handle("interests:list", () => db.listInterests());
ipcMain.handle("interests:upsert", (_e, item) => db.upsertInterest(item));
ipcMain.handle("interests:delete", (_e, id) => db.deleteInterest(id));

// --- backup / restore ---
ipcMain.handle("backup:export", () => backup.exportDb());
ipcMain.handle("backup:import", () => backup.importDb());
ipcMain.handle("backup:info", () => backup.dbInfo());

// --- activity / time log ---
ipcMain.handle("activity:add", (_e, entry) => activity.addEntry(entry));
ipcMain.handle("activity:list", (_e, opts) => activity.listEntries(opts));
ipcMain.handle("activity:delete", (_e, id) => activity.deleteEntry(id));
ipcMain.handle("activity:todayTotals", () => activity.todayTotals());
ipcMain.handle("activity:weekTotals", () => activity.weekTotals());
ipcMain.handle("activity:recentPushes", (_e, opts) =>
  activity.recentPushes(opts),
);
ipcMain.handle("activity:totalsOn", (_e, isoDate) => db.activityTotalsOn(isoDate));
ipcMain.handle("activity:trend", (_e, days) => db.activityTrend(days ?? 7));
ipcMain.handle("activity:topApps", (_e, isoDate, limit) => db.topAppsOn(isoDate ?? today(), limit ?? 10));
ipcMain.handle("activity:feed", (_e, opts) => db.listActivityFeed(opts || {}));
ipcMain.handle("people:heatStrips", (_e, ids, days) =>
  db.pushHeatStripsFor(ids || [], days || 14),
);

// --- live timer (universal "what am I doing now") ---
// Singleton row in live_timer + a broadcast on change so any component can
// react. Stopping/expiring writes the elapsed time into activity_sessions
// so it shows up in Top apps / week totals.
function broadcastTimer(payload) {
  emit("timer:update", payload);
}
ipcMain.handle("timer:active", () => db.getActiveTimer());
ipcMain.handle("timer:start", (_e, p) => {
  // If something is already running, finish it cleanly first.
  const existing = db.getActiveTimer();
  if (existing) finishTimerToActivity(existing, "interrupted");
  const row = db.startTimer(p || {});
  broadcastTimer(row);
  return row;
});
ipcMain.handle("timer:extend", (_e, mins) => {
  const row = db.extendTimer(+mins || 5);
  broadcastTimer(row);
  return row;
});
ipcMain.handle("timer:stop", () => {
  const row = db.getActiveTimer();
  if (!row) return { ok: false, error: "No active timer" };
  const out = finishTimerToActivity(row, "stopped");
  db.clearTimer();
  broadcastTimer(null);
  return { ok: true, logged: out };
});
ipcMain.handle("timer:cancel", () => {
  const row = db.getActiveTimer();
  if (!row) return { ok: false };
  // Cancel = discard. Only log if more than 60s elapsed so accidental
  // cancels don't pollute the activity stream.
  const minutes = elapsedMinutes(row);
  let logged = null;
  if (minutes >= 1) logged = finishTimerToActivity(row, "cancelled");
  db.clearTimer();
  broadcastTimer(null);
  return { ok: true, logged };
});

function elapsedMinutes(timer) {
  const start = new Date(timer.started_at).getTime();
  return Math.max(0, Math.round((Date.now() - start) / 60000));
}
function finishTimerToActivity(timer, reason) {
  const minutes = elapsedMinutes(timer);
  if (minutes < 1) return null;
  const now = new Date();
  const noteParts = [];
  if (timer.description) noteParts.push(timer.description);
  if (reason && reason !== "stopped") noteParts.push(`(${reason})`);
  const id = db.upsertActivitySession({
    date: db.dbPath ? undefined : undefined, // let helper default to today
    source: "timer",
    app: timer.title || timer.kind || "timer",
    window_title: timer.kind || null,
    category: timer.category || db.categoryForTimerKind(timer.kind),
    started_at: timer.started_at,
    ended_at: now.toISOString(),
    minutes,
    note: noteParts.join(" "),
  });
  return { id, minutes };
}

// --- per-date class overrides (cancel/move/replace/add for one day) ---
ipcMain.handle("schedule:overridesForDate", (_e, isoDate) =>
  db.listClassOverrides(isoDate),
);
ipcMain.handle("schedule:setOverride", (_e, isoDate, classId, patch) =>
  db.setClassOverride(isoDate, classId, patch || {}),
);
ipcMain.handle("schedule:addExtraClass", (_e, isoDate, payload) =>
  db.addExtraClass(isoDate, payload || {}),
);
ipcMain.handle("schedule:clearOverride", (_e, isoDate, classId) => {
  db.clearClassOverride(isoDate, classId || null);
  return { ok: true };
});
ipcMain.handle("schedule:deleteOverrideById", (_e, id) => {
  db.deleteClassOverrideById(id);
  return { ok: true };
});

// --- desktop active-window tracker ---
ipcMain.handle("tracker:start", () => activityTracker.start((ch, p) => emit(ch, p)));
ipcMain.handle("tracker:stop", () => activityTracker.stop());
ipcMain.handle("tracker:status", () => activityTracker.status());
ipcMain.handle("tracker:categorize", (_e, app, category) => {
  // Two-step override:
  //   1. Persist the rule so future tracker ticks (and mobile syncs) pick
  //      up the new category.
  //   2. Retroactively rewrite the last 30 days of activity_sessions for
  //      that app so the user sees the change reflected immediately in
  //      Top apps + the daily category breakdown. Works for desktop exes
  //      AND android package names (the storage key/value is generic).
  db.setSetting("activity.overrides." + String(app).toLowerCase(), category);
  const r = db.reclassifyAppCategory(app, category, { days: 30 });
  return { ok: true, updated: r.updated };
});

// --- mobile wellbeing (ADB) ---
ipcMain.handle("wellbeing:devices", () => wellbeing.devices());
ipcMain.handle("wellbeing:syncNow", () => wellbeing.syncNow());

// --- battery-report-derived desktop screen time (Windows only) ---
ipcMain.handle("battery:supported", () => ({ ok: true, supported: batteryReport.supported() }));
ipcMain.handle("battery:run", (_e, duration) => batteryReport.run(duration ?? 14));
ipcMain.handle("battery:latest", () => batteryReport.latest());
ipcMain.handle("battery:syncToActivity", (_e, duration) =>
  batteryReport.syncToActivity({ duration: duration ?? 14 }),
);

// --- calendar (SRM academic calendar HTML → day-order overrides) ---
ipcMain.handle("calendar:parse", (_e, htmlPath) => calendar.parseCalendarHtml(htmlPath));
ipcMain.handle("calendar:sync", (_e, htmlPath) => calendar.syncFromHtml(htmlPath));
ipcMain.handle("calendar:list", (_e, limit) => calendar.listOverrides(limit));

// --- import by link ---
ipcMain.handle("import:preview", (_e, url) => importLinks.previewUrl(url));
ipcMain.handle("import:previewNtl4", () => importLinks.previewNtl4());
ipcMain.handle("import:commit", (_e, list) => importLinks.importCandidates(list));

// --- repo detail + Ollama summary ---
ipcMain.handle("repo:detail", async (_e, repoId) => {
  try {
    const detail = await github.fetchRepoDetail(repoId);
    const cached = db.getRepoSummary(repoId);
    return { ok: true, ...detail, cached: cached?.payload ?? null, cachedModel: cached?.model ?? null };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});
ipcMain.handle("repo:summarize", async (_e, { repoId, ownRepos, model }) => {
  try {
    const detail = await github.fetchRepoDetail(repoId);
    const res = await ollama.summarizeRepo({
      repo: { ...detail.repo, languages: Object.keys(detail.languages || {}) },
      readme: detail.readme,
      ownRepos: ownRepos || [],
      paths: detail.paths || [],
      manifests: detail.manifests || {},
      treeTruncated: !!detail.treeTruncated,
      model,
    });
    if (res.ok) db.saveRepoSummary(repoId, res, res.model || model || null);
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("repo:listByPerson", (_e, personId) => db.listRepos(personId));
// Live commits via the GitHub API for the push-card expand panel.
// Defaults to the last 14 days; capped at 20 commits per call.
ipcMain.handle("repo:recentCommits", async (_e, { fullName, days, limit } = {}) => {
  try {
    const sinceDays = Math.max(1, Math.min(60, +days || 14));
    const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();
    const commits = await github.fetchCommits(fullName, {
      since,
      limit: Math.max(5, Math.min(40, +limit || 20)),
    });
    return { ok: true, commits };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});
// Project Q&A — gathers the same rich context as summarizeRepo + recent
// commits and asks Ollama. The renderer keeps the conversation; we just
// answer the latest question.
ipcMain.handle("repo:chat", async (_e, { repoId, fullName, question, history, model } = {}) => {
  try {
    let detail = null;
    let cachedSummary = null;
    if (repoId) {
      detail = await github.fetchRepoDetail(repoId);
      const cached = db.getRepoSummary(repoId);
      cachedSummary = cached?.payload || null;
    } else if (fullName) {
      const dbh = db._db();
      const repo = dbh.prepare(`SELECT * FROM repos WHERE full_name = ?`).get(fullName);
      if (repo) detail = await github.fetchRepoDetail(repo.id);
    }
    const repoForCtx = detail?.repo
      ? { ...detail.repo, languages: Object.keys(detail.languages || {}) }
      : { full_name: fullName };

    // Recent commits for grounding "what's been done" questions.
    let recentCommits = [];
    try {
      recentCommits = await github.fetchCommits(repoForCtx.full_name, { limit: 25 });
    } catch { /* swallow */ }

    return await ollama.chatAboutRepo({
      repo: repoForCtx,
      readme: detail?.readme || null,
      paths: detail?.paths || [],
      manifests: detail?.manifests || {},
      treeTruncated: !!detail?.treeTruncated,
      recentCommits,
      cachedSummary,
      history,
      question,
      model,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Per-commit chat — fetches the commit detail (with diffs) and asks Ollama.
ipcMain.handle("commit:detail", async (_e, { fullName, sha } = {}) => {
  try {
    const detail = await github.fetchCommitDetail(fullName, sha);
    if (!detail) return { ok: false, error: "Commit not found or not accessible." };
    return { ok: true, ...detail };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});
ipcMain.handle("commit:chat", async (_e, { fullName, sha, question, history, model } = {}) => {
  try {
    const commit = await github.fetchCommitDetail(fullName, sha);
    if (!commit) return { ok: false, error: "Commit not found." };
    const dbh = db._db();
    const repoRow = dbh.prepare(`SELECT * FROM repos WHERE full_name = ?`).get(fullName);
    return await ollama.chatAboutCommit({
      repo: repoRow || { full_name: fullName },
      commit,
      history,
      question,
      model,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// CP per-person Ollama summary. Caller passes a personId; we pull the
// stats + cached recent submissions and ask the model for topics +
// strengths. For "self" the renderer can pass personId=null and the
// snapshot from cp.self.
ipcMain.handle("cp:summarize", async (_e, { personId, name, model } = {}) => {
  try {
    let person, stats = {}, submissions = [];
    if (personId) {
      const dbh = db._db();
      person = dbh.prepare(`SELECT id, name FROM people WHERE id = ?`).get(personId);
      stats = (db.listCpStats?.(personId) || []).reduce((acc, row) => {
        try { acc[row.platform] = JSON.parse(row.stats || '{}'); } catch {}
        return acc;
      }, {});
      submissions = db.recentCpSubmissions?.({ personId, limit: 60 }) || [];
    } else {
      person = { name: name || "you" };
      try {
        const raw = db.getSetting("cp.self.snapshot");
        if (raw) stats = JSON.parse(raw);
      } catch { /* ignore */ }
      submissions = db.recentCpSubmissions?.({ self: true, limit: 60 }) || [];
    }
    return await ollama.summarizeCpActivity({ person, stats, submissions, model });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Ask Ollama "what changed in the last N days" — given live commits.
ipcMain.handle("repo:summarizeRecentChanges", async (_e, { repoId, fullName, days, model } = {}) => {
  try {
    const sinceDays = Math.max(1, Math.min(60, +days || 14));
    const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000).toISOString();
    const commits = await github.fetchCommits(fullName, { since, limit: 30 });
    const repoRow = repoId
      ? db._db().prepare(`SELECT id, name, full_name, description FROM repos WHERE id = ?`).get(repoId)
      : { full_name: fullName };
    const res = await ollama.summarizeRecentChanges({ repo: repoRow, commits, model });
    return { ...(res || {}), commits };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
});

// --- external links ---
ipcMain.handle("ext:open", (_e, url) => shell.openExternal(url));
ipcMain.handle("ext:openSpotify", async () => {
  // Try the desktop app first (spotify:), fall back to the web player.
  try {
    await shell.openExternal("spotify:");
    return { ok: true, app: true };
  } catch {
    try {
      await shell.openExternal("https://open.spotify.com");
      return { ok: true, app: false };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
});

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
