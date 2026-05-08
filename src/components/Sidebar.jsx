import React from "react";

// Friendly icons per page key — falls back to a dot if unknown.
const ICONS = {
  dashboard:  "▣",
  tasks:      "✓",
  schedule:   "▦",
  calendar:   "▦",
  classes:    "▦",
  habits:     "◉",
  cp:         "<>",
  goals:      "★",
  activity:   "▤",
  ai:         "✱",
  apex:       "✱",
  brain:      "✎",
  wellbeing:  "❤",
  settings:   "⚙",
  spotify:    "♪",
};

export default function Sidebar({ current, onChange, pages, onPalette }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-dot" aria-hidden />
        APEX
      </div>
      <nav className="nav-list">
        {Object.entries(pages).map(([key, { label }], i) => {
          const icon = ICONS[key] || "•";
          const active = current === key;
          return (
            <div
              key={key}
              className={"nav-item" + (active ? " active" : "")}
              onClick={() => onChange(key)}
              title={`${label} · Ctrl ${i + 1}`}
            >
              <span className="nav-icon" aria-hidden>{icon}</span>
              <span className="nav-label">{label}</span>
              <span className="nav-shortcut">⌃{i + 1}</span>
            </div>
          );
        })}
      </nav>
      <div style={{ marginTop: "auto" }}>
        <div
          className="nav-item nav-item-cmd"
          onClick={onPalette}
          title="Quick actions · Ctrl+K / Cmd+K"
        >
          <span className="nav-icon" aria-hidden>⌘</span>
          <span className="nav-label">Quick actions</span>
          <span className="nav-shortcut">⌘K</span>
        </div>
      </div>
    </aside>
  );
}
