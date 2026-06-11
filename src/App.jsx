import React, { useEffect, useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import CommandPalette from "./components/CommandPalette.jsx";
import QuickCaptureModal from "./components/QuickCaptureModal.jsx";
import Dashboard from "./components/pages/Dashboard.jsx";
import Tasks from "./components/pages/Tasks.jsx";
import Upcoming from "./components/pages/Upcoming.jsx";
import People from "./components/pages/People.jsx";
import Settings from "./components/pages/Settings.jsx";
import Spotify from "./components/pages/Spotify.jsx";
import api from "./lib/api.js";

// Planner is retired - merged into Dashboard (Today's plan card + Ask Apex drawer).
// Timetable is retired - replaced by Upcoming (schedule + college tasks).
// Interests are merged into Tasks via a `kind` filter.
const PAGES = {
  dashboard: { label: "Dashboard", Comp: Dashboard },
  upcoming:  { label: "Upcoming",  Comp: Upcoming },
  tasks:     { label: "Tasks",     Comp: Tasks },
  people:    { label: "People",    Comp: People },
  spotify:   { label: "Spotify",   Comp: Spotify  },
  settings:  { label: "Settings",  Comp: Settings },
};

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [closeRequest, setCloseRequest] = useState(null);
  const [routineNudge, setRoutineNudge] = useState(null);

  // Hydrate the theme on mount. Default = "library". Stored in settings as
  // `ui.theme`; applied via a data attr on <html> so the CSS theme blocks
  // pick it up. Settings → Appearance writes to the same key. We also
  // re-apply any custom accent override (`ui.customAccent`), high-contrast
  // mode (`ui.contrast`), and per-token colour overrides (`ui.customColors`).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = (await api.settings?.get?.("ui.theme")) || "apex-focus";
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
          } catch { /* invalid json - ignore */ }
        }
      } catch {
        document.documentElement.dataset.theme = "apex-focus";
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      // Cmd/Ctrl+K still opens Quick Actions - that's the one shortcut
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

  useEffect(() => {
    if (!api?.routine?.onCloseBlocked) return;
    const off = api.routine.onCloseBlocked((payload) => setCloseRequest(payload || {}));
    return () => off?.();
  }, []);

  useEffect(() => {
    if (!api?.routine?.onNudge) return;
    const off = api.routine.onNudge((payload) => setRoutineNudge(payload || null));
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
      {closeRequest && (
        <CloseReasonModal
          request={closeRequest}
          onClose={() => setCloseRequest(null)}
        />
      )}
      {routineNudge && (
        <RoutineNudgeToast
          nudge={routineNudge}
          onClose={() => setRoutineNudge(null)}
        />
      )}
    </div>
  );
}

function RoutineNudgeToast({ nudge, onClose }) {
  const [busy, setBusy] = useState(false);
  async function markDone() {
    setBusy(true);
    try {
      await api.routine?.dismissNudge?.(nudge.key);
      onClose?.();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="routine-toast">
      <div>
        <strong>{nudge.title || "Routine reminder"}</strong>
        <small className="muted">{nudge.body || "Mark this done or hide this reminder."}</small>
      </div>
      <div className="row" style={{ gap: 6, flexShrink: 0 }}>
        <button className="primary small" onClick={markDone} disabled={busy}>
          {busy ? "Saving..." : "Already done"}
        </button>
        <button className="ghost xsmall" onClick={onClose} aria-label="Dismiss routine reminder">
          x
        </button>
      </div>
    </div>
  );
}

const CLOSE_REASON_PRESETS = [
  { category: "done-for-day", label: "Done", text: "Finished work for now" },
  { category: "break", label: "Break", text: "Taking an intentional break" },
  { category: "sleep", label: "Sleep", text: "Going to sleep" },
  { category: "switch-device", label: "Phone", text: "Continuing on another device" },
  { category: "maintenance", label: "System", text: "Restarting or fixing the app/system" },
  { category: "distraction-risk", label: "Avoid", text: "Closing to avoid distraction" },
];

function CloseReasonModal({ request, onClose }) {
  const foreground = request?.foreground || request?.payload?.foreground || null;
  const workContext = request?.workContext || request?.payload?.workContext || null;
  const activeWork = workContext?.activeZen || workContext?.activeTimer || null;
  const [category, setCategory] = useState(() => suggestedCloseCategory(foreground));
  const [reason, setReason] = useState(() => {
    const preset = CLOSE_REASON_PRESETS.find((p) => p.category === suggestedCloseCategory(foreground));
    return preset?.text || "";
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    const clean = reason.trim();
    if (clean.length < 3) {
      setErr("Add a short reason first.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api.routine.approveCloseReason({
        reason: clean,
        category,
        source: request?.source || "window-close",
      });
      if (!res?.ok) {
        setErr(res?.error || "Could not approve close.");
        setBusy(false);
        return;
      }
      onClose?.();
    } catch (e) {
      setErr(e?.message || "Could not approve close.");
      setBusy(false);
    }
  }

  return (
    <div className="modal-scrim close-reason-scrim">
      <div className="modal close-reason-modal" style={{ maxWidth: 520 }}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div>
            <h3 style={{ margin: 0 }}>Before Apex closes</h3>
            <small className="muted">
              {activeWork
                ? "A focus block is running. Save the reason so today's log stays honest."
                : "Stored in today's log so the day summary knows why you left."}
            </small>
          </div>
          <button className="ghost" onClick={onClose}>Stay open</button>
        </div>

        {activeWork && (
          <div className="close-reason-foreground">
            <small className="muted">
              {workContext?.activeZen ? "Active Zen" : "Active timer"}
            </small>
            <strong>{activeWork.title || "Focus block"}</strong>
            {workContext?.activeTimer?.description && (
              <span className="muted">{workContext.activeTimer.description}</span>
            )}
          </div>
        )}

        {foreground?.app && (
          <div className="close-reason-foreground">
            <small className="muted">Foreground</small>
            <strong>{foreground.app}</strong>
            {foreground.title && <span className="muted">{foreground.title}</span>}
          </div>
        )}

        <div className="close-reason-presets">
          {CLOSE_REASON_PRESETS.map((p) => (
            <button
              key={p.category}
              type="button"
              className={category === p.category ? "active" : ""}
              onClick={() => {
                setCategory(p.category);
                setReason((cur) => cur.trim() ? cur : p.text);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Done with DBMS notes; closing before I drift into YouTube"
          autoFocus
        />
        {err && <div className="error" style={{ marginTop: 6 }}>{err}</div>}
        <div className="row between" style={{ marginTop: 12, gap: 8 }}>
          <small className="muted">Close will be allowed for about 90 seconds.</small>
          <button className="primary" onClick={submit} disabled={busy || reason.trim().length < 3}>
            {busy ? "Saving..." : "Save reason and close"}
          </button>
        </div>
      </div>
    </div>
  );
}

function suggestedCloseCategory(foreground) {
  if (foreground?.category === "distraction") return "distraction-risk";
  const now = new Date();
  if (now.getHours() >= 22 || now.getHours() < 5) return "sleep";
  return "done-for-day";
}
