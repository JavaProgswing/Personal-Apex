import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../../lib/api.js";
import LiveTimer from "../LiveTimer.jsx";
import { MarkdownBlock } from "../../lib/markdown.jsx";
import { prettyAppName } from "../../lib/appName.js";

// Dashboard — the one place you land. Merges the old Planner (AI day plan +
// Ask-Apex drawer), keeps a compact burnout chip in the header, shows the
// current foreground app as a "now-strip" pulse, and renders a weekly activity
// trail from activity_sessions. Competitive-programming cards moved behind a
// header button ("My CP") so they don't eat the main surface.

const CATEGORY_KEYS = [
  "productive",
  "distraction",
  "neutral",
  "rest",
  "leisure",
  "mobile",
  "other",
];
const GOAL_PRESETS = [
  { title: "LeetCode problems", target: 10 },
  { title: "DSA revision hours", target: 6 },
  { title: "Side-project commits", target: 8 },
  { title: "Pages read", target: 60 },
  { title: "Gym sessions", target: 4 },
  { title: "Deep-work hours", target: 12 },
];
const CATEGORY_LABELS = {
  productive: "productive",
  distraction: "distraction",
  neutral: "neutral",
  rest: "rest",
  leisure: "leisure",
  mobile: "mobile",
  other: "other",
};

