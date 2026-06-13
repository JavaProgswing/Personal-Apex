import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../lib/api.js";

// LiveTimer - universal "what am I doing right now" timer.
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
  { key: "distraction", label: "Distraction", category: "distraction", desc: "Social media, doomscrolling - being honest" },
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
  { icon: "👀", title: "Eyes off-screen", desc: "20-20-20 rule - look 20 ft away for 20 seconds, repeat.", minutes: 5 },
  { icon: "💧", title: "Snack / drink",   desc: "Hydrate, grab a snack.", minutes: 10 },
  { icon: "🌳", title: "Outside",         desc: "Step outside, get sunlight + fresh air.", minutes: 15 },
  { icon: "🚿", title: "Reset (shower)",  desc: "Shower / freshen up to reset focus.", minutes: 20 },
  { icon: "📱", title: "Phone check",     desc: "Triage notifications, then back to work.", minutes: 5 },
  { icon: "🍴", title: "Meal",            desc: "Eat away from the desk.", minutes: 30 },
  { icon: "💬", title: "Social",          desc: "Talk to a friend / family for a few minutes.", minutes: 15 },
  { icon: "🧘", title: "Breathing",       desc: "Box-breathing or short meditation.", minutes: 5 },
  { icon: "😴", title: "Power nap",       desc: "Nap with an alarm - under 30 min so you don't go deep.", minutes: 20 },
  { icon: "🛋️", title: "Just rest",       desc: "Sit, stare, do nothing.", minutes: 10 },
];

