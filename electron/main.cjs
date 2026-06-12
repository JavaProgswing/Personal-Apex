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
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { execFile } = require("node:child_process");

const isDev = process.env.NODE_ENV === "development";
if (process.platform === "win32") {
  app.setAppUserModelId("in.apex.app");
}
app.setName("Apex");

// On Windows, the default console codepage is cp437/cp1252 — Node writes
// UTF-8 bytes and any non-ASCII glyph (em-dash, ellipsis, arrows) renders
// as mojibake (the "ΓÇª" / "ΓÇö" garble). Switch to UTF-8 (chcp 65001) at
// boot so console output stays readable. Best-effort, fire-and-forget.
if (process.platform === "win32") {
  try {
    require("node:child_process").exec("chcp 65001", { windowsHide: true });
    process.stdout.setDefaultEncoding?.("utf8");
    process.stderr.setDefaultEncoding?.("utf8");
  } catch { /* harmless if it fails */ }
}

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
const routine = require("./services/routine.cjs");

let mainWindow = null;
let tray = null;
// Flipped to true only when the user picks "Quit" from the tray or
// Cmd/Ctrl+Q. Tells the close handler "this is a real quit, don't hide".
let isQuitting = false;
let routinePoll = null;
let routineCloudPullAt = 0;
// True if the OS auto-started the app at login. Used so we open the
// window minimised (or not at all if tray-mode is on) when launched
// invisibly at startup, vs full-window when the user opens the app
// from their Start menu / taskbar.
let launchedAtLogin = false;
const appOpenedAt = new Date().toISOString();
const appSessionId = `${process.pid}-${Date.now().toString(36)}`;
let lastCloseRequest = null;
let appCloseLogged = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv = [], workingDirectory = "") => {
    const attemptedAt = new Date().toISOString();
    logRoutineEvent("singleton_second_instance", {
      ...appSessionPayload(),
      attemptedAt,
      argv: argv.slice(-8),
      workingDirectory,
    });
    if (app.isReady()) focusMainWindow();
  });
}

function createWindow() {
  // Honour "start minimised" when launched at login — open hidden if
  // the user enabled minimise-to-tray and the OS auto-launched us.
  let startHidden = false;
  try {
    const wantTray = db.getSetting("ui.minimizeToTray") === "1";
    if (launchedAtLogin && wantTray) startHidden = true;
  } catch { /* ignore */ }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0a0a0b",
    title: "Apex",
    show: !startHidden,
    autoHideMenuBar: true,
    icon: getAppIcon(),
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

  // Hide-to-tray instead of quitting when the close button is clicked,
  // if (a) the tray icon exists AND (b) minimise-to-tray is enabled.
  // Cmd/Ctrl+Q or tray → Quit still exits properly because they flip
  // `isQuitting` before triggering close.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    // Tray mode first: the X only hides the window — Apex keeps running and
    // tracking, so no close reason is owed for that.
    let wantTray = false;
    try { wantTray = db.getSetting("ui.minimizeToTray") === "1"; } catch {}
    if (wantTray && tray) {
      event.preventDefault();
      logRoutineEvent("window_hidden_to_tray", {
        ...appSessionPayload(),
        source: "window-close",
        hiddenAt: new Date().toISOString(),
      });
      mainWindow.hide();
      return;
    }
    let block = false;
    try {
      block = shouldBlockAppClose();
    } catch (err) {
      console.warn("[close-guard] check threw:", err.message);
    }
    console.log("[close-guard] window-close → block =", block);
    if (block) {
      event.preventDefault();
      surfaceRoutineGuard("window-close");
    }
  });
}

// Returns the app icon as a nativeImage if we can find one, else null
// (Electron falls back to its default icon). Looks for any of the common
// asset locations the build/dist process produces.
function getAppIcon() {
  const candidates = [
    path.join(__dirname, "..", "build", "icon.ico"),
    path.join(__dirname, "..", "build", "icon.png"),
    path.join(__dirname, "assets", "icon.png"),
    path.join(__dirname, "..", "dist", "icon.png"),
    path.join(__dirname, "icon.png"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } catch {}
  }
  return null;
}

function getTrayIcon() {
  const candidates = [
    path.join(__dirname, "..", "build", "tray.png"),
    path.join(__dirname, "..", "build", "tray.ico"),
    path.join(__dirname, "assets", "tray.png"),
    path.join(__dirname, "..", "build", "icon.ico"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (img.isEmpty()) continue;
      return img.resize({ width: 16, height: 16, quality: "best" });
    } catch {}
  }
  const fallback = getAppIcon();
  return fallback && !fallback.isEmpty()
    ? fallback.resize({ width: 16, height: 16, quality: "best" })
    : null;
}

