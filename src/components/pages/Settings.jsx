import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import ScheduleEditor from "../ScheduleEditor.jsx";
import WeeklyGoalsEditor from "../WeeklyGoalsEditor.jsx";
import { prettyAppName } from "../../lib/appName.js";

const TABS = [
  { key: "schedule",  label: "Schedule" },
  { key: "activity",  label: "Activity" },
  { key: "wellbeing", label: "Mobile wellbeing" },
  { key: "goals",     label: "Weekly goals" },
  { key: "cp",        label: "Competitive programming" },
  { key: "ollama",    label: "Ollama" },
  { key: "github",    label: "GitHub" },
  { key: "seed",      label: "Seed content" },
  { key: "backup",    label: "Backup" },
];

export default function Settings() {
  const [tab, setTab] = useState("schedule");
  const [all, setAll] = useState({});
  const [msg, setMsg] = useState(null);

  useEffect(() => { reload(); }, []);
  async function reload() { setAll(await api.settings.all()); }

  async function save(key, value) {
    await api.settings.set(key, value);
    setMsg(`Saved ${key}`);
    setTimeout(() => setMsg(null), 1400);
    reload();
  }

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Local-only. All keys stored in SQLite at Documents/Apex.</p>

      <div className="chip-row" style={{ marginBottom: 16, gap: 6, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button key={t.key} className={"chip" + (tab === t.key ? " active" : "")} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "schedule"  && <ScheduleTab all={all} setAll={setAll} save={save} setMsg={setMsg} />}
      {tab === "activity"  && <ActivityTab all={all} setAll={setAll} save={save} setMsg={setMsg} />}
      {tab === "wellbeing" && <WellbeingTab all={all} setAll={setAll} save={save} setMsg={setMsg} />}
      {tab === "goals"     && <WeeklyGoalsEditor />}
      {tab === "cp"        && <CpTab all={all} setAll={setAll} save={save} />}
      {tab === "ollama"    && <OllamaTab all={all} setAll={setAll} save={save} />}
      {tab === "github"    && <GithubTab all={all} setAll={setAll} save={save} />}
      {tab === "seed"      && <SeedTab setMsg={setMsg} />}
      {tab === "backup"    && <BackupTab setMsg={setMsg} />}

      {msg && <div style={{ position: "fixed", bottom: 20, right: 20 }} className="pill teal">{msg}</div>}
    </>
  );
}

