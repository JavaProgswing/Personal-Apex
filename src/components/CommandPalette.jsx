import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../lib/api.js";

// Cmd/Ctrl+K opens the action launcher. Designed as a verb-first command
// palette: most rows are ACTIONS that execute immediately rather than just
// navigations. Pages are still jumpable via "Go to ..." rows. Quick task
// capture is the empty-state default — type and press Enter to create.
export default function CommandPalette({ open, onClose, onNavigate }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [tasks, setTasks] = useState([]);
  const [currentTheme, setCurrentTheme] = useState("library");
  const [activeTimer, setActiveTimer] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setIdx(0);
    (async () => {
      try {
        const [t, theme, timer] = await Promise.all([
          api.tasks?.list?.({ completed: false, kind: "task" }) ?? [],
          api.settings?.get?.("ui.theme"),
          api.timer?.active?.(),
        ]);
        setTasks(t || []);
        if (theme) setCurrentTheme(theme);
        setActiveTimer(timer || null);
      } catch { /* ignore */ }
    })();
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  // Helper that executes an action and closes the palette unless told not to.
  const close = onClose;
  function go(page) { onNavigate(page); close(); }

  // ─── Action catalog ───────────────────────────────────────────────────
  const actions = useMemo(() => {
    const a = [];
    // — Timer —
    if (!activeTimer) {
      a.push({ kind: "Timer", icon: "▶", label: "Start 25-min focus timer",
        keywords: "timer pomodoro 25 focus", run: async () => {
          await api.timer.start({ kind: "task", title: "Focus", planned_minutes: 25 });
          go("dashboard");
        } });
      a.push({ kind: "Timer", icon: "▶", label: "Start 45-min deep work timer",
        keywords: "timer deep work 45 focus", run: async () => {
          await api.timer.start({ kind: "deep", title: "Deep work", planned_minutes: 45 });
          go("dashboard");
        } });
      a.push({ kind: "Timer", icon: "▶", label: "Start 60-min study timer",
        keywords: "timer study 60", run: async () => {
          await api.timer.start({ kind: "study", title: "Study", planned_minutes: 60 });
          go("dashboard");
        } });
    } else {
      a.push({ kind: "Timer", icon: "■", label: "Stop active timer",
        keywords: "timer stop end", run: async () => {
          await api.timer.stop(); close();
        } });
      a.push({ kind: "Timer", icon: "+", label: "Extend timer by 5 min",
        keywords: "timer extend more", run: async () => {
          await api.timer.extend(5); close();
        } });
    }

    // — Quick capture —
    a.push({ kind: "Capture", icon: "✎", label: "Brain dump",
      keywords: "brain dump capture jot note", run: () => go("brain") });
    a.push({ kind: "Capture", icon: "+", label: "New task...",
      keywords: "new task add create", run: () => {
        // Stay open and switch input prompt to "task: ..." mode.
        setQ("task: ");
        setTimeout(() => inputRef.current?.focus(), 0);
      }, stayOpen: true });

    // — AI / planning —
    a.push({ kind: "AI", icon: "✱", label: "Plan my day (Apex AI)",
      keywords: "plan day morning brief ai apex", run: () => go("apex") });
    a.push({ kind: "AI", icon: "✱", label: "Evening review",
      keywords: "evening review reflection day", run: () => go("apex") });

    // — Sync —
    if (api.srm?.syncNow) {
      a.push({ kind: "Sync", icon: "↻", label: "Sync SRM timetable",
        keywords: "sync srm academia timetable refresh", run: async () => {
          try { await api.srm.syncNow(); } catch {}
          close();
        } });
    }

    // — Spotify —
    a.push({ kind: "Spotify", icon: "♪", label: "Start focus playlist",
      keywords: "spotify focus play music playlist", run: async () => {
        try { await api.spotify?.playFocusPlaylist?.(); } catch {}
        close();
      } });
    a.push({ kind: "Spotify", icon: "⏸", label: "Pause / play Spotify",
      keywords: "spotify pause play toggle", run: async () => {
        try {
          const np = await api.spotify?.nowPlaying?.();
          if (np?.playing) await api.spotify?.pause?.();
          else await api.spotify?.play?.();
        } catch {}
        close();
      } });
    a.push({ kind: "Spotify", icon: "⏭", label: "Next track",
      keywords: "spotify skip next", run: async () => {
        try { await api.spotify?.next?.(); } catch {}
        close();
      } });

    // — Themes — quick switcher (top picks)
    // Curated list — kept in the same order as the Appearance picker.
    // Internal CSS may still have variants like Mono/Midnight/Carbon, but
    // they're not surfaced here to keep the chooser snappy and coherent.
    const themes = [
      ["default-dark", "Default · Dark"], ["default-light", "Default · Light"],
      ["slate", "Slate"], ["tokyo-night", "Tokyo Night"],
      ["catppuccin", "Catppuccin"], ["dracula", "Dracula"], ["one-dark", "One Dark"],
      ["vercel", "Vercel"], ["stripe", "Stripe"],
      ["synthwave", "Synthwave"], ["cyberpunk", "Cyberpunk"], ["matrix", "Matrix"],
      ["aurora", "Aurora"], ["obsidian", "Obsidian"], ["eclipse", "Eclipse"],
      ["library", "Library"], ["rose-pine", "Rosé Pine"], ["gruvbox", "Gruvbox"],
      ["nord", "Nord"], ["solarized-dark", "Solarized Dark"],
      ["paper", "Paper"], ["solarized-light", "Solarized Light"], ["latte", "Latte"],
    ];
    for (const [key, label] of themes) {
      a.push({
        kind: "Theme", icon: "🎨",
        label: `Switch theme: ${label}` + (currentTheme === key ? "  (current)" : ""),
        keywords: `theme palette appearance ${key} ${label}`,
        run: async () => {
          document.documentElement.dataset.theme = key;
          await api.settings?.set?.("ui.theme", key);
          close();
        },
      });
    }

    // — Page jumps —
    const PAGES = [
      ["dashboard", "Dashboard"], ["tasks", "Tasks"], ["schedule", "Schedule"],
      ["habits", "Habits"], ["cp", "Competitive programming"], ["activity", "Activity"],
      ["apex", "Apex AI"], ["brain", "Brain"], ["wellbeing", "Wellbeing"],
      ["settings", "Settings"],
    ];
    for (const [key, label] of PAGES) {
      a.push({
        kind: "Go to", icon: "→", label: `Go to ${label}`,
        keywords: `go to navigate jump ${key} ${label}`,
        run: () => go(key),
      });
    }

    // — Tasks (open) — quick navigate to a task
    for (const t of tasks.slice(0, 25)) {
      a.push({
        kind: "Task", icon: "✓", label: t.title,
        keywords: `task ${t.title} ${t.category || ""} ${t.course_code || ""}`,
        sub: `P${t.priority} · ${t.category || "—"}`,
        run: () => go("tasks"),
      });
    }

    return a;
  }, [tasks, currentTheme, activeTimer]);

  // ─── Filter ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    // Detect "task: foo" mode — let the user create a task inline.
    const taskMatch = q.match(/^task:\s*(.+)$/i);
    if (taskMatch) {
      const title = taskMatch[1].trim();
      return [{
        kind: "Capture", icon: "+", label: `Create task: "${title}"`,
        keywords: title,
        sub: "Press Enter to save",
        run: async () => {
          await api.tasks.create({ title, priority: 3, category: "Deep work" });
          close();
        },
      }];
    }
    if (!q.trim()) return actions.slice(0, 30);
    const needle = q.toLowerCase();
    return actions
      .map((a) => ({
        a,
        score:
          score(a.label.toLowerCase(), needle) * 2 +
          score((a.keywords || "").toLowerCase(), needle) +
          (a.kind ? score(a.kind.toLowerCase(), needle) : 0),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((x) => x.a);
  }, [q, actions]);

  // Group by `kind` for visual separation.
  const grouped = useMemo(() => {
    const g = {};
    filtered.forEach((a) => {
      if (!g[a.kind]) g[a.kind] = [];
      g[a.kind].push(a);
    });
    return g;
  }, [filtered]);

  function onKey(e) {
    if (e.key === "ArrowDown") {
      setIdx((i) => Math.min(filtered.length - 1, i + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setIdx((i) => Math.max(0, i - 1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      const item = filtered[idx];
      if (item) {
        const r = item.run?.();
        if (r?.then) r.then(() => { if (!item.stayOpen) close(); });
        else if (!item.stayOpen) close();
      } else if (q.trim()) {
        // Empty-result fallthrough: quick-create a task from the raw query.
        api.tasks.create({ title: q.trim(), priority: 3, category: "Deep work" })
          .then(close);
      }
    } else if (e.key === "Escape") {
      close();
    }
  }

  if (!open) return null;

  // Build flat-render-list with group headers for index alignment.
  let runningIdx = 0;
  const blocks = Object.entries(grouped).map(([kind, list]) => {
    const start = runningIdx;
    runningIdx += list.length;
    return { kind, list, start };
  });

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <div className="modal cmd-palette" style={{ width: 680, padding: 0 }}>
        <div className="cmd-input-wrap">
          <span className="cmd-prefix" aria-hidden>⌘</span>
          <input
            ref={inputRef}
            placeholder="Type a command, or task: ... to capture"
            value={q}
            onChange={(e) => { setQ(e.target.value); setIdx(0); }}
            onKeyDown={onKey}
            autoFocus
          />
          {q && (
            <button
              type="button"
              className="cmd-clear"
              onClick={() => { setQ(""); inputRef.current?.focus(); }}
              title="Clear"
            >
              ✕
            </button>
          )}
        </div>
        <div className="cmd-results">
          {filtered.length === 0 && (
            <div className="muted" style={{ padding: 16, textAlign: "center" }}>
              No matching actions. Type "task: …" to capture a new task.
            </div>
          )}
          {blocks.map((b) => (
            <div key={b.kind} className="cmd-group">
              <div className="cmd-group-title">{b.kind}</div>
              {b.list.map((a, j) => {
                const i = b.start + j;
                const active = i === idx;
                return (
                  <div
                    key={i}
                    className={"cmd-row" + (active ? " active" : "")}
                    onMouseEnter={() => setIdx(i)}
                    onClick={() => {
                      const r = a.run?.();
                      if (r?.then) r.then(() => { if (!a.stayOpen) close(); });
                      else if (!a.stayOpen) close();
                    }}
                  >
                    <span className="cmd-icon" aria-hidden>{a.icon}</span>
                    <div className="cmd-meta">
                      <div className="cmd-label">{a.label}</div>
                      {a.sub && <div className="cmd-sub muted">{a.sub}</div>}
                    </div>
                    {active && (
                      <span className="cmd-enter">↵</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cmd-footer">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
          <span style={{ marginLeft: "auto" }} className="muted">
            {filtered.length} action{filtered.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </div>
  );
}

// Very small fuzzy score: +6 for substring, +1 per matched char in order.
function score(hay, needle) {
  if (!needle) return 1;
  if (!hay) return 0;
  if (hay.includes(needle)) return 6;
  let s = 0, j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) { s++; j++; }
  }
  return j === needle.length ? s : 0;
}
