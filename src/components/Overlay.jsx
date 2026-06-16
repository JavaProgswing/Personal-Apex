import React, { useEffect, useRef, useState } from "react";
import api from "../lib/api.js";

// Apex focus HUD — a tiny, transparent, always-on-top overlay (own window).
// Collapsed: a translucent pill showing the current task + elapsed time.
// Hover: expands to today's per-task focus times (LeetCode vs prompts, etc.).
// Click-through by default; main flips ignore-mouse off while the cursor is
// over the pill (we report enter/leave) so it never blocks the apps behind.

function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}
function fmtMin(min) {
  const m = Math.round(min || 0);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export default function Overlay() {
  const [active, setActive] = useState(null);
  const [zen, setZen] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [fg, setFg] = useState(null); // current foreground app (passive reminder)
  const tick = useRef(null);

  async function refreshTimer() {
    try {
      setActive((await api.timer?.active?.()) || null);
      setZen((await api.zen?.active?.()) || null);
      setFg((await api.tracker?.status?.())?.current || null);
    } catch { /* ignore */ }
  }
  async function refreshTasks() {
    try {
      const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD local
      setTasks((await api.overlay?.taskTimes?.(today)) || []);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    refreshTimer();
    refreshTasks();
    const offT = api.timer?.onUpdate?.((t) => setActive(t || null));
    const offZ = api.zen?.onUpdate?.((p) => setZen(p?.session || null));
    const poll = setInterval(() => { refreshTimer(); }, 5000);
    const taskPoll = setInterval(refreshTasks, 30000);
    return () => { offT?.(); offZ?.(); clearInterval(poll); clearInterval(taskPoll); };
  }, []);

  // 1Hz clock only while something is running (keeps the HUD cheap when idle).
  useEffect(() => {
    if (!active) return;
    tick.current = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick.current);
  }, [active]);

  // Hover: make the window solid + interactive; leave: back to click-through.
  function onEnter() { setOpen(true); api.overlay?.setIgnore?.(false); refreshTasks(); }
  function onLeave() { setOpen(false); api.overlay?.setIgnore?.(true); }

  const elapsed = active
    ? Math.max(0, Math.floor((now - new Date(active.started_at).getTime()) / 1000))
    : 0;
  const total = active ? ((active.planned_minutes || 0) + (active.extended_minutes || 0)) * 60 : 0;
  const remaining = active ? total - elapsed : 0;
  const over = active && remaining <= 0;
  const cat = active?.category || "neutral";
  const todayTotal = tasks.reduce((s, t) => s + (t.minutes || 0), 0);
  // Passive focus reminder: no active timer but sitting on a distraction app.
  const passiveDistraction = !active && fg?.category === "distraction";

  return (
    <div className="ov-root" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className={"ov-pill cat-" + cat + (active ? " on" : "") + (over || passiveDistraction ? " over" : "")}>
        <span className="ov-dot" aria-hidden />
        <span className="ov-title" title={active?.title || fg?.app || ""}>
          {active ? active.title
            : passiveDistraction ? `${fg.app} — refocus?`
            : "No focus timer"}
        </span>
        {active && (
          <span className="ov-time">
            {over ? "+" + fmt(-remaining) : fmt(remaining)}
          </span>
        )}
        {zen?.mode && <span className="ov-zen">{zen.mode}</span>}
      </div>

      {open && (
        <div className="ov-panel">
          <div className="ov-panel-head">
            <strong>Today's focus</strong>
            <span className="ov-muted">{fmtMin(todayTotal)}</span>
          </div>
          {active && (
            <div className="ov-row ov-current">
              <span className="ov-row-name">▶ {active.title}</span>
              <span className="ov-muted">{fmt(elapsed)} this block</span>
            </div>
          )}
          {tasks.length === 0 ? (
            <div className="ov-muted ov-empty">No logged task time yet today.</div>
          ) : (
            tasks.map((t) => (
              <div className="ov-row" key={t.task}>
                <span className="ov-row-name" title={t.task}>{t.task}</span>
                <span className="ov-bar"><span style={{ width: Math.max(4, (t.minutes / (tasks[0].minutes || 1)) * 100) + "%" }} /></span>
                <span className="ov-muted">{fmtMin(t.minutes)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
