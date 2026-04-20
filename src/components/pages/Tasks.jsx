import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import { daysUntil, niceDate } from "../../lib/date.js";

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
  { key: "all",      label: "All" },
];

export default function Tasks() {
  const [tasks, setTasks] = useState([]);
  const [kind, setKind] = useState("task");
  const [completed, setCompleted] = useState(false); // false / true / null(any)
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null);
  const [showNew, setShowNew] = useState(false);

  async function reload() {
    const filter = { kind };
    if (completed !== null) filter.completed = completed;
    if (category) filter.category = category;
    if (q.trim()) filter.q = q.trim();
    setTasks(await api.tasks.list(filter));
  }
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [kind, completed, category, q]);

  async function toggle(id) { await api.tasks.toggle(id); reload(); }
  async function remove(id) { await api.tasks.delete(id); reload(); }

  return (
    <>
      <div className="row between" style={{ marginBottom: 18 }}>
        <div>
          <h1 className="page-title">Tasks</h1>
          <p className="page-sub">
            One list for coursework, habits, and interests. P1 = urgent, P5 = someday.
          </p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => setShowNew(true)}>+ New</button>
        </div>
      </div>

      {/* Kind tabs */}
      <div className="row" style={{ marginBottom: 14, gap: 6 }}>
        {KINDS.map((k) => (
          <button
            key={k.key}
            className={kind === k.key ? "primary" : "ghost"}
            onClick={() => setKind(k.key)}
          >{k.label}</button>
        ))}
      </div>

      {/* Filters */}
      <div className="row" style={{ marginBottom: 14, gap: 8 }}>
        <select
          value={completed === false ? "open" : completed === true ? "done" : "all"}
          onChange={(e) => {
            const v = e.target.value;
            setCompleted(v === "open" ? false : v === "done" ? true : null);
          }}
          style={{ width: 120 }}
        >
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="all">All</option>
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 160 }}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input placeholder="search title / description…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
      </div>

      <div className="card">
        {tasks.length === 0 && <div className="muted">No {kind === "all" ? "items" : kind + "s"} match.</div>}
        {tasks.map((t) => (
          <TaskRow key={t.id} t={t} onToggle={toggle} onEdit={setEditing} onDelete={remove} />
        ))}
      </div>

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
    </>
  );
}

function TaskRow({ t, onToggle, onEdit, onDelete }) {
  const isInterest = t.kind === "interest";
  const isHabit = t.kind === "habit";
  return (
    <div className={"todo-row" + (t.completed ? " done" : "")}>
      {!isInterest && (
        <input type="checkbox" checked={!!t.completed} onChange={() => onToggle(t.id)} />
      )}
      <div style={{ flex: 1 }}>
        <div className="title">{t.title}</div>
        <div className="sub">
          {isHabit && <span className="pill">habit</span>}
          {isInterest && <span className="pill">{t.status || "idea"}</span>}
          {t.course_code && <span className="pill">{t.course_code}</span>}
          {t.category && <span className="pill">{t.category}</span>}
          {t.recurrence_rule && <span className="pill gray">{t.recurrence_rule}</span>}
          {t.deadline && (() => {
            const d = daysUntil(t.deadline);
            const cls = d != null && d <= 1 ? "rose" : d != null && d <= 3 ? "amber" : "gray";
            return <span className={"pill " + cls} style={{ marginLeft: 6 }}>{d != null && d < 0 ? "overdue" : niceDate(t.deadline)}</span>;
          })()}
          {t.estimated_minutes ? <span style={{ marginLeft: 6 }}>~{t.estimated_minutes} min</span> : null}
          {isInterest && typeof t.progress === "number" && <span style={{ marginLeft: 6 }}>· {t.progress}%</span>}
        </div>
        {t.description && <div className="sub" style={{ marginTop: 4 }}>{t.description}</div>}
        {Array.isArray(t.links) && t.links.length > 0 && (
          <div className="sub" style={{ marginTop: 4 }}>
            {t.links.map((l, i) => (
              <a key={i} href="#" onClick={(e) => { e.preventDefault(); api.ext.open(l); }} style={{ marginRight: 8 }}>
                {shortLink(l)}
              </a>
            ))}
          </div>
        )}
      </div>
      <div className="right">
        <span className={"pill " + (t.priority <= 2 ? "rose" : t.priority === 3 ? "amber" : "gray")}>P{t.priority}</span>
        <button className="ghost" onClick={() => onEdit(t)}>Edit</button>
        <button className="ghost" onClick={() => onDelete(t.id)} title="Delete">✕</button>
      </div>
    </div>
  );
}

function TaskModal({ task, defaults, onClose, onSaved }) {
  const initKind = task?.kind || defaults?.kind || "task";
  const [form, setForm] = useState({
    title: task?.title || "",
    description: task?.description || "",
    priority: task?.priority || 3,
    deadline: task?.deadline ? task.deadline.slice(0, 16) : "",
    category: task?.category || (initKind === "interest" ? "Project" : "Deep work"),
    course_code: task?.course_code || "",
    estimated_minutes: task?.estimated_minutes || "",
    tags: (task?.tags || []).join(", "),
    kind: initKind,
    status: task?.status || "idea",
    progress: task?.progress ?? 0,
    links: (task?.links || []).join(", "),
    recurrence_rule: task?.recurrence_rule || "",
  });

  async function save() {
    const payload = {
      ...form,
      priority: +form.priority,
      progress: +form.progress,
      estimated_minutes: form.estimated_minutes === "" ? null : +form.estimated_minutes,
      deadline: form.deadline === "" ? null : new Date(form.deadline).toISOString(),
      tags: form.tags.split(",").map((s) => s.trim()).filter(Boolean),
      links: form.links.split(",").map((s) => s.trim()).filter(Boolean),
      course_code: form.course_code || null,
      recurrence_rule: form.recurrence_rule || null,
    };
    if (task?.id) await api.tasks.update(task.id, payload);
    else await api.tasks.create(payload);
    onSaved();
  }

  const isInterest = form.kind === "interest";
  const isHabit = form.kind === "habit";

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
          <div className="form-row">
            <label>Course code (optional)</label>
            <input value={form.course_code} onChange={(e) => setForm({ ...form, course_code: e.target.value })} placeholder="e.g. 21CSC204J" />
          </div>
          <div className="form-row">
            <label>Recurrence (optional)</label>
            <input value={form.recurrence_rule} onChange={(e) => setForm({ ...form, recurrence_rule: e.target.value })} placeholder="day:1|day:3  or  weekly:mon  or  daily" />
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
        <div className="form-row">
          <label>Tags (comma-separated)</label>
          <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="e.g. neetcode, binary-search" />
        </div>
        <div className="form-row">
          <label>Links (comma-separated URLs)</label>
          <input value={form.links} onChange={(e) => setForm({ ...form, links: e.target.value })} placeholder="https://…, https://…" />
        </div>

        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={!form.title.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}

function shortLink(u) {
  try { const p = new URL(u); return p.hostname.replace(/^www\./, "") + (p.pathname === "/" ? "" : p.pathname.slice(0, 16)); }
  catch { return u.slice(0, 24); }
}
