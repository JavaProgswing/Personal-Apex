import React, { useEffect, useMemo, useState } from "react";
import api from "../../lib/api.js";
import { daysUntil, niceDate } from "../../lib/date.js";
import BrainDumpModal from "../BrainDumpModal.jsx";

// Simplified + split categories. SWE is now "Deep work" (clearer intent),
// Health was added so workouts/sleep don't hide inside Personal, and Leisure
// is its own bucket so scheduled downtime (reading, gaming, TV, music) has a
// legit home rather than masquerading as Personal.
const CATEGORIES = [
  "Deep work",
  "DSA",
  "Academics",
  "Project",
  "Social",
  "Personal",
  "Health",
  "Leisure",
];
// `kind` is the top-level tab: task / habit / interest. Course work goes under
// `category=Academics` with `course_code`; interests used to live on their own
// page and are now filtered here.
const KINDS = [
  { key: "task",     label: "Tasks" },
  { key: "habit",    label: "Habits" },
  { key: "interest", label: "Interests" },
];

// Recurrence presets — the old freeform "day:1|day:3 or weekly:mon" text input
// was a footgun. 99% of what users want is one of these; the remaining 1%
// can still pick Custom and type the rule directly.
const RECURRENCE_PRESETS = [
  { value: "",                   label: "One-off (no recurrence)" },
  { value: "daily",              label: "Daily" },
  { value: "weekly:mon",         label: "Weekly · Mon" },
  { value: "weekly:tue",         label: "Weekly · Tue" },
  { value: "weekly:wed",         label: "Weekly · Wed" },
  { value: "weekly:thu",         label: "Weekly · Thu" },
  { value: "weekly:fri",         label: "Weekly · Fri" },
  { value: "weekly:sat",         label: "Weekly · Sat" },
  { value: "weekly:sun",         label: "Weekly · Sun" },
  { value: "day:1|day:3|day:5",  label: "Day-order 1 / 3 / 5" },
  { value: "day:2|day:4",        label: "Day-order 2 / 4" },
  { value: "__custom__",         label: "Custom…" },
];

const SORT_OPTIONS = [
  { value: "priority",  label: "Priority" },
  { value: "deadline",  label: "Deadline" },
  { value: "recent",    label: "Recently added" },
  { value: "category",  label: "Category" },
];

