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
  const [showImageImport, setShowImageImport] = useState(false);

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
        <div className="row" style={{ gap: 6 }}>
          <button onClick={() => setShowImageImport(true)}>Import from image</button>
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
      {showImageImport && (
        <ImageImportModal
          onClose={() => setShowImageImport(false)}
          onImported={() => { setShowImageImport(false); reload(); }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ImageImportModal — pick one or more timetable images, run local vision-OCR
// through Ollama, preview the extracted rows, and commit them to the DB.
// ────────────────────────────────────────────────────────────────────────────
function ImageImportModal({ onClose, onImported }) {
  const [paths, setPaths] = useState([]);
  const [hint, setHint] = useState("");
  const [allModels, setAllModels] = useState([]);
  const [models, setModels] = useState([]); // vision-capable subset
  const [model, setModel] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [rows, setRows] = useState([]);
  const [modelUsed, setModelUsed] = useState("");

  const VISION_RE = /vision|llava|minicpm-v|bakllava|moondream|qwen2-vl|qwen2\.5-vl|cogvlm/i;

  async function refreshModels() {
    const r = await api.ollama.listModels();
    const all = r?.models || [];
    const vision = all.filter((m) => VISION_RE.test(m));
    setAllModels(all);
    setModels(vision);
    if (vision.length > 0 && (!model || !vision.includes(model))) {
      setModel(vision[0]);
    }
  }

  useEffect(() => {
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pick() {
    const picked = await api.schedule.pickImages();
    if (Array.isArray(picked)) setPaths(picked);
  }

  async function extract() {
    if (paths.length === 0) {
      setErr("Pick at least one image first.");
      return;
    }
    if (models.length === 0) {
      setErr(
        "No vision model installed. Open a terminal and run `ollama pull llama3.2-vision` " +
        "(or `ollama pull minicpm-v` for a smaller alternative), then click Refresh.",
      );
      return;
    }
    setLoading(true);
    setErr("");
    setRows([]);
    setModelUsed("");
    try {
      const res = await api.schedule.parseImages({ imagePaths: paths, model, hint });
      if (!res?.ok) {
        setErr(
          res?.error ||
            "OCR failed. Make sure you have a vision model installed (e.g. `ollama pull llama3.2-vision`).",
        );
      } else {
        setRows(res.rows || []);
        setModelUsed(res.modelUsed || res.model || "");
        if ((res.rows || []).length === 0) {
          setErr(
            "The model returned no classes. Try a clearer image, a different vision model, " +
            "or add a hint below to nudge it.",
          );
        }
      }
    } finally {
      setLoading(false);
    }
  }
  async function commit() {
    if (rows.length === 0) return;
    if (!confirm(`Replace your whole schedule with these ${rows.length} classes?`)) return;
    const res = await api.schedule.importImageRows(rows);
    if (res?.ok) onImported();
    else setErr(res?.error || "Import failed.");
  }

  const byDay = new Map([1, 2, 3, 4, 5].map((d) => [d, rows.filter((r) => r.day_order === d)]));

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" style={{ width: 720 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }}>Import timetable from image</h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <p className="muted small" style={{ marginTop: 4 }}>
          Reads one or more screenshots of your timetable with a local vision model via Ollama. Nothing leaves your machine.
        </p>

        <div className="form-row">
          <label>Images</label>
          <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={pick}>{paths.length === 0 ? "Pick image(s)…" : "Replace images"}</button>
            {paths.length > 0 && (
              <small className="muted">
                {paths.length} file{paths.length === 1 ? "" : "s"}: {paths.map((p) => p.split(/[\\/]/).pop()).join(", ")}
              </small>
            )}
          </div>
        </div>

        <div className="form-row">
          <label>
            Vision model
            <button
              type="button"
              className="ghost xsmall"
              style={{ marginLeft: 8 }}
              onClick={refreshModels}
              title="Re-fetch the installed-models list"
            >
              ↻ Refresh
            </button>
          </label>
          {models.length === 0 ? (
            <div
              className="error"
              style={{
                padding: 10,
                borderRadius: 8,
                background: "rgba(239,107,90,0.10)",
                border: "1px solid rgba(239,107,90,0.30)",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              <strong>No vision model installed.</strong> Reading a timetable
              image needs one. In a terminal, run:
              <pre
                style={{
                  margin: "6px 0 4px",
                  padding: "6px 8px",
                  background: "var(--bg-elev-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  fontSize: 11,
                }}
              >
                ollama pull llama3.2-vision
              </pre>
              {allModels.length > 0 && (
                <small className="muted">
                  Currently installed: {allModels.slice(0, 6).join(", ")}
                  {allModels.length > 6 ? ` +${allModels.length - 6} more` : ""}
                </small>
              )}
            </div>
          ) : (
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="form-row">
          <label>
            Hint{" "}
            <small className="muted">
              (optional — e.g. "Day orders 1-3 are in the first image")
            </small>
          </label>
          <input
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="Context the model might need…"
          />
        </div>

        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <button
            className="primary"
            onClick={extract}
            disabled={loading || paths.length === 0 || models.length === 0}
            title={
              models.length === 0
                ? "Install a vision model first"
                : "Run OCR on the picked images"
            }
          >
            {loading ? "Reading…" : "Read timetable"}
          </button>
          {rows.length > 0 && (
            <button className="primary" onClick={commit}>
              Replace schedule ({rows.length})
            </button>
          )}
          {modelUsed && (
            <small className="muted" style={{ marginLeft: "auto" }}>
              via <strong>{modelUsed}</strong>
            </small>
          )}
        </div>

        {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}

        {rows.length > 0 && (
          <div style={{ marginTop: 14, maxHeight: 320, overflow: "auto" }}>
            <div className="muted small" style={{ marginBottom: 6 }}>
              Preview — review before committing. Commit replaces ALL existing classes.
            </div>
            {[1, 2, 3, 4, 5].map((d) => {
              const list = byDay.get(d) || [];
              if (list.length === 0) return null;
              return (
                <div key={d} style={{ marginTop: 8 }}>
                  <strong>Day order {d}</strong>
                  {list.map((r, i) => (
                    <div key={i} className="row" style={{ margin: "4px 0", gap: 8, alignItems: "center", fontSize: 12 }}>
                      <span className="pill mono">{r.start_time}–{r.end_time}</span>
                      <span style={{ flex: 1 }}>
                        <strong>{r.subject}</strong>
                        <span className="muted">
                          {r.code ? ` · ${r.code}` : ""}{r.room ? ` · ${r.room}` : ""}{r.faculty ? ` · ${r.faculty}` : ""}
                        </span>
                      </span>
                      <span className="pill">{r.kind}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
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
