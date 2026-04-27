import React, { useEffect, useMemo, useState } from "react";
import api from "../../lib/api.js";

// Upcoming = next N days of {classes, task deadlines} in chronological order.
// The central "college schedule" view.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Colour-code subject pills by their first letter so PQT / AI / DAA / DBMS
// are visually distinct without being noisy.
const SUBJECT_HUES = ["rose", "amber", "teal", "blue", "violet", "gray"];
function subjectHue(subject = "") {
  const c = subject.trim().toUpperCase().charCodeAt(0) || 0;
  return SUBJECT_HUES[c % SUBJECT_HUES.length];
}

// "08:00" → 480 (minutes since midnight). Returns -1 if unparsable.
function toMin(hhmm) {
  if (!hhmm) return -1;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm));
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

export default function Upcoming({ go }) {
  const [days, setDays] = useState([]);
  const [manualTasks, setManualTasks] = useState([]);
  const [quickTitle, setQuickTitle] = useState("");
  const [quickDue, setQuickDue] = useState("");
  const [loading, setLoading] = useState(true);
  // tick once a minute so "now"/"next" indicators stay accurate
  const [, setTick] = useState(0);

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
  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60 * 1000);
    return () => clearInterval(id);
  }, []);

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

  async function toggleTask(id) {
    await api.tasks.toggle(id);
    reload();
  }

  const tasksByDate = groupTasksByDate(manualTasks);
  const iso0 = todayIso();

  // Summary strip: how many days have classes / deadlines this week
  const summary = useMemo(() => {
    let cls = 0,
      dl = 0,
      free = 0;
    for (const d of days) {
      cls += d.classes?.length || 0;
      dl += (d.deadlines || []).length;
      if (
        (d.classes?.length || 0) === 0 &&
        (d.deadlines || []).length === 0 &&
        (tasksByDate[d.date]?.length || 0) === 0
      )
        free += 1;
    }
    return { cls, dl, free };
  }, [days, tasksByDate]);

  return (
    <>
      <div className="row between" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          <h1 className="page-title">Upcoming</h1>
          <p className="page-sub">
            Your next 7 days — classes and deadlines in one place.
          </p>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <button className="ghost" onClick={reload}>
            Refresh
          </button>
          <button className="ghost" onClick={() => go("settings")}>
            Edit schedule
          </button>
        </div>
      </div>

      {/* Week summary strip */}
      {!loading && days.length > 0 && (
        <div
          className="row"
          style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}
        >
          <span className="pill teal">{summary.cls} classes</span>
          <span className={"pill " + (summary.dl ? "rose" : "gray")}>
            {summary.dl} deadlines
          </span>
          <span className="pill gray">
            {summary.free} free {summary.free === 1 ? "day" : "days"}
          </span>
        </div>
      )}

      {/* Quick add: a new college task with optional deadline */}
      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="Add college work… (e.g. DBMS assignment 2)"
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addQuickTask()}
            style={{ flex: "1 1 240px" }}
          />
          <input
            type="datetime-local"
            value={quickDue}
            onChange={(e) => setQuickDue(e.target.value)}
            style={{ width: 210 }}
          />
          <button
            className="primary"
            onClick={addQuickTask}
            disabled={!quickTitle.trim()}
          >
            + Add
          </button>
        </div>
        <small className="hint">
          Defaults to category <em>Academics</em>, priority P3. Edit in Tasks.
        </small>
      </div>

      {loading && <div className="muted">Loading…</div>}

      {!loading &&
        days.map((d) => {
          const extras = tasksByDate[d.date] || [];
          const deadlines = d.deadlines || [];
          const allDueToday = dedupeById([...deadlines, ...extras]);
          const isToday = d.date === iso0;
          const isWeekend = !d.dayOrder;
          const isEmpty =
            d.classes.length === 0 && allDueToday.length === 0;
          const dateObj = new Date(d.date + "T00:00:00");
          const dateLabel = dateObj.toLocaleDateString(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
          });
          const offsetDays = Math.round(
            (dateObj - new Date(iso0 + "T00:00:00")) / 86400000,
          );
          const relLabel =
            offsetDays === 0
              ? "Today"
              : offsetDays === 1
                ? "Tomorrow"
                : offsetDays < 7
                  ? DOW[dateObj.getDay()]
                  : null;

          // For today only — figure out the current + next class
          let currentClassId = null;
          let nextClassId = null;
          if (isToday && d.classes.length) {
            const now = nowMin();
            for (const c of d.classes) {
              const s = toMin(c.start_time);
              const e = toMin(c.end_time);
              if (s <= now && now < e) currentClassId = c.id;
            }
            if (!currentClassId) {
              for (const c of d.classes) {
                if (toMin(c.start_time) > nowMin()) {
                  nextClassId = c.id;
                  break;
                }
              }
            }
          }

          return (
            <div
              key={d.date}
              className={
                "card upcoming-day" +
                (isToday ? " is-today" : "") +
                (isWeekend ? " is-weekend" : "")
              }
              style={{
                marginBottom: 12,
                borderLeft: isToday
                  ? "3px solid var(--accent)"
                  : undefined,
              }}
            >
              <div
                className="row between"
                style={{ alignItems: "center", flexWrap: "wrap", gap: 8 }}
              >
                <div>
                  <strong style={{ fontSize: 15 }}>{dateLabel}</strong>
                  {relLabel && (
                    <span
                      className={"pill " + (isToday ? "teal" : "gray")}
                      style={{ marginLeft: 8 }}
                    >
                      {relLabel}
                    </span>
                  )}
                  <small className="muted" style={{ marginLeft: 8 }}>
                    {isWeekend ? "weekend" : `Day order ${d.dayOrder}`}
                  </small>
                </div>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {d.classes.length > 0 && (
                    <span className="pill">
                      {d.classes.length}{" "}
                      {d.classes.length === 1 ? "class" : "classes"}
                    </span>
                  )}
                  {allDueToday.length > 0 && (
                    <span
                      className={
                        "pill " +
                        (allDueToday.some((t) => t.priority <= 2)
                          ? "rose"
                          : "amber")
                      }
                    >
                      {allDueToday.length}{" "}
                      {allDueToday.length === 1 ? "due" : "due"}
                    </span>
                  )}
                </div>
              </div>

              {d.classes.length === 0 && isWeekend && (
                <div className="muted" style={{ marginTop: 8 }}>
                  No classes.
                </div>
              )}

              {d.classes.map((c) => {
                const start = toMin(c.start_time);
                const end = toMin(c.end_time);
                const now = nowMin();
                const isCurrent = isToday && c.id === currentClassId;
                const isNext = isToday && c.id === nextClassId;
                const isPast = isToday && end <= now;
                return (
                  <div
                    key={"c" + c.id}
                    className={
                      "class-row" +
                      (isCurrent ? " now" : "") +
                      (isPast ? " past" : "") +
                      (isNext ? " next" : "")
                    }
                    style={{
                      display: "flex",
                      gap: 10,
                      margin: "8px 0",
                      alignItems: "center",
                      opacity: isPast ? 0.55 : 1,
                      padding: isCurrent ? "6px 8px" : "0",
                      borderRadius: isCurrent ? 8 : 0,
                      background: isCurrent
                        ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                        : undefined,
                    }}
                  >
                    <span className="pill mono" style={{ minWidth: 98, textAlign: "center" }}>
                      {c.start_time}–{c.end_time}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        className="title"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        <span className={"pill " + subjectHue(c.subject)}>
                          {c.subject}
                        </span>
                        {isCurrent && (
                          <span className="pill teal" title="Happening now">
                            now
                          </span>
                        )}
                        {isNext && (
                          <span className="pill amber" title="Next up">
                            next
                          </span>
                        )}
                        {isPast && <small className="muted">done</small>}
                      </div>
                      <div className="sub muted" style={{ marginTop: 2 }}>
                        {c.code || ""}
                        {c.room ? ` · ${c.room}` : ""}
                        {c.faculty ? ` · ${c.faculty}` : ""}
                      </div>
                    </div>
                    {c.kind === "lab" && (
                      <span className="pill rose" title="Lab">
                        lab
                      </span>
                    )}
                    {c.kind === "tutorial" && (
                      <span className="pill amber" title="Tutorial / project">
                        tut
                      </span>
                    )}
                  </div>
                );
              })}

              {allDueToday.length > 0 && (
                <div className="due-section">
                  <div className="section-label due-section-label">
                    Due this day
                    <span className="muted" style={{ marginLeft: 6 }}>
                      · {allDueToday.length}
                    </span>
                  </div>
                  <div className="due-list">
                    {allDueToday.map((t) => (
                      <DeadlineRow
                        key={"t" + t.id}
                        t={t}
                        onToggle={toggleTask}
                      />
                    ))}
                  </div>
                </div>
              )}

              {isEmpty && (
                <div className="muted" style={{ marginTop: 6 }}>
                  Nothing scheduled.
                </div>
              )}
            </div>
          );
        })}
    </>
  );
}

function DeadlineRow({ t, onToggle }) {
  const isUrgent = t.priority <= 2;
  return (
    <div className={"due-row" + (t.completed ? " done" : "")}>
      <input
        type="checkbox"
        checked={!!t.completed}
        onChange={() => onToggle(t.id)}
        aria-label={`Toggle ${t.title}`}
      />
      <div className="due-row-body">
        <div className="due-row-title">{t.title}</div>
        <div className="due-row-meta">
          {t.category && <span className="pill gray">{t.category}</span>}
          {t.course_code && <span className="pill">{t.course_code}</span>}
          {t.estimated_minutes ? (
            <span className="due-row-est">~{t.estimated_minutes} min</span>
          ) : null}
        </div>
      </div>
      <span
        className={
          "pill " + (isUrgent ? "rose" : t.priority === 3 ? "amber" : "gray")
        }
        title={
          isUrgent
            ? "Urgent"
            : t.priority === 3
              ? "Normal"
              : "Low"
        }
      >
        P{t.priority}
      </span>
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

function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const t of list) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}
