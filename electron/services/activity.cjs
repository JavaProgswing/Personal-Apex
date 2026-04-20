// Apex — activity service.
// - time_entries CRUD (manual time logging; foundation for the desktop tracker in v0.2)
// - Classmate activity feed (recent pushes across cached repos)

const db = require("./db.cjs");

function addEntry({ date, app_name, category, minutes, note }) {
  const dbh = db._db();
  const info = dbh
    .prepare(
      `INSERT INTO time_entries (date, app_name, category, minutes, note)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      date,
      app_name ?? null,
      category ?? "productive",
      minutes,
      note ?? null,
    );
  return dbh
    .prepare("SELECT * FROM time_entries WHERE id = ?")
    .get(info.lastInsertRowid);
}

function listEntries({ days = 7 } = {}) {
  return db
    ._db()
    .prepare(
      `SELECT * FROM time_entries WHERE date >= date('now', ?) ORDER BY date DESC, id DESC`,
    )
    .all(`-${days} days`);
}

function deleteEntry(id) {
  db._db().prepare("DELETE FROM time_entries WHERE id = ?").run(id);
  return true;
}

function todayTotals() {
  const rows = db
    ._db()
    .prepare(
      `SELECT category, COALESCE(SUM(minutes), 0) AS minutes FROM time_entries
              WHERE date = date('now','localtime') GROUP BY category`,
    )
    .all();
  const base = { productive: 0, distraction: 0, neutral: 0 };
  for (const r of rows) base[r.category] = r.minutes;
  base.total = base.productive + base.distraction + base.neutral;
  return base;
}

function weekTotals() {
  const rows = db
    ._db()
    .prepare(
      `SELECT date, category, COALESCE(SUM(minutes), 0) AS minutes
              FROM time_entries WHERE date >= date('now','-6 days','localtime')
              GROUP BY date, category ORDER BY date ASC`,
    )
    .all();
  return rows;
}

// Classmate activity: most recently pushed repos across all synced people.
function recentPushes({ days = 30, tag = null, limit = 40 } = {}) {
  const dbh = db._db();
  const clauses = [
    `r.pushed_at IS NOT NULL`,
    `r.pushed_at >= datetime('now', ?)`,
  ];
  const args = [`-${days} days`];
  if (tag) {
    clauses.push(`p.tags LIKE ?`);
    args.push(`%"${tag}"%`);
  }
  const sql = `
    SELECT r.*, p.name AS person_name, p.github_username, p.avatar_url, p.tags AS person_tags
    FROM repos r JOIN people p ON p.id = r.person_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY r.pushed_at DESC
    LIMIT ${+limit}
  `;
  return dbh
    .prepare(sql)
    .all(...args)
    .map((r) => ({
      ...r,
      languages: safeJson(r.languages, {}),
      topics: safeJson(r.topics, []),
      person_tags: safeJson(r.person_tags, []),
    }));
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
  addEntry,
  listEntries,
  deleteEntry,
  todayTotals,
  weekTotals,
  recentPushes,
};
