import React, { useEffect, useRef, useState } from "react";
import api from "../lib/api.js";

// Quick-capture modal — triggered by Cmd/Ctrl+Shift+N from anywhere
// (including when Apex is in the background, via a globalShortcut in
// main.cjs). One input, Enter to save, Esc to cancel.
//
// Smart parsing of the title line:
//   • "p1 finish auth"   → priority 1
//   • "lc 14"            → category "DSA"
//   • "1h read paper"    → estimated_minutes 60
//   • "30m walk"         → estimated_minutes 30
//   • "due fri make slides" → deadline next Friday 5pm
//   • "@health drink water"  → category Health
// Everything else becomes the title.
export default function QuickCaptureModal({ open, onClose, onCreated }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setText("");
      setErr(null);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  if (!open) return null;

  async function submit(e) {
    e?.preventDefault?.();
    const raw = text.trim();
    if (!raw) return;
    setBusy(true);
    setErr(null);
    try {
      const parsed = parseQuickInput(raw);
      await api.tasks.create({
        title: parsed.title,
        description: "",
        category: parsed.category || "Personal",
        priority: parsed.priority || 3,
        deadline: parsed.deadline || null,
        estimated_minutes: parsed.estimated_minutes || null,
        kind: parsed.kind || "task",
        tags: ["quick"],
        links: [],
      });
      onCreated?.();
    } catch (e2) {
      setErr(e2?.message || "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  const preview = text.trim() ? parseQuickInput(text.trim()) : null;

  return (
    <div
      className="modal-scrim quick-capture-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div className="modal quick-capture-modal">
        <form onSubmit={submit} className="quick-capture-form">
          <div className="quick-capture-prefix">+</div>
          <input
            ref={inputRef}
            value={text}
            placeholder="Quick capture — what needs doing?"
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
            spellCheck={false}
          />
          <button
            type="submit"
            className="primary"
            disabled={busy || !text.trim()}
          >
            {busy ? "…" : "Add"}
          </button>
        </form>
        {preview && (
          <div className="quick-capture-preview muted">
            <span>
              <strong className="text">{preview.title}</strong>
            </span>
            {preview.priority != null && (
              <span className="pill rose">P{preview.priority}</span>
            )}
            {preview.category && (
              <span className="pill gray">{preview.category}</span>
            )}
            {preview.estimated_minutes && (
              <span className="pill">~{preview.estimated_minutes}m</span>
            )}
            {preview.deadline && (
              <span className="pill amber">
                due {new Date(preview.deadline).toLocaleString([], {
                  weekday: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            )}
            {preview.kind && preview.kind !== "task" && (
              <span className="pill teal">{preview.kind}</span>
            )}
          </div>
        )}
        <div className="quick-capture-hints muted">
          <span><kbd>p1</kbd>–<kbd>p5</kbd> priority</span>
          <span><kbd>30m</kbd> / <kbd>1h</kbd> estimate</span>
          <span><kbd>due fri</kbd> / <kbd>due tomorrow</kbd></span>
          <span><kbd>@health</kbd> category</span>
          <span><kbd>!habit</kbd> kind</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
        {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}
      </div>
    </div>
  );
}

// ─── tiny smart-input parser ────────────────────────────────────────────
const CATEGORY_MAP = {
  "@dsa": "DSA",        "lc": "DSA",
  "@academics": "Academics",   "@class": "Academics",
  "@project": "Project",       "@build": "Project",
  "@social": "Social",
  "@personal": "Personal",
  "@health": "Health",         "@gym": "Health",
  "@leisure": "Leisure",
  "@deep": "Deep work",        "@work": "Deep work",
};

function parseQuickInput(raw) {
  let s = " " + raw + " ";
  const out = { title: raw };

  // Priority
  const p = s.match(/\sp([1-5])\b/i);
  if (p) { out.priority = +p[1]; s = s.replace(p[0], " "); }

  // Estimate
  const est = s.match(/\s(\d+)\s*(h|hr|hrs|hours?|m|min|mins?|minutes?)\b/i);
  if (est) {
    const n = +est[1];
    const unit = est[2].toLowerCase();
    out.estimated_minutes = unit.startsWith("h") ? n * 60 : n;
    s = s.replace(est[0], " ");
  }

  // Kind
  const kind = s.match(/\s!(task|habit|interest)\b/i);
  if (kind) { out.kind = kind[1].toLowerCase(); s = s.replace(kind[0], " "); }

  // Category — explicit @-prefixed first, then bare keywords
  const cat = s.match(/\s(@[a-z]+)\b/i);
  if (cat) {
    const k = cat[1].toLowerCase();
    if (CATEGORY_MAP[k]) {
      out.category = CATEGORY_MAP[k];
      s = s.replace(cat[0], " ");
    }
  }
  if (!out.category) {
    for (const k of Object.keys(CATEGORY_MAP)) {
      if (k.startsWith("@")) continue;
      const re = new RegExp("\\s" + k + "\\b", "i");
      if (re.test(s)) { out.category = CATEGORY_MAP[k]; break; }
    }
  }

  // Deadline — "due tomorrow", "due fri", "due 5pm", "due in 2h"
  const due = s.match(/\sdue\s+([a-z0-9: ]+?)(?=\s|$)/i);
  if (due) {
    const target = due[1].toLowerCase();
    const d = parseRelativeDate(target);
    if (d) {
      out.deadline = d.toISOString();
      s = s.replace(due[0], " ");
    }
  }

  out.title = s.trim().replace(/\s{2,}/g, " ") || raw;
  return out;
}

function parseRelativeDate(target) {
  const now = new Date();
  if (/^today$/.test(target)) {
    const d = new Date(now); d.setHours(17, 0, 0, 0); return d;
  }
  if (/^tomorrow$/.test(target) || /^tmrw$/.test(target)) {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d;
  }
  const dows = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const dow = target.slice(0, 3);
  if (dows[dow] != null) {
    const d = new Date(now);
    const target7 = (dows[dow] - now.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + target7);
    d.setHours(17, 0, 0, 0);
    return d;
  }
  // "in 2h" / "in 30m"
  const inN = target.match(/^in\s*(\d+)\s*(h|m)/);
  if (inN) {
    const d = new Date(now);
    if (inN[2] === "h") d.setHours(d.getHours() + +inN[1]);
    else d.setMinutes(d.getMinutes() + +inN[1]);
    return d;
  }
  // "5pm" / "11am"
  const t = target.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
  if (t) {
    const d = new Date(now);
    let hr = +t[1] % 12;
    if (t[3] === "pm") hr += 12;
    d.setHours(hr, +(t[2] || 0), 0, 0);
    if (d < now) d.setDate(d.getDate() + 1);
    return d;
  }
  return null;
}