function ScheduleTab({ all, setAll, save, setMsg }) {
  // SRM session state — primary path is browser-login (cookies live in a
  // persistent Electron partition so a one-time sign-in is enough).
  const [sess, setSess] = useState({
    saved: false,
    username: null,
    sessionActive: false,
  });
  const [opening, setOpening] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagReport, setDiagReport] = useState(null);

  async function runDiagnose() {
    setDiagnosing(true);
    setDiagReport(null);
    try {
      const r = await api.srm.diagnose();
      setDiagReport(r);
      setMsg(r?.suggestion || "Diagnostic done. See report below.");
    } catch (e) {
      setMsg("Diagnose failed: " + (e?.message || "unknown"));
    } finally {
      setDiagnosing(false);
    }
  }

  useEffect(() => {
    refreshState();
  }, []);

  async function refreshState() {
    try {
      const r = await api.srm.hasCreds();
      setSess({
        saved: !!r?.saved,
        username: r?.username || null,
        sessionActive: !!r?.sessionActive,
      });
    } catch { /* ignore */ }
  }

  async function openLogin() {
    setOpening(true);
    setMsg("Opening SRM login…");
    try {
      const r = await api.srm.openLoginWindow();
      await refreshState();
      if (r?.loggedIn) {
        setMsg("Signed in to SRM. Click Sync now to pull your timetable.");
      } else {
        setMsg(
          "Login window closed without an active session. Try again — make sure you reach your portal home before closing.",
        );
      }
    } finally {
      setOpening(false);
    }
  }

  async function logoutSrm() {
    if (!confirm("Sign out of SRM Academia inside Apex?")) return;
    await api.srm.logout();
    await refreshState();
    setMsg("SRM session cleared.");
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const res = await api.srm.syncNow({});
      setLastSync(res);
      if (res?.ok) {
        setMsg(
          `Synced ${res.classes} classes` +
          (res.calendar_rows ? ` + ${res.calendar_rows} calendar dates` : "") +
          (res.student?.name ? ` for ${res.student.name}` : "") + ".",
        );
        await refreshState();
      } else if (res?.needsLogin) {
        setMsg(
          res.error +
            " Click \"Log in to SRM\" to sign in — Apex will remember the session.",
        );
        await refreshState();
      } else {
        setMsg("Sync failed: " + (res?.error || "unknown"));
      }
    } finally {
      setSyncing(false);
    }
  }

  async function pickJson() {
    const p = await api.settings.pickFile([{ name: "JSON", extensions: ["json"] }]);
    if (!p) return;
    const res = await api.schedule.parseJson(p);
    if (res?.ok && Array.isArray(res.rows)) {
      await api.schedule.replaceAll(res.rows);
      setMsg(`Imported ${res.rows.length} rows from ${p}`);
    } else setMsg("Parse failed: " + (res?.error || "unknown"));
  }

  function scrollToEditor() {
    const el = document.getElementById("schedule-editor");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">SRM Academia · auto-sync</div>
        <small className="hint" style={{ display: "block", marginBottom: 10 }}>
          Sign in once through a real browser window. Apex remembers the
          session in a private partition and pulls your timetable and
          academic-planner day orders on demand. Captchas, MFA, and password
          changes are handled by your actual login flow — Apex never sees
          your password.
        </small>

        <div
          className="row"
          style={{
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--bg-elev)",
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: sess.sessionActive ? "#5fe0d3" : "#ef6b5a",
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>
              {sess.sessionActive ? "Signed in" : "Not signed in"}
              {sess.username && sess.sessionActive ? (
                <span className="muted" style={{ marginLeft: 6 }}>
                  · {sess.username}
                </span>
              ) : null}
            </div>
            <small className="muted" style={{ display: "block", marginTop: 2 }}>
              {sess.sessionActive
                ? "Apex has a live SRM Academia session cookie. Sync any time."
                : "Click \"Log in to SRM\" — a real browser window will open. Sign in there, then close it."}
            </small>
          </div>
          <div className="row" style={{ gap: 6, flexShrink: 0 }}>
            <button
              className="primary"
              onClick={openLogin}
              disabled={opening}
              title="Open the SRM Academia login in a child window"
            >
              {opening
                ? "Opening…"
                : sess.sessionActive
                  ? "Re-sign in"
                  : "Log in to SRM"}
            </button>
            {sess.sessionActive && (
              <button
                type="button"
                className="ghost small"
                onClick={logoutSrm}
                title="Clear cookies"
              >
                Sign out
              </button>
            )}
          </div>
        </div>

        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 12 }}>
          <button
            className="primary"
            onClick={syncNow}
            disabled={syncing || !sess.sessionActive}
            title={
              sess.sessionActive
                ? "Pull timetable + academic calendar from SRM"
                : "Sign in first"
            }
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={runDiagnose}
            disabled={diagnosing}
            title="Probe every URL/prefix combo and show what SRM is returning"
          >
            {diagnosing ? "Diagnosing…" : "🔬 Diagnose"}
          </button>
        </div>

        {diagReport && <SrmDiagnosePanel report={diagReport} />}

        {lastSync?.ok && (
          <small className="hint" style={{ display: "block", marginTop: 10 }}>
            Last sync: <strong>{lastSync.classes}</strong> classes
            {lastSync.calendar_rows ? ` · ${lastSync.calendar_rows} calendar dates` : ""}
            {lastSync.student?.semester ? ` · semester ${lastSync.student.semester}` : ""}
            {lastSync.planner ? ` · planner ${lastSync.planner}` : ""}.
          </small>
        )}
        {lastSync && !lastSync.ok && (
          <div className="error" style={{ marginTop: 8 }}>
            {lastSync.error || "Sync failed."}
            {lastSync.needsLogin && (
              <button
                type="button"
                className="ghost small"
                style={{ marginLeft: 8 }}
                onClick={openLogin}
              >
                Log in to SRM
              </button>
            )}
          </div>
        )}

        <hr className="soft" />

        <div style={{ marginBottom: 6, fontWeight: 600 }}>Other import paths</div>
        <small className="hint" style={{ display: "block", marginBottom: 8 }}>
          Use these when SRM Academia is unreachable (downtime).
        </small>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <button onClick={pickJson} title="Pick any timetable.json file">
            Import timetable.json…
          </button>
          <button
            onClick={scrollToEditor}
            title="Use Ollama vision to OCR a photo or screenshot of your timetable"
          >
            Import from image…
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Day-order anchor (fallback)</div>
        <p className="muted" style={{ margin: "4px 0 10px" }}>
          Used only if the academic calendar hasn't been synced. The calendar overrides are always authoritative when present.
        </p>
        <div className="grid-2">
          <div className="form-row">
            <label>Anchor date</label>
            <input
              type="date"
              value={all["timetable.anchorDate"] || ""}
              onChange={(e) => setAll({ ...all, "timetable.anchorDate": e.target.value })}
              onBlur={(e) => save("timetable.anchorDate", e.target.value)}
            />
          </div>
          <div className="form-row">
            <label>Day order on that date</label>
            <select
              value={all["timetable.anchorOrder"] || "1"}
              onChange={(e) => { setAll({ ...all, "timetable.anchorOrder": e.target.value }); save("timetable.anchorOrder", e.target.value); }}
            >
              {[1, 2, 3, 4, 5].map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div id="schedule-editor">
        <ScheduleEditor />
      </div>
    </>
  );
}

