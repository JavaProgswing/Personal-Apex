// Apex — SQLite data service. All persistence lives here.
// Uses better-sqlite3 (synchronous, fast, perfect for Electron main).

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { app } = require("electron");
const Database = require("better-sqlite3");

let db = null;

// DB lives at Documents/Apex/apex.sqlite — AppData was wiping the file for
// the user. The legacy AppData DB is migrated once on first v0.2 boot.
function dbPath() {
  const override = process.env.APEX_DB_DIR || null;
  const docsDir = override || path.join(app.getPath("documents"), "Apex");
  fs.mkdirSync(docsDir, { recursive: true });
  return path.join(docsDir, "apex.sqlite");
}

function legacyDbPath() {
  try {
    return path.join(app.getPath("userData"), "apex.sqlite");
  } catch {
    return null;
  }
}

function migrateFromLegacy() {
  const target = dbPath();
  if (fs.existsSync(target)) return;
  const legacy = legacyDbPath();
  if (!legacy || !fs.existsSync(legacy)) return;
  try {
    fs.copyFileSync(legacy, target);
    for (const ext of ["-wal", "-shm"]) {
      if (fs.existsSync(legacy + ext))
        fs.copyFileSync(legacy + ext, target + ext);
    }
    console.log("[db] migrated legacy DB from", legacy, "->", target);
  } catch (err) {
    console.warn("[db] legacy migration failed (non-fatal):", err.message);
  }
}

async function init() {
  migrateFromLegacy();
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const schemaPath = path.join(__dirname, "..", "..", "db", "schema.sql");
  db.exec(fs.readFileSync(schemaPath, "utf-8"));

  runMigrations();

  // Seed classes table on FIRST RUN only. Once the user has interacted
  // with their timetable (even by deleting every row), we record a
  // `classes.seeded` setting so subsequent boots don't re-add the
  // defaults. Previously, deleting every class meant the seeder fired
  // again on next launch — the user complaint "academic year finished
  // but classes come back when I restart". Fix: gate by the setting,
  // not by empty-table.
  try {
    const seededBefore = db.prepare(
      "SELECT value FROM settings WHERE key = 'classes.seeded'",
    ).get();
    const cRow = db.prepare("SELECT COUNT(*) AS c FROM classes").get();
    if (cRow.c === 0 && !seededBefore) {
      require("./timetable.cjs").seedDefaultClasses();
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('classes.seeded', '1')",
      ).run();
      console.log("[db] seeded default classes (first run)");
    } else if (cRow.c > 0 && !seededBefore) {
      // Migrate: existing DBs already have classes — record that fact
      // so we don't ever re-seed if they later delete them.
      db.prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('classes.seeded', '1')",
      ).run();
    }
  } catch (e) {
    console.warn("[db] class seed skipped:", e.message);
  }

  // Seed weekly_goals defaults (replaces the old "weekly_focus" UI).
  const row = db.prepare("SELECT COUNT(*) AS c FROM weekly_goals").get();
  if (row.c === 0) {
    const ins = db.prepare(
      "INSERT INTO weekly_goals (title, target, progress, sort) VALUES (?, ?, ?, ?)",
    );
    const seed = [
      ["LeetCode problems", 10, 0, 1],
      ["Deep-work hours", 15, 0, 2],
      ["GitHub commit days", 5, 0, 3],
      ["Project ship", 1, 0, 4],
    ];
    const tx = db.transaction(() =>
      seed.forEach(([t, tg, p, s]) => ins.run(t, tg, p, s)),
    );
    tx();
  }

  // Seed recurring course tasks (habits) for every unique course code.
  try {
    seedCourseHabits();
  } catch (e) {
    console.warn("[db] course habit seed skipped:", e.message);
  }

  // One-shot cleanup of role-like names that leaked in from the NextTechLab
  // scraper ("associate", "mentor", etc. mistaken for a person's name).
  try {
    cleanupRolePeople();
  } catch (e) {
    console.warn("[db] role-name cleanup skipped:", e.message);
  }

  console.log("[db] ready at", dbPath());
}

// ───────────────────────────────────────────────────────────────────────────
// Forward-only, idempotent ALTER TABLEs. The whole DB is small so we just
// poll PRAGMA table_info and add columns.
// ───────────────────────────────────────────────────────────────────────────
function runMigrations() {
  const has = (table, col) => {
    try {
      return db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((r) => r.name === col);
    } catch {
      return false;
    }
  };
  const tryExec = (sql) => {
    try {
      db.exec(sql);
    } catch (_) {
      /* already applied */
    }
  };

  // tasks: expand schema for kind=interest/habit + course_code linkage.
  if (!has("tasks", "kind"))
    tryExec(`ALTER TABLE tasks ADD COLUMN kind TEXT DEFAULT 'task'`);
  if (!has("tasks", "progress"))
    tryExec(`ALTER TABLE tasks ADD COLUMN progress INTEGER DEFAULT 0`);
  if (!has("tasks", "status"))
    tryExec(`ALTER TABLE tasks ADD COLUMN status TEXT`);
  if (!has("tasks", "links"))
    tryExec(`ALTER TABLE tasks ADD COLUMN links TEXT`);
  if (!has("tasks", "recurrence_rule"))
    tryExec(`ALTER TABLE tasks ADD COLUMN recurrence_rule TEXT`);
  if (!has("tasks", "course_code"))
    tryExec(`ALTER TABLE tasks ADD COLUMN course_code TEXT`);
  tryExec(`CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    at TEXT NOT NULL,
    task_id INTEGER,
    action TEXT NOT NULL,
    title TEXT,
    payload TEXT NOT NULL DEFAULT '{}'
  )`);
  tryExec(`CREATE INDEX IF NOT EXISTS idx_task_events_date ON task_events(date)`);
  tryExec(`CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id)`);

  // people: CP handles + last_scraped_at.
  for (const col of [
    "leetcode_username",
    "codeforces_username",
    "codechef_username",
    "last_scraped_at",
  ]) {
    if (!has("people", col))
      tryExec(`ALTER TABLE people ADD COLUMN ${col} TEXT`);
  }

  // classes: slot + faculty columns (late-added).
  for (const col of ["slot", "faculty"]) {
    if (!has("classes", col))
      tryExec(`ALTER TABLE classes ADD COLUMN ${col} TEXT`);
  }

  // cp_stats: error column for rate-limit/404 messages.
  if (!has("cp_stats", "error"))
    tryExec(`ALTER TABLE cp_stats ADD COLUMN error TEXT`);

  // One-shot cleanup: remove rows for Windows system processes that
   // earlier builds were recording (LockApp, ApplicationFrameHost, etc).
  // Gated on a setting so it only runs once per machine.
  try {
    const cleaned = db.prepare(
      "SELECT value FROM settings WHERE key = 'cleanup.systemProcs.v1'",
    ).get();
    if (!cleaned) {
      const pattern = "%LockApp%";
      const patterns = [
        "%LockApp%", "%lock_app%", "%ApplicationFrameHost%",
        "%SearchHost%", "%SearchUI%", "%ShellExperienceHost%",
        "%StartMenuExperienceHost%", "%TextInputHost%", "%SystemSettings%",
      ];
      const tx = db.transaction(() => {
        for (const p of patterns) {
          try { db.prepare("DELETE FROM activity_buckets WHERE app_name LIKE ?").run(p); } catch {}
          try { db.prepare("DELETE FROM activity_sessions WHERE app LIKE ?").run(p); } catch {}
          try { db.prepare("DELETE FROM time_entries WHERE app_name LIKE ?").run(p); } catch {}
        }
        db.prepare(
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('cleanup.systemProcs.v1', '1')",
        ).run();
      });
      tx();
    }
  } catch (e) {
    console.warn("[db] system-process cleanup skipped:", e.message);
  }

  // activity_buckets: 10-minute-window storage. One row per (date,
  // bucket_start_min, app_name). bucket_start_min is the start of the
  // 10-min window in minutes-since-midnight (0, 10, 20, …, 1430).
  // The tracker writes once per bucket close; the dashboard renders a
  // timeline of buckets, each showing which apps ran in which slice.
  tryExec(`CREATE TABLE IF NOT EXISTS activity_buckets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    bucket_start_min INTEGER NOT NULL,
    app_name TEXT NOT NULL,
    category TEXT,
    minutes INTEGER NOT NULL DEFAULT 0,
    UNIQUE(date, bucket_start_min, app_name)
  )`);
  tryExec(`CREATE INDEX IF NOT EXISTS idx_buckets_date ON activity_buckets(date)`);

  // leisure_segments — explicit user-declared "I'm on a break / leisure
  // / lunch / scroll" intervals. Coexists with the auto-tracker but
  // takes priority for context: when the AI asks "what was I doing
  // 14:00-15:00", a leisure_segments row says "explicit break" even if
  // the tracker says "Brave was foreground" (which would otherwise be
  // mislabeled productive). Open segments have ended_at = NULL.
  tryExec(`CREATE TABLE IF NOT EXISTS leisure_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    estimated_minutes INTEGER,
    label TEXT,
    kind TEXT DEFAULT 'leisure',
    note TEXT
  )`);
  tryExec(`CREATE INDEX IF NOT EXISTS idx_leisure_started ON leisure_segments(started_at)`);

  // zen_sessions — focus blocks that wrap the live timer with allowed/
  // blocked app policy, strict/relaxed mode, and an optional Spotify playlist.
  tryExec(`CREATE TABLE IF NOT EXISTS zen_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'active',
    mode TEXT NOT NULL DEFAULT 'strict',
    title TEXT NOT NULL DEFAULT 'Deep work',
    profile TEXT NOT NULL DEFAULT 'deep',
    allowed_apps TEXT NOT NULL DEFAULT '[]',
    blocked_apps TEXT NOT NULL DEFAULT '[]',
    planned_minutes INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    ended_at TEXT,
    violations INTEGER NOT NULL DEFAULT 0,
    last_violation_at TEXT,
    last_violation_app TEXT,
    last_violation_title TEXT,
    playlist_id TEXT,
    playlist_uri TEXT,
    playlist_name TEXT,
    created_playlist INTEGER NOT NULL DEFAULT 0,
    note TEXT
  )`);
  tryExec(`CREATE INDEX IF NOT EXISTS idx_zen_status ON zen_sessions(status)`);
  tryExec(`CREATE INDEX IF NOT EXISTS idx_zen_started ON zen_sessions(started_at)`);
  tryExec(`CREATE TABLE IF NOT EXISTS zen_violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    at TEXT NOT NULL,
    app TEXT,
    title TEXT,
    reason TEXT,
    category TEXT
  )`);
  tryExec(`CREATE INDEX IF NOT EXISTS idx_zen_violations_session ON zen_violations(session_id)`);

  // Post-migration indexes: these reference columns that may have just been
  // added by the ALTERs above, so they can't live in schema.sql (which runs
  // before migrations). IF NOT EXISTS makes them idempotent.
  if (has("tasks", "kind"))
    tryExec(`CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind)`);
  if (has("tasks", "course_code"))
    tryExec(
      `CREATE INDEX IF NOT EXISTS idx_tasks_course ON tasks(course_code)`,
    );

  // one-time migration: interests → tasks(kind='interest').
  if (tableExists("interests")) {
    const already = db
      .prepare(`SELECT COUNT(*) AS c FROM tasks WHERE kind='interest'`)
      .get().c;
    if (already === 0) {
      const oldRows = db.prepare("SELECT * FROM interests").all();
      const ins = db.prepare(
        `INSERT INTO tasks (title, description, category, tags, kind, status, progress, links, created_at, updated_at)
         VALUES (@title, @desc, @cat, @tags, 'interest', @status, @progress, @links, @created, @updated)`,
      );
      const tx = db.transaction((list) => {
        for (const r of list) {
          ins.run({
            title: r.title,
            desc: r.notes ?? null,
            cat: r.category ?? null,
            tags: JSON.stringify([]),
            status: r.status ?? "idea",
            progress: r.progress ?? 0,
            links: r.links ?? "[]",
            created: r.created_at ?? new Date().toISOString(),
            updated: r.updated_at ?? new Date().toISOString(),
          });
        }
      });
      if (oldRows.length > 0) {
        tx(oldRows);
        console.log("[db] migrated", oldRows.length, "interests -> tasks");
      }
    }
  }
}

function tableExists(name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
}

