import React, { useEffect, useMemo, useState } from "react";
import api from "../../lib/api.js";
import ScheduleEditor from "../ScheduleEditor.jsx";
import WeeklyGoalsEditor from "../WeeklyGoalsEditor.jsx";
import { prettyAppName } from "../../lib/appName.js";

// 7 high-level groups. Each group renders one or more legacy "tabs" as
// labelled sections inside a single scrollable column. This dramatically
// cuts visual noise vs the old 12-chip strip while keeping every setting
// reachable.
// Settings tab order. Icons removed in favour of typographic clarity -
// the labels alone read cleaner and stay consistent across themes (some
// fonts render emoji oddly; some don't render them at all).
const TABS = [
  { key: "schedule",      label: "Schedule" },
  { key: "activity",      label: "Activity" },
  { key: "mobile",        label: "Mobile" },
  { key: "goals",         label: "Goals" },
  { key: "integrations",  label: "Integrations" },
  { key: "appearance",    label: "Appearance" },
  { key: "notifications", label: "Notifications" },
  { key: "data",          label: "Data" },
];

// Tiny presentational helper for in-tab section headers. Used between
// merged sub-tabs (e.g. Activity contains "Activity tracking" +
// "Mobile wellbeing"). Inline styles dropped in favour of a class so
// the CSS layer can tune spacing globally.
function SectionHeader({ title, hint }) {
  return (
    <div className="settings-section-header">
      <div className="settings-section-label">{title}</div>
      {hint && <small className="muted settings-section-hint">{hint}</small>}
    </div>
  );
}

function SettingsOverview({ items }) {
  return (
    <div className="settings-overview-grid">
      {items.map((item) => (
        <div key={item.label} className={"settings-overview-card " + (item.tone || "info")}>
          <small>{item.label}</small>
          <strong>{item.value}</strong>
          {item.detail && <span>{item.detail}</span>}
        </div>
      ))}
    </div>
  );
}

function MobileSettingsOverview({ all }) {
  const [cloud, setCloud] = useState(null);
  const [usb, setUsb] = useState(null);

  useEffect(() => {
    api.wellbeing.cloudStatus?.().then(setCloud).catch(() => setCloud(null));
    api.wellbeing.diagnose?.().then(setUsb).catch(() => setUsb(null));
  }, []);

  const cloudPaired = !!cloud?.paired;
  const lastPull = cloud?.lastSyncAt || all["wellbeing.lastSyncAt"];
  const authorized = Array.isArray(usb?.authorized) ? usb.authorized.length : null;
  const usbOk = usb?.ok !== false;

  return (
    <SettingsOverview
      items={[
        {
          label: "Cloud sync",
          value: cloudPaired ? "Paired" : "Needs pairing",
          detail: cloud?.auto ? "Auto every 15 min" : "Manual pull",
          tone: cloudPaired ? "ok" : "warn",
        },
        {
          label: "API base",
          value: all["cloud.apiBase"] ? "Saved" : "Default",
          detail: all["cloud.apiBase"] || cloud?.apiBase || "apex sync API",
          tone: "info",
        },
        {
          label: "USB fallback",
          value: usbOk ? (authorized ? `${authorized} phone` : "Ready") : "Needs fix",
          detail: all["wellbeing.adbPath"] ? "Custom ADB path" : "Auto-detect ADB",
          tone: usbOk ? "info" : "danger",
        },
        {
          label: "Last phone pull",
          value: lastPull
            ? new Date(lastPull).toLocaleDateString([], { month: "short", day: "numeric" })
            : "Never",
          detail: lastPull
            ? new Date(lastPull).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : "Sync from phone app",
          tone: lastPull ? "ok" : "warn",
        },
      ]}
    />
  );
}

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

  // Section descriptions - shown beneath the nav rail label on hover and
  // as a sublabel under the active section's title.
  const SECTION_BLURB = {
    schedule: "Timetable, classes, course materials",
    activity: "Desktop window tracking, idle thresholds",
    mobile: "Phone pairing · cloud sync · ADB import",
    goals: "Weekly goals, competitive-programming cadence",
    integrations: "Ollama · Spotify · GitHub",
    appearance: "Theme, accent, contrast, fonts",
    notifications: "Class alerts, deadlines, streak nudges",
    data: "Backup, restore, clear, seed",
  };
  const activeTab = TABS.find((t) => t.key === tab) || TABS[0];

  return (
    <div className="settings-layout">
      {/* Left rail - vertical section nav. Title + each section as a row
          with active-state tint. Stays pinned while the right pane
          scrolls. Replaces the cramped horizontal pill bar. */}
      <aside className="settings-rail">
        <div className="settings-rail-head">
          <h1 className="settings-rail-title">Settings</h1>
        </div>
        <nav className="settings-rail-nav">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={"settings-rail-item" + (active ? " active" : "")}
                title={SECTION_BLURB[t.key]}
              >
                <span className="settings-rail-label">{t.label}</span>
                <small className="settings-rail-sub muted">
                  {SECTION_BLURB[t.key]}
                </small>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Right pane - single-column content, capped at a comfortable
          reading width (740px ≈ Fibonacci-friendly). */}
      <main className="settings-content">
        <div className="settings-content-head">
          <h2 className="settings-content-title">{activeTab.label}</h2>
          <small className="muted">{SECTION_BLURB[tab]}</small>
        </div>

      {tab === "schedule" && (
        <ScheduleTab all={all} setAll={setAll} save={save} setMsg={setMsg} />
      )}

      {tab === "activity" && (
        <ActivityTab all={all} setAll={setAll} save={save} setMsg={setMsg} />
      )}

      {tab === "mobile" && (
        <>
          <MobileSettingsOverview all={all} />
          <SectionHeader
            title="Cloud sync"
            hint="Primary path: pair desktop + Android app once, then sync over the network."
          />
          <CloudWellbeingPanel save={save} setMsg={setMsg} />
          <SectionHeader
            title="USB fallback"
            hint="Local testing path when the phone is plugged in and ADB is authorized."
          />
          <WellbeingTab all={all} setAll={setAll} save={save} setMsg={setMsg} />
        </>
      )}

      {tab === "goals" && (
        <>
          <SettingsOverview
            items={[
              { label: "Weekly goals", value: "Active", detail: "Dashboard targets", tone: "ok" },
              {
                label: "CP handles",
                value: [all["cp.leetcode"], all["cp.codeforces"], all["cp.codechef"]].filter(Boolean).length + "/3",
                detail: "LeetCode / CF / CodeChef",
                tone: [all["cp.leetcode"], all["cp.codeforces"], all["cp.codechef"]].some(Boolean) ? "ok" : "warn",
              },
              { label: "Review loop", value: "Manual", detail: "Refresh stats when needed", tone: "info" },
            ]}
          />
          <SectionHeader
            title="Weekly targets"
            hint="Small visible commitments that show up on the dashboard."
          />
          <WeeklyGoalsEditor />
          <SectionHeader
            title="Competitive programming"
            hint="Optional handles for contest and problem-solving stats."
          />
          <Collapse
            title="Competitive programming"
            hint="LeetCode / Codeforces / CodeChef handles + cadence"
          >
            <CpTab all={all} setAll={setAll} save={save} />
          </Collapse>
        </>
      )}

      {tab === "integrations" && (
        <>
          <SettingsOverview
            items={[
              {
                label: "Local AI",
                value: all["ollama.host"] || "Auto host",
                detail: all["ollama.model"] || "Auto-pick model",
                tone: "info",
              },
              {
                label: "Spotify",
                value: "Focus music",
                detail: "Playback + playlists",
                tone: "ok",
              },
              {
                label: "GitHub",
                value: all["github.username"] ? "Configured" : "Optional",
                detail: all["github.username"] || "Repo comparison",
                tone: all["github.username"] ? "ok" : "warn",
              },
            ]}
          />
          <SectionHeader
            title="Local AI"
            hint="Ollama powers Ask Apex, planning, burnout checks, and reviews."
          />
          <OllamaTab all={all} setAll={setAll} save={save} />
          <SectionHeader
            title="Music"
            hint="Spotify focus playlist and device playback controls."
          />
          <Collapse title="Spotify" hint="Connect, focus playlist, playback controls">
            <SpotifyTab setMsg={setMsg} />
          </Collapse>
          <SectionHeader
            title="Code"
            hint="GitHub profile and optional token for richer repo data."
          />
          <Collapse title="GitHub" hint="Username + personal-access token">
            <GithubTab all={all} setAll={setAll} save={save} />
          </Collapse>
        </>
      )}

      {tab === "appearance" && (
        <AppearanceTab all={all} setAll={setAll} save={save} />
      )}

      {tab === "notifications" && <NotificationsTab />}

      {tab === "data" && (
        <>
          <SettingsOverview
            items={[
              { label: "Backup", value: "Export first", detail: "Portable SQLite copy", tone: "ok" },
              { label: "Restore", value: "Relaunches", detail: "Keeps previous DB", tone: "warn" },
              { label: "Seeds", value: "Additive", detail: "No destructive overwrite", tone: "info" },
              { label: "Clears", value: "Confirmed", detail: "Type-to-confirm only", tone: "danger" },
            ]}
          />
          <SectionHeader
            title="Database"
            hint="Export/import the local SQLite database before risky changes."
          />
          <BackupTab setMsg={setMsg} />
          <SectionHeader
            title="Starter content"
            hint="Optional one-click seeds for tasks, habits, and project ideas."
          />
          <SeedTab setMsg={setMsg} />
          <SectionHeader
            title="Danger zone"
            hint="Destructive clears are isolated and require confirmation."
          />
          <Collapse
            title="Danger zone"
            hint="Bulk-clear activity / schedule / everything"
            defaultOpen
          >
            <DangerZone setMsg={setMsg} />
          </Collapse>
        </>
      )}
      </main>

      {msg && <div style={{ position: "fixed", bottom: 20, right: 20 }} className="pill teal">{msg}</div>}
    </div>
  );
}

// Reusable toggle row - label + optional sublabel on the left, a proper
// macOS-style switch on the right. Use this for any boolean setting so
// they all read the same.
function ToggleRow({ label, sub, checked, onChange, disabled }) {
  return (
    <label
      className={"settings-toggle-row" + (disabled ? " disabled" : "")}
    >
      <div className="settings-toggle-text">
        <div className="settings-toggle-label">{label}</div>
        {sub && <small className="muted settings-toggle-sub">{sub}</small>}
      </div>
      <span className={"settings-switch" + (checked ? " on" : "")}>
        <input
          type="checkbox"
          checked={!!checked}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked)}
        />
        <span className="settings-switch-track" aria-hidden>
          <span className="settings-switch-thumb" />
        </span>
      </span>
    </label>
  );
}

// Tiny collapsible - uses <details> so screen readers handle it natively.
// Wrap rarely-touched sections so the primary content (auth + editor) is
// the visual headline.
function Collapse({ title, hint, children, defaultOpen = false }) {
  return (
    <details className="settings-collapse" open={defaultOpen}>
      <summary>
        <span className="settings-collapse-title">{title}</span>
        {hint && <small className="muted">{hint}</small>}
        <span className="settings-collapse-chevron" aria-hidden>▸</span>
      </summary>
      <div className="settings-collapse-body">{children}</div>
    </details>
  );
}

