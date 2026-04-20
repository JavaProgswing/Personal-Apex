import React, { useEffect, useRef, useState } from "react";
import api from "../lib/api.js";
import { todayISO } from "../lib/date.js";

// A focused timer. Defaults to the task's estimated_minutes, falls back to 25.
// On finish: plays a bell, logs to time_entries with category='productive'.
export default function Pomodoro({ tasks, onLogged }) {
  const [selectedId, setSelectedId] = useState("");
  const [duration, setDuration] = useState(25);
  const [left, setLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");
  const [lastMsg, setLastMsg] = useState(null);
  const intRef = useRef(null);

  const task = tasks.find((t) => String(t.id) === selectedId);

  useEffect(() => {
    // When the picked task changes, seed duration from estimated_minutes.
    if (task?.estimated_minutes) {
      setDuration(task.estimated_minutes);
      if (!running) setLeft(task.estimated_minutes * 60);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!running) return;
    intRef.current = setInterval(() => {
      setLeft((s) => {
        if (s <= 1) {
          clearInterval(intRef.current);
          setRunning(false);
          onDone();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(intRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  function start() {
    if (left <= 0) setLeft(duration * 60);
    setRunning(true);
  }
  function pause() {
    setRunning(false);
  }
  function reset() {
    setRunning(false);
    setLeft(duration * 60);
  }

  async function onDone() {
    bell();
    const minutes = duration;
    await api.activity.add({
      date: todayISO(),
      app_name: task ? task.title : "focus session",
      category: "productive",
      minutes,
      note: note || (task ? `Focus on: ${task.title}` : null),
    });
    setLastMsg(`Logged ${minutes} min`);
    setTimeout(() => setLastMsg(null), 3000);
    onLogged?.();
  }

  const m = Math.floor(left / 60);
  const s = left % 60;
  const pct = duration > 0 ? (1 - left / (duration * 60)) * 100 : 0;

  return (
    <div className="card">
      <div className="row between">
        <div className="card-title" style={{ margin: 0 }}>
          Focus timer
        </div>
        {lastMsg && <span className="pill teal">{lastMsg}</span>}
      </div>
      <div className="row" style={{ margin: "12px 0" }}>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          style={{ maxWidth: 280 }}
        >
          <option value="">(no task — freeform)</option>
          {tasks.map((t) => (
            <option key={t.id} value={String(t.id)}>
              P{t.priority} · {t.title}
              {t.estimated_minutes ? ` (~${t.estimated_minutes}m)` : ""}
            </option>
          ))}
        </select>
        <input
          type="number"
          min={5}
          max={180}
          step={5}
          value={duration}
          onChange={(e) => {
            const v = Math.max(5, +e.target.value || 25);
            setDuration(v);
            if (!running) setLeft(v * 60);
          }}
          style={{ width: 90 }}
          title="Minutes"
        />
      </div>

      <div
        style={{
          fontSize: 44,
          fontWeight: 700,
          textAlign: "center",
          letterSpacing: 1,
        }}
      >
        {String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
      </div>
      <div className="bar" style={{ margin: "8px 0 14px" }}>
        <span style={{ width: `${pct}%` }} />
      </div>

      <input
        placeholder="Short note for the log (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        style={{ marginBottom: 10 }}
      />

      <div className="row">
        {!running ? (
          <button className="primary" onClick={start}>
            {left < duration * 60 && left > 0 ? "Resume" : "Start"}
          </button>
        ) : (
          <button onClick={pause}>Pause</button>
        )}
        <button onClick={reset}>Reset</button>
        <small className="hint">
          Logs to today&apos;s productive time on finish.
        </small>
      </div>
    </div>
  );
}

// Tiny WebAudio bell so we don't ship an audio file.
function bell() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    o.type = "sine";
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 1);
  } catch {
    /* ignore */
  }
}
