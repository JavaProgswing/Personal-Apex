import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../lib/api.js";

// LiveTimer — universal "what am I doing right now" timer.
// Pinned to the top of the Dashboard. When idle, shows a "Start" call-to-
// action. When running, shows a countdown ring, the activity title +
// description, and quick actions (extend, stop, cancel).
//
// Activity is persisted in live_timer (singleton) on the main process. On
// stop/cancel, an activity_sessions row is written with source='timer' so
// the Top-apps strip and category totals reflect it.

const KIND_OPTIONS = [
  { key: "task",        label: "Task",        category: "productive", desc: "Focused work on a real task" },
  { key: "study",       label: "Study",       category: "productive", desc: "Reading, watching lectures, notes" },
  { key: "habit",       label: "Habit",       category: "productive", desc: "A routine you're stacking" },
  { key: "exercise",    label: "Exercise",    category: "rest",       desc: "Workout, run, gym, sport" },
  { key: "outdoor",     label: "Outdoor",     category: "rest",       desc: "Walk, errand, sunlight" },
  { key: "rest",        label: "Rest",        category: "rest",       desc: "Nap, meditation, eyes closed" },
  { key: "sleep",       label: "Sleep",       category: "rest",       desc: "Long sleep" },
  { key: "social",      label: "Social",      category: "leisure",    desc: "Hanging out, calls, meals with people" },
  { key: "leisure",     label: "Leisure",     category: "leisure",    desc: "Music, reading for fun" },
  { key: "gaming",      label: "Gaming",      category: "leisure",    desc: "Video games" },
  { key: "distraction", label: "Distraction", category: "distraction", desc: "Social media, doomscrolling — being honest" },
  { key: "break",       label: "Break",       category: "neutral",    desc: "Short break between work blocks" },
  { key: "transit",     label: "Transit",     category: "neutral",    desc: "Commuting, travel" },
  { key: "other",       label: "Other",       category: "neutral",    desc: "Anything else" },
];

const QUICK_DURATIONS = [10, 25, 45, 60, 90, 120];

// "What for?" preset chips that show up when the user picks `break` or
// `rest`. Each one prefills title + description + a sensible duration.
// Specific contexts beat a generic "Break" entry in the day's log and
// give the planner / evening-review better signal.
const BREAK_PRESETS = [
  { icon: "🚶", title: "Stretch / walk",  desc: "Stand up, move around, get the blood flowing.", minutes: 5 },
  { icon: "👀", title: "Eyes off-screen", desc: "20-20-20 rule — look 20 ft away for 20 seconds, repeat.", minutes: 5 },
  { icon: "💧", title: "Snack / drink",   desc: "Hydrate, grab a snack.", minutes: 10 },
  { icon: "🌳", title: "Outside",         desc: "Step outside, get sunlight + fresh air.", minutes: 15 },
  { icon: "🚿", title: "Reset (shower)",  desc: "Shower / freshen up to reset focus.", minutes: 20 },
  { icon: "📱", title: "Phone check",     desc: "Triage notifications, then back to work.", minutes: 5 },
  { icon: "🍴", title: "Meal",            desc: "Eat away from the desk.", minutes: 30 },
  { icon: "💬", title: "Social",          desc: "Talk to a friend / family for a few minutes.", minutes: 15 },
  { icon: "🧘", title: "Breathing",       desc: "Box-breathing or short meditation.", minutes: 5 },
  { icon: "😴", title: "Power nap",       desc: "Nap with an alarm — under 30 min so you don't go deep.", minutes: 20 },
  { icon: "🛋️", title: "Just rest",       desc: "Sit, stare, do nothing.", minutes: 10 },
];