const GROUP_OPTIONS = [
  { value: "none",     label: "Flat" },
  { value: "category", label: "By category" },
  { value: "deadline", label: "By when" },
  { value: "priority", label: "By priority" },
];

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [kind, setKind] = useState("task");
  const [completed, setCompleted] = useState(false); // false / true / null(any)
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [sortBy, setSortBy] = useState("priority");
  const [groupBy, setGroupBy] = useState("none");
  const [editing, setEditing] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [showBrainDump, setShowBrainDump] = useState(false);
  const [importToast, setImportToast] = useState(null);
  const [quickTitle, setQuickTitle] = useState("");

  async function reload() {
    const filter = { kind };
    if (completed !== null) filter.completed = completed;
    if (category) filter.category = category;
    if (q.trim()) filter.q = q.trim();
    setTasks(await api.tasks.list(filter));
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [kind, completed, category, q]);

  // Cmd/Ctrl+Shift+B → open brain dump while on Tasks. (Cmd+Shift+N is
  // already wired globally to quick-capture in App.jsx.)
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setShowBrainDump(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function toggle(id) { await api.tasks.toggle(id); reload(); }
  async function remove(id) { await api.tasks.delete(id); reload(); }

  // Quick-add inline: title only, sensible defaults from current filters.
  async function quickAdd(e) {
    e?.preventDefault?.();
    const title = quickTitle.trim();
    if (!title) return;
    const defaultCat = category
      || (kind === "interest" ? "Project" : kind === "habit" ? "Health" : "Deep work");
    await api.tasks.create({
      title,
      kind,
      priority: 3,
      category: defaultCat,
      tags: [],
      links: [],
    });
    setQuickTitle("");
    reload();
  }

  // Snooze: bump deadline forward by N days. Without a deadline, set one to
  // tomorrow morning.
  async function snooze(t, days = 1) {
    const base = t.deadline ? new Date(t.deadline) : new Date();
    if (!t.deadline) base.setHours(9, 0, 0, 0);
    base.setDate(base.getDate() + days);
    await api.tasks.update(t.id, {
      ...t,
      deadline: base.toISOString(),
      tags: t.tags || [],
      links: t.links || [],
    });
    reload();
  }

  // Bump priority up/down (P1 = urgent, P5 = someday). Wraps inside [1, 5].
  async function bumpPriority(t, delta) {
    const next = Math.max(1, Math.min(5, (t.priority || 3) + delta));
    if (next === t.priority) return;
    await api.tasks.update(t.id, {
      ...t,
      priority: next,
      tags: t.tags || [],
      links: t.links || [],
    });
    reload();
  }

  // Stats: derive from the full open list ignoring search/category filters so
  // the strip remains a stable picture of "what's on my plate".
  const [allOpen, setAllOpen] = useState([]);
  useEffect(() => {
    api.tasks.list({ kind, completed: false }).then(setAllOpen).catch(() => setAllOpen([]));
  }, [kind, tasks.length]);

  const stats = useMemo(() => buildStats(allOpen), [allOpen]);

  // Sorted / grouped view of `tasks`
  const sorted = useMemo(() => sortTasks(tasks, sortBy), [tasks, sortBy]);
  const groups = useMemo(() => groupTasks(sorted, groupBy), [sorted, groupBy]);

  return (
    <>
      <div className="row between" style={{ marginBottom: 18 }}>
        <div>
          <h1 className="page-title">Tasks</h1>
          <p className="page-sub">
            One list for coursework, habits, and interests. P1 = urgent, P5 = someday.
          </p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button
            className="ghost"
            onClick={() => setShowBrainDump(true)}
            title="Paste a chat or text dump and Apex extracts tasks (Ctrl+Shift+B)"
          >
            📋 Brain dump
          </button>
          <button className="primary" onClick={() => setShowNew(true)}>+ New</button>
        </div>
      </div>

      {importToast && (
        <div className="card" style={{ marginBottom: 12, borderColor: "var(--accent)" }}>
          <strong>Imported {importToast.added} task{importToast.added === 1 ? "" : "s"}</strong>
          {importToast.summary && (
            <small className="muted" style={{ display: "block", marginTop: 4 }}>
              {importToast.summary}
            </small>
          )}
          <button
            className="ghost xsmall"
            style={{ marginTop: 6 }}
            onClick={() => setImportToast(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Stats strip — always shown, useful at a glance */}
      <div className="task-stats-strip">
        <StatBlock
          label="Open"
          value={stats.open}
          tone="neutral"
          title="Open tasks (any deadline)"
        />
        <StatBlock
          label="Overdue"
          value={stats.overdue}
          tone={stats.overdue ? "danger" : "neutral"}
          title="Past their deadline"
        />
        <StatBlock
          label="Due today"
          value={stats.dueToday}
          tone={stats.dueToday ? "warn" : "neutral"}
          title="Deadline is today"
        />
        <StatBlock
          label="This week"
          value={stats.dueWeek}
          tone="neutral"
          title="Deadline within the next 7 days"
        />
        <StatBlock
          label="No deadline"
          value={stats.untimed}
          tone="muted"
          title="Open tasks without a deadline"
        />
      </div>

      {/* Kind tabs */}
      <div className="row" style={{ marginBottom: 14, gap: 6, flexWrap: "wrap" }}>
        {KINDS.map((k) => (
          <button
            key={k.key}
            className={kind === k.key ? "primary" : "ghost"}
            onClick={() => setKind(k.key)}
          >{k.label}</button>
        ))}
      </div>

      {/* Quick-add */}
      <form onSubmit={quickAdd} className="task-quick-add">
        <input
          placeholder={`Quick-add ${kind} … (Enter to save)`}
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
        />
        <button type="submit" className="ghost small" disabled={!quickTitle.trim()}>+ Add</button>
      </form>

      {/* Filters + sort/group */}
      <div className="row task-filters" style={{ marginBottom: 14, gap: 8, flexWrap: "wrap" }}>
        <select
          value={completed === false ? "open" : completed === true ? "done" : "all"}
          onChange={(e) => {
            const v = e.target.value;
            setCompleted(v === "open" ? false : v === "done" ? true : null);
          }}
          style={{ width: 110 }}
        >
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="all">All</option>
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 150 }}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ width: 160 }}>
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>Sort · {o.label}</option>
          ))}
        </select>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ width: 150 }}>
          {GROUP_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>Group · {o.label}</option>
          ))}
        </select>
        <input placeholder="search title / description…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
      </div>

      {tasks.length === 0 ? (
        <div className="card">
          <div className="muted">
            No {kind + "s"} match.
            {q || category || completed === true ? (
              <> Try clearing filters above, or </>
            ) : (
              <> Get started — </>
            )}
            <a href="#" onClick={(e) => { e.preventDefault(); setShowNew(true); }}>
              create a new {kind}
            </a>.
          </div>
        </div>
      ) : groupBy === "none" ? (
        <div className="card">
          {sorted.map((t) => (
            <TaskRow
              key={t.id}
              t={t}
              onToggle={toggle}
              onEdit={setEditing}
              onDelete={remove}
              onSnooze={snooze}
              onBumpPriority={bumpPriority}
            />
          ))}
        </div>
      ) : (
        groups.map(([groupLabel, rows]) => (
          <div key={groupLabel} className="card" style={{ marginBottom: 12 }}>
            <div className="task-group-head">
              <span className="task-group-label">{groupLabel}</span>
              <small className="muted">{rows.length}</small>
            </div>
            {rows.map((t) => (
              <TaskRow
                key={t.id}
                t={t}
                onToggle={toggle}
                onEdit={setEditing}
                onDelete={remove}
                onSnooze={snooze}
                onBumpPriority={bumpPriority}
              />
            ))}
          </div>
        ))
      )}

      {showNew && (
        <TaskModal
          defaults={{ kind }}
          onClose={() => setShowNew(false)}
          onSaved={() => { setShowNew(false); reload(); }}
        />
      )}
      {editing && (
        <TaskModal
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
      <BrainDumpModal
        open={showBrainDump}
        onClose={() => setShowBrainDump(false)}
        onCreated={(info) => {
          setShowBrainDump(false);
          setImportToast(info);
          reload();
          // Auto-dismiss the toast after a bit so the page stays clean.
          setTimeout(() => setImportToast(null), 8000);
        }}
      />
    </>
  );
}

