-- Apex schema. Applied on first boot by electron/services/db.cjs.
-- IMPORTANT: use IF NOT EXISTS on everything — this file runs on every launch.
-- Column-level migrations for pre-existing DBs live in db.cjs runMigrations().

-- ────────────────────────────────────────────────────────────────────────────
-- Tasks (task | interest | habit | class-template)
-- The single list replaces the old separate "interests" page. `kind` filters it.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  priority INTEGER DEFAULT 3,            -- 1 (urgent) .. 5 (someday)
  deadline TEXT,                         -- ISO datetime
  category TEXT,                         -- DSA / Academics / Project / Personal / …
  course_code TEXT,                      -- e.g. '21CSC204J' for schedule-linked tasks
  tags TEXT,                             -- JSON array
  estimated_minutes INTEGER,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  kind TEXT DEFAULT 'task',              -- task | interest | habit | class-template
  status TEXT,                           -- interest: idea/exploring/building/shipped/paused
  progress INTEGER DEFAULT 0,            -- 0-100
  links TEXT,                            -- JSON array of urls
  recurrence_rule TEXT,                  -- e.g. 'day:1' (day-order), 'weekly:mon', 'daily'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
-- idx_tasks_kind and idx_tasks_course are created in db.cjs runMigrations()
-- after the `kind` and `course_code` columns are added to pre-v2 databases.

-- ────────────────────────────────────────────────────────────────────────────
-- Check-ins, focus, weekly goals
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT UNIQUE NOT NULL,
  sleep INTEGER,
  clarity INTEGER,
  dread INTEGER,
  energy INTEGER,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_focus (
  date TEXT PRIMARY KEY,
  focus_type TEXT,
  completed INTEGER DEFAULT 0,
  note TEXT
);

-- weekly_focus (legacy, kept for migration). The UI uses weekly_goals.
CREATE TABLE IF NOT EXISTS weekly_focus (
  day_of_week INTEGER PRIMARY KEY,
  focus_type TEXT
);

CREATE TABLE IF NOT EXISTS weekly_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  target INTEGER DEFAULT 1,
  progress INTEGER DEFAULT 0,
  sort INTEGER DEFAULT 99,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────────────────────
-- College schedule: 5 day orders → N periods each.
-- Seeded on first boot from AcademiaScraper/data/timetable.json if the path
-- is set (Settings → Timetable → AcademiaScraper folder). Otherwise from the
-- compiled-in yashasviClasses() default.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_order INTEGER NOT NULL,            -- 1..5
  period INTEGER,                        -- 1..10 ordering within a day
  slot TEXT,                             -- 'A','B','F','G','P6',… (from SRM)
  subject TEXT NOT NULL,                 -- short name shown in UI
  code TEXT,                             -- course code (e.g. '21CSC204J')
  room TEXT,                             -- e.g. 'TP 205'
  faculty TEXT,                          -- full name with employee id
  start_time TEXT NOT NULL,              -- 'HH:MM' 24h
  end_time TEXT NOT NULL,
  kind TEXT DEFAULT 'lecture',           -- lecture | lab | tutorial
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_classes_day ON classes(day_order);

-- Pin an arbitrary ISO date to an SRM day-order when the normal rotation is
-- broken (holidays, make-up days). NULL means "use default rotation".
CREATE TABLE IF NOT EXISTS day_order_overrides (
  date TEXT PRIMARY KEY,                 -- YYYY-MM-DD
  day_order INTEGER                      -- 1..5 or NULL to skip
);