function ActivityTab({ all, setAll, save, setMsg }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { refresh(); }, []);
  async function refresh() { setStatus(await api.tracker.status()); }

  async function start() {
    setLoading(true);
    await api.tracker.start();
    await api.settings.set("activity.tracking", "1");
    await refresh();
    setLoading(false);
    setMsg("Activity tracker started.");
  }
  async function stop() {
    setLoading(true);
    await api.tracker.stop();
    await api.settings.set("activity.tracking", "0");
    await refresh();
    setLoading(false);
    setMsg("Activity tracker stopped.");
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between">
          <div className="card-title">Desktop activity tracker</div>
          <span className={"pill " + (status?.running ? "teal" : "gray")}>
            {status?.running ? "running" : "off"}
          </span>
        </div>
        <p className="muted">
          Samples the foreground window every ~30s. Classifies each app as productive / distraction / leisure / other. Nudges you after {all["activity.nudgeAfterMin"] || 45} min on one app so you actually take breaks.
        </p>
        <div className="row">
          {status?.running
            ? <button onClick={stop} disabled={loading}>Stop tracker</button>
            : <button className="primary" onClick={start} disabled={loading}>Start tracker</button>}
          <small className="muted">
            {status?.running && status.current ? `Currently: ${prettyAppName(status.current.app)} (${status.current.minutes || 0} min, ${status.current.category})` : ""}
          </small>
        </div>
        <hr className="soft" />
        <div className="grid-2">
          <div className="form-row">
            <label>Nudge after (minutes on one app)</label>
            <input type="number" min={10} max={240} step={5}
              value={all["activity.nudgeAfterMin"] || 45}
              onChange={(e) => setAll({ ...all, "activity.nudgeAfterMin": e.target.value })}
              onBlur={(e) => save("activity.nudgeAfterMin", e.target.value)} />
          </div>
          <div className="form-row">
            <label>Idle threshold (minutes without input)</label>
            <input type="number" min={1} max={60} step={1}
              value={all["activity.idleThresholdMin"] || 5}
              onChange={(e) => setAll({ ...all, "activity.idleThresholdMin": e.target.value })}
              onBlur={(e) => save("activity.idleThresholdMin", e.target.value)} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">App categorization overrides</div>
        <p className="muted">Manually reclassify specific apps. Applies to all future samples (old sessions keep their original category).</p>
        <CategorizationOverrides />
      </div>

      <BatteryReportCard setMsg={setMsg} />
    </>
  );
}