// Build the system-tray icon + context menu. Creates one tray instance
// per app lifetime; the menu's items reach into mainWindow so we always
// act on the current renderer.
function createTray() {
  if (tray) return;
  const icon = getTrayIcon();
  // Fallback: a 16x16 transparent template so Tray() doesn't throw if no
  // icon shipped with the build. Windows will show a generic placeholder.
  const trayImg = icon || nativeImage.createEmpty();
  try {
    tray = new Tray(trayImg);
    tray.setToolTip("Apex");
    rebuildTrayMenu();
    // Single-click → show/hide. Default Windows tray UX.
    tray.on("click", () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn("[apex] tray init failed:", err.message);
    tray = null;
  }
}
function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: "Open Apex",
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createWindow();
          return;
        }
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: "Quit Apex",
      click: () => {
        if (shouldBlockAppClose()) {
          surfaceRoutineGuard("tray-quit");
          return;
        }
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// Apply the "start with Windows" preference to the OS. Idempotent: safe
// to call on every boot to keep the registry/Login Items entry in sync.
function usesElectronDefaultRuntime() {
  const exe = path.basename(process.execPath || "").toLowerCase();
  return !!process.defaultApp || !app.isPackaged || exe === "electron.exe" || exe === "electron";
}

function quoteLoginArg(arg) {
  const value = String(arg || "");
  if (process.platform !== "win32") return value;
  if (!/\s/.test(value) || /^".*"$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function loginLaunchArgs(minimised) {
  const args = [];
  // In development/unpackaged runs, Windows launches the Electron binary
  // directly. Electron needs the app folder as argv[1]; without it, the
  // bundled Electron sample screen appears at login.
  if (usesElectronDefaultRuntime()) {
    args.push(quoteLoginArg(app.getAppPath()));
  }
  if (minimised) args.push("--launched-at-login");
  return args;
}

function loginItemOptions(minimised) {
  return {
    path: process.execPath,
    args: loginLaunchArgs(minimised),
  };
}

function applyAutostartFromSettings() {
  try {
    const want = db.getSetting("ui.autostart") === "1";
    const minimised = db.getSetting("ui.minimizeToTray") === "1";
    const loginItem = loginItemOptions(minimised);
    // openAsHidden hides the window at login on macOS; on Windows we
    // approximate it by setting `--launched-at-login` and letting
    // createWindow check it.
    app.setLoginItemSettings({
      openAtLogin: want,
      openAsHidden: !!minimised,
      path: loginItem.path,
      args: loginItem.args,
      enabled: want,
    });
  } catch (err) {
    console.warn("[apex] applyAutostartFromSettings:", err.message);
  }
}

function startupStatusSnapshot() {
  const minimised = db.getSetting("ui.minimizeToTray") === "1";
  const autostart = db.getSetting("ui.autostart") === "1";
  const loginItem = loginItemOptions(minimised);
  const li = app.getLoginItemSettings(loginItem);
  const electronRuntime = usesElectronDefaultRuntime();
  const hasMismatchedStartupArgs =
    autostart && !!li.executableWillLaunchAtLogin && !li.openAtLogin;
  return {
    openAtLogin: !!li.openAtLogin,
    executableWillLaunchAtLogin: !!li.executableWillLaunchAtLogin,
    hasMismatchedStartupArgs,
    trayActive: !!tray,
    minimizeToTrayPref: minimised,
    autostartPref: autostart,
    launchMode: electronRuntime ? "electron-default" : "packaged",
    requiresAppPathArg: electronRuntime,
    expectedArgs: loginItem.args,
    appPath: app.getAppPath(),
    executable: loginItem.path,
  };
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

// Detect "launched at login" so we know whether to open the window
// hidden. Set by setLoginItemSettings({ args: ["--launched-at-login"] }).
if (process.argv.includes("--launched-at-login")) {
  launchedAtLogin = true;
}

if (hasSingleInstanceLock) {
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
  logAppOpen();
  createWindow();
  // Create the system-tray icon ONLY if the user opted in. We keep it
  // off by default so the app doesn't grow a tray icon nobody asked for.
  try {
    if (db.getSetting("ui.minimizeToTray") === "1") {
      createTray();
    }
  } catch {}
  // Sync the login-item entry with the saved preference.
  applyAutostartFromSettings();

  // Auto-resume activity tracker. Default = on: if the setting has never been
  // written, we still start it so "today's apps" isn't empty on first launch.
  // Only explicit "0" (user turned it off) suppresses the auto-start.
  try {
    const pref = db.getSetting("activity.tracking");
    if (pref !== "0") {
      activityTracker.start((ch, p) => emit(ch, p));
    }
  } catch (e) { console.warn("[tracker] autostart skipped:", e.message); }
  try {
    if (db.activeZenSession?.()) startZenMonitor();
  } catch (e) { console.warn("[zen] autoresume skipped:", e.message); }
  try {
    startRoutineMonitor();
  } catch (e) { console.warn("[routine] monitor skipped:", e.message); }

  // Cloud mobile-wellbeing auto-pull. If the desktop is paired and the user
  // enabled auto-sync, pull the phone's usage now and then every 15 minutes.
  try {
    startCloudWellbeingAutoSync();
    const wb = wellbeing.cloudConfigured();
    if (wb.auto && wb.paired) {
      wellbeing.pullFromCloud().catch((e) => console.warn("[wellbeing] cloud pull failed:", e.message));
    }
  } catch (e) { console.warn("[wellbeing] cloud autosync skipped:", e.message); }

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

  // Auto-sync SRM Academia on startup. Network stack often isn't ready in
  // the first few seconds after launch (cold boot, wake-from-sleep, Wi-Fi
  // reconnect), so we wait 30s before the first try. On transient network
  // failure (TypeError / fetch failed), we retry once 30s later instead
  // of dumping noisy errors to the console. Default OFF so a quiet boot
  // is the norm — flip srm.autoSync = "1" in Settings to opt in.
  try {
    const srmAutoSync = db.getSetting("srm.autoSync");
    if (srmAutoSync === "1") {
      const isTransient = (msg) =>
        /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i
          .test(String(msg || ""));
      const attempt = async (n) => {
        try {
          _ensureSrmSessionAttached();
          const loggedIn = await srm.isLoggedIn().catch(() => false);
          if (!loggedIn) {
            console.log("[srm] autoSync: no active session, skipping");
            return;
          }
          console.log(`[srm] autoSync: attempt ${n}`);
          const res = await srm.syncAll({});
          if (res?.ok) {
            console.log(
              `[srm] autoSync: done -- ${res.classes} classes, batch ${res.student?.batch}`,
            );
            emit("srm:synced", {
              classes: res.classes,
              batch: res.student?.batch,
            });
            return;
          }
          if (n < 2 && isTransient(res?.error)) {
            console.log("[srm] autoSync: transient failure, retrying in 30s");
            setTimeout(() => attempt(n + 1), 30_000);
            return;
          }
          console.warn("[srm] autoSync: failed --", res?.error);
        } catch (e) {
          if (n < 2 && isTransient(e.message)) {
            console.log("[srm] autoSync: transient throw, retrying in 30s");
            setTimeout(() => attempt(n + 1), 30_000);
            return;
          }
          console.warn("[srm] autoSync threw:", e.message);
        }
      };
      setTimeout(() => attempt(1), 30_000);
    }
  } catch (e) {
    console.warn("[srm] autoSync setup skipped:", e.message);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => {
  console.error("[apex] whenReady failed:", err);
  app.exit(1);
});
}

app.on("will-quit", () => {
  logAppCloseOnce("will-quit");
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  if (routinePoll) {
    clearInterval(routinePoll);
    routinePoll = null;
  }
});

app.on("window-all-closed", () => {
  // Keep the app alive when the tray is up — closing every window is
  // equivalent to "minimise to tray" in tray mode. macOS already keeps
  // the app running by convention; on Windows + Linux we now do too
  // when the user has opted into the tray.
  if (process.platform === "darwin") return;
  if (tray) return;
  app.quit();
});
app.on("before-quit", (event) => {
  let shouldBlock = false;
  if (hasSingleInstanceLock) {
    try { shouldBlock = shouldBlockAppClose(); } catch {}
  }
  if (shouldBlock) {
    event.preventDefault();
    isQuitting = false;
    surfaceRoutineGuard("app-quit");
    return;
  }
  if (hasSingleInstanceLock) logAppCloseOnce("before-quit");
  isQuitting = true;
});

// Helpers to push progress events to the renderer.
function emit(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch {}
}

function uptimeMs() {
  const opened = Date.parse(appOpenedAt);
  return Number.isFinite(opened) ? Date.now() - opened : null;
}

function appSessionPayload(extra = {}) {
  return {
    appSessionId,
    appOpenAt: appOpenedAt,
    pid: process.pid,
    launchedAtLogin,
    packaged: app.isPackaged,
    executable: process.execPath,
    appPath: app.getAppPath?.(),
    uptimeMs: uptimeMs(),
    ...extra,
  };
}

function logRoutineEvent(kind, payload = {}) {
  try {
    return routine.logEvent(kind, payload || {});
  } catch (err) {
    console.warn(`[routine] ${kind} log skipped:`, err.message);
    return null;
  }
}

function logAppOpen() {
  logRoutineEvent("app_open", {
    ...appSessionPayload({
      openedAt: appOpenedAt,
      argv: process.argv.slice(1),
      cwd: process.cwd(),
    }),
  });
}

function logAppCloseOnce(source, extra = {}) {
  if (appCloseLogged) return null;
  appCloseLogged = true;
  const closeAt = new Date().toISOString();
  let lastReason = null;
  try { lastReason = routine.closeState?.().lastReason || null; } catch {}
  return logRoutineEvent("app_close", {
    ...appSessionPayload({
      source,
      closeAt,
      lastCloseRequest,
      closeReason: lastReason,
      ...extra,
    }),
  });
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function activeWorkCloseContext() {
  let activeZen = null;
  let activeTimer = null;
  try { activeZen = db.activeZenSession?.() || null; } catch {}
  try { activeTimer = db.getActiveTimer?.() || null; } catch {}

  const timerKind = String(activeTimer?.kind || "").toLowerCase();
  const timerCategory = String(activeTimer?.category || "").toLowerCase();
  const timerRequiresReason = !!activeTimer && (
    timerCategory === "productive" ||
    ["task", "study", "habit"].includes(timerKind)
  );

  if (!activeZen && !timerRequiresReason) return null;
  return {
    reason: activeZen ? "zen-active" : "productive-timer-active",
    activeZen: activeZen ? {
      id: activeZen.id,
      title: activeZen.title,
      mode: activeZen.mode,
      plannedMinutes: activeZen.planned_minutes,
      startedAt: activeZen.started_at,
      endsAt: activeZen.ends_at,
      violations: activeZen.violations || 0,
    } : null,
    activeTimer: activeTimer ? {
      id: activeTimer.id,
      kind: activeTimer.kind,
      category: activeTimer.category,
      title: activeTimer.title,
      description: activeTimer.description,
      plannedMinutes: activeTimer.planned_minutes,
      startedAt: activeTimer.started_at,
    } : null,
  };
}

function shouldBlockAppClose() {
  const close = routine.closeState?.();
  if (close?.allowedNow) return false;
  if (routine.shouldBlockClose?.()) return true;
  return !!activeWorkCloseContext();
}

function surfaceRoutineGuard(source) {
  const closeRequestedAt = new Date().toISOString();
  const foreground = activityTracker.status?.().current || null;
  const workContext = activeWorkCloseContext();
  const closePayload = {
    ...appSessionPayload({
      source,
      closeRequestedAt,
      foreground,
      workContext,
    }),
  };
  lastCloseRequest = closePayload;
  let payload = { source, ...closePayload };
  try {
    payload = routine.closeBlocked(closePayload);
    lastCloseRequest = {
      ...closePayload,
      blockedEventId: payload?.event?.id || null,
    };
  } catch (err) {
    payload = { source, ...closePayload, error: err.message };
  }
  focusMainWindow();
  emit("routine:closeBlocked", payload);
  try {
    notifier.fire({
      title: "Close reason required",
      body: "Apex needs a reason before it exits.",
      kind: "routine-close",
      payload,
    });
  } catch { /* notifier may be disabled */ }
}

function startRoutineMonitor() {
  if (routinePoll) return;
  const tick = async () => {
    try {
      const cloud = wellbeing.cloudConfigured?.();
      if (cloud?.paired && Date.now() - routineCloudPullAt > 120_000) {
        routineCloudPullAt = Date.now();
        const pulled = await wellbeing.pullFromCloud?.().catch(() => null);
        if (pulled?.ok && pulled.daysWritten > 0) {
          emit("activity:refresh", { source: "routine-pull", days: pulled.daysWritten });
        }
      }
      const nudge = routine.nextNudge?.();
      if (!nudge) return;
      emit("routine:nudge", nudge);
      try {
        notifier.fire({
          title: nudge.title,
          body: nudge.body,
          kind: `routine-${nudge.key}`,
          payload: nudge,
        });
      } catch { /* notifier may be disabled */ }
    } catch (err) {
      console.warn("[routine] nudge:", err.message);
    }
  };
  routinePoll = setInterval(tick, 60_000);
  setTimeout(tick, 6_000);
}

function listOpenApps() {
  return new Promise((resolve) => {
    const fallback = () => {
      const fg = activityTracker.status?.().current;
      resolve(fg?.app ? [{
        app: fg.app,
        title: fg.title || "",
        category: fg.category || null,
        source: "foreground",
      }] : []);
    };
    if (process.platform !== "win32") return fallback();

    const script = `
      $ErrorActionPreference='SilentlyContinue'
      Get-Process |
        Where-Object { $_.MainWindowTitle -and $_.ProcessName } |
        Sort-Object ProcessName -Unique |
        Select-Object @{Name='app';Expression={$_.ProcessName}},
                      @{Name='title';Expression={$_.MainWindowTitle}},
                      @{Name='pid';Expression={$_.Id}} |
        ConvertTo-Json -Compress
    `;
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 2500, maxBuffer: 256 * 1024 },
      (err, stdout) => {
        if (err) return fallback();
        let rows = [];
        try {
          const parsed = JSON.parse(String(stdout || "[]").trim() || "[]");
          rows = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          rows = [];
        }
        const seen = new Set();
        resolve(rows
          .map((row) => {
            const appName = String(row?.app || "").trim();
            const title = String(row?.title || "").trim();
            const key = appName.toLowerCase();
            if (!appName || seen.has(key)) return null;
            seen.add(key);
            return {
              app: appName,
              title,
              pid: row?.pid || null,
              category: activityTracker.inferCategory?.(appName, title) || null,
              source: "open",
            };
          })
          .filter(Boolean)
          .slice(0, 80));
      },
    );
  });
}

// ---- IPC surface -------------------------------------------------------------
// Keep all channel names namespaced: <domain>:<action>. Preload mirrors these.

// --- settings ---
ipcMain.handle("settings:get", (_e, key) => db.getSetting(key));
ipcMain.handle("settings:set", (_e, key, value) => db.setSetting(key, value));
ipcMain.handle("settings:delete", (_e, key) => db.deleteSetting(key));

// Tray + autostart. Renderer flips these via the standard settings:set
// path, then calls window:applyStartup so the changes take effect
// immediately (tray icon appears/disappears, login-item gets written).
ipcMain.handle("window:applyStartup", () => {
  try {
    const wantTray = db.getSetting("ui.minimizeToTray") === "1";
    if (wantTray && !tray) createTray();
    else if (!wantTray && tray) {
      try { tray.destroy(); } catch {}
      tray = null;
    }
    applyAutostartFromSettings();
    return { ok: true, tray: !!tray, status: startupStatusSnapshot() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
// Status read — Settings UI uses this to reflect the *actual* OS-level
// login-item state (vs what we wrote to settings).
ipcMain.handle("window:startupStatus", () => startupStatusSnapshot());
ipcMain.handle("settings:all", () => db.allSettings());

// --- routine guard ---
ipcMain.handle("routine:state", () => routine.getState());
ipcMain.handle("routine:saveConfig", async (_e, patch) => {
  const config = routine.saveConfig(patch || {});
  if (config.syncEnabled) routine.syncNow?.().catch(() => {});
  return config;
});
ipcMain.handle("routine:mark", async (_e, kind, payload) => {
  const event = routine.logEvent(kind, payload || {});
  if (kind === "wake_done" || kind === "sleep_done" || kind === "objective_done") {
    routine.syncNow?.().catch(() => {});
  }
  return event;
});
ipcMain.handle("routine:dismissNudge", async (_e, kind) => {
  const key = String(kind || "").toLowerCase();
  if (key === "wake") {
    const event = routine.logEvent("wake_done", { source: "desktop-dismiss" });
    routine.syncNow?.().catch(() => {});
    return { ok: true, event };
  }
  if (key === "sleep") {
    const event = routine.logEvent("sleep_done", { source: "desktop-dismiss" });
    routine.syncNow?.().catch(() => {});
    return { ok: true, event };
  }
  return { ok: false, error: "unknown-routine-nudge" };
});
ipcMain.handle("routine:approveCloseReason", async (_e, payload) => {
  const res = routine.approveCloseReason({
    ...(payload || {}),
    ...(lastCloseRequest || {}),
    appSessionId,
    appOpenAt: appOpenedAt,
    closeApprovedAt: new Date().toISOString(),
    uptimeMs: uptimeMs(),
  });
  if (res?.ok) {
    routine.syncNow?.().catch(() => {});
    const closeSource = lastCloseRequest?.source || payload?.source || "approved-close";
    setImmediate(() => {
      try {
        isQuitting = true;
        logAppCloseOnce("approved-close", {
          closeSource,
          closeReasonEventId: res.event?.id || null,
          allowUntil: res.allowUntil,
        });
        app.quit();
      } catch (err) {
        console.warn("[routine] approved close quit failed:", err.message);
      }
    });
  }
  return res;
});
ipcMain.handle("routine:syncNow", () => routine.syncNow());
ipcMain.handle("routine:listDevices", () => routine.listDevices());
ipcMain.handle("routine:revokeDevice", (_e, id) => routine.revokeDevice(id));
ipcMain.handle("routine:createPairingCode", (_e, payload) =>
  routine.createPairingCode(payload || {}),
);
ipcMain.handle("routine:pairDesktop", (_e, payload) =>
  routine.pairDesktop(payload || {}),
);

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
    const recoveryCode = db.resetDayNoteRecoveryCode();
    _dayNotesUnlockedUntil = Date.now() + DAY_NOTES_UNLOCK_TTL_MS;
    return { ok: true, recoveryCode };
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
ipcMain.handle("dayNotes:resetWithRecovery", (_e, { recoveryCode, newPasscode } = {}) => {
  if (!db.hasDayNotePasscode()) return { ok: false, error: "No passcode set" };
  if (!db.hasDayNoteRecoveryCode?.()) {
    return { ok: false, error: "No recovery code is saved for this passcode" };
  }
  if (!db.verifyDayNoteRecoveryCode?.(recoveryCode)) {
    return { ok: false, error: "Recovery code did not match" };
  }
  try {
    db.setDayNotePasscode(newPasscode);
    const nextRecoveryCode = db.resetDayNoteRecoveryCode();
    _dayNotesUnlockedUntil = Date.now() + DAY_NOTES_UNLOCK_TTL_MS;
    return { ok: true, recoveryCode: nextRecoveryCode, ttlMs: DAY_NOTES_UNLOCK_TTL_MS };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// Emergency hard-reset path. The normal forgotten-passcode flow should use
// dayNotes:resetWithRecovery, which preserves notes. This exists only for the
// case where both passcode and recovery code are lost.
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
    db.setSetting("dayNotes.recoveryHash", null);
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

// Rebuild the classes table using a new batch setting without hitting the
// network. The user flips batch in Settings → Schedule → "Your batch",
// we call this so the schedule reflects immediately.
ipcMain.handle("srm:rebuildBatch", async () => {
  try {
    _ensureSrmSessionAttached();
    return await srm.rebuildFromBatch();
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
ipcMain.handle("courseMaterials:context", (_e, opts = {}) => {
  const maxChars = Math.max(500, Math.min(20_000, +opts.maxChars || 6000));
  const items = db.listCourseMaterials({ includeBody: false }) || [];
  return {
    block: db.aiContextFromCourseMaterials({ maxChars }) || "",
    items,
    included: items.filter((x) => x.include_in_ai).length,
    total: items.length,
  };
});
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
ipcMain.handle("notifier:setHour", (_e, key, h) => notifier.setHour(key, h));
ipcMain.handle("notifier:setKindEnabled", (_e, kind, on) =>
  notifier.setKindEnabled(kind, on),
);
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

// Streaming, multi-turn chat for the interactive Ask Apex drawer. Token
// chunks are pushed to the renderer on a per-request channel; the awaited
// invoke resolves with the final assembled message. An in-flight request can
// be cancelled via ollama:chatStreamAbort using the same streamId.
const _ollamaStreamAborts = new Map();
ipcMain.handle("ollama:chatStream", async (e, payload = {}) => {
  const { streamId, model, system, messages, temperature } = payload;
  const channel = `ollama:stream:${streamId}`;
  const send = (msg) => {
    try { if (streamId && !e.sender.isDestroyed()) e.sender.send(channel, msg); } catch {}
  };
  const ctl = new AbortController();
  if (streamId) _ollamaStreamAborts.set(streamId, ctl);
  try {
    const res = await ollama.chatStream({
      model,
      system: ollama.buildSystem(system || "You are Apex, a helpful personal assistant."),
      messages,
      temperature,
      signal: ctl.signal,
      onDelta: (delta) => send({ delta }),
    });
    send({ done: true, ...res });
    return res;
  } catch (err) {
    send({ error: err.message });
    return { ok: false, error: err.message };
  } finally {
    if (streamId) _ollamaStreamAborts.delete(streamId);
  }
});
ipcMain.handle("ollama:chatStreamAbort", (_e, streamId) => {
  const ctl = _ollamaStreamAborts.get(streamId);
  if (ctl) { try { ctl.abort(); } catch {} _ollamaStreamAborts.delete(streamId); return { ok: true }; }
  return { ok: false };
});
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
ipcMain.handle("ollama:extractTasks", (_e, opts = {}) =>
  ollama.extractTasksFromText({
    ...(opts || {}),
    courseContext:
      opts?.courseContext ??
      db.aiContextFromCourseMaterials?.({ maxChars: 5000 }) ??
      "",
  }),
);

// File → text. Handles PDFs via `pdftotext` (poppler) when available;
// falls back to base64 + Ollama vision for images. Returns the raw
// extracted text so the renderer can hand it back to extractTasks for
// structured-task synthesis.
ipcMain.handle("apex:extractFromFile", async (_e, { path: filePath, model } = {}) => {
  if (!filePath) return { ok: false, error: "no path" };
  try {
    const fsMod = require("node:fs/promises");
    const stat = await fsMod.stat(filePath);
    if (!stat || !stat.isFile()) return { ok: false, error: "not a file" };
    const ext = (filePath.split(".").pop() || "").toLowerCase();

    // PDFs: try `pdftotext -layout` first. If the binary's missing OR
    // the PDF is image-only (scanned hall ticket, syllabus screenshot
    // saved as PDF), the output will be empty / a couple of whitespace
    // characters. In that case fall back to rasterising each page with
    // `pdftoppm` and running the images through Ollama vision. That
    // covers the "image-only PDF" case which was the actual bug behind
    // "Apex says it can't see the curriculum in my Hall Ticket".
    if (ext === "pdf") {
      const { spawn } = require("node:child_process");
      const os = require("node:os");
      const path = require("node:path");
      const result = await new Promise((resolve) => {
        const chunks = [];
        const errs = [];
        const p = spawn("pdftotext", ["-layout", filePath, "-"], { windowsHide: true });
        p.stdout.on("data", (d) => chunks.push(d));
        p.stderr.on("data", (d) => errs.push(d));
        p.on("error", (err) => resolve({ ok: false, error: err.message }));
        p.on("close", (code) => {
          if (code !== 0 && chunks.length === 0) {
            resolve({ ok: false, error: errs.join("") || `pdftotext exited ${code}` });
            return;
          }
          resolve({ ok: true, text: Buffer.concat(chunks).toString("utf8") });
        });
      });

      const extractedText = result.ok ? String(result.text || "") : "";
      // Heuristic: anything under ~30 chars after stripping whitespace is
      // effectively "nothing" — almost certainly an image-only PDF.
      const cleaned = extractedText.replace(/\s+/g, "").trim();
      if (result.ok && cleaned.length >= 30) {
        return { ok: true, text: extractedText, kind: "pdf" };
      }

      // FALLBACK: PDF → PNG pages → vision. Uses pdftoppm (also poppler).
      // Cap at 5 pages so we don't blow the model's context on a 50-page
      // doc. Each page is sent as its own vision message; we concatenate
      // results into one text block.
      const tmpDir = await fsMod.mkdtemp(path.join(os.tmpdir(), "apex-pdf-"));
      const prefix = path.join(tmpDir, "page");
      const rasterised = await new Promise((resolve) => {
        const errs = [];
        // -r 150 = 150dpi, enough resolution for OCR without huge images.
        // -f 1 -l 5 = pages 1 through 5 (cap so we don't blow context).
        const p = spawn("pdftoppm", ["-r", "150", "-f", "1", "-l", "5", "-png", filePath, prefix], { windowsHide: true });
        p.stderr.on("data", (d) => errs.push(d));
        p.on("error", (err) => resolve({ ok: false, error: err.message }));
        p.on("close", (code) => {
          if (code !== 0) resolve({ ok: false, error: errs.join("") || `pdftoppm exited ${code}` });
          else resolve({ ok: true });
        });
      });

      if (!rasterised.ok) {
        // Cleanup attempt + clear error.
        try { await fsMod.rm(tmpDir, { recursive: true, force: true }); } catch {}
        return {
          ok: false,
          error: result.ok && cleaned.length === 0
            ? "This PDF has no embedded text (likely scanned). Install poppler's pdftoppm for the image-OCR fallback, or send the page as a PNG/JPG directly."
            : "Couldn't run pdftotext or pdftoppm. Install poppler (Windows: `winget install poppler-utils`, macOS: `brew install poppler`) — or send the page as a PNG/JPG directly.",
        };
      }

      // Read every generated page file (pdftoppm names them
      // <prefix>-1.png, <prefix>-2.png …) and feed each to vision.
      const files = (await fsMod.readdir(tmpDir))
        .filter((f) => f.endsWith(".png"))
        .sort();
      const visionParts = [];
      for (const f of files) {
        const full = path.join(tmpDir, f);
        const buf = await fsMod.readFile(full);
        const b64 = buf.toString("base64");
        const r = await ollama.chat({
          model,
          system:
            "You are an OCR engine. Extract every piece of textual content " +
            "you see in the image — names, registration numbers, dates, " +
            "subject codes, subject names, times, room/venue, instructions. " +
            "Preserve the original tabular layout for tables. Do NOT " +
            "summarise. Output the extracted text verbatim and nothing else.",
          user: `Extract the text from this image (PDF page).`,
          images: [b64],
          temperature: 0.1,
        });
        if (r?.ok && r.content) visionParts.push(`--- Page ${f} ---\n` + r.content);
      }
      // Cleanup.
      try { await fsMod.rm(tmpDir, { recursive: true, force: true }); } catch {}

      if (visionParts.length === 0) {
        return {
          ok: false,
          error: "Couldn't read this PDF — pdftotext returned nothing and the vision fallback produced no output. Try a clearer scan or a different model (e.g. `ollama pull llama3.2-vision`).",
        };
      }
      return {
        ok: true,
        text: visionParts.join("\n\n"),
        kind: "pdf-vision",
      };
    }

    // Images: feed straight to Ollama vision. The model returns the text
    // it sees in the image. Works on screenshots of timetables, calendar
    // photos, syllabus pages, etc.
    if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
      const buf = await fsMod.readFile(filePath);
      const b64 = buf.toString("base64");
      const r = await ollama.chat({
        model,
        system:
          "You are an OCR engine. Extract every piece of textual content you " +
          "see in the image — dates, times, subject names, deadlines, " +
          "instructions. Preserve the original layout where useful (tables, " +
          "lists). Do NOT summarise or rephrase. Output the extracted text " +
          "and nothing else.",
        user: "Extract the text from this image.",
        images: [b64],
        temperature: 0.1,
      });
      if (r?.ok) return { ok: true, text: r.content || "", kind: "image" };
      return { ok: false, error: r?.error || "vision extract failed" };
    }

    // Plain text — read it back verbatim.
    if (["txt", "md", "csv", "log", "json"].includes(ext)) {
      const txt = await fsMod.readFile(filePath, "utf8");
      return { ok: true, text: txt, kind: "text" };
    }

    return {
      ok: false,
      error: `Unsupported file type: ${ext}. Supported: pdf, png, jpg, txt, md, csv, json.`,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
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
ipcMain.handle("people:deleteBulk", (_e, ids) => db.deletePeople(ids));
ipcMain.handle("people:deleteAll", () => db.deleteAllPeople());
ipcMain.handle("people:findDuplicates", () => db.findDuplicateGroups());
ipcMain.handle("people:merge", (_e, { keepId, mergeIds } = {}) =>
  db.mergePeople(keepId, mergeIds || []),
);
ipcMain.handle("people:repos", (_e, personId) => db.listRepos(personId));
ipcMain.handle("people:sync", (_e, personId) => github.syncPerson(personId));

// Sync state cache — lives in the main process so it survives page
// switches in the renderer. Each sync function is wrapped in a guard
// that (a) refuses to start a second concurrent run and (b) keeps the
// latest progress snapshot so a returning UI can re-paint itself
// without waiting for the next event tick.
const _syncState = {
  gh:  { active: false, total: 0, done: 0, ok: 0, err: 0, current: null, rateLimited: false, resetAt: null, finishedAt: null, lastResult: null },
  cp:  { active: false, total: 0, done: 0, ok: 0, err: 0, current: null, finishedAt: null, lastResult: null },
  srm: { active: false, stage: null, page: null, totalSoFar: 0, finishedAt: null, lastResult: null },
};
function setSync(kind, patch) {
  _syncState[kind] = { ..._syncState[kind], ...patch };
}
ipcMain.handle("sync:status", () => _syncState);

ipcMain.handle("people:syncAll", async (_e, opts) => {
  if (_syncState.gh.active) {
    return { ok: false, error: "already-running", status: _syncState.gh };
  }
  setSync("gh", { active: true, total: 0, done: 0, ok: 0, err: 0, current: null, rateLimited: false, resetAt: null });
  emit("people:syncProgress", _syncState.gh);
  try {
    const res = await github.syncAll((p) => {
      setSync("gh", p);
      emit("people:syncProgress", _syncState.gh);
    }, opts || {});
    setSync("gh", { active: false, finishedAt: new Date().toISOString(), lastResult: res });
    emit("people:syncProgress", _syncState.gh);
    return res;
  } catch (err) {
    setSync("gh", { active: false, finishedAt: new Date().toISOString(), lastResult: { ok: false, error: err.message } });
    emit("people:syncProgress", _syncState.gh);
    return { ok: false, error: err.message };
  }
});

// --- CP (competitive programming) ---
ipcMain.handle("cp:fetchPerson", (_e, personId) => cp.fetchAllForPerson(personId));
ipcMain.handle("cp:fetchAll", async (_e, opts) => {
  if (_syncState.cp.active) {
    return { ok: false, error: "already-running", status: _syncState.cp };
  }
  setSync("cp", { active: true, total: 0, done: 0, ok: 0, err: 0, current: null });
  emit("cp:progress", _syncState.cp);
  try {
    const res = await cp.fetchAllPeople((p) => {
      setSync("cp", p);
      emit("cp:progress", _syncState.cp);
    }, opts || {});
    setSync("cp", { active: false, finishedAt: new Date().toISOString(), lastResult: res });
    emit("cp:progress", _syncState.cp);
    return res;
  } catch (err) {
    setSync("cp", { active: false, finishedAt: new Date().toISOString(), lastResult: { ok: false, error: err.message } });
    emit("cp:progress", _syncState.cp);
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("cp:stats", (_e, personId) => db.listCpStats(personId));
ipcMain.handle("cp:submissions", (_e, personId, limit) =>
  db.recentCpSubmissions(personId, limit ?? 20),
);
ipcMain.handle("cp:self", () => cp.fetchSelf());
ipcMain.handle("cp:selfCached", () => cp.selfCached());
ipcMain.handle("cp:leaderboard", (_e, platform, opts) =>
  db.cpLeaderboard(platform, opts || {}),
);
ipcMain.handle("cp:fetchSrmLeaderboard", (event) =>
  cp.fetchSrmLeaderboard((info) => {
    try { event.sender.send("cp:srmLeaderboardProgress", info); } catch {}
  }),
);
ipcMain.handle("cp:syncSrmLeaderboard", async (event) => {
  if (_syncState.srm.active) {
    return { ok: false, error: "already-running", status: _syncState.srm };
  }
  setSync("srm", { active: true, stage: null, page: null, totalSoFar: 0 });
  event.sender.send("cp:srmLeaderboardProgress", _syncState.srm);
  try {
    const r = await cp.fetchSrmLeaderboard((info) => {
      setSync("srm", info);
      try { event.sender.send("cp:srmLeaderboardProgress", _syncState.srm); } catch {}
    });
    if (!r.ok) {
      setSync("srm", { active: false, finishedAt: new Date().toISOString(), lastResult: r });
      try { event.sender.send("cp:srmLeaderboardProgress", _syncState.srm); } catch {}
      return r;
    }
    const synced = cp.syncSrmLeaderboardToPeople(r.rows);
    const result = {
      ...synced,
      fetchedAt: r.fetchedAt,
      via: r.via,
      partial: !!r.partial,
      note: r.note,
    };
    setSync("srm", { active: false, finishedAt: new Date().toISOString(), lastResult: result });
    try { event.sender.send("cp:srmLeaderboardProgress", _syncState.srm); } catch {}
    return result;
  } catch (err) {
    setSync("srm", { active: false, finishedAt: new Date().toISOString(), lastResult: { ok: false, error: err.message } });
    try { event.sender.send("cp:srmLeaderboardProgress", _syncState.srm); } catch {}
    return { ok: false, error: err.message };
  }
});
ipcMain.handle(
  "cp:srmLeaderboardLastSync",
  () => {
    try { return JSON.parse(db.getSetting("cp.srmLeaderboard.lastSync") || "null"); }
    catch { return null; }
  },
);

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
// Manual backfill — user logs an activity that happened earlier today
// (library reading 2-4 pm, LeetCode 1h, video lecture 30 min, etc.) so
// it shows up in Top apps + the AI sees it next time it builds context.
// Saves as a real activity_sessions row with source='manual' and
// computed start/end timestamps.
ipcMain.handle("activity:addManual", (_e, p = {}) => {
  try {
    const dur = Math.max(1, Math.round(+p.minutes || 0));
    if (!dur) return { ok: false, error: "Duration required" };
    const title = (p.title || "").trim() || "manual activity";
    const category = p.category || "neutral";
    // Resolve start time. Caller can pass startedAtIso, or just
    // hours-ago, or omit (defaults to "ended now, ran for `dur` min").
    let startMs;
    if (p.startedAtIso) {
      const d = new Date(p.startedAtIso);
      if (!Number.isNaN(+d)) startMs = +d;
    }
    if (!startMs && Number.isFinite(+p.hoursAgo)) {
      startMs = Date.now() - (+p.hoursAgo) * 3600 * 1000 - dur * 60 * 1000;
    }
    if (!startMs) startMs = Date.now() - dur * 60 * 1000;
    const start = new Date(startMs);
    const end = new Date(startMs + dur * 60 * 1000);
    const iso = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    db.addActivitySession({
      date: iso,
      source: "manual",
      app: title,
      window_title: p.kind || null,
      category,
      started_at: start.toISOString(),
      ended_at: end.toISOString(),
      minutes: dur,
      note: p.description || null,
    });
    return { ok: true, date: iso, startedAtIso: start.toISOString(), minutes: dur };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle("activity:list", (_e, opts) => activity.listEntries(opts));
ipcMain.handle("activity:delete", (_e, id) => activity.deleteEntry(id));
ipcMain.handle("activity:todayTotals", () => activity.todayTotals());
ipcMain.handle("activity:buckets", (_e, date) => db.listBuckets(date));
ipcMain.handle("activity:clearAll", () => db.clearAllActivity());

// --- leisure timer (explicit user-declared breaks) ---
ipcMain.handle("leisure:active", () => db.activeLeisure());
ipcMain.handle("leisure:start", (_e, opts) => db.startLeisure(opts || {}));
ipcMain.handle("leisure:extend", (_e, mins) => db.extendLeisure(mins));
ipcMain.handle("leisure:stop", () => db.stopLeisure());
ipcMain.handle("leisure:recent", (_e, opts) => db.recentLeisure(opts || {}));
ipcMain.handle("schedule:clearAll", () => db.clearAllSchedule());
ipcMain.handle("activity:weekTotals", () => activity.weekTotals());
ipcMain.handle("activity:recentPushes", (_e, opts) =>
  activity.recentPushes(opts),
);
ipcMain.handle("activity:totalsOn", (_e, isoDate) => db.activityTotalsOn(isoDate));
ipcMain.handle("activity:trend", (_e, days) => db.activityTrend(days ?? 7));
ipcMain.handle("activity:topApps", (_e, isoDate, limit) => db.topAppsOn(isoDate ?? today(), limit ?? 10));
ipcMain.handle("activity:focusBlocks", (_e, isoDate, limit) =>
  db.focusBlocksOn(isoDate ?? today(), limit ?? 12),
);
ipcMain.handle("activity:daySummary", (_e, isoDate) =>
  db.daySummaryOn(isoDate ?? today()),
);
ipcMain.handle("activity:feed", (_e, opts) => db.listActivityFeed(opts || {}));
ipcMain.handle("activity:openApps", () => listOpenApps());
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

// Mirror productive timers to the phone's focus blocker, exactly like Zen
// does. The phone polls GET /focus and nudges/bounces distraction apps —
// so starting a plain task timer on desktop now also guards the phone
// (e.g. Instagram reels mid focus block ⇒ mobile nudge). Zen owns the
// focus channel while it's active; we never fight it from here.
function timerEndsAtIso(row) {
  const start = new Date(row.started_at).getTime();
  const totalMin = (+row.planned_minutes || 0) + (+row.extended_minutes || 0);
  if (!Number.isFinite(start) || !totalMin) return null;
  return new Date(start + totalMin * 60000).toISOString();
}
function mirrorTimerFocus(row) {
  if (db.activeZenSession?.()) return; // zen already published its block
  if (row && row.category === "productive") {
    routine.pushFocus?.({
      active: true,
      title: row.title || "Focus block",
      mode: "timer",
      endsAt: timerEndsAtIso(row),
    }).catch?.(() => {});
  } else {
    routine.pushFocus?.({ active: false }).catch?.(() => {});
  }
}
ipcMain.handle("timer:active", () => db.getActiveTimer());
ipcMain.handle("timer:start", (_e, p) => {
  // If something is already running, finish it cleanly first.
  const existing = db.getActiveTimer();
  const activeZen = db.activeZenSession?.();
  if (activeZen?.mode === "locked" && !zenCanEnd(activeZen, "stopped")) {
    return lockedZenStopError(activeZen);
  }
  if (existing) finishTimerToActivity(existing, "interrupted");
  const row = db.startTimer(p || {});
  broadcastTimer(row);
  mirrorTimerFocus(row);
  if (activeZen) broadcastZen(activeZen, { timer: row });
  // Optional Spotify focus playlist auto-play. Defined later in the file
  // (after the spotify service is required); guarded with typeof so we
  // don't blow up if the helper hasn't loaded yet.
  if (typeof _maybeStartFocusMusic === "function") _maybeStartFocusMusic(row);
  return row;
});
ipcMain.handle("timer:extend", (_e, mins) => {
  const byMinutes = +mins || 5;
  const row = db.extendTimer(byMinutes);
  const activeZen = db.activeZenSession?.();
  if (activeZen) {
    const session = db.extendZenSession?.(byMinutes);
    broadcastZen(session, { timer: row });
  }
  broadcastTimer(row);
  mirrorTimerFocus(row); // refresh the phone's ends_at
  return row;
});
ipcMain.handle("timer:stop", () => {
  const row = db.getActiveTimer();
  if (!row) return { ok: false, error: "No active timer" };
  const activeZen = db.activeZenSession?.();
  const completed = timerIsComplete(row);
  if (activeZen?.mode === "locked" && !completed && !zenCanEnd(activeZen, "stopped")) {
    return lockedZenStopError(activeZen);
  }
  const out = finishTimerToActivity(row, completed ? "completed" : "stopped");
  db.clearTimer();
  if (activeZen) finishZenSession(completed ? "completed" : "stopped", { stopTimer: false });
  else mirrorTimerFocus(null); // stand the phone blocker down
  broadcastTimer(null);
  return { ok: true, logged: out };
});
ipcMain.handle("timer:cancel", () => {
  const row = db.getActiveTimer();
  if (!row) return { ok: false };
  const activeZen = db.activeZenSession?.();
  if (activeZen?.mode === "locked" && !zenCanEnd(activeZen, "cancelled")) {
    return lockedZenStopError(activeZen);
  }
  // Cancel = discard. Only log if more than 60s elapsed so accidental
  // cancels don't pollute the activity stream.
  const minutes = elapsedMinutes(row);
  let logged = null;
  if (minutes >= 1) logged = finishTimerToActivity(row, "cancelled");
  db.clearTimer();
  if (activeZen) finishZenSession("cancelled", { stopTimer: false });
  else mirrorTimerFocus(null);
  broadcastTimer(null);
  return { ok: true, logged };
});

function elapsedMinutes(timer) {
  const start = new Date(timer.started_at).getTime();
  return Math.max(0, Math.round((Date.now() - start) / 60000));
}

function timerRemainingSeconds(timer) {
  if (!timer) return 0;
  const start = new Date(timer.started_at).getTime();
  const totalSeconds = Math.max(
    0,
    ((+timer.planned_minutes || 0) + (+timer.extended_minutes || 0)) * 60,
  );
  if (!Number.isFinite(start)) return totalSeconds;
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
  return Math.ceil(totalSeconds - elapsedSeconds);
}

function timerIsComplete(timer) {
  return timerRemainingSeconds(timer) <= 0;
}

function zenCanEnd(session, reason = "stopped") {
  if (!session || session.mode !== "locked") return true;
  if (reason === "completed" || reason === "expired" || reason === "shutdown") return true;
  const endsAt = new Date(session.ends_at).getTime();
  return Number.isFinite(endsAt) && Date.now() >= endsAt;
}

function lockedZenStopError(session) {
  return {
    ok: false,
    locked: true,
    error: "Locked focus is active. It can only stop when the timer finishes.",
    session,
  };
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

// --- Zen mode ---------------------------------------------------------------
// Guarded focus lock. Strict mode raises Apex and emits a lock overlay when
// the user moves into a blocked app; relaxed mode only records/nudges.
let zenPoll = null;
let zenLastViolationAt = 0;
let zenLastViolationKey = "";
const ZEN_POLL_MS = 4_000;
const ZEN_REPEAT_VIOLATION_MS = 12_000;

function broadcastZen(payload, extra = {}) {
  emit("zen:update", { session: payload, ...extra });
}

function normalizeZenToken(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/\.exe$/i, "")
    .trim();
}

function zenTokenMatches(fg, token) {
  const t = normalizeZenToken(token);
  if (!t) return false;
  const app = normalizeZenToken(fg?.app);
  const title = String(fg?.title || "").toLowerCase();
  return app.includes(t) || title.includes(t);
}

function isApexWindow(fg) {
  const appName = normalizeZenToken(fg?.app);
  const title = String(fg?.title || "").toLowerCase();
  return appName.includes("apex") || title.includes("apex");
}

function zenViolationReason(session, fg) {
  if (!session || !fg || isApexWindow(fg)) return null;
  const allowed = Array.isArray(session.allowed_apps) ? session.allowed_apps : [];
  const blocked = Array.isArray(session.blocked_apps) ? session.blocked_apps : [];
  if (blocked.some((token) => zenTokenMatches(fg, token))) return "blocked-app";
  if (allowed.length && !allowed.some((token) => zenTokenMatches(fg, token))) {
    return "outside-allowlist";
  }
  if (!allowed.length && fg.category === "distraction") return "distraction";
  return null;
}

function startZenMonitor() {
  if (zenPoll) return;
  zenPoll = setInterval(() => {
    zenTick().catch((err) => console.warn("[zen] tick:", err.message));
  }, ZEN_POLL_MS);
  zenTick().catch((err) => console.warn("[zen] initial tick:", err.message));
}

function stopZenMonitorIfIdle() {
  if (!zenPoll) return;
  if (db.activeZenSession?.()) return;
  clearInterval(zenPoll);
  zenPoll = null;
  zenLastViolationAt = 0;
  zenLastViolationKey = "";
}

async function zenTick() {
  const session = db.activeZenSession?.();
  if (!session) {
    stopZenMonitorIfIdle();
    return;
  }

  if (session.remaining_seconds <= 0) {
    finishZenSession("completed", { stopTimer: true });
    return;
  }

  const fg = await activityTracker.currentWindow?.();
  const reason = zenViolationReason(session, fg);
  if (!reason) return;

  const key = `${fg.app}|${fg.title}|${reason}`;
  const now = Date.now();
  if (key === zenLastViolationKey && now - zenLastViolationAt < ZEN_REPEAT_VIOLATION_MS) {
    return;
  }
  zenLastViolationKey = key;
  zenLastViolationAt = now;

  const updated = db.recordZenViolation?.({
    app: fg.app,
    title: fg.title,
    reason,
    category: fg.category,
  });
  const payload = { session: updated, foreground: fg, reason };
  emit("zen:violation", payload);
  broadcastZen(updated, { violation: { foreground: fg, reason } });

  if ((updated?.mode === "strict" || updated?.mode === "locked") && mainWindow && !mainWindow.isDestroyed()) {
    try {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.flashFrame(true);
      try {
        mainWindow.setAlwaysOnTop(true, "floating");
        setTimeout(() => {
          try {
            mainWindow?.setAlwaysOnTop?.(false);
            mainWindow?.flashFrame?.(false);
          } catch {}
        }, 4500);
      } catch {}
    } catch {}
  } else if (Notification?.isSupported?.()) {
    try {
      new Notification({
        title: "Zen drift",
        body: `${fg.app || "App"} is outside this focus block.`,
      }).show();
    } catch {}
  }
}

function finishZenSession(reason = "stopped", { stopTimer = true } = {}) {
  const current = db.activeZenSession?.();
  if (current?.mode === "locked" && !zenCanEnd(current, reason)) {
    broadcastZen(current);
    return lockedZenStopError(current);
  }
  const ended = db.stopZenSession?.(reason);
  if (!ended) return null;
  // Tell the phone the focus block is over so its blocker stands down.
  routine.pushFocus?.({ active: false }).catch?.(() => {});
  if (stopTimer) {
    const timer = db.getActiveTimer?.();
    if (timer) finishTimerToActivity(timer, reason);
    db.clearTimer?.();
    broadcastTimer(null);
  }
  broadcastZen(null, { ended });
  stopZenMonitorIfIdle();
  return ended;
}

ipcMain.handle("zen:active", () => db.activeZenSession?.() || null);
ipcMain.handle("zen:history", (_e, limit) => db.recentZenSessions?.(limit || 12) || []);
ipcMain.handle("zen:start", async (_e, p) => {
  const existing = db.getActiveTimer();
  const activeZen = db.activeZenSession?.();
  if (activeZen?.mode === "locked" && !zenCanEnd(activeZen, "stopped")) {
    return lockedZenStopError(activeZen);
  }

  const payload = { ...(p || {}) };
  if (existing) {
    const remainingMinutes = Math.max(1, Math.ceil(Math.max(0, timerRemainingSeconds(existing)) / 60));
    payload.title = payload.title || existing.title || "Focus timer";
    payload.planned_minutes = remainingMinutes;
    payload.note = payload.note || `Wrapped live timer: ${existing.title || existing.kind || "timer"}`;
  }

  const session = db.startZenSession(payload);
  const timerRow = existing || db.startTimer({
    kind: "study",
    category: "productive",
    title: session.title,
    description: `Zen mode: ${session.mode}`,
    planned_minutes: session.planned_minutes,
  });
  broadcastTimer(timerRow);
  startZenMonitor();
  broadcastZen(session, { timer: timerRow });

  // Mirror the focus block to the phone (mobile distraction blocker).
  routine.pushFocus?.({
    active: true,
    title: session.title,
    mode: session.mode,
    endsAt: session.ends_at,
  }).catch?.(() => {});

  if (session.playlist_uri && spotify?.play) {
    startZenPlaylist(session.playlist_uri).then((playlist) => {
      const live = db.activeZenSession?.();
      if (live?.id === session.id) broadcastZen(live, { playlist });
    }).catch(() => {});
  } else if (typeof _maybeStartFocusMusic === "function") {
    _maybeStartFocusMusic(timerRow);
  }
  return session;
});
ipcMain.handle("zen:extend", (_e, mins) => {
  const session = db.extendZenSession?.(+mins || 10);
  const timer = db.extendTimer(+mins || 10);
  broadcastTimer(timer);
  broadcastZen(session);
  return session;
});
ipcMain.handle("zen:stop", (_e, reason) => finishZenSession(reason || "stopped", { stopTimer: true }));

async function startZenPlaylist(uri) {
  let r = await spotify.play(uri);
  let woke = false;
  if (!r?.ok && (r?.code === "NO_DEVICES" || r?.code === "NO_ACTIVE_DEVICE")) {
    woke = true;
    try { await shell.openExternal("spotify:"); } catch {}
    await new Promise((res) => setTimeout(res, 2500));
    r = await spotify.play(uri);
  }
  if (!r?.ok) {
    const reason =
      r?.code === "PREMIUM_REQUIRED"
        ? "Spotify Premium is required for remote playback."
        : r?.code === "NO_DEVICES" || r?.code === "NO_ACTIVE_DEVICE"
          ? "Open Spotify on desktop or phone, then start Zen again."
          : (r?.error || "Could not start the focus playlist.");
    try {
      notifier.fire({
        title: "Focus music skipped",
        body: reason,
        kind: "spotify",
      });
    } catch {}
    return { ok: false, error: reason, code: r?.code || null, woke };
  }
  return { ok: true, device: r.device || null, woke };
}

// Periodic checkpoint of the active live timer into activity_sessions.
// Without this, a timer that runs for an hour doesn't show up in Top
// apps until it's stopped — and a crash mid-timer loses the time. Runs
// every 60s; idempotent via upsertActivitySession's (source, started_at)
// composite key.
const TIMER_CHECKPOINT_MS = 60_000;
setInterval(() => {
  try {
    const t = db.getActiveTimer ? db.getActiveTimer() : null;
    if (!t) return;
    const minutes = elapsedMinutes(t);
    if (minutes < 1) return; // don't pollute with sub-minute partial rows
    const noteParts = [];
    if (t.description) noteParts.push(t.description);
    noteParts.push("(in-progress)");
    db.upsertActivitySession({
      date: undefined,
      source: "timer",
      app: t.title || t.kind || "timer",
      window_title: t.kind || null,
      category: t.category || db.categoryForTimerKind(t.kind),
      started_at: t.started_at,
      ended_at: new Date().toISOString(),
      minutes,
      note: noteParts.join(" "),
    });
  } catch (e) {
    console.warn("[timer.checkpoint]", e.message);
  }
}, TIMER_CHECKPOINT_MS);

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
ipcMain.handle("wellbeing:diagnose", () => wellbeing.diagnose());
ipcMain.handle("wellbeing:syncNow", () => wellbeing.syncNow());

// --- mobile wellbeing (cloud — no USB) ---
// Pulls the phone's Digital Wellbeing usage from the shared sync API and
// writes it into activity_sessions(source='mobile'). Credentials are shared
// with the routine guard's desktop pairing.
ipcMain.handle("wellbeing:cloudStatus", () => wellbeing.cloudConfigured());
ipcMain.handle("wellbeing:pullCloud", async (_e, opts) => {
  const res = await wellbeing.pullFromCloud(opts || {});
  if (res?.ok) emit("activity:refresh", { source: "manual-pull", days: res.daysWritten || 0 });
  return res;
});
ipcMain.handle("wellbeing:setCloudAuto", async (_e, on) => {
  db.setSetting("wellbeing.cloud.auto", on ? "1" : "0");
  startCloudWellbeingAutoSync();
  // Kick an immediate pull when enabling so the user sees data right away.
  if (on) { try { await wellbeing.pullFromCloud(); } catch {} }
  return wellbeing.cloudConfigured();
});

// Background pull loop — re-checks the setting each tick and self-gates, so a
// single interval covers enable/disable without teardown bookkeeping.
let _cloudWellbeingTimer = null;
const CLOUD_WELLBEING_INTERVAL_MS = 15 * 60_000;
function startCloudWellbeingAutoSync() {
  if (_cloudWellbeingTimer) return;
  _cloudWellbeingTimer = setInterval(async () => {
    try {
      const status = wellbeing.cloudConfigured();
      if (status.auto && status.paired) {
        // Push first (tasks/routine up), then pull (phone usage + phone task
        // completions down) so each cycle is a full round-trip.
        try {
          if (routine.getConfig?.().syncEnabled) await routine.syncNow();
        } catch { /* push is best-effort */ }
        const pulled = await wellbeing.pullFromCloud();
        // Fresh phone rows landed — tell the dashboard to repaint the graph
        // and phone filter instead of waiting for a manual refresh.
        if (pulled?.ok) emit("activity:refresh", { source: "cloud-pull", days: pulled.daysWritten || 0 });
        // "I'm awake ✓" pressed on the phone's alarm → greet with the day's
        // shape: classes + the top open task, so the desktop picks up the
        // morning the moment the user does.
        if (pulled?.wokeUp) {
          try {
            const timetable = require("./services/timetable.cjs");
            const tt = timetable.today?.();
            const classes = Array.isArray(tt?.classes) ? tt.classes : [];
            const firstClass = classes[0];
            const open = (db.listTasks?.({ kind: "task", completed: false }) || [])
              .sort((a, b) => (a.priority || 3) - (b.priority || 3));
            const parts = [];
            parts.push(classes.length
              ? `${classes.length} class${classes.length === 1 ? "" : "es"} today${firstClass ? `, first at ${firstClass.start_time}` : ""}`
              : "No classes today");
            if (open[0]) parts.push(`Top task: ${open[0].title}`);
            notifier.fire({
              title: "Good morning — you're up ✓",
              body: parts.join(" · "),
              kind: "wake-brief",
            });
          } catch { /* brief is a bonus, never fatal */ }
        }
      }
    } catch { /* non-fatal */ }
  }, CLOUD_WELLBEING_INTERVAL_MS);
  if (_cloudWellbeingTimer.unref) _cloudWellbeingTimer.unref();
}

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
// Topic search across cached repos (local + person-attributed).
ipcMain.handle("repo:searchLocal", (_e, q, limit) =>
  db.searchAllRepos(q, limit || 80),
);

// Batch-summarize repos that either have no AI summary or were summarized
// before the latest push. Lets "Browse repos" become semantic — the
// stored payload includes oneliner / architecture / tech_stack which
// searchAllRepos folds into its match hay. Emits a progress event per
// repo so a UI can show the queue burning down.
ipcMain.handle(
  "repo:summarizeAll",
  async (event, { force, max, model } = {}) => {
    try {
      const dbh = db._db();
      const rows = dbh
        .prepare(
          `SELECT r.id, r.name, r.full_name, r.pushed_at, rs.created_at AS summarized_at
             FROM repos r
             LEFT JOIN repo_summaries rs ON rs.repo_id = r.id
            ORDER BY r.pushed_at DESC NULLS LAST`,
        )
        .all();
      // Stale = never summarized OR pushed after last summary.
      const stale = rows.filter((r) => {
        if (force) return true;
        if (!r.summarized_at) return true;
        if (!r.pushed_at) return false;
        return r.pushed_at > r.summarized_at;
      });
      const limit = Math.max(1, Math.min(50, +max || 10));
      const queue = stale.slice(0, limit);
      const results = [];
      for (let i = 0; i < queue.length; i++) {
        const r = queue[i];
        try { event.sender.send("repo:summarizeProgress", { i, total: queue.length, current: r.name }); } catch {}
        try {
          const detail = await github.fetchRepoDetail(r.id);
          const res = await ollama.summarizeRepo({
            repo: { ...detail.repo, languages: Object.keys(detail.languages || {}) },
            readme: detail.readme,
            ownRepos: [],
            paths: detail.paths || [],
            manifests: detail.manifests || {},
            treeTruncated: !!detail.treeTruncated,
            model,
          });
          if (res?.ok) {
            db.saveRepoSummary(r.id, res, res.model || model || null);
            results.push({ id: r.id, ok: true });
          } else {
            results.push({ id: r.id, ok: false, error: res?.error });
          }
        } catch (err) {
          results.push({ id: r.id, ok: false, error: err.message });
        }
      }
      try { event.sender.send("repo:summarizeProgress", { i: queue.length, total: queue.length, done: true }); } catch {}
      return {
        ok: true,
        totalStale: stale.length,
        processed: queue.length,
        remaining: Math.max(0, stale.length - queue.length),
        results,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
);
ipcMain.handle("repo:summarizeStats", () => {
  const dbh = db._db();
  const total = dbh.prepare("SELECT COUNT(*) AS c FROM repos").get().c;
  const withSummary = dbh
    .prepare(
      `SELECT COUNT(*) AS c FROM repos r
         JOIN repo_summaries rs ON rs.repo_id = r.id
        WHERE r.pushed_at IS NULL OR rs.created_at >= r.pushed_at`,
    )
    .get().c;
  return { total, withSummary, stale: total - withSummary };
});
// Public GitHub search — "what has the community built for this topic".
ipcMain.handle("repo:searchPublic", (_e, q, opts) =>
  github.searchPublicRepos(q, opts || {}),
);

// File tree + content for the interactive walkthrough panel. Cheap calls
// — github.fetchTree caches via the underlying ETag, so repeat hits are
// effectively free.
ipcMain.handle("repo:tree", async (_e, fullName) => {
  try {
    const tree = await github.fetchTree(fullName);
    if (!tree) return { ok: false, error: "Tree not available" };
    const paths = (tree.tree || [])
      .filter((n) => n.type === "blob")
      .map((n) => ({ path: n.path, size: n.size || 0 }));
    return { ok: true, paths, truncated: !!tree.truncated };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle(
  "repo:fileContent",
  async (_e, { fullName, path, maxBytes } = {}) => {
    try {
      const text = await github.fetchFileContent(fullName, path, maxBytes || 16000);
      return { ok: true, content: text || "" };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
);
// Walkthrough: per-file teacher-style explanation. Renderer holds the
// visited-paths history + the planned tour and passes both back each call.
// The tour plan lets the model build narrative continuity ("you saw X
// earlier, this builds on it / you'll see Y next").
ipcMain.handle(
  "repo:walkthrough",
  async (_e, { repoId, fullName, filePath, visitedPaths, tourPlan, stepIndex, model } = {}) => {
    try {
      const detail = await github.fetchRepoDetail(repoId);
      const repo = detail?.repo || { full_name: fullName };
      const content = await github.fetchFileContent(
        repo.full_name || fullName,
        filePath,
        16000,
      );
      const tree = (detail?.paths || []).slice(0, 60);
      const r = await ollama.walkthroughFile({
        repo: {
          ...repo,
          languages: Object.keys(detail?.languages || {}),
        },
        filePath,
        fileContent: content || "",
        visitedPaths: visitedPaths || [],
        treeSnapshot: tree,
        tourPlan: tourPlan || null,
        stepIndex: typeof stepIndex === "number" ? stepIndex : -1,
        model,
      });
      return { ok: !!r?.ok, ...r, fileContent: content || "", treeSnapshot: tree };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
);
// Recap: end-of-tour synthesis. Tells the user how all the files they've
// just walked through fit together.
ipcMain.handle(
  "repo:walkthroughRecap",
  async (_e, { repoId, fullName, tourPlan, model } = {}) => {
    try {
      const detail = await github.fetchRepoDetail(repoId);
      const repo = detail?.repo || { full_name: fullName };
      return await ollama.walkthroughRecap({
        repo: { ...repo, languages: Object.keys(detail?.languages || {}) },
        tourPlan: tourPlan || [],
        treeSnapshot: (detail?.paths || []).slice(0, 60),
        model,
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
);
// Multi-signal similarity scoring. We don't just look at the primary
// language — we score each of the user's repos against the target on:
//   - languages overlap (count of shared, weighted by surface area)
//   - topics overlap (GitHub `topics` array — strong framework signal)
//   - keyword overlap in name + description (catches "react", "express",
//     "nextjs", "tauri" etc. when topics aren't set)
// Topics + name keywords are heavier signals than a shared language alone,
// so a user's React project compared to a target React project beats two
// random Python repos that just happen to share `python`.

// `topics` may arrive as either an array (live GitHub) or a JSON-encoded
// TEXT string (from the DB). Coerce to an array of lowercase strings.
function asTopicsArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map((s) => String(s).toLowerCase());
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed)
        ? parsed.filter(Boolean).map((s) => String(s).toLowerCase())
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function scoreSimilarity(target, mine) {
  const tLangs = new Set((target.languages || []).map((s) => s.toLowerCase()));
  const tTopics = new Set(asTopicsArray(target.topics));
  const tKeywords = new Set(
    (
      (target.name || "") + " " +
      (target.description || "") + " " +
      [...tTopics].join(" ")
    )
      .toLowerCase()
      .split(/[^a-z0-9+]+/)
      .filter((w) => w.length >= 3),
  );

  const mLangs = mine.language ? [mine.language.toLowerCase()] : [];
  const mTopics = asTopicsArray(mine.topics);
  const mKeywords = (
    (mine.name || "") + " " +
    (mine.description || "") + " " +
    mTopics.join(" ")
  )
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter((w) => w.length >= 3);

  const overlapLangs = mLangs.filter((l) => tLangs.has(l));
  const overlapTopics = mTopics.filter((t) => tTopics.has(t));
  const overlapKeywords = [...new Set(mKeywords.filter((k) => tKeywords.has(k)))];

  // Score: language=2, topic=4, keyword=1. Topics are the strongest
  // framework signal so they get the biggest weight.
  const score =
    overlapLangs.length * 2 +
    overlapTopics.length * 4 +
    overlapKeywords.length * 1;

  return { score, overlapLangs, overlapTopics, overlapKeywords };
}

ipcMain.handle(
  "repo:similarToMine",
  async (_e, { repoId, myUsername } = {}) => {
    try {
      const detail = await github.fetchRepoDetail(repoId);
      const targetMeta = {
        name: detail?.repo?.name || "",
        description: detail?.repo?.description || "",
        languages: Object.keys(detail?.languages || {}),
        topics: detail?.repo?.topics || [],
      };
      const username = (myUsername || db.getSetting("github.username") || "")
        .trim();
      if (!username) {
        return {
          ok: false,
          error: "no-username",
          message: "Set your GitHub username in Settings → Integrations → GitHub.",
        };
      }

      // 1) Fast path — DB lookup if the user is already a person + synced.
      let myRepos = [];
      const me = db._db()
        .prepare("SELECT id FROM people WHERE LOWER(github_username) = LOWER(?)")
        .get(username);
      if (me) myRepos = db.listRepos(me.id) || [];

      // 2) Fallback — live GitHub fetch. Cheap (one API call) and always
      // current. We don't try to persist these because they're "yours";
      // we just want to render the compare panel.
      let liveFetched = false;
      if (!myRepos.length) {
        try {
          const live = await github.fetchRepos(username, { includeForks: false });
          myRepos = (live || []).map((r) => ({
            id: r.id || `live-${r.name}`,
            name: r.name,
            full_name: r.full_name,
            description: r.description,
            url: r.html_url || r.url,
            language: r.language,
            topics: r.topics || [],
            stars: r.stargazers_count ?? r.stars ?? 0,
            forks: r.forks_count ?? r.forks ?? 0,
            pushed_at: r.pushed_at,
          }));
          liveFetched = true;
        } catch (err) {
          return {
            ok: false,
            error: "github-fetch-failed",
            message: `Could not fetch ${username}'s repos: ${err.message}`,
          };
        }
      }

      const matches = myRepos
        .map((r) => {
          // Some DB rows have topics as a JSON string column; parse it.
          let topics = r.topics;
          if (typeof topics === "string") {
            try { topics = JSON.parse(topics); } catch { topics = []; }
          }
          if (!Array.isArray(topics)) topics = [];
          const sim = scoreSimilarity(targetMeta, { ...r, topics });
          return {
            repo: { ...r, topics },
            ...sim,
          };
        })
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score || (b.repo.stars || 0) - (a.repo.stars || 0))
        .slice(0, 12);

      return {
        ok: true,
        matches,
        target: targetMeta,
        viaLive: liveFetched,
        myUsername: username,
        myRepoCount: myRepos.length,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
);

// Pull a deeper compare between the target repo and one of the user's
// repos. Fetches both repos' tree + manifests + READMEs, then asks
// Ollama to produce a structured comparison: shared patterns, what each
// does differently, what the user's repo could borrow. Optional
// follow-up Q&A keeps the conversation grounded in BOTH project contexts.
ipcMain.handle(
  "repo:compareWithMine",
  async (_e, { repoId, mineFullName, history, question, model } = {}) => {
    try {
      const targetDetail = await github.fetchRepoDetail(repoId);
      // Mine is identified by full_name (live or DB). Find a repoId if the
      // DB has it; otherwise fetch tree + readme directly.
      const dbh = db._db();
      const myRow = mineFullName
        ? dbh
            .prepare("SELECT id FROM repos WHERE LOWER(full_name) = LOWER(?)")
            .get(mineFullName)
        : null;
      let mineDetail;
      if (myRow) {
        mineDetail = await github.fetchRepoDetail(myRow.id);
      } else if (mineFullName) {
        // Live path — assemble the same shape from primitive fetches.
        const [tree, readme, languages] = await Promise.all([
          github.fetchTree(mineFullName).catch(() => null),
          github.fetchReadme(mineFullName).catch(() => null),
          github.fetchLanguages(mineFullName).catch(() => ({})),
        ]);
        mineDetail = {
          repo: { full_name: mineFullName, name: mineFullName.split("/")[1] },
          paths: tree?.tree
            ? tree.tree.filter((n) => n.type === "blob").map((n) => n.path).slice(0, 200)
            : [],
          readme,
          languages,
          manifests: {},
        };
      } else {
        return { ok: false, error: "no mineFullName" };
      }

      // Run the comparison. If `question` is set, treat it as a chat
      // follow-up; otherwise produce the initial structured comparison.
      const r = await ollama.compareRepos({
        target: {
          ...targetDetail.repo,
          languages: Object.keys(targetDetail.languages || {}),
          paths: targetDetail.paths || [],
          readme: targetDetail.readme,
          manifests: targetDetail.manifests || {},
        },
        mine: {
          ...mineDetail.repo,
          languages: Object.keys(mineDetail.languages || {}),
          paths: mineDetail.paths || [],
          readme: mineDetail.readme,
          manifests: mineDetail.manifests || {},
        },
        history: history || [],
        question: question || null,
        model,
      });
      return r;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
);
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
      // recentCpSubmissions takes positional args (personId, limit). Earlier
      // code passed an object which made better-sqlite3 throw "Too few
      // parameter values were provided" because the prepared statement
      // ended up with NaN as the LIMIT.
      submissions = db.recentCpSubmissions?.(personId, 60) || [];
    } else {
      person = { name: name || "you" };
      try {
        const raw = db.getSetting("cp.self.snapshot");
        if (raw) stats = JSON.parse(raw);
      } catch { /* ignore */ }
      // Self has no person_id row; skip submissions to avoid the same bug.
      submissions = [];
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

// --- spotify (oauth + transport) ---
const spotify = require("./services/spotify.cjs");
ipcMain.handle("spotify:connect", () =>
  spotify.connect({ BrowserWindow, session }),
);
ipcMain.handle("spotify:disconnect", () => spotify.disconnect());
ipcMain.handle("spotify:status", () => spotify.status());
ipcMain.handle("spotify:nowPlaying", () => spotify.nowPlaying());
ipcMain.handle("spotify:play", (_e, uri) => spotify.play(uri));
ipcMain.handle("spotify:pause", () => spotify.pause());
ipcMain.handle("spotify:next", () => spotify.next());
ipcMain.handle("spotify:previous", () => spotify.previous());
ipcMain.handle("spotify:myPlaylists", (_e, limit) => spotify.myPlaylists(limit));
ipcMain.handle("spotify:searchPlaylists", (_e, q, limit) =>
  spotify.searchPlaylists(q, limit),
);
ipcMain.handle("spotify:setFocusPlaylist", (_e, p) =>
  spotify.setFocusPlaylist(p || {}),
);
ipcMain.handle("spotify:setAutoPlayFocus", (_e, on) =>
  spotify.setAutoPlayFocus(!!on),
);
ipcMain.handle("spotify:setClientId", (_e, id) => spotify.setClientId(id));
ipcMain.handle("spotify:playFocusPlaylist", () => spotify.playFocusPlaylist());
ipcMain.handle("spotify:devices", () => spotify.devices());
ipcMain.handle("spotify:setShuffle", (_e, on) => spotify.setShuffle(!!on));
ipcMain.handle("spotify:setRepeat", (_e, state) => spotify.setRepeat(state));
ipcMain.handle("spotify:setVolume", (_e, v) => spotify.setVolume(v));
ipcMain.handle("spotify:seek", (_e, ms) => spotify.seek(ms));
ipcMain.handle("spotify:transferTo", (_e, id, startPlaying) =>
  spotify.transferTo(id, !!startPlaying),
);
ipcMain.handle("spotify:queue", (_e, uri) => spotify.addToQueue(uri));
ipcMain.handle("spotify:recent", (_e, n) => spotify.recent(n));
ipcMain.handle("spotify:topTracks", (_e, n) => spotify.topTracks(n));
ipcMain.handle("spotify:likedSongs", (_e, n) => spotify.likedSongs(n));
ipcMain.handle("spotify:isTrackSaved", (_e, uri) => spotify.isTrackSaved(uri));
ipcMain.handle("spotify:saveTrack", (_e, uri) => spotify.saveTrack(uri));
ipcMain.handle("spotify:unsaveTrack", (_e, uri) => spotify.unsaveTrack(uri));

// ── Playlist Manager IPC handlers ─────────────────────────────────────────
// All long-running ops accept an onProgress callback that pushes live
// updates to the renderer via `spotify:progress` so the UI can show a bar.
function _spProg(event) {
  return (p) => { try { event.sender.send("spotify:progress", p); } catch { /* win closed */ } };
}
ipcMain.handle("spotify:exportSyncLiked", (e, opts) =>
  spotify.exportSyncLiked(opts || {}, _spProg(e)));
ipcMain.handle("spotify:sortPlaylist", (e, opts) =>
  spotify.sortPlaylist(opts || {}, _spProg(e)));
ipcMain.handle("spotify:audioDashboard", (e, opts) =>
  spotify.audioDashboard(opts || {}, _spProg(e)));
ipcMain.handle("spotify:detectPlaylistDuplicates", (e, opts) =>
  spotify.detectPlaylistDuplicates(opts || {}, _spProg(e)));
ipcMain.handle("spotify:removeExactDuplicates", (e, opts) =>
  spotify.removeExactDuplicates(opts || {}, _spProg(e)));
ipcMain.handle("spotify:applyMoodArc", (e, opts) =>
  spotify.applyMoodArc(opts || {}, _spProg(e)));
ipcMain.handle("spotify:backupPlaylist", (e, opts) =>
  spotify.backupPlaylist(opts || {}, _spProg(e)));
ipcMain.handle("spotify:listBackups", () => spotify.listBackups());
ipcMain.handle("spotify:restorePlaylist", (e, opts) =>
  spotify.restorePlaylist(opts || {}, _spProg(e)));
ipcMain.handle("spotify:smartFilter", (e, opts) =>
  spotify.smartFilter(opts || {}, _spProg(e)));
ipcMain.handle("spotify:crossPlaylistDupes", (e) =>
  spotify.crossPlaylistDupes(_spProg(e)));
ipcMain.handle("spotify:mergePlaylists", (e, opts) =>
  spotify.mergePlaylists(opts || {}, _spProg(e)));
ipcMain.handle("spotify:timeMachine", (e, opts) =>
  spotify.timeMachine(opts || {}, _spProg(e)));
ipcMain.handle("spotify:createFocusPlaylist", (e, opts) =>
  spotify.createFocusPlaylist(opts || {}, _spProg(e)));

// Auto-play the focus playlist when a productive timer starts, if the
// user opted in. Hooked here (not in the timer service) so we don't
// couple Spotify into the core data layer.
//
// Spotify's Web API can only control playback on an *active* device.
// If nothing is open we try to wake the desktop app (best-effort) and
// retry once. If that still fails, we surface a real notification so
// the user knows WHY the music didn't start instead of silently dying.
async function _maybeStartFocusMusic(timerRow) {
  try {
    if (!timerRow) return;
    if (db.getSetting("spotify.autoPlayFocus") !== "1") return;
    const productiveKinds = new Set(["task", "study", "habit"]);
    const isProductive =
      timerRow.category === "productive" ||
      productiveKinds.has(timerRow.kind);
    if (!isProductive) return;
    const uri = db.getSetting("spotify.focusPlaylistUri");
    if (!uri) return;

    let r = await spotify.play(uri);
    if (!r?.ok && (r?.code === "NO_DEVICES" || r?.code === "NO_ACTIVE_DEVICE")) {
      // No reachable Spotify session -- try to wake the desktop app,
      // wait a couple seconds for it to register, then retry.
      try { await shell.openExternal("spotify:"); } catch { /* may not be installed */ }
      await new Promise((res) => setTimeout(res, 2500));
      r = await spotify.play(uri);
    }

    if (!r?.ok) {
      const reason =
        r?.code === "PREMIUM_REQUIRED"
          ? "Spotify Premium is required for remote playback."
          : r?.code === "NO_DEVICES" || r?.code === "NO_ACTIVE_DEVICE"
            ? "Open Spotify on your desktop or phone, then start the timer again."
            : (r?.error || "Could not start the focus playlist.");
      console.warn("[spotify.autoPlay] failed:", reason);
      try {
        notifier.fire({
          title: "Couldn't start focus music",
          body: reason,
          kind: "spotify",
        });
      } catch { /* notifier may be off */ }
    } else {
      console.log(
        "[spotify.autoPlay] started focus playlist on",
        r.device || "active device",
      );
    }
  } catch (e) {
    console.warn("[spotify.autoPlay]", e.message);
  }
}

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