function ScheduleTab({ all, setAll, save, setMsg }) {
  // SRM session state - primary path is browser-login (cookies live in a
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
          "Login window closed without an active session. Try again - make sure you reach your portal home before closing.",
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
            " Click \"Log in to SRM\" to sign in - Apex will remember the session.",
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

  const scheduleOverview = [
    {
      label: "SRM session",
      value: sess.sessionActive ? "Signed in" : "Needs login",
      tone: sess.sessionActive ? "ok" : "warn",
      detail: sess.username || "Browser login",
    },
    {
      label: "Batch",
      value: `Batch ${all["srm.batch"] || "1"}`,
      tone: "neutral",
      detail: "Slot table",
    },
    {
      label: "Auto-sync",
      value: (all["srm.autoSync"] ?? "1") !== "0" ? "On" : "Off",
      tone: (all["srm.autoSync"] ?? "1") !== "0" ? "ok" : "neutral",
      detail: "On app startup",
    },
    {
      label: "Last pull",
      value: lastSync?.ok ? `${lastSync.classes} classes` : "Not yet",
      tone: lastSync?.ok ? "ok" : "neutral",
      detail: lastSync?.calendar_rows ? `${lastSync.calendar_rows} calendar dates` : "Run Sync now",
    },
  ];

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">SRM Academia</div>

        <div className="settings-overview-grid">
          {scheduleOverview.map((item) => (
            <div key={item.label} className={"settings-overview-card " + item.tone}>
              <small>{item.label}</small>
              <strong>{item.value}</strong>
              <span>{item.detail}</span>
            </div>
          ))}
        </div>

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
                : "Click \"Log in to SRM\" - a real browser window will open. Sign in there, then close it."}
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
            {diagnosing ? "Diagnosing…" : "Diagnose"}
          </button>
        </div>

        {diagReport && <SrmDiagnosePanel report={diagReport} />}

        {lastSync?.ok && (
          <small className="hint" style={{ display: "block", marginTop: 10 }}>
            Last sync: <strong>{lastSync.classes}</strong> classes
            {lastSync.calendar_rows ? ` · ${lastSync.calendar_rows} calendar dates` : ""}
            {lastSync.student?.batch ? ` · batch ${lastSync.student.batch}` : ""}
            {lastSync.student?.semester ? ` · semester ${lastSync.student.semester}` : ""}
            {lastSync.planner ? ` · planner ${lastSync.planner}` : ""}.
          </small>
        )}

        <hr className="soft" style={{ margin: "12px 0 10px" }} />
        <div className="row between" style={{ alignItems: "center", maxWidth: 520 }}>
          <label style={{ fontWeight: 600, margin: 0 }}>
            Your batch
            <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>
              (slot table used for timetable)
            </span>
          </label>
          <select
            id="srm-batch-override"
            value={all["srm.batch"] || "1"}
            onChange={async (e) => {
              const v = e.target.value;
              setAll({ ...all, "srm.batch": v });
              await save("srm.batch", v);
              // Rebuilds classes instantly from cached data — no network.
              const r = await api.srm.rebuildBatch();
              if (r?.ok) {
                setMsg(`✓ Schedule rebuilt for Batch ${v} - ${r.classes} classes updated.`);
              } else {
                setMsg(r?.error || `Batch saved. Do a full Sync to apply.`);
              }
            }}
            style={{ width: 110 }}
          >
            <option value="1">Batch 1</option>
            <option value="2">Batch 2</option>
          </select>
        </div>
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

        <div className="settings-divider" />
        <ToggleRow
          label="Auto-sync on startup"
          sub="Pulls your timetable silently on launch."
          checked={(all["srm.autoSync"] ?? "1") !== "0"}
          onChange={(v) => {
            setAll({ ...all, "srm.autoSync": v ? "1" : "0" });
            save("srm.autoSync", v ? "1" : "0");
          }}
        />
      </div>

      {/* Rarely-needed fallback — one compact row. Only consulted when the
          academic calendar hasn't synced a day-order for a date. */}
      <Collapse
        title="Day-order fallback"
        hint="Anchor a known date when the calendar isn't synced"
      >
        <div className="row" style={{ gap: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="form-row" style={{ margin: 0 }}>
            <label>Anchor date</label>
            <input
              type="date"
              value={all["timetable.anchorDate"] || ""}
              onChange={(e) => setAll({ ...all, "timetable.anchorDate": e.target.value })}
              onBlur={(e) => save("timetable.anchorDate", e.target.value)}
            />
          </div>
          <div className="form-row" style={{ margin: 0 }}>
            <label>Day order on that date</label>
            <select
              value={all["timetable.anchorOrder"] || "1"}
              onChange={(e) => { setAll({ ...all, "timetable.anchorOrder": e.target.value }); save("timetable.anchorOrder", e.target.value); }}
            >
              {[1, 2, 3, 4, 5].map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
        </div>
      </Collapse>

      <div id="schedule-editor">
        <ScheduleEditor />
      </div>

      <Collapse
        title="Course materials"
        hint="Syllabus context fed into AI prompts"
      >
        <CourseMaterialsCard />
      </Collapse>
    </>
  );
}

// ─── CourseMaterialsCard ─────────────────────────────────────────────────
// Per-course syllabus / unit-plan / notes. Materials with "Include in AI"
// on get stitched into every Ollama prompt so academic suggestions are
// grounded in the actual coursework.
function CourseMaterialsCard() {
  const [items, setItems] = useState([]);
  const [courses, setCourses] = useState([]);
  const [editing, setEditing] = useState(null); // material being edited / null
  const [adding, setAdding] = useState(false);

  async function refresh() {
    const [list, knownCourses] = await Promise.all([
      api.courseMaterials.list({}),
      api.courseMaterials.knownCourses(),
    ]);
    setItems(list || []);
    setCourses(knownCourses || []);
  }

  useEffect(() => { refresh(); }, []);

  async function toggleAi(it) {
    await api.courseMaterials.setAi(it.id, !it.include_in_ai);
    refresh();
  }
  async function remove(it) {
    if (!confirm(`Delete "${it.title || it.kind}" for ${it.course_code || "-"}?`))
      return;
    await api.courseMaterials.delete(it.id);
    refresh();
  }

  // Group materials by course code for display.
  const groups = useMemo(() => {
    const map = new Map();
    for (const it of items) {
      const k = it.course_code || "-";
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(it);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  const totalIncluded = items.filter((i) => i.include_in_ai).length;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between" style={{ alignItems: "baseline" }}>
        <div>
          <div className="card-title" style={{ margin: 0 }}>
            Course materials · syllabus context
          </div>
          <small className="hint" style={{ display: "block", marginTop: 4 }}>
            Paste your syllabus / unit plan / notes per course. Materials with
            <strong> Include in AI </strong> on are fed into every Ollama
            prompt, including Ask Apex and Brain dump extraction, so plans,
            recommendations, and task parsing are grounded in the actual course
            content (not generic advice).
            <br />
            <strong>Local only</strong> - never leaves your machine.
          </small>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <span className="pill">
            {totalIncluded}/{items.length} in AI
          </span>
          <button className="primary small" onClick={() => setAdding(true)}>
            + Add material
          </button>
        </div>
      </div>

      {items.length === 0 && !adding && (
        <div className="muted" style={{ marginTop: 14 }}>
          No course materials yet. Paste a syllabus to give Apex's AI real
          academic context.
        </div>
      )}

      {groups.length > 0 && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          {groups.map(([code, list]) => (
            <div key={code} className="course-mat-group">
              <div className="section-label" style={{ marginBottom: 6 }}>
                {code === "-" ? "General" : code}
                {list[0]?.course_name && (
                  <span className="muted" style={{ marginLeft: 6 }}>
                    {list[0].course_name}
                  </span>
                )}
              </div>
              <div className="course-mat-list">
                {list.map((it) => (
                  <div key={it.id} className="course-mat-row">
                    <div className="course-mat-row-body">
                      <div className="course-mat-row-head">
                        <strong>{it.title || it.kind}</strong>
                        <span className="pill gray">{it.kind}</span>
                        <small className="muted">
                          {(it.body_len ?? it.body?.length ?? 0).toLocaleString()} chars
                        </small>
                      </div>
                      <small className="muted" style={{ display: "block" }}>
                        updated {it.updated_at ? new Date(it.updated_at + "Z").toLocaleDateString() : "-"}
                      </small>
                    </div>
                    <div className="course-mat-row-actions">
                      <label className="switch" title={it.include_in_ai ? "Stop sending to AI" : "Include in AI prompts"}>
                        <input
                          type="checkbox"
                          checked={!!it.include_in_ai}
                          onChange={() => toggleAi(it)}
                        />
                        <span>AI</span>
                      </label>
                      <button className="ghost xsmall" onClick={() => setEditing(it)}>Edit</button>
                      <button className="ghost xsmall" onClick={() => remove(it)} title="Delete">✕</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {(adding || editing) && (
        <CourseMaterialEditor
          courses={courses}
          material={editing}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function CourseMaterialEditor({ courses, material, onClose, onSaved }) {
  const [form, setForm] = useState({
    id: material?.id ?? null,
    course_code: material?.course_code || (courses[0]?.code || ""),
    course_name: material?.course_name || (courses[0]?.subject || ""),
    kind: material?.kind || "syllabus",
    title: material?.title || "",
    body: material?.body || "",
    include_in_ai:
      material == null ? true : !!material.include_in_ai,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  function pickCourse(code) {
    const c = courses.find((x) => x.code === code);
    setForm({
      ...form,
      course_code: code,
      course_name: c?.subject || form.course_name,
    });
  }

  async function pickFile() {
    const f = await api.settings.pickFile([
      { name: "Text / Markdown", extensions: ["txt", "md", "markdown"] },
    ]);
    if (!f) return;
    const r = await api.courseMaterials.readFile(f);
    if (r?.ok) {
      setForm({ ...form, body: r.body, source: "file", source_path: f });
    } else {
      setErr(r?.error || "Couldn't read file");
    }
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api.courseMaterials.upsert(form);
      if (r?.ok) onSaved();
      else setErr(r?.error || "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 720 }}>
        <div className="row between" style={{ alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>
            {material ? "Edit material" : "New course material"}
          </h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="grid-2" style={{ marginTop: 10 }}>
          <div className="form-row">
            <label>Course</label>
            {courses.length > 0 ? (
              <select
                value={form.course_code || ""}
                onChange={(e) => pickCourse(e.target.value)}
              >
                <option value="">- general (no course) -</option>
                {courses.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} · {c.subject}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={form.course_code || ""}
                placeholder="e.g. 21CSC204J"
                onChange={(e) => setForm({ ...form, course_code: e.target.value })}
              />
            )}
          </div>
          <div className="form-row">
            <label>Kind</label>
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              <option value="syllabus">Syllabus</option>
              <option value="unit_plan">Unit plan</option>
              <option value="notes">Notes</option>
              <option value="reference">Reference</option>
            </select>
          </div>
        </div>
        <div className="form-row">
          <label>Title (optional)</label>
          <input
            value={form.title}
            placeholder="e.g. DBMS - Unit 1: Relational Model"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="row between" style={{ alignItems: "center" }}>
            <span>Body - paste syllabus / notes</span>
            <button
              type="button"
              className="ghost xsmall"
              onClick={pickFile}
              title="Read .txt or .md from disk"
            >
              📄 Import file…
            </button>
          </label>
          <textarea
            rows={14}
            value={form.body}
            placeholder="Paste your syllabus / unit plan / notes here. Plain text only - Apex feeds (a slice of) this into every academic AI prompt."
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12, lineHeight: 1.5 }}
          />
          <small className="muted" style={{ marginTop: 4 }}>
            {form.body.length.toLocaleString()} chars · cap is ~6 KB into the
            prompt; longer bodies are sliced.
          </small>
        </div>
        <div className="form-row">
          <label className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={form.include_in_ai}
              onChange={(e) => setForm({ ...form, include_in_ai: e.target.checked })}
            />
            <span>Include in AI prompts (recommendations, plan, burnout, etc.)</span>
          </label>
        </div>
        {err && <div className="error">{err}</div>}
        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={busy || !form.body.trim()}>
            {busy ? "Saving…" : material ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
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
      <SettingsOverview
        items={[
          {
            label: "Tracker",
            value: status?.running ? "Running" : "Off",
            detail: status?.running ? "Sampling foreground apps" : "No desktop samples",
            tone: status?.running ? "ok" : "warn",
          },
          {
            label: "Current app",
            value: status?.current?.app ? prettyAppName(status.current.app) : "Waiting",
            detail: status?.current?.minutes ? `${status.current.minutes} min · ${status.current.category}` : "Start tracker to populate",
            tone: status?.current?.category === "distraction" ? "danger" : "info",
          },
          {
            label: "Nudge after",
            value: `${all["activity.nudgeAfterMin"] || 45} min`,
            detail: "One-app stretch limit",
            tone: "info",
          },
          {
            label: "Idle cutoff",
            value: `${all["activity.idleThresholdMin"] || 5} min`,
            detail: "Stops counting AFK time",
            tone: "info",
          },
        ]}
      />
      <SectionHeader
        title="Tracking"
        hint="Foreground app sampling, idle handling, and break nudges."
      />
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

      <SectionHeader
        title="Close behavior"
        hint="Decide when Apex should ask for a reason before quitting."
      />
      <CloseGuardCard all={all} setAll={setAll} save={save} />

      <SectionHeader
        title="App rules"
        hint="Correct automatic app categories and keep future sessions cleaner."
      />
      <div className="card">
        <div className="card-title">App categorization overrides</div>
        <p className="muted">Manually reclassify specific apps. Applies to all future samples (old sessions keep their original category).</p>
        <CategorizationOverrides />
      </div>
    </>
  );
}

// Close guard — the "give a reason before quitting" gate. The on/off switch
// is a plain setting; the active hours live inside the routine config.
function CloseGuardCard({ all, setAll, save }) {
  const [hours, setHours] = useState({ workStart: "00:00", workEnd: "23:59" });

  useEffect(() => {
    api.routine?.state?.().then((s) => {
      if (s?.config) {
        setHours({
          workStart: s.config.workStart || "00:00",
          workEnd: s.config.workEnd || "23:59",
        });
      }
    }).catch(() => {});
  }, []);

  function saveHours(patch) {
    const next = { ...hours, ...patch };
    setHours(next);
    api.routine?.saveConfig?.(next).catch(() => {});
  }

  const alwaysOn = hours.workStart === "00:00" && hours.workEnd === "23:59";

  return (
    <div className="card">
      <div className="card-title">Close guard</div>
      <ToggleRow
        label="Ask for a reason before quitting"
        sub={alwaysOn
          ? "Active all day. Quitting (✕ or tray → Quit) needs one line for the day log; hiding to tray never asks."
          : `Active ${hours.workStart}–${hours.workEnd}. Outside these hours Apex closes silently.`}
        checked={(all["routine.desktopGuardEnabled.v1"] ?? "1") !== "0"}
        onChange={(v) => {
          setAll({ ...all, "routine.desktopGuardEnabled.v1": v ? "1" : "0" });
          save("routine.desktopGuardEnabled.v1", v ? "1" : "0");
        }}
      />
      <div className="row" style={{ gap: 14, marginTop: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div className="form-row" style={{ margin: 0 }}>
          <label>Guard from</label>
          <input
            type="time"
            value={hours.workStart}
            onChange={(e) => saveHours({ workStart: e.target.value })}
          />
        </div>
        <div className="form-row" style={{ margin: 0 }}>
          <label>until</label>
          <input
            type="time"
            value={hours.workEnd}
            onChange={(e) => saveHours({ workEnd: e.target.value })}
          />
        </div>
        {!alwaysOn && (
          <button
            type="button"
            className="ghost small"
            onClick={() => saveHours({ workStart: "00:00", workEnd: "23:59" })}
            title="Guard every close, any hour"
          >
            Always ask
          </button>
        )}
      </div>
    </div>
  );
}

function fmtHM(mins) {
  if (!mins || mins <= 0) return "-";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function CategorizationOverrides() {
  const [list, setList] = useState([]);
  const [form, setForm] = useState({ app: "", category: "productive" });
  const [recentApps, setRecentApps] = useState([]);
  const [err, setErr] = useState(null);

  // Rebuild the list from settings + opportunistically GC any ghost
  // entries that earlier builds left behind (empty-string values that
  // showed up as "→ <empty pill>" rows).
  async function refresh() {
    const today = new Date().toISOString().slice(0, 10);
    const [all, recent] = await Promise.all([
      api.settings.all(),
      api.activity?.topApps?.(today, 16).catch(() => []),
    ]);
    const entries = Object.entries(all)
      .filter(([k]) => k.startsWith("activity.overrides."))
      .map(([k, v]) => ({
        app: k.replace("activity.overrides.", ""),
        category: v,
      }));
    // Drop empty values AND empty keys (the "" remnants from the old bug).
    const ghosts = entries.filter((x) => !x.app.trim() || !x.category);
    for (const g of ghosts) {
      try { await api.settings.delete("activity.overrides." + g.app); } catch {}
    }
    const live = entries
      .filter((x) => x.app.trim() && x.category)
      .sort((a, b) => a.app.localeCompare(b.app));
    setList(live);
    setRecentApps(uniqueRecentApps(recent));
  }
  useEffect(() => { refresh(); }, []);

  async function add() {
    const app = form.app.trim();
    if (!app) {
      setErr("Type the .exe name first.");
      return;
    }
    setErr(null);
    await api.settings.set("activity.overrides." + app, form.category);
    await refresh();
    setForm({ app: "", category: "productive" });
  }
  async function remove(app) {
    // Use the real delete IPC so the row doesn't linger as an empty-string
    // value (the old bug: `set(..., "")` left the key around with a blank
    // value, which then rendered as a ghost on next page load).
    await api.settings.delete("activity.overrides." + app);
    setList((l) => l.filter((x) => x.app !== app));
  }

  return (
    <div className="cat-overrides">
      <form
        className="cat-overrides-form"
        onSubmit={(e) => { e.preventDefault(); add(); }}
      >
        <input
          placeholder="App name from recent activity"
          value={form.app}
          onChange={(e) => setForm({ ...form, app: e.target.value })}
        />
        <select
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        >
          <option value="productive">Productive</option>
          <option value="neutral">Neutral</option>
          <option value="distraction">Distraction</option>
          <option value="leisure">Leisure</option>
          <option value="rest">Rest</option>
          <option value="other">Other</option>
        </select>
        <button className="primary" type="submit">Add</button>
      </form>
      <div className="cat-recent-apps" aria-label="Recent apps">
        {recentApps.length === 0 ? (
          <small className="muted">Recent apps appear here once the tracker records activity.</small>
        ) : (
          recentApps.map((app) => (
            <button
              key={app}
              type="button"
              className={form.app.toLowerCase() === app.toLowerCase() ? "active" : ""}
              onClick={() => setForm((f) => ({ ...f, app }))}
              title={app}
            >
              {prettyAppName(app)}
            </button>
          ))
        )}
      </div>
      {err && <small className="error" style={{ display: "block", marginBottom: 8 }}>{err}</small>}

      {list.length === 0 ? (
        <div className="cat-overrides-empty muted">
          No overrides yet. Add a row above to reclassify an app.
        </div>
      ) : (
        <ul className="cat-overrides-list">
          {list.map((x) => (
            <li key={x.app} className="cat-overrides-row">
              <div className="cat-overrides-app">
                <code>{x.app}</code>
                <small className="muted">{prettyAppName(x.app)}</small>
              </div>
              <span className={`pill cat-overrides-pill cat-${x.category}`}>
                {x.category}
              </span>
              <button
                type="button"
                className="ghost xsmall"
                onClick={() => remove(x.app)}
                title="Remove override"
                aria-label={`Remove override for ${x.app}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function uniqueRecentApps(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const app = String(row?.app || "").trim();
    if (!app) continue;
    const key = app.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(app);
  }
  return out.slice(0, 12);
}

// Cloud (no-USB) phone-usage sync. Pairs the desktop + phone with the shared
// sync API; Apex then pulls Digital Wellbeing over the network on a timer.
function CloudWellbeingPanel({ save, setMsg }) {
  const [status, setStatus] = useState(null);
  const [apiBase, setApiBase] = useState("https://apex.yashasviallen.is-a.dev");
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState("");
  const [code, setCode] = useState(null);
  const [devices, setDevices] = useState([]);
  const [selfId, setSelfId] = useState(null);

  useEffect(() => { refresh(); }, []);
  async function refresh() {
    const s = await api.wellbeing.cloudStatus().catch(() => null);
    setStatus(s);
    const a = await api.settings.all().catch(() => ({}));
    setApiBase(a["cloud.apiBase"] || s?.apiBase || "https://apex.yashasviallen.is-a.dev");
    setAdminToken(a["cloud.adminToken"] || "");
    if (s?.paired) loadDevices();
  }

  const [tokenDead, setTokenDead] = useState(false);
  async function loadDevices() {
    const r = await api.routine.listDevices().catch(() => null);
    if (r?.ok) {
      setDevices(r.devices || []);
      setSelfId(r.self || null);
      // Token works but this desktop isn't in the list → it was unlinked
      // from another device. Either way: re-pair.
      setTokenDead(!!r.self && !(r.devices || []).some((d) => d.id === r.self));
    } else if (/401|Invalid device token|HTTP 401/i.test(r?.error || "")) {
      setDevices([]);
      setTokenDead(true);
    }
  }

  async function unlink(d) {
    const isSelf = d.id === selfId;
    setBusy("unlink:" + d.id);
    try {
      const r = await api.routine.revokeDevice(d.id);
      if (!r?.ok) throw new Error(r?.error || "revoke failed");
      setMsg(isSelf ? "This desktop unpaired." : `Unlinked “${d.name}”.`);
      await refresh();
    } catch (e) { setMsg("Unlink failed: " + e.message); }
    finally { setBusy(""); }
  }

  async function pairDesktop() {
    setBusy("pair"); setMsg("");
    try {
      save("cloud.apiBase", apiBase); save("cloud.adminToken", adminToken);
      const made = await api.routine.createPairingCode({ apiBase, adminToken });
      if (!made?.ok) throw new Error(made?.error || "could not create pairing code");
      const paired = await api.routine.pairDesktop({ apiBase, code: made.code });
      if (!paired?.ok) throw new Error(paired?.error || "pairing failed");
      setMsg("Desktop paired with the sync API.");
      await refresh();
    } catch (e) { setMsg("Pair failed: " + e.message); }
    finally { setBusy(""); }
  }

  async function phoneCode() {
    setBusy("code"); setMsg("");
    try {
      save("cloud.apiBase", apiBase); save("cloud.adminToken", adminToken);
      const made = await api.routine.createPairingCode({ apiBase, adminToken });
      if (!made?.ok) throw new Error(made?.error || "could not create code");
      setCode({ code: made.code, expires_at: made.expires_at });
    } catch (e) { setMsg("Code failed: " + e.message); }
    finally { setBusy(""); }
  }

  // Web version: served by the sync API at /web. With an admin token we mint
  // a one-shot pairing code and pass it in the hash so the browser signs in
  // by itself; already-paired browsers ignore the code (it just expires).
  async function openWebApp() {
    setBusy("web"); setMsg("");
    try {
      const base = (apiBase || "").trim().replace(/\/+$/, "");
      if (!base) throw new Error("set the API base first");
      if (adminToken) {
        save("cloud.apiBase", base); save("cloud.adminToken", adminToken);
        const made = await api.routine.createPairingCode({ apiBase: base, adminToken });
        if (made?.ok) {
          await api.ext.open(`${base}/web#pair=${made.code}`);
          setMsg("Web app opened — it pairs itself with the code in the link.");
          return;
        }
      }
      await api.ext.open(`${base}/web`);
      setMsg("Web app opened — use “Pair a phone” to mint a sign-in code.");
    } catch (e) { setMsg("Open failed: " + e.message); }
    finally { setBusy(""); }
  }

  async function syncNow() {
    setBusy("sync"); setMsg("");
    try {
      const res = await api.wellbeing.pullCloud();
      if (!res?.ok) throw new Error(res?.error || "sync failed");
      setMsg(res.note === "no-mobile-data"
        ? "No phone usage on the server yet - open Apex Mobile and tap Sync usage."
        : `Pulled ${res.count} apps · ${res.total_minutes} min from phone (${res.daysWritten} day${res.daysWritten === 1 ? "" : "s"}).`);
      await refresh();
    } catch (e) { setMsg("Sync failed: " + e.message); }
    finally { setBusy(""); }
  }

  async function toggleAuto() {
    const next = !status?.auto;
    const s = await api.wellbeing.setCloudAuto(next).catch(() => null);
    if (s) setStatus(s);
  }

  const paired = !!status?.paired;
  const phoneCount = devices.filter((d) => d.type !== "desktop").length;
  const desktopCount = devices.filter((d) => d.type === "desktop").length;
  const lastLabel = status?.lastSyncAt
    ? new Date(status.lastSyncAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "Never";

  return (
    <>
      <section className={"wellbeing-hero cloud" + (paired ? " is-ready" : "")}>
        <div className="wellbeing-hero-copy">
          <div className="wellbeing-kicker">Cloud sync · no cable</div>
          <h3>Phone usage over the network.</h3>
          <small className="muted">
            Pair this desktop and your phone with the sync API. Apex pulls Digital Wellbeing automatically - no USB, no ADB.
          </small>
        </div>
        <div className={"wellbeing-status-card" + (paired ? " ok" : " warn")}>
          <span className="wellbeing-status-dot" aria-hidden="true" />
          <strong>{paired ? "Paired" : "Not paired"}</strong>
          <small>Last pull · {lastLabel}</small>
        </div>
      </section>

      <div className="wellbeing-metrics cloud-metrics" aria-label="Cloud phone sync state">
        <div className="wellbeing-metric">
          <small>Connection</small>
          <strong>{paired ? "Paired" : "Setup needed"}</strong>
        </div>
        <div className="wellbeing-metric">
          <small>Devices</small>
          <strong>{devices.length ? `${devices.length} linked` : paired ? "Refresh" : "None"}</strong>
        </div>
        <div className="wellbeing-metric">
          <small>Phones</small>
          <strong>{phoneCount}</strong>
        </div>
        <div className="wellbeing-metric">
          <small>Auto-sync</small>
          <strong>{status?.auto ? "On" : "Off"}</strong>
        </div>
      </div>

      <section className="wellbeing-panel">
        <div className="wellbeing-panel-head">
          <div>
            <strong>Sync API</strong>
            <small className="muted">Stored on this machine. The admin token mints pairing codes.</small>
          </div>
          <div className="wellbeing-actions">
            <button type="button" className="primary" onClick={syncNow} disabled={!paired || busy === "sync"}>
              {busy === "sync" ? "Pulling…" : "Sync phone now"}
            </button>
          </div>
        </div>

        <div className="form-row">
          <label>API base</label>
          <input
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            onBlur={() => save("cloud.apiBase", apiBase)}
            placeholder="https://apex.yashasviallen.is-a.dev"
          />
        </div>
        <div className="form-row">
          <label>Admin token</label>
          <input
            type="password"
            value={adminToken}
            onChange={(e) => setAdminToken(e.target.value)}
            onBlur={() => save("cloud.adminToken", adminToken)}
            placeholder="APEX_SYNC_ADMIN_TOKEN"
          />
        </div>

        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
          <button type="button" className="primary" onClick={pairDesktop} disabled={busy === "pair" || !apiBase || !adminToken}>
            {busy === "pair" ? "Pairing…" : paired ? "Re-pair desktop" : "Pair this desktop"}
          </button>
          <button type="button" className="ghost" onClick={phoneCode} disabled={busy === "code" || !apiBase || !adminToken}>
            {busy === "code" ? "…" : "Pair a phone"}
          </button>
          <button type="button" className="ghost" onClick={openWebApp} disabled={busy === "web" || !apiBase}>
            {busy === "web" ? "Opening…" : "Open web app ↗"}
          </button>
        </div>
        <ToggleRow
          label="Auto-sync phone usage"
          sub="Pulls the phone's screen time every 15 minutes while Apex runs."
          checked={!!status?.auto}
          disabled={!paired}
          onChange={toggleAuto}
        />

        {code && (
          <div className="pairing-qr-card">
            <img
              className="pairing-qr-img"
              src={`${apiBase}/pairing-codes/${code.code}/qr.png`}
              alt={`Pairing QR for code ${code.code}`}
              width={164}
              height={164}
            />
            <div className="pairing-qr-info">
              <strong>Scan with Apex Mobile</strong>
              <small className="muted">
                Settings tab → <b>Scan pairing QR</b>. Or type the code:
              </small>
              <div className="pairing-qr-code">{code.code}</div>
              <small className="muted">
                Expires {new Date(code.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · single use
              </small>
            </div>
          </div>
        )}

        {paired && tokenDead && (
          <div className="error" style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8 }}>
            This desktop's pairing was revoked (likely unlinked from the phone), so sync is
            dead even though credentials are saved. Hit <strong>Pair this desktop</strong> above
            to re-link.
          </div>
        )}

        {paired && (
          <div className="paired-devices">
            <div className="row between" style={{ marginBottom: 8 }}>
              <div>
                <strong>Paired devices</strong>
                <small className="muted paired-devices-summary">
                  {devices.length} linked · {phoneCount} phone{phoneCount === 1 ? "" : "s"} · {desktopCount} desktop{desktopCount === 1 ? "" : "s"}
                </small>
              </div>
              <button type="button" className="ghost xsmall" onClick={loadDevices}>Refresh list</button>
            </div>
            <div className="wellbeing-note">
              No device limit — each pairing code links one more phone or desktop.
              Unlinking a device kills its token immediately; unlinking <em>this</em> desktop stops sync until you re-pair.
            </div>
            {devices.length === 0 ? (
              <small className="muted">No devices found - hit Refresh list.</small>
            ) : (
              devices.map((d) => {
                const isSelf = d.id === selfId;
                return (
                  <div key={d.id} className="paired-device-row">
                    <span className={"paired-device-icon " + (d.type === "desktop" ? "desktop" : "phone")} aria-hidden>
                      {d.type === "desktop" ? "🖥" : "📱"}
                    </span>
                    <div className="paired-device-info">
                      <strong>
                        {d.name} {isSelf && <span className="pill teal" style={{ marginLeft: 6 }}>this device</span>}
                      </strong>
                      <small className="muted">
                        Paired since {new Date(d.created_at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                        {d.last_seen_at && ` · last seen ${new Date(d.last_seen_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="ghost small danger"
                      onClick={() => unlink(d)}
                      disabled={busy === "unlink:" + d.id}
                      title={isSelf ? "Unpair this desktop (clears its token)" : "Revoke this device's access"}
                    >
                      {busy === "unlink:" + d.id ? "…" : "Unlink"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
        {status?.lastError && (
          <small className="error" style={{ display: "block", marginTop: 8 }}>Last error: {status.lastError}</small>
        )}
      </section>
    </>
  );
}

function WellbeingTab({ all, setAll, save, setMsg }) {
  const [devices, setDevices] = useState([]);
  const [usbDiag, setUsbDiag] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [last, setLast] = useState(null);

  useEffect(() => { refresh(); }, []);
  async function refresh() {
    const [diagnostic, latestSettings] = await Promise.all([
      api.wellbeing.diagnose?.().catch(() => null),
      api.settings.all(),
    ]);
    setUsbDiag(diagnostic);
    const authorized = Array.isArray(diagnostic?.authorized)
      ? diagnostic.authorized
      : await api.wellbeing.devices().catch(() => []);
    setDevices(Array.isArray(authorized) ? authorized : []);
    if (latestSettings) setAll(latestSettings);
    setLast((latestSettings || all)["wellbeing.lastSyncAt"]);
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
      setMsg(`Phone: ${res.count} apps, ${res.total_minutes} min · device ${res.device}`);
      await refresh();
    } else {
      setMsg("Sync failed: " + (res?.error || "unknown"));
    }
  }

  const adbPath = all["wellbeing.adbPath"] || "";
  const deviceCount = devices.length;
  const allUsbDevices = Array.isArray(usbDiag?.devices) ? usbDiag.devices : devices;
  const unauthorizedCount = allUsbDevices.filter((d) => d.state && d.state !== "device").length;
  const hasDevice = deviceCount > 0;
  const adbSource = usbDiag?.adb?.source
    ? usbDiag.adb.source
    : adbPath.trim() ? "Custom path" : "Auto-detect";
  const adbCommand = usbDiag?.adb?.command || (adbPath.trim() || "adb");
  const adbOk = usbDiag?.ok !== false;
  const lastLabel = last
    ? new Date(last).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Never";
  const deviceLabel = hasDevice
    ? `${deviceCount} authorized`
    : unauthorizedCount > 0
      ? `${unauthorizedCount} needs auth`
      : "No phone";

  return (
    <div className="wellbeing-shell">
      <section className={"wellbeing-hero" + (hasDevice ? " is-ready" : "")}>
        <div className="wellbeing-hero-copy">
          <div className="wellbeing-kicker">USB · ADB fallback</div>
          <h3>Wired import for local testing.</h3>
          <small className="muted">
            The Android app pairs with the sync API. USB import stays here for local testing.
          </small>
        </div>
        <div className={"wellbeing-status-card" + (hasDevice ? " ok" : " warn")}>
          <span className="wellbeing-status-dot" aria-hidden="true" />
          <strong>{hasDevice ? "Ready" : "Waiting"}</strong>
          <small>{deviceLabel}</small>
        </div>
      </section>

      <div className="wellbeing-metrics" aria-label="Phone activity sync state">
        <div className="wellbeing-metric">
          <small>Last sync</small>
          <strong title={last || "Never synced"}>{lastLabel}</strong>
        </div>
        <div className="wellbeing-metric">
          <small>Device</small>
          <strong title={devices[0]?.serial || "No device connected"}>
            {devices[0]?.serial || "Not connected"}
          </strong>
        </div>
        <div className="wellbeing-metric">
          <small>ADB</small>
          <strong title={adbCommand}>{adbOk ? adbSource : "Needs fix"}</strong>
        </div>
      </div>

      <section className="wellbeing-panel">
        <div className="wellbeing-panel-head">
          <div>
            <strong>USB fallback</strong>
            <small className="muted">Use this only when you want desktop Apex to pull phone usage over ADB.</small>
          </div>
          <div className="wellbeing-actions">
            <button type="button" className="ghost" onClick={refresh}>
              Refresh
            </button>
            <button
              type="button"
              className="primary"
              onClick={sync}
              disabled={syncing || !hasDevice}
            >
              {syncing ? "Syncing..." : "Sync now"}
            </button>
          </div>
        </div>

        <div className="wellbeing-grid">
          <div className="wellbeing-tile">
            <div className="wellbeing-tile-head">
              <strong>ADB executable</strong>
              <span className={"pill " + (adbOk ? "gray" : "rose")}>{adbOk ? adbSource : "Failed"}</span>
            </div>
            <div className="wellbeing-path-row">
              <input
                value={adbPath}
                placeholder="C:\Program Files (x86)\Minimal ADB and Fastboot\adb.exe"
                aria-label="ADB executable path"
                onChange={(e) => setAll({ ...all, "wellbeing.adbPath": e.target.value })}
                onBlur={(e) => save("wellbeing.adbPath", e.target.value)}
              />
              <button type="button" className="ghost" onClick={pickAdb}>
                Pick...
              </button>
            </div>
            <div className="wellbeing-path-resolved">
              <small className="muted">Resolved command</small>
              <code title={adbCommand}>{adbCommand}</code>
            </div>
            {!adbOk && (
              <div className="wellbeing-diagnostic danger">
                <strong>ADB could not run</strong>
                <small>{usbDiag?.error || "Unknown ADB error"}</small>
              </div>
            )}
          </div>

          <div className="wellbeing-tile">
            <div className="wellbeing-tile-head">
              <strong>Authorized devices</strong>
              <span className={"pill " + (hasDevice ? "teal" : "amber")}>
                {hasDevice ? "Online" : "None"}
              </span>
            </div>
            {allUsbDevices.length > 0 ? (
              <div className="wellbeing-device-list">
                {allUsbDevices.map((d) => {
                  const authorized = d.state === "device";
                  return (
                  <div className={"wellbeing-device" + (authorized ? "" : " warn")} key={d.serial}>
                    <span className={"wellbeing-device-dot" + (authorized ? "" : " warn")} aria-hidden="true" />
                    <div>
                      <strong title={d.serial}>{d.serial}</strong>
                      <small className="muted">
                        {authorized ? "authorized" : d.state || "not authorized"}
                        {d.detail ? ` · ${d.detail}` : ""}
                      </small>
                    </div>
                    <span className={"pill " + (authorized ? "teal" : "amber")}>
                      {authorized ? "Authorized" : "Authorize"}
                    </span>
                  </div>
                  );
                })}
              </div>
            ) : (
              <div className="wellbeing-empty">
                <strong>No phone detected</strong>
                <small className="muted">Authorize the phone, then refresh.</small>
              </div>
            )}
          </div>
        </div>

        <details className="wellbeing-adb-help" open={!hasDevice}>
          <summary>
            <strong>How to import over USB (ADB)</strong>
            <small className="muted">Step-by-step</small>
          </summary>
          <ol>
            <li>Install <b>platform-tools</b> (or “Minimal ADB and Fastboot”) on this PC. Note the path to <code>adb.exe</code>.</li>
            <li>On the phone: <b>Settings → About phone</b>, tap <b>Build number</b> 7× to unlock Developer options.</li>
            <li><b>Developer options → enable USB debugging</b>.</li>
            <li>Plug the phone in by USB, then tap <b>Allow</b> on the “Allow USB debugging?” prompt.</li>
            <li>Set the <b>ADB executable</b> path above (or leave Auto-detect), then hit <b>Refresh</b> - your device should appear under Authorized devices.</li>
            <li>Click <b>Sync now</b> to pull today’s per-app usage into Apex.</li>
          </ol>
          <small className="muted">
            No cable? Use <b>Cloud sync</b> on the Mobile tab instead - pair the phone once and it
            syncs over the network with no USB.
          </small>
        </details>

        <ol className="wellbeing-steps" aria-label="Phone activity setup progress">
          <li className="done">
            <span>1</span>
            <div>
              <strong>ADB</strong>
              <small className="muted">{adbOk ? adbSource : "Path/error"}</small>
            </div>
          </li>
          <li className={hasDevice ? "done" : "active"}>
            <span>2</span>
            <div>
              <strong>Phone</strong>
              <small className="muted">{hasDevice ? deviceLabel : "Needs authorization"}</small>
            </div>
          </li>
          <li className={last ? "done" : ""}>
            <span>3</span>
            <div>
              <strong>Import</strong>
              <small className="muted">{last ? lastLabel : "Pending"}</small>
            </div>
          </li>
        </ol>
      </section>
    </div>
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
                ? `@${r.handle} · solved ${r.totalSolved ?? "-"}${r.rating ? ` · rating ${r.rating}` : ""}`
                : <span className="muted">error - {r.error}</span>}
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
        <div className="settings-divider" />
        <ToggleRow
          label="Auto-start Ollama when Apex launches"
          sub="Keeps Ask Apex and planning features ready without opening Ollama manually."
          checked={autoStart}
          onChange={(on) => {
            setAll({ ...all, "ollama.autoStart": String(on) });
            save("ollama.autoStart", String(on));
          }}
        />
      </div>

      <SectionHeader
        title="Assistant context"
        hint="Personal profile used by planning, reviews, burnout checks, and repo chat."
      />
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
            placeholder="Anything else the model should know - constraints, preferences, ongoing projects…"
            onChange={(e) => setAll({ ...all, "user.extraContext": e.target.value })}
            onBlur={(e) => save("user.extraContext", e.target.value)} />
        </div>
      </div>

      {/* About me - free-form profile prompt the user can paste from any
          other LLM ("write a profile of me as if I were briefing my own
          assistant"). Goes to the TOP of every system prompt. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">About me · profile prompt</div>
        <small className="hint" style={{ display: "block", marginBottom: 10 }}>
          A free-form description of you, your work style, ongoing projects,
          how you want help framed. This sits at the TOP of every Ollama
          prompt - recommendations, plan-day, evening review, repo chat all
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
                  "shipping real things - local-first apps, AI tooling, " +
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
            completed-today, and any active timer into every prompt - no need
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
    <details className="srm-diag-panel" style={{ marginTop: 12 }}>
      <summary>
        <span className="srm-diag-badge" aria-hidden>⚒</span>
        <strong>Troubleshooting report</strong>
        <small className="muted" style={{ marginLeft: "auto" }}>
          {report.cookieCount} cookies · {report.isLoggedIn ? "session active" : "session inactive"}
        </small>
      </summary>
      <div className="srm-diag-body">
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

      <details style={{ marginTop: 8 }}>
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
                  <td style={{ textAlign: "center" }}>{a.status ?? "-"}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {a.bodyLen}
                  </td>
                  <td style={{ textAlign: "center" }}>{a.sanitizeMatches}</td>
                  <td style={{ textAlign: "center" }}>
                    {a.courseTblFound ? "✓" : a.mainDivFound ? "div" : "-"}
                  </td>
                  <td style={{ textAlign: "center" }}>{a.looksLikeLogin ? "⚠" : "-"}</td>
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
                  <td style={{ textAlign: "center" }}>{a.status ?? "-"}</td>
                  <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {a.bodyLen}
                  </td>
                  <td style={{ textAlign: "center" }}>{a.sanitizeMatches}</td>
                  <td style={{ textAlign: "center" }}>{a.hasDoColumn ? "✓" : "-"}</td>
                  <td style={{ textAlign: "center" }}>{a.looksLikeLogin ? "⚠" : "-"}</td>
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
    </details>
  );
}

function GithubTab({ all, setAll, save }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">GitHub</div>
      <div className="form-row">
        <label>Your GitHub username</label>
        <input
          type="text"
          value={all["github.username"] || ""}
          placeholder="e.g. yashasvi-allen-kujur"
          onChange={(e) => setAll({ ...all, "github.username": e.target.value })}
          onBlur={(e) => save("github.username", e.target.value.trim())}
        />
        <small className="hint">
          Used by repo Compare to fetch your own repos and find ones with
          overlapping languages/topics.
        </small>
      </div>
      <div className="form-row" style={{ marginTop: 10 }}>
        <label>Personal access token (optional - boosts rate limit to 5000/hr)</label>
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

// Seed tab - one-click bulk insert of CS-student-oriented starter content.
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

// Danger zone - bulk-clear actions. Each row is a small card with an
// explanation + a button that opens an inline confirm before firing the
// IPC. Confirm uses a "type DELETE" pattern for the "everything" path so
// nobody nukes their DB by misclick.
function DangerZone({ setMsg }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <DangerRow
        label="Clear activity history"
        sub="Wipes the 10-min buckets, recorded sessions, and time entries. Your tracker keeps running afterwards. Tasks, schedule, and goals are untouched."
        confirmWord="clear"
        buttonLabel="Clear activity"
        onConfirm={async () => {
          const r = await api.activity?.clearAll?.();
          if (r?.ok) setMsg("Activity history cleared.");
          else setMsg("Failed: " + (r?.error || "unknown"));
        }}
      />
      <hr className="soft" />
      <DangerRow
        label="Clear schedule (all classes)"
        sub="Removes every class, override, academic-calendar entry, and course material. Re-import from SRM or timetable.json afterwards. Defaults will NOT auto-seed back."
        confirmWord="clear schedule"
        buttonLabel="Clear schedule"
        onConfirm={async () => {
          const r = await api.schedule?.clearAll?.();
          if (r?.ok) setMsg("Schedule cleared. Re-sync or import to repopulate.");
          else setMsg("Failed: " + (r?.error || "unknown"));
        }}
      />
      <hr className="soft" />
      <DangerRow
        label="Clear everything (activity + schedule)"
        sub="Both of the above in one shot. Tasks, notes, goals, people, repos, CP stats, integrations are kept."
        confirmWord="DELETE EVERYTHING"
        buttonLabel="Clear everything"
        destructive
        onConfirm={async () => {
          const a = await api.activity?.clearAll?.();
          const b = await api.schedule?.clearAll?.();
          if (a?.ok && b?.ok) setMsg("Activity + schedule cleared.");
          else setMsg("Partial clear: activity=" + (a?.ok ? "ok" : "fail") + ", schedule=" + (b?.ok ? "ok" : "fail"));
        }}
      />
    </div>
  );
}

function DangerRow({ label, sub, confirmWord, buttonLabel, onConfirm, destructive }) {
  const [stage, setStage] = useState("idle"); // idle | confirming | running
  const [input, setInput] = useState("");
  const matches = input.trim().toLowerCase() === confirmWord.toLowerCase();
  return (
    <div className="row between" style={{ gap: 12, alignItems: "flex-start", padding: "10px 0" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>{label}</strong>
        <small className="muted" style={{ display: "block", marginTop: 4 }}>
          {sub}
        </small>
        {stage === "confirming" && (
          <div className="row" style={{ gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
            <small className="muted">
              Type <code>{confirmWord}</code> to confirm:
            </small>
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              style={{ flex: 1, minWidth: 160, maxWidth: 320, height: 30 }}
              placeholder={confirmWord}
            />
            <button
              type="button"
              className={destructive ? "primary" : "primary"}
              disabled={!matches || stage === "running"}
              onClick={async () => {
                setStage("running");
                try { await onConfirm(); } finally {
                  setStage("idle"); setInput("");
                }
              }}
              style={destructive ? { background: "var(--distraction)", color: "#fff" } : undefined}
            >
              {stage === "running" ? "Clearing…" : "Confirm"}
            </button>
            <button
              type="button"
              className="ghost xsmall"
              onClick={() => { setStage("idle"); setInput(""); }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      {stage === "idle" && (
        <button
          type="button"
          className={destructive ? "ghost" : "ghost"}
          onClick={() => setStage("confirming")}
          style={destructive ? { borderColor: "var(--distraction)", color: "var(--distraction)" } : undefined}
        >
          {buttonLabel}
        </button>
      )}
    </div>
  );
}

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
    if (res.ok) setMsg("Database replaced - Apex will relaunch.");
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


// ─── SpotifyTab ─────────────────────────────────────────────────────────
// OAuth connect/disconnect, focus playlist picker, auto-play toggle.
function SpotifyTab({ setMsg }) {
  const [status, setStatus] = useState({ connected: false });
  const [busy, setBusy] = useState(false);
  const [playlists, setPlaylists] = useState([]);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [showCustomId, setShowCustomId] = useState(false);
  const [customId, setCustomId] = useState("");

  async function refresh() {
    const s = await api.spotify.status();
    setStatus(s || {});
    setCustomId(s?.clientId || "");
  }
  useEffect(() => { refresh(); }, []);

  async function connect() {
    setBusy(true);
    setMsg("Opening Spotify auth…");
    try {
      const r = await api.spotify.connect();
      if (r?.ok) {
        setMsg("Connected to Spotify.");
        await refresh();
      } else {
        setMsg("Connect failed: " + (r?.error || "unknown"));
      }
    } finally { setBusy(false); }
  }
  async function disconnect() {
    if (!confirm("Disconnect Spotify and forget tokens?")) return;
    await api.spotify.disconnect();
    await refresh();
    setMsg("Disconnected.");
  }
  async function loadMine() {
    const r = await api.spotify.myPlaylists(50);
    setPlaylists(r?.items || []);
  }
  async function doSearch() {
    if (!search.trim()) { setSearchResults([]); return; }
    const r = await api.spotify.searchPlaylists(search.trim(), 20);
    setSearchResults(r?.items || []);
  }
  async function pickPlaylist(p) {
    await api.spotify.setFocusPlaylist({ uri: p.uri, name: p.name });
    setMsg(`Focus playlist set: ${p.name}`);
    await refresh();
  }
  async function clearPlaylist() {
    await api.spotify.setFocusPlaylist({ uri: null });
    await refresh();
  }
  async function toggleAutoPlay() {
    await api.spotify.setAutoPlayFocus(!status.autoPlayFocus);
    await refresh();
  }
  async function saveClientId() {
    await api.spotify.setClientId(customId.trim() || null);
    setMsg(customId.trim() ? "Custom client ID saved." : "Reverted to default client ID.");
    await refresh();
  }

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between" style={{ alignItems: "baseline" }}>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Spotify · connection</div>
            <small className="hint" style={{ display: "block", marginTop: 4 }}>
              Sign in once via OAuth (PKCE - no password handling on our side).
              Apex can show what's playing and start a focus playlist when a
              productive timer kicks off.
            </small>
          </div>
          <span
            className={"pill " + (status.connected ? "teal" : "gray")}
            title={status.connected ? "Connected" : "Not connected"}
          >
            {status.connected ? "connected" : "off"}
          </span>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {!status.connected ? (
            <button className="primary" onClick={connect} disabled={busy}>
              {busy ? "Opening…" : "Connect Spotify"}
            </button>
          ) : (
            <>
              <small className="muted">
                Signed in as{" "}
                <strong>{status.user?.displayName || status.user?.id || "-"}</strong>
              </small>
              <button className="ghost" onClick={disconnect}>Disconnect</button>
            </>
          )}
          <button
            type="button"
            className="ghost xsmall"
            onClick={() => setShowCustomId((v) => !v)}
            title="Use your own Spotify Developer client_id"
          >
            {showCustomId ? "Hide advanced" : "Advanced"}
          </button>
        </div>

        {showCustomId && (
          <div className="form-row" style={{ marginTop: 10 }}>
            <label>
              Custom client_id <small className="muted">(optional - yours from developer.spotify.com)</small>
            </label>
            <div className="row" style={{ gap: 6 }}>
              <input
                value={customId}
                placeholder="leave blank to use the bundled default"
                onChange={(e) => setCustomId(e.target.value)}
                style={{ flex: 1 }}
              />
              <button className="ghost" onClick={saveClientId}>Save</button>
            </div>
            <small className="hint" style={{ marginTop: 4 }}>
              If using your own, register{" "}
              <code>http://127.0.0.1:8000/callback</code> as a redirect URI.
            </small>
          </div>
        )}

        {status.connected && status.needsReconnectForPlaylistWrite && (
          <div
            className="notice warn"
            style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
          >
            <span style={{ flex: 1, minWidth: 220 }}>
              Spotify is connected, but this token is missing playlist write permission.
              Reconnect once to let Apex create/update Zen focus playlists.
            </span>
            <button className="ghost small" onClick={connect} disabled={busy}>
              Reconnect Spotify
            </button>
          </div>
        )}
      </div>

      {status.connected && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">Focus playlist</div>
          <small className="hint" style={{ display: "block", marginBottom: 10 }}>
            Pick a playlist to start automatically when a productive Live Timer
            kicks off.
          </small>

          {status.focusPlaylistUri ? (
            <div
              className="row"
              style={{
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                border: "1px solid var(--border)",
                borderRadius: 8,
                background: "var(--bg-elev)",
              }}
            >
              <span style={{ fontSize: 18 }}>▶</span>
              <strong style={{ flex: 1 }}>{status.focusPlaylistName || "(unnamed)"}</strong>
              <button className="ghost xsmall" onClick={clearPlaylist}>Clear</button>
            </div>
          ) : (
            <small className="muted">No focus playlist set yet.</small>
          )}

          <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label className="switch" title="Start the focus playlist on productive timer">
              <input
                type="checkbox"
                checked={!!status.autoPlayFocus}
                onChange={toggleAutoPlay}
                disabled={!status.focusPlaylistUri}
              />
              <span>Auto-play on productive timer</span>
            </label>
            <button
              className="ghost xsmall"
              type="button"
              disabled={!status.focusPlaylistUri}
              onClick={async () => {
                setMsg("Testing focus playlist…");
                const r = await api.spotify.playFocusPlaylist();
                if (r?.ok) {
                  setMsg(`Playing on ${r.device || "active device"}.`);
                } else if (r?.code === "NO_DEVICES" || r?.code === "NO_ACTIVE_DEVICE") {
                  setMsg("No active Spotify device. Open Spotify on your desktop or phone, then try again.");
                } else if (r?.code === "PREMIUM_REQUIRED") {
                  setMsg("Spotify Premium is required for remote playback.");
                } else {
                  setMsg("Test failed: " + (r?.error || "unknown"));
                }
              }}
              title="Try playing the focus playlist right now"
            >
              Test play
            </button>
            <button
              className="ghost xsmall"
              type="button"
              onClick={async () => {
                const r = await api.spotify.devices();
                if (!r?.ok) {
                  setMsg("Couldn't list devices: " + (r?.error || "unknown"));
                  return;
                }
                if (!r.devices.length) {
                  setMsg("No Spotify devices found. Open Spotify somewhere first.");
                  return;
                }
                const lines = r.devices.map(
                  (d) => `${d.is_active ? "● " : "○ "}${d.name} (${d.type})`,
                );
                setMsg("Devices: " + lines.join(" · "));
              }}
              title="Show which Spotify devices are reachable right now"
            >
              Show devices
            </button>
          </div>

          <small className="hint" style={{ display: "block", marginTop: 8 }}>
            Auto-play needs an active Spotify session (desktop app, phone, or
            web player) and a Premium account. If nothing's open, Apex will
            try to wake the desktop app - but starting Spotify yourself is
            most reliable.
          </small>

          <hr className="soft" />

          <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="ghost" onClick={loadMine}>My playlists</button>
            <input
              value={search}
              placeholder="Search playlists…"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              style={{ flex: 1, minWidth: 200 }}
            />
            <button className="ghost" onClick={doSearch} disabled={!search.trim()}>
              Search
            </button>
          </div>

          {(searchResults.length > 0 || playlists.length > 0) && (
            <div
              className="spotify-playlist-grid"
              style={{ marginTop: 10 }}
            >
              {(searchResults.length > 0 ? searchResults : playlists).map((p) => {
                const isLiked = p.synthetic && p.uri === "apex:liked-songs";
                const isPrivate = p.private && !p.synthetic;
                return (
                  <button
                    key={p.uri}
                    type="button"
                    className={
                      "spotify-playlist-card" +
                      (isLiked ? " liked" : "") +
                      (isPrivate ? " private" : "")
                    }
                    onClick={() => pickPlaylist(p)}
                    title={`Set as focus playlist · ${p.tracks} tracks`}
                  >
                    {p.image ? (
                      <img src={p.image} alt="" />
                    ) : (
                      <div
                        className="spotify-playlist-fallback"
                        style={
                          isLiked
                            ? {
                                background:
                                  "linear-gradient(135deg, #4f1d8c, #aa2bd4)",
                                color: "#fff",
                              }
                            : undefined
                        }
                      >
                        {isLiked ? "♥" : "♪"}
                      </div>
                    )}
                    <div className="spotify-playlist-meta">
                      <strong>
                        {p.name}
                        {isPrivate && (
                          <span
                            className="pill gray"
                            style={{ marginLeft: 6, fontSize: 9 }}
                            title="Private playlist"
                          >
                            private
                          </span>
                        )}
                      </strong>
                      <small className="muted">
                        {isLiked
                          ? `${p.tracks} liked songs`
                          : `${p.owner ? `by ${p.owner} · ` : ""}${p.tracks} tracks`}
                      </small>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ─── AppearanceTab ──────────────────────────────────────────────────────
// Theme picker with live preview swatches. Also exposes the legacy density
// + reduced-motion toggles if we add them later.
function AppearanceTab({ all, setAll, save }) {
  const current = all["ui.theme"] || "apex-focus";
  const customAccent = all["ui.customAccent"] || "";

  // Curated catalog. Six palettes, each a distinct mood: signature teal,
  // cool slate, warm sand, green moss, OLED black, and one light. Fonts are
  // unified app-wide (Inter + Sora display + JetBrains Mono).
  const THEMES = [
    { key: "apex-focus", label: "Apex",
      desc: "Graphite + teal. The signature - matches web and mobile.",
      swatches: ["#0c0d0f", "#2ec7b4", "#ff6b7a", "#f5b84b"] },
    { key: "slate", label: "Slate",
      desc: "Cool neutral slate + soft periwinkle. Calm and pro.",
      swatches: ["#0e1014", "#8aa0ff", "#6fcf97", "#f2788c"] },
    { key: "sand", label: "Sand",
      desc: "Warm taupe + muted clay. Cozy dark.",
      swatches: ["#100f0d", "#d7a36a", "#8bc6a0", "#e0826a"] },
    { key: "moss", label: "Moss",
      desc: "Desaturated green-gray + sage. Quiet focus.",
      swatches: ["#0d100e", "#82c79e", "#d6b06a", "#e0796f"] },
    { key: "obsidian", label: "Obsidian",
      desc: "True OLED black + cyan glow. Lights off.",
      swatches: ["#000000", "#00e5ff", "#2fe6a0", "#ff4d72"] },
    { key: "default-light", label: "Daylight",
      desc: "Calm off-white + indigo. For bright rooms.",
      swatches: ["#fafbfc", "#4263eb", "#16a34a", "#ea580c"] },
  ];

  // Curated accents the user can set on top of any theme.
  const ACCENTS = [
    { name: "honey",      hex: "#e8a23a" },
    { name: "amber",      hex: "#fbbf24" },
    { name: "tangerine",  hex: "#f97316" },
    { name: "rose",       hex: "#ec4899" },
    { name: "violet",     hex: "#8b5cf6" },
    { name: "indigo",     hex: "#6366f1" },
    { name: "sky",        hex: "#3b82f6" },
    { name: "cyan",       hex: "#06b6d4" },
    { name: "emerald",    hex: "#10b981" },
    { name: "lime",       hex: "#84cc16" },
    { name: "ruby",       hex: "#ef4444" },
    { name: "ivory",      hex: "#e6edf3" },
  ];

  function setTheme(key) {
    setAll({ ...all, "ui.theme": key });
    save("ui.theme", key);
    document.documentElement.dataset.theme = key;
  }
  function setAccent(hex) {
    const v = (hex || "").trim();
    setAll({ ...all, "ui.customAccent": v });
    save("ui.customAccent", v);
    if (v) {
      document.documentElement.style.setProperty("--accent", v);
      // Derive a subtle softer + stronger sibling so cards/borders stay coherent.
      document.documentElement.style.setProperty("--accent-soft", v + "33");
      document.documentElement.style.setProperty("--accent-strong", v);
    } else {
      document.documentElement.style.removeProperty("--accent");
      document.documentElement.style.removeProperty("--accent-soft");
      document.documentElement.style.removeProperty("--accent-strong");
    }
  }

  return (
    <>
      <SettingsOverview
        items={[
          {
            label: "Theme",
            value: THEMES.find((t) => t.key === current)?.label || current,
            detail: "Curated set of five",
            tone: "ok",
          },
          {
            label: "Accent",
            value: customAccent || "Theme default",
            detail: customAccent ? "Custom override" : "Inherited",
            tone: customAccent ? "ok" : "info",
          },
          {
            label: "Contrast",
            value: all["ui.contrast"] === "high" ? "High" : "Normal",
            detail: "Dashboard + settings",
            tone: all["ui.contrast"] === "high" ? "warn" : "info",
          },
          {
            label: "Startup",
            value: (all["ui.autostart"] ?? "0") === "1" ? "Windows login" : "Manual",
            detail: (all["ui.minimizeToTray"] ?? "0") === "1" ? "Tray enabled" : "No tray minimize",
            tone: (all["ui.autostart"] ?? "0") === "1" ? "ok" : "info",
          },
        ]}
      />
      <SectionHeader
        title="Visual system"
        hint="Theme, accent, contrast, and color tokens are previewed live."
      />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between" style={{ alignItems: "baseline", marginBottom: 6 }}>
          <div className="card-title" style={{ margin: 0 }}>Theme</div>
          <small className="muted">{THEMES.length} curated</small>
        </div>
        <small className="hint" style={{ display: "block", marginBottom: 12 }}>
          Pick a palette - changes are instant. Custom accent below overrides
          the theme's default colour.
        </small>

        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.key}
              type="button"
              className={"theme-card" + (current === t.key ? " active" : "")}
              onClick={() => setTheme(t.key)}
            >
              <div className="theme-swatches">
                {t.swatches.map((c, i) => (
                  <span key={i} style={{ background: c }} />
                ))}
              </div>
              <div className="row between" style={{ alignItems: "baseline", width: "100%" }}>
                <strong>{t.label}</strong>
                {current === t.key && (
                  <span className="pill teal" style={{ fontSize: 9, padding: "1px 6px" }}>active</span>
                )}
              </div>
              <small className="muted">{t.desc}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Custom accent</div>
        <small className="hint" style={{ display: "block", marginBottom: 12 }}>
          Override the accent colour from the active theme. Leave blank to
          inherit from the theme.
        </small>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {ACCENTS.map((a) => (
            <button
              key={a.hex}
              type="button"
              className={"accent-chip" + (customAccent === a.hex ? " active" : "")}
              onClick={() => setAccent(a.hex)}
              title={`${a.name} · ${a.hex}`}
              style={{
                background: a.hex,
                width: 28, height: 28, borderRadius: "50%",
                border: customAccent === a.hex
                  ? "3px solid var(--text)"
                  : "2px solid var(--border)",
                cursor: "pointer",
              }}
            />
          ))}
          <span className="muted" style={{ marginLeft: 8 }}>or</span>
          <input
            type="color"
            value={customAccent || "#e8a23a"}
            onChange={(e) => setAccent(e.target.value)}
            style={{ width: 36, height: 32, padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "transparent" }}
            title="Pick any colour"
          />
          {customAccent && (
            <button className="ghost xsmall" type="button" onClick={() => setAccent("")}>
              Reset
            </button>
          )}
          {customAccent && (
            <code style={{ marginLeft: 4, fontSize: 11 }}>{customAccent}</code>
          )}
        </div>
      </div>

      <ContrastCard all={all} setAll={setAll} save={save} />

      <SectionHeader
        title="Window behavior"
        hint="Tray and startup settings that affect how Apex behaves outside the window."
      />
      <SystemStartupCard all={all} setAll={setAll} save={save} />

      <SectionHeader
        title="Advanced colors"
        hint="Only touch this when you want to override individual theme tokens."
      />
      <CustomColorsCard all={all} setAll={setAll} save={save} />
    </>
  );
}

// ─── SystemStartupCard ──────────────────────────────────────────────────
// Start-with-Windows + close-to-tray toggles. Each flip writes the pref
// to settings AND calls window.applyStartup() so the OS-level state
// (registry login item, tray icon) lines up with the saved preference
// without needing a restart.
function SystemStartupCard({ all, setAll, save }) {
  const [status, setStatus] = useState(null);
  const [repairing, setRepairing] = useState(false);
  const [lastAction, setLastAction] = useState(null);
  useEffect(() => {
    refreshStatus();
  }, []);

  async function refreshStatus() {
    try {
      const next = await api.window?.startupStatus?.();
      if (next) setStatus(next);
    } catch {}
  }

  async function applyStartupSettings(action = "saved") {
    setRepairing(true);
    try {
      const r = await api.window?.applyStartup?.();
      if (r?.status) setStatus(r.status);
      else await refreshStatus();
      if (r?.ok) {
        setLastAction(action);
        setTimeout(() => setLastAction(null), 1800);
      }
      return r;
    } finally {
      setRepairing(false);
    }
  }

  async function flip(key, value) {
    setAll({ ...all, [key]: value ? "1" : "0" });
    await save(key, value ? "1" : "0");
    await applyStartupSettings("saved");
  }

  const trayOn = (all["ui.minimizeToTray"] ?? "0") === "1";
  const autoOn = (all["ui.autostart"] ?? "0") === "1";
  const osOn = !!status?.openAtLogin;
  const mismatch = !!status?.hasMismatchedStartupArgs;
  const devSafe = status?.requiresAppPathArg;
  const launchMode = devSafe ? "Electron dev-safe" : "Packaged Apex";
  const startupState =
    autoOn && osOn ? "Registered"
    : autoOn && mismatch ? "Repair ready"
    : autoOn ? "Needs repair"
    : "Off";
  const startupTone =
    autoOn && osOn ? "ok"
    : autoOn ? "warn"
    : "muted";

  return (
    <div className="card system-startup-card" style={{ marginBottom: 16 }}>
      <div className="settings-card-head">
        <div>
          <div className="card-title">System</div>
          <small className="hint">
            Windows login, tray, and background launch behavior.
          </small>
        </div>
        <div className={"startup-health " + startupTone}>
          <span>{startupState}</span>
        </div>
      </div>

      <ToggleRow
        label="Minimize to system tray"
        sub="Closing the window hides Apex to the tray instead of quitting. Click the tray icon to bring it back."
        checked={trayOn}
        onChange={(v) => flip("ui.minimizeToTray", v)}
      />
      <div className="settings-divider" />
      <ToggleRow
        label="Start Apex with Windows"
        sub={
          trayOn
            ? "Launches Apex automatically at login, hidden in the tray. Click the tray icon when you need it."
            : "Launches Apex automatically at login. Window opens normally."
        }
        checked={autoOn}
        onChange={(v) => flip("ui.autostart", v)}
      />

      {status && (
        <div className="startup-status-panel">
          <div className="startup-status-grid">
            <StatusPill label="Windows login" value={status.openAtLogin ? "On" : "Off"} tone={status.openAtLogin ? "ok" : "muted"} />
            <StatusPill label="Tray" value={status.trayActive ? "Active" : "Off"} tone={status.trayActive ? "ok" : "muted"} />
            <StatusPill label="Launch mode" value={mismatch ? "Old command" : launchMode} tone={mismatch ? "warn" : devSafe ? "info" : "ok"} />
          </div>
          {mismatch && autoOn ? (
            <small className="startup-note warn">
              Windows has an older startup command. Repair rewrites it with the Apex app folder.
            </small>
          ) : devSafe && autoOn && (
            <small className="startup-note">
              Startup is registered with the Apex app folder, so Windows does not open the Electron sample screen.
            </small>
          )}
          {autoOn && (
            <div className="startup-actions">
              <button
                type="button"
                className="ghost small"
                disabled={repairing}
                onClick={() => applyStartupSettings("repaired")}
              >
                {repairing ? "Repairing..." : "Repair startup entry"}
              </button>
              {lastAction && (
                <small className="muted">
                  {lastAction === "repaired" ? "Startup entry repaired." : "Startup settings saved."}
                </small>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ label, value, tone = "muted" }) {
  return (
    <div className={"startup-status-pill " + tone}>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

// ─── ContrastCard ───────────────────────────────────────────────────────
// Toggle a high-contrast amplification mode. Sharpens borders, boosts text,
// saturates category swatches. Stored under `ui.contrast` = "high" | "normal".
function ContrastCard({ all, setAll, save }) {
  const v = all["ui.contrast"] === "high";
  function set(on) {
    const next = on ? "high" : "normal";
    setAll({ ...all, "ui.contrast": next });
    save("ui.contrast", next);
    if (on) document.documentElement.dataset.contrast = "high";
    else delete document.documentElement.dataset.contrast;
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">High contrast</div>
      <small className="hint" style={{ display: "block", marginBottom: 10 }}>
        Sharpens borders, boosts text, and saturates category colours across
        the dashboard. Useful for bright rooms or OLED displays.
      </small>
      <label className="switch">
        <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} />
        <span>{v ? "High contrast on" : "Normal contrast"}</span>
      </label>
    </div>
  );
}

// ─── CustomColorsCard ───────────────────────────────────────────────────
// Per-token colour editor. Lets the user override individual CSS variables
// on top of the active theme. Stored under `ui.customColors` as JSON.
const CUSTOM_TOKENS = [
  { key: "--bg",          label: "Background" },
  { key: "--bg-elev",     label: "Surface" },
  { key: "--bg-elev-2",   label: "Raised surface" },
  { key: "--border",      label: "Border" },
  { key: "--text",        label: "Text" },
  { key: "--text-dim",    label: "Text · dim" },
  { key: "--accent",      label: "Accent" },
  { key: "--productive",  label: "Productive" },
  { key: "--distraction", label: "Distraction" },
  { key: "--leisure",     label: "Leisure" },
  { key: "--rest",        label: "Rest" },
  { key: "--neutral",     label: "Neutral" },
  { key: "--mobile",      label: "Mobile" },
];

function CustomColorsCard({ all, setAll, save }) {
  let stored = {};
  try { stored = JSON.parse(all["ui.customColors"] || "{}") || {}; } catch { stored = {}; }
  const [open, setOpen] = useState(false);
  const [exportText, setExportText] = useState("");

  function applyOne(key, value) {
    const next = { ...stored };
    if (value) next[key] = value;
    else delete next[key];
    const json = JSON.stringify(next);
    setAll({ ...all, "ui.customColors": json });
    save("ui.customColors", json);
    if (value) document.documentElement.style.setProperty(key, value);
    else document.documentElement.style.removeProperty(key);
    // Re-derive accent-soft / accent-strong if accent changed.
    if (key === "--accent" && value) {
      document.documentElement.style.setProperty("--accent-soft", value + "33");
      document.documentElement.style.setProperty("--accent-strong", value);
    }
  }
  function clearAll() {
    for (const t of CUSTOM_TOKENS) {
      document.documentElement.style.removeProperty(t.key);
    }
    document.documentElement.style.removeProperty("--accent-soft");
    document.documentElement.style.removeProperty("--accent-strong");
    setAll({ ...all, "ui.customColors": "{}" });
    save("ui.customColors", "{}");
  }
  function doExport() {
    setExportText(JSON.stringify(stored, null, 2));
  }
  function doImport() {
    try {
      const next = JSON.parse(exportText);
      if (!next || typeof next !== "object") throw new Error("not an object");
      for (const t of CUSTOM_TOKENS) {
        if (next[t.key]) document.documentElement.style.setProperty(t.key, next[t.key]);
      }
      const json = JSON.stringify(next);
      setAll({ ...all, "ui.customColors": json });
      save("ui.customColors", json);
      setExportText("");
    } catch (e) {
      alert("Invalid JSON: " + e.message);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between" style={{ alignItems: "baseline" }}>
        <div className="card-title" style={{ margin: 0 }}>Custom colours · advanced</div>
        <button className="ghost xsmall" type="button" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      <small className="hint" style={{ display: "block", marginTop: 6 }}>
        Override individual colour tokens on top of the active theme. Empty
        cells inherit from the theme. Activity / category colours auto-update
        across the whole app.
      </small>

      {open && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 10,
              marginTop: 12,
            }}
          >
            {CUSTOM_TOKENS.map((t) => {
              const cur = stored[t.key] || "";
              return (
                <div
                  key={t.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: 8,
                    borderRadius: 8,
                    background: "var(--bg-elev-2)",
                    border: "1px solid var(--border)",
                  }}
                >
                  <input
                    type="color"
                    value={cur || "#888888"}
                    onChange={(e) => applyOne(t.key, e.target.value)}
                    style={{
                      width: 28, height: 28, padding: 0,
                      border: "1px solid var(--border)", borderRadius: 6,
                      background: "transparent", cursor: "pointer",
                    }}
                    title={t.label}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{t.label}</div>
                    <code style={{ fontSize: 10, color: "var(--text-faint)" }}>
                      {cur || "inherit"}
                    </code>
                  </div>
                  {cur && (
                    <button
                      className="ghost xsmall"
                      type="button"
                      onClick={() => applyOne(t.key, "")}
                      title="Reset to theme value"
                    >
                      ↺
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button className="ghost xsmall" type="button" onClick={clearAll}>
              Reset all
            </button>
            <button className="ghost xsmall" type="button" onClick={doExport}>
              Export JSON
            </button>
            <button
              className="ghost xsmall"
              type="button"
              onClick={doImport}
              disabled={!exportText.trim()}
            >
              Import JSON
            </button>
          </div>
          {exportText && (
            <textarea
              value={exportText}
              onChange={(e) => setExportText(e.target.value)}
              rows={6}
              style={{
                width: "100%",
                marginTop: 8,
                padding: 8,
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 11,
                background: "var(--bg)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                resize: "vertical",
              }}
              placeholder="Paste a JSON object of CSS variables here, then press Import."
            />
          )}
        </>
      )}
    </div>
  );
}

// ─── NotificationsTab ───────────────────────────────────────────────────
function NotificationsTab() {
  const [status, setStatus] = useState({});
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const s = await api.notifier.status();
    setStatus(s || {});
  }
  useEffect(() => { refresh(); }, []);

  async function setEnabled(on) {
    await api.notifier.setEnabled(on);
    refresh();
  }
  async function setLeads(opts) {
    await api.notifier.setLeads(opts);
    refresh();
  }
  async function test() {
    setBusy(true);
    await api.notifier.test();
    setBusy(false);
  }
  async function setKindFlag(key, on) {
    await api.notifier.setKindEnabled?.(key, on);
    refresh();
  }
  async function setHour(key, h) {
    await api.notifier.setHour?.(key, h);
    refresh();
  }

  return (
    <>
      <SettingsOverview
        items={[
          {
            label: "Desktop alerts",
            value: status.enabled ? "On" : "Off",
            detail: status.supported ? "OS supported" : "OS unsupported",
            tone: status.enabled ? "ok" : "warn",
          },
          {
            label: "Classes",
            value: `${status.classLeadMinutes ?? 10} min`,
            detail: "Before start",
            tone: status.kinds?.class === false ? "warn" : "info",
          },
          {
            label: "Deadlines",
            value: `${status.deadlineLeadMinutes ?? 60} min`,
            detail: "Before due",
            tone: status.kinds?.deadline === false ? "warn" : "info",
          },
          {
            label: "Daily rhythm",
            value: `${status.morningHour ?? 8}:00 / ${status.eveningHour ?? 21}:00`,
            detail: "Morning + evening",
            tone: "info",
          },
        ]}
      />

      <SectionHeader
        title="Master switch"
        hint="Local desktop notifications only. Mobile reminders are controlled on Android."
      />
      <div className="card" style={{ marginBottom: 16 }}>
        <ToggleRow
          label="Enable desktop notifications"
          sub={status.supported ? "Apex can show native Windows notifications." : "Your OS reports no notification support."}
          checked={!!status.enabled}
          onChange={setEnabled}
          disabled={!status.supported}
        />
      </div>

      <SectionHeader
        title="Timing"
        hint="Choose how early Apex warns you before classes and task deadlines."
      />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="grid-2">
          <div className="form-row">
            <label>Class start lead (min)</label>
            <input
              type="number"
              min={1}
              max={60}
              value={status.classLeadMinutes ?? 10}
              onChange={(e) =>
                setLeads({ classLeadMinutes: +e.target.value || 10 })
              }
            />
          </div>
          <div className="form-row">
            <label>Deadline lead (min)</label>
            <input
              type="number"
              min={5}
              max={240}
              value={status.deadlineLeadMinutes ?? 60}
              onChange={(e) =>
                setLeads({ deadlineLeadMinutes: +e.target.value || 60 })
              }
            />
          </div>
          <div className="form-row">
            <label>Morning digest hour (0-23)</label>
            <input
              type="number"
              min={0}
              max={23}
              value={status.morningHour ?? 8}
              onChange={(e) => setHour("morningHour", +e.target.value || 8)}
            />
          </div>
          <div className="form-row">
            <label>Evening review hour (0-23)</label>
            <input
              type="number"
              min={0}
              max={23}
              value={status.eveningHour ?? 21}
              onChange={(e) => setHour("eveningHour", +e.target.value || 21)}
            />
          </div>
        </div>
      </div>

      <SectionHeader
        title="Channels"
        hint="Turn off noisy categories without disabling the notification system."
      />
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="settings-toggle-stack">
          {[
            ["class", "Class starts", "Before each scheduled class."],
            ["deadline", "Task deadlines", "Upcoming due dates from tasks."],
            ["timer", "Timer expiry", "Focus timer complete alerts."],
            ["morning", "Morning digest", "Start-of-day plan prompt."],
            ["evening", "Evening review prompt", "End-of-day reflection prompt."],
            ["streak", "Habit streak at-risk", "Gentle warning before a habit streak breaks."],
          ].map(([k, label, sub]) => (
            <ToggleRow
              key={k}
              label={label}
              sub={sub}
              checked={status.kinds?.[k] !== false}
              onChange={(on) => setKindFlag(k, on)}
            />
          ))}
        </div>
      </div>

      <SectionHeader
        title="Test"
        hint="Confirm Windows notifications are visible before relying on them."
      />
      <div className="card" style={{ marginBottom: 16 }}>
        <button className="ghost" onClick={test} disabled={busy || !status.enabled}>
          {busy ? "Sending..." : "Send test notification"}
        </button>
      </div>
    </>
  );
}
