import React from "react";

export default function Sidebar({ current, onChange, pages, onPalette }) {
  return (
    <aside className="sidebar">
      <div className="brand">APEX</div>
      {Object.entries(pages).map(([key, { label }], i) => (
        <div
          key={key}
          className={"nav-item" + (current === key ? " active" : "")}
          onClick={() => onChange(key)}
        >
          <span className="dot" />
          {label}
          <span
            style={{
              marginLeft: "auto",
              color: "var(--text-faint)",
              fontSize: 10,
            }}
          >
            Ctrl {i + 1}
          </span>
        </div>
      ))}
      <div style={{ marginTop: "auto" }}>
        <div
          className="nav-item"
          onClick={onPalette}
          title="Ctrl+K / Cmd+K"
          style={{ marginTop: 10 }}
        >
          <span className="dot" /> Search
          <span
            style={{
              marginLeft: "auto",
              color: "var(--text-faint)",
              fontSize: 10,
            }}
          >
            ⌘K
          </span>
        </div>
        <small
          className="hint"
          style={{ padding: "10px 8px 0", display: "block" }}
        >
          v0.1 · local-first
        </small>
      </div>
    </aside>
  );
}
