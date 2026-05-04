import React, { useEffect, useRef, useState } from "react";
import api from "../lib/api.js";

// Brain dump — paste any wall of text (chat transcript, plan email,
// meeting notes, reading list) and Apex extracts structured tasks. The
// user reviews them in a preview, deselects/edits any noise, then bulk-
// creates the kept rows. Created tasks carry `apex-import` so they're
// filterable/groupable later.
//
// Triggered from: Tasks page header button + Cmd/Ctrl+Shift+B shortcut.

const CATEGORY_OPTIONS = [
  "Deep work", "DSA", "Academics", "Project",
  "Social", "Personal", "Health", "Leisure",
];

export default function BrainDumpModal({ open, onClose, onCreated }) {
  const [phase, setPhase] = useState("paste"); // paste | extracted
  const [text, setText] = useState("");
  const [intent, setIntent] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [err, setErr] = useState(null);
  const [summary, setSummary] = useState("");
  const [topic, setTopic] = useState("");
  const [tasks, setTasks] = useState([]); // [{ ...task, _keep: true, _id: idx }]
  const [creating, setCreating] = useState(false);
  const textRef = useRef(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => textRef.current?.focus(), 30);
    } else {
      // Reset on close so a fresh open starts clean.
      setPhase("paste");
      setText("");
      setIntent("");
      setErr(null);
      setSummary("");
      setTopic("");
      setTasks([]);
    }
  }, [open]);

  if (!open) return null;

  async function extract() {
    if (!text.trim()) return;
    setExtracting(true);
    setErr(null);
    try {
      const res = await api.ollama.extractTasks({
        text: text.trim(),
        intent: intent.trim() || null,
      });
      if (!res?.ok && !res?.tasks) {
        setErr(res?.error || "Couldn't extract — Ollama may be offline.");
      } else {
        setSummary(res.summary || "");
        setTopic(res.topic || "");
        const decorated = (res.tasks || []).map((t, i) => ({
          ...t,
          _keep: true,
          _id: i,
        }));
        if (decorated.length === 0) {
          setErr("Apex didn't find any actionable items. Try adding intent above.");
        } else {
          setTasks(decorated);
          setPhase("extracted");
        }
      }
    } catch (e) {
      setErr(e?.message || "Extraction failed.");
    } finally {
      setExtracting(false);
    }
  }

  function patchTask(id, patch) {
    setTasks((cur) =>
      cur.map((t) => (t._id === id ? { ...t, ...patch } : t)),
    );
  }
  function setAllKept(on) {
    setTasks((cur) => cur.map((t) => ({ ...t, _keep: on })));
  }

  async function createKept() {
    const kept = tasks.filter((t) => t._keep);
    if (kept.length === 0) return;
    setCreating(true);
    let ok = 0;
    for (const t of kept) {
      try {
        const tags = Array.isArray(t.tags) ? [...t.tags] : [];
        if (!tags.includes("apex-import")) tags.push("apex-import");
        if (topic && !tags.includes(topic)) tags.push(topic);
        await api.tasks.create({
          title: t.title,
          description: t.description || "",
          kind: t.kind || "task",
          category: t.category || "Personal",
          priority: Math.max(1, Math.min(5, +t.priority || 3)),
          deadline: t.deadline ? new Date(t.deadline + "T17:00:00").toISOString() : null,
          estimated_minutes: t.estimated_minutes || null,
          tags,
          links: Array.isArray(t.links) ? t.links : [],
        });
        ok++;
      } catch { /* skip individual failures */ }
    }
    setCreating(false);
    onCreated?.({ added: ok, total: kept.length, summary, topic });
  }

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div className="modal brain-dump-modal" style={{ maxWidth: 820 }}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div>
            <h3 style={{ margin: 0 }}>Brain dump → tasks</h3>
            <small className="muted">
              {phase === "paste"
                ? "Paste anything — chat transcript, plan email, reading list. Apex extracts structured tasks you can review."
                : `Extracted ${tasks.length} task${tasks.length === 1 ? "" : "s"}. Uncheck any noise, edit fields inline, then add the keepers.`}
            </small>
          </div>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>

        {phase === "paste" && (
          <>
            <div className="form-row">
              <label>
                Intent <small className="muted">(optional — gives the model a steer)</small>
              </label>
              <input
                value={intent}
                placeholder="e.g. 'reverse-engineering hobby plan' or 'OS midterm prep'"
                onChange={(e) => setIntent(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label>
                Paste source
                <small className="muted" style={{ marginLeft: 6 }}>
                  ({text.length.toLocaleString()} / 18,000 chars)
                </small>
              </label>
              <textarea
                ref={textRef}
                rows={16}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={
                  "Paste a ChatGPT/Claude convo, an email, a syllabus paragraph, " +
                  "meeting notes, anything. Apex will pull structured tasks from it."
                }
                style={{
                  fontFamily: "ui-monospace, Menlo, Consolas, monospace",
                  fontSize: 12,
                  lineHeight: 1.5,
                  resize: "vertical",
                }}
              />
            </div>
            {err && <div className="error" style={{ marginTop: 6 }}>{err}</div>}
            <div className="row" style={{ marginTop: 12, justifyContent: "flex-end", gap: 8 }}>
              <button className="ghost" onClick={onClose}>Cancel</button>
              <button
                className="primary"
                onClick={extract}
                disabled={extracting || !text.trim()}
              >
                {extracting ? "Extracting…" : "✨ Extract tasks"}
              </button>
            </div>
          </>
        )}

        {phase === "extracted" && (
          <>
            {summary && (
              <div className="brain-dump-summary">
                <small className="muted">READ</small>
                <p style={{ margin: "4px 0 0" }}>{summary}</p>
                {topic && (
                  <small className="muted" style={{ display: "block", marginTop: 4 }}>
                    topic: <code>{topic}</code>
                  </small>
                )}
              </div>
            )}

            <div
              className="row"
              style={{ marginTop: 10, gap: 8, alignItems: "center" }}
            >
              <small className="muted" style={{ flex: 1 }}>
                {tasks.filter((t) => t._keep).length} of {tasks.length} kept
              </small>
              <button className="ghost xsmall" onClick={() => setAllKept(true)}>
                Keep all
              </button>
              <button className="ghost xsmall" onClick={() => setAllKept(false)}>
                Drop all
              </button>
            </div>

            <div className="brain-dump-list">
              {tasks.map((t) => (
                <div
                  key={t._id}
                  className={"brain-dump-row" + (t._keep ? "" : " skipped")}
                >
                  <input
                    type="checkbox"
                    checked={!!t._keep}
                    onChange={(e) => patchTask(t._id, { _keep: e.target.checked })}
                  />
                  <div className="brain-dump-row-body">
                    <input
                      className="brain-dump-title"
                      value={t.title}
                      onChange={(e) => patchTask(t._id, { title: e.target.value })}
                      disabled={!t._keep}
                    />
                    <div className="brain-dump-row-fields">
                      <select
                        value={t.kind || "task"}
                        onChange={(e) => patchTask(t._id, { kind: e.target.value })}
                        disabled={!t._keep}
                      >
                        <option value="task">task</option>
                        <option value="habit">habit</option>
                        <option value="interest">interest</option>
                      </select>
                      <select
                        value={t.category || "Personal"}
                        onChange={(e) => patchTask(t._id, { category: e.target.value })}
                        disabled={!t._keep}
                      >
                        {CATEGORY_OPTIONS.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      <select
                        value={t.priority || 3}
                        onChange={(e) => patchTask(t._id, { priority: +e.target.value })}
                        disabled={!t._keep}
                        title="Priority"
                      >
                        {[1, 2, 3, 4, 5].map((p) => (
                          <option key={p} value={p}>P{p}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={5}
                        step={5}
                        value={t.estimated_minutes || ""}
                        onChange={(e) =>
                          patchTask(t._id, {
                            estimated_minutes: e.target.value
                              ? +e.target.value
                              : null,
                          })
                        }
                        placeholder="min"
                        disabled={!t._keep}
                        title="Estimated minutes"
                        style={{ width: 70 }}
                      />
                      <input
                        type="date"
                        value={t.deadline || ""}
                        onChange={(e) =>
                          patchTask(t._id, { deadline: e.target.value || null })
                        }
                        disabled={!t._keep}
                        title="Deadline"
                      />
                    </div>
                    {t.description && (
                      <div className="brain-dump-desc">{t.description}</div>
                    )}
                    {Array.isArray(t.links) && t.links.length > 0 && (
                      <div className="brain-dump-links">
                        {t.links.slice(0, 3).map((l, i) => (
                          <a
                            key={i}
                            href={l}
                            onClick={(e) => {
                              e.preventDefault();
                              api.ext?.open?.(l);
                            }}
                          >
                            ↗ {String(l).slice(0, 60)}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div
              className="row"
              style={{ marginTop: 12, justifyContent: "space-between", gap: 8 }}
            >
              <button
                className="ghost"
                onClick={() => {
                  setPhase("paste");
                  setTasks([]);
                  setErr(null);
                }}
              >
                ← Back
              </button>
              <div className="row" style={{ gap: 8 }}>
                <button className="ghost" onClick={onClose}>Cancel</button>
                <button
                  className="primary"
                  onClick={createKept}
                  disabled={creating || tasks.filter((t) => t._keep).length === 0}
                >
                  {creating
                    ? "Adding…"
                    : `+ Add ${tasks.filter((t) => t._keep).length} task${
                        tasks.filter((t) => t._keep).length === 1 ? "" : "s"
                      }`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