export default function Dashboard({ go }) {
  const [goals, setGoals] = useState([]);
  const [streak, setStreak] = useState({
    streak: 0,
    weekDays: [],
    weekDone: 0,
  });
  const [tasks, setTasks] = useState([]);
  const [classes, setClasses] = useState([]);
  const [dayOrder, setDayOrder] = useState(null);
  const [checkin, setCheckin] = useState({
    sleep: 6,
    clarity: 5,
    dread: 4,
    energy: 6,
    note: "",
  });
  const [checkinSaved, setCheckinSaved] = useState(false);
  const [burnoutLoading, setBurnoutLoading] = useState(false);
  const [burnoutReport, setBurnoutReport] = useState(null);
  const [recentBurnout, setRecentBurnout] = useState([]);

  // CP moved to a modal; we only keep a boolean for "has any cached CP at all"
  // so the header chip can light up conditionally.
  const [selfCp, setSelfCp] = useState(null);
  const [showCp, setShowCp] = useState(false);

  const [trackerStatus, setTrackerStatus] = useState(null);
  const [todayTotals, setTodayTotals] = useState(null);
  const [trend, setTrend] = useState([]);
  const [topApps, setTopApps] = useState([]);
  const [topAppsDate, setTopAppsDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [hiddenCats, setHiddenCats] = useState(() => new Set()); // toggleable legend

  const [toast, setToast] = useState(null);
  const [showAskApex, setShowAskApex] = useState(false);
  // Per-day class overrides — click a row to edit/cancel, or "+ Extra
  // class" to add a one-off entry to today's schedule.
  const [editingClass, setEditingClass] = useState(null);
  const [addingExtra, setAddingExtra] = useState(false);

  // Ollama / plan card. Models + ollamaOk are probed once. The cached plan is
  // read on first mount only — subsequent refreshes keep whatever the user
  // currently sees (so flipping to a class and back doesn't clobber anything).
  const [planCard, setPlanCard] = useState({
    loading: false,
    plan: null,
    error: null,
    ollamaOk: null,
    models: [],
    model: "",
  });
  const planBootstrappedRef = useRef(false);
  const pollRef = useRef(null);

  useEffect(() => {
    refresh(/* firstMount */ true); /* eslint-disable-next-line */
  }, []);

  // Subscribe to tracker nudges + session-ended events for toasts.
  useEffect(() => {
    const off1 = api.tracker.onNudge?.((p) => {
      setToast({
        kind: "nudge",
        title: "Long session",
        msg: `You've been in ${p.app} for ${p.minutes} min. Take a 5-min break?`,
      });
      setTimeout(() => setToast(null), 8000);
    });
    const off2 = api.tracker.onSessionEnded?.((p) => {
      if (p?.minutes >= 30) {
        setToast({
          kind: "session",
          title: "Session wrapped",
          msg: `${p.app} · ${p.minutes} min (${p.category})`,
        });
        setTimeout(() => setToast(null), 5000);
      }
      api.tracker
        .status()
        .then(setTrackerStatus)
        .catch(() => {});
      api.activity
        .todayTotals()
        .then(setTodayTotals)
        .catch(() => {});
      // refresh trend + topApps so the stack animates
      refreshActivity();
    });
    return () => {
      off1?.();
      off2?.();
    };
  }, []);

  useEffect(() => {
    // Tracker heartbeat — short poll so the "tracking" pill + current app
    // stay in sync with whatever the foreground window actually is.
    pollRef.current = setInterval(() => {
      api.tracker
        .status()
        .then(setTrackerStatus)
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(pollRef.current);
  }, []);

  // Whenever the user picks a different day in the trail, re-fetch top apps
  // for that date. For *today* we additionally re-poll every 60s so the list
  // updates as the tracker checkpoints the current session.
  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    const viewingToday = topAppsDate === today;

    let cancelled = false;
    const load = () => {
      api.activity
        .topApps(topAppsDate, 8)
        .then((apps) => { if (!cancelled) setTopApps(apps); })
        .catch(() => { if (!cancelled) setTopApps([]); });
      if (viewingToday) {
        api.activity.trend?.(7)
          .then((tr) => { if (!cancelled) setTrend(tr); })
          .catch(() => {});
        api.activity.todayTotals?.()
          .then((t) => { if (!cancelled) setTodayTotals(t); })
          .catch(() => {});
      }
    };
    load();
    if (!viewingToday) return () => { cancelled = true; };
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [topAppsDate]);

  async function refreshActivity() {
    const [tr, apps, totals] = await Promise.all([
      api.activity.trend ? api.activity.trend(7).catch(() => []) : [],
      api.activity.topApps
        ? api.activity.topApps(topAppsDate, 8).catch(() => [])
        : [],
      api.activity.todayTotals().catch(() => null),
    ]);
    setTrend(tr);
    setTopApps(apps);
    setTodayTotals(totals);
  }

  async function refresh(firstMount = false) {
    const [g, s, t, c, sched, latest, cpCache, ts] = await Promise.all([
      api.goals.list(),
      api.streak.status(),
      api.tasks.today(),
      api.checkins.today(),
      api.schedule.today(),
      api.burnout.latestReport(),
      api.cp.selfCached(),
      api.tracker.status().catch(() => null),
    ]);
    setGoals(g);
    setStreak(s);
    setTasks(t);
    setClasses(sched?.classes ?? []);
    setDayOrder(sched?.dayOrder ?? null);
    if (c)
      setCheckin({
        sleep: c.sleep,
        clarity: c.clarity,
        dread: c.dread,
        energy: c.energy,
        note: c.note ?? "",
      });
    if (latest?.payload) setBurnoutReport(latest.payload);
    if (cpCache) setSelfCp(cpCache);
    // Lightweight: pull last 7 days of risk scores for the trend strip
    if (api.burnout?.recent) {
      api.burnout.recent(7).then((rows) => setRecentBurnout(rows || [])).catch(() => {});
    }
    setTrackerStatus(ts);
    await refreshActivity();

    // Ollama + cached plan: do this exactly ONCE per mount. Subsequent refreshes
    // leave planCard alone, so toggling sidebars/tasks doesn't blow away the
    // plan the user is reading.
    if (firstMount && !planBootstrappedRef.current) {
      planBootstrappedRef.current = true;
      const [modelsRes, savedModel, savedPlanRaw, best] = await Promise.all([
        api.ollama.listModels().catch(() => ({ ok: false, models: [] })),
        api.settings.get("ollama.model"),
        api.settings.get("apex.plan.today"),
        api.ollama.best().catch(() => ({ model: null })),
      ]);
      const models = modelsRes?.models || [];
      // Priority: user-pinned setting (if still installed) → "best" auto-pick
      // from the rank (gpt-oss:120b-cloud > llama3:latest > gemma3:4b > …)
      // → first installed model.
      let chosen = "";
      if (savedModel && models.includes(savedModel)) chosen = savedModel;
      else if (best?.model && models.includes(best.model)) chosen = best.model;
      else if (models.length) chosen = models[0];

      let savedPlan = null;
      if (savedPlanRaw) {
        try {
          const parsed = JSON.parse(savedPlanRaw);
          if (parsed?.date === new Date().toISOString().slice(0, 10))
            savedPlan = parsed;
        } catch {}
      }
      setPlanCard((p) => ({
        ...p,
        ollamaOk: modelsRes?.ok ?? false,
        models,
        model: chosen,
        plan: savedPlan,
      }));
    }
  }

  async function refreshOllama() {
    const [r, best] = await Promise.all([
      api.ollama.listModels().catch(() => ({ ok: false, models: [] })),
      api.ollama.best().catch(() => ({ model: null })),
    ]);
    const models = r?.models || [];
    setPlanCard((p) => ({
      ...p,
      ollamaOk: r?.ok ?? false,
      models,
      model:
        p.model && models.includes(p.model)
          ? p.model
          : best?.model && models.includes(best.model)
          ? best.model
          : models[0] || "",
    }));
  }

  async function saveCheckin() {
    await api.checkins.upsert(checkin);
    setCheckinSaved(true);
    setTimeout(() => setCheckinSaved(false), 1600);
  }

  async function toggleTask(id) {
    await api.tasks.toggle(id);
    setTasks(await api.tasks.today());
    setStreak(await api.streak.status());
  }

  async function bumpGoal(g, delta = 1) {
    const next = Math.max(0, (g.progress || 0) + delta);
    await api.goals.upsert({ ...g, progress: next });
    setGoals(await api.goals.list());
  }
  async function setGoalProgress(g, value) {
    const next = Math.max(0, Math.min(Number(value) || 0, (g.target || 1) * 3));
    await api.goals.upsert({ ...g, progress: next });
    setGoals(await api.goals.list());
  }
  async function addGoalFromPreset(p) {
    await api.goals.upsert({
      title: p.title,
      target: p.target,
      progress: 0,
      sort: 99,
    });
    setGoals(await api.goals.list());
  }
  async function addGoalQuick() {
    const title = prompt("Goal title?");
    if (!title?.trim()) return;
    const tgt = Number(prompt("Weekly target?", "5")) || 5;
    await api.goals.upsert({
      title: title.trim(),
      target: tgt,
      progress: 0,
      sort: 99,
    });
    setGoals(await api.goals.list());
  }
  async function resetGoalsWeek() {
    if (!confirm("Reset all goal progress to 0 for a new week?")) return;
    await api.goals.resetWeek();
    setGoals(await api.goals.list());
  }

  async function runPlan() {
    setPlanCard((p) => ({ ...p, loading: true, error: null }));
    if (planCard.model) await api.settings.set("ollama.model", planCard.model);
    const energyCap =
      checkin?.energy == null
        ? 90
        : Math.max(30, Math.round((checkin.energy / 10) * 120));
    const res = await api.ollama.plan({
      tasks,
      checkin,
      energyCap,
      dayOrder,
      classes,
      model: planCard.model,
    });
    if (!res?.ok) {
      setPlanCard((p) => ({
        ...p,
        loading: false,
        error: res?.error || "Ollama error",
      }));
      return;
    }
    setPlanCard((p) => ({ ...p, loading: false, plan: res, error: null }));
    await api.settings.set(
      "apex.plan.today",
      JSON.stringify({
        plan: res.plan,
        summary: res.summary,
        date: new Date().toISOString().slice(0, 10),
      }),
    );
  }

  async function clearPlan() {
    await api.settings.set("apex.plan.today", "");
    setPlanCard((p) => ({ ...p, plan: null, error: null }));
  }

  async function runBurnoutCheck() {
    setBurnoutLoading(true);
    try {
      const iso = new Date().toISOString().slice(0, 10);
      const [completed, timeTotals, open, plannedRaw] = await Promise.all([
        api.tasks.completedOn(iso),
        api.activity.todayTotals(),
        api.tasks.list({ completed: false }),
        api.settings.get("apex.plan.today"),
      ]);
      const plan = plannedRaw ? tryParse(plannedRaw) : null;
      const resp = await api.ollama.burnoutCheck({
        checkin,
        plan,
        completedToday: completed,
        timeTotals,
        openTasks: open,
        classes,
        model: planCard.model,
      });
      if (resp?.ok) setBurnoutReport(resp);
      else
        setToast({
          kind: "error",
          title: "Burnout check failed",
          msg: resp?.error || "Is Ollama running?",
        });
    } finally {
      setBurnoutLoading(false);
      setTimeout(() => setToast(null), 4000);
    }
  }

  // ── Derived
  const risk = burnoutReport?.risk_score;
  const riskClass =
    typeof risk === "number"
      ? risk >= 7
        ? "high"
        : risk >= 4
          ? "mid"
          : "low"
      : "low";
  const energyMsg = energyMessage(checkin);
  const doneToday = tasks.filter((t) => t.completed).length;

  const weekTotals = useMemo(() => {
    const acc = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));
    for (const d of trend || [])
      for (const k of CATEGORY_KEYS) acc[k] += d[k] || 0;
    acc.total = CATEGORY_KEYS.reduce((s, k) => s + acc[k], 0);
    return acc;
  }, [trend]);

  const cpHasAny = !!(
    selfCp &&
    (selfCp.leetcode || selfCp.codeforces || selfCp.codechef)
  );

  // Build a markdown brief of today — classes, open tasks, weekly goals, streak.
  // Useful to paste into a standup chat, a journal, or a second-brain app.
  function buildTodayBrief() {
    const dateLabel = new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const out = [];
    out.push(`# Brief · ${dateLabel}`);
    const subParts = [];
    if (dayOrder) subParts.push(`Day order ${dayOrder}`);
    else subParts.push("weekend");
    if (streak?.streak) subParts.push(`${streak.streak}-day streak`);
    if (typeof risk === "number") subParts.push(`burnout ${risk}/10`);
    out.push(subParts.join(" · "));
    out.push("");

    if (Array.isArray(classes) && classes.length) {
      out.push("## Classes");
      for (const c of classes) {
        const time =
          c.start_time && c.end_time
            ? `${c.start_time}–${c.end_time}`
            : c.start_time || "";
        const room = c.room ? ` · ${c.room}` : "";
        const subj = c.subject || c.code || "Class";
        out.push(`- ${time ? time + " " : ""}${subj}${room}`);
      }
      out.push("");
    }

    const openTasks = (tasks || []).filter((t) => !t.completed);
    const doneTasks = (tasks || []).filter((t) => t.completed);
    if (tasks?.length) {
      out.push(`## Tasks (${doneTasks.length}/${tasks.length} done)`);
      for (const t of openTasks.slice(0, 12)) {
        const p = t.priority ? `P${t.priority} ` : "";
        out.push(`- [ ] ${p}${t.title}`);
      }
      for (const t of doneTasks.slice(0, 8)) {
        out.push(`- [x] ${t.title}`);
      }
      out.push("");
    }

    if (Array.isArray(goals) && goals.length) {
      out.push("## Weekly goals");
      for (const g of goals) {
        const done = (g.current ?? 0) >= (g.target ?? 0) && (g.target ?? 0) > 0;
        out.push(
          `- ${done ? "[x]" : "[ ]"} ${g.title} · ${g.current ?? 0}/${g.target ?? 0}`,
        );
      }
      out.push("");
    }

    return out.join("\n").trim() + "\n";
  }

  async function copyTodayBrief() {
    const text = buildTodayBrief();
    try {
      await navigator.clipboard.writeText(text);
      setToast({
        kind: "info",
        title: "Brief copied",
        msg: "Paste it anywhere — standup, journal, second-brain.",
      });
      setTimeout(() => setToast(null), 3000);
    } catch {
      setToast({
        kind: "warn",
        title: "Copy failed",
        msg: "Select & copy from the box below instead.",
      });
      setTimeout(() => setToast(null), 4000);
    }
  }

  return (
    <>
      {/* Header */}
      <div
        className="row between"
        style={{ alignItems: "flex-start", marginBottom: 8 }}
      >
        <div>
          <h1 className="page-title">Today</h1>
          <p className="page-sub">
            {new Date().toLocaleDateString(undefined, {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
            {dayOrder ? ` · Day order ${dayOrder}` : " · weekend"}
            {" · "}
            {streak.streak}-day streak
          </p>
        </div>
        <div className="dashboard-actions">
          <button className="primary small" onClick={() => setShowAskApex(true)}>
            Ask Apex
          </button>
          <InsightsChip
            ollamaOk={planCard.ollamaOk}
            model={planCard.model}
            tasks={tasks}
            risk={risk}
            riskClass={riskClass}
            report={burnoutReport}
            burnoutLoading={burnoutLoading}
            onRerunBurnout={runBurnoutCheck}
            onAddTask={async (rec) => {
              await api.tasks.create({
                title: rec.text || "recommendation",
                description: rec.reason ? rec.reason : "",
                category: rec.kind === "cp" ? "DSA"
                  : rec.kind === "class-prep" ? "Academics"
                  : rec.kind === "break" || rec.kind === "health" ? "Health"
                  : "Personal",
                priority: 3,
                estimated_minutes: rec.estimated_minutes || 15,
                tags: ["apex"],
                links: [],
              });
              setToast({
                kind: "success",
                title: "Added to tasks",
                msg: rec.text || rec.kind,
              });
              setTimeout(() => setToast(null), 3000);
            }}
            onStartTimer={async (rec) => {
              const isCp = rec.kind === "cp";
              const isBreak = rec.kind === "break" || rec.kind === "health";
              await api.timer.start({
                kind: isCp ? "study" : isBreak ? "break" : "task",
                category: isBreak ? "neutral" : "productive",
                title: rec.text || rec.kind || "recommendation",
                description: rec.reason || null,
                task_id: rec.taskId || null,
                planned_minutes: rec.estimated_minutes || 25,
              });
              setToast({
                kind: "success",
                title: "Timer started",
                msg: rec.text || rec.kind,
              });
              setTimeout(() => setToast(null), 2500);
            }}
            onAddBurnoutSuggestion={async (s) => {
              await api.tasks.create({
                title: s.text || s.type || "burnout suggestion",
                description: s.link ? "Link: " + s.link : "",
                category:
                  s.type === "exercise" ? "Health"
                  : s.type === "break" ? "Leisure"
                  : "Personal",
                priority: 3,
                estimated_minutes: s.minutes || 15,
                tags: ["burnout"],
                links: s.link ? [s.link] : [],
              });
              setToast({
                kind: "success",
                title: "Added to tasks",
                msg: s.text || s.type,
              });
              setTimeout(() => setToast(null), 3000);
            }}
            onAddTomorrowTask={async (text) => {
              const tomorrow = new Date();
              tomorrow.setDate(tomorrow.getDate() + 1);
              tomorrow.setHours(9, 0, 0, 0);
              await api.tasks.create({
                title: text || "tomorrow",
                description: "From evening review",
                category: "Personal",
                priority: 3,
                deadline: tomorrow.toISOString(),
                tags: ["apex", "evening"],
                links: [],
              });
              setToast({
                kind: "success",
                title: "Saved for tomorrow",
                msg: text,
              });
              setTimeout(() => setToast(null), 3000);
            }}
          />
          <OverflowMenu
            items={[
              cpHasAny && {
                label: "My CP snapshot",
                onClick: () => setShowCp(true),
              },
              {
                label: "Copy today's brief",
                onClick: copyTodayBrief,
              },
              {
                label: "Settings",
                onClick: () => go("settings"),
              },
            ].filter(Boolean)}
          />
        </div>
      </div>

      {/* Live timer — universal "what am I doing now" with countdown,
          extend, and cancel/stop. Takes over the now-strip slot. The
          desktop tracker still runs underneath (its current foreground
          app shows up in Top apps), but the live timer is the explicit
          time the user has agreed to spend on something. */}
      <LiveTimer tasks={tasks} onChanged={() => refreshActivity()} />
      {trackerStatus && !trackerStatus.running && (
        <div className="now-strip idle" style={{ marginTop: 8 }}>
          <span className="dot" />
          <div style={{ flex: 1 }}>
            <small className="muted">
              Passive tracker is off — turn it on in Settings → Activity to
              also auto-track foreground apps.
            </small>
          </div>
          <button
            className="ghost small"
            onClick={async () => {
              await api.tracker.start();
              setTrackerStatus(await api.tracker.status());
            }}
          >
            Start
          </button>
        </div>
      )}

      {/* Top row: Today (Plan + Tasks tabs) | Today's classes | Weekly goals.
          Plan and Tasks are merged into one card because they're answers to
          the same question — what am I doing today? */}
      <div className="grid-3 dashboard-top-row" style={{ marginTop: 14, marginBottom: 16 }}>
        <TodayCard
          tasks={tasks}
          doneToday={doneToday}
          planCard={planCard}
          runPlan={runPlan}
          clearPlan={clearPlan}
          refreshOllama={refreshOllama}
          toggleTask={toggleTask}
          go={go}
          setToast={setToast}
        />

        <div className="card">
          <div className="row between">
            <div className="card-title">Today's classes</div>
            <span className="pill">{classes.length}</span>
          </div>
          {classes.length === 0 && (
            <div className="muted">
              {dayOrder ? "Nothing scheduled." : "Weekend — no classes."}
            </div>
          )}
          {classes.map((c) => {
            const [sh, sm] = (c.start_time || "0:0").split(":").map(Number);
            const [eh, em] = (c.end_time || "0:0").split(":").map(Number);
            const start = (sh || 0) * 60 + (sm || 0);
            const end = (eh || 0) * 60 + (em || 0);
            const d = new Date();
            const nowM = d.getHours() * 60 + d.getMinutes();
            const isCurrent = start <= nowM && nowM < end;
            const isPast = end <= nowM;
            const classIdx = classes.findIndex((x) => x.id === c.id);
            const isNext =
              !isCurrent &&
              !isPast &&
              // the first future class in the list
              classes
                .slice(0, classIdx)
                .every((x) => {
                  const [xh, xm] = (x.end_time || "0:0").split(":").map(Number);
                  return (xh || 0) * 60 + (xm || 0) <= nowM;
                });
            const overrideStatus = c.override_status || null;
            return (
              <div
                key={c.id}
                className={
                  "class-row" +
                  (isCurrent ? " now" : "") +
                  (isPast ? " past" : "") +
                  (isNext ? " next" : "") +
                  (overrideStatus ? " overridden" : "")
                }
                onClick={() => setEditingClass(c)}
                title="Click to edit / cancel for today"
                style={{
                  display: "flex",
                  gap: 10,
                  margin: "8px 0",
                  alignItems: "center",
                  opacity: isPast ? 0.55 : 1,
                  padding: isCurrent ? "6px 8px" : "4px 6px",
                  borderRadius: 8,
                  background: isCurrent
                    ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                    : undefined,
                  cursor: "pointer",
                  transition: "background 120ms ease",
                }}
              >
                <span className="pill mono" style={{ minWidth: 92, textAlign: "center" }}>
                  {c.start_time}–{c.end_time}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    className="title"
                    style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
                  >
                    <span>{c.subject}</span>
                    {isCurrent && <span className="pill teal">now</span>}
                    {isNext && <span className="pill amber">next</span>}
                    {isPast && <small className="muted">done</small>}
                    {overrideStatus === "moved" && (
                      <span className="pill amber" title="Moved for today">moved</span>
                    )}
                    {overrideStatus === "replaced" && (
                      <span className="pill amber" title="Replaced for today">replaced</span>
                    )}
                    {overrideStatus === "added" && (
                      <span className="pill teal" title="One-off extra class">extra</span>
                    )}
                  </div>
                  <div className="sub muted">
                    {c.code ?? ""} {c.room ? `· ${c.room}` : ""}{" "}
                    {c.faculty ? `· ${c.faculty}` : ""}
                  </div>
                </div>
                {c.kind === "lab" && <span className="pill rose">lab</span>}
                {c.kind === "tutorial" && <span className="pill amber">tut</span>}
                <button
                  type="button"
                  className="ghost xsmall class-row-edit"
                  onClick={(e) => { e.stopPropagation(); setEditingClass(c); }}
                  title="Edit / cancel for today"
                  aria-label="Edit class"
                >
                  ✎
                </button>
              </div>
            );
          })}
          <hr className="soft" />
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button className="ghost" onClick={() => go("upcoming")}>
              Open Upcoming →
            </button>
            <button
              className="ghost small"
              onClick={() => setAddingExtra(true)}
              title="Add a one-off class for today"
            >
              + Extra class
            </button>
          </div>
        </div>

        {/* Weekly goals — third column of the top row. */}
        <div className="card">
          <div className="row between">
            <div className="card-title">Weekly goals</div>
            <span className="pill">
              {goals.filter((g) => (g.progress || 0) >= g.target).length} /{" "}
              {goals.length} hit
            </span>
          </div>
          {goals.length === 0 && (
            <div className="muted goal-empty">
              No goals yet — set some in <a href="#" onClick={(e) => { e.preventDefault(); go("settings"); }}>Settings → Goals</a>.
            </div>
          )}
          <div className="goal-list">
            {goals.map((g) => {
              const pct = Math.min(
                100,
                Math.round(((g.progress ?? 0) / (g.target || 1)) * 100),
              );
              const hit = (g.progress ?? 0) >= g.target;
              return (
                <div key={g.id} className={"goal-row" + (hit ? " hit" : "")}>
                  <div className="goal-row-head">
                    <strong className="goal-row-title">{g.title}</strong>
                    <span className="goal-row-count">
                      {g.progress ?? 0}<span className="muted">/{g.target}</span>
                    </span>
                  </div>
                  <div className="goal-row-track">
                    <div className="bar goal-bar">
                      <div className="bar-fill" style={{ width: `${pct}%` }} />
                    </div>
                    <button
                      className="ghost xsmall goal-bump"
                      onClick={() => bumpGoal(g)}
                      title="Mark one more"
                      disabled={hit}
                    >
                      +1
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <hr className="soft" />
          <GoalQuickAdd onAdd={async (g) => {
            await api.goals.upsert(g);
            await refreshActivity();
            const fresh = await api.goals.list();
            setGoals(fresh || []);
          }} />
          <div
            className="row between"
            style={{ alignItems: "center", marginTop: 8 }}
          >
            <button className="ghost small" onClick={() => go("settings")}>
              Edit goals
            </button>
            <small className="muted">
              {streak.weekDone} / 7 active days
            </small>
          </div>
        </div>
      </div>

      {/* Reflect row — private journal. The focus timer was retired in
          favour of LiveTimer at the top, which subsumes its functionality
          (task selection + auto-log + AI awareness). */}
      <DayNoteCard model={planCard.model} ollamaOk={planCard.ollamaOk} />

      {/* Unified Activity section — stats, trail, top apps, tracker controls */}
      <ActivitySection
        trend={trend}
        weekTotals={weekTotals}
        hiddenCats={hiddenCats}
        setHiddenCats={setHiddenCats}
        topApps={topApps}
        topAppsDate={topAppsDate}
        setTopAppsDate={setTopAppsDate}
        trackerStatus={trackerStatus}
        onToggleTracker={async () => {
          try {
            if (trackerStatus?.running) await api.tracker.stop();
            else await api.tracker.start();
          } finally {
            setTrackerStatus(
              await api.tracker.status().catch(() => trackerStatus),
            );
            refreshActivity();
          }
        }}
        onSyncMobile={async () => {
          const r = await api.wellbeing?.syncNow?.();
          setToast({
            kind: r?.ok ? "success" : "error",
            title: r?.ok ? "Mobile synced" : "Mobile sync failed",
            msg: r?.ok
              ? `${r.count} apps, ${r.total_minutes} min · device ${r.device}`
              : r?.error || "No ADB device found",
          });
          setTimeout(() => setToast(null), 5000);
          refreshActivity();
        }}
        onSyncBattery={async () => {
          const r = await api.battery?.syncToActivity?.(14);
          setToast({
            kind: r?.ok ? "success" : "error",
            title: r?.ok ? "Desktop usage synced" : "Battery sync failed",
            msg: r?.ok
              ? `${r.added} day${r.added === 1 ? "" : "s"} imported from battery report.`
              : r?.error || "powercfg failed (Windows only)",
          });
          setTimeout(() => setToast(null), 5000);
          refreshActivity();
        }}
        onOpenSettings={() => go("settings")}
      />

      {showAskApex && (
        <AskApexDrawer
          model={planCard.model}
          ollamaOk={planCard.ollamaOk}
          tasks={tasks}
          classes={classes}
          dayOrder={dayOrder}
          trackerStatus={trackerStatus}
          todayTotals={todayTotals}
          trend={trend}
          topApps={topApps}
          checkin={checkin}
          burnoutReport={burnoutReport}
          onClose={() => setShowAskApex(false)}
        />
      )}

      {showCp && selfCp && (
        <CpSelfModal
          selfCp={selfCp}
          onClose={() => setShowCp(false)}
          onRefresh={async () => {
            const r = await api.cp.self();
            if (r?.results)
              setSelfCp({ ...r.results, cached_at: new Date().toISOString() });
          }}
        />
      )}

      {toast && (
        <div className={`toast toast-${toast.kind}`}>
          <div style={{ flex: 1 }}>
            {toast.title && <div className="title">{toast.title}</div>}
            <div className="sub">{toast.msg}</div>
          </div>
          <button className="ghost xsmall" onClick={() => setToast(null)}>
            ✕
          </button>
        </div>
      )}

      {editingClass && (
        <ClassEditModal
          classRow={editingClass}
          dateIso={new Date().toISOString().slice(0, 10)}
          onClose={() => setEditingClass(null)}
          onSaved={async () => {
            setEditingClass(null);
            await refresh();
          }}
        />
      )}
      {addingExtra && (
        <ClassEditModal
          classRow={null}
          dateIso={new Date().toISOString().slice(0, 10)}
          onClose={() => setAddingExtra(false)}
          onSaved={async () => {
            setAddingExtra(false);
            await refresh();
          }}
        />
      )}
    </>
  );
}

// ─── ClassEditModal ──────────────────────────────────────────────────────
// One-day-only edits to the timetable. Open from a class row to:
//   • cancel the class (status='cancelled')
//   • move it (different time)
//   • replace it (different subject + time)
//   • restore to default (clear override)
// Or open in "add extra class" mode (no classRow passed) to insert a
// one-off entry into today's schedule.
function ClassEditModal({ classRow, dateIso, onClose, onSaved }) {
  const isExtra = !classRow;
  const isExistingExtra = classRow?.override_status === "added";
  const [mode, setMode] = useState(
    isExtra ? "add" : classRow.override_status || "edit",
  );
  const [form, setForm] = useState({
    subject: classRow?.subject || "",
    code: classRow?.code || "",
    start_time: classRow?.start_time || "09:00",
    end_time: classRow?.end_time || "10:00",
    room: classRow?.room || "",
    faculty: classRow?.faculty || "",
    kind: classRow?.kind || "lecture",
    note: classRow?.note || "",
  });

  async function save() {
    if (isExtra) {
      await api.schedule.addExtraClass(dateIso, form);
      onSaved();
      return;
    }
    if (mode === "cancelled") {
      await api.schedule.setOverride(dateIso, classRow.id, {
        status: "cancelled",
      });
      onSaved();
      return;
    }
    // moved or replaced — push the patch through. We only send fields the
    // user changed so blanks are interpreted as "keep original".
    const patch = { status: mode === "replaced" ? "replaced" : "moved" };
    if (form.subject && form.subject !== classRow.subject) patch.subject = form.subject;
    if (form.code && form.code !== classRow.code) patch.code = form.code;
    if (form.start_time && form.start_time !== classRow.start_time)
      patch.start_time = form.start_time;
    if (form.end_time && form.end_time !== classRow.end_time)
      patch.end_time = form.end_time;
    if (form.room && form.room !== classRow.room) patch.room = form.room;
    if (form.faculty && form.faculty !== classRow.faculty) patch.faculty = form.faculty;
    if (form.kind && form.kind !== classRow.kind) patch.kind = form.kind;
    if (form.note && form.note !== classRow.note) patch.note = form.note;
    await api.schedule.setOverride(dateIso, classRow.id, patch);
    onSaved();
  }

  async function clearOverride() {
    if (isExistingExtra && classRow?.override_id) {
      await api.schedule.deleteOverrideById(classRow.override_id);
    } else if (classRow?.id) {
      await api.schedule.clearOverride(dateIso, classRow.id);
    }
    onSaved();
  }

  const title = isExtra
    ? "Add a one-off class"
    : `${classRow.subject} · just for today`;

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" style={{ maxWidth: 540 }}>
        <div className="row between" style={{ alignItems: "center" }}>
          <div>
            <h3 style={{ margin: 0 }}>{title}</h3>
            <small className="muted">
              {isExtra
                ? "This class will only show up on " + dateIso + "."
                : "Changes apply only to " +
                  dateIso +
                  ". Default schedule isn't affected."}
            </small>
          </div>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        {!isExtra && (
          <div
            className="row"
            style={{ gap: 6, flexWrap: "wrap", marginTop: 12 }}
          >
            <button
              type="button"
              className={"chip" + (mode === "moved" ? " active" : "")}
              onClick={() => setMode("moved")}
            >
              Move
            </button>
            <button
              type="button"
              className={"chip" + (mode === "replaced" ? " active" : "")}
              onClick={() => setMode("replaced")}
            >
              Replace
            </button>
            <button
              type="button"
              className={"chip" + (mode === "cancelled" ? " active" : "")}
              onClick={() => setMode("cancelled")}
              style={{
                borderColor: mode === "cancelled" ? "#ff8577" : undefined,
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {(isExtra || mode === "moved" || mode === "replaced") && (
          <>
            <div className="grid-2" style={{ marginTop: 10 }}>
              <div className="form-row">
                <label>Subject</label>
                <input
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  placeholder="e.g. PQT"
                />
              </div>
              <div className="form-row">
                <label>Course code</label>
                <input
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="optional"
                />
              </div>
            </div>
            <div className="grid-2">
              <div className="form-row">
                <label>Start</label>
                <input
                  type="time"
                  value={form.start_time}
                  onChange={(e) =>
                    setForm({ ...form, start_time: e.target.value })
                  }
                />
              </div>
              <div className="form-row">
                <label>End</label>
                <input
                  type="time"
                  value={form.end_time}
                  onChange={(e) =>
                    setForm({ ...form, end_time: e.target.value })
                  }
                />
              </div>
            </div>
            <div className="grid-2">
              <div className="form-row">
                <label>Room</label>
                <input
                  value={form.room}
                  onChange={(e) => setForm({ ...form, room: e.target.value })}
                  placeholder="optional"
                />
              </div>
              <div className="form-row">
                <label>Kind</label>
                <select
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                >
                  <option value="lecture">lecture</option>
                  <option value="lab">lab</option>
                  <option value="tutorial">tutorial</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <label>Note</label>
              <input
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="e.g. moved from 2pm — heard from group chat"
              />
            </div>
          </>
        )}

        {!isExtra && mode === "cancelled" && (
          <div
            className="muted"
            style={{
              marginTop: 12,
              padding: 12,
              border: "1px dashed var(--border)",
              borderRadius: 8,
            }}
          >
            Hide this class from today's schedule. The default timetable
            isn't touched — clear the override to bring it back.
          </div>
        )}

        <div
          className="row"
          style={{ marginTop: 16, justifyContent: "space-between", gap: 8 }}
        >
          <div>
            {classRow?.override_status && (
              <button
                className="ghost"
                onClick={clearOverride}
                title="Clear today's override and use the default schedule"
              >
                Reset to default
              </button>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button onClick={onClose}>Close</button>
            <button
              className="primary"
              onClick={save}
              disabled={
                (isExtra && !form.subject.trim()) ||
                (mode === "moved" &&
                  form.start_time === classRow?.start_time &&
                  form.end_time === classRow?.end_time)
              }
            >
              {isExtra
                ? "Add class"
                : mode === "cancelled"
                  ? "Cancel for today"
                  : "Save for today"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Activity section (trail + top apps + tracker controls) ───────────────
// One full-width card. Stats strip → trail | top apps → tracker row.
// Desktop + mobile data unify here; a source toggle filters the top-apps list.
function ActivitySection({
  trend,
  weekTotals,
  hiddenCats,
  setHiddenCats,
  topApps,
  topAppsDate,
  setTopAppsDate,
  trackerStatus,
  onToggleTracker,
  onSyncMobile,
  onSyncBattery,
  onOpenSettings,
}) {
  const [hover, setHover] = useState(null);
  const [source, setSource] = useState("all"); // all | desktop | mobile
  const today = new Date().toISOString().slice(0, 10);
  const isToday = topAppsDate === today;

  function toggleCat(k) {
    const n = new Set(hiddenCats);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setHiddenCats(n);
  }

  // Sum of all *visible* categories on a given trend row
  function daySum(d) {
    if (!d) return 0;
    return CATEGORY_KEYS.filter((k) => !hiddenCats.has(k)).reduce(
      (s, k) => s + (d[k] || 0),
      0,
    );
  }

  const visibleWeekTotal = CATEGORY_KEYS.filter(
    (k) => !hiddenCats.has(k),
  ).reduce((s, k) => s + (weekTotals[k] || 0), 0);

  // Today's row derived from trend (source of truth — matches the trail)
  const todayRow = (trend || []).find((d) => d.date === today) || null;
  const todayTotalMin = daySum(todayRow);

  // Filter top apps by source via the `sources` field returned by SQL.
  // "Desktop" is a union of the desktop tracker AND the Windows battery report,
  // since both represent desktop screen time. The "Battery" chip remains for
  // when you specifically want the battery-report breakdown on its own.
  const filteredApps = useMemo(() => {
    if (!topApps) return [];
    if (source === "all") return topApps;
    const wanted = source === "desktop" ? ["desktop", "battery"] : [source];
    return topApps.filter((a) => {
      const s = (a.sources || a.source || "").toString();
      return wanted.some((w) => s.includes(w));
    });
  }, [topApps, source]);

  const appTotal = filteredApps.reduce((s, a) => s + (a.minutes || 0), 0);

  // Category breakdown over the (filtered) top apps — used for the at-a-glance
  // composition strip. Order matches CATEGORY_KEYS so colors stay consistent.
  const catBreakdown = useMemo(() => {
    const map = new Map();
    for (const a of filteredApps) {
      const k = a.category || "other";
      map.set(k, (map.get(k) || 0) + (a.minutes || 0));
    }
    const total = appTotal || 1;
    return [...map.entries()]
      .map(([k, m]) => ({ cat: k, minutes: m, pct: Math.round((m / total) * 100) }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [filteredApps, appTotal]);

  // Yesterday's total for the same source filter — used to show a delta.
  const yesterdayIso = useMemo(() => {
    const d = new Date(topAppsDate + "T00:00:00");
    if (Number.isNaN(+d)) return null;
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }, [topAppsDate]);
  const ydayRow = (trend || []).find((d) => d.date === yesterdayIso);
  const ydayTotal = ydayRow ? daySum(ydayRow) : null;
  const dayDelta = (ydayTotal != null && appTotal != null)
    ? appTotal - ydayTotal
    : null;

  // Breakdown for the selected date: desktop vs mobile minutes (from topApps).
  // Desktop includes the battery-report fallback so the stat pill is accurate
  // even on days when the foreground tracker wasn't running.
  const selDesktopMin =
    sumBySource(topApps, "desktop") + sumBySource(topApps, "battery");
  const selMobileMin = sumBySource(topApps, "mobile");
  const selBatteryMin = sumBySource(topApps, "battery");
  // Does the DB have any battery rows visible in the current top-apps slice?
  // Used to distinguish "never synced" vs "no battery data for this day".
  const hasAnyBatteryInTopApps = selBatteryMin > 0;

  // Top category on the selected date (for the last stat pill)
  const topCatRow = (trend || []).find((d) => d.date === topAppsDate);
  const topCatEntry = topCatRow
    ? CATEGORY_KEYS.filter((k) => !hiddenCats.has(k))
        .map((k) => [k, topCatRow[k] || 0])
        .sort((a, b) => b[1] - a[1])[0]
    : null;

  return (
    <div className="card activity-section" style={{ marginBottom: 16 }}>
      {/* Header */}
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <div>
          <div className="card-title" style={{ margin: 0 }}>
            Activity{" "}
            <small className="muted" style={{ fontWeight: 400 }}>
              · desktop + mobile
            </small>
          </div>
          <small className="muted">
            {isToday
              ? `Today · ${new Date().toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}`
              : `Viewing ${topAppsDate}`}
          </small>
        </div>
        <div
          className="row"
          style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}
        >
          {trackerStatus?.running ? (
            <span className="pill teal" title="Desktop tracker is running">
              <span className="pulse" style={{ marginRight: 6 }} />
              tracking
            </span>
          ) : (
            <span className="pill gray" title="Desktop tracker is off">
              ○ idle
            </span>
          )}
          <button className="ghost small" onClick={onToggleTracker}>
            {trackerStatus?.running ? "Stop" : "Start"}
          </button>
          <button
            className="ghost small"
            onClick={onSyncMobile}
            title="Pull today's mobile usage via ADB"
          >
            Sync mobile
          </button>
          {onSyncBattery && (
            <button
              className="ghost small"
              onClick={onSyncBattery}
              title="Import last 14 days of desktop usage from Windows battery report"
            >
              Sync desktop
            </button>
          )}
          <button className="ghost small" onClick={onOpenSettings}>
            Settings
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="stats-strip">
        <StatPill
          cat="productive"
          label="Today"
          value={fmtMinutes(todayTotalMin)}
          sub={
            todayTotalMin
              ? topCatEntry
                ? `mostly ${topCatEntry[0]}`
                : ""
              : "nothing tracked yet"
          }
        />
        <StatPill
          cat="other"
          label="Week"
          value={fmtMinutes(visibleWeekTotal)}
          sub={`avg ${fmtMinutes(Math.round(visibleWeekTotal / 7))} / day`}
        />
        <StatPill
          cat="neutral"
          label="Desktop"
          value={fmtMinutes(selDesktopMin)}
          sub={isToday ? "today" : topAppsDate}
        />
        <StatPill
          cat="mobile"
          label="Mobile"
          value={fmtMinutes(selMobileMin)}
          sub={isToday ? "today" : topAppsDate}
        />
      </div>

      {/* Last session fallback when tracker is off */}
      {!trackerStatus?.running && trackerStatus?.last && (
        <div className="last-session muted">
          Last desktop session: <strong>{trackerStatus.last.app}</strong> ·{" "}
          {trackerStatus.last.category} · {trackerStatus.last.minutes || 0} min
          · wrapped{" "}
          {trackerStatus.last.ended_at
            ? relativeAgo(trackerStatus.last.ended_at)
            : "recently"}
        </div>
      )}

      {/* Main two-pane: trail (left) + top apps (right) */}
      <div className="activity-panes">
        {/* Trail pane */}
        <div className="pane trail-pane">
          <div className="row between" style={{ marginBottom: 6 }}>
            <div className="section-label" style={{ marginTop: 0 }}>
              7-day trail
            </div>
            <small className="muted">
              {fmtMinutes(visibleWeekTotal)} · click a day for apps
            </small>
          </div>
          <div className="trail" style={{ position: "relative" }}>
            {(trend || []).map((d) => {
              const total = daySum(d);
              const h = (v) =>
                total ? Math.max(1, Math.round((v / total) * 100)) : 0;
              const isSel = d.date === topAppsDate;
              const weekday = weekdayShort(d.date);
              return (
                <div
                  key={d.date}
                  className={"trail-day" + (isSel ? " sel" : "")}
                  title={d.date}
                  onClick={() => setTopAppsDate(d.date)}
                  onMouseEnter={() => setHover({ date: d.date, day: d })}
                  onMouseLeave={() => setHover(null)}
                >
                  <div className="trail-day-stack">
                    {CATEGORY_KEYS.map((k) =>
                      hiddenCats.has(k) ? null : (
                        <div
                          key={k}
                          className={`leg ${k}`}
                          style={{ height: h(d[k] || 0) + "%" }}
                        />
                      ),
                    )}
                  </div>
                  <small className="muted day">
                    <span className="wk">{weekday}</span>
                    <span className="dt">{d.date.slice(8)}</span>
                  </small>
                </div>
              );
            })}
            {(!trend || trend.length === 0) && (
              <small className="muted">
                No activity yet. Turn tracker on in Settings.
              </small>
            )}
            {hover && (
              <div className="trail-tooltip">
                <div className="tt-head">{hover.date}</div>
                {CATEGORY_KEYS.map(
                  (k) =>
                    (hover.day[k] || 0) > 0 &&
                    !hiddenCats.has(k) && (
                      <div key={k} className="tt-row">
                        <span>
                          <span className={`sw cat-${k}`} />
                          {CATEGORY_LABELS[k]}
                        </span>
                        <small>{fmtMinutes(hover.day[k])}</small>
                      </div>
                    ),
                )}
                <div
                  className="tt-row"
                  style={{
                    borderTop: "1px solid var(--border)",
                    paddingTop: 4,
                    marginTop: 4,
                  }}
                >
                  <strong>total</strong>
                  <strong>{fmtMinutes(daySum(hover.day))}</strong>
                </div>
              </div>
            )}
          </div>
          <div className="chip-row" style={{ marginTop: 10, flexWrap: "wrap" }}>
            {CATEGORY_KEYS.map((k) => (
              <button
                key={k}
                className={
                  `chip legend-${k}` + (hiddenCats.has(k) ? " disabled" : "")
                }
                title={hiddenCats.has(k) ? "click to show" : "click to hide"}
                onClick={() => toggleCat(k)}
                type="button"
              >
                {CATEGORY_LABELS[k]} {fmtMinutesShort(weekTotals[k] || 0)}
              </button>
            ))}
          </div>
        </div>

        {/* Top apps pane */}
        <div className="pane apps-pane">
          <div className="row between" style={{ marginBottom: 6 }}>
            <div className="section-label" style={{ marginTop: 0 }}>
              Top apps · {isToday ? "today" : topAppsDate}
            </div>
            <small className="muted">
              {fmtMinutes(appTotal)}
              {dayDelta != null && Math.abs(dayDelta) >= 5 && (
                <span
                  style={{
                    marginLeft: 6,
                    color: dayDelta > 0 ? "var(--distraction, #E8806B)" : "var(--productive, #7FD99E)",
                    fontWeight: 500,
                  }}
                  title={`Yesterday: ${fmtMinutes(ydayTotal)}`}
                >
                  {dayDelta > 0 ? "↑" : "↓"} {fmtMinutes(Math.abs(dayDelta))}
                </span>
              )}
            </small>
          </div>

          {/* Live "currently on" banner — visible only when viewing today and
              the tracker is actively recording something. Updates roughly every
              15s via the tracker heartbeat. */}
          {isToday && trackerStatus?.running && trackerStatus.current?.app && (
            <div
              className={`live-now cat-${trackerStatus.current.category || "other"}`}
              title="Desktop tracker is live"
            >
              <span className="pulse-dot" />
              <span className="live-now-label">Now</span>
              <strong className="live-now-app">
                {prettyAppName(trackerStatus.current.app)}
              </strong>
              <span className="live-now-min">
                {trackerStatus.current.minutes || 0}m
              </span>
            </div>
          )}

          {/* Source toggle */}
          <div className="source-toggle chip-row" style={{ marginBottom: 8 }}>
            {[
              { key: "all", label: "All", title: "Every source combined" },
              {
                key: "desktop",
                label: "Desktop",
                title: "Foreground-window tracker + Windows battery report",
              },
              {
                key: "mobile",
                label: "Mobile",
                title: "ADB digital-wellbeing",
              },
              {
                key: "battery",
                label: "Battery",
                title: "Only rows from powercfg /batteryreport",
              },
            ].map((o) => (
              <button
                key={o.key}
                type="button"
                className={"chip" + (source === o.key ? " active" : "")}
                onClick={() => setSource(o.key)}
                title={o.title}
              >
                {o.label}
              </button>
            ))}
            {!isToday && (
              <button
                className="chip"
                type="button"
                onClick={() => setTopAppsDate(today)}
                title="back to today"
                style={{ marginLeft: "auto" }}
              >
                ← today
              </button>
            )}
          </div>

          {/* Category composition strip — productive / distraction / leisure /
              other at a glance. Hidden when there's nothing to show. */}
          {catBreakdown.length > 0 && appTotal > 0 && (
            <>
              <div className="cat-strip" title="App-time composition by category">
                {catBreakdown.map((c) => (
                  <div
                    key={c.cat}
                    className={`cat-strip-seg cat-${c.cat}`}
                    style={{ width: c.pct + "%" }}
                    title={`${c.cat} · ${fmtMinutes(c.minutes)} (${c.pct}%)`}
                  />
                ))}
              </div>
              <div className="cat-strip-legend">
                {catBreakdown.slice(0, 4).map((c) => (
                  <span key={c.cat} className="cat-strip-legend-item">
                    <i className={`cat-dot cat-${c.cat}`} />
                    <span className="muted">{c.cat}</span>
                    <strong>{c.pct}%</strong>
                  </span>
                ))}
              </div>
            </>
          )}

          {filteredApps.length === 0 ? (
            <div className="muted" style={{ padding: "10px 0" }}>
              {topApps.length === 0 ? (
                <>
                  Nothing tracked on this day.{" "}
                  {onSyncBattery && (
                    <button
                      className="ghost xsmall"
                      onClick={onSyncBattery}
                      style={{ marginLeft: 6 }}
                      title="Pull last 14 days from the Windows battery report"
                    >
                      Sync desktop
                    </button>
                  )}
                </>
              ) : source === "battery" ? (
                <>
                  No battery-report data for this day.
                  {onSyncBattery && (
                    <>
                      {" "}
                      <button
                        className="ghost xsmall"
                        onClick={onSyncBattery}
                        style={{ marginLeft: 6 }}
                        title="Re-run powercfg /batteryreport and import the last 14 days"
                      >
                        Sync desktop
                      </button>
                    </>
                  )}
                </>
              ) : source === "desktop" ? (
                "No desktop tracker data for this day. Start the tracker in Settings, or try Battery for longer history."
              ) : source === "mobile" ? (
                "No mobile data for this day. Sync ADB to pull digital wellbeing."
              ) : (
                `No ${source} data for this day.`
              )}
            </div>
          ) : (
            <div className="app-rows">
              {filteredApps.map((a) => (
                <AppRow
                  key={a.app}
                  app={a}
                  appTotal={appTotal}
                  source={source}
                  isToday={isToday}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── OverflowMenu ────────────────────────────────────────────────────────
// A 3-dot button that opens a small popover with secondary actions
// (My CP, Copy brief, Settings). Keeps the header header clean.
function OverflowMenu({ items }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  if (!items || items.length === 0) return null;
  return (
    <div className="overflow-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={"ghost small overflow-menu-btn" + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        title="More actions"
        aria-label="More actions"
      >
        ⋯
      </button>
      {open && (
        <div className="overflow-menu" role="menu">
          {items.map((it, i) => (
            <button
              key={i}
              type="button"
              className="overflow-menu-item"
              onClick={() => { setOpen(false); it.onClick?.(); }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── InsightsChip ────────────────────────────────────────────────────────
// One unified popover that replaces the previous burnout / What now? /
// Evening review chips. Three sections inside, each generated lazily on
// first open. Saves a ton of horizontal real-estate in the header.
function InsightsChip({
  ollamaOk,
  model,
  tasks,
  risk,
  riskClass,
  report,
  burnoutLoading,
  onRerunBurnout,
  onAddTask,
  onStartTimer,
  onAddBurnoutSuggestion,
  onAddTomorrowTask,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Recommendations
  const [recs, setRecs] = useState([]);
  const [recsLoading, setRecsLoading] = useState(false);
  const [recsErr, setRecsErr] = useState(null);

  // Evening review
  const [review, setReview] = useState(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewErr, setReviewErr] = useState(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Auto-fetch recommendations on first open (it's the most useful section).
  useEffect(() => {
    if (open && ollamaOk && recs.length === 0 && !recsLoading && !recsErr) {
      refreshRecs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function refreshRecs() {
    setRecsLoading(true); setRecsErr(null);
    try {
      const r = await api.ollama.recommend({ model });
      if (!r?.ok) { setRecsErr(r?.error || "Couldn't fetch."); setRecs([]); }
      else setRecs(Array.isArray(r.recommendations) ? r.recommendations : []);
    } catch (e) { setRecsErr(e?.message || "Failed."); }
    finally { setRecsLoading(false); }
  }
  async function refreshReview() {
    setReviewLoading(true); setReviewErr(null);
    try {
      const r = await api.ollama.eveningReview({ model });
      if (!r?.ok) { setReviewErr(r?.error || "Couldn't fetch."); setReview(null); }
      else setReview(r);
    } catch (e) { setReviewErr(e?.message || "Failed."); }
    finally { setReviewLoading(false); }
  }

  const summary = report?.summary || null;
  const flags = Array.isArray(report?.redFlags) ? report.redFlags : [];
  const suggestions = Array.isArray(report?.suggestions) ? report.suggestions : [];
  const hasBurnout = typeof risk === "number";
  const isEvening = new Date().getHours() >= 17;

  // Chip label adapts: shows the dominant signal (burnout score if high,
  // otherwise a generic "Apex insights").
  const chipLabel = hasBurnout && risk >= 6 ? `burnout ${risk}/10` : "Apex insights";

  return (
    <div className="insights-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={
          "insights-chip" +
          (open ? " open" : "") +
          (hasBurnout ? ` risk-${riskClass}` : "")
        }
        onClick={() => setOpen((v) => !v)}
        title={summary || "Apex insights — burnout, recommendations, evening review"}
      >
        <span className="insights-spark" aria-hidden>{isEvening ? "🌇" : "✨"}</span>
        <span className="insights-label">{chipLabel}</span>
        {hasBurnout && (
          <span className="insights-mini-dot" aria-hidden />
        )}
        <span className="insights-caret">▾</span>
      </button>
      {open && (
        <div className="insights-popover">

          {/* — Recommendations (auto-fetched on open) ─────────────── */}
          <div className="insights-section">
            <div className="insights-section-head">
              <strong>What now?</strong>
              <button
                className="ghost xsmall"
                onClick={(e) => { e.stopPropagation(); refreshRecs(); }}
                disabled={recsLoading}
                title="Re-roll"
              >↻</button>
            </div>
            {recsLoading && <div className="muted">Thinking…</div>}
            {recsErr && !recsLoading && <div className="error">{recsErr}</div>}
            {!recsLoading && recs.length === 0 && !recsErr && (
              <div className="muted small">Nothing to recommend yet.</div>
            )}
            {!recsLoading && recs.length > 0 && (
              <ul className="insights-rec-list">
                {recs.slice(0, 3).map((r, i) => (
                  <li key={i} className={"insights-rec rec-" + (r.kind || "other")}>
                    <div className="insights-rec-body">
                      <div className="insights-rec-text">{r.text}</div>
                      <div className="insights-rec-meta muted">
                        <span className={"pill rec-pill rec-" + (r.kind || "other")}>
                          {r.kind || "other"}
                        </span>
                        {r.estimated_minutes ? (
                          <span> · ~{r.estimated_minutes}m</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="insights-rec-actions">
                      <button
                        type="button" className="ghost xsmall"
                        onClick={() => onStartTimer?.(r)}
                        title="Start a timer"
                      >▶</button>
                      {!r.taskId && (
                        <button
                          type="button" className="ghost xsmall"
                          onClick={() => onAddTask?.(r)}
                          title="+ Task"
                        >+</button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* — Burnout (compact, click chip-pill to refresh) ─────────── */}
          <div className="insights-section">
            <div className="insights-section-head">
              <strong>Burnout</strong>
              <div className="row" style={{ gap: 6 }}>
                {hasBurnout && (
                  <span
                    className={`burnout-mini-pill risk-${riskClass}`}
                    title={summary || "current risk"}
                  >
                    {risk}/10
                  </span>
                )}
                <button
                  className="ghost xsmall"
                  disabled={burnoutLoading}
                  onClick={(e) => { e.stopPropagation(); onRerunBurnout?.(); }}
                  title={hasBurnout ? "Re-run check" : "Run a burnout check"}
                >
                  {hasBurnout ? "↻" : "Run"}
                </button>
              </div>
            </div>
            {hasBurnout ? (
              <>
                {summary && <p className="insights-text">{summary}</p>}
                {(flags.length > 0 || suggestions.length > 0) && (
                  <details className="insights-details">
                    <summary>Red flags &amp; suggestions</summary>
                    {flags.length > 0 && (
                      <ul className="insights-flag-list">
                        {flags.slice(0, 4).map((f, i) => (
                          <li key={i}>{typeof f === "string" ? f : f.text || JSON.stringify(f)}</li>
                        ))}
                      </ul>
                    )}
                    {suggestions.length > 0 && (
                      <ul className="insights-suggestion-list">
                        {suggestions.slice(0, 4).map((s, i) => (
                          <li key={i} className="insights-suggestion-row">
                            <span>{s.text || s.type || ""}</span>
                            <button
                              className="ghost xsmall"
                              onClick={() => onAddBurnoutSuggestion?.(s)}
                              title="+ Task"
                            >+</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                )}
              </>
            ) : (
              <div className="muted small">No reading yet.</div>
            )}
          </div>

          {/* — Evening review (lazy — button to generate) ────────────── */}
          <div className="insights-section">
            <div className="insights-section-head">
              <strong>Evening review</strong>
              <button
                className="ghost xsmall"
                onClick={(e) => { e.stopPropagation(); refreshReview(); }}
                disabled={reviewLoading || !ollamaOk}
                title="Generate"
              >{review?.ok ? "↻" : "Run"}</button>
            </div>
            {reviewLoading && <div className="muted">Reflecting…</div>}
            {reviewErr && !reviewLoading && <div className="error">{reviewErr}</div>}
            {!reviewLoading && !review && !reviewErr && (
              <div className="muted small">
                {isEvening
                  ? "Click Run to wrap up the day."
                  : "Wrap up your day later — generate any time."}
              </div>
            )}
            {review && review.ok && (
              <>
                {Array.isArray(review.wins) && review.wins.length > 0 && (
                  <div className="insights-mini-block">
                    <small className="muted">WINS</small>
                    <ul className="insights-flag-list">
                      {review.wins.slice(0, 2).map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  </div>
                )}
                {review.friction && (
                  <p className="insights-text"><small className="muted">FRICTION · </small>{review.friction}</p>
                )}
                {review.tomorrow && (
                  <div className="insights-tomorrow">
                    <p className="insights-text"><small className="muted">TRY TOMORROW · </small>{review.tomorrow}</p>
                    <button
                      type="button"
                      className="ghost xsmall"
                      onClick={() => onAddTomorrowTask?.(review.tomorrow)}
                    >+ Save as task</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── BurnoutChip ─────────────────────────────────────────────────────────
// Compact, useful burnout surface that lives in the header. When idle:
// "Burnout check" CTA. When a report exists: a coloured chip with the
// risk band; clicking it opens a popover with the AI summary, red flags,
// and one-click "Add suggestion to tasks".
function BurnoutChip({
  risk,
  riskClass,
  report,
  loading,
  onRerun,
  onSuggestionToTask,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (typeof risk !== "number") {
    return (
      <button
        className="ghost small"
        disabled={loading}
        onClick={onRerun}
        title="Run a quick burnout read on the day"
      >
        {loading ? "Analysing…" : "Burnout check"}
      </button>
    );
  }

  const summary = report?.summary || null;
  const flags = Array.isArray(report?.redFlags) ? report.redFlags : [];
  const suggestions = Array.isArray(report?.suggestions)
    ? report.suggestions
    : [];

  return (
    <div className="burnout-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`burnout-chip risk-${riskClass} clickable` + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        title={summary || "Open burnout details"}
      >
        <span className="dot" />
        <span className="burnout-chip-label">burnout {risk}/10</span>
        <span className="burnout-chip-caret">▾</span>
      </button>
      {open && (
        <div className="burnout-popover">
          <div className="burnout-popover-head">
            <div>
              <strong>Burnout read · {risk}/10</strong>
              {report?.generated_at && (
                <small className="muted" style={{ marginLeft: 8 }}>
                  {new Date(report.generated_at).toLocaleString()}
                </small>
              )}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button
                className="ghost xsmall"
                disabled={loading}
                onClick={(e) => { e.stopPropagation(); onRerun(); }}
                title="Re-run burnout check"
              >
                ↻
              </button>
              <button
                className="ghost xsmall"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>
          {summary && <p className="burnout-popover-summary">{summary}</p>}
          {flags.length > 0 && (
            <div className="burnout-popover-block">
              <div className="section-label">Red flags</div>
              <ul className="burnout-popover-list">
                {flags.slice(0, 4).map((f, i) => (
                  <li key={i}>{typeof f === "string" ? f : f.text || JSON.stringify(f)}</li>
                ))}
              </ul>
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="burnout-popover-block">
              <div className="section-label">Try this</div>
              <ul className="burnout-popover-list suggestions">
                {suggestions.slice(0, 4).map((s, i) => (
                  <li key={i} className="suggestion-line">
                    <span>{s.text || s.type || ""}</span>
                    <button
                      className="ghost xsmall"
                      onClick={() => onSuggestionToTask?.(s)}
                      title="Add as a task"
                    >
                      + Task
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!summary && flags.length === 0 && suggestions.length === 0 && (
            <div className="muted" style={{ marginTop: 8 }}>
              Re-run the check to refresh insights.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── GoalQuickAdd ────────────────────────────────────────────────────────
// Inline "Add a goal" form on the Weekly goals card so the user doesn't
// have to navigate to Settings to create a goal. Defaults to a target of
// 5 — the slider next to the input lets them tune it before adding.
function GoalQuickAdd({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState(5);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e?.preventDefault?.();
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    try {
      await onAdd({ title: t, target: Math.max(1, +target || 1), progress: 0 });
      setTitle("");
      setTarget(5);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="ghost small goal-quick-add-toggle"
        onClick={() => setOpen(true)}
        title="Add a new weekly goal"
      >
        + Add a goal
      </button>
    );
  }
  return (
    <form className="goal-quick-add" onSubmit={submit}>
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Read 4 hours"
        maxLength={64}
      />
      <input
        type="number"
        min={1}
        max={999}
        value={target}
        onChange={(e) => setTarget(+e.target.value || 1)}
        title="Weekly target"
        style={{ width: 64 }}
      />
      <button
        type="submit"
        className="primary small"
        disabled={busy || !title.trim()}
      >
        Add
      </button>
      <button
        type="button"
        className="ghost xsmall"
        onClick={() => { setOpen(false); setTitle(""); }}
        title="Cancel"
      >
        ✕
      </button>
    </form>
  );
}

// ─── EveningReviewChip ───────────────────────────────────────────────────
// Surfaces ollama.eveningReview as a header chip. Auto-styles brighter
// after 17:00 to suggest "wrap up your day". On open, fetches the review
// (wins / friction / one thing to try tomorrow) and lets the user save
// the tomorrow-suggestion as a real task with a 9 AM deadline.
function EveningReviewChip({ ollamaOk, model, onAddTomorrowTask }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState(null);
  const [err, setErr] = useState(null);
  const wrapRef = useRef(null);
  const isEvening = new Date().getHours() >= 17;

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function refresh() {
    if (!ollamaOk) {
      setErr("Ollama is offline.");
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const res = await api.ollama.eveningReview({ model });
      if (!res?.ok) {
        setErr(res?.error || "Couldn't generate review.");
        setReview(null);
      } else {
        setReview(res);
      }
    } catch (e) {
      setErr(e?.message || "Couldn't generate review.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && !review && !loading && !err) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="evening-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={
          "evening-chip" +
          (isEvening ? " late" : "") +
          (open ? " open" : "")
        }
        onClick={() => setOpen((v) => !v)}
        disabled={!ollamaOk}
        title={
          ollamaOk
            ? "Wrap-up: wins, friction, one thing to try tomorrow"
            : "Ollama is offline"
        }
      >
        <span className="evening-icon" aria-hidden>🌇</span>
        <span>Evening review</span>
        <span className="evening-caret">▾</span>
      </button>
      {open && (
        <div className="evening-popover">
          <div className="evening-popover-head">
            <strong>Today's review</strong>
            <div className="row" style={{ gap: 6 }}>
              <button
                className="ghost xsmall"
                onClick={(e) => { e.stopPropagation(); refresh(); }}
                disabled={loading}
                title="Re-roll the review"
              >
                ↻
              </button>
              <button
                className="ghost xsmall"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>
          {loading && <div className="muted">Reflecting…</div>}
          {err && !loading && <div className="error">{err}</div>}
          {!loading && review && review.ok && (
            <>
              {Array.isArray(review.wins) && review.wins.length > 0 && (
                <div className="evening-block">
                  <div className="section-label">Wins</div>
                  <ul className="evening-list">
                    {review.wins.slice(0, 3).map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {review.friction && (
                <div className="evening-block">
                  <div className="section-label">Friction</div>
                  <p className="evening-text">{review.friction}</p>
                </div>
              )}
              {review.tomorrow && (
                <div className="evening-block evening-tomorrow">
                  <div className="section-label">Try tomorrow</div>
                  <p className="evening-text">{review.tomorrow}</p>
                  <button
                    type="button"
                    className="ghost small"
                    onClick={() => onAddTomorrowTask?.(review.tomorrow)}
                  >
                    + Save as task
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── RecommendChip ───────────────────────────────────────────────────────
// "What should I do next?" chip that lives next to the burnout chip in the
// header. On open, calls ollama:recommend (which assembles tasks + classes
// + active timer + recent activity + CP + burnout server-side) and renders
// 2–4 actionable items with quick "+ Task" / "▶ Start" buttons.
function RecommendChip({ ollamaOk, model, tasks, onAddTask, onStartTimer }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [recs, setRecs] = useState([]);
  const [err, setErr] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function refresh() {
    if (!ollamaOk) {
      setErr("Ollama is offline.");
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const res = await api.ollama.recommend({ model });
      if (!res?.ok) {
        setErr(res?.error || "Couldn't get recommendations.");
        setRecs([]);
      } else {
        setRecs(Array.isArray(res.recommendations) ? res.recommendations : []);
        setGeneratedAt(new Date());
      }
    } catch (e) {
      setErr(e?.message || "Failed to get recommendations.");
    } finally {
      setLoading(false);
    }
  }

  // First-open auto-fetch.
  useEffect(() => {
    if (open && recs.length === 0 && !loading && !err) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="recommend-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={"recommend-chip" + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        disabled={!ollamaOk}
        title={
          ollamaOk
            ? "Get a quick recommendation from Apex"
            : "Ollama is offline"
        }
      >
        <span className="recommend-spark" aria-hidden>✨</span>
        <span>What now?</span>
        <span className="recommend-caret">▾</span>
      </button>
      {open && (
        <div className="recommend-popover">
          <div className="recommend-popover-head">
            <strong>What should I do now?</strong>
            <div className="row" style={{ gap: 6 }}>
              <button
                className="ghost xsmall"
                onClick={(e) => { e.stopPropagation(); refresh(); }}
                disabled={loading}
                title="Re-roll recommendations"
              >
                ↻
              </button>
              <button
                className="ghost xsmall"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>
          {generatedAt && (
            <small className="muted" style={{ display: "block", marginBottom: 6 }}>
              {generatedAt.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </small>
          )}
          {loading && <div className="muted">Thinking…</div>}
          {err && !loading && <div className="error">{err}</div>}
          {!loading && !err && recs.length === 0 && (
            <div className="muted">
              Nothing to recommend right now — re-run after you've logged a bit.
            </div>
          )}
          {!loading && recs.length > 0 && (
            <ul className="recommend-list">
              {recs.slice(0, 4).map((r, i) => {
                const linkedTask = r.taskId
                  ? (tasks || []).find((t) => t.id === r.taskId)
                  : null;
                return (
                  <li key={i} className={"recommend-item rec-" + (r.kind || "other")}>
                    <div className="recommend-item-body">
                      <div className="recommend-text">{r.text}</div>
                      <div className="recommend-meta muted">
                        <span className={"pill rec-pill rec-" + (r.kind || "other")}>
                          {r.kind || "other"}
                        </span>
                        {r.estimated_minutes ? (
                          <span>· ~{r.estimated_minutes}m</span>
                        ) : null}
                        {linkedTask && (
                          <span title={linkedTask.title}>
                            · linked: {linkedTask.title.slice(0, 40)}
                          </span>
                        )}
                        {r.reason && <span className="rec-reason">· {r.reason}</span>}
                      </div>
                    </div>
                    <div className="recommend-item-actions">
                      <button
                        type="button"
                        className="ghost xsmall"
                        onClick={() => onStartTimer?.(r)}
                        title="Start a live timer for this"
                      >
                        ▶ Start
                      </button>
                      {!r.taskId && (
                        <button
                          type="button"
                          className="ghost xsmall"
                          onClick={() => onAddTask?.(r)}
                          title="Save as a task"
                        >
                          + Task
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── TodayCard ───────────────────────────────────────────────────────────
// Merges "Today's plan" and "Today's tasks" into one tabbed card. The Plan
// tab is the AI schedule; the Tasks tab is the manual checklist of the
// next ~7 open items. Both share state with the Dashboard's planCard so
// running a plan from this card updates the same backing store.
function TodayCard({
  tasks,
  doneToday,
  planCard,
  runPlan,
  clearPlan,
  refreshOllama,
  toggleTask,
  go,
  setToast,
}) {
  const [tab, setTab] = useState("tasks");
  const [habitStreaks, setHabitStreaks] = useState({});
  const openTasks = (tasks || []).filter((t) => !t.completed);
  const visible = tab === "tasks" ? (tasks || []).slice(0, 7) : null;

  // Whenever the visible habit IDs change, fetch their streaks. Cheap —
  // habit_completions is small + indexed.
  useEffect(() => {
    const habitIds = (visible || [])
      .filter((t) => t.kind === "habit")
      .map((t) => t.id);
    if (habitIds.length === 0) {
      setHabitStreaks({});
      return;
    }
    let cancelled = false;
    api.tasks.habitStreaksFor?.(habitIds)
      .then((map) => { if (!cancelled) setHabitStreaks(map || {}); })
      .catch(() => { if (!cancelled) setHabitStreaks({}); });
    return () => { cancelled = true; };
  }, [JSON.stringify((visible || []).filter((t) => t.kind === "habit").map((t) => t.id))]);

  return (
    <div className="card today-card">
      <div className="row between today-head" style={{ alignItems: "center" }}>
        <div>
          <div className="card-title" style={{ margin: 0 }}>Today</div>
          <small className="muted today-sub">
            {doneToday}/{tasks.length} done
            {planCard.plan && (
              <>
                {" · "}AI plan ready
              </>
            )}
          </small>
        </div>
        <div className="today-tabs">
          <button
            type="button"
            className={"today-tab" + (tab === "tasks" ? " active" : "")}
            onClick={() => setTab("tasks")}
          >
            Tasks
          </button>
          <button
            type="button"
            className={"today-tab" + (tab === "plan" ? " active" : "")}
            onClick={() => setTab("plan")}
            title={planCard.ollamaOk ? "AI day plan" : "Ollama is offline"}
          >
            Plan {planCard.plan ? "✓" : ""}
          </button>
        </div>
      </div>

      {tab === "tasks" ? (
        <>
          {tasks.length === 0 ? (
            <div className="muted today-empty">
              Nothing queued — add some in <a href="#" onClick={(e) => { e.preventDefault(); go("tasks"); }}>Tasks →</a>
            </div>
          ) : (
            <div className="today-task-list">
              {visible.map((t) => (
                <div
                  key={t.id}
                  className={"today-task" + (t.completed ? " done" : "")}
                >
                  <input
                    type="checkbox"
                    checked={!!t.completed}
                    onChange={() => toggleTask(t.id)}
                    aria-label={`Toggle ${t.title}`}
                  />
                  <div className="today-task-body">
                    <div className="today-task-title">{t.title}</div>
                    <div className="today-task-sub">
                      {t.kind === "habit" && (
                        <span className="pill">habit</span>
                      )}
                      {t.kind === "habit" &&
                        habitStreaks[t.id]?.current > 0 && (
                          <span
                            className="habit-streak-badge"
                            title={`Longest streak: ${habitStreaks[t.id].longest}`}
                          >
                            🔥 {habitStreaks[t.id].current}
                          </span>
                        )}
                      {t.course_code && (
                        <span className="pill gray">{t.course_code}</span>
                      )}
                      {t.category && (
                        <span className="pill gray">{t.category}</span>
                      )}
                      {t.deadline && (
                        <span className="today-task-meta">
                          due {new Date(t.deadline).toLocaleDateString()}
                        </span>
                      )}
                      {t.estimated_minutes && (
                        <span className="today-task-meta">
                          ~{t.estimated_minutes}m
                        </span>
                      )}
                    </div>
                  </div>
                  {!t.completed && (
                    <button
                      type="button"
                      className="today-task-start"
                      title="Start a timer for this task"
                      onClick={async () => {
                        await api.timer.start({
                          kind: t.kind === "habit" ? "habit" : "task",
                          category: "productive",
                          title: t.title,
                          description: t.description || null,
                          task_id: t.id,
                          planned_minutes: t.estimated_minutes || 25,
                        });
                      }}
                    >
                      ▶
                    </button>
                  )}
                  <span
                    className={
                      "pill " +
                      (t.priority <= 2
                        ? "rose"
                        : t.priority === 3
                          ? "amber"
                          : "gray")
                    }
                    title={`Priority P${t.priority}`}
                  >
                    P{t.priority}
                  </span>
                </div>
              ))}
              {tasks.length > 7 && (
                <div className="muted today-more">
                  +{tasks.length - 7} more
                </div>
              )}
            </div>
          )}
          <hr className="soft" />
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button onClick={() => go("tasks")} className="ghost small">
              Manage tasks →
            </button>
            <button
              onClick={() => {
                setTab("plan");
                if (!planCard.plan && planCard.ollamaOk && openTasks.length) runPlan();
              }}
              className="ghost small"
              disabled={
                !planCard.ollamaOk || !planCard.model || planCard.loading
              }
              title={planCard.ollamaOk ? "Generate an AI day plan" : "Ollama is offline"}
            >
              {planCard.plan ? "View plan" : "Plan my day"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="row plan-actions" style={{ gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            <small className="muted plan-sub" style={{ flex: 1 }}>
              {planCard.ollamaOk === null
                ? "Checking Ollama…"
                : planCard.ollamaOk
                  ? planCard.model
                    ? `via ${planCard.model}`
                    : "Ollama ready"
                  : "Ollama offline — start it from Settings"}
            </small>
            <span
              className={"pill " + (planCard.ollamaOk ? "teal" : "rose")}
              title={planCard.ollamaOk ? "Ollama reachable" : "Ollama not reachable"}
            >
              {planCard.ollamaOk === null ? "…" : planCard.ollamaOk ? "ollama" : "offline"}
            </span>
            <button
              className="ghost xsmall"
              title="Re-check Ollama"
              onClick={refreshOllama}
            >
              ↻
            </button>
            <button
              className="primary small"
              disabled={
                !planCard.ollamaOk ||
                !planCard.model ||
                planCard.loading ||
                tasks.length === 0
              }
              onClick={runPlan}
            >
              {planCard.loading
                ? "Thinking…"
                : planCard.plan
                  ? "Replan"
                  : "Plan my day"}
            </button>
            {planCard.plan && (
              <button
                className="ghost xsmall"
                title="Copy plan as text"
                onClick={() => copyPlanToClipboard(planCard.plan, setToast)}
              >
                ⧉
              </button>
            )}
            {planCard.plan && (
              <button
                className="ghost xsmall"
                title="Clear today's plan"
                onClick={clearPlan}
              >
                ✕
              </button>
            )}
          </div>
          {planCard.error && (
            <div className="error" style={{ marginTop: 6 }}>
              {planCard.error}
            </div>
          )}
          {!planCard.plan && !planCard.loading && (
            <div className="plan-empty">
              {tasks.length === 0 ? (
                <>
                  <div className="plan-empty-title">Nothing queued yet</div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    Add a few tasks then hit <strong>Plan my day</strong> —
                    Apex turns them into a realistic schedule.
                  </div>
                </>
              ) : (
                <>
                  <div className="plan-empty-title">
                    {tasks.length} task{tasks.length === 1 ? "" : "s"} ready
                  </div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    Press <strong>Plan my day</strong> for a schedule, or
                    work through them freestyle in the Tasks tab.
                  </div>
                </>
              )}
            </div>
          )}
          {planCard.loading && (
            <div className="plan-empty" style={{ marginTop: 6 }}>
              <div className="plan-empty-title">Drafting your day…</div>
              <div className="muted" style={{ marginTop: 4 }}>
                Local model is thinking — usually 5–20 seconds.
              </div>
            </div>
          )}
          {planCard.plan && (
            <>
              {planCard.plan.summary && (
                <p className="plan-summary">{planCard.plan.summary}</p>
              )}
              <div className="plan-timeline">
                {(planCard.plan.plan || []).map((p, i) => (
                  <div key={i} className="plan-block">
                    <div className="plan-time">
                      <div className="plan-time-start">{p.start}</div>
                      <div className="plan-time-dur">{p.duration} min</div>
                    </div>
                    <div className="plan-block-body">
                      <div className="plan-block-title">{p.title}</div>
                      {p.reason && (
                        <div className="plan-block-reason">{p.reason}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {(planCard.plan.skip || []).length > 0 && (
                <div className="plan-skip">
                  <div className="section-label" style={{ marginBottom: 4 }}>
                    Skipped today
                  </div>
                  {planCard.plan.skip.map((s, i) => (
                    <div key={i} className="plan-skip-row">
                      <span className="muted">—</span> {s.reason}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// One row in Top apps · today. Shows app name, minutes, percent bar, and
// a category chip that doubles as a quick "re-categorise" control: click
// the chip and a small popover lets you override the category for this
// app. Override is persisted via api.tracker.categorize so future ticks
// use the new label.
function AppRow({ app: a, appTotal, source, isToday }) {
  const [editing, setEditing] = useState(false);
  const [override, setOverride] = useState(null);
  const pct = appTotal ? Math.round((a.minutes / appTotal) * 100) : 0;
  const srcs = (a.sources || a.source || "").toString();
  const srcKind =
    srcs.includes("mobile") && srcs.includes("desktop")
      ? "both"
      : srcs.includes("mobile")
        ? "mobile"
        : srcs.includes("desktop") || srcs.includes("battery")
          ? "desktop"
          : null;
  const catLabel = override || a.category || "other";
  const showSrc = source === "all" && !!srcKind;
  const hideCat =
    (catLabel === "mobile" && srcKind === "mobile") || catLabel === "other";

  // Override is supported for both desktop exes AND android packages —
  // the override is just a setting + a retroactive activity_sessions
  // UPDATE; both data sources read the same `activity.overrides.<app>`
  // key, so a single click recategorises everywhere.
  const canEdit = !!api.tracker?.categorize;
  const opts = ["productive", "neutral", "distraction", "leisure", "rest"];

  async function save(cat) {
    setEditing(false);
    if (!canEdit) return;
    setOverride(cat);
    try {
      await api.tracker.categorize(a.app, cat);
    } catch {
      /* swallow — UI optimistic */
    }
  }

  return (
    <div className={`app-row cat-${catLabel}`}>
      <div className="app-row-main">
        <span className={`cat-dot cat-${catLabel}`} title={catLabel} />
        <strong className="top-app-name" title={a.app}>
          {prettyAppName(a.app)}
        </strong>
        <div className="app-row-tags">
          {!hideCat && (
            <button
              type="button"
              className={`cat-tag cat-${catLabel}` + (canEdit ? " editable" : "")}
              disabled={!canEdit}
              onClick={() => canEdit && setEditing((e) => !e)}
              title={canEdit ? "Click to recategorise" : catLabel}
            >
              {catLabel}
            </button>
          )}
          {showSrc && (
            <span
              className={"src-tag " + srcKind}
              title={`source: ${srcs}`}
            >
              {srcKind}
            </span>
          )}
        </div>
        <span className="app-row-time">
          <strong>{fmtMinutes(a.minutes)}</strong>
          <small className="muted">{pct}%</small>
        </span>
      </div>
      {editing && (
        <div className="cat-edit-row">
          {opts.map((c) => (
            <button
              key={c}
              type="button"
              className={
                "cat-tag cat-" + c + (c === catLabel ? " active" : "")
              }
              onClick={() => save(c)}
            >
              {c}
            </button>
          ))}
          <button
            type="button"
            className="cat-edit-cancel"
            onClick={() => setEditing(false)}
            title="Cancel"
          >
            ✕
          </button>
        </div>
      )}
      <div className="bar app-row-bar">
        <div
          className={`bar-fill cat-${catLabel}`}
          style={{ width: Math.max(3, pct) + "%" }}
        />
      </div>
    </div>
  );
}

// Colored stat pill used in the Activity stats strip
function StatPill({ cat = "other", label, value, sub }) {
  return (
    <div className={`stat-pill cat-${cat}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function sumBySource(apps, src) {
  if (!apps) return 0;
  return apps.reduce((s, a) => {
    const sources = (a.sources || a.source || "").toString();
    return sources.includes(src) ? s + (a.minutes || 0) : s;
  }, 0);
}

function weekdayShort(iso) {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString(undefined, {
      weekday: "short",
    });
  } catch {
    return "";
  }
}

function relativeAgo(isoOrDateStr) {
  try {
    const d = new Date(isoOrDateStr);
    if (Number.isNaN(+d)) return "recently";
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const h = Math.round(mins / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  } catch {
    return "recently";
  }
}

// ─── Today's read card ────────────────────────────────────────────────────
function BurnoutReadCard({
  report,
  recent = [],
  loading,
  onRerun,
  onSuggestionToTask,
  checkin,
  setCheckin,
  saveCheckin,
  checkinSaved,
  energyMsg,
}) {
  const [showFlags, setShowFlags] = useState(false);
  const [showVibe, setShowVibe] = useState(false);

  const risk = report?.risk_score;
  const hasReport = !!report;
  const riskBand =
    typeof risk === "number"
      ? risk >= 7
        ? "high"
        : risk >= 4
          ? "mid"
          : "low"
      : null;
  const riskLabel =
    riskBand === "high"
      ? "elevated"
      : riskBand === "mid"
        ? "moderate"
        : riskBand === "low"
          ? "steady"
          : "not checked";
  const riskPct =
    typeof risk === "number" ? Math.max(4, Math.min(100, risk * 10)) : 0;

  const flags = Array.isArray(report?.redFlags) ? report.redFlags : [];
  const suggestions = Array.isArray(report?.suggestions)
    ? report.suggestions
    : [];
  const generatedAt = report?.generated_at || report?.generatedAt || null;

  // Recent risk history — newest first from server, render oldest → newest.
  // Pad to 7 days so the bar chart always has the same width.
  const trendBars = useMemo(() => {
    const map = new Map((recent || []).map((r) => [r.date, r]));
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const r = map.get(iso);
      const score = r && typeof r.risk_score === "number" ? r.risk_score : null;
      out.push({
        date: iso,
        score,
        band: score == null ? "none"
          : score >= 7 ? "high"
          : score >= 4 ? "mid" : "low",
        label: d.toLocaleDateString(undefined, { weekday: "narrow" }),
      });
    }
    return out;
  }, [recent]);

  // Yesterday's score → delta marker on the score
  const ydayScore = useMemo(() => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const iso = y.toISOString().slice(0, 10);
    const r = (recent || []).find((x) => x.date === iso);
    return r && typeof r.risk_score === "number" ? r.risk_score : null;
  }, [recent]);
  const riskDelta = (typeof risk === "number" && typeof ydayScore === "number")
    ? risk - ydayScore
    : null;

  // Derive a fallback "vibe" score so the meter isn't blank pre-check.
  const vibeAvg =
    typeof risk !== "number" && checkin
      ? (
          (checkin.sleep +
            checkin.clarity +
            checkin.energy +
            (10 - checkin.dread)) /
          4
        ).toFixed(1)
      : null;

  return (
    <div
      className={`card burnout-read-card band-${riskBand || "none"}`}
      style={{ marginBottom: 16 }}
    >
      <div className="burnout-head">
        <div className="burnout-head-text">
          <div className="card-title" style={{ margin: 0 }}>
            Today's read
          </div>
          <small className="muted burnout-subtitle">
            {generatedAt
              ? `Checked ${new Date(generatedAt).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}`
              : hasReport
                ? "Latest read"
                : "No burnout read yet — log a vibe or run a check."}
          </small>
        </div>
        <div className="burnout-head-actions">
          <button
            className="ghost small"
            onClick={() => setShowVibe((v) => !v)}
          >
            {showVibe ? "Hide vibe" : "Log vibe"}
          </button>
          <button className="ghost small" onClick={onRerun} disabled={loading}>
            {loading ? "Analysing…" : hasReport ? "Re-run" : "Run check"}
          </button>
        </div>
      </div>

      {/* Risk hero — score on the left, summary on the right */}
      <div className={`risk-hero band-${riskBand || "none"}`}>
        <div className="risk-hero-score">
          {typeof risk === "number" ? (
            <>
              <div className={`risk-big band-${riskBand}`}>
                <span className="risk-big-num">{risk}</span>
                <span className="risk-big-denom">/10</span>
              </div>
              <div className={`risk-band band-${riskBand}`}>{riskLabel}</div>
            </>
          ) : vibeAvg ? (
            <>
              <div className="risk-big band-none">
                <span className="risk-big-num">{vibeAvg}</span>
                <span className="risk-big-denom">/10</span>
              </div>
              <div className="risk-band band-none">vibe</div>
            </>
          ) : (
            <>
              <div className="risk-big band-none">
                <span className="risk-big-num">—</span>
              </div>
              <div className="risk-band band-none">no signal</div>
            </>
          )}
        </div>
        <div className="risk-hero-body">
          {report?.summary ? (
            <p className="burnout-summary">{report.summary}</p>
          ) : vibeAvg ? (
            <p className="burnout-summary muted">
              Run a check to turn this vibe into a burnout read.
            </p>
          ) : (
            <p className="burnout-summary muted">
              Log a quick vibe or run a check — Apex will read your activity
              history and flag what's worth watching.
            </p>
          )}
          <div className="risk-meter-track">
            <div
              className={`risk-meter-fill band-${riskBand || "none"}`}
              style={{ width: riskPct + "%" }}
            />
          </div>
          {riskDelta != null && Math.abs(riskDelta) >= 0.5 && (
            <small className="muted" style={{ marginTop: 6, display: "block" }}>
              {riskDelta > 0 ? "↑" : "↓"} {Math.abs(riskDelta).toFixed(1)} vs yesterday
              ({ydayScore.toFixed?.(1) ?? ydayScore})
            </small>
          )}
        </div>
      </div>

      {/* 7-day risk-score trend */}
      {trendBars.some((b) => b.score != null) && (
        <div style={{ marginTop: 12 }}>
          <div className="section-label" style={{ marginTop: 0, marginBottom: 4 }}>
            Last 7 days
          </div>
          <div className="risk-trend">
            {trendBars.map((b) => (
              <div
                key={b.date}
                className={`risk-trend-bar band-${b.band}`}
                style={{ height: b.score == null ? 4 : Math.max(6, (b.score / 10) * 28) + "px" }}
                title={b.score == null ? `${b.date}: no check` : `${b.date}: ${b.score}/10`}
              />
            ))}
          </div>
          <div className="risk-trend-axis">
            {trendBars.map((b, i) => (
              <span key={i}>{b.label}</span>
            ))}
          </div>
        </div>
      )}

      {/* Inline vibe logger */}
      {showVibe && checkin && setCheckin && (
        <div className="vibe-logger">
          <div className="row between" style={{ alignItems: "baseline" }}>
            <div className="section-label" style={{ marginTop: 0 }}>
              Quick vibe check
            </div>
            <small className="muted">
              1–10 · save to feed the next burnout read
            </small>
          </div>
          <div className="vibe-grid">
            <SliderRow
              label="Sleep"
              kind="sleep"
              value={checkin.sleep}
              onChange={(v) => setCheckin({ ...checkin, sleep: v })}
            />
            <SliderRow
              label="Clarity"
              kind="clarity"
              value={checkin.clarity}
              onChange={(v) => setCheckin({ ...checkin, clarity: v })}
            />
            <SliderRow
              label="Dread"
              kind="dread"
              value={checkin.dread}
              onChange={(v) => setCheckin({ ...checkin, dread: v })}
            />
            <SliderRow
              label="Energy"
              kind="energy"
              value={checkin.energy}
              onChange={(v) => setCheckin({ ...checkin, energy: v })}
            />
          </div>
          {energyMsg && <div className="vibe-hint">{energyMsg}</div>}
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <button className="primary small" onClick={saveCheckin}>
              Save vibe
            </button>
            <button
              className="ghost small"
              onClick={() => api.ext.openSpotify()}
            >
              Open Spotify
            </button>
            {checkinSaved && <small className="hint">Saved ✓</small>}
          </div>
        </div>
      )}

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 10 }}>
            Suggestions · {suggestions.length}
          </div>
          <div className="suggestion-list">
            {suggestions.map((s, i) => (
              <div key={i} className="suggestion-row">
                <span className={"pill " + suggestionPillColor(s.type)}>
                  {s.type || "tip"}
                </span>
                <div style={{ flex: 1 }}>
                  <div>{s.text}</div>
                  {s.link && (
                    <small>
                      <a
                        href="#"
                        onClick={(e) => {
                          e.preventDefault();
                          api.ext.open(s.link);
                        }}
                      >
                        {shortUrl(s.link)}
                      </a>
                    </small>
                  )}
                </div>
                <button
                  className="ghost xsmall"
                  title="Add as task"
                  onClick={() => onSuggestionToTask(s)}
                >
                  + task
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Red flags — collapsed by default */}
      {flags.length > 0 && (
        <>
          <hr className="soft" />
          <div className="row between">
            <small className="muted">
              ⚠ {flags.length} red flag{flags.length === 1 ? "" : "s"}
            </small>
            <button
              className="ghost xsmall"
              onClick={() => setShowFlags((v) => !v)}
            >
              {showFlags ? "hide" : "show"}
            </button>
          </div>
          {showFlags && (
            <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
              {flags.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
        </>
      )}

      {report?.tomorrow && (
        <>
          <hr className="soft" />
          <p style={{ margin: 0 }}>
            <strong>Tomorrow →</strong> {report.tomorrow}
          </p>
        </>
      )}
    </div>
  );
}

// ─── CP self modal — LC/CF/CC snapshot + today's solved ───────────────────
function CpSelfModal({ selfCp, onClose, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);
  const todaysSolved = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = [];
    for (const plat of ["leetcode", "codeforces", "codechef"]) {
      const d = selfCp?.[plat];
      if (!d || !Array.isArray(d.submissions)) continue;
      for (const s of d.submissions) {
        const day = (s.submitted_at || "").slice(0, 10);
        if (day === today) rows.push({ ...s, platform: plat });
      }
    }
    return rows.sort((a, b) =>
      (b.submitted_at || "").localeCompare(a.submitted_at || ""),
    );
  }, [selfCp]);

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal wide" style={{ width: 720 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }}>My competitive programming</h3>
          <div className="row" style={{ gap: 6 }}>
            <button
              className="ghost small"
              onClick={async () => {
                setRefreshing(true);
                await onRefresh();
                setRefreshing(false);
              }}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing…" : "↻ Refresh"}
            </button>
            <button className="ghost" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        {selfCp?.cached_at && (
          <small className="muted">
            cached {new Date(selfCp.cached_at).toLocaleString()}
          </small>
        )}
        <div className="grid-3" style={{ marginTop: 12 }}>
          {selfCp?.leetcode && (
            <CpMiniCard title="LeetCode" data={selfCp.leetcode} />
          )}
          {selfCp?.codeforces && (
            <CpMiniCard title="Codeforces" data={selfCp.codeforces} />
          )}
          {selfCp?.codechef && (
            <CpMiniCard title="CodeChef" data={selfCp.codechef} />
          )}
        </div>

        <div className="section-label" style={{ marginTop: 16 }}>
          Solved today · {todaysSolved.length}
        </div>
        {todaysSolved.length === 0 && (
          <div className="muted">
            Nothing logged today. Solve one and hit Refresh.
          </div>
        )}
        {todaysSolved.map((s, i) => (
          <div key={i} className="todo-row">
            <span className={"pill " + platformPillColor(s.platform)}>
              {s.platform}
            </span>
            <div style={{ flex: 1 }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  api.ext.open(s.url);
                }}
              >
                <strong>{s.title}</strong>
              </a>
              <div className="sub">
                {s.verdict && <span className="pill gray">{s.verdict}</span>}
                {s.rating != null && (
                  <span className="pill gray" style={{ marginLeft: 4 }}>
                    rating {s.rating}
                  </span>
                )}
                {Array.isArray(s.tags) &&
                  s.tags.slice(0, 4).map((t) => (
                    <span key={t} className="pill" style={{ marginLeft: 4 }}>
                      {t}
                    </span>
                  ))}
                <small className="muted" style={{ marginLeft: 6 }}>
                  {new Date(s.submitted_at).toLocaleTimeString()}
                </small>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CpMiniCard({ title, data }) {
  if (!data) return null;
  if (!data.ok) {
    return (
      <div className="card">
        <div className="card-title">{title}</div>
        <small className="muted">{data.error || "no data"}</small>
      </div>
    );
  }
  return (
    <div className="card">
      <div className="row between">
        <div className="card-title">{title}</div>
        <small className="muted">@{data.handle}</small>
      </div>
      {data.rating != null && (
        <div>
          Rating: <strong>{data.rating}</strong>
          {data.maxRating ? (
            <small className="muted"> (max {data.maxRating})</small>
          ) : null}
        </div>
      )}
      {data.totalSolved != null && (
        <div>
          Solved: <strong>{data.totalSolved}</strong>
          {data.easy != null ? (
            <small className="muted">
              {" "}
              · {data.easy}E / {data.medium}M / {data.hard}H
            </small>
          ) : null}
        </div>
      )}
      {data.stars != null && (
        <div>
          Stars: <strong>{data.stars}★</strong>
        </div>
      )}
    </div>
  );
}

// ─── DayNoteCard ──────────────────────────────────────────────────────────
// A private per-day journal. Saved locally (SQLite), never posted anywhere.
// User can opt-in to an Ollama one-sentence summary that becomes part of the
// Ask-Apex context for that date only.
function DayNoteCard({ model, ollamaOk }) {
  const today = new Date().toISOString().slice(0, 10);
  const [note, setNote] = useState(null);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [summarising, setSummarising] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // Passcode state — when a passcode is configured, we ALSO lock today's note
  // until the user unlocks. `locked === true` means we need the unlock prompt.
  const [lockState, setLockState] = useState({
    hasPasscode: false,
    locked: false,
    checked: false,
  });
  const [showUnlock, setShowUnlock] = useState(false);
  // Writing streak — count of consecutive days ending today with a non-empty
  // entry. Only loads when we're unlocked (otherwise the backend returns
  // locked: true for every row and we'd get 0).
  const [writeStreak, setWriteStreak] = useState(0);

  async function refreshLock() {
    try {
      const hp = await api.dayNotes.hasPasscode();
      const unlocked = hp?.set
        ? (await api.dayNotes.isUnlocked())?.unlocked
        : true;
      setLockState({
        hasPasscode: !!hp?.set,
        locked: hp?.set && !unlocked,
        checked: true,
      });
      return { hasPasscode: !!hp?.set, locked: hp?.set && !unlocked };
    } catch {
      setLockState({ hasPasscode: false, locked: false, checked: true });
      return { hasPasscode: false, locked: false };
    }
  }

  async function loadNote() {
    try {
      const n = (await api.dayNotes.get(today)) || null;
      if (n && n.locked) {
        setNote(null);
        setBody("");
        return;
      }
      setNote(n);
      setBody(n?.body || "");
    } catch {
      setNote(null);
    }
  }

  async function loadWriteStreak() {
    try {
      const rows = await api.dayNotes.list(60);
      if (!Array.isArray(rows) || rows.length === 0) {
        setWriteStreak(0);
        return;
      }
      // Build a set of ISO dates with non-empty entries
      const filledDates = new Set(
        rows
          .filter((r) => !r.locked && typeof r.body === "string" && r.body.trim())
          .map((r) => r.date),
      );
      // Walk backwards from today counting consecutive filled days
      let count = 0;
      const cursor = new Date(today + "T00:00:00");
      while (true) {
        const iso = cursor.toISOString().slice(0, 10);
        if (filledDates.has(iso)) {
          count += 1;
          cursor.setDate(cursor.getDate() - 1);
        } else {
          break;
        }
      }
      setWriteStreak(count);
    } catch {
      setWriteStreak(0);
    }
  }

  useEffect(() => {
    (async () => {
      const s = await refreshLock();
      if (!s.locked) {
        await loadNote();
        await loadWriteStreak();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  async function save() {
    setSaving(true);
    try {
      const n = await api.dayNotes.upsert({
        date: today,
        body,
        isPrivate: true,
      });
      if (n?.locked) {
        await refreshLock();
        return;
      }
      setNote(n);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2000);
      // Refresh streak — today may have flipped from empty to filled
      loadWriteStreak();
    } finally {
      setSaving(false);
    }
  }

  async function summarise() {
    if (!ollamaOk || !model || !body.trim()) return;
    setSummarising(true);
    try {
      // Save first, then summarise the saved version.
      const up = await api.dayNotes.upsert({
        date: today,
        body,
        isPrivate: true,
      });
      if (up?.locked) {
        await refreshLock();
        return;
      }
      const res = await api.dayNotes.summarize({ date: today, model });
      if (res?.ok) {
        const n = await api.dayNotes.get(today);
        if (!n?.locked) setNote(n);
      }
    } finally {
      setSummarising(false);
    }
  }

  async function handleUnlockSuccess() {
    setShowUnlock(false);
    await refreshLock();
    await loadNote();
    await loadWriteStreak();
  }

  async function clearSummary() {
    // Delete the summary by overwriting with empty (keeps body, clears AI summary)
    // Simpler: just re-save to clear any prior summary by sending upsert with body.
    // But setDayNoteSummary is server-side; use a tiny trick: upsert sets null summary? no —
    // upsert doesn't touch summary. We need a dedicated path. For now, call summarize with body="".
    // Easiest: expose via upsert + setDayNoteSummary — but we didn't bind that.
    // Pragmatic: re-upsert and then ask for summary of a sentinel — or just toggle expanded.
    // Instead: delete the row and re-save with body only.
    await api.dayNotes.delete(today);
    const n = await api.dayNotes.upsert({ date: today, body, isPrivate: true });
    setNote(n);
  }

  const hasSummary = !!note?.summary;
  const chars = body.length;
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;

  return (
    <div className="card day-note-card" style={{ marginBottom: 16 }}>
      <div
        className="row between"
        style={{ alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}
      >
        <div>
          <div className="card-title" style={{ margin: 0 }}>
            Day note{" "}
            <span className="pill gray" style={{ marginLeft: 8, fontSize: 10 }}>
              private
            </span>
          </div>
          <small className="muted">
            A short entry for future-you. Summarise to feed Ask Apex on this
            date (opt-in).
          </small>
          {!lockState.locked && writeStreak > 0 && (
            <small className="muted" style={{ display: "block", marginTop: 2 }}>
              {writeStreak}-day writing streak
            </small>
          )}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {lockState.hasPasscode &&
            (lockState.locked ? (
              <button
                className="ghost small"
                onClick={() => setShowUnlock(true)}
                title="Unlock day notes"
              >
                Unlock
              </button>
            ) : (
              <button
                className="ghost small"
                onClick={async () => {
                  await api.dayNotes.lock();
                  await refreshLock();
                  setExpanded(false);
                  setNote(null);
                  setBody("");
                }}
                title="Lock notes now"
              >
                Lock
              </button>
            ))}
          <button
            className="ghost small"
            onClick={() => setShowHistory(true)}
            title="View past entries (passcode required)"
          >
            History
          </button>
          <button
            className="ghost small"
            disabled={lockState.locked}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Collapse" : "Open"}
          </button>
        </div>
      </div>

      {lockState.locked && (
        <div className="day-note-locked" style={{ marginTop: 10 }}>
          <div style={{ marginTop: 6 }}>
            <button
              className="primary small"
              onClick={() => setShowUnlock(true)}
            >
              Enter passcode
            </button>
          </div>
        </div>
      )}

      {!lockState.locked && expanded && (
        <>
          <textarea
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What actually happened today? Wins, blockers, how you felt. No rules."
            style={{ marginTop: 10, resize: "vertical", fontFamily: "inherit" }}
          />
          <div
            className="row between"
            style={{ marginTop: 8, flexWrap: "wrap", gap: 8 }}
          >
            <small className="muted">
              {words} {words === 1 ? "word" : "words"} · {chars} chars
              {note?.updated_at
                ? ` · saved ${relativeAgo(note.updated_at)}`
                : ""}
            </small>
            <div className="row" style={{ gap: 6 }}>
              <button
                className="ghost small"
                onClick={summarise}
                disabled={!ollamaOk || !model || !body.trim() || summarising}
                title="One-sentence summary that becomes context for Ask Apex on this date only"
              >
                {summarising
                  ? "Summarising…"
                  : hasSummary
                    ? "Re-summarise"
                    : "Summarise (opt-in)"}
              </button>
              <button
                className="primary small"
                onClick={save}
                disabled={saving}
              >
                {saving ? "Saving…" : savedAt ? "Saved ✓" : "Save"}
              </button>
            </div>
          </div>
          {hasSummary && (
            <div className="day-note-summary">
              <small className="muted">
                Summary (used as Ask-Apex context):
              </small>
              <div>{note.summary}</div>
              <button
                className="ghost xsmall"
                onClick={clearSummary}
                style={{ marginTop: 6 }}
              >
                Clear summary
              </button>
            </div>
          )}
        </>
      )}

      {!lockState.locked && !expanded && note?.body && (
        <div
          className="day-note-preview muted"
          onClick={() => setExpanded(true)}
          role="button"
        >
          {truncate(note.body, 180)}
        </div>
      )}
      {!lockState.locked && !expanded && !note?.body && (
        <small className="muted" style={{ display: "block", marginTop: 8 }}>
          No entry yet. Tap Open to jot down the day.
        </small>
      )}

      {showHistory && (
        <DayNoteHistoryModal
          onClose={async () => {
            setShowHistory(false);
            await refreshLock();
            await loadNote();
          }}
          todayIso={today}
        />
      )}
      {showUnlock && (
        <DayNoteUnlockModal
          onClose={() => setShowUnlock(false)}
          onUnlocked={handleUnlockSuccess}
        />
      )}
    </div>
  );
}

// ─── DayNoteUnlockModal ───────────────────────────────────────────────────
// Small inline passcode prompt for gating today's note. If no passcode has
// been configured yet, this offers to set one right here.
function DayNoteUnlockModal({ onClose, onUnlocked }) {
  const [phase, setPhase] = useState("loading"); // loading | setup | unlock
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const hp = await api.dayNotes.hasPasscode();
      setPhase(hp?.set ? "unlock" : "setup");
    })();
  }, []);

  async function doSetup() {
    setErr("");
    if (pass.length < 4) {
      setErr("Passcode must be at least 4 characters.");
      return;
    }
    if (pass !== pass2) {
      setErr("The two entries don't match.");
      return;
    }
    setBusy(true);
    const res = await api.dayNotes.setPasscode(pass);
    setBusy(false);
    if (res?.ok) {
      setPass("");
      setPass2("");
      onUnlocked?.();
    } else setErr(res?.error || "Could not save passcode.");
  }
  async function doUnlock() {
    setErr("");
    setBusy(true);
    const res = await api.dayNotes.unlock(pass);
    setBusy(false);
    if (res?.ok) {
      setPass("");
      onUnlocked?.();
    } else setErr(res?.error || "Incorrect passcode.");
  }

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" style={{ width: 420 }}>
        <div className="row between" style={{ marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>Day notes</h3>
            <small className="muted">
              {phase === "setup"
                ? "Set a passcode to keep your notes private."
                : "Enter your passcode to unlock. Auto-locks after 15 min idle."}
            </small>
          </div>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        {phase === "loading" && <div className="muted">Loading…</div>}

        {phase === "setup" && (
          <div>
            <div className="form-row">
              <label>New passcode</label>
              <input
                type="password"
                autoFocus
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label>Confirm passcode</label>
              <input
                type="password"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSetup()}
              />
            </div>
            {err && <div className="error">{err}</div>}
            <div
              className="row"
              style={{ justifyContent: "flex-end", gap: 6, marginTop: 8 }}
            >
              <button className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="primary" onClick={doSetup} disabled={busy}>
                Set passcode
              </button>
            </div>
          </div>
        )}

        {phase === "unlock" && (
          <div>
            <div className="form-row">
              <label>Passcode</label>
              <input
                type="password"
                autoFocus
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doUnlock()}
              />
            </div>
            {err && <div className="error">{err}</div>}
            <div
              className="row"
              style={{ justifyContent: "flex-end", gap: 6, marginTop: 8 }}
            >
              <button className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={doUnlock}
                disabled={busy || !pass}
              >
                Unlock
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DayNoteHistoryModal ──────────────────────────────────────────────────
// Read-only browser for past day-notes. First use asks you to set a passcode
// (so a casual onlooker can't see past entries). After unlock, entries stay
// accessible for ~15 minutes, then re-lock automatically.
function DayNoteHistoryModal({ onClose, todayIso }) {
  // Lifecycle: loading → needsSetup | needsUnlock | unlocked
  const [phase, setPhase] = useState("loading");
  const [err, setErr] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [dates, setDates] = useState([]);
  const [selected, setSelected] = useState(null);
  const [selectedNote, setSelectedNote] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const hp = await api.dayNotes.hasPasscode();
      if (!hp?.set) {
        setPhase("needsSetup");
        return;
      }
      const unlocked = await api.dayNotes.isUnlocked();
      if (unlocked?.unlocked) {
        setPhase("unlocked");
        await loadList();
      } else {
        setPhase("needsUnlock");
      }
    })();
  }, []);

  async function loadList() {
    const res = await api.dayNotes.list(60);
    setDates((res?.dates || []).filter((d) => d.date !== todayIso));
  }
  async function doSetup() {
    setErr("");
    if (pass.length < 4) {
      setErr("Passcode must be at least 4 characters.");
      return;
    }
    if (pass !== pass2) {
      setErr("The two entries don't match.");
      return;
    }
    setBusy(true);
    const res = await api.dayNotes.setPasscode(pass);
    setBusy(false);
    if (res?.ok) {
      setPhase("unlocked");
      setPass("");
      setPass2("");
      await loadList();
    } else setErr(res?.error || "Could not save passcode.");
  }
  async function doUnlock() {
    setErr("");
    setBusy(true);
    const res = await api.dayNotes.unlock(pass);
    setBusy(false);
    if (res?.ok) {
      setPhase("unlocked");
      setPass("");
      await loadList();
    } else setErr(res?.error || "Incorrect passcode.");
  }
  async function openDate(iso) {
    setSelected(iso);
    setSelectedNote(null);
    const n = await api.dayNotes.get(iso);
    if (n?.locked) {
      setPhase("needsUnlock");
      setErr("Session expired — unlock again.");
      return;
    }
    setSelectedNote(n || { date: iso, body: "" });
  }
  async function lockNow() {
    await api.dayNotes.lock();
    onClose();
  }

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal" style={{ width: 560 }}>
        <div className="row between" style={{ marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>Day-note history</h3>
            <small className="muted">
              {phase === "unlocked"
                ? "Past entries — read only. Auto-locks after 15 min idle."
                : "Private. Stays on this machine."}
            </small>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {phase === "unlocked" && (
              <button
                className="ghost small"
                onClick={lockNow}
                title="Lock and close"
              >
                Lock
              </button>
            )}
            <button className="ghost" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        {phase === "loading" && <div className="muted">Loading…</div>}

        {phase === "needsSetup" && (
          <div>
            <p className="muted small">
              Set a passcode the first time. You'll need it to open day notes
              (past AND today) — auto-locks after 15 min idle.
            </p>
            <div className="form-row">
              <label>New passcode</label>
              <input
                type="password"
                autoFocus
                value={pass}
                onChange={(e) => setPass(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label>Confirm passcode</label>
              <input
                type="password"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSetup()}
              />
            </div>
            {err && <div className="error">{err}</div>}
            <div
              className="row"
              style={{ justifyContent: "flex-end", gap: 6, marginTop: 8 }}
            >
              <button className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="primary" onClick={doSetup} disabled={busy}>
                Set passcode
              </button>
            </div>
          </div>
        )}

        {phase === "needsUnlock" && (
          <div>
            <p className="muted small">
              Enter your passcode to view past entries.
            </p>
            <div className="form-row">
              <label>Passcode</label>
              <input
                type="password"
                autoFocus
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doUnlock()}
              />
            </div>
            {err && <div className="error">{err}</div>}
            <div
              className="row"
              style={{ justifyContent: "flex-end", gap: 6, marginTop: 8 }}
            >
              <button className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={doUnlock}
                disabled={busy || !pass}
              >
                Unlock
              </button>
            </div>
          </div>
        )}

        {phase === "unlocked" && (
          <div className="day-note-history">
            {dates.length === 0 && !selectedNote && (
              <div className="muted" style={{ padding: 10 }}>
                No past entries yet. Come back tomorrow.
              </div>
            )}
            {dates.length > 0 && !selectedNote && (
              <div className="day-note-history-list">
                {dates.map((d) => (
                  <button
                    key={d.date}
                    className="day-note-history-row"
                    onClick={() => openDate(d.date)}
                  >
                    <span className="date">{d.date}</span>
                    <small className="muted">
                      {d.chars ? `${d.chars} chars` : "(empty)"}
                    </small>
                  </button>
                ))}
              </div>
            )}
            {selectedNote && (
              <div>
                <div className="row between" style={{ marginBottom: 6 }}>
                  <strong>{selected}</strong>
                  <button
                    className="ghost small"
                    onClick={() => {
                      setSelected(null);
                      setSelectedNote(null);
                    }}
                  >
                    ← Back
                  </button>
                </div>
                {selectedNote.summary && (
                  <div
                    className="day-note-summary"
                    style={{ marginBottom: 10 }}
                  >
                    <small className="muted">Summary</small>
                    <div>{selectedNote.summary}</div>
                  </div>
                )}
                <div className="day-note-readonly">
                  {selectedNote.body || (
                    <span className="muted">(no body)</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function SliderRow({ label, value, onChange, kind }) {
  return (
    <div className={`slider-row ${kind}`}>
      <div className="muted">{label}</div>
      <input
        type="range"
        min={1}
        max={10}
        value={value ?? 5}
        onChange={(e) => onChange(+e.target.value)}
      />
      <div className="val">{value ?? "-"}/10</div>
    </div>
  );
}

function AskApexDrawer({
  model,
  ollamaOk,
  onClose,
  tasks,
  classes,
  dayOrder,
  trackerStatus,
  todayTotals,
  trend,
  topApps,
  checkin,
  burnoutReport,
}) {
  const [q, setQ] = useState("");
  const [a, setA] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [includeContext, setIncludeContext] = useState(true);
  const [includeDayNote, setIncludeDayNote] = useState(false);
  const [dayNoteSummary, setDayNoteSummary] = useState(null);

  // Fetch today's day-note summary (opt-in) once.
  useEffect(() => {
    (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const n = await api.dayNotes.get(today);
        if (n?.summary) setDayNoteSummary(n.summary);
      } catch {}
    })();
  }, []);

  const ctx = useMemo(
    () =>
      buildAskApexContext({
        tasks,
        classes,
        dayOrder,
        trackerStatus,
        todayTotals,
        trend,
        topApps,
        checkin,
        burnoutReport,
        dayNoteSummary: includeDayNote ? dayNoteSummary : null,
      }),
    [
      tasks,
      classes,
      dayOrder,
      trackerStatus,
      todayTotals,
      trend,
      topApps,
      checkin,
      burnoutReport,
      dayNoteSummary,
      includeDayNote,
    ],
  );

  async function ask() {
    if (!q.trim() || !ollamaOk || !model) return;
    setLoading(true);
    setErr(null);
    setA(null);
    const system = [
      `You are Apex, a calm, precise assistant for Yashasvi (CS student at SRM).`,
      `Format your responses in clean markdown: short paragraphs, compact bullets when listing steps, fenced code blocks for code. Bold the key actionable phrase.`,
      `Be concrete. Avoid pep talk. Avoid restating the question. For plans, give a 3-step list + one sentence of reasoning. For code, one short example plus one caveat.`,
      `Do NOT invent times or facts the user didn't provide; if you reference their schedule or workload, use only the context block.`,
    ].join(" ");
    const user = includeContext
      ? `# Context\n${ctx.blockText}\n\n# Question\n${q.trim()}`
      : q.trim();
    const res = await api.ollama.chat({ model, system, user });
    setLoading(false);
    if (!res.ok) setErr(res.error || "Ollama error");
    else setA(res.content);
  }

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal wide" style={{ width: 720 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }}>Ask Apex</h3>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="muted" style={{ margin: "4px 0 10px" }}>
          Freeform chat with your local Ollama. Design tradeoffs, a weird bug, a
          study plan.
        </p>

        {/* Context block — user sees exactly what Apex gets */}
        {includeContext && (
          <div className="ask-apex-context">
            <div className="row between" style={{ marginBottom: 4 }}>
              <strong>Apex will see:</strong>
              <small className="muted">{ctx.summary}</small>
            </div>
            {ctx.rows.map((r, i) => (
              <div key={i} className="ctx-row">
                <span>{r.label}</span>
                <span className="muted">{r.value}</span>
              </div>
            ))}
          </div>
        )}

        <textarea
          rows={4}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Given today's schedule, what's a realistic evening plan?"
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === "Enter") ask();
          }}
        />

        <div
          className="row between"
          style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}
        >
          <div
            className="row"
            style={{ gap: 12, flexWrap: "wrap", fontSize: 12 }}
          >
            <label className="row" style={{ gap: 6, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={includeContext}
                onChange={(e) => setIncludeContext(e.target.checked)}
                style={{ width: "auto" }}
              />
              include my context
            </label>
            <label
              className="row"
              style={{
                gap: 6,
                cursor: dayNoteSummary ? "pointer" : "not-allowed",
                opacity: dayNoteSummary ? 1 : 0.5,
              }}
              title={
                dayNoteSummary
                  ? "Include your opt-in day-note summary"
                  : "No summary for today — open Day note and tap Summarise"
              }
            >
              <input
                type="checkbox"
                checked={includeDayNote}
                disabled={!dayNoteSummary}
                onChange={(e) => setIncludeDayNote(e.target.checked)}
                style={{ width: "auto" }}
              />
              include day-note summary
            </label>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {err && <span className="error">{err}</span>}
            <button
              className="primary"
              onClick={ask}
              disabled={!ollamaOk || !model || loading || !q.trim()}
            >
              {loading ? "Thinking…" : "Ask (Ctrl+Enter)"}
            </button>
          </div>
        </div>

        {a && <MarkdownBlock text={a} className="ask-apex-response" />}
      </div>
    </div>
  );
}

// Build a compact, bullet-shaped context string for Ask Apex. Also returns the
// same info in a label/value shape so the UI can show the user exactly what
// will be sent.
function buildAskApexContext({
  tasks,
  classes,
  dayOrder,
  trackerStatus,
  todayTotals,
  trend,
  topApps,
  checkin,
  burnoutReport,
  dayNoteSummary,
}) {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const time = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const classList = (classes || []).map(
    (c) =>
      `${c.start_time?.slice(0, 5) || "?"}–${c.end_time?.slice(0, 5) || "?"} ${c.course_code || c.code || c.name || "class"}`,
  );
  const openTasks = (tasks || []).filter((t) => !t.completed);
  const doneTasks = (tasks || []).filter((t) => t.completed);
  const topOpen = openTasks
    .slice(0, 5)
    .map(
      (t) =>
        `${t.title}${t.estimated_minutes ? ` (${t.estimated_minutes}m)` : ""}`,
    );

  // Activity — today + last 7d
  const todayRow = (trend || []).find(
    (d) => d.date === now.toISOString().slice(0, 10),
  );
  const todayMins = todayRow
    ? CATEGORY_KEYS.reduce((s, k) => s + (todayRow[k] || 0), 0)
    : 0;
  const weekMins = (trend || []).reduce(
    (s, d) => s + CATEGORY_KEYS.reduce((a, k) => a + (d[k] || 0), 0),
    0,
  );
  const topAppStr = (topApps || [])
    .slice(0, 3)
    .map((a) => `${prettyAppName(a.app)} ${Math.round(a.minutes)}m`)
    .join(", ");

  const rows = [
    { label: "Date / time", value: `${date} · ${time}` },
    {
      label: "Day order",
      value: dayOrder ? `Day ${dayOrder}` : "weekend / no day-order",
    },
    {
      label: "Classes today",
      value: classList.length ? classList.join("; ") : "none",
    },
    {
      label: "Open tasks",
      value: openTasks.length
        ? `${openTasks.length} open (top: ${topOpen.join("; ") || "—"})`
        : "inbox empty",
    },
    {
      label: "Done today",
      value: doneTasks.length
        ? doneTasks
            .map((t) => t.title)
            .slice(0, 4)
            .join("; ")
        : "nothing yet",
    },
    {
      label: "Screen time today",
      value: `${fmtMinutes(todayMins)} tracked${topAppStr ? ` · ${topAppStr}` : ""}`,
    },
    {
      label: "Screen time 7d",
      value:
        fmtMinutes(weekMins) +
        ` (avg ${fmtMinutes(Math.round(weekMins / 7))}/day)`,
    },
    {
      label: "Tracker",
      value: trackerStatus?.running
        ? `on · currently ${prettyAppName(trackerStatus.current?.app) || "—"}`
        : "off",
    },
    {
      label: "Latest vibe",
      value: checkin
        ? `sleep ${checkin.sleep}, clarity ${checkin.clarity}, dread ${checkin.dread}, energy ${checkin.energy}`
        : "not logged",
    },
    {
      label: "Burnout risk",
      value:
        typeof burnoutReport?.risk_score === "number"
          ? `${burnoutReport.risk_score}/10`
          : "not checked today",
    },
  ];
  if (dayNoteSummary) {
    rows.push({ label: "Day-note summary", value: dayNoteSummary });
  }

  const blockText = rows.map((r) => `- **${r.label}:** ${r.value}`).join("\n");
  const summary = `${openTasks.length} open · ${fmtMinutes(todayMins)} today · vibe e${checkin?.energy ?? "?"}`;
  return { rows, blockText, summary };
}

// MarkdownBlock lives in src/lib/markdown.jsx — imported above.

// ─── helpers ──────────────────────────────────────────────────────────────
function fmtMinutes(m) {
  if (!m) return "0m";
  const h = Math.floor(m / 60);
  const mn = m % 60;
  return h ? `${h}h ${mn}m` : `${mn}m`;
}

// Copy today's plan as plain-text so the user can paste it into notes /
// chat / wherever. Falls back gracefully if the clipboard API is missing.
function copyPlanToClipboard(plan, setToast) {
  try {
    const blocks = (plan?.plan || []).map(
      (p) => `• ${p.start} · ${p.duration}m — ${p.title}${p.reason ? ` (${p.reason})` : ""}`,
    );
    const skip = (plan?.skip || []).map((s) => `  – skip: ${s.reason || "—"}`);
    const lines = [];
    if (plan?.summary) lines.push(plan.summary, "");
    lines.push(...blocks);
    if (skip.length) {
      lines.push("", "Skipped:");
      lines.push(...skip);
    }
    const text = lines.join("\n");
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setToast?.({ kind: "success", title: "Plan copied", msg: "Paste it anywhere." });
    setTimeout(() => setToast?.(null), 2500);
  } catch {
    setToast?.({ kind: "error", title: "Copy failed", msg: "Try again." });
    setTimeout(() => setToast?.(null), 2500);
  }
}
function fmtMinutesShort(m) {
  if (!m) return "0m";
  if (m < 60) return m + "m";
  return (m / 60).toFixed(m % 60 === 0 ? 0 : 1) + "h";
}
function suggestionPillColor(type) {
  switch ((type || "").toLowerCase()) {
    case "break":
    case "rest":
    case "walk":
      return "teal";
    case "exercise":
      return "teal";
    case "work":
    case "focus":
      return "amber";
    case "warn":
    case "reduce":
      return "rose";
    default:
      return "gray";
  }
}
function platformPillColor(plat) {
  if (plat === "leetcode") return "amber";
  if (plat === "codeforces") return "teal";
  if (plat === "codechef") return "rose";
  return "gray";
}
function shortUrl(u) {
  try {
    const p = new URL(u);
    return (
      p.hostname.replace(/^www\./, "") +
      (p.pathname === "/" ? "" : p.pathname.slice(0, 22))
    );
  } catch {
    return u.slice(0, 32);
  }
}
function energyMessage({ sleep, clarity, dread, energy }) {
  const e = energy ?? 5,
    d = dread ?? 5;
  if (e <= 3)
    return "Low energy. Today is for one small win — a single LC easy + a walk is enough.";
  if (d >= 7)
    return "Dread is high. Start with the smallest task on your list. Momentum beats plans.";
  if (e <= 5)
    return "Moderate energy. Cap deep work at 60 min. One LC problem + a short walk is a win.";
  if (clarity >= 8 && sleep >= 7)
    return "Good day to tackle a hard problem. 90-min deep session, then break.";
  return "Steady day. Two sessions of 45-60 min with a walk between them.";
}
function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
