// Apex — SQLite data service. All persistence lives here.
// Uses better-sqlite3 (synchronous, fast, perfect for Electron main).

const path = require("node:path");
const fs = require("node:fs");
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
    console.log("[db] migrated legacy DB from", legacy, "→", target);
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

  // Seed classes table from AcademiaScraper JSON (or fallback) on first run.
  try {
    const cRow = db.prepare("SELECT COUNT(*) AS c FROM classes").get();
    if (cRow.c === 0) {
      require("./timetable.cjs").seedDefaultClasses();
      console.log("[db] seeded default classes");
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
        console.log("[db] migrated", oldRows.length, "interests → tasks");
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
  return listOne(info.lastInsertRowid);
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
  return listOne(id);
}
function deleteTask(id) {
  db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return true;
}
function toggleTask(id) {
  const cur = db.prepare("SELECT completed FROM tasks WHERE id = ?").get(id);
  if (!cur) return null;
  const now = cur.completed ? null : new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET completed = ?, completed_at = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(cur.completed ? 0 : 1, now, id);
  return listOne(id);
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
    return db.prepare("SELECT * FROM weekly_goals WHERE id=?").get(g.id);
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
  return db
    .prepare("SELECT * FROM weekly_goals WHERE id=?")
    .get(info.lastInsertRowid);
}
function deleteWeeklyGoal(id) {
  db.prepare("DELETE FROM weekly_goals WHERE id = ?").run(id);
  return true;
}
function resetWeeklyGoals() {
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
  return db.prepare("SELECT * FROM weekly_goals WHERE id = ?").get(id);
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
function importPeople(members) {
  const tx = db.transaction((list) => list.map((m) => upsertPerson(m)));
  return tx(members);
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
function cpLeaderboard(platform) {
  const rows = db
    .prepare(
      `SELECT cp.*, p.name AS person_name, p.avatar_url
     FROM cp_stats cp JOIN people p ON p.id = cp.person_id
     WHERE cp.platform = ?`,
    )
    .all(platform);
  const parsed = rows.map((r) => ({
    person_id: r.person_id,
    person_name: r.person_name,
    avatar_url: r.avatar_url,
    platform: r.platform,
    handle: r.handle,
    error: r.error,
    fetched_at: r.fetched_at,
    stats: safeJson(r.stats, {}),
  }));
  const key = platform === "leetcode" ? "totalSolved" : "rating";
  parsed.sort((a, b) => (b.stats[key] ?? 0) - (a.stats[key] ?? 0));
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
     GROUP BY app ORDER BY minutes DESC LIMIT ?`,
    )
    .all(date, limit);
}
function activitySessionsRange(startIso, endIso) {
  return db
    .prepare(
      `SELECT * FROM activity_sessions WHERE date BETWEEN ? AND ? ORDER BY started_at DESC`,
    )
    .all(startIso, endIso);
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
function listActivityFeed({ days = 7, personId, limit = 100 } = {}) {
  const where = ['at >= date("now", ?)'];
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
  allSettings,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  toggleTask,
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
  touchPersonScraped,
  listRepos,
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
  activitySessionsRange,
  getRepoSummary,
  saveRepoSummary,
  insertActivityFeed,
  listActivityFeed,
  saveBurnoutReport,
  latestBurnoutReport,
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
