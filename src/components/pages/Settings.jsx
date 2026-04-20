import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import ScheduleEditor from "../ScheduleEditor.jsx";
import WeeklyGoalsEditor from "../WeeklyGoalsEditor.jsx";

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
  const [calendarInfo, setCalendarInfo] = useState(null);

  async function pickAcademia() {
    const f = await api.settings.pickDirectory();
    if (!f) return;
    save("timetable.folder", f);
    const res = await api.schedule.resyncFromAcademia(f);
    setMsg(res?.ok ? `Re-synced ${res.rows?.length ?? "?"} rows from AcademiaScraper.` : "Re-sync failed: " + (res?.error || "unknown"));
  }
  async function resyncNow() {
    const res = await api.schedule.resyncFromAcademia(all["timetable.folder"]);
    setMsg(res?.ok ? `Re-synced ${res.rows?.length ?? "?"} rows.` : "Re-sync failed: " + (res?.error || "unknown"));
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
  async function syncCalendar() {
    const folder = all["timetable.folder"];
    if (!folder) { setMsg("Set AcademiaScraper folder first."); return; }
    const res = await api.calendar.sync({ folder });
    setCalendarInfo(res);
    setMsg(res?.ok ? `Calendar: ${res.count} date→day-order overrides loaded.` : "Calendar sync failed: " + (res?.error || "unknown"));
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">AcademiaScraper</div>
        <div className="form-row">
          <label>Folder containing <code>data/timetable.json</code> + <code>calendar.html</code></label>
          <div className="row">
            <input
              value={all["timetable.folder"] || ""}
              placeholder="C:\Users\yashasvi\Documents\Python\AcademiaScraper"
              onChange={(e) => setAll({ ...all, "timetable.folder": e.target.value })}
            />
            <button onClick={pickAcademia}>Pick folder…</button>
            <button className="primary" onClick={resyncNow} disabled={!all["timetable.folder"]}>Re-sync timetable</button>
          </div>
        </div>
        <small className="hint">
          Re-sync reads <code>&lt;folder&gt;/data/timetable.json</code> and replaces all 5 day-orders.
        </small>
        <hr className="soft" />
        <div className="row">
          <button onClick={pickJson}>Import a timetable.json file…</button>
          <button className="primary" onClick={syncCalendar} disabled={!all["timetable.folder"]}>Sync academic calendar</button>
        </div>
        {calendarInfo?.ok && (
          <small className="hint" style={{ display: "block", marginTop: 8 }}>
            Loaded {calendarInfo.count} date→day-order overrides from calendar.html. Holidays + make-up days now respected.
          </small>
        )}
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

      <ScheduleEditor />
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
            {status?.running && status.current ? `Currently: ${status.current.app} (${status.current.minutes || 0} min, ${status.current.category})` : ""}
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
    </>
  );
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
          <span><code>{x.app}</code> → <span className="pill">{x.category}</span></span>
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

  useEffect(() => { (async () => {
    const r = await api.ollama.listModels();
    setModels(r?.models || []); setOk(r?.ok);
  })(); }, []);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between">
        <div className="card-title">Ollama</div>
        <span className={"pill " + (ok ? "teal" : "rose")}>{ok === null ? "…" : ok ? "connected" : "offline"}</span>
      </div>
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
              <option value="">(auto-pick)</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input value={all["ollama.model"] || ""} placeholder="llama3.2"
              onChange={(e) => setAll({ ...all, "ollama.model": e.target.value })}
              onBlur={(e) => save("ollama.model", e.target.value)} />
          )}
          <button onClick={async () => {
            const r = await api.ollama.listModels();
            setModels(r?.models || []); setOk(r?.ok);
          }}>↻ Refresh</button>
        </div>
        <small className="hint">
          If Ollama is running but nothing's installed, run <code>ollama pull llama3.2</code> in a terminal.
        </small>
      </div>
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
