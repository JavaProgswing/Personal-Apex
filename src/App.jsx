import React, { useEffect, useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import QuickCaptureModal from "./components/QuickCaptureModal.jsx";
import Dashboard from "./components/pages/Dashboard.jsx";
import Tasks from "./components/pages/Tasks.jsx";
import Upcoming from "./components/pages/Upcoming.jsx";
import People from "./components/pages/People.jsx";
import Settings from "./components/pages/Settings.jsx";
import api from "./lib/api.js";

// Planner is retired — merged into Dashboard (Today's plan card + Ask Apex drawer).
// Timetable is retired — replaced by Upcoming (schedule + college tasks).
// Interests are merged into Tasks via a `kind` filter.
const PAGES = {
  dashboard: { label: "Dashboard", Comp: Dashboard },
  upcoming:  { label: "Upcoming",  Comp: Upcoming },
  tasks:     { label: "Tasks",     Comp: Tasks },
  people:    { label: "People",    Comp: People },
  settings:  { label: "Settings",  Comp: Settings },
};

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);

  // Hydrate the theme on mount. Default = "library". Stored in settings as
  // `ui.theme`; applied via a data attr on <html> so the CSS theme blocks
  // pick it up. Settings → Appearance writes to the same key. We also
  // re-apply any custom accent override (`ui.customAccent`), high-contrast
  // mode (`ui.contrast`), and per-token colour overrides (`ui.customColors`).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = (await api.settings?.get?.("ui.theme")) || "default-dark";
        if (!cancelled) document.documentElement.dataset.theme = t;

        const accent = await api.settings?.get?.("ui.customAccent");
        if (!cancelled && accent) {
          document.documentElement.style.setProperty("--accent", accent);
          document.documentElement.style.setProperty("--accent-soft", accent + "33");
          document.documentElement.style.setProperty("--accent-strong", accent);
        }

        const contrast = await api.settings?.get?.("ui.contrast");
        if (!cancelled && contrast === "high") {
          document.documentElement.dataset.contrast = "high";
        }

        const customColorsJson = await api.settings?.get?.("ui.customColors");
        if (!cancelled && customColorsJson) {
          try {
            const obj = JSON.parse(customColorsJson) || {};
            for (const [k, v] of Object.entries(obj)) {
              if (typeof v === "string" && v.trim()) {
                document.documentElement.style.setProperty(k, v);
              }
            }
            // Re-derive accent siblings if accent was overridden.
            if (obj["--accent"]) {
              document.documentElement.style.setProperty("--accent-soft", obj["--accent"] + "33");
              document.documentElement.style.setProperty("--accent-strong", obj["--accent"]);
            }
          } catch { /* invalid json — ignore */ }
        }
      } catch {
        document.documentElement.dataset.theme = "default-dark";
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      // Cmd/Ctrl+K still opens Quick Actions — that's the one shortcut
      // users actually muscle-memorise. Ctrl+1..5 page jumps and
      // Cmd+Shift+N quick capture were removed; they cluttered the UI
      // labels for almost no real-world usage.
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === "Escape") {
        if (quickOpen) setQuickOpen(false);
        else if (paletteOpen) setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [quickOpen, paletteOpen]);

  // Subscribe to the global Ctrl/Cmd+Shift+N shortcut from main.cjs so the
  // capture also opens when Apex isn't focused.
  useEffect(() => {
    if (!api?.shortcuts?.onQuickCapture) return;
    const off = api.shortcuts.onQuickCapture(() => setQuickOpen(true));
    return () => off?.();
  }, []);

  const Active = PAGES[page].Comp;

  return (
    <div className="app">
      <Sidebar
        current={page}
        onChange={setPage}
        pages={PAGES}
        onPalette={() => setPaletteOpen(true)}
      />
      <div className="main">
        <Active go={setPage} />
      </div>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={setPage}
      />
      <QuickCaptureModal
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        onCreated={() => setQuickOpen(false)}
      />
    </div>
  );
}
