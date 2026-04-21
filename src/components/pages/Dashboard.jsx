import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../../lib/api.js";
import Pomodoro from "../Pomodoro.jsx";
import MoodTrend from "../MoodTrend.jsx";
import TimeLog from "../TimeLog.jsx";

// Dashboard — the one place you land. Merges the old Planner (AI day plan +
// Ask-Apex drawer), keeps a compact burnout chip in the header, shows the
// current foreground app as a "now-strip" pulse, and renders a weekly activity
// trail from activity_sessions. Competitive-programming cards moved behind a
// header button ("My CP") so they don't eat the main surface.

const CATEGORY_KEYS = ["productive", "distraction", "neutral", "rest", "leisure", "mobile", "other"];
const CATEGORY_LABELS = {
  productive: "productive", distraction: "distraction", neutral: "neutral",
  rest: "rest", leisure: "leisure", mobile: "mobile", other: "other",
};

export default function Dashboard({ go }) {
  const [goals, setGoals] = useState([]);
  const [streak, setStreak] = useState({ streak: 0, weekDays: [], weekDone: 0 });
  const [tasks, setTasks] = useState([]);
  const [classes, setClasses] = useState([]);
  const [dayOrder, setDayOrder] = useState(null);
  const [checkin, setCheckin] = useState({ sleep: 6, clarity: 5, dread: 4, energy: 6, note: "" });
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
  const [topAppsDate, setTopAppsDate] = useState(new Date().toISOString().slice(0, 10));
  const [hiddenCats, setHiddenCats] = useState(() => new Set()); // toggleable legend

  const [toast, setToast] = useState(null);
  const [showAskApex, setShowAskApex] = useState(false);

  // Ollama / plan card. Models + ollamaOk are probed once. The cached plan is
  // read on first mount only — subsequent refreshes keep whatever the user
  // currently sees (so flipping to a class and back doesn't clobber anything).
  const [planCard, setPlanCard] = useState({ loading: false, plan: null, error: null, ollamaOk: null, models: [], model: "" });
  const planBootstrappedRef = useRef(false);
  const pollRef = useRef(null);

  useEffect(() => { refresh(/* firstMount */ true); /* eslint-disable-next-line */ }, []);

  // Subscribe to tracker nudges + session-ended events for toasts.
  useEffect(() => {
    const off1 = api.tracker.onNudge?.((p) => {
      setToast({ kind: "nudge", title: "Long session", msg: `You've been in ${p.app} for ${p.minutes} min. Take a 5-min break?` });
      setTimeout(() => setToast(null), 8000);
    });
    const off2 = api.tracker.onSessionEnded?.((p) => {
      if (p?.minutes >= 30) {
        setToast({ kind: "session", title: "Session wrapped", msg: `${p.app} · ${p.minutes} min (${p.category})` });
        setTimeout(() => setToast(null), 5000);
      }
      api.tracker.status().then(setTrackerStatus).catch(() => {});
      api.activity.todayTotals().then(setTodayTotals).catch(() => {});
      // refresh trend + topApps so the stack animates
      refreshActivity();
    });
    return () => { off1?.(); off2?.(); };
  }, []);

  useEffect(() => {
    pollRef.current = setInterval(() => {
      api.tracker.status().then(setTrackerStatus).catch(() => {});
    }, 15_000);
    return () => clearInterval(pollRef.current);
  }, []);

  // Whenever the user picks a different day in the trail, re-fetch top apps
  // for that date.
  useEffect(() => {
    api.activity.topApps(topAppsDate, 8).then(setTopApps).catch(() => setTopApps([]));
  }, [topAppsDate]);

  async function refreshActivity() {
    const [tr, apps, totals] = await Promise.all([
      api.activity.trend ? api.activity.trend(7).catch(() => []) : [],
      api.activity.topApps ? api.activity.topApps(topAppsDate, 8).catch(() => []) : [],
      api.activity.todayTotals().catch(() => null),
    ]);
    setTrend(tr); setTopApps(apps); setTodayTotals(totals);
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
    setGoals(g); setStreak(s); setTasks(t);
    setClasses(sched?.classes ?? []);
    setDayOrder(sched?.dayOrder ?? null);
    if (c) setCheckin({ sleep: c.sleep, clarity: c.clarity, dread: c.dread, energy: c.energy, note: c.note ?? "" });
    if (latest?.payload) setBurnoutReport(latest.payload);
    if (cpCache) setSelfCp(cpCache);
    setTrackerStatus(ts);
    await refreshActivity();

    // Ollama + cached plan: do this exactly ONCE per mount. Subsequent refreshes
    // leave planCard alone, so toggling sidebars/tasks doesn't blow away the
    // plan the user is reading.
    if (firstMount && !planBootstrappedRef.current) {
      planBootstrappedRef.current = true;
      const [modelsRes, savedModel, savedPlanRaw] = await Promise.all([
        api.ollama.listModels().catch(() => ({ ok: false, models: [] })),
        api.settings.get("ollama.model"),
        api.settings.get("apex.plan.today"),
      ]);
      const models = modelsRes?.models || [];
      let chosen = "";
      if (savedModel && models.includes(savedModel)) chosen = savedModel;
      else if (models.length) chosen = models[0];

      let savedPlan = null;
      if (savedPlanRaw) {
        try {
          const parsed = JSON.parse(savedPlanRaw);
          if (parsed?.date === new Date().toISOString().slice(0, 10)) savedPlan = parsed;
        } catch {}
      }
      setPlanCard((p) => ({ ...p, ollamaOk: modelsRes?.ok ?? false, models, model: chosen, plan: savedPlan }));
    }
  }

  async function refreshOllama() {
    const r = await api.ollama.listModels().catch(() => ({ ok: false, models: [] }));
    const models = r?.models || [];
    setPlanCard((p) => ({
      ...p,
      ollamaOk: r?.ok ?? false,
      models,
      model: p.model && models.includes(p.model) ? p.model : (models[0] || ""),
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

  async function bumpGoal(g) {
    await api.goals.incrementProgress(g.id, 1);
    setGoals(await api.goals.list());
  }

  async function runPlan() {
    setPlanCard((p) => ({ ...p, loading: true, error: null }));
    if (planCard.model) await api.settings.set("ollama.model", planCard.model);
    const energyCap = checkin?.energy == null ? 90 : Math.max(30, Math.round((checkin.energy / 10) * 120));
    const res = await api.ollama.plan({
      tasks, checkin, energyCap, dayOrder, classes, model: planCard.model,
    });
    if (!res?.ok) {
      setPlanCard((p) => ({ ...p, loading: false, error: res?.error || "Ollama error" }));
      return;
    }
    setPlanCard((p) => ({ ...p, loading: false, plan: res, error: null }));
    await api.settings.set("apex.plan.today", JSON.stringify({
      plan: res.plan, summary: res.summary, date: new Date().toISOString().slice(0, 10),
    }));
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
        checkin, plan, completedToday: completed, timeTotals, openTasks: open, classes,
        model: planCard.model,
      });
      if (resp?.ok) setBurnoutReport(resp);
      else setToast({ kind: "error", title: "Burnout check failed", msg: resp?.error || "Is Ollama running?" });
    } finally {
      setBurnoutLoading(false);
      setTimeout(() => setToast(null), 4000);
    }
  }

  // ── Derived
  const risk = burnoutReport?.risk_score;
  const riskClass = typeof risk === "number" ? (risk >= 7 ? "high" : risk >= 4 ? "mid" : "low") : "low";
  const energyMsg = energyMessage(checkin);
  const doneToday = tasks.filter((t) => t.completed).length;

  const weekTotals = useMemo(() => {
    const acc = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));
    for (const d of trend || []) for (const k of CATEGORY_KEYS) acc[k] += d[k] || 0;
    acc.total = CATEGORY_KEYS.reduce((s, k) => s + acc[k], 0);
    return acc;
  }, [trend]);

  const cpHasAny = !!(selfCp && (selfCp.leetcode || selfCp.codeforces || selfCp.codechef));

  return (
    <>
      {/* Header */}
      <div className="row between" style={{ alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <h1 className="page-title">Today</h1>
          <p className="page-sub">
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            {dayOrder ? ` · Day order ${dayOrder}` : " · weekend"}
            {" · "}{streak.streak}-day streak
          </p>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {cpHasAny && (
            <button className="ghost small" onClick={() => setShowCp(true)} title="Your LeetCode / Codeforces / CodeChef snapshot">
              📊 My CP
            </button>
          )}
          <button className="ghost small" onClick={() => setShowAskApex(true)}>Ask Apex ↗</button>
          {typeof risk === "number" ? (
            <div className={`burnout-chip risk-${riskClass}`} title={burnoutReport?.summary || "burnout read"}>
              <span className="dot" />
              burnout {risk}/10
              <button className="ghost xsmall" disabled={burnoutLoading} onClick={runBurnoutCheck}>↻</button>
            </div>
          ) : (
            <button className="ghost small" disabled={burnoutLoading} onClick={runBurnoutCheck}>
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
            <strong>{trackerStatus.current.app}</strong>
            <small className="muted"> · {trackerStatus.current.category} · {trackerStatus.current.minutes || 0} min</small>
          </div>
          <small className="muted" style={{ maxWidth: "50%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {trackerStatus.current.title?.slice(0, 80)}
          </small>
        </div>
      )}
      {trackerStatus && !trackerStatus.running && (
        <div className="now-strip idle">
          <span className="dot" />
          <div style={{ flex: 1 }}><small className="muted">Activity tracker is off — enable in Settings → Activity to see what eats your hours.</small></div>
          <button className="ghost small" onClick={async () => { await api.tracker.start(); setTrackerStatus(await api.tracker.status()); }}>Start</button>
        </div>
      )}

      {/* Top grid: Today's plan + Today's classes */}
      <div className="grid-2" style={{ marginTop: 14, marginBottom: 16 }}>
        <div className="card">
          <div className="row between">
            <div className="card-title">Today's plan</div>
            <div className="row" style={{ gap: 6 }}>
              <span className={"pill " + (planCard.ollamaOk ? "teal" : "rose")}>
                {planCard.ollamaOk === null ? "…" : planCard.ollamaOk ? "ollama" : "offline"}
              </span>
              <select value={planCard.model} onChange={(e) => setPlanCard({ ...planCard, model: e.target.value })} style={{ maxWidth: 160 }}>
                {planCard.models.length === 0 && <option value="">(no models)</option>}
                {planCard.models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <button className="ghost xsmall" title="Re-check Ollama" onClick={refreshOllama}>↻</button>
              <button
                className="primary small"
                disabled={!planCard.ollamaOk || !planCard.model || planCard.loading || tasks.length === 0}
                onClick={runPlan}
              >
                {planCard.loading ? "Thinking…" : planCard.plan ? "Replan" : "Plan my day"}
              </button>
              {planCard.plan && (
                <button className="ghost xsmall" title="Clear today's plan" onClick={clearPlan}>✕</button>
              )}
            </div>
          </div>
          {planCard.error && <div className="error" style={{ marginTop: 8 }}>{planCard.error}</div>}
          {!planCard.plan && !planCard.loading && (
            <div className="muted" style={{ marginTop: 10 }}>
              {tasks.length === 0
                ? "Nothing queued — add tasks and hit Plan my day."
                : "Press Plan my day. A local Ollama model turns your open tasks + check-in into a realistic schedule."}
            </div>
          )}
          {planCard.plan && (
            <>
              <p className="muted" style={{ margin: "8px 0 14px" }}>{planCard.plan.summary}</p>
              {(planCard.plan.plan || []).map((p, i) => (
                <div key={i} className="plan-block">
                  <div className="row between">
                    <div>
                      <div className="when">{p.start} · {p.duration} min</div>
                      <div style={{ fontWeight: 600, marginTop: 2 }}>{p.title}</div>
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
                    <div key={i} className="muted" style={{ margin: "4px 0" }}>task #{s.taskId} — {s.reason}</div>
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
            <div className="muted">{dayOrder ? "Nothing scheduled." : "Weekend — no classes."}</div>
          )}
          {classes.map((c) => (
            <div key={c.id} className="class-row" style={{ display: "flex", gap: 10, margin: "8px 0", alignItems: "center" }}>
              <span className="pill mono">{c.start_time}</span>
              <div style={{ flex: 1 }}>
                <div className="title">{c.subject}</div>
                <div className="sub muted">{c.code ?? ""} {c.room ? `· ${c.room}` : ""} {c.faculty ? `· ${c.faculty}` : ""}</div>
              </div>
              {c.kind === "lab" && <span className="pill rose">lab</span>}
            </div>
          ))}
          <hr className="soft" />
          <button className="ghost" onClick={() => go("upcoming")}>Open Upcoming →</button>
        </div>
      </div>

      {/* Second row: Tasks + Weekly goals */}
      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="row between">
            <div className="card-title">Today's tasks</div>
            <span className="pill">{doneToday}/{tasks.length} done</span>
          </div>
          {tasks.length === 0 && <div className="muted">Nothing queued. Add some in Tasks →</div>}
          {tasks.slice(0, 7).map((t) => (
            <div key={t.id} className={"todo-row" + (t.completed ? " done" : "")}>
              <input type="checkbox" checked={!!t.completed} onChange={() => toggleTask(t.id)} />
              <div>
                <div className="title">{t.title}</div>
                <div className="sub">
                  {t.kind === "habit" && <span className="pill">habit</span>}
                  {t.course_code && <span className="pill">{t.course_code}</span>}
                  {t.category && <span className="pill">{t.category}</span>}
                  {t.deadline && <> · due {new Date(t.deadline).toLocaleDateString()}</>}
                  {t.estimated_minutes && <> · ~{t.estimated_minutes} min</>}
                </div>
              </div>
              <div className="right">
                {t.priority <= 2 && <span className="pill rose">P{t.priority}</span>}
                {t.priority === 3 && <span className="pill amber">P3</span>}
                {t.priority >= 4 && <span className="pill gray">P{t.priority}</span>}
              </div>
            </div>
          ))}
          <hr className="soft" />
          <div className="row">
            <button onClick={() => go("tasks")} className="ghost">Manage tasks →</button>
            <button onClick={runPlan} className="ghost" disabled={!planCard.ollamaOk || !planCard.model || planCard.loading}>
              {planCard.plan ? "Replan" : "Plan my day"} ↗
            </button>
          </div>
        </div>

        <div className="card">
          <div className="row between">
            <div className="card-title">Weekly goals</div>
            <span className="pill">{goals.filter((g) => (g.progress || 0) >= g.target).length} / {goals.length} hit</span>
          </div>
          {goals.length === 0 && <div className="muted">Set some in Settings → Goals.</div>}
          {goals.map((g) => {
            const pct = Math.min(100, Math.round(((g.progress ?? 0) / (g.target || 1)) * 100));
            return (
              <div key={g.id} className="goal-row" style={{ marginTop: 10 }}>
                <div className="row between">
                  <strong>{g.title}</strong>
                  <small className="muted">{g.progress ?? 0} / {g.target}</small>
                </div>
                <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
                <button className="ghost small" onClick={() => bumpGoal(g)}>+1</button>
              </div>
            );
          })}
          <hr className="soft" />
          <div className="row">
            <button className="ghost" onClick={() => go("settings")}>Edit goals</button>
            <small className="hint">{streak.weekDone} / 7 days active this week</small>
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
            setTrackerStatus(await api.tracker.status().catch(() => trackerStatus));
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
              : (r?.error || "No ADB device found"),
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
            category: s.type === "exercise" ? "Health" : s.type === "break" ? "Leisure" : "Personal",
            priority: 3,
            estimated_minutes: s.minutes || 15,
            tags: ["burnout"],
            links: s.link ? [s.link] : [],
          });
          setToast({ kind: "success", title: "Added to tasks", msg: s.text || s.type });
          setTimeout(() => setToast(null), 3500);
        }}
      />

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <Pomodoro tasks={tasks} onLogged={() => refreshActivity()} />
        <MoodTrend />
      </div>
      <TimeLog />

      {showAskApex && (
        <AskApexDrawer
          model={planCard.model}
          ollamaOk={planCard.ollamaOk}
          onClose={() => setShowAskApex(false)}
        />
      )}

      {showCp && selfCp && (
        <CpSelfModal
          selfCp={selfCp}
          onClose={() => setShowCp(false)}
          onRefresh={async () => {
            const r = await api.cp.self();
            if (r?.results) setSelfCp({ ...r.results, cached_at: new Date().toISOString() });
          }}
        />
      )}

      {toast && (
        <div className={`toast toast-${toast.kind}`}>
          <div style={{ flex: 1 }}>
            {toast.title && <div className="title">{toast.title}</div>}
            <div className="sub">{toast.msg}</div>
          </div>
          <button className="ghost xsmall" onClick={() => setToast(null)}>✕</button>
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

  const visibleWeekTotal = CATEGORY_KEYS.filter((k) => !hiddenCats.has(k)).reduce(
    (s, k) => s + (weekTotals[k] || 0),
    0,
  );

  // Today's row derived from trend (source of truth — matches the trail)
  const todayRow = (trend || []).find((d) => d.date === today) || null;
  const todayTotalMin = daySum(todayRow);

  // Filter top apps by desktop/mobile via the `sources` field returned by SQL
  const filteredApps = useMemo(() => {
    if (!topApps) return [];
    if (source === "all") return topApps;
    return topApps.filter((a) => {
      const s = (a.sources || a.source || "").toString();
      return s.includes(source);
    });
  }, [topApps, source]);

  const appTotal = filteredApps.reduce((s, a) => s + (a.minutes || 0), 0);

  // Breakdown for the selected date: desktop vs mobile minutes (from topApps)
  const selDesktopMin = sumBySource(topApps, "desktop");
  const selMobileMin = sumBySource(topApps, "mobile");

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
        <div className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
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
          <button className="ghost small" onClick={onSyncMobile} title="Pull today's mobile usage via ADB">
            Sync mobile 📱
          </button>
          <button className="ghost small" onClick={onOpenSettings}>
            Settings →
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="stats-strip">
        <StatPill
          cat="productive"
          label="Today"
          value={fmtMinutes(todayTotalMin)}
          sub={todayTotalMin ? (topCatEntry ? `mostly ${topCatEntry[0]}` : "") : "nothing tracked yet"}
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
          Last desktop session:{" "}
          <strong>{trackerStatus.last.app}</strong> · {trackerStatus.last.category} ·{" "}
          {trackerStatus.last.minutes || 0} min · wrapped{" "}
          {trackerStatus.last.ended_at ? relativeAgo(trackerStatus.last.ended_at) : "recently"}
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
              const h = (v) => (total ? Math.max(1, Math.round((v / total) * 100)) : 0);
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
              <small className="muted">No activity yet. Turn tracker on in Settings.</small>
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
                <div className="tt-row" style={{ borderTop: "1px solid var(--border)", paddingTop: 4, marginTop: 4 }}>
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
                className={`chip legend-${k}` + (hiddenCats.has(k) ? " disabled" : "")}
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
              { key: "all", label: "All" },
              { key: "desktop", label: "💻 Desktop" },
              { key: "mobile", label: "📱 Mobile" },
            ].map((o) => (
              <button
                key={o.key}
                type="button"
                className={"chip" + (source === o.key ? " active" : "")}
                onClick={() => setSource(o.key)}
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
              {topApps.length === 0
                ? "Nothing tracked on this day. Start the tracker or sync mobile."
                : `No ${source} data for this day.`}
            </div>
          ) : (
            filteredApps.map((a) => {
              const pct = appTotal ? Math.round((a.minutes / appTotal) * 100) : 0;
              const srcs = (a.sources || a.source || "").toString();
              return (
                <div key={a.app} className="app-row">
                  <div className="row between">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span className={`cat-dot cat-${a.category || "other"}`} />
                      <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.app}
                      </strong>
                      <small className="muted">· {a.category || "—"}</small>
                      {srcs && (
                        <small className="muted" title={`source: ${srcs}`}>
                          {srcs.includes("mobile") && srcs.includes("desktop")
                            ? "💻📱"
                            : srcs.includes("mobile")
                              ? "📱"
                              : "💻"}
                        </small>
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
    return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
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
  report, loading, onRerun, onSuggestionToTask,
  checkin, setCheckin, saveCheckin, checkinSaved, energyMsg,
}) {
  const [showFlags, setShowFlags] = useState(false);
  const [showVibe, setShowVibe] = useState(false);

  const risk = report?.risk_score;
  const hasReport = !!report;
  const riskBand = typeof risk === "number"
    ? (risk >= 7 ? "high" : risk >= 4 ? "mid" : "low")
    : null;
  const riskLabel = riskBand === "high" ? "elevated" : riskBand === "mid" ? "moderate" : riskBand === "low" ? "steady" : "not checked";
  const riskPct = typeof risk === "number" ? Math.max(4, Math.min(100, risk * 10)) : 0;

  const flags = Array.isArray(report?.redFlags) ? report.redFlags : [];
  const suggestions = Array.isArray(report?.suggestions) ? report.suggestions : [];
  const generatedAt = report?.generated_at || report?.generatedAt || null;

  // Derive a fallback "vibe" score so the meter isn't blank pre-check.
  const vibeAvg = typeof risk !== "number" && checkin
    ? ((checkin.sleep + checkin.clarity + checkin.energy + (10 - checkin.dread)) / 4).toFixed(1)
    : null;

  return (
    <div className={`card burnout-read-card band-${riskBand || "none"}`} style={{ marginBottom: 16 }}>
      <div className="burnout-head">
        <div>
          <div className="card-title" style={{ margin: 0 }}>Today's read</div>
          {generatedAt && (
            <small className="muted">checked {new Date(generatedAt).toLocaleString([], { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}</small>
          )}
          {!generatedAt && hasReport && <small className="muted">latest read</small>}
          {!hasReport && <small className="muted">No burnout read yet — log a vibe or hit Re-run.</small>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="ghost small" onClick={() => setShowVibe((v) => !v)}>
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
          <div className={`risk-meter-fill band-${riskBand || "none"}`} style={{ width: riskPct + "%" }} />
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
            <div className="section-label" style={{ marginTop: 0 }}>Quick vibe check</div>
            <small className="muted">1–10 · save to feed the next burnout read</small>
          </div>
          <div className="vibe-grid">
            <SliderRow label="Sleep"   kind="sleep"   value={checkin.sleep}   onChange={(v) => setCheckin({ ...checkin, sleep: v })} />
            <SliderRow label="Clarity" kind="clarity" value={checkin.clarity} onChange={(v) => setCheckin({ ...checkin, clarity: v })} />
            <SliderRow label="Dread"   kind="dread"   value={checkin.dread}   onChange={(v) => setCheckin({ ...checkin, dread: v })} />
            <SliderRow label="Energy"  kind="energy"  value={checkin.energy}  onChange={(v) => setCheckin({ ...checkin, energy: v })} />
          </div>
          {energyMsg && <div className="vibe-hint">{energyMsg}</div>}
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <button className="primary small" onClick={saveCheckin}>Save vibe</button>
            <button className="ghost small" onClick={() => api.ext.openSpotify()}>🎧 Spotify</button>
            {checkinSaved && <small className="hint">Saved ✓</small>}
          </div>
        </div>
      )}

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 10 }}>Suggestions · {suggestions.length}</div>
          <div className="suggestion-list">
            {suggestions.map((s, i) => (
              <div key={i} className="suggestion-row">
                <span className={"pill " + suggestionPillColor(s.type)}>{s.type || "tip"}</span>
                <div style={{ flex: 1 }}>
                  <div>{s.text}</div>
                  {s.link && (
                    <small><a href="#" onClick={(e) => { e.preventDefault(); api.ext.open(s.link); }}>{shortUrl(s.link)}</a></small>
                  )}
                </div>
                <button className="ghost xsmall" title="Add as task" onClick={() => onSuggestionToTask(s)}>+ task</button>
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
            <small className="muted">⚠ {flags.length} red flag{flags.length === 1 ? "" : "s"}</small>
            <button className="ghost xsmall" onClick={() => setShowFlags((v) => !v)}>
              {showFlags ? "hide" : "show"}
            </button>
          </div>
          {showFlags && (
            <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
              {flags.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          )}
        </>
      )}

      {report?.tomorrow && (
        <>
          <hr className="soft" />
          <p style={{ margin: 0 }}><strong>Tomorrow →</strong> {report.tomorrow}</p>
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
    return rows.sort((a, b) => (b.submitted_at || "").localeCompare(a.submitted_at || ""));
  }, [selfCp]);

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" style={{ width: 720 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }}>My competitive programming</h3>
          <div className="row" style={{ gap: 6 }}>
            <button className="ghost small" onClick={async () => { setRefreshing(true); await onRefresh(); setRefreshing(false); }} disabled={refreshing}>
              {refreshing ? "Refreshing…" : "↻ Refresh"}
            </button>
            <button className="ghost" onClick={onClose}>✕</button>
          </div>
        </div>
        {selfCp?.cached_at && (
          <small className="muted">cached {new Date(selfCp.cached_at).toLocaleString()}</small>
        )}
        <div className="grid-3" style={{ marginTop: 12 }}>
          {selfCp?.leetcode   && <CpMiniCard title="LeetCode"   data={selfCp.leetcode} />}
          {selfCp?.codeforces && <CpMiniCard title="Codeforces" data={selfCp.codeforces} />}
          {selfCp?.codechef   && <CpMiniCard title="CodeChef"   data={selfCp.codechef} />}
        </div>

        <div className="section-label" style={{ marginTop: 16 }}>
          Solved today · {todaysSolved.length}
        </div>
        {todaysSolved.length === 0 && (
          <div className="muted">Nothing logged today. Solve one and hit Refresh.</div>
        )}
        {todaysSolved.map((s, i) => (
          <div key={i} className="todo-row">
            <span className={"pill " + platformPillColor(s.platform)}>{s.platform}</span>
            <div style={{ flex: 1 }}>
              <a href="#" onClick={(e) => { e.preventDefault(); api.ext.open(s.url); }}>
                <strong>{s.title}</strong>
              </a>
              <div className="sub">
                {s.verdict && <span className="pill gray">{s.verdict}</span>}
                {s.rating != null && <span className="pill gray" style={{ marginLeft: 4 }}>rating {s.rating}</span>}
                {Array.isArray(s.tags) && s.tags.slice(0, 4).map((t) => (
                  <span key={t} className="pill" style={{ marginLeft: 4 }}>{t}</span>
                ))}
                <small className="muted" style={{ marginLeft: 6 }}>{new Date(s.submitted_at).toLocaleTimeString()}</small>
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
      <div className="row between"><div className="card-title">{title}</div><small className="muted">@{data.handle}</small></div>
      {data.rating != null && <div>Rating: <strong>{data.rating}</strong>{data.maxRating ? <small className="muted"> (max {data.maxRating})</small> : null}</div>}
      {data.totalSolved != null && <div>Solved: <strong>{data.totalSolved}</strong>{data.easy != null ? <small className="muted"> · {data.easy}E / {data.medium}M / {data.hard}H</small> : null}</div>}
      {data.stars != null && <div>Stars: <strong>{data.stars}★</strong></div>}
    </div>
  );
}

function SliderRow({ label, value, onChange, kind }) {
  return (
    <div className={`slider-row ${kind}`}>
      <div className="muted">{label}</div>
      <input type="range" min={1} max={10} value={value ?? 5} onChange={(e) => onChange(+e.target.value)} />
      <div className="val">{value ?? "-"}/10</div>
    </div>
  );
}

function AskApexDrawer({ model, ollamaOk, onClose }) {
  const [q, setQ] = useState("");
  const [a, setA] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function ask() {
    if (!q.trim() || !ollamaOk || !model) return;
    setLoading(true); setErr(null); setA(null);
    const res = await api.ollama.chat({
      model,
      system: `You are Apex, a calm, precise assistant for a CS student (Yashasvi). Be concise. Short paragraphs or compact bullets. Prefer concrete steps over pep talk. For code, one short example. For strategy, 3-step plan + one sentence of reasoning.`,
      user: q,
    });
    setLoading(false);
    if (!res.ok) setErr(res.error || "Ollama error");
    else setA(res.content);
  }

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="row between">
          <h3 style={{ margin: 0 }}>Ask Apex</h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <p className="muted" style={{ margin: "4px 0 10px" }}>
          Freeform chat with your local Ollama. System design tradeoff, a weird bug, a study plan.
        </p>
        <textarea rows={4} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. Pragmatic way to study binary search variants in two weeks?"
          onKeyDown={(e) => { if (e.ctrlKey && e.key === "Enter") ask(); }} />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary" onClick={ask} disabled={!ollamaOk || !model || loading || !q.trim()}>
            {loading ? "Thinking…" : "Ask (Ctrl+Enter)"}
          </button>
          {err && <span className="error">{err}</span>}
        </div>
        {a && (
          <div className="plan-block" style={{ marginTop: 14, whiteSpace: "pre-wrap" }}>{a}</div>
        )}
      </div>
    </div>
  );
}

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
    case "walk":     return "teal";
    case "exercise": return "teal";
    case "work":
    case "focus":    return "amber";
    case "warn":
    case "reduce":   return "rose";
    default: return "gray";
  }
}
function platformPillColor(plat) {
  if (plat === "leetcode") return "amber";
  if (plat === "codeforces") return "teal";
  if (plat === "codechef") return "rose";
  return "gray";
}
function shortUrl(u) {
  try { const p = new URL(u); return p.hostname.replace(/^www\./, "") + (p.pathname === "/" ? "" : p.pathname.slice(0, 22)); }
  catch { return u.slice(0, 32); }
}
function energyMessage({ sleep, clarity, dread, energy }) {
  const e = energy ?? 5, d = dread ?? 5;
  if (e <= 3) return "Low energy. Today is for one small win — a single LC easy + a walk is enough.";
  if (d >= 7) return "Dread is high. Start with the smallest task on your list. Momentum beats plans.";
  if (e <= 5) return "Moderate energy. Cap deep work at 60 min. One LC problem + a short walk is a win.";
  if (clarity >= 8 && sleep >= 7) return "Good day to tackle a hard problem. 90-min deep session, then break.";
  return "Steady day. Two sessions of 45-60 min with a walk between them.";
}
function tryParse(raw) { try { return JSON.parse(raw); } catch { return null; } }
