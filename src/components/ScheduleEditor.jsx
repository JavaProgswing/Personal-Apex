import React, { useEffect, useState } from "react";
import api from "../lib/api.js";

// A small editor for the 5 SRM day-orders. Grouped by day_order, sorted by
// start_time. The backend's `replaceAll` re-writes everything in one tx.
const EMPTY = {
  day_order: 1, period: 1, slot: "", subject: "", code: "",
  room: "", faculty: "", start_time: "08:00", end_time: "08:50",
  kind: "lecture", note: "",
};

export default function ScheduleEditor() {
  const [rows, setRows] = useState([]);
  const [draft, setDraft] = useState(null);

  useEffect(() => { reload(); }, []);
  async function reload() { setRows(await api.schedule.list()); }

  async function saveRow(row) {
    await api.schedule.upsert(row);
    setDraft(null);
    reload();
  }
  async function del(id) {
    if (!confirm("Delete this class?")) return;
    await api.schedule.delete(id);
    reload();
  }

  const byDay = new Map([1, 2, 3, 4, 5].map((d) => [d, rows.filter((r) => r.day_order === d)]));

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between">
        <div className="card-title">Schedule editor</div>
        <div className="row">
          <button className="primary" onClick={() => setDraft(EMPTY)}>+ Add class</button>
        </div>
      </div>
      <small className="hint">
        Direct edits — re-syncing from AcademiaScraper will wipe changes. Use Add to insert things the scraper missed.
      </small>

      {[1, 2, 3, 4, 5].map((d) => (
        <div key={d} style={{ marginTop: 14 }}>
          <strong>Day order {d}</strong>
          <div>
            {(byDay.get(d) || []).length === 0 && <div className="muted sub" style={{ marginTop: 6 }}>Nothing yet.</div>}
            {(byDay.get(d) || []).map((r) => (
              <div key={r.id} className="row" style={{ alignItems: "center", margin: "6px 0", gap: 8 }}>
                <span className="pill mono">{r.start_time}–{r.end_time}</span>
                <div style={{ flex: 1 }}>
                  <div className="title">{r.subject}</div>
                  <div className="sub muted">
                    {r.code || "—"}{r.slot ? ` · slot ${r.slot}` : ""}{r.room ? ` · ${r.room}` : ""}{r.faculty ? ` · ${r.faculty}` : ""}
                  </div>
                </div>
                <span className="pill">{r.kind}</span>
                <button className="ghost" onClick={() => setDraft(r)}>Edit</button>
                <button className="ghost" onClick={() => del(r.id)} title="Delete">✕</button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {draft && <ClassModal initial={draft} onClose={() => setDraft(null)} onSave={saveRow} />}
    </div>
  );
}

function ClassModal({ initial, onClose, onSave }) {
  const [row, setRow] = useState(initial);
  function set(k, v) { setRow((r) => ({ ...r, [k]: v })); }
  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>{row.id ? "Edit class" : "New class"}</h3>
        <div className="grid-2">
          <div className="form-row">
            <label>Day order</label>
            <select value={row.day_order} onChange={(e) => set("day_order", +e.target.value)}>
              {[1, 2, 3, 4, 5].map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
          <div className="form-row">
            <label>Kind</label>
            <select value={row.kind || "lecture"} onChange={(e) => set("kind", e.target.value)}>
              <option value="lecture">lecture</option>
              <option value="lab">lab</option>
              <option value="tutorial">tutorial</option>
            </select>
          </div>
        </div>
        <div className="form-row">
          <label>Subject (short)</label>
          <input value={row.subject} onChange={(e) => set("subject", e.target.value)} />
        </div>
        <div className="grid-2">
          <div className="form-row">
            <label>Course code</label>
            <input value={row.code || ""} onChange={(e) => set("code", e.target.value)} />
          </div>
          <div className="form-row">
            <label>Slot</label>
            <input value={row.slot || ""} onChange={(e) => set("slot", e.target.value)} />
          </div>
        </div>
        <div className="grid-2">
          <div className="form-row">
            <label>Start</label>
            <input type="time" value={row.start_time} onChange={(e) => set("start_time", e.target.value)} />
          </div>
          <div className="form-row">
            <label>End</label>
            <input type="time" value={row.end_time} onChange={(e) => set("end_time", e.target.value)} />
          </div>
        </div>
        <div className="form-row">
          <label>Room</label>
          <input value={row.room || ""} onChange={(e) => set("room", e.target.value)} />
        </div>
        <div className="form-row">
          <label>Faculty</label>
          <input value={row.faculty || ""} onChange={(e) => set("faculty", e.target.value)} />
        </div>
        <div className="form-row">
          <label>Note</label>
          <input value={row.note || ""} onChange={(e) => set("note", e.target.value)} />
        </div>
        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onSave(row)} disabled={!row.subject?.trim() || !row.start_time || !row.end_time}>Save</button>
        </div>
      </div>
    </div>
  );
}
