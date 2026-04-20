import React, { useEffect, useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import Dashboard from "./components/pages/Dashboard.jsx";
import Tasks from "./components/pages/Tasks.jsx";
import Upcoming from "./components/pages/Upcoming.jsx";
import People from "./components/pages/People.jsx";
import Settings from "./components/pages/Settings.jsx";

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

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      // Direct jumps: Ctrl+1..5
      if (mod && /^[1-5]$/.test(e.key)) {
        const key = Object.keys(PAGES)[+e.key - 1];
        if (key) {
          e.preventDefault();
          setPage(key);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    </div>
  );
}
