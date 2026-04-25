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
ipcMain.handle("ollama:plan", (_e, ctx) => ollama.planDay(ctx));
ipcMain.handle("ollama:chat", (_e, { model, system, user }) =>
  // Wrap the UI-supplied role prompt with the shared personal-context layer
  // so even Ask-Apex gets the profile + house rules.
  ollama.chat({ model, system: ollama.buildSystem(system || "You are Apex, a helpful personal assistant."), user }),
);
ipcMain.handle("ollama:burnoutSuggest", (_e, ctx) => ollama.burnoutSuggest(ctx));
ipcMain.handle("ollama:burnoutCheck", (_e, ctx) => ollama.burnoutCheck(ctx));
ipcMain.handle("ollama:eveningReview", (_e, ctx) => ollama.eveningReview(ctx));
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

// --- desktop active-window tracker ---
ipcMain.handle("tracker:start", () => activityTracker.start((ch, p) => emit(ch, p)));
ipcMain.handle("tracker:stop", () => activityTracker.stop());
ipcMain.handle("tracker:status", () => activityTracker.status());
ipcMain.handle("tracker:categorize", (_e, app, category) => {
  db.setSetting("activity.overrides." + String(app).toLowerCase(), category);
  return { ok: true };
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