// ───────────────────────────────────────────────────────────────────────────
// Seed one recurring task per course code (habit, auto-generated once).
// The user can delete / edit / mark done per instance.
// ───────────────────────────────────────────────────────────────────────────
function seedCourseHabits() {
  const rows = db
    .prepare(
      `SELECT DISTINCT code, subject FROM classes WHERE code IS NOT NULL`,
    )
    .all();
  const existing = new Set(
    db
      .prepare(
        `SELECT course_code FROM tasks WHERE kind='habit' AND course_code IS NOT NULL`,
      )
      .all()
      .map((r) => r.course_code),
  );
  const habits = {
    "21CSC204J": {
      title: "DAA: review today's topic + 1 LeetCode problem",
      rec: "day:1|day:2|day:3|day:4",
    },
    "21CSC205P": {
      title: "DBMS: run today's queries in sqlite / pg",
      rec: "day:3|day:4|day:5",
    },
    "21MAB204T": {
      title: "PQT: one worked example from the lecture",
      rec: "day:1|day:2|day:3",
    },
    "21CSC206T": {
      title: "AI: skim + flashcards of today's slides",
      rec: "day:1|day:5",
    },
    "21CSE251T": {
      title: "DIP: one Python image filter from today's topic",
      rec: "day:3|day:4|day:5",
    },
    "21DCS201P": {
      title: "Design Thinking: 15 min on the group deliverable",
      rec: "day:1|day:2",
    },
    "21PDH209T": {
      title: "Social Engineering: 10 min reflection / reading",
      rec: "day:4|day:5",
    },
  };
  const ins = db.prepare(
    `INSERT INTO tasks (title, description, priority, category, tags, kind, course_code, recurrence_rule, estimated_minutes)
     VALUES (@title, @desc, @priority, 'Academics', @tags, 'habit', @code, @rec, @est)`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (existing.has(r.code)) continue;
      const h = habits[r.code];
      if (!h) continue;
      ins.run({
        title: h.title,
        desc: `Auto-created by Apex for ${r.subject} (${r.code}). Edit or delete freely.`,
        priority: 3,
        tags: JSON.stringify([r.subject, "course", "habit"]),
        code: r.code,
        rec: h.rec,
        est: 25,
      });
    }
  });
  tx();
}