export default function LiveTimer({ tasks = [], onChanged }) {
  const [active, setActive] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [showStart, setShowStart] = useState(false);
  // After a timer auto-stops we keep a "just finished" strip with the
  // logged block + one-click ways to keep going (same task, fresh block)
  // or take a sized break. Extending after the bell is the common case —
  // it shouldn't require re-typing anything.
  const [finished, setFinished] = useState(null);
  // Active leisure segment - runs independently of the live_timer state
  // so the user can be "off the clock" without having to start a fake
  // timer. Polled alongside the regular timer refresh.
  const [leisure, setLeisure] = useState(null);
  const [zen, setZen] = useState(null);
  // Away/idle awareness while a timer runs — so a focus block can't quietly
  // claim minutes you spent away from the desk.
  const [away, setAway] = useState(false);
  const [awayMin, setAwayMin] = useState(0);
  const lastIdlePollRef = useRef(0);
  const awayTimerIdRef = useRef(null);
  const tickRef = useRef(null);

  async function refresh() {
    try {
      const [t, l, z] = await Promise.all([
        api.timer.active(),
        api.leisure?.active?.() ?? Promise.resolve(null),
        api.zen?.active?.() ?? Promise.resolve(null),
      ]);
      setActive(t || null);
      setLeisure(l || null);
      setZen(z || null);
      onChanged?.(t || null);
    } catch {
      setActive(null);
    }
  }
  async function startLeisureSegment(label) {
    await api.leisure?.start?.({ label, estimatedMinutes: 15 });
    await refresh();
  }
  async function extendLeisureSegment(mins) {
    await api.leisure?.extend?.(mins);
    await refresh();
  }
  async function stopLeisureSegment() {
    await api.leisure?.stop?.();
    await refresh();
  }

  // Initial load + subscribe to push updates from main.
  useEffect(() => {
    refresh();
    const off = api.timer.onUpdate?.((t) => {
      setActive(t || null);
      onChanged?.(t || null);
    });
    const offZen = api.zen?.onUpdate?.((payload) => {
      setZen(payload?.session || null);
    });
    return () => {
      off?.();
      offZen?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 1Hz tick to drive the countdown/leisure elapsed time without re-fetching.
  // Snap `now` to the present the instant a timer activates — otherwise the
  // first render uses a `now` frozen from when the tick was last running.
  useEffect(() => {
    if (!active && !leisure) return;
    setNow(Date.now());
    tickRef.current = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tickRef.current);
  }, [active, leisure]);

  // Poll the system idle state while a timer runs; accumulate away minutes
  // per block (reset when a new timer starts). powerMonitor works even when
  // the per-app tracker is off.
  useEffect(() => {
    if (!active) { setAway(false); return; }
    if (awayTimerIdRef.current !== active.id) {
      awayTimerIdRef.current = active.id;
      setAwayMin(0);
    }
    lastIdlePollRef.current = Date.now();
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await api.tracker?.status?.();
        if (cancelled) return;
        const isAway = !!s?.idle;
        const nowMs = Date.now();
        if (isAway) setAwayMin((m) => m + (nowMs - lastIdlePollRef.current) / 60000);
        lastIdlePollRef.current = nowMs;
        setAway(isAway);
      } catch { /* ignore */ }
    };
    poll();
    const id = setInterval(poll, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [active?.id]);

  // Auto-finish when the timer has been at/under 0 for 45s — long enough to
  // hit "+10m keep going" without racing the auto-stop, short enough that an
  // abandoned bell still logs itself.
  const AUTO_STOP_GRACE_MS = 45_000;
  const overdueSince = useRef(null);
  useEffect(() => {
    if (!active) {
      overdueSince.current = null;
      return;
    }
    const remaining = remainingSec(active, now);
    if (remaining > 0) { overdueSince.current = null; return; } // extended past 0 — re-arm
    if (!overdueSince.current) overdueSince.current = Date.now();
    if (Date.now() - overdueSince.current > AUTO_STOP_GRACE_MS) {
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
        // Longer focus → longer break (rough rule of thumb).
        const breakMinutes = wasProductive && elapsed >= 25
          ? (elapsed >= 90 ? 15 : elapsed >= 50 ? 10 : 5)
          : null;
        setFinished({ row: justFinished, elapsed, breakMinutes });
        refresh();
      })();
    }
  }, [active, now]);

  // One click: fresh block on the same activity. Used from the finished
  // strip; mirrors everything except duration.
  async function goAgain(row, minutes = 25) {
    await api.timer.start({
      kind: row.kind,
      category: row.category,
      title: row.title,
      description: row.description || null,
      planned_minutes: minutes,
      task_id: row.task_id || null,
    });
    setFinished(null);
    refresh();
  }

  if (!active) {
    return (
      <>
        {finished && (
          <div className="break-suggest">
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>
                ✓ {finished.elapsed}m of “{finished.row.title}” logged
              </strong>
              <small className="muted" style={{ display: "block", marginTop: 2 }}>
                {finished.breakMinutes
                  ? `Keep the streak going, or take a ${finished.breakMinutes}-min break first.`
                  : "Back at it, or done for now?"}
              </small>
            </div>
            <div className="row" style={{ gap: 6, flexShrink: 0 }}>
              <button
                className="primary small"
                onClick={() => goAgain(finished.row, 25)}
                title="New 25-min block on the same activity"
              >
                ▶ Go again · 25m
              </button>
              <button
                className="ghost small"
                onClick={() => goAgain(finished.row, 10)}
                title="Short 10-min wrap-up block"
              >
                +10m
              </button>
              {finished.breakMinutes && (
                <button
                  className="ghost small"
                  onClick={async () => {
                    await api.timer.start({
                      kind: "break",
                      category: "neutral",
                      title: "Stretch / walk",
                      description:
                        "Stand up, move around. Auto-suggested after " +
                        `${finished.elapsed}m of focus.`,
                      planned_minutes: finished.breakMinutes,
                    });
                    setFinished(null);
                    refresh();
                  }}
                  title="Quick break"
                >
                  Break {finished.breakMinutes}m
                </button>
              )}
              <button
                className="ghost xsmall"
                onClick={() => setFinished(null)}
                title="Dismiss"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          </div>
        )}
        {/* Leisure mode - a parallel "I'm on a break" state. Lives next
            to the work-timer slot so the dashboard always reflects what
            the user is actually doing. */}
        {leisure ? (
          <LeisureStrip
            seg={leisure}
            now={now}
            onExtend={extendLeisureSegment}
            onStop={stopLeisureSegment}
          />
        ) : (
          <div className="live-timer idle-slim">
            <span className="muted">Ready to focus?</span>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className="ghost small"
                onClick={() => startLeisureSegment("On a break")}
                title="Log a break - extend, resume, or stop when you're back"
              >
                Start leisure
              </button>
              <button className="primary small" onClick={() => setShowStart(true)}>
                Start a timer
              </button>
            </div>
          </div>
        )}
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
  const lockedByZen = zen?.mode === "locked" && remaining > 0;

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
          {awayMin >= 1 ? (
            <> · <span className="timer-away-stat">{Math.round(awayMin)}m away</span></>
          ) : null}
          {lockedByZen ? <> · locked by Zen</> : null}
        </div>
        {away && (
          <div className="timer-away-now">⏸ You're away — this time isn't focus.</div>
        )}
      </div>
      <div className="live-timer-clock">
        <div className={"live-timer-time" + (isOver ? " over" : isLow ? " low" : "")}>
          {isOver ? `+${fmt(-remaining)}` : fmt(remaining)}
        </div>
        {isOver && (
          <small className="muted live-timer-autostop">
            auto-logs in {Math.max(0, Math.ceil((AUTO_STOP_GRACE_MS - (overdueSince.current ? now - overdueSince.current : 0)) / 1000))}s
          </small>
        )}
        <div className="live-timer-actions">
          {isOver ? (
            // Past zero the common move is "keep going" — make it the loud one.
            <button
              className="primary small"
              onClick={async () => {
                await api.timer.extend(10);
                refresh();
              }}
              title="Add 10 minutes and keep this block running"
            >
              +10m keep going
            </button>
          ) : (
            <>
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
            </>
          )}
          <button
            className="primary small"
            onClick={async () => {
              const result = await api.timer.stop();
              if (result?.locked) {
                setZen(result.session || zen);
                return;
              }
              refresh();
            }}
            title={lockedByZen ? "Locked focus ends when the timer reaches zero" : "Stop and log this timer"}
            disabled={lockedByZen}
          >
            {lockedByZen ? "Locked" : "■ Stop"}
          </button>
          <button
            className="ghost xsmall"
            onClick={async () => {
              if (lockedByZen) return;
              if (
                elapsed >= 60 &&
                !confirm("Cancel this timer? Less than a minute will be discarded; >1m logs as cancelled.")
              ) {
                return;
              }
              const result = await api.timer.cancel();
              if (result?.locked) {
                setZen(result.session || zen);
                return;
              }
              refresh();
            }}
            title={lockedByZen ? "Locked focus cannot be cancelled early" : "Cancel - discard if <1m, else log as cancelled"}
            disabled={lockedByZen}
          >
            ✕
          </button>
        </div>
        {/* Emergency stop — the escape hatch. Kills the timer AND any Zen,
            even a locked one, and clears the phone/web block. Always available. */}
        <button
          className="live-timer-emergency"
          onClick={async () => {
            if (!confirm("Emergency stop? Ends this focus block now — including a locked Zen — and clears it on your phone and the web.")) return;
            await api.focus?.emergencyStop?.();
            setZen(null);
            refresh();
          }}
          title="Force-end this focus block on every device"
        >
          ⏹ Emergency stop
        </button>
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
                <option value="">- none -</option>
                {openTasks.slice(0, 50).map((t) => (
                  <option key={t.id} value={t.id}>
                    P{t.priority} · {t.title.slice(0, 60)}
                  </option>
                ))}
              </select>
            </div>
          )}

        {/* Break presets - quick-pick "what for?" so a break gets logged
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
  // Clamp elapsed to >= 0. While no timer runs the 1Hz tick is paused, so
  // `now` is stale; the first frame after start would otherwise compute a
  // negative elapsed and flash an inflated time (e.g. 45:00) before settling
  // on the real countdown.
  const elapsed = Math.max(0, Math.floor((now - start) / 1000));
  return total - elapsed;
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

// Compact strip shown while the user is in "leisure mode". Replaces the
// "Ready to focus?" line. Shows how long the break has been running and
// gives quick +5/+10/+15 extend buttons. Stop fires `leisure:stop` which
// closes the open segment.
function LeisureStrip({ seg, now, onExtend, onStop }) {
  const start = seg?.started_at
    ? new Date((seg.started_at.length === 19 ? seg.started_at + "Z" : seg.started_at))
    : new Date();
  const elapsedSec = Math.max(0, Math.floor((now - start.getTime()) / 1000));
  const elapsedMin = Math.floor(elapsedSec / 60);
  const estimated = seg?.estimated_minutes || null;
  const overdue = estimated && elapsedMin > estimated;
  return (
    <div className={"live-timer leisure-strip" + (overdue ? " overdue" : "")}>
      <div className="leisure-strip-left">
        <div className="leisure-strip-title">
          <span className="leisure-pulse" aria-hidden />
          {seg.label || "On a break"}
        </div>
        <small className="muted">
          {fmt(elapsedSec)}
          {estimated ? ` / ~${estimated}m est` : ""}
          {overdue ? " · over" : ""}
        </small>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <button className="ghost xsmall" onClick={() => onExtend(5)} title="Extend by 5 min">+5</button>
        <button className="ghost xsmall" onClick={() => onExtend(10)} title="Extend by 10 min">+10</button>
        <button className="ghost xsmall" onClick={() => onExtend(15)} title="Extend by 15 min">+15</button>
        <button className="primary small" onClick={onStop} title="Back to work">
          Resume work
        </button>
      </div>
    </div>
  );
}
