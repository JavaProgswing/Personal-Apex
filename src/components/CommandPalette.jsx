import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../lib/api.js";

// Ctrl+K / Cmd+K to open. Fuzzy over nav + tasks + people + interests.
// First line = "New task: …" shortcut; press Enter with a query to create.
export default function CommandPalette({ open, onClose, onNavigate }) {
  const [q, setQ] = useState("");
  const [tasks, setTasks] = useState([]);
  const [people, setPeople] = useState([]);
  const [interests, setInterests] = useState([]);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setIdx(0);
    (async () => {
      const [t, p, i] = await Promise.all([
        api.tasks.list({ completed: false, kind: "task" }),
        api.people.list({}),
        api.tasks.list({ kind: "interest" }),
      ]);
      setTasks(t);
      setPeople(p);
      setInterests(i);
    })();
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  const items = useMemo(() => {
    const nav = [
      { kind: "nav", label: "Dashboard", go: "dashboard" },
      { kind: "nav", label: "Upcoming",  go: "upcoming" },
      { kind: "nav", label: "Tasks",     go: "tasks" },
      { kind: "nav", label: "People",    go: "people" },
      { kind: "nav", label: "Settings",  go: "settings" },
    ];
    const all = [
      ...nav,
      ...tasks.map((t) => ({
        kind: "task",
        label: t.title,
        sub: `P${t.priority} · ${t.category || "—"}`,
        id: t.id,
      })),
      ...people.map((p) => ({
        kind: "person",
        label: p.name,
        sub: p.github_username ? "@" + p.github_username : "",
        id: p.id,
      })),
      ...interests.map((i) => ({
        kind: "interest",
        label: i.title,
        sub: i.category || "",
        id: i.id,
      })),
    ];
    if (!q.trim()) return all.slice(0, 40);
    const needle = q.toLowerCase();
    return all
      .map((it) => ({
        it,
        score:
          score(it.label.toLowerCase(), needle) +
          (it.sub ? score(String(it.sub).toLowerCase(), needle) / 2 : 0),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 40)
      .map((x) => x.it);
  }, [q, tasks, people, interests]);

  async function exec(item) {
    if (!item) return;
    if (item.kind === "nav") {
      onNavigate(item.go);
    } else if (item.kind === "task") {
      onNavigate("tasks");
    } else if (item.kind === "person") {
      onNavigate("people");
    } else if (item.kind === "interest") {
      onNavigate("tasks");
    }
    onClose();
  }

  async function quickAdd() {
    const title = q.trim();
    if (!title) return;
    await api.tasks.create({ title, priority: 3, category: "Deep work" });
    onClose();
    onNavigate("tasks");
  }

  function onKey(e) {
    if (e.key === "ArrowDown") {
      setIdx((i) => Math.min(items.length, i + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setIdx((i) => Math.max(0, i - 1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      if (idx === 0 && items.length === 0 && q.trim()) return quickAdd();
      exec(items[Math.max(0, idx - 1)] || items[0]);
    } else if (e.key === "Escape") onClose();
  }

  if (!open) return null;
  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" style={{ width: 640 }}>
        <input
          ref={inputRef}
          placeholder="Search tasks, people, interests… (Enter creates a task when empty matches)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={onKey}
          autoFocus
        />
        <div style={{ marginTop: 12, maxHeight: 440, overflowY: "auto" }}>
          {q.trim() && (
            <div
              className={"todo-row" + (idx === 0 ? " active-cmd" : "")}
              style={{
                background: idx === 0 ? "var(--bg-elev-2)" : "transparent",
                borderRadius: 8,
                padding: 10,
                cursor: "pointer",
              }}
              onClick={quickAdd}
            >
              <div>
                <div className="title">+ New task: “{q.trim()}”</div>
                <div className="sub">Press Enter</div>
              </div>
            </div>
          )}
          {items.map((it, i) => {
            const active = q.trim() ? idx === i + 1 : idx === i;
            return (
              <div
                key={i}
                className="todo-row"
                onMouseEnter={() => setIdx(q.trim() ? i + 1 : i)}
                onClick={() => exec(it)}
                style={{
                  background: active ? "var(--bg-elev-2)" : "transparent",
                  borderRadius: 8,
                  padding: 10,
                  cursor: "pointer",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div className="title">{it.label}</div>
                  {it.sub && <div className="sub">{it.sub}</div>}
                </div>
                <div className="right">
                  <span className="pill gray">{it.kind}</span>
                </div>
              </div>
            );
          })}
          {items.length === 0 && !q.trim() && (
            <div className="muted" style={{ padding: 10 }}>
              Start typing…
            </div>
          )}
        </div>
        <small className="hint" style={{ display: "block", marginTop: 10 }}>
          ↑↓ navigate · Enter to open/create · Esc to close
        </small>
      </div>
    </div>
  );
}

// Very small fuzzy score: +3 for substring, +1 per matched char in order.
function score(hay, needle) {
  if (!needle) return 1;
  if (hay.includes(needle)) return 6;
  let s = 0,
    j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) {
      s++;
      j++;
    }
  }
  return j === needle.length ? s : 0;
}