// ───────────────────────────────────────────────────────────────────────────
// settings
// ───────────────────────────────────────────────────────────────────────────
function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}
function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value == null ? null : String(value));
  return true;
}
// Hard-remove a setting row. Used by Categorization Overrides to actually
// delete an entry rather than leaving an empty-string ghost behind that
// the rebuild query then renders as "(empty)" on next page load.
function deleteSetting(key) {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  return true;
}
function allSettings() {
  return Object.fromEntries(
    db
      .prepare("SELECT key, value FROM settings")
      .all()
      .map((r) => [r.key, r.value]),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// tasks (kind: task | interest | habit | class-template)
// ───────────────────────────────────────────────────────────────────────────
function listTasks(filter = {}) {
  const clauses = [];
  const args = {};
  const kind = filter.kind ?? "task";
  if (kind !== "all") {
    clauses.push("COALESCE(kind,'task') = @kind");
    args.kind = kind;
  }
  if (filter.completed === false) clauses.push("completed = 0");
  if (filter.completed === true) clauses.push("completed = 1");
  if (filter.category) {
    clauses.push("category = @category");
    args.category = filter.category;
  }
  if (filter.course_code) {
    clauses.push("course_code = @code");
    args.code = filter.course_code;
  }
  if (filter.dueBy) {
    clauses.push("deadline IS NOT NULL AND deadline <= @dueBy");
    args.dueBy = filter.dueBy;
  }
  if (filter.q) {
    clauses.push("(title LIKE @q OR description LIKE @q)");
    args.q = `%${filter.q}%`;
  }
  const sql = `
    SELECT * FROM tasks
    ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
    ORDER BY completed ASC,
             CASE WHEN deadline IS NULL THEN 1 ELSE 0 END,
             deadline ASC, priority ASC, created_at DESC
  `;
  return db.prepare(sql).all(args).map(rowToTask);
}
function rowToTask(r) {
  return {
    ...r,
    completed: !!r.completed,
    tags: safeJson(r.tags, []),
    links: safeJson(r.links, []),
    kind: r.kind || "task",
  };
}
function logTaskEvent(action, task, payload = {}) {
  try {
    const at = payload.at || new Date().toISOString();
    const date = payload.date || isoDate(new Date(at));
    db.prepare(
      `INSERT INTO task_events (date, at, task_id, action, title, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      date,
      at,
      task?.id ?? payload.task_id ?? null,
      action,
      task?.title || payload.title || null,
      JSON.stringify(payload || {}),
    );
  } catch {
    /* audit logging must never block the task action */
  }
}
function taskChangedFields(before, after) {
  const keys = [
    "title",
    "description",
    "priority",
    "deadline",
    "category",
    "course_code",
    "estimated_minutes",
    "kind",
    "status",
    "progress",
    "recurrence_rule",
  ];
  const changed = [];
  for (const key of keys) {
    const a = before?.[key] ?? null;
    const b = after?.[key] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(key);
  }
  return changed;
}
function createTask(t) {
  const info = db
    .prepare(
      `INSERT INTO tasks (title, description, priority, deadline, category, course_code, tags,
       estimated_minutes, kind, status, progress, links, recurrence_rule)
     VALUES (@title, @description, @priority, @deadline, @category, @course_code, @tags,
       @estimated_minutes, @kind, @status, @progress, @links, @rec)`,
    )
    .run({
      title: t.title,
      description: t.description ?? null,
      priority: t.priority ?? 3,
      deadline: t.deadline ?? null,
      category: t.category ?? null,
      course_code: t.course_code ?? null,
      tags: JSON.stringify(t.tags ?? []),
      estimated_minutes: t.estimated_minutes ?? null,
      kind: t.kind ?? "task",
      status: t.status ?? null,
      progress: t.progress ?? 0,
      links: JSON.stringify(t.links ?? []),
      rec: t.recurrence_rule ?? null,
    });
  const row = listOne(info.lastInsertRowid);
  logTaskEvent("created", row, { source: t.source || null });
  return row;
}
function updateTask(id, patch) {
  const cur = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  if (!cur) return null;
  const merged = {
    id,
    title: patch.title ?? cur.title,
    description: patch.description ?? cur.description,
    priority: patch.priority ?? cur.priority,
    deadline: patch.deadline === undefined ? cur.deadline : patch.deadline,
    category: patch.category ?? cur.category,
    course_code:
      patch.course_code === undefined ? cur.course_code : patch.course_code,
    tags: JSON.stringify(patch.tags ?? safeJson(cur.tags, [])),
    estimated_minutes:
      patch.estimated_minutes === undefined
        ? cur.estimated_minutes
        : patch.estimated_minutes,
    kind: patch.kind ?? cur.kind ?? "task",
    status: patch.status === undefined ? cur.status : patch.status,
    progress: patch.progress === undefined ? cur.progress : patch.progress,
    links: JSON.stringify(patch.links ?? safeJson(cur.links, [])),
    rec:
      patch.recurrence_rule === undefined
        ? cur.recurrence_rule
        : patch.recurrence_rule,
  };
  db.prepare(
    `UPDATE tasks SET title=@title, description=@description, priority=@priority,
       deadline=@deadline, category=@category, course_code=@course_code, tags=@tags,
       estimated_minutes=@estimated_minutes, kind=@kind, status=@status,
       progress=@progress, links=@links, recurrence_rule=@rec,
       updated_at=datetime('now') WHERE id=@id`,
  ).run(merged);
  const row = listOne(id);
  logTaskEvent("updated", row, {
    changed: taskChangedFields(rowToTask(cur), row),
  });
  return row;
}
function deleteTask(id) {
  const cur = listOne(id);
  logTaskEvent("deleted", cur || { id }, { snapshot: cur });
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return true;
}
function toggleTask(id) {
  const cur = db
    .prepare("SELECT completed, kind FROM tasks WHERE id = ?")
    .get(id);
  if (!cur) return null;
  const becomingDone = !cur.completed;
  const now = becomingDone ? new Date().toISOString() : null;
  db.prepare(
    `UPDATE tasks SET completed = ?, completed_at = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(becomingDone ? 1 : 0, now, id);
  // For habit-kind tasks we also log the tick into habit_completions so we
  // can compute streaks across day rotations. Idempotent via UNIQUE(task_id,
  // date). Toggling OFF on the same day removes today's tick (so the user
  // can correct an accidental check) — older history stays intact.
  if (cur.kind === "habit") {
    const todayLocal = isoDate(new Date());
    if (becomingDone) {
      try {
        db.prepare(
          `INSERT OR IGNORE INTO habit_completions (task_id, date, completed_at)
           VALUES (?, ?, datetime('now'))`,
        ).run(id, todayLocal);
      } catch { /* table may not exist yet on legacy DBs */ }
    } else {
      try {
        db.prepare(
          `DELETE FROM habit_completions WHERE task_id = ? AND date = ?`,
        ).run(id, todayLocal);
      } catch { /* ignore */ }
    }
  }
  const row = listOne(id);
  logTaskEvent(becomingDone ? "completed" : "reopened", row, {
    completed_at: row?.completed_at || null,
  });
  return row;
}

// Current streak for a habit — how many consecutive days (ending today
// or yesterday) the habit was checked off. Returns
// `{ current, longest, lastCompleted }`. Tolerant: if the habit is "due
// every day" we count strictly consecutive days; for non-daily habits
// (weekly, day-order-based) the same calculation still works because we
// only require that the user *did* tick the habit each day they meant to.
function habitStreak(taskId) {
  if (!taskId) return { current: 0, longest: 0, lastCompleted: null };
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT date FROM habit_completions WHERE task_id = ? ORDER BY date DESC`,
      )
      .all(taskId);
  } catch { return { current: 0, longest: 0, lastCompleted: null }; }
  if (!rows.length) return { current: 0, longest: 0, lastCompleted: null };

  const days = new Set(rows.map((r) => r.date));
  const lastCompleted = rows[0].date;

  // Walk back from today; if today isn't a tick, allow yesterday as the
  // anchor (so "did it yesterday and not yet today" still counts as a 1-
  // day-old streak instead of zero).
  function shift(iso, deltaDays) {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + deltaDays);
    return isoDate(d);
  }

  let anchor = isoDate(new Date());
  if (!days.has(anchor)) {
    const y = shift(anchor, -1);
    if (days.has(y)) anchor = y;
    else return { current: 0, longest: longestRun(rows), lastCompleted };
  }
  let current = 0;
  let cursor = anchor;
  while (days.has(cursor)) {
    current++;
    cursor = shift(cursor, -1);
  }
  return { current, longest: Math.max(current, longestRun(rows)), lastCompleted };
}
function longestRun(rows) {
  // rows is newest-first; walk forward (oldest-first) tracking the longest
  // run of consecutive dates.
  if (!rows || rows.length === 0) return 0;
  const list = rows.slice().reverse().map((r) => r.date);
  let best = 1, run = 1;
  for (let i = 1; i < list.length; i++) {
    const prev = new Date(list[i - 1] + "T00:00:00").getTime();
    const cur = new Date(list[i] + "T00:00:00").getTime();
    const dayDiff = Math.round((cur - prev) / 86400000);
    if (dayDiff === 1) { run++; best = Math.max(best, run); }
    else if (dayDiff === 0) { /* dup — ignore */ }
    else { run = 1; }
  }
  return best;
}

// Streaks for many habits at once — saves a per-row IPC round-trip.
function habitStreaksFor(ids) {
  const out = {};
  for (const id of ids || []) {
    out[id] = habitStreak(id);
  }
  return out;
}
function listOne(id) {
  const r = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return r ? rowToTask(r) : null;
}

// Tasks due today or earlier + today's course habits (by JS day-of-week mapping
// to SRM day-order). Callers typically union these with today's classes.
function tasksForToday() {
  const todayIso = isoDate(new Date());
  // Anything deadline <= today and not completed, plus kind='task' no deadline.
  const rows = db
    .prepare(
      `SELECT * FROM tasks
     WHERE completed = 0
       AND COALESCE(kind,'task') IN ('task','habit')
       AND (
         (deadline IS NOT NULL AND date(deadline) <= date(?))
         OR deadline IS NULL
       )
     ORDER BY
       CASE WHEN deadline IS NULL THEN 1 ELSE 0 END,
       deadline ASC, priority ASC, created_at DESC`,
    )
    .all(todayIso);
  return rows.map(rowToTask);
}
function tasksUpcoming(days = 7) {
  const rows = db
    .prepare(
      `SELECT * FROM tasks
     WHERE completed = 0
       AND COALESCE(kind,'task') = 'task'
       AND deadline IS NOT NULL
       AND date(deadline) <= date('now', ?)
     ORDER BY deadline ASC, priority ASC`,
    )
    .all(`+${days} days`);
  return rows.map(rowToTask);
}
function tasksCompletedOn(iso) {
  const rows = db
    .prepare(
      `SELECT * FROM tasks WHERE completed = 1 AND date(completed_at) = date(?)
     ORDER BY completed_at DESC`,
    )
    .all(iso);
  return rows.map(rowToTask);
}

// ───────────────────────────────────────────────────────────────────────────
// checkins
// ───────────────────────────────────────────────────────────────────────────
function getCheckinByDate(date) {
  return db.prepare("SELECT * FROM checkins WHERE date = ?").get(date) ?? null;
}
function upsertCheckin({ date, sleep, clarity, dread, energy, note }) {
  db.prepare(
    `INSERT INTO checkins (date, sleep, clarity, dread, energy, note)
     VALUES (@date, @sleep, @clarity, @dread, @energy, @note)
     ON CONFLICT(date) DO UPDATE SET
       sleep = excluded.sleep, clarity = excluded.clarity,
       dread = excluded.dread, energy = excluded.energy, note = excluded.note`,
  ).run({ date, sleep, clarity, dread, energy, note: note ?? null });
  return getCheckinByDate(date);
}
function lastCheckins(days) {
  return db
    .prepare(
      `SELECT * FROM checkins WHERE date >= date('now', ?) ORDER BY date DESC`,
    )
    .all(`-${days} days`);
}

// ───────────────────────────────────────────────────────────────────────────
// streak / focus
// ───────────────────────────────────────────────────────────────────────────
function streakStatus() {
  const rows = db
    .prepare(
      `SELECT date FROM daily_focus WHERE completed = 1
     UNION
     SELECT date(completed_at) AS date FROM tasks WHERE completed_at IS NOT NULL
     ORDER BY date DESC`,
    )
    .all();
  const seen = new Set(rows.map((r) => r.date));
  let streak = 0;
  const d = new Date();
  while (true) {
    const key = isoDate(d);
    if (seen.has(key)) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else break;
  }
  const startOfWeek = new Date();
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const cur = new Date(startOfWeek);
    cur.setDate(startOfWeek.getDate() + i);
    const key = isoDate(cur);
    weekDays.push({ date: key, done: seen.has(key) });
  }
  return { streak, weekDays, weekDone: weekDays.filter((d) => d.done).length };
}
function completeTodayFocus() {
  const key = isoDate(new Date());
  db.prepare(
    `INSERT INTO daily_focus (date, completed) VALUES (?, 1)
     ON CONFLICT(date) DO UPDATE SET completed = 1`,
  ).run(key);
  return streakStatus();
}

// ───────────────────────────────────────────────────────────────────────────
// weekly goals
// ───────────────────────────────────────────────────────────────────────────
function listWeeklyGoals() {
  return db
    .prepare("SELECT * FROM weekly_goals ORDER BY sort ASC, id ASC")
    .all();
}
function upsertWeeklyGoal(g) {
  if (g.id) {
    db.prepare(
      `UPDATE weekly_goals SET title=@title, target=@target, progress=@progress, sort=@sort WHERE id=@id`,
    ).run({
      id: g.id,
      title: g.title,
      target: g.target ?? 1,
      progress: g.progress ?? 0,
      sort: g.sort ?? 99,
    });
    const row = db.prepare("SELECT * FROM weekly_goals WHERE id=?").get(g.id);
    logTaskEvent("goal_updated", null, { goal_id: row?.id, title: row?.title, goal: row });
    return row;
  }
  const info = db
    .prepare(
      `INSERT INTO weekly_goals (title, target, progress, sort) VALUES (@title, @target, @progress, @sort)`,
    )
    .run({
      title: g.title,
      target: g.target ?? 1,
      progress: g.progress ?? 0,
      sort: g.sort ?? 99,
    });
  const row = db
    .prepare("SELECT * FROM weekly_goals WHERE id=?")
    .get(info.lastInsertRowid);
  logTaskEvent("goal_created", null, { goal_id: row?.id, title: row?.title, goal: row });
  return row;
}
function deleteWeeklyGoal(id) {
  const row = db.prepare("SELECT * FROM weekly_goals WHERE id = ?").get(id);
  logTaskEvent("goal_deleted", null, { goal_id: id, title: row?.title || null, goal: row || null });
  db.prepare("DELETE FROM weekly_goals WHERE id = ?").run(id);
  return true;
}
function resetWeeklyGoals() {
  logTaskEvent("goals_reset", null, { title: "Weekly goals reset" });
  db.prepare("UPDATE weekly_goals SET progress = 0").run();
  return listWeeklyGoals();
}
function incrementGoalProgress(id, by = 1) {
  const row = db.prepare("SELECT * FROM weekly_goals WHERE id = ?").get(id);
  if (!row) return null;
  const next = Math.max(
    0,
    Math.min((row.progress ?? 0) + by, (row.target ?? 1) * 2),
  );
  db.prepare("UPDATE weekly_goals SET progress = ? WHERE id = ?").run(next, id);
  const updated = db.prepare("SELECT * FROM weekly_goals WHERE id = ?").get(id);
  logTaskEvent("goal_progress", null, {
    goal_id: id,
    title: updated?.title || row.title,
    by,
    previous: row.progress ?? 0,
    progress: next,
    target: row.target ?? 1,
  });
  return updated;
}
// Exported helper so init-ordering / manual re-seeding both work.
function seedWeeklyGoals() {
  const row = db.prepare("SELECT COUNT(*) AS c FROM weekly_goals").get();
  if (row.c > 0) return listWeeklyGoals();
  const ins = db.prepare(
    "INSERT INTO weekly_goals (title, target, progress, sort) VALUES (?, ?, ?, ?)",
  );
  const seed = [
    ["LeetCode problems", 10, 0, 1],
    ["Deep-work hours", 15, 0, 2],
    ["GitHub commit days", 5, 0, 3],
    ["Project ship", 1, 0, 4],
  ];
  const tx = db.transaction(() =>
    seed.forEach(([t, tg, p, s]) => ins.run(t, tg, p, s)),
  );
  tx();
  return listWeeklyGoals();
}

// ───────────────────────────────────────────────────────────────────────────
// classes (college schedule)
// ───────────────────────────────────────────────────────────────────────────
function listClasses() {
  return db
    .prepare("SELECT * FROM classes ORDER BY day_order ASC, start_time ASC")
    .all();
}
function classesForDayOrder(dayOrder) {
  if (!dayOrder) return [];
  return db
    .prepare(
      "SELECT * FROM classes WHERE day_order = ? ORDER BY start_time ASC",
    )
    .all(dayOrder);
}
function upsertClass(c) {
  if (c.id) {
    db.prepare(
      `UPDATE classes SET day_order=@day_order, period=@period, slot=@slot, subject=@subject,
         code=@code, room=@room, faculty=@faculty, start_time=@start_time, end_time=@end_time,
         kind=@kind, note=@note WHERE id=@id`,
    ).run({
      id: c.id,
      day_order: c.day_order,
      period: c.period ?? null,
      slot: c.slot ?? null,
      subject: c.subject,
      code: c.code ?? null,
      room: c.room ?? null,
      faculty: c.faculty ?? null,
      start_time: c.start_time,
      end_time: c.end_time,
      kind: c.kind ?? "lecture",
      note: c.note ?? null,
    });
    return db.prepare("SELECT * FROM classes WHERE id=?").get(c.id);
  }
  const info = db
    .prepare(
      `INSERT INTO classes (day_order, period, slot, subject, code, room, faculty, start_time, end_time, kind, note)
     VALUES (@day_order, @period, @slot, @subject, @code, @room, @faculty, @start_time, @end_time, @kind, @note)`,
    )
    .run({
      day_order: c.day_order,
      period: c.period ?? null,
      slot: c.slot ?? null,
      subject: c.subject,
      code: c.code ?? null,
      room: c.room ?? null,
      faculty: c.faculty ?? null,
      start_time: c.start_time,
      end_time: c.end_time,
      kind: c.kind ?? "lecture",
      note: c.note ?? null,
    });
  return db
    .prepare("SELECT * FROM classes WHERE id=?")
    .get(info.lastInsertRowid);
}
function deleteClass(id) {
  db.prepare("DELETE FROM classes WHERE id = ?").run(id);
  return true;
}

// Pin an arbitrary date to an SRM day-order (1..5), or clear it (dayOrder=null).
// Used when a day-order skips (holiday) and rolls over.
function setDayOrderForDate(iso, dayOrder) {
  if (dayOrder == null) {
    db.prepare("DELETE FROM day_order_overrides WHERE date = ?").run(iso);
  } else {
    db.prepare(
      `INSERT INTO day_order_overrides (date, day_order) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET day_order = excluded.day_order`,
    ).run(iso, dayOrder);
  }
  return true;
}
// Returns:
//   undefined  → no row (caller should fall back to the anchor rotation)
//   null       → row with day_order=NULL (explicit holiday / no classes)
//   1..5       → the SRM day order
function dayOrderForDate(iso) {
  const row = db
    .prepare("SELECT day_order FROM day_order_overrides WHERE date = ?")
    .get(iso);
  if (!row) return undefined;
  return row.day_order;
}
function replaceAllClasses(rows) {
  const tx = db.transaction((list) => {
    db.prepare("DELETE FROM classes").run();
    const ins = db.prepare(
      `INSERT INTO classes (day_order, period, slot, subject, code, room, faculty, start_time, end_time, kind, note)
       VALUES (@day_order, @period, @slot, @subject, @code, @room, @faculty, @start_time, @end_time, @kind, @note)`,
    );
    for (const c of list) {
      ins.run({
        day_order: c.day_order,
        period: c.period ?? null,
        slot: c.slot ?? null,
        subject: c.subject,
        code: c.code ?? null,
        room: c.room ?? null,
        faculty: c.faculty ?? null,
        start_time: c.start_time,
        end_time: c.end_time,
        kind: c.kind ?? "lecture",
        note: c.note ?? null,
      });
    }
  });
  tx(rows);
  return listClasses();
}

// ───────────────────────────────────────────────────────────────────────────
// people / repos
// ───────────────────────────────────────────────────────────────────────────
function listPeople(filter = {}) {
  const clauses = [];
  const args = {};
  if (filter.source) {
    clauses.push("source = @source");
    args.source = filter.source;
  }
  if (filter.tag) {
    clauses.push("tags LIKE @tag");
    args.tag = `%"${filter.tag}"%`;
  }
  if (filter.q) {
    clauses.push("(name LIKE @q OR github_username LIKE @q)");
    args.q = `%${filter.q}%`;
  }
  const rows = db
    .prepare(
      `SELECT * FROM people ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY name COLLATE NOCASE`,
    )
    .all(args);
  return rows.map((r) => ({ ...r, tags: safeJson(r.tags, []) }));
}
function upsertPerson(p) {
  if (p.id) {
    db.prepare(
      `UPDATE people SET name=@name, github_username=@gh, linkedin_url=@li, source=@source,
         tags=@tags, notes=@notes, avatar_url=@avatar, bio=@bio,
         leetcode_username=@lc, codeforces_username=@cf, codechef_username=@cc
       WHERE id=@id`,
    ).run({
      id: p.id,
      name: p.name,
      gh: p.github_username ?? null,
      li: p.linkedin_url ?? null,
      source: p.source ?? "manual",
      tags: JSON.stringify(p.tags ?? []),
      notes: p.notes ?? null,
      avatar: p.avatar_url ?? null,
      bio: p.bio ?? null,
      lc: p.leetcode_username ?? null,
      cf: p.codeforces_username ?? null,
      cc: p.codechef_username ?? null,
    });
    return db.prepare("SELECT * FROM people WHERE id = ?").get(p.id);
  }
  if (p.github_username) {
    const existing = db
      .prepare("SELECT * FROM people WHERE github_username = ?")
      .get(p.github_username);
    if (existing) {
      const mergedTags = Array.from(
        new Set([...safeJson(existing.tags, []), ...(p.tags ?? [])]),
      );
      db.prepare(
        `UPDATE people SET name = COALESCE(?, name), linkedin_url = COALESCE(?, linkedin_url),
           source = COALESCE(?, source), tags = ?, notes = COALESCE(?, notes),
           avatar_url = COALESCE(?, avatar_url), bio = COALESCE(?, bio),
           leetcode_username = COALESCE(?, leetcode_username),
           codeforces_username = COALESCE(?, codeforces_username),
           codechef_username = COALESCE(?, codechef_username)
         WHERE id = ?`,
      ).run(
        p.name ?? null,
        p.linkedin_url ?? null,
        p.source ?? null,
        JSON.stringify(mergedTags),
        p.notes ?? null,
        p.avatar_url ?? null,
        p.bio ?? null,
        p.leetcode_username ?? null,
        p.codeforces_username ?? null,
        p.codechef_username ?? null,
        existing.id,
      );
      return db.prepare("SELECT * FROM people WHERE id = ?").get(existing.id);
    }
  }
  // Secondary dedupe: match by linkedin_url. Otherwise the same LinkedIn-only
  // scrape re-runs keep appending duplicates (the user saw two "associate"
  // rows for the same LinkedIn handle).
  if (p.linkedin_url && !p.github_username) {
    const existing = db
      .prepare("SELECT * FROM people WHERE linkedin_url = ? AND (github_username IS NULL OR github_username = '')")
      .get(p.linkedin_url);
    if (existing) {
      const mergedTags = Array.from(
        new Set([...safeJson(existing.tags, []), ...(p.tags ?? [])]),
      );
      db.prepare(
        `UPDATE people SET name = COALESCE(?, name), source = COALESCE(?, source),
           tags = ?, notes = COALESCE(?, notes), avatar_url = COALESCE(?, avatar_url),
           bio = COALESCE(?, bio)
         WHERE id = ?`,
      ).run(
        p.name ?? null,
        p.source ?? null,
        JSON.stringify(mergedTags),
        p.notes ?? null,
        p.avatar_url ?? null,
        p.bio ?? null,
        existing.id,
      );
      return db.prepare("SELECT * FROM people WHERE id = ?").get(existing.id);
    }
  }
  const info = db
    .prepare(
      `INSERT INTO people (name, github_username, linkedin_url, source, tags, notes,
       avatar_url, bio, leetcode_username, codeforces_username, codechef_username)
     VALUES (@name, @gh, @li, @source, @tags, @notes, @avatar, @bio, @lc, @cf, @cc)`,
    )
    .run({
      name: p.name,
      gh: p.github_username ?? null,
      li: p.linkedin_url ?? null,
      source: p.source ?? "manual",
      tags: JSON.stringify(p.tags ?? []),
      notes: p.notes ?? null,
      avatar: p.avatar_url ?? null,
      bio: p.bio ?? null,
      lc: p.leetcode_username ?? null,
      cf: p.codeforces_username ?? null,
      cc: p.codechef_username ?? null,
    });
  return db
    .prepare("SELECT * FROM people WHERE id = ?")
    .get(info.lastInsertRowid);
}
function deletePerson(id) {
  db.prepare("DELETE FROM people WHERE id = ?").run(id);
  return true;
}
function deletePeople(ids) {
  if (!ids || ids.length === 0) return true;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM people WHERE id IN (${placeholders})`).run(...ids);
  return true;
}
function deleteAllPeople() {
  db.prepare("DELETE FROM people").run();
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Duplicate detection + merging.
// Two people are "likely the same" if ANY of:
//   - same registration number (notes.registration), strongest signal
//   - same github_username (case-insensitive)
//   - same leetcode_username (case-insensitive)
//   - same name + overlap on at least one handle/url
//   - normalized name identical (lowercase, ascii, no punctuation)
// Returns an array of groups: [{members: [person, ...], reason: "..." }].
// Members in each group are sorted by completeness so the first is the
// best "anchor" to merge into.
// ───────────────────────────────────────────────────────────────────────────
function _normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    // LinkedIn slugs end with a hash ID like "-ba5a1533b" or "_ab12cd34" —
    // strip them so "yashasvi-allen-kujur-ba5a1533b" matches "Yashasvi Allen Kujur".
    .replace(/[-_][a-z0-9]{6,}$/i, "")
    // Dashes / underscores → spaces (LinkedIn slugs use dashes).
    .replace(/[-_]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Extract the LinkedIn slug from a profile URL (e.g.
// "https://linkedin.com/in/yashasvi-allen-kujur-ba5a1533b" →
// "yashasvi allen kujur"). Used as an extra dedup signal when one record
// has a real name and another only has the LinkedIn URL.
function _normalizeLinkedinSlug(url) {
  if (!url) return "";
  try {
    const m = String(url).match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
    if (!m) return "";
    return _normalizeName(m[1]);
  } catch { return ""; }
}
function _completenessScore(p) {
  // More filled fields → higher score → preferred as merge target.
  let n = 0;
  if (p.github_username) n += 3;
  if (p.linkedin_url) n += 2;
  if (p.leetcode_username) n += 2;
  if (p.codeforces_username) n += 1;
  if (p.codechef_username) n += 1;
  if (p.avatar_url) n += 1;
  if (p.bio) n += 1;
  if (p.last_scraped_at) n += 2;
  if (p.notes && p.notes.length > 2) n += 1;
  return n;
}
function findDuplicateGroups() {
  const all = db
    .prepare(
      `SELECT id, name, github_username, linkedin_url,
              leetcode_username, codeforces_username, codechef_username,
              avatar_url, bio, source, tags, notes, last_scraped_at
         FROM people`,
    )
    .all();

  // Build candidate-key indices. The LinkedIn slug index is keyed by the
  // *normalized* slug ("yashasvi allen kujur") — same shape as `byNorm`,
  // so it cross-matches with people who only have a real name field.
  const byReg = new Map(); // regNo -> [person...]
  const byGh  = new Map(); // gh username -> [person...]
  const byLc  = new Map(); // lc handle  -> [person...]
  const byNorm = new Map(); // normalized name -> [person...]
  const byLnSlug = new Map(); // normalized LinkedIn slug -> [person...]

  for (const p of all) {
    let notes = {};
    try { notes = JSON.parse(p.notes || "{}") || {}; } catch {}
    p._notes = notes;
    if (notes.registration) {
      const k = String(notes.registration).toUpperCase();
      if (!byReg.has(k)) byReg.set(k, []);
      byReg.get(k).push(p);
    }
    if (p.github_username) {
      const k = p.github_username.toLowerCase();
      if (!byGh.has(k)) byGh.set(k, []);
      byGh.get(k).push(p);
    }
    if (p.leetcode_username) {
      const k = p.leetcode_username.toLowerCase();
      if (!byLc.has(k)) byLc.set(k, []);
      byLc.get(k).push(p);
    }
    const norm = _normalizeName(p.name);
    if (norm) {
      if (!byNorm.has(norm)) byNorm.set(norm, []);
      byNorm.get(norm).push(p);
    }
    const slug = _normalizeLinkedinSlug(p.linkedin_url);
    if (slug) {
      // Add to the slug index AND link slug→name via byNorm so a record
      // with only a LinkedIn URL gets paired with one that has the real name.
      if (!byLnSlug.has(slug)) byLnSlug.set(slug, []);
      byLnSlug.get(slug).push(p);
      if (!byNorm.has(slug)) byNorm.set(slug, []);
      // Avoid double-pushing if name happened to normalize to the same
      // string — guard against duplicates.
      if (!byNorm.get(slug).find((q) => q.id === p.id)) {
        byNorm.get(slug).push(p);
      }
    }
  }

  // Build groups using union-find so a 3-way collision (A==B by gh, B==C
  // by name) ends up as one {A, B, C} group rather than two pairs.
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) { parent.set(x, x); return x; }
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const groupReason = new Map(); // root id -> reason set
  function addReason(id, reason) {
    const root = find(id);
    if (!groupReason.has(root)) groupReason.set(root, new Set());
    groupReason.get(root).add(reason);
  }
  function unionList(list, reason) {
    if (list.length < 2) return;
    const a = list[0].id;
    for (let i = 1; i < list.length; i++) {
      union(a, list[i].id);
      addReason(list[i].id, reason);
      addReason(a, reason);
    }
  }

  for (const list of byReg.values())   unionList(list, "registration");
  for (const list of byGh.values())    unionList(list, "github handle");
  for (const list of byLc.values())    unionList(list, "leetcode handle");
  for (const list of byNorm.values())  unionList(list, "name / linkedin slug");
  for (const list of byLnSlug.values()) unionList(list, "linkedin slug");

  // Skip groups that are huge AND only matched by name (likely a junk
  // name like "syndicate" used as a placeholder during scraping). 8+
  // people sharing exactly one name with no shared handles is almost
  // certainly an import bug rather than a duplicate cluster — surfacing
  // them as ONE giant merge group spams the UI. We surface them in a
  // separate "needs-cleanup" return key so the UI can offer a fix-names
  // flow instead of a merge flow.

  // Collect groups.
  const groups = new Map(); // root id -> [persons]
  for (const p of all) {
    if (!parent.has(p.id)) continue; // singleton, no duplicates
    const root = find(p.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(p);
  }

  const out = [];
  const placeholders = []; // big name-only collisions ("syndicate", "Unknown", etc)
  for (const [root, members] of groups.entries()) {
    if (members.length < 2) continue;
    // Sort members so the most-complete is first (the "primary").
    members.sort(
      (a, b) =>
        _completenessScore(b) - _completenessScore(a) ||
        (a.id - b.id),
    );
    const reasons = [...(groupReason.get(root) || ["match"])];
    // Detect placeholder-name collision: 6+ members ALL sharing the same
    // (case-insensitive) name with no other matching signal.
    const names = new Set(members.map((m) => String(m.name).toLowerCase()));
    const onlyNameSignal = reasons.length === 1 &&
      (reasons[0] === "name / linkedin slug" || reasons[0] === "name");
    const placeholderName = members.length >= 6 && names.size === 1 && onlyNameSignal;
    if (placeholderName) {
      placeholders.push({ members, reasons, placeholderName: members[0].name });
    } else {
      out.push({ members, reasons });
    }
  }
  // Stable order for the UI: largest groups first, then by primary name.
  const cmp = (a, b) =>
    b.members.length - a.members.length ||
    String(a.members[0].name).localeCompare(String(b.members[0].name));
  out.sort(cmp);
  placeholders.sort(cmp);
  // Return both lists; the UI shows real merge groups by default and
  // the placeholders behind a separate "Fix names" tab.
  return { groups: out, placeholders };
}

// Merge the listed personIds into `keepId`. Combines all fillable fields
// (handles, links, tags, notes), reassigns repos + cp_stats + cp_submissions
// to keepId, then deletes the merged rows. Wrapped in a transaction so a
// partial failure doesn't leave dangling foreign keys.
function mergePeople(keepId, mergeIds) {
  if (!keepId || !Array.isArray(mergeIds) || mergeIds.length === 0) {
    return { ok: false, error: "nothing to merge" };
  }
  const ids = mergeIds.filter((x) => x && x !== keepId);
  if (!ids.length) return { ok: false, error: "no merge targets" };

  const tx = db.transaction(() => {
    const keeper = db
      .prepare("SELECT * FROM people WHERE id = ?")
      .get(keepId);
    if (!keeper) throw new Error("Keeper not found: " + keepId);

    const merging = ids
      .map((id) => db.prepare("SELECT * FROM people WHERE id = ?").get(id))
      .filter(Boolean);
    if (!merging.length) throw new Error("No merge candidates exist");

    // Combine simple fields (first non-null wins, keeper takes priority).
    const filled = (...vals) =>
      vals.find((v) => v !== null && v !== undefined && v !== "") ?? null;

    const merged = {
      name: keeper.name || merging.map((m) => m.name).find(Boolean) || keeper.name,
      github_username: filled(keeper.github_username, ...merging.map((m) => m.github_username)),
      linkedin_url: filled(keeper.linkedin_url, ...merging.map((m) => m.linkedin_url)),
      leetcode_username: filled(keeper.leetcode_username, ...merging.map((m) => m.leetcode_username)),
      codeforces_username: filled(keeper.codeforces_username, ...merging.map((m) => m.codeforces_username)),
      codechef_username: filled(keeper.codechef_username, ...merging.map((m) => m.codechef_username)),
      avatar_url: filled(keeper.avatar_url, ...merging.map((m) => m.avatar_url)),
      bio: filled(keeper.bio, ...merging.map((m) => m.bio)),
      source: keeper.source || merging.find((m) => m.source)?.source || "merged",
    };

    // Tags: union as deduped JSON array.
    const allTags = new Set();
    const collectTags = (raw) => {
      try {
        const arr = JSON.parse(raw || "[]");
        if (Array.isArray(arr)) arr.forEach((t) => t && allTags.add(t));
      } catch {}
    };
    collectTags(keeper.tags);
    merging.forEach((m) => collectTags(m.tags));
    allTags.add("merged");
    const mergedTags = JSON.stringify([...allTags]);

    // Notes: deep-merge JSON objects (later wins on key conflicts; keeper
    // wins overall). String notes get concatenated.
    const mergeNote = (raw) => {
      try {
        const v = JSON.parse(raw || "{}");
        return typeof v === "object" && v ? v : { _text: String(raw || "") };
      } catch {
        return raw ? { _text: String(raw) } : {};
      }
    };
    const mergedNotes = Object.assign(
      {},
      ...merging.map(mergeNote),
      mergeNote(keeper.notes),
    );
    mergedNotes._mergedFrom = (mergedNotes._mergedFrom || []).concat(
      merging.map((m) => ({ id: m.id, name: m.name })),
    );

    db.prepare(
      `UPDATE people SET
         name=@name, github_username=@github_username, linkedin_url=@linkedin_url,
         leetcode_username=@leetcode_username, codeforces_username=@codeforces_username,
         codechef_username=@codechef_username, avatar_url=@avatar_url, bio=@bio,
         source=@source, tags=@tags, notes=@notes
       WHERE id=@id`,
    ).run({
      ...merged,
      tags: mergedTags,
      notes: JSON.stringify(mergedNotes),
      id: keepId,
    });

    // Reassign rows that point at the merging ids — repos, cp_stats,
    // cp_submissions. Use INSERT OR IGNORE pattern to avoid PK clashes
    // on (person_id, ...) unique indexes.
    const reassign = (table) => {
      try {
        for (const id of ids) {
          db.prepare(`UPDATE OR IGNORE ${table} SET person_id = ? WHERE person_id = ?`).run(keepId, id);
          db.prepare(`DELETE FROM ${table} WHERE person_id = ?`).run(id);
        }
      } catch { /* table might not exist; ignore */ }
    };
    reassign("repos");
    reassign("cp_stats");
    reassign("cp_submissions");

    // Delete the merged rows.
    for (const id of ids) {
      db.prepare("DELETE FROM people WHERE id = ?").run(id);
    }

    return { kept: keepId, mergedCount: ids.length };
  });

  try {
    return { ok: true, ...tx() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
function touchPersonScraped(id) {
  db.prepare(
    `UPDATE people SET last_scraped_at = datetime('now') WHERE id = ?`,
  ).run(id);
}
function listRepos(personId) {
  const rows = db
    .prepare(
      "SELECT * FROM repos WHERE person_id = ? ORDER BY pushed_at DESC NULLS LAST",
    )
    .all(personId);
  return rows.map((r) => ({
    ...r,
    languages: safeJson(r.languages, {}),
    topics: safeJson(r.topics, []),
  }));
}

// Search across every repo we've cached for every person — keyword
// match against name, description, topics, language. Returns rows
// flattened with the owner's name + handle so the UI can render a
// "browse by topic" view without N+1 lookups.
// ───────────────────────────────────────────────────────────────────────────
// Activity buckets — 10-min foreground-app timeline.
// Stores at most one row per (date, 10-min window, app). The total minutes
// per bucket is capped at 10; per 60-min hour at 60 (the underlying
// addBucketMinutes() clamps so a noisy tracker can't blow past clock time).
// ───────────────────────────────────────────────────────────────────────────
function addBucketMinutes({ date, bucketStartMin, app, category, minutes }) {
  if (!date || bucketStartMin == null || !app) return false;
  const mins = Math.max(0, Math.min(10, +minutes || 0));
  if (mins === 0) return false;
  // Sum of existing minutes in this bucket — clamp the new addition so
  // total never exceeds 10.
  const cur = db.prepare(
    `SELECT COALESCE(SUM(minutes), 0) AS total
       FROM activity_buckets WHERE date = ? AND bucket_start_min = ?`,
  ).get(date, bucketStartMin);
  const room = Math.max(0, 10 - (cur?.total || 0));
  const toAdd = Math.min(mins, room);
  if (toAdd === 0) return false;
  db.prepare(
    `INSERT INTO activity_buckets (date, bucket_start_min, app_name, category, minutes)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date, bucket_start_min, app_name) DO UPDATE SET
       minutes = MIN(10, minutes + excluded.minutes),
       category = COALESCE(excluded.category, category)`,
  ).run(date, bucketStartMin, app, category || null, toAdd);
  return true;
}

function listBuckets(date, { limit = 200 } = {}) {
  const d = date || isoDate(new Date());
  const rows = db
    .prepare(
      `SELECT bucket_start_min, app_name, category, minutes
         FROM activity_buckets
        WHERE date = ?
        ORDER BY bucket_start_min ASC, minutes DESC
        LIMIT ?`,
    )
    .all(d, +limit || 200);
  // Group by bucket window.
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.bucket_start_min)) map.set(r.bucket_start_min, []);
    map.get(r.bucket_start_min).push({
      app: r.app_name, category: r.category, minutes: r.minutes,
    });
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([startMin, apps]) => ({
      startMin,
      endMin: startMin + 10,
      apps,
      totalMinutes: apps.reduce((s, a) => s + a.minutes, 0),
    }));
}

// ───────────────────────────────────────────────────────────────────────────
// leisure_segments — user-declared breaks. Single open segment at a time
// (the model: you're either "working" or "on a break"; the work side is
// covered by live_timer). Lets the user override the auto-tracker's
// guess for ambiguous activity like "Brave foregrounded" → that could
// be Insta scroll OR a PQT lecture. Explicit > inferred.
// ───────────────────────────────────────────────────────────────────────────
function activeLeisure() {
  return db
    .prepare(
      `SELECT * FROM leisure_segments
        WHERE ended_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get() || null;
}
function startLeisure({ label, estimatedMinutes, kind, note } = {}) {
  // Close any stale open segment first (defensive — there should only
  // ever be one).
  db.prepare(`UPDATE leisure_segments SET ended_at = datetime('now') WHERE ended_at IS NULL`).run();
  const info = db
    .prepare(
      `INSERT INTO leisure_segments (started_at, estimated_minutes, label, kind, note)
       VALUES (datetime('now'), ?, ?, ?, ?)`,
    )
    .run(
      estimatedMinutes ? Math.max(1, Math.round(+estimatedMinutes)) : null,
      label || null,
      kind || "leisure",
      note || null,
    );
  return db.prepare(`SELECT * FROM leisure_segments WHERE id = ?`).get(info.lastInsertRowid);
}
function extendLeisure(byMinutes) {
  const open = activeLeisure();
  if (!open) return null;
  const m = Math.max(1, Math.round(+byMinutes || 0));
  db.prepare(
    `UPDATE leisure_segments SET estimated_minutes = COALESCE(estimated_minutes, 0) + ? WHERE id = ?`,
  ).run(m, open.id);
  return db.prepare(`SELECT * FROM leisure_segments WHERE id = ?`).get(open.id);
}
function stopLeisure() {
  const open = activeLeisure();
  if (!open) return null;
  db.prepare(`UPDATE leisure_segments SET ended_at = datetime('now') WHERE id = ?`).run(open.id);
  return db.prepare(`SELECT * FROM leisure_segments WHERE id = ?`).get(open.id);
}
// Recent leisure segments for the day-view + AI context.
function recentLeisure({ days = 1 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  return db
    .prepare(
      `SELECT * FROM leisure_segments
        WHERE started_at >= ?
        ORDER BY started_at DESC`,
    )
    .all(cutoff);
}

function clearAllActivity() {
  // Nuke every activity surface — buckets, sessions, time entries, leisure.
  // Used by Settings → Data → "Clear activity history".
  const tx = db.transaction(() => {
    db.exec("DELETE FROM activity_buckets");
    try { db.exec("DELETE FROM activity_sessions"); } catch {}
    try { db.exec("DELETE FROM time_entries"); } catch {}
    try { db.exec("DELETE FROM leisure_segments"); } catch {}
  });
  try { tx(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

// Wipe every class + schedule override + course material. After this the
// timetable is fully empty; the `classes.seeded` flag stays set so they
// don't auto-recreate on next launch.
function clearAllSchedule() {
  const tx = db.transaction(() => {
    try { db.exec("DELETE FROM classes"); } catch {}
    try { db.exec("DELETE FROM class_overrides"); } catch {}
    try { db.exec("DELETE FROM academic_calendar"); } catch {}
    try { db.exec("DELETE FROM course_materials"); } catch {}
    // Keep `classes.seeded` so we never re-seed defaults.
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('classes.seeded', '1')",
    ).run();
  });
  try { tx(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

function searchAllRepos(query, limit = 80) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  // Pull everything (cheap — repos table is small) then filter in JS.
  // We also LEFT JOIN repo_summaries so the search hay includes the AI's
  // structured summary (oneliner / architecture / tech_stack / what
  // someone could learn from it) — this is the difference between a
  // pure keyword match ("rag" finds 2 repos) and a semantic-ish hit
  // ("rag" finds repos that DESCRIBE building retrieval flows).
  const rows = db
    .prepare(
      `SELECT r.*, p.name AS person_name, p.github_username AS person_handle,
              p.avatar_url AS person_avatar,
              rs.payload AS ai_summary_json
         FROM repos r JOIN people p ON p.id = r.person_id
         LEFT JOIN repo_summaries rs ON rs.repo_id = r.id
        ORDER BY r.stars DESC NULLS LAST, r.pushed_at DESC NULLS LAST`,
    )
    .all();
  const out = [];
  for (const r of rows) {
    const topics = safeJson(r.topics, []);
    const langs = safeJson(r.languages, {});
    const langKeys = Object.keys(langs).map((k) => k.toLowerCase());
    // Pull the AI summary text into the search hay so semantic matches
    // (e.g. "rag" matches "uses an embedding store for retrieval") work.
    let aiHay = "";
    if (r.ai_summary_json) {
      try {
        const a = JSON.parse(r.ai_summary_json);
        aiHay = [
          a.oneliner || "",
          a.architecture || "",
          (a.tech_stack || []).join(" "),
          (a.things_to_learn || []).map((x) => typeof x === "string" ? x : x?.text || "").join(" "),
        ].join(" ");
      } catch { /* ignore */ }
    }
    const hay = [
      String(r.name || ""),
      String(r.description || ""),
      String(r.language || ""),
      topics.join(" "),
      langKeys.join(" "),
      aiHay,
    ].join(" ").toLowerCase();
    if (hay.includes(q)) {
      out.push({
        id: r.id,
        person_id: r.person_id,
        person_name: r.person_name,
        person_handle: r.person_handle,
        person_avatar: r.person_avatar,
        name: r.name,
        full_name: r.full_name,
        description: r.description,
        url: r.url,
        language: r.language,
        languages: langs,
        topics,
        stars: r.stars ?? 0,
        forks: r.forks ?? 0,
        pushed_at: r.pushed_at,
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}
function upsertRepo(r) {
  db.prepare(
    `INSERT INTO repos (person_id, github_id, name, full_name, description, url,
       language, languages, topics, stars, forks, pushed_at, fetched_at)
     VALUES (@person_id, @github_id, @name, @full_name, @description, @url,
       @language, @languages, @topics, @stars, @forks, @pushed_at, datetime('now'))
     ON CONFLICT(full_name) DO UPDATE SET
       description=excluded.description, language=excluded.language,
       languages=excluded.languages, topics=excluded.topics,
       stars=excluded.stars, forks=excluded.forks, pushed_at=excluded.pushed_at,
       fetched_at=datetime('now')`,
  ).run({
    person_id: r.person_id,
    github_id: r.github_id,
    name: r.name,
    full_name: r.full_name,
    description: r.description ?? null,
    url: r.url,
    language: r.language ?? null,
    languages: JSON.stringify(r.languages ?? {}),
    topics: JSON.stringify(r.topics ?? []),
    stars: r.stars ?? 0,
    forks: r.forks ?? 0,
    pushed_at: r.pushed_at ?? null,
  });
}
// ───────────────────────────────────────────────────────────────────────────
// day_notes — private per-day journal entries.
// ───────────────────────────────────────────────────────────────────────────
function getDayNote(date) {
  const row = db.prepare(`SELECT * FROM day_notes WHERE date = ?`).get(date);
  return row || null;
}
function upsertDayNote({ date, body, isPrivate }) {
  if (!date) throw new Error("date required");
  const existing = db.prepare(`SELECT date FROM day_notes WHERE date = ?`).get(date);
  const priv = isPrivate === false ? 0 : 1;
  if (existing) {
    db.prepare(
      `UPDATE day_notes SET body = ?, private = ?, updated_at = datetime('now') WHERE date = ?`,
    ).run(body || "", priv, date);
  } else {
    db.prepare(
      `INSERT INTO day_notes (date, body, private) VALUES (?, ?, ?)`,
    ).run(date, body || "", priv);
  }
  return getDayNote(date);
}
function setDayNoteSummary(date, summary) {
  db.prepare(
    `UPDATE day_notes SET summary = ?, updated_at = datetime('now') WHERE date = ?`,
  ).run(summary || null, date);
  return getDayNote(date);
}
function listDayNoteDates(limit = 60) {
  return db
    .prepare(
      `SELECT date, updated_at, LENGTH(body) AS chars, private FROM day_notes
       ORDER BY date DESC LIMIT ?`,
    )
    .all(limit);
}
function deleteDayNote(date) {
  db.prepare(`DELETE FROM day_notes WHERE date = ?`).run(date);
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Day-notes passcode. A lightweight gate for the history-view UI — it is
// NOT disk encryption (the bodies still sit plaintext in SQLite at rest),
// but it ensures a casual onlooker can't tap "View history" and read past
// entries. Hash is stored salted in settings.
//
// Scheme: scrypt(passcode, salt, 32) → stored as "scrypt:<saltHex>:<hashHex>".
// ───────────────────────────────────────────────────────────────────────────
function hashDayNoteSecret(plaintext) {
  const text = String(plaintext || "");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(text, salt, 32);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyDayNoteSecret(plaintext, stored) {
  if (!stored || !stored.startsWith("scrypt:")) return false;
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const got = crypto.scryptSync(String(plaintext || ""), salt, 32);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch {
    return false;
  }
}

function hasDayNotePasscode() {
  const v = getSetting("dayNotes.passcodeHash");
  return !!(v && v.startsWith("scrypt:"));
}
function setDayNotePasscode(plaintext) {
  const text = String(plaintext || "");
  if (text.length < 3) throw new Error("Passcode must be at least 3 characters");
  setSetting("dayNotes.passcodeHash", hashDayNoteSecret(text));
  return true;
}
function verifyDayNotePasscode(plaintext) {
  return verifyDayNoteSecret(plaintext, getSetting("dayNotes.passcodeHash"));
}
function normalizeDayNoteRecoveryCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function generateDayNoteRecoveryCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(16);
  let raw = "";
  for (const byte of bytes) raw += alphabet[byte % alphabet.length];
  return raw.match(/.{1,4}/g).join("-");
}
function setDayNoteRecoveryCode(code) {
  const text = normalizeDayNoteRecoveryCode(code);
  if (text.length < 12) throw new Error("Recovery code must be at least 12 characters");
  setSetting("dayNotes.recoveryHash", hashDayNoteSecret(text));
  return true;
}
function resetDayNoteRecoveryCode() {
  const code = generateDayNoteRecoveryCode();
  setDayNoteRecoveryCode(code);
  return code;
}
function hasDayNoteRecoveryCode() {
  const v = getSetting("dayNotes.recoveryHash");
  return !!(v && v.startsWith("scrypt:"));
}
function verifyDayNoteRecoveryCode(code) {
  return verifyDayNoteSecret(
    normalizeDayNoteRecoveryCode(code),
    getSetting("dayNotes.recoveryHash"),
  );
}
function clearDayNotePasscode() {
  setSetting("dayNotes.passcodeHash", "");
  setSetting("dayNotes.recoveryHash", "");
  return true;
}

function importPeople(members) {
  // Dedupe and guard against role-like names (a common scraper bug where
  // "associate"/"mentor"/"member" role headings leak in as the person's name).
  const cleaned = (members || []).map(sanitiseMember).filter(Boolean);
  const tx = db.transaction((list) => list.map((m) => upsertPerson(m)));
  return tx(cleaned);
}

// Role/title words that scrapers sometimes mistake for a person's name.
const PERSON_ROLE_WORDS = new Set([
  "associate", "associates", "mentor", "mentors", "member", "members",
  "alumni", "alumnus", "lead", "leads", "head", "heads", "president",
  "vicepresident", "vice-president", "secretary", "treasurer",
  "founder", "cofounder", "co-founder", "faculty", "advisor", "advisors",
  "coordinator", "coordinators", "director", "intern", "interns",
  "contributor", "contributors", "maintainer", "maintainers",
  "student", "students", "staff", "team", "meettheteam",
  "syndicate", "syndicates", "github", "linkedin", "twitter",
  "website", "portfolio", "email", "mail", "resume"
]);

function looksLikeRoleName(name) {
  if (!name) return false;
  const normalised = String(name).trim().toLowerCase().replace(/[^a-z\s-]/g, "").replace(/\s+/g, "");
  if (!normalised) return false;
  return PERSON_ROLE_WORDS.has(normalised);
}

function linkedinHandleFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : null;
}

function sanitiseMember(m) {
  if (!m) return null;
  const out = { ...m };
  if (looksLikeRoleName(out.name)) {
    // Prefer GitHub handle, then LinkedIn vanity, then null (upsert will keep
    // whatever name is already on the matching row).
    out.name = out.github_username || linkedinHandleFromUrl(out.linkedin_url) || null;
  }
  // Final safety net: collapse empty strings to null so we don't overwrite
  // existing names with "".
  if (out.name === "") out.name = null;
  return out;
}

// One-shot cleanup of existing rows whose `name` is a role word. Also collapses
// duplicates that share the same linkedin_url. Called from open() on startup;
// idempotent.
function cleanupRolePeople() {
  try {
    const rows = db.prepare(`SELECT id, name, github_username, linkedin_url FROM people`).all();
    let fixed = 0;
    for (const r of rows) {
      if (!looksLikeRoleName(r.name)) continue;
      const better = r.github_username || linkedinHandleFromUrl(r.linkedin_url);
      if (!better) continue;
      db.prepare(`UPDATE people SET name = ? WHERE id = ?`).run(better, r.id);
      fixed++;
    }
    if (fixed > 0) console.log(`[db] cleaned ${fixed} role-like person names`);

    // Dedupe by linkedin_url when github_username is missing. Keep the row with
    // the richer data (github/lc/cf/cc non-null) or the oldest id.
    const liGroups = db
      .prepare(
        `SELECT linkedin_url, COUNT(*) AS n FROM people
          WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
            AND (github_username IS NULL OR github_username = '')
          GROUP BY linkedin_url HAVING n > 1`,
      )
      .all();
    let dropped = 0;
    for (const g of liGroups) {
      const dupes = db
        .prepare(
          `SELECT * FROM people WHERE linkedin_url = ?
                AND (github_username IS NULL OR github_username = '')
              ORDER BY id ASC`,
        )
        .all(g.linkedin_url);
      if (dupes.length < 2) continue;
      // Pick a canonical: the one with a real (non-role) name first, else id asc.
      const canonical =
        dupes.find((r) => r.name && !looksLikeRoleName(r.name)) || dupes[0];
      for (const d of dupes) {
        if (d.id === canonical.id) continue;
        // Merge tags
        const merged = Array.from(
          new Set([...safeJson(canonical.tags, []), ...safeJson(d.tags, [])]),
        );
        db.prepare(`UPDATE people SET tags = ? WHERE id = ?`).run(
          JSON.stringify(merged),
          canonical.id,
        );
        db.prepare(`DELETE FROM people WHERE id = ?`).run(d.id);
        dropped++;
      }
    }
    if (dropped > 0) console.log(`[db] collapsed ${dropped} duplicate LinkedIn-only people`);
  } catch (err) {
    console.warn("[db] role-name cleanup failed:", err.message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// cp stats + submissions
// ───────────────────────────────────────────────────────────────────────────
function getCpStats(personId) {
  return db.prepare(`SELECT * FROM cp_stats WHERE person_id = ?`).all(personId);
}
function upsertCpStats(personId, platform, stats, error = null) {
  db.prepare(
    `INSERT INTO cp_stats (person_id, platform, handle, stats, error, fetched_at)
     VALUES (@person_id, @platform, @handle, @stats, @error, datetime('now'))
     ON CONFLICT(person_id, platform) DO UPDATE SET
       handle = excluded.handle, stats = excluded.stats, error = excluded.error,
       fetched_at = datetime('now')`,
  ).run({
    person_id: personId,
    platform,
    handle: stats?.handle ?? null,
    stats: JSON.stringify(stats ?? {}),
    error: error ?? null,
  });
  return db
    .prepare("SELECT * FROM cp_stats WHERE person_id = ? AND platform = ?")
    .get(personId, platform);
}
function listAllCpStats() {
  const rows = db.prepare(`SELECT * FROM cp_stats`).all();
  return rows.map((r) => ({ ...r, stats: safeJson(r.stats, {}) }));
}
function insertCpSubmissions(personId, platform, subs) {
  if (!subs || subs.length === 0) return;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO cp_submissions
       (person_id, platform, problem_id, title, verdict, rating, submitted_at, url)
     VALUES (@person_id, @platform, @problem_id, @title, @verdict, @rating, @submitted_at, @url)`,
  );
  const tx = db.transaction((list) => {
    for (const s of list) {
      ins.run({
        person_id: personId,
        platform,
        problem_id: s.problem_id ?? null,
        title: s.title ?? null,
        verdict: s.verdict ?? null,
        rating: s.rating ?? null,
        submitted_at: s.submitted_at ?? null,
        url: s.url ?? null,
      });
    }
  });
  tx(subs);
}
function recentCpSubmissions(personId, limit = 10) {
  return db
    .prepare(
      `SELECT * FROM cp_submissions WHERE person_id = ?
     ORDER BY submitted_at DESC LIMIT ?`,
    )
    .all(personId, limit);
}

// Friends' CP stats for a given platform, ranked by the most useful metric.
// Returns [{person_id, name, handle, stats, error, fetched_at}] sorted desc.
function cpLeaderboard(platform, opts = {}) {
  const rows = db
    .prepare(
      `SELECT cp.*, p.name AS person_name, p.avatar_url
     FROM cp_stats cp JOIN people p ON p.id = cp.person_id
     WHERE cp.platform = ?`,
    )
    .all(platform);
  const parsed = rows.map((r) => {
    const stats = safeJson(r.stats, {});
    // Combined score: weight problems-solved + contest-rating so the
    // ranking reflects both grind AND contest skill. Rating sits on a
    // 1500-3000 scale, totalSolved on a 0-1000 scale; we scale rating by
    // 0.1 so a 1500-rated coder gets +150 to their score — meaningful but
    // not overwhelming. Lets a 200-solved + 2200-rated CFist beat a
    // 250-solved + unrated grinder.
    const totalSolved = stats.totalSolved ?? 0;
    const rating = stats.rating ?? 0;
    const combinedScore = totalSolved + Math.round(rating * 0.1);
    return {
      person_id: r.person_id,
      person_name: r.person_name,
      avatar_url: r.avatar_url,
      platform: r.platform,
      handle: r.handle,
      error: r.error,
      fetched_at: r.fetched_at,
      stats,
      // Promote a few fields to top-level so the UI can render them
      // without re-parsing nested stats every time.
      rating: rating || null,
      maxRating: stats.maxRating ?? null,
      contests: stats.contests ?? null,
      totalSolved,
      combinedScore,
    };
  });
  // Sort mode:
  //   "combined" (default for leetcode) — totalSolved + rating*0.1
  //   "rating"   (default for cf/cc)    — pure contest rating
  //   "solved"                          — totalSolved only
  const sortBy = opts.sortBy ||
    (platform === "leetcode" ? "combined" : "rating");
  const cmp = {
    combined: (a, b) => b.combinedScore - a.combinedScore,
    rating:   (a, b) => (b.rating || 0) - (a.rating || 0),
    solved:   (a, b) => b.totalSolved - a.totalSolved,
  }[sortBy] || ((a, b) => b.combinedScore - a.combinedScore);
  parsed.sort(cmp);
  return parsed;
}
// Alias for parity with UI expectations.
const listCpStats = getCpStats;

// ───────────────────────────────────────────────────────────────────────────
// time entries + activity totals
// ───────────────────────────────────────────────────────────────────────────
function addTimeEntry(e) {
  db.prepare(
    `INSERT INTO time_entries (date, app_name, category, minutes, note)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    e.date ?? isoDate(new Date()),
    e.app_name ?? null,
    e.category ?? "neutral",
    e.minutes ?? 0,
    e.note ?? null,
  );
  return true;
}
function listTimeEntriesOn(date) {
  return db
    .prepare(`SELECT * FROM time_entries WHERE date = ? ORDER BY id DESC`)
    .all(date);
}
function activityTotalsOn(date) {
  const t = db
    .prepare(
      `SELECT category, COALESCE(SUM(minutes), 0) AS mins
     FROM time_entries WHERE date = ? GROUP BY category`,
    )
    .all(date);
  const s = db
    .prepare(
      `SELECT category, COALESCE(SUM(minutes), 0) AS mins
     FROM activity_sessions WHERE date = ? GROUP BY category`,
    )
    .all(date);
  const out = {
    productive: 0,
    distraction: 0,
    neutral: 0,
    rest: 0,
    leisure: 0,
    mobile: 0,
  };
  for (const r of t) out[r.category] = (out[r.category] ?? 0) + r.mins;
  for (const r of s) out[r.category] = (out[r.category] ?? 0) + r.mins;
  return out;
}

// 7-day average by category, used by the compact burnout card + Ollama
// burnoutCheck to diff today vs. the week.
function activityTrend(days = 7) {
  const rows = db
    .prepare(
      `
    SELECT date, category, SUM(minutes) as mins
    FROM (
      SELECT date, category, minutes FROM time_entries
      UNION ALL
      SELECT date, category, minutes FROM activity_sessions
    )
    WHERE date >= date('now', ?)
    GROUP BY date, category
    ORDER BY date ASC
  `,
    )
    .all(`-${days} days`);

  const map = new Map();

  for (const r of rows) {
    if (!map.has(r.date)) {
      map.set(r.date, {
        date: r.date,
        productive: 0,
        distraction: 0,
        neutral: 0,
        rest: 0,
        leisure: 0,
        mobile: 0,
        other: 0,
      });
    }

    const day = map.get(r.date);

    if (r.category in day) {
      day[r.category] += r.mins;
    } else {
      day.other += r.mins;
    }
  }

  return fillMissingDays([...map.values()], days);
}
function fillMissingDays(data, days) {
  const map = new Map(data.map((d) => [d.date, d]));
  const result = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);

    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    result.push(
      map.get(key) || {
        date: key,
        productive: 0,
        distraction: 0,
        neutral: 0,
        rest: 0,
        leisure: 0,
        mobile: 0,
        other: 0,
      },
    );
  }

  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// activity_sessions (active-window tracking, ADB wellbeing imports)
// ───────────────────────────────────────────────────────────────────────────
function addActivitySession(s) {
  db.prepare(
    `INSERT INTO activity_sessions
     (date, source, app, window_title, category, started_at, ended_at, minutes, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.date ?? isoDate(new Date()),
    s.source ?? "desktop",
    s.app ?? null,
    s.window_title ?? null,
    s.category ?? "neutral",
    s.started_at ?? null,
    s.ended_at ?? null,
    s.minutes ?? 0,
    s.note ?? null,
  );
  return true;
}

// Upsert a session by (source + started_at). Used by the desktop tracker to
// "checkpoint" long-running sessions so their minutes become visible before
// the user switches apps. The composite key makes this idempotent.
function upsertActivitySession(s) {
  const existing = db
    .prepare(
      `SELECT id FROM activity_sessions
       WHERE source = ? AND started_at = ?`,
    )
    .get(s.source ?? "desktop", s.started_at ?? "");
  if (existing) {
    db.prepare(
      `UPDATE activity_sessions
         SET window_title = ?, ended_at = ?, minutes = ?, category = ?
       WHERE id = ?`,
    ).run(
      s.window_title ?? null,
      s.ended_at ?? null,
      s.minutes ?? 0,
      s.category ?? "neutral",
      existing.id,
    );
    return existing.id;
  }
  const info = db
    .prepare(
      `INSERT INTO activity_sessions
        (date, source, app, window_title, category, started_at, ended_at, minutes, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      s.date ?? isoDate(new Date()),
      s.source ?? "desktop",
      s.app ?? null,
      s.window_title ?? null,
      s.category ?? "neutral",
      s.started_at ?? null,
      s.ended_at ?? null,
      s.minutes ?? 0,
      s.note ?? null,
    );
  return info.lastInsertRowid;
}
function topAppsOn(date, limit = 10) {
  return db
    .prepare(
      `SELECT app, category, SUM(minutes) AS minutes,
              GROUP_CONCAT(DISTINCT source) AS sources
     FROM activity_sessions WHERE date = ?
       AND source NOT IN ('timer', 'manual')
     GROUP BY app ORDER BY minutes DESC LIMIT ?`,
    )
    .all(date, limit);
}
function focusBlocksOn(date, limit = 12) {
  return db
    .prepare(
      `SELECT id, app AS title, window_title AS kind, category, started_at, ended_at, minutes, note
         FROM activity_sessions
        WHERE date = ?
          AND source = 'timer'
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(date, Math.max(1, Math.min(50, +limit || 12)));
}
function activitySessionsRange(startIso, endIso) {
  return db
    .prepare(
      `SELECT * FROM activity_sessions WHERE date BETWEEN ? AND ? ORDER BY started_at DESC`,
    )
    .all(startIso, endIso);
}

// Apply a category override retroactively — used by the Top apps "click chip
// to recategorise" flow. Without this the override only affects future
// tracker ticks; the visible day's totals don't change until the user
// switches apps. `days` defaults to 30 so very old history isn't rewritten.
function reclassifyAppCategory(app, category, { days = 30 } = {}) {
  if (!app || !category) return { ok: false, error: "app + category required" };
  const info = db
    .prepare(
      `UPDATE activity_sessions
         SET category = ?
       WHERE LOWER(app) = LOWER(?)
         AND date >= date('now', ?)`,
    )
    .run(category, app, `-${Math.max(1, +days)} days`);
  return { ok: true, updated: info.changes ?? 0 };
}

// ───────────────────────────────────────────────────────────────────────────
// repo_summaries (cache of Ollama "what is this project")
// ───────────────────────────────────────────────────────────────────────────
function getRepoSummary(repoId) {
  const row = db
    .prepare("SELECT * FROM repo_summaries WHERE repo_id = ?")
    .get(repoId);
  return row ? { ...row, payload: safeJson(row.payload, {}) } : null;
}
function saveRepoSummary(repoId, payload, model) {
  db.prepare(
    `INSERT INTO repo_summaries (repo_id, payload, model, created_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(repo_id) DO UPDATE SET payload=excluded.payload, model=excluded.model, created_at=excluded.created_at`,
  ).run(repoId, JSON.stringify(payload), model ?? null);
}

// ───────────────────────────────────────────────────────────────────────────
// activity_feed (recent pushes / events per person)
// ───────────────────────────────────────────────────────────────────────────
function insertActivityFeed(personId, pushes) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO activity_feed (person_id, kind, repo, message, url, at)
     VALUES (?, 'gh:push', ?, ?, ?, ?)`,
  );
  const tx = db.transaction((list) => {
    for (const p of list)
      ins.run(
        personId,
        p.repo ?? null,
        p.message ?? null,
        p.url ?? null,
        p.at ?? null,
      );
  });
  tx(pushes);
  return pushes.length;
}
// 14-day push heat-strip per person — `[{ date, n }]` newest-first.
// Used by the People grid to render a tiny per-card calendar so you can
// see at a glance who's been shipping. Cheap query — single GROUP BY.
function pushHeatStrip(personId, days = 14) {
  if (!personId) return [];
  const rows = db
    .prepare(
      `SELECT date(at) AS date, COUNT(*) AS n
         FROM activity_feed
        WHERE person_id = ?
          AND at >= date('now', ?)
        GROUP BY date(at)
        ORDER BY date(at) DESC`,
    )
    .all(personId, `-${Math.max(1, +days || 14)} days`);
  return rows;
}
// Batch heat strips for many people at once — saves N IPC round-trips.
function pushHeatStripsFor(ids, days = 14) {
  const out = {};
  for (const id of ids || []) out[id] = pushHeatStrip(id, days);
  return out;
}

function listActivityFeed({ days = 7, personId, limit = 100 } = {}) {
  const where = [`at >= date('now', ?)`];
  const args = [`-${days} days`];
  if (personId) {
    where.push("person_id = ?");
    args.push(personId);
  }
  const sql = `SELECT f.*, p.name AS person_name, p.github_username
     FROM activity_feed f JOIN people p ON p.id = f.person_id
     WHERE ${where.join(" AND ")}
     ORDER BY at DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit);
}

// ───────────────────────────────────────────────────────────────────────────
// burnout reports
// ───────────────────────────────────────────────────────────────────────────
function saveBurnoutReport(date, payload) {
  db.prepare(
    `INSERT INTO burnout_reports (date, payload) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET payload = excluded.payload`,
  ).run(date, JSON.stringify(payload));
  return payload;
}
function latestBurnoutReport() {
  const row = db
    .prepare(`SELECT * FROM burnout_reports ORDER BY date DESC LIMIT 1`)
    .get();
  return row ? { ...row, payload: safeJson(row.payload, {}) } : null;
}

// Last N burnout reports newest-first. Each row exposes `risk_score` plucked
// from the JSON payload so the UI can render a trend strip without parsing.
function recentBurnoutReports(days = 7) {
  const rows = db
    .prepare(
      `SELECT date, payload FROM burnout_reports
       WHERE date >= date('now', ?)
       ORDER BY date DESC`
    )
    .all(`-${Math.max(1, +days || 7)} days`);
  return rows.map((r) => {
    const p = safeJson(r.payload, {});
    return {
      date: r.date,
      risk_score: typeof p.risk_score === "number" ? p.risk_score : null,
      summary: p.summary || null,
    };
  });
}

// ───────────────────────────────────────────────────────────────────────────
// live_timer — a singleton row tracking what the user is doing right now.
// At most one timer is active at a time. When stopped or expired, the caller
// is expected to also write into activity_sessions so the day's totals
// reflect it.
// ───────────────────────────────────────────────────────────────────────────
function getActiveTimer() {
  const row = db.prepare(`SELECT * FROM live_timer WHERE id = 1`).get();
  return row || null;
}
function startTimer(p) {
  const now = p.started_at || new Date().toISOString();
  const planned = Math.max(1, Math.round(+p.planned_minutes || 25));
  db.prepare(`DELETE FROM live_timer WHERE id = 1`).run();
  db.prepare(
    `INSERT INTO live_timer
       (id, kind, category, title, description, task_id, started_at, planned_minutes, extended_minutes)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    p.kind || "task",
    p.category || categoryForTimerKind(p.kind),
    p.title || "Focus",
    p.description || null,
    p.task_id || null,
    now,
    planned,
  );
  return getActiveTimer();
}
function extendTimer(byMinutes) {
  const m = Math.max(1, Math.round(+byMinutes || 0));
  if (!m) return getActiveTimer();
  db.prepare(
    `UPDATE live_timer SET extended_minutes = extended_minutes + ? WHERE id = 1`,
  ).run(m);
  return getActiveTimer();
}
function clearTimer() {
  db.prepare(`DELETE FROM live_timer WHERE id = 1`).run();
}

// Map a user-facing timer kind to the activity_sessions category used by the
// dashboard's Top apps strip + stats. Keep this in sync with the categories
// emitted by activityTracker.inferCategory.
function categoryForTimerKind(kind) {
  switch ((kind || "").toLowerCase()) {
    case "task":
    case "study":
    case "deep":
    case "deepwork":
    case "deep work":
    case "project":
    case "academic":
    case "academics":
      return "productive";
    case "distraction":
    case "social-media":
    case "social media":
      return "distraction";
    case "leisure":
    case "gaming":
    case "social":
    case "music":
      return "leisure";
    case "rest":
    case "sleep":
    case "nap":
    case "meditation":
      return "rest";
    case "exercise":
    case "workout":
    case "outdoor":
    case "walk":
      return "rest"; // count restorative movement as rest in the strip
    case "break":
    case "transit":
    case "commute":
    case "errand":
      return "neutral";
    case "habit":
      return "productive";
    default:
      return "neutral";
  }
}

// ───────────────────────────────────────────────────────────────────────────
// zen_sessions — focused app-lock sessions layered on top of the live timer.
// Strict/relaxed/locked behavior is enforced in main.cjs; persistence lives here.
// ───────────────────────────────────────────────────────────────────────────
function rowToZen(r) {
  if (!r) return null;
  const ends = new Date(r.ends_at).getTime();
  let violationEvents = [];
  try {
    violationEvents = zenViolationsFor(r.id, 24);
  } catch { violationEvents = []; }
  return {
    ...r,
    allowed_apps: safeJson(r.allowed_apps, []),
    blocked_apps: safeJson(r.blocked_apps, []),
    violation_events: violationEvents,
    created_playlist: !!r.created_playlist,
    remaining_seconds: Number.isFinite(ends)
      ? Math.max(0, Math.ceil((ends - Date.now()) / 1000))
      : 0,
  };
}
function activeZenSession() {
  const row = db
    .prepare(
      `SELECT * FROM zen_sessions
        WHERE status = 'active'
        ORDER BY started_at DESC
        LIMIT 1`,
    )
    .get();
  return rowToZen(row);
}
function startZenSession(p = {}) {
  const existing = activeZenSession();
  if (existing) stopZenSession("interrupted");
  const started = p.started_at ? new Date(p.started_at) : new Date();
  const planned = Math.max(1, Math.min(600, Math.round(+p.planned_minutes || 50)));
  const ends = new Date(started.getTime() + planned * 60_000);
  const allowed = Array.isArray(p.allowed_apps) ? p.allowed_apps : [];
  const blocked = Array.isArray(p.blocked_apps) ? p.blocked_apps : [];
  const mode = ["relaxed", "strict", "locked"].includes(p.mode) ? p.mode : "strict";
  const info = db
    .prepare(
      `INSERT INTO zen_sessions
        (status, mode, title, profile, allowed_apps, blocked_apps,
         planned_minutes, started_at, ends_at, playlist_id, playlist_uri,
         playlist_name, created_playlist, note)
       VALUES
        ('active', @mode, @title, @profile, @allowed, @blocked,
         @planned, @started, @ends, @playlistId, @playlistUri,
         @playlistName, @createdPlaylist, @note)`,
    )
    .run({
      mode,
      title: (p.title || "Deep work").trim(),
      profile: ["deep", "flow", "calm"].includes(p.profile) ? p.profile : "deep",
      allowed: JSON.stringify(allowed.map((x) => String(x).trim()).filter(Boolean)),
      blocked: JSON.stringify(blocked.map((x) => String(x).trim()).filter(Boolean)),
      planned,
      started: started.toISOString(),
      ends: ends.toISOString(),
      playlistId: p.playlist_id || null,
      playlistUri: p.playlist_uri || null,
      playlistName: p.playlist_name || null,
      createdPlaylist: p.created_playlist ? 1 : 0,
      note: p.note || null,
    });
  return rowToZen(
    db.prepare(`SELECT * FROM zen_sessions WHERE id = ?`).get(info.lastInsertRowid),
  );
}
function extendZenSession(byMinutes) {
  const row = activeZenSession();
  if (!row) return null;
  const m = Math.max(1, Math.min(180, Math.round(+byMinutes || 0)));
  const ends = new Date(new Date(row.ends_at).getTime() + m * 60_000);
  db.prepare(
    `UPDATE zen_sessions
        SET planned_minutes = planned_minutes + ?,
            ends_at = ?
      WHERE id = ?`,
  ).run(m, ends.toISOString(), row.id);
  return activeZenSession();
}
function stopZenSession(reason = "stopped") {
  const row = activeZenSession();
  if (!row) return null;
  const now = new Date();
  const completed = now.getTime() >= new Date(row.ends_at).getTime();
  const status = reason === "cancelled"
    ? "cancelled"
    : reason === "interrupted"
      ? "interrupted"
      : completed || reason === "completed"
        ? "completed"
        : "stopped";
  db.prepare(
    `UPDATE zen_sessions
        SET status = ?, ended_at = ?
      WHERE id = ?`,
  ).run(status, now.toISOString(), row.id);
  return rowToZen(db.prepare(`SELECT * FROM zen_sessions WHERE id = ?`).get(row.id));
}
function recordZenViolation(v = {}) {
  const row = activeZenSession();
  if (!row) return null;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO zen_violations (session_id, at, app, title, reason, category)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(row.id, now, v.app || null, v.title || null, v.reason || null, v.category || null);
    db.prepare(
      `UPDATE zen_sessions
          SET violations = violations + 1,
              last_violation_at = ?,
              last_violation_app = ?,
              last_violation_title = ?
        WHERE id = ?`,
    ).run(now, v.app || null, v.title || null, row.id);
  });
  tx();
  return activeZenSession();
}
function zenViolationsFor(sessionId, limit = 24) {
  if (!sessionId) return [];
  return db
    .prepare(
      `SELECT at, app, title, reason, category
         FROM zen_violations
        WHERE session_id = ?
        ORDER BY at DESC
        LIMIT ?`,
    )
    .all(sessionId, Math.max(1, Math.min(100, +limit || 24)));
}
function zenSessionsOn(date, limit = 12) {
  return db
    .prepare(
      `SELECT * FROM zen_sessions
        WHERE substr(started_at, 1, 10) = ?
           OR substr(COALESCE(ended_at, ''), 1, 10) = ?
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(date, date, Math.max(1, Math.min(50, +limit || 12)))
    .map(rowToZen);
}
function rowWithJsonPayload(row) {
  return row ? { ...row, payload: safeJson(row.payload, {}) } : row;
}
function taskEventsOn(date, limit = 100) {
  return db
    .prepare(
      `SELECT * FROM task_events
        WHERE date = ?
        ORDER BY at DESC, id DESC
        LIMIT ?`,
    )
    .all(date, Math.max(1, Math.min(300, +limit || 100)))
    .map(rowWithJsonPayload);
}
function routineEventsOn(date, { kinds = null, limit = 120 } = {}) {
  let sql = `SELECT * FROM routine_events WHERE date = ?`;
  const args = [date];
  if (Array.isArray(kinds) && kinds.length) {
    sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
    args.push(...kinds);
  }
  sql += ` ORDER BY at DESC, id DESC LIMIT ?`;
  args.push(Math.max(1, Math.min(300, +limit || 120)));
  return db.prepare(sql).all(...args).map(rowWithJsonPayload);
}
function distractionLogOn(date, limit = 24) {
  return db
    .prepare(
      `SELECT id, source, app, window_title, category, started_at, ended_at, minutes, note
         FROM activity_sessions
        WHERE date = ?
          AND category = 'distraction'
        ORDER BY minutes DESC, started_at DESC
        LIMIT ?`,
    )
    .all(date, Math.max(1, Math.min(100, +limit || 24)));
}
function appCloseEventsOn(date, limit = 24) {
  return routineEventsOn(date, {
    kinds: ["close_blocked", "close_reason", "app_close"],
    limit,
  });
}
function daySummaryOn(date = isoDate(new Date())) {
  const iso = date || isoDate(new Date());
  const burnoutRow = db
    .prepare(`SELECT * FROM burnout_reports WHERE date = ? ORDER BY created_at DESC LIMIT 1`)
    .get(iso);
  const dayNote = getDayNote(iso);
  const openTasks = db
    .prepare(
      `SELECT * FROM tasks
        WHERE completed = 0
        ORDER BY priority ASC,
                 CASE WHEN deadline IS NULL THEN 1 ELSE 0 END,
                 deadline ASC,
                 updated_at DESC
        LIMIT 20`,
    )
    .all()
    .map(rowToTask);
  return {
    date: iso,
    generated_at: new Date().toISOString(),
    checkin: getCheckinByDate(iso),
    totals: activityTotalsOn(iso),
    topApps: topAppsOn(iso, 10),
    focusBlocks: focusBlocksOn(iso, 12),
    distractions: distractionLogOn(iso, 24),
    zenSessions: zenSessionsOn(iso, 12),
    closeEvents: appCloseEventsOn(iso, 24),
    routineEvents: routineEventsOn(iso, {
      kinds: ["app_open", "wake_done", "sleep_done", "objective_done", "routine_nudge"],
      limit: 40,
    }),
    taskEvents: taskEventsOn(iso, 100),
    completedTasks: tasksCompletedOn(iso),
    openTasks,
    weeklyGoals: listWeeklyGoals(),
    burnoutReport: burnoutRow
      ? { ...burnoutRow, payload: safeJson(burnoutRow.payload, {}) }
      : null,
    dayNoteSummary: dayNote?.summary || null,
  };
}
function recentZenSessions(limit = 12) {
  return db
    .prepare(
      `SELECT * FROM zen_sessions
        ORDER BY started_at DESC
        LIMIT ?`,
    )
    .all(Math.max(1, Math.min(50, +limit || 12)))
    .map(rowToZen);
}

// ───────────────────────────────────────────────────────────────────────────
// class_overrides — per-date edits to the timetable. status is one of
// 'cancelled' | 'moved' | 'replaced' | 'added'. class_id can be null for
// 'added' rows (extra one-off class for the day).
// ───────────────────────────────────────────────────────────────────────────
function listClassOverrides(date) {
  return db
    .prepare(
      `SELECT * FROM class_overrides WHERE date = ? ORDER BY start_time ASC`,
    )
    .all(date);
}
function setClassOverride(date, classId, patch) {
  if (!classId) throw new Error("setClassOverride requires a classId");
  const existing = db
    .prepare(`SELECT id FROM class_overrides WHERE date = ? AND class_id = ?`)
    .get(date, classId);
  const status = patch.status || "moved";
  if (existing) {
    db.prepare(
      `UPDATE class_overrides
         SET status = ?, subject = ?, code = ?, start_time = ?, end_time = ?,
             room = ?, faculty = ?, kind = ?, note = ?
       WHERE id = ?`,
    ).run(
      status,
      patch.subject ?? null,
      patch.code ?? null,
      patch.start_time ?? null,
      patch.end_time ?? null,
      patch.room ?? null,
      patch.faculty ?? null,
      patch.kind ?? null,
      patch.note ?? null,
      existing.id,
    );
    return existing.id;
  }
  const info = db
    .prepare(
      `INSERT INTO class_overrides
         (date, class_id, status, subject, code, start_time, end_time, room, faculty, kind, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      date,
      classId,
      status,
      patch.subject ?? null,
      patch.code ?? null,
      patch.start_time ?? null,
      patch.end_time ?? null,
      patch.room ?? null,
      patch.faculty ?? null,
      patch.kind ?? null,
      patch.note ?? null,
    );
  return info.lastInsertRowid;
}
function addExtraClass(date, p) {
  const info = db
    .prepare(
      `INSERT INTO class_overrides
         (date, class_id, status, subject, code, start_time, end_time, room, faculty, kind, note)
       VALUES (?, NULL, 'added', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      date,
      p.subject || "(unnamed)",
      p.code ?? null,
      p.start_time ?? null,
      p.end_time ?? null,
      p.room ?? null,
      p.faculty ?? null,
      p.kind ?? "lecture",
      p.note ?? null,
    );
  return info.lastInsertRowid;
}
function clearClassOverride(date, classId) {
  if (classId) {
    db.prepare(
      `DELETE FROM class_overrides WHERE date = ? AND class_id = ?`,
    ).run(date, classId);
  } else {
    db.prepare(`DELETE FROM class_overrides WHERE date = ?`).run(date);
  }
}
function deleteClassOverrideById(id) {
  db.prepare(`DELETE FROM class_overrides WHERE id = ?`).run(id);
}

// ───────────────────────────────────────────────────────────────────────────
// course_materials — syllabi / notes / references per course. Plain text
// only; Ollama gets a budget-capped slice when include_in_ai = 1.
// ───────────────────────────────────────────────────────────────────────────
function listCourseMaterials({ code, includeBody = true } = {}) {
  const cols = includeBody
    ? "*"
    : "id, course_code, course_name, kind, title, source, include_in_ai, created_at, updated_at, length(body) AS body_len";
  if (code) {
    return db
      .prepare(
        `SELECT ${cols} FROM course_materials WHERE course_code = ? ORDER BY updated_at DESC`,
      )
      .all(code);
  }
  return db
    .prepare(
      `SELECT ${cols} FROM course_materials ORDER BY course_code ASC, updated_at DESC`,
    )
    .all();
}
function upsertCourseMaterial(p) {
  const now = new Date().toISOString();
  if (p.id) {
    db.prepare(
      `UPDATE course_materials
         SET course_code = ?, course_name = ?, kind = ?, title = ?,
             body = ?, source = ?, source_path = ?, include_in_ai = ?,
             updated_at = ?
       WHERE id = ?`,
    ).run(
      p.course_code ?? null,
      p.course_name ?? null,
      p.kind || "syllabus",
      p.title || null,
      p.body || "",
      p.source || "pasted",
      p.source_path || null,
      p.include_in_ai ? 1 : 0,
      now,
      p.id,
    );
    return p.id;
  }
  const info = db
    .prepare(
      `INSERT INTO course_materials
         (course_code, course_name, kind, title, body, source, source_path, include_in_ai)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      p.course_code ?? null,
      p.course_name ?? null,
      p.kind || "syllabus",
      p.title || null,
      p.body || "",
      p.source || "pasted",
      p.source_path || null,
      p.include_in_ai === false ? 0 : 1,
    );
  return info.lastInsertRowid;
}
function deleteCourseMaterial(id) {
  db.prepare(`DELETE FROM course_materials WHERE id = ?`).run(id);
  return true;
}
function setCourseMaterialAi(id, on) {
  db.prepare(
    `UPDATE course_materials SET include_in_ai = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(on ? 1 : 0, id);
  return true;
}
// Compact AI-context string built from include_in_ai materials. Caps total
// length so we don't blow the prompt budget — Ollama context windows are
// finite and these can get big.
function aiContextFromCourseMaterials({ maxChars = 6000 } = {}) {
  const rows = db
    .prepare(
      `SELECT course_code, course_name, kind, title, body
         FROM course_materials
        WHERE include_in_ai = 1 AND body != ''
        ORDER BY course_code ASC, updated_at DESC`,
    )
    .all();
  if (rows.length === 0) return null;
  const parts = [];
  let used = 0;
  for (const r of rows) {
    const head = `[${r.course_code || "—"}] ${r.kind}${r.title ? " · " + r.title : ""}`;
    // Allocate per-material budget evenly but at least 400 chars.
    const remaining = maxChars - used;
    if (remaining < 200) break;
    const slice = (r.body || "").trim().slice(0, Math.max(400, Math.floor(remaining / 2)));
    const block = head + "\n" + slice;
    parts.push(block);
    used += block.length + 2;
  }
  return parts.join("\n\n");
}

// ───────────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────────
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function safeJson(v, fallback) {
  if (v == null) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

module.exports = {
  init,
  dbPath,
  getSetting,
  setSetting,
  deleteSetting,
  allSettings,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  toggleTask,
  habitStreak,
  habitStreaksFor,
  tasksForToday,
  tasksUpcoming,
  tasksCompletedOn,
  seedCourseHabits,
  seedWeeklyGoals,
  getCheckinByDate,
  upsertCheckin,
  lastCheckins,
  streakStatus,
  completeTodayFocus,
  listWeeklyGoals,
  upsertWeeklyGoal,
  deleteWeeklyGoal,
  resetWeeklyGoals,
  incrementGoalProgress,
  listClasses,
  classesForDayOrder,
  upsertClass,
  deleteClass,
  replaceAllClasses,
  setDayOrderForDate,
  dayOrderForDate,
  listPeople,
  upsertPerson,
  deletePerson,
  deletePeople,
  deleteAllPeople,
  findDuplicateGroups,
  mergePeople,
  touchPersonScraped,
  listRepos,
  searchAllRepos,
  addBucketMinutes,
  listBuckets,
  clearAllActivity,
  clearAllSchedule,
  activeLeisure,
  startLeisure,
  extendLeisure,
  stopLeisure,
  recentLeisure,
  upsertRepo,
  importPeople,
  getCpStats,
  listCpStats,
  upsertCpStats,
  listAllCpStats,
  insertCpSubmissions,
  recentCpSubmissions,
  cpLeaderboard,
  addTimeEntry,
  listTimeEntriesOn,
  activityTotalsOn,
  activityTrend,
  addActivitySession,
  upsertActivitySession,
  topAppsOn,
  focusBlocksOn,
  activitySessionsRange,
  reclassifyAppCategory,
  getRepoSummary,
  saveRepoSummary,
  insertActivityFeed,
  listActivityFeed,
  pushHeatStrip,
  pushHeatStripsFor,
  listCourseMaterials,
  upsertCourseMaterial,
  deleteCourseMaterial,
  setCourseMaterialAi,
  aiContextFromCourseMaterials,
  saveBurnoutReport,
  latestBurnoutReport,
  recentBurnoutReports,
  // live timer + class overrides
  getActiveTimer,
  startTimer,
  extendTimer,
  clearTimer,
  categoryForTimerKind,
  activeZenSession,
  startZenSession,
  extendZenSession,
  stopZenSession,
  recordZenViolation,
  zenViolationsFor,
  zenSessionsOn,
  taskEventsOn,
  routineEventsOn,
  distractionLogOn,
  appCloseEventsOn,
  daySummaryOn,
  recentZenSessions,
  listClassOverrides,
  setClassOverride,
  addExtraClass,
  clearClassOverride,
  deleteClassOverrideById,
  getDayNote,
  upsertDayNote,
  listDayNoteDates,
  setDayNoteSummary,
  deleteDayNote,
  hasDayNotePasscode,
  setDayNotePasscode,
  verifyDayNotePasscode,
  resetDayNoteRecoveryCode,
  hasDayNoteRecoveryCode,
  verifyDayNoteRecoveryCode,
  clearDayNotePasscode,
  // legacy / compatibility — not persistent. Kept to avoid UI breakage.
  listInterests: () =>
    db
      .prepare(
        `SELECT * FROM tasks WHERE kind='interest' ORDER BY created_at DESC`,
      )
      .all()
      .map(rowToTask),
  upsertInterest: (i) => createTask({ ...i, kind: "interest" }),
  deleteInterest: (id) => deleteTask(id),
  _db: () => db,
};
