import React, { useEffect, useMemo, useState } from "react";
import api from "../../lib/api.js";
import ScheduleEditor from "../ScheduleEditor.jsx";
import WeeklyGoalsEditor from "../WeeklyGoalsEditor.jsx";
import { prettyAppName } from "../../lib/appName.js";

// 7 high-level groups. Each group renders one or more legacy "tabs" as
// labelled sections inside a single scrollable column. This dramatically
// cuts visual noise vs the old 12-chip strip while keeping every setting
// reachable.
// Settings tab order. Icons removed in favour of typographic clarity —
// the labels alone read cleaner and stay consistent across themes (some
// fonts render emoji oddly; some don't render them at all).
const TABS = [
  { key: "schedule",      label: "Schedule" },
  { key: "activity",      label: "Activity" },
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

  // Section descriptions — shown beneath the nav rail label on hover and
  // as a sublabel under the active section's title.
  const SECTION_BLURB = {
    schedule: "Timetable, classes, course materials",
    activity: "Tracking, mobile wellbeing, idle thresholds",
    goals: "Weekly goals, competitive-programming cadence",
    integrations: "Ollama · Spotify · GitHub",
    appearance: "Theme, accent, contrast, fonts",
    notifications: "Class alerts, deadlines, streak nudges",
    data: "Backup, restore, clear, seed",
  };
  const activeTab = TABS.find((t) => t.key === tab) || TABS[0];

  return (
    <div className="settings-layout">
      {/* Left rail — vertical section nav. Title + each section as a row
          with active-state tint. Stays pinned while the right pane
          scrolls. Replaces the cramped horizontal pill bar. */}
      <aside className="settings-rail">
        <div className="settings-rail-head">
          <h1 className="settings-rail-title">Settings</h1>
          <small className="muted">Local-only · SQLite</small>
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

      {/* Right pane — single-column content, capped at a comfortable
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
        <>
          <ActivityTab all={all} setAll={setAll} save={save} setMsg={setMsg} />
          <Collapse
            title="Mobile wellbeing"
            hint="Phone usage caps + mobile-app overrides"
          >
            <WellbeingTab all={all} setAll={setAll} save={save} setMsg={setMsg} />
          </Collapse>
        </>
      )}

      {tab === "goals" && (
        <>
          <WeeklyGoalsEditor />
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
          <OllamaTab all={all} setAll={setAll} save={save} />
          <Collapse title="Spotify" hint="Connect, focus playlist, playback controls">
            <SpotifyTab setMsg={setMsg} />
          </Collapse>
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
          <BackupTab setMsg={setMsg} />
          <Collapse
            title="Danger zone"
            hint="Bulk-clear activity / schedule / everything"
          >
            <DangerZone setMsg={setMsg} />
          </Collapse>
          <Collapse
            title="Seed content"
            hint="Populate with sample tasks, classes, habits"
          >
            <SeedTab setMsg={setMsg} />
          </Collapse>
        </>
      )}
      </main>

      {msg && <div style={{ position: "fixed", bottom: 20, right: 20 }} className="pill teal">{msg}</div>}
    </div>
  );
}

// Reusable toggle row — label + optional sublabel on the left, a proper
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

// Tiny collapsible — uses <details> so screen readers handle it natively.
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
        <div className="form-row" style={{ maxWidth: 340 }}>
          <label style={{ fontWeight: 600 }}>
            Your batch
            <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>
              (slot table used for timetable)
            </span>
          </label>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <select
              id="srm-batch-override"
              value={all["srm.batch"] || "1"}
              onChange={async (e) => {
                const v = e.target.value;
                setAll({ ...all, "srm.batch": v });
                await save("srm.batch", v);
                // Immediately rebuild classes from cached data — no network needed.
                const r = await api.srm.rebuildBatch();
                if (r?.ok) {
                  setMsg(`✓ Schedule rebuilt for Batch ${v} — ${r.classes} classes updated.`);
                } else {
                  setMsg(r?.error || `Batch saved. Do a full Sync to apply.`);
                }
              }}
              style={{ width: 100 }}
            >
              <option value="1">Batch 1</option>
              <option value="2">Batch 2</option>
            </select>
            <small className="muted">
              Changes apply instantly using cached data.
            </small>
          </div>
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
          sub="Pulls your timetable silently ~4 seconds after Apex launches."
          checked={(all["srm.autoSync"] ?? "1") !== "0"}
          onChange={(v) => {
            setAll({ ...all, "srm.autoSync": v ? "1" : "0" });
            save("srm.autoSync", v ? "1" : "0");
          }}
        />
      </div>

      {/* Rarely-touched fallback paths — tucked away. Most users only need
          the SRM auth + the editor, which are above. */}
      <Collapse
        title="Other import paths"
        hint="Use when SRM Academia is unreachable"
      >
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
      </Collapse>

      <Collapse
        title="Day-order anchor (fallback)"
        hint="Only used if the academic calendar isn't synced"
      >
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
    if (!confirm(`Delete "${it.title || it.kind}" for ${it.course_code || "—"}?`))
      return;
    await api.courseMaterials.delete(it.id);
    refresh();
  }

  // Group materials by course code for display.
  const groups = useMemo(() => {
    const map = new Map();
    for (const it of items) {
      const k = it.course_code || "—";
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
            prompt, so plan-day, recommendations, and burnout suggestions are
            grounded in the actual course content (not generic advice).
            <br />
            <strong>Local only</strong> — never leaves your machine.
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
                {code === "—" ? "General" : code}
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
                        updated {it.updated_at ? new Date(it.updated_at + "Z").toLocaleDateString() : "—"}
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
                <option value="">— general (no course) —</option>
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
            placeholder="e.g. DBMS — Unit 1: Relational Model"
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label className="row between" style={{ alignItems: "center" }}>
            <span>Body — paste syllabus / notes</span>
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
            placeholder="Paste your syllabus / unit plan / notes here. Plain text only — Apex feeds (a slice of) this into every academic AI prompt."
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
  const [err, setErr] = useState(null);

  // Rebuild the list from settings + opportunistically GC any ghost
  // entries that earlier builds left behind (empty-string values that
  // showed up as "→ <empty pill>" rows).
  async function refresh() {
    const all = await api.settings.all();
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
          placeholder="App name — e.g. Code.exe, chrome.exe, Discord"
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

// Danger zone — bulk-clear actions. Each row is a small card with an
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
              Sign in once via OAuth (PKCE — no password handling on our side).
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
                <strong>{status.user?.displayName || status.user?.id || "—"}</strong>
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
              Custom client_id <small className="muted">(optional — yours from developer.spotify.com)</small>
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
            try to wake the desktop app — but starting Spotify yourself is
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
  const current = all["ui.theme"] || "library";
  const customAccent = all["ui.customAccent"] || "";
  const [filter, setFilter] = useState(""); // search box
  const [tag, setTag] = useState("All");    // category filter

  // Curated themes catalog — ordered intentionally:
  //   1. Foundations (default-dark / light) — clean Inter, neutral.
  //   2. Dev favourites — Slate, Tokyo Night, Catppuccin, Dracula, One Dark.
  //   3. Modern minimal — Vercel, Stripe.
  //   4. Vibrant — Synthwave, Cyberpunk, Matrix, Aurora.
  //   5. Warm / serif — Library, Paper, Rosé Pine, Gruvbox, Nord, Solarized.
  //   6. OLED + violet — Obsidian, Eclipse.
  //   7. Light — Solarized Light, Latte.
  // Each has its own font assignment in the CSS layer + a unique colour
  // family so no two themes feel the same when you flip between them.
  const THEMES = [
    // Foundations
    { key: "default-dark", label: "Default · Dark", tags: ["Dark", "Default", "Cool"],
      desc: "Neutral modern dark · Inter · soft blue accent.",
      swatches: ["#0e1014", "#6aa7ff", "#5fc89c", "#ef6f6c"] },
    { key: "default-light", label: "Default · Light", tags: ["Light", "Default", "Cool"],
      desc: "Warm-tinted off-white · Inter · indigo accent.",
      swatches: ["#fafbfc", "#2563eb", "#16a34a", "#dc2626"] },
    // Dev favourites
    { key: "slate", label: "Slate", tags: ["Dark", "Cool"],
      desc: "GitHub-Dark style · Inter · sky-blue accent.",
      swatches: ["#0d1117", "#58a6ff", "#7ee787", "#ff7b72"] },
    { key: "tokyo-night", label: "Tokyo Night", tags: ["Dark", "Cool", "Pastel"],
      desc: "Indigo midnight + pastels · Inter · the dev favourite.",
      swatches: ["#1a1b26", "#7aa2f7", "#bb9af7", "#9ece6a"] },
    { key: "catppuccin", label: "Catppuccin", tags: ["Dark", "Pastel"],
      desc: "Mocha pastel night · Outfit · the internet-darling.",
      swatches: ["#1e1e2e", "#cba6f7", "#f5c2e7", "#a6e3a1"] },
    { key: "dracula", label: "Dracula", tags: ["Dark", "Bold"],
      desc: "Cult-classic purple-pink · Sora.",
      swatches: ["#282a36", "#bd93f9", "#ff79c6", "#50fa7b"] },
    { key: "one-dark", label: "One Dark", tags: ["Dark", "Cool"],
      desc: "Atom's classic — slate blue + warm coral · Inter.",
      swatches: ["#282c34", "#61afef", "#c678dd", "#98c379"] },
    // Modern minimal
    { key: "vercel", label: "Vercel", tags: ["Dark", "High contrast"],
      desc: "Pure black + white · Inter · vercel.com radical minimal.",
      swatches: ["#000000", "#ffffff", "#50e3c2", "#a1a1aa"] },
    { key: "stripe", label: "Stripe", tags: ["Dark", "Cool"],
      desc: "Cool slate + electric purple · Inter.",
      swatches: ["#0a0e1f", "#635bff", "#00d4a4", "#a78bfa"] },
    // Vibrant / character
    { key: "synthwave", label: "Synthwave", tags: ["Dark", "Neon", "Bold"],
      desc: "Vaporwave neon · Orbitron + Rajdhani.",
      swatches: ["#1a0b2e", "#ff2a6d", "#05d9e8", "#d300c5"] },
    { key: "cyberpunk", label: "Cyberpunk", tags: ["Dark", "Neon", "High contrast", "Bold"],
      desc: "Yellow + cyan · Orbitron · Night City vibes.",
      swatches: ["#0a0a0a", "#fcee0a", "#00f0ff", "#ff003c"] },
    { key: "matrix", label: "Matrix", tags: ["Dark", "Neon", "High contrast"],
      desc: "Green-on-black · VT323 · pure hacker movie.",
      swatches: ["#000000", "#00ff41", "#39ff14", "#b3ff66"] },
    { key: "aurora", label: "Aurora", tags: ["Dark", "Cool"],
      desc: "Northern-lights gradient · Outfit · teal → magenta.",
      swatches: ["#0a0e1a", "#7df9d4", "#6dc1ff", "#b685ff"] },
    // OLED + violet
    { key: "obsidian", label: "Obsidian", tags: ["Dark", "Neon", "High contrast", "Bold"],
      desc: "OLED black + electric cyan glow · Inter.",
      swatches: ["#000000", "#00e5ff", "#00ffa3", "#ff3b6b"] },
    { key: "eclipse", label: "Eclipse", tags: ["Dark", "Neon", "High contrast", "Bold"],
      desc: "Pitch-black void · Sora · royal violet glow.",
      swatches: ["#050308", "#a855f7", "#ec4899", "#4ade80"] },
    // Warm / serif
    { key: "library", label: "Library", tags: ["Dark", "Warm"],
      desc: "Warm coffee + honey amber · Outfit + Crimson Pro serif.",
      swatches: ["#14110f", "#e8a23a", "#82caa9", "#e07a5f"] },
    { key: "rose-pine", label: "Rosé Pine", tags: ["Dark", "Pastel", "Warm"],
      desc: "Soft burgundy + warm pastels · Spectral serif.",
      swatches: ["#191724", "#eb6f92", "#c4a7e7", "#9ccfd8"] },
    { key: "gruvbox", label: "Gruvbox", tags: ["Dark", "Warm"],
      desc: "Retro-grove warm · IBM Plex.",
      swatches: ["#282828", "#fabd2f", "#b8bb26", "#fb4934"] },
    { key: "nord", label: "Nord", tags: ["Dark", "Cool"],
      desc: "Arctic blue + frost teal · Inter · calm matte.",
      swatches: ["#2e3440", "#88c0d0", "#eceff4", "#a3be8c"] },
    { key: "solarized-dark", label: "Solarized Dark", tags: ["Dark", "Cool"],
      desc: "Classic dev palette · IBM Plex · easy on the eyes.",
      swatches: ["#002b36", "#268bd2", "#fdf6e3", "#b58900"] },
    // Light
    { key: "paper", label: "Paper", tags: ["Light", "Warm"],
      desc: "Cream parchment · Spectral serif · day-mode book vibe.",
      swatches: ["#f4ecd8", "#9c5b25", "#3a2f1f", "#5a8761"] },
    { key: "solarized-light", label: "Solarized Light", tags: ["Light", "Cool"],
      desc: "Light companion to Solarized Dark · IBM Plex.",
      swatches: ["#fdf6e3", "#268bd2", "#586e75", "#b58900"] },
    { key: "latte", label: "Latte", tags: ["Light", "Pastel"],
      desc: "Catppuccin Latte · Outfit · soft cream + lavender.",
      swatches: ["#eff1f5", "#8839ef", "#ea76cb", "#40a02b"] },
  ];

  const ALL_TAGS = [
    "All", "Dark", "Light", "Neon", "Pastel", "Bold", "Warm", "Cool", "High contrast",
  ];

  const filteredThemes = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return THEMES.filter((t) => {
      if (tag !== "All" && !t.tags.includes(tag)) return false;
      if (!q) return true;
      return (
        t.label.toLowerCase().includes(q) ||
        t.desc.toLowerCase().includes(q) ||
        t.tags.some((x) => x.toLowerCase().includes(q))
      );
    });
  }, [filter, tag]);

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
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row between" style={{ alignItems: "baseline", marginBottom: 6 }}>
          <div className="card-title" style={{ margin: 0 }}>Theme</div>
          <small className="muted">{filteredThemes.length} of {THEMES.length}</small>
        </div>
        <small className="hint" style={{ display: "block", marginBottom: 12 }}>
          Pick a palette — changes are instant. Filter by tag or search by
          name. Custom accent below overrides the theme's default colour.
        </small>

        <div className="row" style={{ gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
          {ALL_TAGS.map((t) => (
            <button
              key={t}
              type="button"
              className={"chip" + (tag === t ? " active" : "")}
              onClick={() => setTag(t)}
              style={{ fontSize: 11, padding: "4px 10px" }}
            >
              {t}
            </button>
          ))}
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search themes…"
            style={{
              flex: 1,
              minWidth: 160,
              padding: "5px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text)",
              fontSize: 12,
            }}
          />
        </div>

        {filteredThemes.length === 0 ? (
          <div className="muted" style={{ padding: "20px 8px", textAlign: "center" }}>
            No themes match. <button className="ghost xsmall" onClick={() => { setFilter(""); setTag("All"); }}>Clear filters</button>
          </div>
        ) : (
          <div className="theme-grid">
            {filteredThemes.map((t) => (
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
                <div className="row" style={{ gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                  {t.tags.slice(0, 3).map((x) => (
                    <span
                      key={x}
                      style={{
                        fontSize: 9,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: "var(--bg-elev-2)",
                        color: "var(--text-faint)",
                      }}
                    >
                      {x}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}
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

      <SystemStartupCard all={all} setAll={setAll} save={save} />

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
  useEffect(() => {
    api.window?.startupStatus?.().then(setStatus).catch(() => {});
  }, []);

  async function flip(key, value) {
    setAll({ ...all, [key]: value ? "1" : "0" });
    await save(key, value ? "1" : "0");
    const r = await api.window?.applyStartup?.();
    if (r?.ok) {
      // Re-pull status so the UI shows the actual OS-level state.
      api.window?.startupStatus?.().then(setStatus).catch(() => {});
    }
  }

  const trayOn = (all["ui.minimizeToTray"] ?? "0") === "1";
  const autoOn = (all["ui.autostart"] ?? "0") === "1";

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-title">System</div>
      <small className="hint" style={{ display: "block", marginBottom: 12 }}>
        How Apex behaves around the OS — start with your machine, hide to
        the tray instead of quitting when you close the window.
      </small>

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
        <small className="muted" style={{ display: "block", marginTop: 10, fontSize: 11 }}>
          OS state: login-item is <strong>{status.openAtLogin ? "on" : "off"}</strong>
          {" · "}tray icon is <strong>{status.trayActive ? "active" : "off"}</strong>.
        </small>
      )}
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
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row between" style={{ alignItems: "center" }}>
        <div>
          <div className="card-title" style={{ margin: 0 }}>Notifications</div>
          <small className="hint">
            Local desktop notifications. {status.supported ? "Supported." : "Your OS reports no notification support."}
          </small>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={!!status.enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>{status.enabled ? "On" : "Off"}</span>
        </label>
      </div>

      <hr className="soft" />

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
      </div>

      <hr className="soft" />

      <div className="grid-2">
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

      <div style={{ marginTop: 8 }}>
        {[
          ["class", "Class starts"],
          ["deadline", "Task deadlines"],
          ["timer", "Timer expiry"],
          ["morning", "Morning digest"],
          ["evening", "Evening review prompt"],
          ["streak", "Habit streak at-risk"],
        ].map(([k, label]) => (
          <label key={k} className="switch" style={{ display: "flex", margin: "4px 0" }}>
            <input
              type="checkbox"
              checked={status.kinds?.[k] !== false}
              onChange={(e) => setKindFlag(k, e.target.checked)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button className="ghost" onClick={test} disabled={busy}>
          Send test notification
        </button>
      </div>
    </div>
  );
}
