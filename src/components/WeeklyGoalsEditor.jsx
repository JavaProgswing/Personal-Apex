import React, { useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";

// Preset goals commonly useful for a CS undergrad. Quick-add chips.
const PRESETS = [
  { title: "LeetCode problems", target: 10 },
  { title: "DSA revision hours", target: 6 },
  { title: "Side-project commits", target: 8 },
  { title: "Pages read", target: 60 },
  { title: "Gym sessions", target: 4 },
  { title: "Deep-work hours", target: 12 },
  { title: "Research paper skim", target: 2 },
];

export default function WeeklyGoalsEditor() {
  const [goals, setGoals] = useState([]);
  const [draft, setDraft] = useState(null);

  useEffect(() => { reload(); }, []);
  async function reload() { setGoals(await api.goals.list()); }

  async function save(g) {
    await api.goals.upsert(g);
    setDraft(null);
    reload();
  }
  async function remove(id) {
    if (!confirm("Delete this goal?")) return;
    await api.goals.delete(id);
    reload();
  }
  async function reset() {
    if (!confirm("Reset all progress to 0 for a new week?")) return;
    await api.goals.resetWeek();
    reload();
  }
  async function addPreset(p) {
    await api.goals.upsert({ title: p.title, target: p.target, progress: 0, sort: 99 });
    reload();
  }
  async function bumpProgress(g, delta) {
    const next = Math.max(0, (g.progress || 0) + delta);
    await api.goals.upsert({ ...g, progress: next });
    reload();
  }
  async function setProgress(g, value) {
    const next = Math.max(0, Math.min(Number(value) || 0, g.target * 2));
    await api.goals.upsert({ ...g, progress: next });
    reload();
  }

  // Only show presets that aren't already added (case-insensitive title match).
  const remainingPresets = useMemo(() => {
    const used = new Set(goals.map((g) => (g.title || "").toLowerCase().trim()));
    return PRESETS.filter((p) => !used.has(p.title.toLowerCase().trim()));
  }, [goals]);

  const total = goals.length;
  const done = goals.filter((g) => g.progress >= g.target).length;

  return (
    <div className="card weekly-goals" style={{ marginBottom: 16 }}>
      <div className="row between wg-header">
        <div>
          <div className="card-title">Weekly goals</div>
          <div className="muted small">
            {total === 0
              ? "Set a few loose targets for the week — no pressure."
              : `${done} of ${total} complete this week`}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {total > 0 && <button className="small ghost" onClick={reset}>Reset week</button>}
          <button className="small primary" onClick={() => setDraft({ title: "", target: 1, progress: 0, sort: 99 })}>+ New goal</button>
        </div>
      </div>

      {/* Preset quick-add chips */}
      {remainingPresets.length > 0 && (
        <div className="wg-presets">
          <div className="muted small" style={{ marginBottom: 4 }}>Quick add</div>
          <div className="chip-row">
            {remainingPresets.map((p) => (
              <button
                key={p.title}
                className="chip chip-add"
                onClick={() => addPreset(p)}
                title={`Adds "${p.title}" with a target of ${p.target}`}
              >
                + {p.title} <small className="muted">· {p.target}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Empty state when no goals */}
      {total === 0 && (
        <div className="wg-empty">
          <div className="wg-empty-title">No goals yet</div>
          <div className="muted small">Tap a preset above, or make one of your own.</div>
        </div>
      )}

      {/* Goal rows */}
      <div className="wg-list">
        {goals.map((g) => {
          const pct = Math.min(100, Math.round(((g.progress || 0) / (g.target || 1)) * 100));
          const isDone = g.progress >= g.target;
          return (
            <div key={g.id} className={`wg-row ${isDone ? "wg-done" : ""}`}>
              <div className="row between wg-row-head">
                <strong className="wg-title">{g.title}</strong>
                <span className="wg-progress-label">
                  <input
                    type="number"
                    min={0}
                    value={g.progress ?? 0}
                    onChange={(e) => setProgress(g, e.target.value)}
                    className="wg-progress-input"
                  />
                  <span className="muted"> / {g.target}</span>
                  <span className="wg-pct"> · {pct}%</span>
                </span>
              </div>
              <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
              <div className="row wg-actions">
                <button className="small ghost" onClick={() => bumpProgress(g, -1)} aria-label="Decrement">−1</button>
                <button className="small ghost" onClick={() => bumpProgress(g, 1)} aria-label="Increment">+1</button>
                <div style={{ flex: 1 }} />
                <button className="small ghost" onClick={() => setDraft(g)}>Edit</button>
                <button className="small ghost danger" onClick={() => remove(g.id)}>Delete</button>
              </div>
            </div>
          );
        })}
      </div>

      {draft && <GoalModal initial={draft} onClose={() => setDraft(null)} onSave={save} />}
    </div>
  );
}

function GoalModal({ initial, onClose, onSave }) {
  const [g, setG] = useState(initial);
  function set(k, v) { setG((x) => ({ ...x, [k]: v })); }
  const canSave = !!g.title?.trim() && (g.target || 0) > 0;
  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 420 }}>
        <h3 style={{ marginTop: 0 }}>{g.id ? "Edit goal" : "New goal"}</h3>
        <div className="form-row">
          <label>What are you tracking?</label>
          <input
            autoFocus
            placeholder="e.g. LeetCode problems"
            value={g.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </div>
        <div className="grid-2">
          <div className="form-row">
            <label>Weekly target</label>
            <input
              type="number"
              min={1}
              value={g.target}
              onChange={(e) => set("target", +e.target.value)}
            />
          </div>
          <div className="form-row">
            <label>Current progress</label>
            <input
              type="number"
              min={0}
              value={g.progress}
              onChange={(e) => set("progress", +e.target.value)}
            />
          </div>
        </div>
        <div className="form-row">
          <label className="muted small">Sort order (lower = higher in list)</label>
          <input type="number" value={g.sort} onChange={(e) => set("sort", +e.target.value)} />
        </div>
        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end", gap: 6 }}>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onSave(g)} disabled={!canSave}>
            {g.id ? "Save changes" : "Add goal"}
          </button>
        </div>
      </div>
    </div>
  );
}
