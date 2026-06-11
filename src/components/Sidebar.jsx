import React, { useEffect, useState } from "react";
import api from "../lib/api.js";

// Typographic glyphs - no emoji, no system-font dependency.
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
  wellbeing:  "♥",
  settings:   "⚙",
  spotify:    "♪",
  people:     "○",
  upcoming:   "→",
};

export default function Sidebar({ current, onChange, pages, onPalette }) {
  // Collapsed state persists across reboots via settings.ui.sidebar.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    let mounted = true;
    api.settings?.get?.("ui.sidebar")?.then((v) => {
      if (mounted) setCollapsed(v === "collapsed");
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);
  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    try { api.settings?.set?.("ui.sidebar", next ? "collapsed" : "expanded"); } catch {}
    // Re-apply on document so layout CSS can react.
    document.documentElement.dataset.sidebar = next ? "collapsed" : "expanded";
  }
  useEffect(() => {
    document.documentElement.dataset.sidebar = collapsed ? "collapsed" : "expanded";
  }, [collapsed]);

  return (
    <aside className={"sidebar" + (collapsed ? " collapsed" : "")}>
      <div className="brand" title={collapsed ? "APEX - click to expand" : ""}>
        {!collapsed && <span className="brand-text">APEX</span>}
        <button
          type="button"
          className="sidebar-collapse"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "›" : "‹"}
        </button>
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
              title={label}
            >
              <span className="nav-icon" aria-hidden>{icon}</span>
              {!collapsed && <span className="nav-label">{label}</span>}
            </div>
          );
        })}
      </nav>
      <div style={{ marginTop: "auto" }}>
        <div
          className="nav-item nav-item-cmd"
          onClick={onPalette}
          title="Quick actions"
        >
          <span className="nav-icon" aria-hidden>+</span>
          {!collapsed && <span className="nav-label">Quick actions</span>}
        </div>
      </div>
    </aside>
  );
}
