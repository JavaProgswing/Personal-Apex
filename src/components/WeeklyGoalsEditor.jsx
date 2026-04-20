import React, { useEffect, useState } from "react";
import api from "../lib/api.js";

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
    if (!confirm("Reset all progress to 0?")) return;
    await api.goals.resetWeek();
    reload();
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between">
        <div className="card-title">Weekly goals</div>
        <div className="row">
          <button onClick={reset}>Reset progress</button>
          <button className="primary" onClick={() => setDraft({ title: "", target: 1, progress: 0, sort: 99 })}>+ New</button>
        </div>
      </div>
      <small className="hint">These replace the old "week's focus" row on the dashboard.</small>

      {goals.length === 0 && <div className="muted" style={{ marginTop: 8 }}>No goals yet.</div>}
      {goals.map((g) => {
        const pct = Math.min(100, Math.round((g.progress / (g.target || 1)) * 100));
        return (
          <div key={g.id} style={{ margin: "10px 0" }}>
            <div className="row between">
              <strong>{g.title}</strong>
              <small className="muted">{g.progress} / {g.target}</small>
            </div>
            <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
            <div className="row" style={{ marginTop: 4 }}>
              <button className="ghost" onClick={() => setDraft(g)}>Edit</button>
              <button className="ghost" onClick={() => remove(g.id)}>Delete</button>
              <button className="ghost" onClick={() => api.goals.incrementProgress(g.id, 1).then(reload)}>+1</button>
              <button className="ghost" onClick={() => api.goals.incrementProgress(g.id, -1).then(reload)}>-1</button>
            </div>
          </div>
        );
      })}

      {draft && <GoalModal initial={draft} onClose={() => setDraft(null)} onSave={save} />}
    </div>
  );
}

function GoalModal({ initial, onClose, onSave }) {
  const [g, setG] = useState(initial);
  function set(k, v) { setG((x) => ({ ...x, [k]: v })); }
  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{g.id ? "Edit goal" : "New goal"}</h3>
        <div className="form-row">
          <label>Title</label>
          <input autoFocus value={g.title} onChange={(e) => set("title", e.target.value)} />
        </div>
        <div className="grid-2">
          <div className="form-row">
            <label>Target</label>
            <input type="number" min={1} value={g.target} onChange={(e) => set("target", +e.target.value)} />
          </div>
          <div className="form-row">
            <label>Progress</label>
            <input type="number" min={0} value={g.progress} onChange={(e) => set("progress", +e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <label>Sort (lower = earlier)</label>
          <input type="number" value={g.sort} onChange={(e) => set("sort", +e.target.value)} />
        </div>
        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onSave(g)} disabled={!g.title?.trim()}>Save</button>
        </div>
      </div>
    </div>
  );
}
