import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";

// Upcoming = next N days of {classes, task deadlines} in chronological order.
// Replaces the old Timetable page with something actionable.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Upcoming({ go }) {
  const [days, setDays] = useState([]);
  const [manualTasks, setManualTasks] = useState([]);
  const [quickTitle, setQuickTitle] = useState("");
  const [quickDue, setQuickDue] = useState("");
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    const [sched, open] = await Promise.all([
      api.schedule.upcoming(7),
      api.tasks.list({ completed: false, kind: "task" }),
    ]);
    setDays(sched || []);
    setManualTasks(open || []);
    setLoading(false);
  }
  useEffect(() => { reload(); }, []);

  async function addQuickTask() {
    if (!quickTitle.trim()) return;
    await api.tasks.create({
      title: quickTitle.trim(),
      category: "Academics",
      deadline: quickDue ? new Date(quickDue).toISOString() : null,
      kind: "task",
      priority: 3,
    });
    setQuickTitle("");
    setQuickDue("");
    reload();
  }

  async function toggleTask(id) { await api.tasks.toggle(id); reload(); }

  const tasksByDate = groupTasksByDate(manualTasks);

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div>
          <h1 className="page-title">Upcoming</h1>
          <p className="page-sub">Your next 7 days — classes and deadlines in one place.</p>
        </div>
        <div className="row">
          <button className="ghost" onClick={reload}>Refresh</button>
          <button className="ghost" onClick={() => go("settings")}>Edit schedule</button>
        </div>
      </div>

      {/* Quick add: a new college task with optional deadline */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row" style={{ gap: 8 }}>
          <input
            placeholder="Add college work… (e.g. DBMS assignment 2)"
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addQuickTask()}
            style={{ flex: 1 }}
          />
          <input
            type="datetime-local"
            value={quickDue}
            onChange={(e) => setQuickDue(e.target.value)}
            style={{ width: 210 }}
          />
          <button className="primary" onClick={addQuickTask} disabled={!quickTitle.trim()}>
            + Add
          </button>
        </div>
        <small className="hint">Defaults to category <em>Academics</em>, priority P3. Edit in Tasks.</small>
      </div>

      {loading && <div className="muted">Loading…</div>}

      {!loading && days.map((d) => {
        const extras = tasksByDate[d.date] || [];
        const isWeekend = !d.dayOrder;
        const isEmpty = d.classes.length === 0 && extras.length === 0 && (d.deadlines || []).length === 0;
        const dateLabel = new Date(d.date).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
        return (
          <div key={d.date} className="card" style={{ marginBottom: 12 }}>
            <div className="row between">
              <div>
                <strong>{dateLabel}</strong>
                <small className="muted" style={{ marginLeft: 8 }}>
                  {isWeekend ? "weekend" : `Day order ${d.dayOrder}`}
                </small>
              </div>
            </div>

            {d.classes.length === 0 && isWeekend && <div className="muted" style={{ marginTop: 8 }}>No classes.</div>}

            {d.classes.map((c) => (
              <div key={"c" + c.id} className="row" style={{ marginTop: 8, gap: 10, alignItems: "center" }}>
                <span className="pill mono">{c.start_time}–{c.end_time}</span>
                <div style={{ flex: 1 }}>
                  <div className="title">{c.subject}</div>
                  <div className="sub muted">
                    {c.code} {c.room ? `· ${c.room}` : ""} {c.faculty ? `· ${c.faculty}` : ""}
                  </div>
                </div>
                {c.kind === "lab" && <span className="pill rose">lab</span>}
              </div>
            ))}

            {(d.deadlines || []).length > 0 && (
              <>
                <hr className="soft" />
                <small className="muted">due this day</small>
                {d.deadlines.map((t) => (
                  <DeadlineRow key={"d" + t.id} t={t} onToggle={toggleTask} />
                ))}
              </>
            )}

            {extras.length > 0 && (d.deadlines || []).length === 0 && (
              <>
                <hr className="soft" />
                <small className="muted">due this day</small>
                {extras.map((t) => (
                  <DeadlineRow key={"e" + t.id} t={t} onToggle={toggleTask} />
                ))}
              </>
            )}

            {isEmpty && <div className="muted" style={{ marginTop: 6 }}>Nothing scheduled.</div>}
          </div>
        );
      })}
    </>
  );
}

function DeadlineRow({ t, onToggle }) {
  return (
    <div className="row" style={{ marginTop: 6, alignItems: "center" }}>
      <input type="checkbox" checked={!!t.completed} onChange={() => onToggle(t.id)} />
      <div style={{ flex: 1 }}>
        <div className="title">{t.title}</div>
        <div className="sub">
          {t.category && <span className="pill">{t.category}</span>}
          {t.course_code && <span className="pill">{t.course_code}</span>}
          {t.estimated_minutes ? <span className="muted" style={{ marginLeft: 6 }}>~{t.estimated_minutes} min</span> : null}
        </div>
      </div>
      <span className={"pill " + (t.priority <= 2 ? "rose" : t.priority === 3 ? "amber" : "gray")}>P{t.priority}</span>
    </div>
  );
}

function groupTasksByDate(tasks) {
  const out = {};
  for (const t of tasks) {
    if (!t.deadline) continue;
    const iso = new Date(t.deadline).toISOString().slice(0, 10);
    (out[iso] ||= []).push(t);
  }
  return out;
}
