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

  // Auto-resume activity tracker if the user had it enabled.
  try {
    if (db.getSetting("activity.tracking") === "1") {
      activityTracker.start((ch, p) => emit(ch, p));
    }
  } catch (e) { console.warn("[tracker] autostart skipped:", e.message); }

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
  ollama.chat({ model, system, user }),
);
ipcMain.handle("ollama:burnoutSuggest", (_e, ctx) => ollama.burnoutSuggest(ctx));
ipcMain.handle("ollama:burnoutCheck", (_e, ctx) => ollama.burnoutCheck(ctx));
ipcMain.handle("ollama:eveningReview", (_e, ctx) => ollama.eveningReview(ctx));
ipcMain.handle("burnout:latestReport", () => db.latestBurnoutReport());

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