-- ────────────────────────────────────────────────────────────────────────────
-- People (classmates / friends). CP handles live here too.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  github_username TEXT UNIQUE,
  linkedin_url TEXT,
  leetcode_username TEXT,
  codeforces_username TEXT,
  codechef_username TEXT,
  source TEXT,                           -- 'manual' | 'ntl:satoshi' | 'friend' | 'gh-follow'
  tags TEXT,                             -- JSON array
  notes TEXT,
  avatar_url TEXT,
  bio TEXT,
  last_scraped_at TEXT,                  -- combined GitHub/CP refresh
  added_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_source ON people(source);

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER,
  github_id INTEGER UNIQUE,
  name TEXT,
  full_name TEXT UNIQUE,
  description TEXT,
  url TEXT,
  language TEXT,
  languages TEXT,
  topics TEXT,
  stars INTEGER,
  forks INTEGER,
  pushed_at TEXT,
  fetched_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repos_person ON repos(person_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Competitive-programming data per person per platform.
-- `stats` is a JSON blob: {solved, rating, maxRating, streak, rank, ...}
-- Recent submissions live in cp_submissions so we can render a tiny activity
-- sparkline per friend.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cp_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  platform TEXT NOT NULL,                -- leetcode | codeforces | codechef
  handle TEXT,
  stats TEXT,                            -- JSON
  error TEXT,                            -- last error message (rate-limit, 404, …)
  fetched_at TEXT,
  UNIQUE(person_id, platform),
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cp_person ON cp_stats(person_id);

CREATE TABLE IF NOT EXISTS cp_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  problem_id TEXT,
  title TEXT,
  verdict TEXT,
  rating INTEGER,
  submitted_at TEXT,                     -- ISO
  url TEXT,
  UNIQUE(person_id, platform, problem_id, submitted_at),
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_subs_person ON cp_submissions(person_id);
CREATE INDEX IF NOT EXISTS idx_subs_date ON cp_submissions(submitted_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Interests (legacy). Rows here migrate into tasks(kind='interest') on first
-- v2 boot. Kept around so the migration is idempotent. UI no longer reads it.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS interests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT,
  status TEXT DEFAULT 'idea',
  progress INTEGER DEFAULT 0,
  links TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT,
  app_name TEXT,
  category TEXT,                         -- productive / distraction / neutral / rest
  minutes INTEGER,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_time_date ON time_entries(date);

-- ────────────────────────────────────────────────────────────────────────────
-- Burnout check-in results (end-of-day Ollama analysis)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS burnout_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT UNIQUE NOT NULL,
  payload TEXT,                          -- JSON: {summary, redFlags[], suggestions[], risk_score}
  created_at TEXT DEFAULT (datetime('now'))
);

-- ────────────────────────────────────────────────────────────────────────────
-- Passive activity tracker — active-window poll (desktop) + ADB dumpsys (mobile).
-- `source` is 'desktop' or 'mobile'. `category` is productive / distraction /
-- neutral / rest / mobile. `app` is the window exe or mobile package name.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                    -- YYYY-MM-DD (local)
  source TEXT NOT NULL DEFAULT 'desktop',
  app TEXT,                              -- exe name (chrome.exe) or package (com.whatsapp)
  window_title TEXT,
  category TEXT,                         -- productive | distraction | neutral | rest | mobile
  started_at TEXT,                       -- ISO
  ended_at TEXT,                         -- ISO
  minutes INTEGER DEFAULT 0,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_act_sessions_date ON activity_sessions(date);
CREATE INDEX IF NOT EXISTS idx_act_sessions_app ON activity_sessions(app);

-- Cache of Ollama "what is this repo" summaries so we don't re-prompt.
CREATE TABLE IF NOT EXISTS repo_summaries (
  repo_id INTEGER PRIMARY KEY,
  payload TEXT,                          -- JSON from ollama.summarizeRepo
  model TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

-- Recent-commit stream per person. Populated by github.fetchRecentActivity
-- during a sync. Used on the People detail page + Dashboard activity feed.
CREATE TABLE IF NOT EXISTS activity_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'gh:push',  -- gh:push | gh:pr | gh:issue | cp:solve
  repo TEXT,
  message TEXT,
  url TEXT,
  at TEXT,                               -- ISO
  UNIQUE(person_id, url),
  FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_feed_person ON activity_feed(person_id);
CREATE INDEX IF NOT EXISTS idx_feed_at ON activity_feed(at);

-- Private per-day journal notes. `summary` is an optional AI-generated
-- distillation the user has opted in to feed back as context for Ask Apex /
-- burnout reports. `private` is a belt-and-braces flag — when true the row
-- is never sent to Ollama or any external call, even if the summary exists.
CREATE TABLE IF NOT EXISTS day_notes (
  date TEXT PRIMARY KEY,                 -- YYYY-MM-DD, local
  body TEXT NOT NULL DEFAULT '',         -- raw user text
  summary TEXT,                          -- optional AI summary (1–2 sentences)
  private INTEGER NOT NULL DEFAULT 1,    -- 1 = never share body with AI
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
