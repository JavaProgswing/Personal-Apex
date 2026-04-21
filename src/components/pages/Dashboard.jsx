import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../../lib/api.js";
import Pomodoro from "../Pomodoro.jsx";
import MoodTrend from "../MoodTrend.jsx";
import TimeLog from "../TimeLog.jsx";
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
    pollRef.current = setInterval(() => {
      api.tracker
        .status()
        .then(setTrackerStatus)
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(pollRef.current);
  }, []);

  // Whenever the user picks a different day in the trail, re-fetch top apps
  // for that date.
  useEffect(() => {
    api.activity
      .topApps(topAppsDate, 8)
      .then(setTopApps)
      .catch(() => setTopApps([]));
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
        <div
          className="row"
          style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}
        >
          {cpHasAny && (
            <button
              className="ghost small"
              onClick={() => setShowCp(true)}
              title="Your LeetCode / Codeforces / CodeChef snapshot"
            >
              My CP
            </button>
          )}
          <button
            className="ghost small"
            onClick={copyTodayBrief}
            title="Copy a markdown brief of today to the clipboard"
          >
            Copy brief
          </button>
          <button className="ghost small" onClick={() => setShowAskApex(true)}>
            Ask Apex
          </button>
          {typeof risk === "number" ? (
            <div
              className={`burnout-chip risk-${riskClass}`}
              title={burnoutReport?.summary || "burnout read"}
            >
              <span className="dot" />
              burnout {risk}/10
              <button
                className="ghost xsmall"
                disabled={burnoutLoading}
                onClick={runBurnoutCheck}
              >
                ↻
              </button>
            </div>
          ) : (
            <button
              className="ghost small"
              disabled={burnoutLoading}
              onClick={runBurnoutCheck}
            >
              {burnoutLoading ? "Analysing…" : "Burnout check"}
            </button>
          )}
        </div>
      </div>

      {/* Now strip — currently foreground app */}
      {trackerStatus?.running && trackerStatus?.current && (
        <div className="now-strip">
          <span className="pulse" />
          <div style={{ flex: 1 }}>
            <strong>{prettyAppName(trackerStatus.current.app)}</strong>
            <small className="muted">
              &nbsp;·&nbsp;{trackerStatus.current.category}&nbsp;·&nbsp;
              {trackerStatus.current.minutes || 0} min
            </small>
          </div>
          <small
            className="muted"
            style={{
              maxWidth: "50%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {trackerStatus.current.title?.slice(0, 80)}
          </small>
        </div>
      )}
      {trackerStatus && !trackerStatus.running && (
        <div className="now-strip idle">
          <span className="dot" />
          <div style={{ flex: 1 }}>
            <small className="muted">
              Activity tracker is off — enable in Settings → Activity to see
              what eats your hours.
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

      {/* Top grid: Today's plan + Today's classes */}
      <div className="grid-2" style={{ marginTop: 14, marginBottom: 16 }}>
        <div className="card">
          <div className="row between">
            <div className="card-title">Today's plan</div>
            <div className="row" style={{ gap: 6 }}>
              <span className={"pill " + (planCard.ollamaOk ? "teal" : "rose")}>
                {planCard.ollamaOk === null
                  ? "…"
                  : planCard.ollamaOk
                    ? "ollama"
                    : "offline"}
              </span>
              <select
                value={planCard.model}
                onChange={(e) =>
                  setPlanCard({ ...planCard, model: e.target.value })
                }
                style={{ maxWidth: 160 }}
              >
                {planCard.models.length === 0 && (
                  <option value="">(no models)</option>
                )}
                {planCard.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
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
                  title="Clear today's plan"
                  onClick={clearPlan}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
          {planCard.error && (
            <div className="error" style={{ marginTop: 8 }}>
              {planCard.error}
            </div>
          )}
          {!planCard.plan && !planCard.loading && (
            <div className="muted" style={{ marginTop: 10 }}>
              {tasks.length === 0
                ? "Nothing queued — add tasks and hit Plan my day."
                : "Press Plan my day. A local Ollama model turns your open tasks + check-in into a realistic schedule."}
            </div>
          )}
          {planCard.plan && (
            <>
              <p className="muted" style={{ margin: "8px 0 14px" }}>
                {planCard.plan.summary}
              </p>
              {(planCard.plan.plan || []).map((p, i) => (
                <div key={i} className="plan-block">
                  <div className="row between">
                    <div>
                      <div className="when">
                        {p.start} · {p.duration} min
                      </div>
                      <div style={{ fontWeight: 600, marginTop: 2 }}>
                        {p.title}
                      </div>
                    </div>
                    {p.taskId && <span className="pill">task #{p.taskId}</span>}
                  </div>
                  {p.reason && <div className="reason">{p.reason}</div>}
                </div>
              ))}
              {(planCard.plan.skip || []).length > 0 && (
                <>
                  <hr className="soft" />
                  <div className="section-label">Skipped today</div>
                  {planCard.plan.skip.map((s, i) => (
                    <div key={i} className="muted" style={{ margin: "4px 0" }}>
                      task #{s.taskId} — {s.reason}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>

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
            return (
              <div
                key={c.id}
                className={
                  "class-row" +
                  (isCurrent ? " now" : "") +
                  (isPast ? " past" : "") +
                  (isNext ? " next" : "")
                }
                style={{
                  display: "flex",
                  gap: 10,
                  margin: "8px 0",
                  alignItems: "center",
                  opacity: isPast ? 0.55 : 1,
                  padding: isCurrent ? "6px 8px" : "0",
                  borderRadius: isCurrent ? 8 : 0,
                  background: isCurrent
                    ? "color-mix(in srgb, var(--accent) 12%, transparent)"
                    : undefined,
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
                  </div>
                  <div className="sub muted">
                    {c.code ?? ""} {c.room ? `· ${c.room}` : ""}{" "}
                    {c.faculty ? `· ${c.faculty}` : ""}
                  </div>
                </div>
                {c.kind === "lab" && <span className="pill rose">lab</span>}
                {c.kind === "tutorial" && <span className="pill amber">tut</span>}
              </div>
            );
          })}
          <hr className="soft" />
          <button className="ghost" onClick={() => go("upcoming")}>
            Open Upcoming →
          </button>
        </div>
      </div>

      {/* Second row: Tasks + Weekly goals */}
      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="row between">
            <div className="card-title">Today's tasks</div>
            <span className="pill">
              {doneToday}/{tasks.length} done
            </span>
          </div>
          {tasks.length === 0 && (
            <div className="muted">Nothing queued. Add some in Tasks →</div>
          )}
          {tasks.slice(0, 7).map((t) => (
            <div
              key={t.id}
              className={"todo-row" + (t.completed ? " done" : "")}
            >
              <input
                type="checkbox"
                checked={!!t.completed}
                onChange={() => toggleTask(t.id)}
              />
              <div>
                <div className="title">{t.title}</div>
                <div className="sub">
                  {t.kind === "habit" && <span className="pill">habit</span>}
                  {t.course_code && (
                    <span className="pill">{t.course_code}</span>
                  )}
                  {t.category && <span className="pill">{t.category}</span>}
                  {t.deadline && (
                    <> · due {new Date(t.deadline).toLocaleDateString()}</>
                  )}
                  {t.estimated_minutes && <> · ~{t.estimated_minutes} min</>}
                </div>
              </div>
              <div className="right">
                {t.priority <= 2 && (
                  <span className="pill rose">P{t.priority}</span>
                )}
                {t.priority === 3 && <span className="pill amber">P3</span>}
                {t.priority >= 4 && (
                  <span className="pill gray">P{t.priority}</span>
                )}
              </div>
            </div>
          ))}
          <hr className="soft" />
          <div className="row">
            <button onClick={() => go("tasks")} className="ghost">
              Manage tasks →
            </button>
            <button
              onClick={runPlan}
              className="ghost"
              disabled={
                !planCard.ollamaOk || !planCard.model || planCard.loading
              }
            >
              {planCard.plan ? "Replan" : "Plan my day"}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="row between">
            <div className="card-title">Weekly goals</div>
            <span className="pill">
              {goals.filter((g) => (g.progress || 0) >= g.target).length} /{" "}
              {goals.length} hit
            </span>
          </div>
          {goals.length === 0 && (
            <div className="muted">Set some in Settings → Goals.</div>
          )}
          {goals.map((g) => {
            const pct = Math.min(
              100,
              Math.round(((g.progress ?? 0) / (g.target || 1)) * 100),
            );
            return (
              <div key={g.id} className="goal-row" style={{ marginTop: 10 }}>
                <div className="row between">
                  <strong>{g.title}</strong>
                  <small className="muted">
                    {g.progress ?? 0} / {g.target}
                  </small>
                </div>
                <div className="bar">
                  <div className="bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <button className="ghost small" onClick={() => bumpGoal(g)}>
                  +1
                </button>
              </div>
            );
          })}
          <hr className="soft" />
          <div className="row">
            <button className="ghost" onClick={() => go("settings")}>
              Edit goals
            </button>
            <small className="hint">
              {streak.weekDone} / 7 days active this week
            </small>
          </div>
        </div>
      </div>

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

      {/* Today's read (burnout + inline check-in) */}
      <BurnoutReadCard
        report={burnoutReport}
        loading={burnoutLoading}
        onRerun={runBurnoutCheck}
        checkin={checkin}
        setCheckin={setCheckin}
        saveCheckin={saveCheckin}
        checkinSaved={checkinSaved}
        energyMsg={energyMsg}
        onSuggestionToTask={async (s) => {
          await api.tasks.create({
            title: s.text || s.type || "burnout suggestion",
            description: s.link ? "Link: " + s.link : "",
            category:
              s.type === "exercise"
                ? "Health"
                : s.type === "break"
                  ? "Leisure"
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
          setTimeout(() => setToast(null), 3500);
        }}
      />

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <Pomodoro tasks={tasks} onLogged={() => refreshActivity()} />
        <MoodTrend />
      </div>

      <DayNoteCard model={planCard.model} ollamaOk={planCard.ollamaOk} />

      <TimeLog />

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
    </>
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
            <small className="muted">{fmtMinutes(appTotal)}</small>
          </div>

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
            filteredApps.map((a) => {
              const pct = appTotal
                ? Math.round((a.minutes / appTotal) * 100)
                : 0;
              const srcs = (a.sources || a.source || "").toString();
              return (
                <div key={a.app} className="app-row">
                  <div className="row between">
                    <div
                      className="top-app-id"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      <span
                        className={`cat-dot cat-${a.category || "other"}`}
                      />
                      <strong
                        className="top-app-name"
                        title={a.app}
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          minWidth: 0,
                        }}
                      >
                        {prettyAppName(a.app)}
                      </strong>
                      <small className="muted top-app-cat">
                        &nbsp;·&nbsp;{a.category || "—"}
                      </small>
                      {srcs && (
                        <span
                          className={
                            "src-tag " +
                            (srcs.includes("mobile") && srcs.includes("desktop")
                              ? "both"
                              : srcs.includes("mobile")
                                ? "mobile"
                                : "desktop")
                          }
                          style={{ marginLeft: 6 }}
                          title={`source: ${srcs}`}
                        >
                          {srcs.includes("mobile") && srcs.includes("desktop")
                            ? "both"
                            : srcs.includes("mobile")
                              ? "mobile"
                              : "desktop"}
                        </span>
                      )}
                    </div>
                    <span className="pill">
                      {fmtMinutes(a.minutes)} · {pct}%
                    </span>
                  </div>
                  <div className="bar">
                    <div
                      className={`bar-fill cat-${a.category || "other"}`}
                      style={{ width: pct + "%" }}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>
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

      {/* Risk meter */}
      <div className="risk-meter">
        <div className="risk-meter-track">
          <div
            className={`risk-meter-fill band-${riskBand || "none"}`}
            style={{ width: riskPct + "%" }}
          />
        </div>
        <div className="risk-meter-labels">
          <span className="muted">low</span>
          <span className="muted">moderate</span>
          <span className="muted">elevated</span>
        </div>
        <div className="risk-meter-readout">
          {typeof risk === "number" ? (
            <>
              <strong className={`risk-val band-${riskBand}`}>{risk}/10</strong>
              <span className="muted"> · {riskLabel}</span>
            </>
          ) : vibeAvg ? (
            <>
              <strong>vibe {vibeAvg}/10</strong>
              <span className="muted"> · run a check for burnout score</span>
            </>
          ) : (
            <span className="muted">no signal yet</span>
          )}
        </div>
      </div>

      {report?.summary && <p className="burnout-summary">{report.summary}</p>}

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