function StatBlock({ label, value, tone, title }) {
  return (
    <div className={`task-stat tone-${tone || "neutral"}`} title={title}>
      <div className="task-stat-value">{value}</div>
      <div className="task-stat-label">{label}</div>
    </div>
  );
}

function TaskRow({ t, onToggle, onEdit, onDelete, onSnooze, onBumpPriority }) {
  const isInterest = t.kind === "interest";
  const deadlineInfo = t.deadline
    ? (() => {
        const d = daysUntil(t.deadline);
        const cls = d != null && d < 0
          ? "rose"
          : d != null && d <= 1
            ? "rose"
            : d != null && d <= 3
              ? "amber"
              : "gray";
        const txt = d != null && d < 0
          ? `overdue ${Math.abs(d)}d`
          : niceDate(t.deadline);
        return { cls, txt };
      })()
    : null;
  const priorityCls =
    t.priority <= 2 ? "rose" : t.priority === 3 ? "amber" : "gray";

  return (
    <div className={"task-row" + (t.completed ? " done" : "")}>
      <div className="task-row-check">
        {!isInterest ? (
          <input
            type="checkbox"
            checked={!!t.completed}
            onChange={() => onToggle(t.id)}
            aria-label={`Toggle ${t.title}`}
          />
        ) : (
          <span className="task-interest-dot" title="Interest" />
        )}
      </div>

      <div className="task-row-body">
        <div className="task-row-title">{t.title}</div>
        {(t.category ||
          t.course_code ||
          deadlineInfo ||
          t.estimated_minutes ||
          (isInterest && t.status) ||
          (isInterest && typeof t.progress === "number" && t.progress > 0) ||
          t.recurrence_rule) && (
          <div className="task-row-meta">
            {isInterest && (
              <span className="pill">{t.status || "idea"}</span>
            )}
            {t.course_code && <span className="pill">{t.course_code}</span>}
            {t.category && <span className="pill gray">{t.category}</span>}
            {deadlineInfo && (
              <span className={"pill " + deadlineInfo.cls}>
                {deadlineInfo.txt}
              </span>
            )}
            {t.estimated_minutes ? (
              <span className="task-meta-text">
                ~{t.estimated_minutes} min
              </span>
            ) : null}
            {isInterest &&
              typeof t.progress === "number" &&
              t.progress > 0 && (
                <span className="task-meta-text">{t.progress}%</span>
              )}
            {t.recurrence_rule && (
              <span className="task-meta-text">
                ↻ {labelForRecurrence(t.recurrence_rule)}
              </span>
            )}
          </div>
        )}
        {t.description && (
          <div className="task-row-desc">{t.description}</div>
        )}
      </div>

      <div className="task-row-actions">
        <div className={"task-priority-pill cat-" + priorityCls}>
          <button
            type="button"
            className="task-priority-arrow"
            title="More urgent"
            onClick={() => onBumpPriority(t, -1)}
            disabled={t.priority <= 1}
            aria-label="More urgent"
          >
            ▲
          </button>
          <span
            className={"task-priority-num pill " + priorityCls}
            title={`Priority P${t.priority}`}
          >
            P{t.priority}
          </span>
          <button
            type="button"
            className="task-priority-arrow"
            title="Less urgent"
            onClick={() => onBumpPriority(t, +1)}
            disabled={t.priority >= 5}
            aria-label="Less urgent"
          >
            ▼
          </button>
        </div>
        <div className="task-row-buttons">
          {!isInterest && !t.completed && (
            <button
              className="ghost small task-row-start"
              onClick={async () => {
                await api.timer.start({
                  kind: t.kind === "habit" ? "habit" : "task",
                  category: "productive",
                  title: t.title,
                  description: t.description || null,
                  task_id: t.id,
                  planned_minutes: t.estimated_minutes || 25,
                });
              }}
              title="Start a live timer for this task"
            >
              ▶ Start
            </button>
          )}
          {!isInterest && !t.completed && (
            <button
              className="ghost small"
              onClick={() => onSnooze(t, 1)}
              title="Snooze deadline by 1 day"
            >
              Snooze
            </button>
          )}
          <button
            className="ghost small"
            onClick={() => onEdit(t)}
            title="Edit"
          >
            Edit
          </button>
          <button
            className="ghost small task-row-delete"
            onClick={() => onDelete(t.id)}
            title="Delete"
            aria-label="Delete"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────

function buildStats(rows) {
  let open = 0, overdue = 0, dueToday = 0, dueWeek = 0, untimed = 0;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);
  const weekEnd = new Date(todayStart); weekEnd.setDate(weekEnd.getDate() + 7);
  for (const t of rows || []) {
    if (t.completed) continue;
    open++;
    if (!t.deadline) { untimed++; continue; }
    const d = new Date(t.deadline);
    if (Number.isNaN(+d)) { untimed++; continue; }
    if (d < todayStart) overdue++;
    else if (d < todayEnd) dueToday++;
    else if (d < weekEnd) dueWeek++;
  }
  return { open, overdue, dueToday, dueWeek, untimed };
}

function sortTasks(rows, sortBy) {
  const arr = [...(rows || [])];
  if (sortBy === "priority") {
    // Lower priority number = higher importance. Tiebreak by deadline.
    return arr.sort((a, b) => {
      const pa = a.priority ?? 3, pb = b.priority ?? 3;
      if (pa !== pb) return pa - pb;
      return deadlineKey(a) - deadlineKey(b);
    });
  }
  if (sortBy === "deadline") {
    return arr.sort((a, b) => deadlineKey(a) - deadlineKey(b));
  }
  if (sortBy === "category") {
    return arr.sort((a, b) => (a.category || "").localeCompare(b.category || "")
      || deadlineKey(a) - deadlineKey(b));
  }
  // recent — most-recently-added first; fall back to id order
  return arr.sort((a, b) => (b.id || 0) - (a.id || 0));
}

function deadlineKey(t) {
  if (!t.deadline) return Number.POSITIVE_INFINITY;
  const v = +new Date(t.deadline);
  return Number.isNaN(v) ? Number.POSITIVE_INFINITY : v;
}

function groupTasks(rows, groupBy) {
  if (groupBy === "none") return null;
  const map = new Map();
  for (const t of rows) {
    let key;
    if (groupBy === "category") {
      key = t.category || "Uncategorized";
    } else if (groupBy === "priority") {
      key = `P${t.priority || 3}`;
    } else if (groupBy === "deadline") {
      key = deadlineBucket(t);
    } else {
      key = "All";
    }
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  // Preserve a sensible order per group type.
  if (groupBy === "deadline") {
    const order = ["Overdue", "Today", "Tomorrow", "This week", "Later", "No deadline"];
    return order.filter((k) => map.has(k)).map((k) => [k, map.get(k)]);
  }
  if (groupBy === "priority") {
    return ["P1", "P2", "P3", "P4", "P5"].filter((k) => map.has(k)).map((k) => [k, map.get(k)]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function deadlineBucket(t) {
  if (!t.deadline) return "No deadline";
  const d = new Date(t.deadline);
  if (Number.isNaN(+d)) return "No deadline";
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const dayAfter = new Date(tomorrowStart); dayAfter.setDate(dayAfter.getDate() + 1);
  const weekEnd = new Date(todayStart); weekEnd.setDate(weekEnd.getDate() + 7);
  if (d < todayStart) return "Overdue";
  if (d < tomorrowStart) return "Today";
  if (d < dayAfter) return "Tomorrow";
  if (d < weekEnd) return "This week";
  return "Later";
}

function labelForRecurrence(rule) {
  const hit = RECURRENCE_PRESETS.find((p) => p.value === rule);
  return hit ? hit.label : rule;
}

function TaskModal({ task, defaults, onClose, onSaved }) {
  const initKind = task?.kind || defaults?.kind || "task";
  const initRule = task?.recurrence_rule || "";
  const initRuleIsPreset = RECURRENCE_PRESETS.some(
    (p) => p.value === initRule && p.value !== "__custom__",
  );
  const [form, setForm] = useState({
    title: task?.title || "",
    description: task?.description || "",
    priority: task?.priority || 3,
    deadline: task?.deadline ? task.deadline.slice(0, 16) : "",
    category: task?.category || (initKind === "interest" ? "Project" : "Deep work"),
    course_code: task?.course_code || "",
    estimated_minutes: task?.estimated_minutes || "",
    kind: initKind,
    status: task?.status || "idea",
    progress: task?.progress ?? 0,
    recurrence_rule: initRule,
    recurrence_choice: initRule === ""
      ? ""
      : initRuleIsPreset
        ? initRule
        : "__custom__",
  });

  async function save() {
    const payload = {
      ...form,
      priority: +form.priority,
      progress: +form.progress,
      estimated_minutes: form.estimated_minutes === "" ? null : +form.estimated_minutes,
      deadline: form.deadline === "" ? null : new Date(form.deadline).toISOString(),
      // Keep tags/links arrays intact on existing rows — we stopped exposing
      // them in the form but we don't want saving to wipe what's there.
      tags: task?.tags || [],
      links: task?.links || [],
      course_code: form.category === "Academics" ? (form.course_code || null) : null,
      recurrence_rule: form.recurrence_rule || null,
    };
    // Strip helper-only fields we added for the dropdown.
    delete payload.recurrence_choice;
    if (task?.id) await api.tasks.update(task.id, payload);
    else await api.tasks.create(payload);
    onSaved();
  }

  const isInterest = form.kind === "interest";
  const isHabit = form.kind === "habit";
  const isAcademics = form.category === "Academics";

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{task ? "Edit" : "New"} {isInterest ? "interest" : isHabit ? "habit" : "task"}</h3>

        <div className="form-row">
          <label>Kind</label>
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="task">Task</option>
            <option value="habit">Habit (recurring)</option>
            <option value="interest">Interest / side project</option>
          </select>
        </div>
        <div className="form-row">
          <label>Title</label>
          <input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div className="form-row">
          <label>Description</label>
          <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="grid-2">
          <div className="form-row">
            <label>Category</label>
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="form-row">
            <label>Priority</label>
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: +e.target.value })}>
              <option value={1}>P1 · Urgent</option>
              <option value={2}>P2 · High</option>
              <option value={3}>P3 · Medium</option>
              <option value={4}>P4 · Low</option>
              <option value={5}>P5 · Someday</option>
            </select>
          </div>
        </div>
        {!isInterest && (
          <div className="grid-2">
            <div className="form-row">
              <label>Deadline</label>
              <input type="datetime-local" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
            </div>
            <div className="form-row">
              <label>Estimated minutes</label>
              <input type="number" min={5} step={5} value={form.estimated_minutes} onChange={(e) => setForm({ ...form, estimated_minutes: e.target.value })} />
            </div>
          </div>
        )}
        <div className="grid-2">
          {isAcademics ? (
            <div className="form-row">
              <label>Course code</label>
              <input
                value={form.course_code}
                onChange={(e) => setForm({ ...form, course_code: e.target.value })}
                placeholder="e.g. 21CSC204J"
              />
            </div>
          ) : <div />}
          <div className="form-row">
            <label>Recurrence</label>
            <select
              value={form.recurrence_choice}
              onChange={(e) => {
                const v = e.target.value;
                setForm({
                  ...form,
                  recurrence_choice: v,
                  recurrence_rule: v === "__custom__" ? form.recurrence_rule : v,
                });
              }}
            >
              {RECURRENCE_PRESETS.map((p) => (
                <option key={p.value || "none"} value={p.value}>{p.label}</option>
              ))}
            </select>
            {form.recurrence_choice === "__custom__" && (
              <input
                style={{ marginTop: 6 }}
                placeholder="day:1|day:3  or  weekly:mon  or  daily"
                value={form.recurrence_rule}
                onChange={(e) => setForm({ ...form, recurrence_rule: e.target.value })}
              />
            )}
          </div>
        </div>
        {isInterest && (
          <div className="grid-2">
            <div className="form-row">
              <label>Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="idea">idea</option>
                <option value="exploring">exploring</option>
                <option value="building">building</option>
                <option value="shipped">shipped</option>
                <option value="paused">paused</option>
              </select>
            </div>
            <div className="form-row">
              <label>Progress (%)</label>
              <input type="number" min={0} max={100} step={5} value={form.progress} onChange={(e) => setForm({ ...form, progress: e.target.value })} />
            </div>
          </div>
        )}
        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={!form.title.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}