export default function LiveTimer({ tasks = [], onChanged }) {
  const [active, setActive] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [showStart, setShowStart] = useState(false);
  // After a productive timer auto-stops we surface a small inline suggest:
  // "Take a 5-min break?" — one click starts a break-kind timer with a
  // sensible duration based on what just finished.
  const [breakSuggestion, setBreakSuggestion] = useState(null);
  const tickRef = useRef(null);

  async function refresh() {
    try {
      const t = await api.timer.active();
      setActive(t || null);
      onChanged?.(t || null);
    } catch {
      setActive(null);
    }
  }

  // Initial load + subscribe to push updates from main.
  useEffect(() => {
    refresh();
    const off = api.timer.onUpdate?.((t) => {
      setActive(t || null);
      onChanged?.(t || null);
    });
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1Hz tick to drive the countdown without re-fetching.
  useEffect(() => {
    if (!active) return;
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tickRef.current);
  }, [active]);

  // Auto-finish when the timer has been at/under 0 for 10s. We keep showing
  // the "0:00" briefly so the user sees the moment of completion.
  const overdueSince = useRef(null);
  useEffect(() => {
    if (!active) {
      overdueSince.current = null;
      return;
    }
    const remaining = remainingSec(active, now);
    if (remaining <= 0 && !overdueSince.current) overdueSince.current = Date.now();
    if (overdueSince.current && Date.now() - overdueSince.current > 10_000) {
      // Auto-stop and persist. If the just-finished timer was productive
      // (task / study / habit) and ran for >= 25 min, suggest a break.
      const justFinished = active;
      (async () => {
        await api.timer.stop();
        overdueSince.current = null;
        const elapsed = Math.round(
          (Date.now() - new Date(justFinished.started_at).getTime()) / 60000,
        );
        const wasProductive =
          justFinished.category === "productive" ||
          ["task", "study", "habit"].includes(justFinished.kind);
        if (wasProductive && elapsed >= 25) {
          // Longer focus → longer break (rough rule of thumb).
          const minutes = elapsed >= 90 ? 15 : elapsed >= 50 ? 10 : 5;
          setBreakSuggestion({
            after: justFinished.title,
            elapsed,
            minutes,
          });
        }
        refresh();
      })();
    }
  }, [active, now]);

  if (!active) {
    return (
      <>
        {breakSuggestion && (
          <div className="break-suggest">
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>
                Done — {breakSuggestion.elapsed}m of "{breakSuggestion.after}"
              </strong>
              <small className="muted" style={{ display: "block", marginTop: 2 }}>
                Take a {breakSuggestion.minutes}-min break before the next block?
              </small>
            </div>
            <div className="row" style={{ gap: 6, flexShrink: 0 }}>
              <button
                className="primary small"
                onClick={async () => {
                  await api.timer.start({
                    kind: "break",
                    category: "neutral",
                    title: "Stretch / walk",
                    description:
                      "Stand up, move around. Auto-suggested after " +
                      `${breakSuggestion.elapsed}m of focus.`,
                    planned_minutes: breakSuggestion.minutes,
                  });
                  setBreakSuggestion(null);
                  refresh();
                }}
                title="Quick break"
              >
                ▶ Take {breakSuggestion.minutes}m
              </button>
              <button
                className="ghost small"
                onClick={() => {
                  setShowStart(true);
                  setBreakSuggestion(null);
                }}
                title="Pick a different break preset"
              >
                Pick…
              </button>
              <button
                className="ghost xsmall"
                onClick={() => setBreakSuggestion(null)}
                title="Dismiss"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        )}
        <div className="live-timer idle">
          <div className="live-timer-idle-left">
            <div className="live-timer-idle-title">No active timer</div>
            <small className="muted">
              Start a timer for whatever you're doing — Apex will log it and
              plan around it.
            </small>
          </div>
          <button className="primary" onClick={() => setShowStart(true)}>
            ▶ Start a timer
          </button>
        </div>
        {showStart && (
          <StartTimerModal
            tasks={tasks}
            onClose={() => setShowStart(false)}
            onStarted={() => {
              setShowStart(false);
              refresh();
            }}
          />
        )}
      </>
    );
  }

  const remaining = remainingSec(active, now);
  const total = (active.planned_minutes + (active.extended_minutes || 0)) * 60;
  const elapsed = Math.max(0, total - remaining);
  const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
  const isLow = remaining > 0 && remaining <= 120;
  const isOver = remaining <= 0;
  const cat = active.category || "neutral";

  return (
    <div className={`live-timer running cat-${cat}` + (isLow ? " low" : "") + (isOver ? " over" : "")}>
      <Ring pct={pct} cat={cat} />
      <div className="live-timer-body">
        <div className="live-timer-head">
          <span className={`pill cat-${cat}-pill`}>
            {prettyKind(active.kind)}
          </span>
          <strong className="live-timer-title" title={active.title}>
            {active.title}
          </strong>
        </div>
        {active.description && (
          <div className="live-timer-desc" title={active.description}>
            {active.description}
          </div>
        )}
        <div className="live-timer-meta muted">
          {fmt(elapsed)} elapsed
          {active.extended_minutes ? (
            <> · +{active.extended_minutes}m extended</>
          ) : null}
        </div>
      </div>
      <div className="live-timer-clock">
        <div className={"live-timer-time" + (isOver ? " over" : isLow ? " low" : "")}>
          {fmt(Math.max(0, remaining))}
        </div>
        <div className="live-timer-actions">
          <button
            className="ghost xsmall"
            onClick={async () => {
              await api.timer.extend(5);
              refresh();
            }}
            title="Extend by 5 minutes"
          >
            +5
          </button>
          <button
            className="ghost xsmall"
            onClick={async () => {
              await api.timer.extend(15);
              refresh();
            }}
            title="Extend by 15 minutes"
          >
            +15
          </button>
          <button
            className="primary small"
            onClick={async () => {
              await api.timer.stop();
              refresh();
            }}
            title="Stop and log this timer"
          >
            ■ Stop
          </button>
          <button
            className="ghost xsmall"
            onClick={async () => {
              if (
                elapsed >= 60 &&
                !confirm("Cancel this timer? Less than a minute will be discarded; >1m logs as cancelled.")
              ) {
                return;
              }
              await api.timer.cancel();
              refresh();
            }}
            title="Cancel — discard if <1m, else log as cancelled"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

function StartTimerModal({ tasks, onClose, onStarted }) {
  const [kind, setKind] = useState("task");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [minutes, setMinutes] = useState(25);
  const [taskId, setTaskId] = useState("");

  const kindMeta = useMemo(
    () => KIND_OPTIONS.find((k) => k.key === kind) || KIND_OPTIONS[0],
    [kind],
  );

  const openTasks = (tasks || []).filter((t) => !t.completed);

  async function start() {
    const t = title.trim() ||
      (kind === "task" || kind === "study"
        ? "Focus block"
        : prettyKind(kind));
    await api.timer.start({
      kind,
      category: kindMeta.category,
      title: t,
      description: description.trim() || null,
      planned_minutes: +minutes || 25,
      task_id: taskId ? +taskId : null,
    });
    onStarted();
  }

  function pickTask(id) {
    setTaskId(id);
    if (!id) return;
    const t = openTasks.find((x) => String(x.id) === String(id));
    if (t) {
      setTitle(t.title);
      if (t.estimated_minutes) setMinutes(t.estimated_minutes);
      if (kind !== "task" && kind !== "study" && kind !== "habit")
        setKind("task");
    }
  }

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="row between" style={{ alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Start a timer</h3>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="form-row" style={{ marginTop: 12 }}>
          <label>What are you doing?</label>
          <div className="kind-grid">
            {KIND_OPTIONS.map((k) => (
              <button
                key={k.key}
                type="button"
                className={
                  "kind-btn cat-" + k.category + (kind === k.key ? " active" : "")
                }
                onClick={() => setKind(k.key)}
                title={k.desc}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        {(kind === "task" || kind === "study" || kind === "habit") &&
          openTasks.length > 0 && (
            <div className="form-row">
              <label>Link to a task (optional)</label>
              <select value={taskId} onChange={(e) => pickTask(e.target.value)}>
                <option value="">— none —</option>
                {openTasks.slice(0, 50).map((t) => (
                  <option key={t.id} value={t.id}>
                    P{t.priority} · {t.title.slice(0, 60)}
                  </option>
                ))}
              </select>
            </div>
          )}

        {/* Break presets — quick-pick "what for?" so a break gets logged
            with real context instead of just "Break". Click prefills
            title + description + duration; user can still tweak. */}
        {(kind === "break" || kind === "rest") && (
          <div className="form-row">
            <label>What for?</label>
            <div className="break-presets">
              {BREAK_PRESETS.map((b) => (
                <button
                  key={b.title}
                  type="button"
                  className="break-preset"
                  onClick={() => {
                    setTitle(b.title);
                    setDescription(b.desc);
                    setMinutes(b.minutes);
                  }}
                  title={b.desc}
                >
                  <span className="break-preset-icon" aria-hidden>{b.icon}</span>
                  <span className="break-preset-label">{b.title}</span>
                  <small className="muted">{b.minutes}m</small>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="form-row">
          <label>Title</label>
          <input
            value={title}
            placeholder={
              kind === "task" || kind === "study" ? "e.g. LeetCode #14" : prettyKind(kind)
            }
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>

        <div className="form-row">
          <label>Description / context (optional)</label>
          <textarea
            rows={2}
            value={description}
            placeholder="e.g. with friends, on the balcony, watching a tutorial…"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="form-row">
          <label>Duration</label>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {QUICK_DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                className={"chip" + (+minutes === d ? " active" : "")}
                onClick={() => setMinutes(d)}
              >
                {d}m
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={600}
              step={5}
              value={minutes}
              onChange={(e) => setMinutes(+e.target.value || 0)}
              style={{ width: 90 }}
              title="Custom minutes"
            />
          </div>
        </div>

        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={start} disabled={!minutes}>
            ▶ Start
          </button>
        </div>
      </div>
    </div>
  );
}

function Ring({ pct, cat }) {
  const r = 28;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <svg className={`live-timer-ring cat-${cat}`} viewBox="0 0 64 64" width={64} height={64}>
      <circle cx="32" cy="32" r={r} className="ring-track" />
      <circle
        cx="32"
        cy="32"
        r={r}
        className="ring-progress"
        strokeDasharray={`${dash} ${c}`}
        transform="rotate(-90 32 32)"
      />
    </svg>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────
function remainingSec(active, now) {
  if (!active) return 0;
  const start = new Date(active.started_at).getTime();
  const total =
    ((active.planned_minutes || 0) + (active.extended_minutes || 0)) * 60;
  return total - Math.floor((now - start) / 1000);
}
function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${String(mm).padStart(2, "0")}m`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}
function prettyKind(k) {
  const o = KIND_OPTIONS.find((x) => x.key === k);
  return o?.label || k || "Activity";
}
