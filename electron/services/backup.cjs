// Apex — backup/restore. Local-first app means YOU own the data, so we make
// it trivial to take it with you.
// Export: copies apex.sqlite to a user-chosen location (with WAL checkpoint).
// Import: replaces apex.sqlite from a user-chosen file.

const path = require("node:path");
const fs = require("node:fs");
const { app, dialog, BrowserWindow } = require("electron");
const db = require("./db.cjs");

function sqlitePath() {
  // Must match db.cjs: Documents/Apex/apex.sqlite
  return path.join(app.getPath("documents"), "Apex", "apex.sqlite");
}

async function exportDb() {
  // Checkpoint WAL so the .sqlite file is complete on disk before we copy.
  try {
    db._db().pragma("wal_checkpoint(TRUNCATE)");
  } catch (e) {
    /* ignore */
  }

  const now = new Date();
  const defaultName = `apex-backup-${now.toISOString().slice(0, 10)}.sqlite`;
  const res = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    defaultPath: defaultName,
    filters: [{ name: "SQLite", extensions: ["sqlite", "db"] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };

  try {
    fs.copyFileSync(sqlitePath(), res.filePath);
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function importDb() {
  const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    properties: ["openFile"],
    filters: [{ name: "SQLite", extensions: ["sqlite", "db"] }],
  });
  if (res.canceled || res.filePaths.length === 0)
    return { ok: false, canceled: true };

  const src = res.filePaths[0];
  const confirm = await dialog.showMessageBox(
    BrowserWindow.getFocusedWindow(),
    {
      type: "warning",
      buttons: ["Cancel", "Replace my data"],
      defaultId: 0,
      cancelId: 0,
      title: "Replace database?",
      message:
        "This will REPLACE your current Apex database with the file you selected.",
      detail: `From: ${src}\nThe current DB will be backed up next to it as apex-prev.sqlite.\nApex will quit; relaunch it after.`,
    },
  );
  if (confirm.response !== 1) return { ok: false, canceled: true };

  try {
    const current = sqlitePath();
    const prev = current.replace(/\.sqlite$/, "-prev.sqlite");
    if (fs.existsSync(current)) fs.copyFileSync(current, prev);
    fs.copyFileSync(src, current);
    // Force quit so SQLite/WAL handles are released cleanly before next boot.
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function dbInfo() {
  const p = sqlitePath();
  try {
    const st = fs.statSync(p);
    return { path: p, sizeBytes: st.size, modified: st.mtime.toISOString() };
  } catch {
    return { path: p, sizeBytes: 0, modified: null };
  }
}

module.exports = { exportDb, importDb, dbInfo };