// Windows-only: run `powercfg /batteryreport` and show per-day active time.
// Complements the per-app tracker (works even when the tracker is off).
function BatteryReportCard({ setMsg }) {
  const [supported, setSupported] = useState(null);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => { (async () => {
    const s = await api.battery.supported();
    setSupported(!!s?.supported);
    if (s?.supported) {
      const cached = await api.battery.latest();
      if (cached?.ok) setData(cached);
    }
  })(); }, []);

  async function refresh() {
    setLoading(true); setErr("");
    const res = await api.battery.run(14);
    setLoading(false);
    if (res?.ok) { setData(res); setMsg("Battery report refreshed."); }
    else setErr(res?.error || "Failed to run powercfg.");
  }

  if (supported === false) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-title">Desktop screen time (battery report)</div>
        <p className="muted">Only available on Windows — this reads <code>powercfg /batteryreport</code>.</p>
      </div>
    );
  }
  if (supported === null) return null;

  const days = (data?.days || []).slice(0, 14);
  const total = days.reduce((s, d) => s + (d.active_minutes || 0), 0);
  const avg = days.length ? Math.round(total / days.length) : 0;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row between">
        <div className="card-title">Desktop screen time (battery report)</div>
        <button className="small primary" onClick={refresh} disabled={loading}>
          {loading ? "Reading…" : (data ? "Refresh" : "Run now")}
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 4 }}>
        Derived from Windows' own battery/usage history — active foreground time per day for the last 14 days.
        Works even when Apex's per-app tracker is off.
      </p>

      {err && <div className="error" style={{ marginTop: 8 }}>{err}</div>}

      {!data && !err && (
        <div className="muted" style={{ marginTop: 8 }}>
          No report yet. Hit <strong>Run now</strong> — takes a few seconds.
        </div>
      )}

      {data && (
        <>
          <div className="row" style={{ gap: 18, marginTop: 10, flexWrap: "wrap" }}>
            <div>
              <div className="muted small">Last 14 days</div>
              <strong style={{ fontSize: 18 }}>{fmtHM(total)}</strong>
            </div>
            <div>
              <div className="muted small">Daily avg</div>
              <strong style={{ fontSize: 18 }}>{fmtHM(avg)}</strong>
            </div>
            <div>
              <div className="muted small">Generated</div>
              <div>{data.generatedAt ? new Date(data.generatedAt).toLocaleString() : "—"}</div>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            {days.map((d) => {
              const pct = Math.min(100, Math.round((d.active_minutes / Math.max(1, Math.max(...days.map((x) => x.active_minutes || 1)))) * 100));
              return (
                <div key={d.date} className="row" style={{ gap: 10, alignItems: "center", margin: "2px 0" }}>
                  <small className="muted" style={{ width: 86 }}>{d.date}</small>
                  <div className="bar" style={{ flex: 1, height: 6 }}>
                    <div className="bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <small style={{ width: 54, textAlign: "right" }}>{fmtHM(d.active_minutes)}</small>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function fmtHM(mins) {
  if (!mins || mins <= 0) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function CategorizationOverrides() {
  const [list, setList] = useState([]);
  const [form, setForm] = useState({ app: "", category: "productive" });

  useEffect(() => { (async () => {
    const all = await api.settings.all();
    setList(Object.entries(all)
      .filter(([k]) => k.startsWith("activity.overrides."))
      .map(([k, v]) => ({ app: k.replace("activity.overrides.", ""), category: v }))
      .sort((a, b) => a.app.localeCompare(b.app)));
  })(); }, []);

  async function add() {
    if (!form.app.trim()) return;
    await api.settings.set("activity.overrides." + form.app.trim(), form.category);
    const all = await api.settings.all();
    setList(Object.entries(all)
      .filter(([k]) => k.startsWith("activity.overrides."))
      .map(([k, v]) => ({ app: k.replace("activity.overrides.", ""), category: v })));
    setForm({ app: "", category: "productive" });
  }
  async function remove(app) {
    await api.settings.set("activity.overrides." + app, "");
    setList(list.filter((x) => x.app !== app));
  }

  return (
    <>
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <input placeholder="exe name (e.g. Code.exe, chrome.exe)" value={form.app} onChange={(e) => setForm({ ...form, app: e.target.value })} />
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          <option value="productive">productive</option>
          <option value="distraction">distraction</option>
          <option value="leisure">leisure</option>
          <option value="other">other</option>
        </select>
        <button className="primary" onClick={add}>Add</button>
      </div>
      {list.length === 0 && <div className="muted">No overrides yet.</div>}
      {list.map((x) => (
        <div key={x.app} className="row between" style={{ margin: "6px 0" }}>
          <span><code>{x.app}</code> <small className="muted">({prettyAppName(x.app)})</small> → <span className="pill">{x.category}</span></span>
          <button className="ghost small" onClick={() => remove(x.app)}>✕ remove</button>
        </div>
      ))}
    </>
  );
}

function WellbeingTab({ all, setAll, save, setMsg }) {
  const [devices, setDevices] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [last, setLast] = useState(null);

  useEffect(() => { refresh(); }, []);
  async function refresh() {
    setDevices(await api.wellbeing.devices());
    setLast(all["wellbeing.lastSyncAt"]);
  }
  async function pickAdb() {
    const p = await api.settings.pickFile([{ name: "adb", extensions: ["exe", ""] }]);
    if (!p) return;
    save("wellbeing.adbPath", p);
  }
  async function sync() {
    setSyncing(true);
    const res = await api.wellbeing.syncNow();
    setSyncing(false);
    if (res?.ok) {
      setMsg(`Mobile: ${res.count} apps, ${res.total_minutes} min · device ${res.device}`);
      await refresh();
    } else {
      setMsg("Sync failed: " + (res?.error || "unknown"));
    }
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Android Digital Wellbeing via ADB</div>
        <p className="muted">
          Connect your phone over USB with <strong>USB Debugging</strong> enabled. Run <code>adb devices</code> once from a terminal and authorize the prompt. Apex reads <code>adb shell dumpsys usagestats</code> and turns per-app foreground time into Activity sessions tagged <code>source='mobile'</code>.
        </p>
        <div className="form-row">
          <label>adb path (optional — uses PATH if blank)</label>
          <div className="row">
            <input value={all["wellbeing.adbPath"] || ""} placeholder="C:\platform-tools\adb.exe"
              onChange={(e) => setAll({ ...all, "wellbeing.adbPath": e.target.value })}
              onBlur={(e) => save("wellbeing.adbPath", e.target.value)} />
            <button onClick={pickAdb}>Pick…</button>
          </div>
        </div>

        <hr className="soft" />
        <div className="row between">
          <div>
            <strong>Devices:</strong> {devices.length === 0 ? <span className="muted">none connected</span> :
              devices.map((d) => <span key={d.serial} className="pill teal" style={{ marginLeft: 6 }}>{d.serial}</span>)}
          </div>
          <div className="row">
            <button onClick={refresh}>Refresh</button>
            <button className="primary" onClick={sync} disabled={syncing || devices.length === 0}>
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
        </div>
        {last && <small className="hint" style={{ display: "block", marginTop: 10 }}>Last sync: {new Date(last).toLocaleString()}</small>}
      </div>
    </>
  );
}

function CpTab({ all, setAll, save }) {
  const [selfStats, setSelfStats] = useState(null);
  const [loading, setLoading] = useState(false);

  async function refreshSelf() {
    setLoading(true);
    try { setSelfStats(await api.cp.self()); }
    finally { setLoading(false); }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">My handles</div>
      <HandleRow k="cp.leetcode"   label="LeetCode"   all={all} setAll={setAll} save={save} />
      <HandleRow k="cp.codeforces" label="Codeforces" all={all} setAll={setAll} save={save} />
      <HandleRow k="cp.codechef"   label="CodeChef"   all={all} setAll={setAll} save={save} />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" onClick={refreshSelf} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh stats now"}
        </button>
      </div>
      {selfStats?.results && (
        <div style={{ marginTop: 10 }}>
          {Object.entries(selfStats.results).map(([plat, r]) => (
            <div key={plat} className="sub" style={{ marginTop: 6 }}>
              <strong>{plat}</strong>: {r.ok
                ? `@${r.handle} · solved ${r.totalSolved ?? "—"}${r.rating ? ` · rating ${r.rating}` : ""}`
                : <span className="muted">error — {r.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HandleRow({ k, label, all, setAll, save }) {
  return (
    <div className="form-row">
      <label>{label}</label>
      <input
        value={all[k] || ""}
        placeholder={`your ${label} username`}
        onChange={(e) => setAll({ ...all, [k]: e.target.value })}
        onBlur={(e) => save(k, e.target.value)}
      />
    </div>
  );
}

function OllamaTab({ all, setAll, save }) {
  const [models, setModels] = useState([]);
  const [ok, setOk] = useState(null);
  const [best, setBest] = useState(null);
  const [starting, setStarting] = useState(false);

  const profile = (() => {
    try { return JSON.parse(all["user.profile"] || "{}"); } catch { return {}; }
  })();
  function saveProfile(next) {
    const json = JSON.stringify(next);
    setAll({ ...all, "user.profile": json });
    save("user.profile", json);
  }

  async function refresh() {
    const [r, b] = await Promise.all([
      api.ollama.listModels(),
      api.ollama.best().catch(() => ({ model: null })),
    ]);
    setModels(r?.models || []);
    setOk(r?.ok);
    setBest(b?.model || null);
  }

  async function startOllama() {
    setStarting(true);
    try {
      const r = await api.ollama.start?.();
      if (r?.ok) await refresh();
    } finally {
      setStarting(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const autoStart = (all["ollama.autoStart"] ?? "true") === "true";

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between">
          <div className="card-title">Ollama</div>
          <span className={"pill " + (ok ? "teal" : "rose")}>
            {ok === null ? "…" : ok ? "connected" : "offline"}
          </span>
        </div>

        {!ok && ok !== null && (
          <div className="row" style={{ gap: 8, marginTop: 6 }}>
            <button className="primary small" onClick={startOllama} disabled={starting}>
              {starting ? "Starting…" : "Start Ollama"}
            </button>
            <small className="muted">
              We'll launch <code>ollama app.exe</code> and retry for ~15s.
            </small>
          </div>
        )}

        <div className="form-row">
          <label>Host</label>
          <input value={all["ollama.host"] || ""} placeholder="http://127.0.0.1:11434"
            onChange={(e) => setAll({ ...all, "ollama.host": e.target.value })}
            onBlur={(e) => save("ollama.host", e.target.value)} />
        </div>
        <div className="form-row">
          <label>Preferred model</label>
          <div className="row">
            {models.length > 0 ? (
              <select value={all["ollama.model"] || ""} style={{ maxWidth: 260 }}
                onChange={(e) => { setAll({ ...all, "ollama.model": e.target.value }); save("ollama.model", e.target.value); }}>
                <option value="">(auto-pick{best ? ` → ${best}` : ""})</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <input value={all["ollama.model"] || ""} placeholder="gpt-oss:120b-cloud"
                onChange={(e) => setAll({ ...all, "ollama.model": e.target.value })}
                onBlur={(e) => save("ollama.model", e.target.value)} />
            )}
            <button onClick={refresh}>↻ Refresh</button>
          </div>
          <small className="hint">
            Auto-pick priority: <code>gpt-oss:120b-cloud</code> → <code>llama3:latest</code> → <code>gemma3:4b</code> → others.
          </small>
        </div>
        <div className="form-row">
          <label className="row" style={{ gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={autoStart}
              onChange={(e) => { setAll({ ...all, "ollama.autoStart": String(e.target.checked) }); save("ollama.autoStart", String(e.target.checked)); }} />
            Auto-start Ollama when Apex launches
          </label>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Personal context</div>
        <small className="muted">
          Gets injected into every Ollama prompt (Plan, Ask Apex, burnout, evening review). Stays on this machine.
        </small>
        <div className="grid-2" style={{ marginTop: 8 }}>
          <div className="form-row">
            <label>Name</label>
            <input value={profile.name || ""} placeholder="Yashasvi"
              onChange={(e) => saveProfile({ ...profile, name: e.target.value })} />
          </div>
          <div className="form-row">
            <label>College</label>
            <input value={profile.college || ""} placeholder="SRM Institute of Science and Technology"
              onChange={(e) => saveProfile({ ...profile, college: e.target.value })} />
          </div>
          <div className="form-row">
            <label>Major</label>
            <input value={profile.major || ""} placeholder="Computer Science"
              onChange={(e) => saveProfile({ ...profile, major: e.target.value })} />
          </div>
          <div className="form-row">
            <label>Year</label>
            <input value={profile.year || ""} placeholder="2"
              onChange={(e) => saveProfile({ ...profile, year: e.target.value })} />
          </div>
        </div>
        <div className="form-row">
          <label>Interests (comma-separated)</label>
          <input value={Array.isArray(profile.interests) ? profile.interests.join(", ") : (profile.interests || "")}
            placeholder="systems, AI tooling, competitive programming, local-first apps"
            onChange={(e) => saveProfile({ ...profile, interests: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />
        </div>
        <div className="form-row">
          <label>Long-term goals</label>
          <textarea rows={2} value={profile.goals || ""}
            placeholder="become a strong systems + AI engineer; ship personal projects weekly; stay healthy."
            onChange={(e) => saveProfile({ ...profile, goals: e.target.value })} />
        </div>
        <div className="form-row">
          <label>Preferred tone</label>
          <input value={profile.tone || ""} placeholder="calm, precise, no pep talk, no hedging"
            onChange={(e) => saveProfile({ ...profile, tone: e.target.value })} />
        </div>
        <div className="form-row">
          <label>Extra context (free-form, structured note)</label>
          <textarea rows={3} value={all["user.extraContext"] || ""}
            placeholder="Anything else the model should know — constraints, preferences, ongoing projects…"
            onChange={(e) => setAll({ ...all, "user.extraContext": e.target.value })}
            onBlur={(e) => save("user.extraContext", e.target.value)} />
        </div>
      </div>

      {/* About me — free-form profile prompt the user can paste from any
          other LLM ("write a profile of me as if I were briefing my own
          assistant"). Goes to the TOP of every system prompt. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">About me · profile prompt</div>
        <small className="hint" style={{ display: "block", marginBottom: 10 }}>
          A free-form description of you, your work style, ongoing projects,
          how you want help framed. This sits at the TOP of every Ollama
          prompt — recommendations, plan-day, evening review, repo chat all
          see it. Paste from another LLM if you want; tweak as needed.
        </small>
        <div className="form-row">
          <label>
            Who am I?
            <button
              type="button"
              className="ghost xsmall"
              style={{ marginLeft: 8 }}
              onClick={() => {
                const seed =
                  "I'm a CS undergrad at SRM Kattankulathur. I care about " +
                  "shipping real things — local-first apps, AI tooling, " +
                  "competitive programming. I prefer concrete, specific advice " +
                  "over motivational fluff. When I ask for a plan I want " +
                  "realistic time estimates, not aspirational ones. I'm " +
                  "currently most interested in: [your current obsessions].";
                setAll({ ...all, "user.aboutMe": seed });
                save("user.aboutMe", seed);
              }}
              title="Insert a starter you can edit"
            >
              Insert starter
            </button>
            {(all["user.aboutMe"] || "").trim() && (
              <button
                type="button"
                className="ghost xsmall"
                style={{ marginLeft: 6 }}
                onClick={() => {
                  if (!confirm("Clear your About-me prompt?")) return;
                  setAll({ ...all, "user.aboutMe": "" });
                  save("user.aboutMe", "");
                }}
              >
                Clear
              </button>
            )}
          </label>
          <textarea
            rows={8}
            value={all["user.aboutMe"] || ""}
            placeholder={
              "Paste from another LLM, or write your own. e.g.:\n\n" +
              "I'm a fourth-year CS student building a personal productivity tool…\n" +
              "I prefer terse, technical advice. When stuck, ask me one clarifying question rather than guessing.\n" +
              "Currently grinding LeetCode mediums + system design fundamentals."
            }
            onChange={(e) => setAll({ ...all, "user.aboutMe": e.target.value })}
            onBlur={(e) => save("user.aboutMe", e.target.value)}
            style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12, lineHeight: 1.5 }}
          />
          <small className="hint" style={{ marginTop: 6 }}>
            Apex also auto-pulls your courses, today's classes, open tasks,
            completed-today, and any active timer into every prompt — no need
            to repeat that here.
          </small>
        </div>
      </div>
    </>
  );
}

// Renders the rich debug payload returned by api.srm.diagnose(). Shows a
// summary suggestion + a collapsed table of every fetch attempt so the
// user can see exactly what each URL/prefix combo did.
function SrmDiagnosePanel({ report }) {
  if (!report) return null;
  return (
    <div
      style={{
        marginTop: 12,
        padding: 12,
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--bg-elev)",
      }}
    >
      <div className="row between" style={{ alignItems: "center" }}>
        <strong>Diagnostic report</strong>
        <small className="muted">
          {report.cookieCount} cookies ·{" "}
          {report.isLoggedIn ? "session active" : "session inactive"}
        </small>
      </div>
      {report.suggestion && (
        <p style={{ margin: "8px 0", fontSize: 13 }}>
          <strong>↳ </strong>
          {report.suggestion}
        </p>
      )}
      {report.savedTo && (
        <small className="muted" style={{ display: "block", marginBottom: 8 }}>
          Saved to <code>{report.savedTo}</code>
        </small>
      )}

      <details style={{ marginTop: 8 }} open>
        <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
          Timetable attempts ({report.timetableAttempts?.length || 0})
        </summary>
        <div
          style={{
            marginTop: 6,
            maxHeight: 320,
            overflow: "auto",
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <table className="diag-table" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Slug</th>
                <th>Status</th>
                <th>Body</th>
                <th>sanitize()</th>
                <th>course_tbl</th>
                <th>login</th>
              </tr>
            </thead>
            <tbody>
              {(report.timetableAttempts || []).map((a, i) => (
                <tr key={i}>
                  <td title={a.url} style={{ fontFamily: "monospace" }}>
                    {a.slug}
                    <br />
                    <small className="muted">{a.url}</small>
                  </td>
                  <td style={{ textAlign: "center" }}>{a.status ?? "—"}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {a.bodyLen}
                  </td>
                  <td style={{ textAlign: "center" }}>{a.sanitizeMatches}</td>
                  <td style={{ textAlign: "center" }}>
                    {a.courseTblFound ? "✓" : a.mainDivFound ? "div" : "—"}
                  </td>
                  <td style={{ textAlign: "center" }}>{a.looksLikeLogin ? "⚠" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
          Calendar attempts ({report.calendarAttempts?.length || 0})
        </summary>
        <div
          style={{
            marginTop: 6,
            maxHeight: 240,
            overflow: "auto",
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          <table className="diag-table" style={{ width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Slug</th>
                <th>Status</th>
                <th>Body</th>
                <th>sanitize()</th>
                <th>DO col</th>
                <th>login</th>
              </tr>
            </thead>
            <tbody>
              {(report.calendarAttempts || []).map((a, i) => (
                <tr key={i}>
                  <td title={a.url} style={{ fontFamily: "monospace" }}>
                    {a.slug}
                    <br />
                    <small className="muted">{a.url}</small>
                  </td>
                  <td style={{ textAlign: "center" }}>{a.status ?? "—"}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {a.bodyLen}
                  </td>
                  <td style={{ textAlign: "center" }}>{a.sanitizeMatches}</td>
                  <td style={{ textAlign: "center" }}>{a.hasDoColumn ? "✓" : "—"}</td>
                  <td style={{ textAlign: "center" }}>{a.looksLikeLogin ? "⚠" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {report.cookieNames?.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
            Session cookies ({report.cookieNames.length})
          </summary>
          <code style={{ display: "block", fontSize: 11, marginTop: 4, wordBreak: "break-all" }}>
            {report.cookieNames.join(", ")}
          </code>
        </details>
      )}
    </div>
  );
}

function GithubTab({ all, setAll, save }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">GitHub</div>
      <div className="form-row">
        <label>Personal access token (optional — boosts rate limit to 5000/hr)</label>
        <input type="password" value={all["github.token"] || ""} placeholder="ghp_…"
          onChange={(e) => setAll({ ...all, "github.token": e.target.value })}
          onBlur={(e) => save("github.token", e.target.value)} />
        <small className="hint">
          github.com → Settings → Developer settings → PAT. Needs <code>read:user</code> + <code>public_repo</code>.
        </small>
      </div>
    </div>
  );
}

// Seed tab — one-click bulk insert of CS-student-oriented starter content.
// Idempotent: each row is upserted by title so rerunning doesn't duplicate.
function SeedTab({ setMsg }) {
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  async function seed(kind) {
    setBusy(true);
    try {
      const payload = STARTERS[kind];
      let count = 0;
      for (const item of payload) {
        await api.tasks.create({
          kind: item.kind || "task",
          title: item.title,
          description: item.description || "",
          priority: item.priority || 3,
          category: item.category,
          course_code: item.course_code || null,
          estimated_minutes: item.estimated_minutes || null,
          recurrence_rule: item.recurrence_rule || null,
          tags: item.tags || [],
          links: item.links || [],
          status: item.status || "idea",
          progress: item.progress || 0,
        });
        count += 1;
      }
      setLastResult({ kind, count });
      setMsg(`Seeded ${count} ${kind}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">Seed starter content</div>
      <p className="muted">
        Quickly populate Apex with opinionated starter tasks / habits / interests for a CS student (DSA prep, side-project ideas, daily routines). Safe to run; adds in addition to whatever's already there.
      </p>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        <button className="primary" onClick={() => seed("tasks")} disabled={busy}>+ 8 starter tasks</button>
        <button onClick={() => seed("habits")} disabled={busy}>+ 6 habits</button>
        <button onClick={() => seed("interests")} disabled={busy}>+ 5 project interests</button>
      </div>
      {lastResult && (
        <small className="hint" style={{ display: "block", marginTop: 10 }}>
          Added {lastResult.count} items to <strong>{lastResult.kind}</strong>. Head to the Tasks page to see them.
        </small>
      )}
    </div>
  );
}

// Opinionated CS-student starter packs. Tweak freely.
const STARTERS = {
  tasks: [
    { title: "Solve 1 LC medium in <30 min today", category: "DSA", priority: 2, estimated_minutes: 30, tags: ["leetcode"] },
    { title: "Review one past LC solution and rewrite cleanly", category: "DSA", priority: 3, estimated_minutes: 25 },
    { title: "Push one small feature to a personal repo", category: "Project", priority: 3, estimated_minutes: 60 },
    { title: "Read 1 paper/blog post on system design", category: "Deep work", priority: 4, estimated_minutes: 30, tags: ["learning"] },
    { title: "Clean up inbox / email triage", category: "Personal", priority: 4, estimated_minutes: 15 },
    { title: "Update resume with latest project", category: "Personal", priority: 4, estimated_minutes: 30 },
    { title: "30-min walk (no phone)", category: "Health", priority: 3, estimated_minutes: 30 },
    { title: "Close one open lab assignment", category: "Academics", priority: 2, estimated_minutes: 90 },
  ],
  habits: [
    { kind: "habit", title: "1 LC problem · daily",     category: "DSA",       priority: 2, recurrence_rule: "daily", estimated_minutes: 30 },
    { kind: "habit", title: "Read 20 pages · daily",    category: "Leisure",   priority: 4, recurrence_rule: "daily", estimated_minutes: 25 },
    { kind: "habit", title: "Journal · evening",        category: "Personal",  priority: 4, recurrence_rule: "daily", estimated_minutes: 10 },
    { kind: "habit", title: "Gym · Mon/Wed/Fri",        category: "Health",    priority: 3, recurrence_rule: "weekly:mon|weekly:wed|weekly:fri", estimated_minutes: 60 },
    { kind: "habit", title: "Weekly review · Sun",      category: "Personal",  priority: 3, recurrence_rule: "weekly:sun", estimated_minutes: 30 },
    { kind: "habit", title: "No-phone wind-down · 30m", category: "Health",    priority: 4, recurrence_rule: "daily", estimated_minutes: 30 },
  ],
  interests: [
    { kind: "interest", title: "Local-first productivity app (Apex)", category: "Project", status: "building", progress: 40, tags: ["electron", "sqlite"] },
    { kind: "interest", title: "Raytracer in Rust",                    category: "Project", status: "idea",     progress: 0,  tags: ["rust", "graphics"] },
    { kind: "interest", title: "Minimal container runtime",            category: "Project", status: "idea",     progress: 0,  tags: ["linux", "go"] },
    { kind: "interest", title: "CP-style contest tracker",             category: "Project", status: "exploring", progress: 10, tags: ["cp", "web"] },
    { kind: "interest", title: "Paper-a-week reading club",            category: "Personal", status: "idea",     progress: 0,  tags: ["learning"] },
  ],
};

function BackupTab({ setMsg }) {
  const [dbInfo, setDbInfo] = useState(null);
  useEffect(() => { api.backup.info().then(setDbInfo); }, []);

  async function exportDb() {
    const res = await api.backup.export();
    if (res.ok) { setMsg("Backed up to " + res.path); setTimeout(() => setMsg(null), 3000); }
    else if (!res.canceled) setMsg("Error: " + (res.error || "unknown"));
  }
  async function importDb() {
    const res = await api.backup.import();
    if (res.ok) setMsg("Database replaced — Apex will relaunch.");
    else if (!res.canceled) setMsg("Error: " + (res.error || "unknown"));
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">Backup &amp; restore</div>
      {dbInfo && (
        <div className="muted" style={{ marginBottom: 10 }}>
          <div><b>Location:</b> <code>{dbInfo.path}</code></div>
          <div>
            <b>Size:</b> {(dbInfo.sizeBytes / 1024).toFixed(1)} KB
            {dbInfo.modified && <> · <b>last modified:</b> {new Date(dbInfo.modified).toLocaleString()}</>}
          </div>
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={exportDb}>Export backup…</button>
        <button onClick={importDb}>Import from backup…</button>
      </div>
      <small className="hint" style={{ display: "block", marginTop: 8 }}>
        Importing replaces your current database. The old DB is kept next to it as <code>apex-prev.sqlite</code>.
      </small>
    </div>
  );
}
