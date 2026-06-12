import React, { useEffect, useState } from "react";
import api from "../lib/api.js";

// Crisp stroke icons (24-grid, currentColor) — consistent weight, no emoji,
// no system-font dependency. Sized by .nav-icon svg in CSS.
function Icon({ children }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  dashboard: (
    <Icon>
      <rect x="3" y="3" width="7.5" height="9" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6" />
      <rect x="13.5" y="12" width="7.5" height="9" rx="1.6" />
      <rect x="3" y="15.5" width="7.5" height="5.5" rx="1.6" />
    </Icon>
  ),
  upcoming: (
    <Icon>
      <rect x="3" y="5" width="18" height="16" rx="2.2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
      <path d="M9 15.5h5.5M12.2 13l2.6 2.5-2.6 2.5" />
    </Icon>
  ),
  tasks: (
    <Icon>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m8.5 12.3 2.6 2.7 4.9-5.5" />
    </Icon>
  ),
  people: (
    <Icon>
      <circle cx="9.5" cy="8.5" r="3.4" />
      <path d="M3.5 20c.6-3.4 3-5.2 6-5.2s5.4 1.8 6 5.2" />
      <path d="M16 5.6a3.4 3.4 0 0 1 0 5.8M18.6 14.9c1.3.9 2.2 2.3 2.5 4.1" />
    </Icon>
  ),
  spotify: (
    <Icon>
      <circle cx="6.5" cy="18" r="2.6" />
      <circle cx="17.5" cy="16" r="2.6" />
      <path d="M9.1 18V6.4L20.1 4v12" />
    </Icon>
  ),
  settings: (
    <Icon>
      <path d="M4 7h9M17.5 7H20M4 17h4M12.5 17H20" />
      <circle cx="15" cy="7" r="2.4" />
      <circle cx="10" cy="17" r="2.4" />
    </Icon>
  ),
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
