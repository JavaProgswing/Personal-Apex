// Apex — Ollama integration. Talks to the local Ollama daemon at
// http://127.0.0.1:11434. Used for the day planner, burnout analysis,
// evening review, the freeform Ask-Apex chat, and repo summaries.

const db = require('./db.cjs');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const DEFAULT_HOST = 'http://127.0.0.1:11434';

function host() {
  return db.getSetting('ollama.host') || DEFAULT_HOST;
}

// Cache the list of installed models so we can auto-recover from a stale
// 'ollama.model' setting (e.g. user uninstalled the model → 404 on /api/chat).
let _modelCache = { at: 0, models: [] };
async function cachedModels() {
  if (Date.now() - _modelCache.at < 15_000) return _modelCache.models;
  const res = await listModels();
  _modelCache = { at: Date.now(), models: res.models || [] };
  return _modelCache.models;
}

// ───────────────────────────────────────────────────────────────────────────
// ping — tiny health probe used during auto-start
// ───────────────────────────────────────────────────────────────────────────
async function ping(ms = 1500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`${host()}/api/tags`, { signal: ctl.signal });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

// ───────────────────────────────────────────────────────────────────────────
// ensureRunning — best-effort launch of the local Ollama daemon on Windows
// (and a fallback `ollama serve` on any platform where it's on PATH).
// Returns { ok, started, already, error?, tried: [paths...] }
// ───────────────────────────────────────────────────────────────────────────
function _expandWindowsPaths() {
  const user = process.env.USERNAME || process.env.USER || '';
  const localAppData = process.env.LOCALAPPDATA || (user ? `C:\\Users\\${user}\\AppData\\Local` : null);
  const appData = process.env.APPDATA || (user ? `C:\\Users\\${user}\\AppData\\Roaming` : null);
  const paths = [];
  if (localAppData) {
    paths.push(path.join(localAppData, 'Programs', 'Ollama', 'ollama app.exe'));
    paths.push(path.join(localAppData, 'Programs', 'Ollama', 'Ollama.exe'));
    paths.push(path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'));
  }
  if (appData) {
    paths.push(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Ollama.lnk'));
  }
  return paths;
}

async function ensureRunning({ timeoutMs = 15000 } = {}) {
  const tried = [];
  if (await ping()) return { ok: true, already: true, started: false, tried };

  let launched = false;
  let err = null;

  if (process.platform === 'win32') {
    // The Windows install ships TWO executables in the same folder:
    //   - `ollama app.exe` / `Ollama.exe`  → the GUI launcher / tray app
    //   - `ollama.exe`                      → the actual CLI daemon
    // Only the second one understands `serve`. Earlier code looped
    // through _expandWindowsPaths in declaration order and broke on the
    // first existing path, which happened to be the GUI launcher — so
    // `spawn(launcher, ['serve'])` either opened the tray UI or did
    // nothing, and the daemon never came up.
    //
    // Fix: split the paths into "cli-like" (basename === ollama.exe)
    // and "gui-like", try the CLI ones first with `serve`, then PATH-
    // resolved `ollama.exe serve`, and finally fall back to launching
    // the GUI app *without* args (which starts its own embedded daemon).
    const all = _expandWindowsPaths();
    const cliPaths = all.filter((p) => {
      const base = p.split(/[\\/]/).pop().toLowerCase();
      return base === 'ollama.exe';
    });
    const guiPaths = all.filter((p) => {
      const base = p.split(/[\\/]/).pop().toLowerCase();
      return base !== 'ollama.exe' && !p.toLowerCase().endsWith('.lnk');
    });

    for (const p of cliPaths) {
      tried.push(p + ' serve');
      if (!fs.existsSync(p)) continue;
      try {
        spawn(p, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        launched = true;
        break;
      } catch (e) { err = e; }
    }
    if (!launched) {
      tried.push('ollama.exe serve (PATH)');
      try {
        spawn('ollama.exe', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        launched = true;
      } catch (e) { err = e; }
    }
    // Last resort: the GUI launcher. It starts its own daemon as a side
    // effect of opening. Yes, the tray UI may briefly appear — that's
    // the price of having Ollama working at all on this machine.
    if (!launched) {
      for (const p of guiPaths) {
        tried.push(p + ' (gui fallback)');
        if (!fs.existsSync(p)) continue;
        try {
          spawn(p, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          launched = true;
          break;
        } catch (e) { err = e; }
      }
    }
  } else {
    tried.push('ollama serve (PATH)');
    try {
      spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref();
      launched = true;
    } catch (e) { err = e; }
  }

  if (!launched) return { ok: false, started: false, error: err?.message || 'ollama binary not found', tried };

  // Poll for up to `timeoutMs` until /api/tags answers.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping()) return { ok: true, started: true, tried };
    await new Promise((r) => setTimeout(r, 750));
  }
  return { ok: false, started: true, error: 'Launched but daemon never responded', tried };
}

async function listModels() {
  try {
    const res = await fetch(`${host()}/api/tags`);
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    const data = await res.json();
    return { ok: true, models: (data.models || []).map((m) => m.name) };
  } catch (err) {
    return { ok: false, error: err.message, models: [] };
  }
}

// Preferred-chat ranking — the FIRST that's installed wins.
// Cloud-hosted gpt-oss is by far the strongest, so we prefer it when present;
// then the best general-purpose llama; tiny/fast gemma is the fallback.
// Everything after is a compatibility escape hatch.
const CHAT_MODEL_RANK = [
  'gpt-oss:120b-cloud', 'gpt-oss:20b-cloud', 'gpt-oss',
  'llama3.3', 'llama3.2', 'llama3.1', 'llama3:latest', 'llama3',
  'qwen2.5', 'qwen2', 'mistral', 'phi3', 'gemma2', 'gemma3',
];

function _matchInstalled(installed, name) {
  return installed.find((m) => m === name || m.startsWith(name + ':'));
}

// Pick the best CHAT model:
//   (1) caller-supplied (if actually installed),
//   (2) pinned setting (if installed),
//   (3) first match of CHAT_MODEL_RANK that's installed,
//   (4) first installed model.
async function resolveModel(preferred) {
  const installed = await cachedModels();
  if (preferred && installed.includes(preferred)) return preferred;
  const configured = db.getSetting('ollama.model');
  if (configured && installed.includes(configured)) return configured;
  for (const name of CHAT_MODEL_RANK) {
    const found = _matchInstalled(installed, name);
    if (found) return found;
  }
  return installed[0] || null;
}

// Auto-pick WITHOUT reading the pinned setting. The UI uses this to recommend
// a model on startup even when the user has never opened Settings.
async function autoPickBest() {
  const installed = await cachedModels();
  for (const name of CHAT_MODEL_RANK) {
    const found = _matchInstalled(installed, name);
    if (found) return found;
  }
  return installed[0] || null;
}

// Personal context — user-tunable in Settings → Ollama. We prepend a compact
// profile to every system prompt so generic models feel like "your" Apex.
//
// v1.1 additions:
//   • `user.aboutMe`          — free-form prompt the user can paste from
//                              another LLM ("write a profile of me as if I
//                              were briefing my own assistant"). When set,
//                              it's the FIRST thing the model sees.
//   • Live snapshot           — current SRM courses (subjects + codes),
//                              today's class subjects, today's open tasks
//                              (count + top 5), active timer summary,
//                              today's totals. Pulled fresh on every call,
//                              so the model always knows what's happening
//                              right now without the renderer having to
//                              wire it manually.
function personalContext({ live = true } = {}) {
  // Profile structured fields (legacy).
  let profile = {};
  const raw = db.getSetting('user.profile');
  if (raw) {
    try { profile = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { profile = {}; }
  }
  const extra = (db.getSetting('user.extraContext') || '').toString().trim();
  const aboutMe = (db.getSetting('user.aboutMe') || '').toString().trim();

  const name = profile.name || 'Yashasvi';
  const college = profile.college || 'SRM Institute of Science and Technology';
  const major = profile.major || 'Computer Science';
  const year = profile.year ? `Year ${profile.year}` : 'undergraduate';
  const interests = Array.isArray(profile.interests) && profile.interests.length
    ? profile.interests.join(', ')
    : 'systems, AI tooling, competitive programming, local-first apps';
  const goals = (profile.goals || '').toString().trim()
    || 'become a strong systems + AI engineer; ship personal projects weekly; stay healthy.';
  const tone = profile.tone || 'calm, precise, no pep talk, no hedging';

  const lines = [];

  // ── ABOUT ME (free-form, top-of-stack) ────────────────────────────────
  if (aboutMe) {
    lines.push('ABOUT THE USER (their own words)');
    lines.push(aboutMe);
    lines.push('');
  }

  // ── PROFILE (structured fields) ───────────────────────────────────────
  lines.push('USER PROFILE');
  lines.push(`- Name: ${name}`);
  lines.push(`- Education: ${major}, ${year}, ${college}`);
  lines.push(`- Core interests: ${interests}`);
  lines.push(`- Long-term goals: ${goals}`);
  lines.push(`- Preferred tone: ${tone}`);
  if (extra) lines.push(`- Extra context: ${extra}`);

  // ── LIVE SNAPSHOT (courses, today, timer) ─────────────────────────────
  if (live) {
    try {
      const live = _liveSnapshot();
      if (live) {
        lines.push('');
        lines.push('LIVE SNAPSHOT (auto-pulled, freshest data)');
        if (live.courses) lines.push(`- Courses this term: ${live.courses}`);
        if (live.todayDayOrder != null) {
          lines.push(`- Today: day order ${live.todayDayOrder} · ${live.todayClasses || '(no classes)'}`);
        } else if (live.weekday != null) {
          lines.push(`- Today: weekend / no day order`);
        }
        if (live.openTasksLine) lines.push(`- Open tasks: ${live.openTasksLine}`);
        if (live.completedTodayLine) lines.push(`- Already done today: ${live.completedTodayLine}`);
        if (live.timerLine) lines.push(`- Active timer: ${live.timerLine}`);
        if (live.todayTotalsLine) lines.push(`- Today's time totals: ${live.todayTotalsLine}`);
      }
    } catch (e) {
      // Don't let a snapshot failure break a prompt — just log and skip.
      // eslint-disable-next-line no-console
      console.warn('[ollama.personalContext] live snapshot failed:', e.message);
    }
  }

  // ── COURSE MATERIALS (syllabi, unit plans, notes the user opted in) ─
  // Capped to ~6KB so it doesn't dominate the context window.
  try {
    if (db.aiContextFromCourseMaterials) {
      const materials = db.aiContextFromCourseMaterials({ maxChars: 6000 });
      if (materials) {
        lines.push('');
        lines.push("COURSE MATERIALS (user-attached — use these to ground academic suggestions)");
        lines.push(materials);
      }
    }
  } catch { /* ignore */ }

  return lines.join('\n');
}

// Build a compact "what's happening right now" block. Pulled directly
// from the same DB the dashboard reads, so it's always in sync.
function _liveSnapshot() {
  const out = {};
  const dbh = db._db();
  // Courses (distinct by code).
  try {
    const rows = dbh
      .prepare(
        `SELECT DISTINCT code, subject FROM classes
          WHERE code IS NOT NULL AND TRIM(code) != ''
          ORDER BY code ASC LIMIT 12`,
      )
      .all();
    if (rows.length > 0) {
      out.courses = rows.map((r) => `${r.subject} (${r.code})`).join('; ');
    }
  } catch { /* no schema or empty */ }

  // Day order + today's classes.
  try {
    const timetable = require('./timetable.cjs');
    const tt = timetable.today();
    if (tt) {
      out.todayDayOrder = tt.dayOrder ?? null;
      out.weekday = new Date().getDay();
      if (Array.isArray(tt.classes) && tt.classes.length > 0) {
        out.todayClasses = tt.classes
          .slice(0, 6)
          .map((c) => `${c.start_time}–${c.end_time} ${c.subject}${c.room ? ` (${c.room})` : ''}${c.override_status ? ` [${c.override_status}]` : ''}`)
          .join('; ');
      }
    }
  } catch { /* ignore */ }

  // Open tasks (count + top 5 by priority/deadline).
  try {
    const open = db.listTasks ? db.listTasks({ kind: 'task', completed: false }) : [];
    if (open && open.length > 0) {
      const top = open
        .slice()
        .sort((a, b) => (a.priority || 3) - (b.priority || 3))
        .slice(0, 5)
        .map((t) => {
          const due = t.deadline ? ` (due ${t.deadline.slice(0, 10)})` : '';
          return `P${t.priority} ${t.title}${due}`;
        })
        .join('; ');
      out.openTasksLine = `${open.length} open · ${top}`;
    }
  } catch { /* ignore */ }

  // Completed today.
  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const rows = dbh
      .prepare(
        `SELECT title FROM tasks
          WHERE completed = 1 AND date(completed_at) = date(?)
          ORDER BY completed_at DESC LIMIT 6`,
      )
      .all(todayIso);
    if (rows.length > 0) {
      out.completedTodayLine = `${rows.length} · ${rows.map((r) => r.title).join('; ')}`;
    }
  } catch { /* ignore */ }

  // Active timer.
  try {
    const t = db.getActiveTimer ? db.getActiveTimer() : null;
    if (t) {
      const start = new Date(t.started_at).getTime();
      const elapsed = Math.max(0, Math.round((Date.now() - start) / 60000));
      const total = (t.planned_minutes || 0) + (t.extended_minutes || 0);
      const remaining = Math.max(0, total - elapsed);
      out.timerLine = `"${t.title}" (${t.kind || 'task'}) · ${elapsed}m of ${total}m, ${remaining}m left`;
    }
  } catch { /* ignore */ }

  // Today's totals.
  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const totals = db.activityTotalsOn ? db.activityTotalsOn(todayIso) : null;
    if (totals) {
      const parts = [];
      for (const k of ['productive', 'distraction', 'leisure', 'rest', 'neutral']) {
        if (totals[k]) parts.push(`${k} ${totals[k]}m`);
      }
      if (parts.length) out.todayTotalsLine = parts.join(' · ');
    }
  } catch { /* ignore */ }

  return out;
}

// Wrap a role-specific system prompt with personal context + house rules.
function buildSystem(rolePrompt) {
  return [
    personalContext(),
    '',
    'HOUSE RULES',
    "- Always speak directly to the user; don't narrate yourself in 3rd person.",
    '- Be specific: cite task titles, course codes, and numbers rather than generic advice.',
    '- Prefer concrete, testable next-actions over vague encouragements.',
    "- If asked for JSON, output ONLY valid JSON — no markdown fences, no preamble.",
    '- Keep responses compact unless the user explicitly asks for depth.',
    '',
    'ROLE',
    rolePrompt,
  ].join('\n');
}

async function chat({ model, system, user, json = false, temperature = 0.4, images }) {
  try {
    const chosen = await resolveModel(model);
    if (!chosen) {
      return {
        ok: false,
        error: 'No Ollama models installed. Run `ollama pull llama3.2` first, then Refresh models.',
      };
    }
    const userMsg = { role: 'user', content: user };
    // Ollama vision models (llama3.2-vision, llava, minicpm-v, …) accept a
    // parallel `images` array of base64-encoded PNG/JPEG payloads on the
    // user message.
    if (Array.isArray(images) && images.length > 0) {
      userMsg.images = images;
    }
    const res = await fetch(`${host()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chosen,
        messages: [
          system ? { role: 'system', content: system } : null,
          userMsg,
        ].filter(Boolean),
        stream: false,
        format: json ? 'json' : undefined,
        options: { temperature },
      }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      // On 404 the body typically explains "model X not found" — surface it.
      const hint = res.status === 404
        ? ` (model "${chosen}" not found on this host — try \`ollama pull ${chosen}\`)`
        : '';
      throw new Error(`Ollama ${res.status}${hint}${body ? ': ' + body.slice(0, 200) : ''}`);
    }
    const data = await res.json();
    return { ok: true, content: data.message?.content ?? '', model: chosen };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// chatStream — multi-turn streaming chat. Accepts a full `messages` array
// (role/content turns) plus an optional `system` prompt, streams Ollama's
// NDJSON response, and invokes `onDelta(piece)` for every token chunk. An
// AbortSignal can cancel mid-stream. Used by the interactive Ask Apex drawer.
// Returns { ok, content, model, aborted? }.
// ───────────────────────────────────────────────────────────────────────────
async function chatStream({ model, system, messages = [], temperature = 0.4, signal, onDelta } = {}) {
  try {
    const chosen = await resolveModel(model);
    if (!chosen) {
      return {
        ok: false,
        error: 'No Ollama models installed. Run `ollama pull llama3.2` first, then Refresh models.',
      };
    }
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    for (const m of messages) {
      if (!m || !m.content) continue;
      if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue;
      const mm = { role: m.role, content: String(m.content) };
      if (Array.isArray(m.images) && m.images.length > 0) mm.images = m.images;
      msgs.push(mm);
    }
    const res = await fetch(`${host()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chosen, messages: msgs, stream: true, options: { temperature } }),
      signal,
    });
    if (!res.ok || !res.body) {
      let body = ''; try { body = await res.text(); } catch {}
      const hint = res.status === 404
        ? ` (model "${chosen}" not found — try \`ollama pull ${chosen}\`)`
        : '';
      return { ok: false, error: `Ollama ${res.status}${hint}${body ? ': ' + body.slice(0, 200) : ''}` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          const piece = j.message?.content || '';
          if (piece) { full += piece; if (onDelta) { try { onDelta(piece); } catch {} } }
        } catch { /* partial line — wait for more */ }
      }
    }
    return { ok: true, content: full, model: chosen };
  } catch (err) {
    if (err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''))) {
      return { ok: true, content: '', model: null, aborted: true };
    }
    return { ok: false, error: err.message };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// planDay — produce a structured day plan respecting classes, energy, dread.
// ───────────────────────────────────────────────────────────────────────────
async function planDay({
  tasks,
  checkin,
  energyCap,
  dayOrder,
  classes,
  activeTimer,
  recentTimerSessions,
  nowIso,
  model,
}) {
  const system = buildSystem(`You are Apex, a calm, precise personal day planner.
Output ONLY valid JSON. No preamble. No markdown.
Hard constraints:
- Never schedule deep work during classes or labs; block those times out.
- Respect cancelled/moved classes — only schedule around what's effectively today.
- Respect energy: if energy<=4, cap any single deep-work block at 60 min.
- If dread>=7, the FIRST item in the plan must be an easy win (<=25 min).
- Insert a 10-minute walk/break after every 90 min deep work.
- Always include at least one Leisure slot (20–30 min) — not optional.
- Chain hard+easy: pair one hard problem with one easy follow-up when possible.
- If there's an ACTIVE timer right now, plan AROUND it: don't double-book the
  next ~timer-remaining minutes; pick up afterwards.
- CT/exam rule: if any task mentions a CT/exam with a date (e.g. "CT2 DBMS
  on 2026-06-20"), syllabus units COVERED BY THAT CT (see COURSE MATERIALS)
  outrank everything else until that date; units outside the CT syllabus get
  scheduled only after the CT date.
- Skip slots that already happened (before "now").
- Prefer a realistic plan over an ambitious one; leave 20% slack.
Output style:
- "summary": one sentence — read of the day + what today is for.
- "plan": array in chronological order; times in 24h HH:MM; duration in minutes.
- "skip": only for tasks you actively recommend pushing, each with a reason.`);

  const classLines = (classes || [])
    .map((c) => {
      const sub = c.override_status === 'added' ? `${c.subject} (extra)` : c.subject;
      return `${c.start_time}–${c.end_time} ${sub}${c.room ? ' (' + c.room + ')' : ''}${c.override_status === 'moved' || c.override_status === 'replaced' ? ' [overridden]' : ''}`;
    })
    .join('; ');

  // Active timer summary so the model doesn't double-book the present.
  let timerLine = '(none)';
  if (activeTimer) {
    const start = new Date(activeTimer.started_at).getTime();
    const elapsed = Math.max(0, Math.round((Date.now() - start) / 60000));
    const total = (activeTimer.planned_minutes || 0) + (activeTimer.extended_minutes || 0);
    const remaining = Math.max(0, total - elapsed);
    timerLine = `"${activeTimer.title}" (${activeTimer.kind || 'task'}) — ${elapsed}m elapsed of ${total}m, ${remaining}m remaining`;
  }

  // Compact summary of what was already done today (timer-logged).
  const recentBlock = (recentTimerSessions || [])
    .slice(0, 6)
    .map((s) => `${s.app || s.title || 'untitled'} — ${s.minutes}m (${s.category})`)
    .join('; ');

  const user = `Today's context:
- Now: ${nowIso || new Date().toISOString()}
- Day order: ${dayOrder ?? 'weekend'}
- Effective classes today (overrides applied): ${classLines || '(none / weekend)'}
- Active timer right now: ${timerLine}
- Already done today (recent timer/activity): ${recentBlock || '(nothing logged)'}
- Burnout check-in: ${checkin ? JSON.stringify(checkin) : 'not submitted'}
- Energy cap (minutes of deep work): ${energyCap ?? 90}

Tasks to consider (incomplete, non-class):
${JSON.stringify(
  tasks.map((t) => ({
    id: t.id, title: t.title, priority: t.priority, deadline: t.deadline,
    category: t.category, course_code: t.course_code, estimated_minutes: t.estimated_minutes,
  })), null, 2
)}

Return JSON:
{
  "summary": "one-sentence vibe read + what today is for",
  "plan": [
    { "taskId": <number or null>, "title": "...", "start": "HH:MM", "duration": <minutes>, "reason": "..." }
  ],
  "skip": [ { "taskId": <number>, "reason": "..." } ]
}`;

  const resp = await chat({ model, system, user, json: true });
  if (!resp.ok) return resp;
  return safeParseJson(resp.content);
}

// ───────────────────────────────────────────────────────────────────────────
// burnoutSuggest — 2–4 concrete suggestions based on TODAY's check-in + plan.
// ───────────────────────────────────────────────────────────────────────────
async function burnoutSuggest({
  checkin,
  todaysTasks,
  classes,
  upcomingDeadlines,
  openAcademicTasks,
  recentCompletedAcademic,
  model,
}) {
  const system = buildSystem(`You're advising a CS undergrad on what to do RIGHT NOW.
Output ONLY valid JSON. No fluff.

HARD RULES:
- 3–4 suggestions, each ≤18 words, concrete and immediately actionable.
- At LEAST 2 suggestions MUST be academic — referencing a specific course
  (by code OR subject), an upcoming deadline, or an open academic task by
  its actual title. NO generic "study smarter" / "review your notes" filler.
- Cite numbers when you can: "review DBMS unit 3 (3 sub-topics) in 30 min"
  beats "review DBMS".
- 1 suggestion may be body/recovery (walk, water, sleep) ONLY if energy<=4
  OR dread>=6 OR the user has no academic context loaded.
- 1 suggestion may be a boundary ("cap deep work at 45 min today").
- Never repeat the same suggestion twice across runs (vary it).

DO NOT suggest:
- "Take a walk" / "drink water" / "stretch" UNLESS energy<=4 or dread>=6.
- Generic "review your notes" — name a course or topic.
- Tasks the user has already completed today (listed below).
- Anything beyond the user's actual context.`);

  const classLines = (classes || [])
    .map((c) => `${c.start_time}–${c.end_time} ${c.subject}${c.code ? ' [' + c.code + ']' : ''}`)
    .join('; ');
  const deadlineLines = (upcomingDeadlines || [])
    .slice(0, 8)
    .map((t) => {
      const due = t.deadline ? ` due ${t.deadline.slice(0, 10)}` : '';
      const code = t.course_code ? ` [${t.course_code}]` : '';
      return `P${t.priority} ${t.title}${code}${due}`;
    })
    .join('; ');
  const academicOpen = (openAcademicTasks || [])
    .slice(0, 6)
    .map((t) => `${t.course_code ? '[' + t.course_code + '] ' : ''}${t.title}`)
    .join('; ');
  const completedAcademic = (recentCompletedAcademic || [])
    .slice(0, 6)
    .map((t) => `${t.course_code ? '[' + t.course_code + '] ' : ''}${t.title}`)
    .join('; ');

  const user = `Mood check-in (1–10 scales):
${JSON.stringify(checkin ?? {}, null, 2)}

Today's classes: ${classLines || '(none)'}

Open academic tasks (top): ${academicOpen || '(none)'}

Upcoming deadlines (next 7d): ${deadlineLines || '(none)'}

Already completed today (don't suggest these): ${completedAcademic || '(none)'}

All planned tasks today: ${JSON.stringify(
    (todaysTasks || []).map((t) => ({
      id: t.id, title: t.title, priority: t.priority,
      course: t.course_code, est: t.estimated_minutes,
    })), null, 2
  )}

Return JSON:
{
  "mood_read": "one sentence on the day's read",
  "suggestions": [
    {
      "type": "academic|boundary|body|swap",
      "text": "specific action ≤18 words",
      "course": "course code if applicable",
      "minutes": <number or null>
    }
  ]
}`;

  const resp = await chat({ model, system, user, json: true });
  if (!resp.ok) return resp;
  return safeParseJson(resp.content);
}

// ───────────────────────────────────────────────────────────────────────────
// eveningReview — 1–2 wins, friction, one concrete thing to try tomorrow.
// ───────────────────────────────────────────────────────────────────────────
async function eveningReview({ checkin, completedToday, timeTotals, openTasks, model }) {
  const system = buildSystem(`End-of-day journal partner. Output ONLY valid JSON.
Style:
- Total words across all fields: <=120.
- "wins": 1–2 items; each cites an actual task title the user completed.
- "friction": single sentence pointing at a pattern (not a one-off).
- "tomorrow": ONE concrete, specific action (include time or count where possible).`);

  const user = `End of day (${new Date().toLocaleDateString()}).
Check-in: ${JSON.stringify(checkin ?? {}, null, 2)}
Completed tasks: ${JSON.stringify((completedToday || []).map((t) => ({ title: t.title, category: t.category, course: t.course_code })), null, 2)}
Time totals (minutes): ${JSON.stringify(timeTotals ?? {})}
Still-open tasks count: ${(openTasks ?? []).length}

Return JSON:
{
  "wins": ["...", "..."],
  "friction": "single sentence pointing at a pattern",
  "tomorrow": "one concrete thing to try tomorrow"
}`;

  const resp = await chat({ model, system, user, json: true });
  if (!resp.ok) return resp;
  return safeParseJson(resp.content);
}

// ───────────────────────────────────────────────────────────────────────────
// burnoutCheck — END-OF-DAY analysis. Compares planned vs actual + mood.
// ───────────────────────────────────────────────────────────────────────────
async function burnoutCheck({ checkin, plan, completedToday, timeTotals, openTasks, classes, activityTrend, model }) {
  const system = buildSystem(`Burnout-aware personal coach — end-of-day read.
You analyse the gap between what was PLANNED and what got DONE, factoring in mood
(check-in), classes, time log, and 7-day activity trend. Be kind but honest —
if the day was over-packed or badly aligned with energy, say so and recommend
a concrete fix.
Rules:
- Output ONLY valid JSON. No fences.
- risk_score is an integer 0–10; use 0 for a healthy day, 10 for crisis.
- "suggestions" MUST include at least one of:
    * music   (type:"music", link:"spotify:app" or playlist URL)
    * body    (type:"body",  text:"10 min walk after dinner" etc)
    * swap    (type:"swap",  text:"move X to tomorrow, replace with Y")
- "tomorrow" is ONE concrete change, not a list.
- Keep total JSON content under 200 words.`);

  const classLines = (classes || []).map((c) => `${c.start_time}–${c.end_time} ${c.subject}`).join('; ');
  const plannedTitles = (plan?.plan || []).map((p) => `${p.start} ${p.title} (${p.duration}min)`).join('; ');
  const doneTitles = (completedToday || []).map((t) => t.title).join('; ');

  const user = `End-of-day analysis (${new Date().toLocaleDateString()}).

CHECK-IN (1–10): ${JSON.stringify(checkin ?? {}, null, 2)}

CLASSES TODAY: ${classLines || '(none)'}

MORNING PLAN (what we committed to):
${plannedTitles || '(no plan was generated)'}

ACTUALLY COMPLETED:
${doneTitles || '(nothing completed)'}

TIME TOTALS (minutes by category): ${JSON.stringify(timeTotals ?? {})}

7-DAY ACTIVITY TREND (avg minutes/day by category): ${JSON.stringify(activityTrend ?? {})}

OPEN TASKS CARRYING OVER: ${(openTasks ?? []).length}

Return JSON:
{
  "summary": "2-sentence honest read of the day",
  "risk_score": <0-10 integer>,
  "redFlags": [ "short bullet", "short bullet" ],
  "suggestions": [
    { "type": "music|body|swap|boundary|action", "text": "...", "link": "optional" }
  ],
  "tomorrow": "one concrete, specific thing to change tomorrow"
}`;

  const resp = await chat({ model, system, user, json: true, temperature: 0.5 });
  if (!resp.ok) return resp;
  const parsed = safeParseJson(resp.content);
  if (parsed.ok) {
    const iso = new Date().toISOString().slice(0, 10);
    try { db.saveBurnoutReport(iso, parsed); } catch (e) { /* non-fatal */ }
  }
  return parsed;
}

// ───────────────────────────────────────────────────────────────────────────
// summarizeRepo — "what is this project & what could Yashasvi learn from it".
// Takes the repo metadata + README + (optionally) a list of your OWN repo
// names so it can suggest which of yours are similar.
// ───────────────────────────────────────────────────────────────────────────
async function summarizeRepo({
  repo,
  readme,
  ownRepos = [],
  paths = [],
  manifests = {},
  treeTruncated = false,
  model,
}) {
  const system = buildSystem(`Terse, technical project-explainer. Output ONLY valid JSON.
You are summarising a repository the user is curious about. You will be
given the README, the file tree, and the actual contents of any well-known
manifest files (package.json, requirements.txt, Cargo.toml, Dockerfile, etc.).
Use ALL of these to produce a consistent, grounded answer:
- "tech_stack" must come from the manifests + file extensions, not just guesses.
- If a Dockerfile or compose file is present, mention it in "architecture".
- If multiple package.json files exist (monorepo), say so in "architecture".
- "things_to_learn" = concrete topics/tools the user can go study if they want to build
  something like this (names of specific libraries, papers, or concepts — not vague words).
- "similar_mine" cites the user's OWN repo names verbatim (from the provided list).
- "starter_project" is ONE buildable mini-project (1–2 weekend scope) that moves toward this repo.
- Each field under 2 sentences except the lists.`);

  const readmeSlice = (readme || '').slice(0, 5000);

  // Compact path summary — keep up to 80 lines so the model can see the
  // shape of the project without blowing the context window.
  const treeSlice = (paths || []).slice(0, 80);
  const treeBlock = treeSlice.length
    ? treeSlice.join('\n') + (treeTruncated ? '\n…(tree truncated by GitHub)' : '')
    : '(no file tree available)';

  // Truncate each manifest to ~1500 chars; cap to ~6 manifests.
  const manifestEntries = Object.entries(manifests || {}).slice(0, 6);
  const manifestBlock = manifestEntries.length
    ? manifestEntries
        .map(
          ([p, content]) =>
            `--- ${p} ---\n${(content || '').slice(0, 1500)}`,
        )
        .join('\n\n')
    : '(no manifest files found)';

  const user = `Repo: ${repo?.full_name || repo?.name || 'unknown'}
Description: ${repo?.description || '(none)'}
Languages (by bytes): ${Array.isArray(repo?.languages) ? repo.languages.join(', ') : (repo?.language || 'unknown')}
Topics: ${Array.isArray(repo?.topics) ? repo.topics.join(', ') : '(none)'}
Stars: ${repo?.stargazers_count ?? repo?.stars ?? 0}
Last push: ${repo?.pushed_at || '(unknown)'}

Yashasvi's own repos (for "similar_mine"): ${ownRepos.slice(0, 50).join(', ')}

File tree (sample):
${treeBlock}

Manifest files (verbatim, truncated):
${manifestBlock}

README (truncated):
${readmeSlice || '(no README)'}

Return JSON:
{
  "oneliner": "≤18 words: what this project is",
  "architecture": "1-2 sentences on how it actually works (cite real files / frameworks you saw)",
  "tech_stack": ["Language/Framework", "Key library", "Build tool", "Runtime / container if present"],
  "things_to_learn": ["specific topic 1", "specific topic 2", "specific topic 3"],
  "similar_mine": ["repo-name-1", "repo-name-2"],
  "starter_project": "one concrete mini-project Yashasvi could build to level up toward this"
}`;

  const resp = await chat({ model, system, user, json: true, temperature: 0.2 });
  if (!resp.ok) return resp;
  return safeParseJson(resp.content);
}

// ───────────────────────────────────────────────────────────────────────────
// chatAboutRepo — open-ended Q&A over a repo, grounded in its actual content.
// Server assembles the same rich context summarizeRepo uses (README + tree
// + manifests + recent commits + cached AI summary) and feeds it as the
// system context. Returns a single assistant message — the renderer keeps
// the conversation history and just sends the latest question.
// ───────────────────────────────────────────────────────────────────────────
async function chatAboutRepo({
  repo,
  readme,
  paths = [],
  manifests = {},
  treeTruncated = false,
  recentCommits = [],
  cachedSummary,
  history = [],
  question,
  model,
}) {
  if (!question || !question.trim()) {
    return { ok: false, error: 'No question provided' };
  }
  const systemBase = `You are a precise, technical assistant explaining a GitHub project to a curious dev.
- Ground EVERY claim in what's in the README / file tree / manifests / commits.
- If something isn't in the provided context, say so explicitly — do not invent.
- Be concrete: name files, libraries, APIs, commands.
- 3-7 sentences for an explanation, with a short list when useful.
- If the user asks "how would I run this?" cite the actual scripts/manifests.
- If asked to compare to user's own work or extend it, refer back to README/topics.
Avoid markdown headers; light **bold** and inline code are fine.`;

  const readmeSlice = (readme || '').slice(0, 5000);
  const treeBlock = (paths || []).slice(0, 80).join('\n')
    + (treeTruncated ? '\n…(tree truncated by GitHub)' : '');
  const manifestBlock = Object.entries(manifests || {})
    .slice(0, 6)
    .map(([p, c]) => `--- ${p} ---\n${(c || '').slice(0, 1500)}`)
    .join('\n\n');
  const commitBlock = (recentCommits || [])
    .slice(0, 25)
    .map((c) => `${(c.date || '').slice(0, 10)} ${c.sha?.slice(0, 7)} — ${(c.message || '').split('\n')[0].slice(0, 140)}`)
    .join('\n');
  const summaryBlock = cachedSummary
    ? `\nPRIOR AI SUMMARY (for reference, may be stale):\n${JSON.stringify(cachedSummary).slice(0, 1500)}`
    : '';

  const contextBlock = `Repo: ${repo?.full_name || repo?.name || 'unknown'}
Description: ${repo?.description || '(none)'}
Languages: ${Array.isArray(repo?.languages) ? repo.languages.join(', ') : (repo?.language || 'unknown')}
Topics: ${Array.isArray(repo?.topics) ? repo.topics.join(', ') : '(none)'}
Stars: ${repo?.stargazers_count ?? repo?.stars ?? 0}
Last push: ${repo?.pushed_at || '(unknown)'}
${summaryBlock}

FILE TREE (sample):
${treeBlock || '(no tree)'}

MANIFEST FILES (verbatim, truncated):
${manifestBlock || '(none)'}

RECENT COMMITS (newest first):
${commitBlock || '(none)'}

README (truncated):
${readmeSlice || '(no README)'}`;

  const system = buildSystem(systemBase + '\n\n' + contextBlock);

  // Convert history to alternating user/assistant turns + the new question.
  const turns = [];
  for (const h of history.slice(-10)) {
    if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
      turns.push({ role: h.role, content: String(h.content) });
    }
  }
  turns.push({ role: 'user', content: question });

  const chosen = await resolveModel(model);
  if (!chosen) return { ok: false, error: 'No Ollama models installed.' };
  try {
    const res = await fetch(`${host()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chosen,
        messages: [{ role: 'system', content: system }, ...turns],
        stream: false,
        options: { temperature: 0.25 },
      }),
    });
    if (!res.ok) {
      let body = ''; try { body = await res.text(); } catch {}
      return { ok: false, error: `Ollama ${res.status}${body ? ': ' + body.slice(0, 200) : ''}` };
    }
    const data = await res.json();
    return { ok: true, reply: data.message?.content || '', model: chosen };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// chatAboutCommit — focused Q&A on a single commit. Caller fetches the
// commit's diff/details and passes them in. Reuses the same model with a
// tighter system prompt.
// ───────────────────────────────────────────────────────────────────────────
async function chatAboutCommit({ repo, commit, history = [], question, model }) {
  if (!question || !question.trim()) {
    return { ok: false, error: 'No question provided' };
  }
  const systemBase = `You are a precise code-review assistant explaining a single git commit.
- Stick to the diff + message provided. Don't invent files or behaviour.
- 2-5 sentences, focused on intent + impact + possible side effects.
- Cite file paths and function names from the diff when relevant.`;

  const filesBlock = Array.isArray(commit?.files)
    ? commit.files
        .slice(0, 8)
        .map(
          (f) =>
            `--- ${f.filename} (${f.status}, +${f.additions || 0} -${f.deletions || 0}) ---\n` +
            (f.patch || '').slice(0, 2000),
        )
        .join('\n\n')
    : '(no file diffs available)';

  const contextBlock = `Repo: ${repo?.full_name || 'unknown'}
Commit: ${commit?.sha || ''}
Author: ${commit?.author_name || commit?.author || ''}
Date: ${commit?.date || ''}
Message: ${(commit?.message || '').slice(0, 1000)}

DIFFS (truncated):
${filesBlock}`;

  const system = buildSystem(systemBase + '\n\n' + contextBlock);
  const turns = [];
  for (const h of (history || []).slice(-6)) {
    if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
      turns.push({ role: h.role, content: String(h.content) });
    }
  }
  turns.push({ role: 'user', content: question });

  const chosen = await resolveModel(model);
  if (!chosen) return { ok: false, error: 'No Ollama models installed.' };
  try {
    const res = await fetch(`${host()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chosen,
        messages: [{ role: 'system', content: system }, ...turns],
        stream: false,
        options: { temperature: 0.2 },
      }),
    });
    if (!res.ok) {
      let body = ''; try { body = await res.text(); } catch {}
      return { ok: false, error: `Ollama ${res.status}${body ? ': ' + body.slice(0, 200) : ''}` };
    }
    const data = await res.json();
    return { ok: true, reply: data.message?.content || '', model: chosen };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// summarizeCpActivity — given a person's recent CP submissions, distil the
// topics they've been working on, strengths, and what's notable. Used in
// the CP leaderboard to one-click summarise anyone's profile (yourself
// included).
// ───────────────────────────────────────────────────────────────────────────
async function summarizeCpActivity({ person, submissions = [], stats = {}, model }) {
  if (!Array.isArray(submissions) || submissions.length === 0) {
    return {
      ok: true,
      summary: '(no recent submissions cached for this person)',
      topics: [],
      strengths: [],
    };
  }
  const system = buildSystem(`Concise CP activity summariser. Output ONLY valid JSON.
- "summary" 2-4 sentences on what they've been grinding (problems, difficulty, frequency).
- "topics" array (max 6) — DSA topics inferred from problem titles/tags (e.g. "graphs", "DP", "binary search").
- "strengths" 1-3 areas they look strong in based on rating + verdict mix.
- Don't invent platforms — only mention what's in the data.`);

  const list = submissions.slice(0, 60).map((s) => ({
    platform: s.platform,
    title: s.title,
    rating: s.rating,
    verdict: s.verdict,
    submitted_at: s.submitted_at,
  }));
  const statsLine = Object.entries(stats || {})
    .filter(([, v]) => v && typeof v === 'object')
    .map(([plat, v]) => `${plat}: ${JSON.stringify(v).slice(0, 200)}`)
    .join('\n');

  const user = `Person: ${person?.name || person?.handle || 'unknown'}

Stats:
${statsLine || '(none)'}

Recent submissions (max 60):
${JSON.stringify(list, null, 2)}

Return JSON:
{
  "summary": "2-4 sentences",
  "topics": ["topic1", "topic2"],
  "strengths": ["area1"]
}`;

  const resp = await chat({ model, system, user, json: true, temperature: 0.25 });
  if (!resp.ok) return resp;
  return safeParseJson(resp.content);
}

// ───────────────────────────────────────────────────────────────────────────
// recommendNow — "what should I do next" given the current state of the day.
// Pulls in: today's classes (effective, override-applied), open tasks,
// active live timer, recent activity, last burnout read, CP self stats.
// Returns 2–4 short, actionable recommendations the dashboard can render
// inline (each is one sentence, with an optional link to a task or page).
// ───────────────────────────────────────────────────────────────────────────
async function recommendNow({
  classes = [],
  tasks = [],
  activeTimer,
  recentTimerSessions = [],
  todayTotals,
  burnoutReport,
  cpSelf,
  weeklyGoals = [],
  nowIso,
  model,
}) {
  const system = buildSystem(`Brief, practical "what to do next" coach.
Output ONLY valid JSON.
Style:
- Each item is ONE concrete next action, max 18 words.
- No generic motivational fluff. No "drink water" filler unless burnout suggests it.
- Mix at least one DSA/CP nudge, at least one task or class-prep item, and at least one health/break item if energy/dread suggest it.
- CT/exam rule: when a task names a CT/exam date, recommend ONLY that CT's syllabus units (from course materials) until the date passes; push other units after it.
- Reference real task IDs / titles / class subjects from the input where you can.
- Skip items that are already in progress (active timer / just-logged sessions).
- Output 2 to 4 items, sorted most-impactful-first.`);

  const classesLine = classes
    .map((c) => `${c.start_time}–${c.end_time} ${c.subject}${c.override_status ? ' [' + c.override_status + ']' : ''}`)
    .join('; ');

  const taskList = (tasks || [])
    .filter((t) => !t.completed)
    .slice(0, 25)
    .map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      deadline: t.deadline,
      category: t.category,
      course_code: t.course_code,
      estimated_minutes: t.estimated_minutes,
    }));

  const goalLine = (weeklyGoals || [])
    .filter((g) => (g.progress ?? 0) < (g.target ?? 1))
    .slice(0, 6)
    .map((g) => `${g.title}: ${g.progress ?? 0}/${g.target}`)
    .join('; ') || '(none unfinished)';

  const cpLine = cpSelf
    ? Object.entries(cpSelf)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([plat, v]) => `${plat}: ${v.totalSolved ?? v.rating ?? '?'}`)
        .join('; ')
    : '(no CP data)';

  const timerLine = activeTimer
    ? `${activeTimer.title} (${activeTimer.kind}) — running`
    : '(none)';

  const recentLine = (recentTimerSessions || [])
    .slice(0, 6)
    .map((s) => `${s.app || s.title || 'untitled'} ${s.minutes}m`)
    .join('; ') || '(none yet today)';

  const burnoutLine = burnoutReport
    ? `risk ${burnoutReport.risk_score ?? '?'} · ${burnoutReport.summary || ''}`
    : '(no read)';

  const todayLine = todayTotals
    ? `productive ${todayTotals.productive || 0}m · distraction ${todayTotals.distraction || 0}m · neutral ${todayTotals.neutral || 0}m`
    : '(no totals)';

  const user = `Now: ${nowIso || new Date().toISOString()}
Effective classes today: ${classesLine || '(none)'}
Active timer: ${timerLine}
Today already done (timer-logged): ${recentLine}
Today totals: ${todayLine}
Burnout read: ${burnoutLine}
Weekly goals progress (unfinished): ${goalLine}
My CP snapshot: ${cpLine}

Open tasks (top 25):
${JSON.stringify(taskList, null, 2)}

Return JSON:
{
  "recommendations": [
    {
      "kind": "task|cp|class-prep|break|health|reflection|other",
      "text": "concrete next action, ≤18 words",
      "taskId": <number or null>,
      "estimated_minutes": <number or null>,
      "reason": "≤14 words on why now"
    }
  ]
}`;

  const resp = await chat({ model, system, user, json: true, temperature: 0.3 });
  if (!resp.ok) return resp;
  return safeParseJson(resp.content);
}

// ───────────────────────────────────────────────────────────────────────────
// summarizeRecentChanges — given a list of recent commits to a repo, produce
// a short "what changed in the last N days" summary. Used by the Classmate
// Activity push-card expand pane so you can see at a glance what someone
// has been shipping without combing through commit messages by hand.
// ───────────────────────────────────────────────────────────────────────────
async function summarizeRecentChanges({ repo, commits, model }) {
  const list = (commits || []).slice(0, 30);
  if (list.length === 0) {
    return { ok: true, summary: '(no recent commits)', themes: [] };
  }

  const system = buildSystem(`Concise, factual change-log summariser. Output ONLY valid JSON.
- "summary" is 2–4 sentences describing what's been worked on, grounded in the commit messages.
- "themes" is a short array of high-level buckets (max 5): "refactor", "bugfix", "new feature", "tests", "docs", "config", "deps", etc — only those that actually fit.
- "highlight" is the single most interesting commit (cite by message, not sha).
- Never invent commits or features. If the messages are noisy/uninformative, say so.`);

  const messages = list
    .map((c) => {
      const date = c.date ? c.date.slice(0, 10) : '';
      const msg = (c.message || '').split('\n')[0].slice(0, 140);
      return `${date} ${c.sha.slice(0, 7)} — ${msg}`;
    })
    .join('\n');

  const user = `Repo: ${repo?.full_name || repo?.name || 'unknown'}
${repo?.description ? `Description: ${repo.description}` : ''}

Recent commits (newest first, max 30):
${messages}

Return JSON:
{
  "summary": "2-4 sentences on what's been worked on",
  "themes": ["refactor", "bugfix", ...],
  "highlight": "single most interesting commit, by message"
}`;

  const resp = await chat({ model, system, user, json: true, temperature: 0.2 });
  if (!resp.ok) return resp;
  const parsed = safeParseJson(resp.content);
  return parsed.ok ? { ok: true, ...parsed } : parsed;
}

// ───────────────────────────────────────────────────────────────────────────
// ocrTimetable — vision-OCR one or more timetable images.
// Each image is expected to depict (part of) a weekly class schedule.
// Returns rows matching the classes table schema.
// ───────────────────────────────────────────────────────────────────────────
// True if the model name *looks* vision-capable. Conservative — we'd rather
// reject a fine model than silently send images to a chat-only model that
// will ignore them and return zero rows.
function isVisionModel(name) {
  if (!name) return false;
  return /vision|llava|minicpm-v|bakllava|cogvlm|moondream|qwen2-vl|qwen2\.5-vl/i.test(
    name,
  );
}

async function ocrTimetable({ imagesBase64, hint, model }) {
  if (!Array.isArray(imagesBase64) || imagesBase64.length === 0) {
    return { ok: false, error: 'No images provided' };
  }
  // Require a vision-capable model. If the caller passed a non-vision name,
  // override it — a chat-only model would silently drop the images and
  // produce zero rows, which is confusing as hell.
  const installed = await cachedModels();
  const visionRank = [
    'llama3.2-vision', 'llama3.2-vision:11b', 'llama3.2-vision:90b',
    'minicpm-v', 'llava', 'llava-llama3', 'llava-phi3', 'bakllava',
    'moondream', 'qwen2.5-vl', 'qwen2-vl',
  ];
  const matchInstalled = (name) =>
    installed.find((m) => m === name || m.startsWith(name + ':'));

  let chosen = null;
  // 1) Honour the user's pick if it actually IS vision-capable.
  if (model && installed.includes(model) && isVisionModel(model)) {
    chosen = model;
  }
  // 2) Otherwise fall back to the first installed vision model from our rank.
  if (!chosen) {
    for (const v of visionRank) {
      const found = matchInstalled(v);
      if (found) { chosen = found; break; }
    }
  }
  // 3) Final fallback: any installed model that smells vision-capable.
  if (!chosen) {
    chosen = installed.find(isVisionModel) || null;
  }

  if (!chosen) {
    return {
      ok: false,
      error:
        'No Ollama vision model installed. Run `ollama pull llama3.2-vision` ' +
        '(or `minicpm-v` / `moondream` for smaller alternatives), then try again.',
      installed,
    };
  }
  if (model && model !== chosen) {
    // Caller passed something but we overrode it — surface that in the
    // result so the UI can update the dropdown.
    // eslint-disable-next-line no-console
    console.warn(
      `[ocrTimetable] caller asked for "${model}" but that's not vision-capable; using "${chosen}" instead.`,
    );
  }

  const system = `You are a precise OCR + structuring assistant.
You will be shown an image (or images) of a college timetable for a CS student at SRM.
Extract every class you can see and return ONLY valid JSON of the following shape.
Do not invent classes. If something is unreadable, OMIT it rather than guessing.
Combine consecutive cells of the same course into a single row with a single
start_time and end_time.
Times must be 24-hour "HH:MM" format. Remember SRM afternoon slots are PM
(e.g. "01:20" drawn with no suffix usually means 13:20 if it sits in the
afternoon columns).
Day orders are 1..5 (Mon..Fri in most timetables; use the header you see).
If the image labels rows as "Day 1/Day 2/…" or "Day order 1/2/…", use those;
otherwise infer from row position (top=1).`;

  const user =
    `Return JSON exactly:\n\n` +
    `{\n` +
    `  "rows": [\n` +
    `    { "day_order": 1, "period": 1, "subject": "PQT", "code": "21MAB204T", ` +
    `"room": "TP 205", "faculty": null, "start_time": "08:00", "end_time": "09:40", ` +
    `"kind": "lecture" }\n` +
    `  ]\n` +
    `}\n\n` +
    `\`kind\` is one of: "lecture" | "lab" | "tutorial".\n` +
    (hint ? `Context / hint from the user: ${hint}\n` : '');

  const resp = await chat({
    model: chosen,
    system,
    user,
    images: imagesBase64,
    json: true,
    temperature: 0.1,
  });
  if (!resp.ok) return resp;
  const parsed = safeParseJson(resp.content);
  if (!parsed.ok) {
    return { ...parsed, modelUsed: chosen };
  }
  return {
    ok: true,
    rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    model: chosen,
    modelUsed: chosen,
    requestedModel: model || null,
  };
}

function safeParseJson(content) {
  try { return { ok: true, ...JSON.parse(content) }; } catch {}
  const m = content.match(/\{[\s\S]*\}/);
  if (m) {
    try { return { ok: true, ...JSON.parse(m[0]) }; } catch {}
  }
  return { ok: false, error: 'Could not parse Ollama output as JSON', raw: content };
}

// ───────────────────────────────────────────────────────────────────────────
// extractTasksFromText — turn a wall of pasted text (chat transcripts,
// meeting notes, syllabus paragraphs, plan emails, anything) into a clean
// list of tasks the user can review + bulk-create.
//
// We deliberately bias toward MORE extractions than fewer — easier to
// uncheck a noisy row than re-paste to add a missing one.
// ───────────────────────────────────────────────────────────────────────────
async function extractTasksFromText({ text, intent, model, courseContext } = {}) {
  if (!text || !String(text).trim()) {
    return { ok: false, error: 'Paste something first.' };
  }
  const system = buildSystem(`You're an inbox-zero assistant: parse a freeform
text dump (chat transcript, plan email, meeting recap, syllabus, etc.) and
emit STRUCTURED TASKS the user should add to their personal tracker.

Output ONLY valid JSON — no markdown fences, no preamble.

For each actionable item, real plan, deadline, study topic, or "thing
worth tracking" you find in the text, emit ONE task with:
- "title"            : ≤72 chars, imperative voice ("Read Heartbleed write-up", not "I should read…")
- "kind"             : "task" | "habit" | "interest"
- "category"         : one of: "Deep work" | "DSA" | "Academics" | "Project" | "Social" | "Personal" | "Health" | "Leisure"
- "priority"         : 1 (urgent) – 5 (someday). Use 3 by default; raise/lower only with a reason.
- "estimated_minutes": rough time. null if unclear.
- "deadline"         : ISO date "YYYY-MM-DD" if mentioned/implied; null otherwise.
- "description"      : ONE sentence of grounding context pulled from the source.
- "links"            : array of any URLs cited for that item.
- "tags"             : array — always include "apex-import"; add "explore" or "study" if relevant.

Hard rules:
- DO NOT invent deadlines/numbers not in the source text.
- DO NOT emit a task for advice that's purely conversational ("good luck!") — only real next-actions.
- DEDUPE: if two parts of the source describe the same action, emit one task.
- If the dump is a list of resources/links, group by intent (e.g. "Skim Exploit-DB CVE writeups" beats 30 individual link tasks).
- "Long-term goals" or whole topics → kind="interest" with a generous estimate.
- For named tools / protocols / topics, set "Project" or "Personal" category and add the topic to "tags".

Return shape:
{
  "summary": "1-sentence read of what the dump is about",
  "topic":   "kebab-case topic tag if obvious (e.g. 'reverse-engineering', 'dbms')",
  "tasks":   [ {…fields above…} ]
}`);

  const intentLine = intent && intent.trim()
    ? `User intent / framing: "${intent.trim().slice(0, 200)}"\n\n`
    : '';
  const courseBlock = courseContext && String(courseContext).trim()
    ? `Known course/syllabus context (use to infer course_code/category when the source mentions matching topics; do not create tasks from this block alone):\n${String(courseContext).slice(0, 6000)}\n\n`
    : '';

  const user = `${intentLine}${courseBlock}Source dump (verbatim, may be a chat transcript with both speakers):

"""
${String(text).slice(0, 18_000)}
"""

Extract tasks now. Return JSON only.`;

  const resp = await chat({ model, system, user, json: true, temperature: 0.2 });
  if (!resp.ok) return resp;
  return safeParseJson(resp.content);
}

// ───────────────────────────────────────────────────────────────────────────
// walkthroughFile — guided file-by-file repo tour. Given the current file
// contents + the path + the repo's previously-seen files, produce a short,
// teacher-style explanation of THIS file: what it does, why it exists in
// this codebase, what to look at next. The model is told to assume
// "yashasvi is reading this to learn how to build something similar".
// ───────────────────────────────────────────────────────────────────────────
async function walkthroughFile({
  repo,
  filePath,
  fileContent,
  visitedPaths = [],
  treeSnapshot = [], // first ~50 paths for context
  tourPlan = null, // [{path, purpose}] — the planned tour
  stepIndex = -1, // 0-based position in the plan, -1 if off-tour
  model,
}) {
  // The model gets the FULL tour plan so it can build narrative
  // continuity ("you saw X earlier, you'll see Y next"). It also gets
  // the current step's `purpose` label so the explanation focuses on
  // why this file matters in the reading flow we picked.
  const onTour = stepIndex >= 0 && Array.isArray(tourPlan) && tourPlan.length > 0;
  const planPreview = onTour
    ? tourPlan
        .map((s, i) => {
          const marker = i === stepIndex ? ' ←  YOU ARE HERE' : (i < stepIndex ? ' ✓' : '');
          return `  ${i + 1}. ${s.path}  · ${s.purpose}${marker}`;
        })
        .join('\n')
    : null;
  const isLast = onTour && stepIndex === tourPlan.length - 1;
  const isFirst = onTour && stepIndex === 0;

  const sys =
    `You are a senior engineer giving a guided code walkthrough to a CS ` +
    `undergrad named Yashasvi who wants to learn how to build something ` +
    `similar to this project.\n\n` +
    (onTour
      ? `You are following a PLANNED TOUR. The user is on step ${stepIndex + 1} ` +
        `of ${tourPlan.length}. The whole tour plan is shown below — you can ` +
        `reference what you've explained before and tease what's coming. ` +
        `Stay focused on THIS file's purpose label.\n\n`
      : `The user clicked into a file outside the planned tour — explain it ` +
        `on its own merits.\n\n`) +
    `Output structure (markdown):\n` +
    `**${onTour ? `Step ${stepIndex + 1}/${tourPlan.length} · ${tourPlan[stepIndex]?.purpose || filePath}` : `Purpose`}** — 1-2 sentences: what this file is and where it sits ` +
    `in the runtime/build flow.\n` +
    `**Key parts** — 3-5 bullets, each naming a real symbol/section from the ` +
    `code (e.g. \`function foo()\`, the \`useEffect\` hook). Crisp what + why.\n` +
    `**Concrete example** — ONE non-trivial bit shown working on an actual ` +
    `input/example. Keep code ≤6 lines.\n` +
    (isLast
      ? `**End of tour** — 1 sentence acknowledging this is the final step. ` +
        `Don't include "Look at next".\n`
      : onTour
        ? `**Coming up:** \`${tourPlan[stepIndex + 1]?.path}\` — 1 line on why ` +
          `it's the natural next step (matches the planned tour).\n`
        : `**Look at next:** \`<path/from/tree>\` — pick the most logical next ` +
          `file from the tree (not already visited).\n`) +
    `\nBe concrete. Reference real names. Don't regurgitate the file. ` +
    `Stay under 240 words.${isFirst ? ' Since this is the first step, briefly say what kind of project this is in 1 sentence at the top before "Step 1/...".' : ''}`;

  const treePreview = (treeSnapshot || []).slice(0, 50).join('\n');
  const visitedPreview = (visitedPaths || []).slice(-8).join(', ');
  const user =
    `Repo: ${repo.full_name || repo.name}\n` +
    `Languages: ${(repo.languages || []).join(', ') || 'unknown'}\n` +
    (onTour
      ? `\n--- Planned tour ---\n${planPreview}\n`
      : '') +
    `\nAlready visited: ${visitedPreview || '(none yet)'}\n\n` +
    `--- Project tree (first 50 paths) ---\n${treePreview}\n\n` +
    `--- Current file: ${filePath} ---\n${(fileContent || '').slice(0, 7000)}\n\n` +
    `Now explain ${filePath} following the structure above.`;
  const r = await chat({ model, system: sys, user, temperature: 0.4 });
  return r;
}

// Tour recap — synthesize how all the visited files fit together. Called
// at the end of the walkthrough or whenever the user asks "how does it
// all work together?". Has access to the plan but NOT the file contents
// (would blow context); references files by path + purpose.
async function walkthroughRecap({
  repo,
  tourPlan = [],
  treeSnapshot = [],
  model,
}) {
  const sys =
    `You are a senior engineer giving a final synthesis to a CS undergrad ` +
    `who just finished a guided tour of an open-source project. Your job: ` +
    `connect the dots — explain how the files they just saw work together ` +
    `at runtime / build time.\n\n` +
    `Output (markdown):\n` +
    `**The big picture** — 2-3 sentences on the project's overall flow ` +
    `(boot → render → user action → effect, or equivalent).\n` +
    `**How the files connect** — 4-6 bullets, each linking 2 files from ` +
    `the tour with arrow notation: \`A.tsx → B.ts (calls fooBar())\`. ` +
    `Reference real symbol names where you can.\n` +
    `**The mental model to take away** — 2-3 lines: the architectural ` +
    `pattern this project uses (e.g. "single-page React app with file-` +
    `based routing + a thin Node API layer").\n` +
    `**To build something similar** — 3 concrete first steps the user ` +
    `should take in their own project, in order.\n\n` +
    `Stay under 280 words.`;
  const planPreview = tourPlan
    .map((s, i) => `  ${i + 1}. ${s.path}  · ${s.purpose}`)
    .join('\n');
  const user =
    `Repo: ${repo.full_name || repo.name}\n` +
    `Languages: ${(repo.languages || []).join(', ') || 'unknown'}\n\n` +
    `--- Tour we just completed ---\n${planPreview}\n\n` +
    `--- Project tree (first 50) ---\n${(treeSnapshot || []).slice(0, 50).join('\n')}\n\n` +
    `Now synthesize the tour.`;
  return await chat({ model, system: sys, user, temperature: 0.4 });
}

// ───────────────────────────────────────────────────────────────────────────
// compareRepos — side-by-side analysis of two projects (target vs mine).
// First call (no `question`) produces the structured comparison; later
// calls treat `question` as a follow-up grounded in BOTH project contexts.
// ───────────────────────────────────────────────────────────────────────────
async function compareRepos({ target, mine, history = [], question, model }) {
  // Trim each project's tree to the most informative paths so we don't
  // blow the context window. Keep manifests and the top-level source dirs.
  const trimPaths = (paths) => {
    if (!Array.isArray(paths)) return [];
    const noise = /(^|\/)(node_modules|dist|build|\.next|\.cache|coverage|vendor|target|venv|__pycache__)\//i;
    return paths.filter((p) => !noise.test(p)).slice(0, 60);
  };
  // Topics may be an array OR a JSON-encoded string (DB column). Coerce.
  const asArr = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; }
      catch { return []; }
    }
    return [];
  };
  const sketch = (r) => {
    const t = trimPaths(r.paths || []).join('\n');
    const manifestKeys = Object.keys(r.manifests || {});
    const manifestPreview = manifestKeys.length
      ? '\n--- manifests: ' + manifestKeys.join(', ')
      : '';
    const readmeFirst = (r.readme || '').slice(0, 1200);
    return (
      `# ${r.full_name || r.name}\n` +
      `langs: ${asArr(r.languages).join(', ') || 'unknown'}\n` +
      `desc: ${r.description || '(none)'}\n` +
      `topics: ${asArr(r.topics).join(', ') || '-'}\n` +
      manifestPreview +
      `\n--- README (first ~1200) ---\n${readmeFirst}\n` +
      `\n--- tree (first 60 paths) ---\n${t}\n`
    );
  };

  if (!question) {
    // Initial structured comparison.
    const sys =
      `You are a senior engineer doing a side-by-side comparison of TWO ` +
      `projects for a CS undergrad named Yashasvi.\n\n` +
      `One is the project he's exploring (TARGET); the other is one of his ` +
      `OWN existing repos (MINE). Both share frameworks/ideas. Help him ` +
      `learn by drawing the parallels — what's the same idea, what's done ` +
      `differently, and what specific things his repo could borrow.\n\n` +
      `Output structure (markdown):\n` +
      `**Shared idea** — 1-2 sentences: what both projects fundamentally do ` +
      `or share architecturally.\n` +
      `**Same approach** — 2-4 bullets: patterns/frameworks/structures both ` +
      `use, naming the actual paths or symbols where possible.\n` +
      `**Different approach** — 2-4 bullets: where they diverge, with the ` +
      `concrete what + why for each.\n` +
      `**What MINE could borrow** — 2-4 actionable suggestions for the ` +
      `user's own repo, prefixed by file paths in MINE that would change ` +
      `(e.g. \`src/router.ts → switch to file-based routing because ...\`).\n\n` +
      `Stay under 320 words. Reference real paths and library names.`;
    const user =
      `=== TARGET ===\n${sketch(target)}\n\n` +
      `=== MINE ===\n${sketch(mine)}\n\n` +
      `Now write the comparison.`;
    return await chat({ model, system: sys, user, temperature: 0.4 });
  }

  // Follow-up Q&A — same context, conversation accumulator.
  const sys =
    `You are continuing a comparison conversation between TWO projects ` +
    `(TARGET and MINE) for Yashasvi. You have full context on both. Answer ` +
    `his follow-up question concretely, referencing actual file paths and ` +
    `symbols. If asked "how would I do X", give a short code-shape sketch ` +
    `(<= 8 lines) using paths from MINE so he can apply it directly. ` +
    `Stay under 220 words.`;
  const historyPreview = history.slice(-6)
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  const user =
    `=== TARGET ===\n${sketch(target)}\n\n` +
    `=== MINE ===\n${sketch(mine)}\n\n` +
    (historyPreview ? `=== Conversation so far ===\n${historyPreview}\n\n` : '') +
    `=== New question ===\n${question}\n\nAnswer.`;
  return await chat({ model, system: sys, user, temperature: 0.4 });
}

module.exports = {
  listModels, chat, chatStream, planDay, burnoutSuggest, eveningReview, burnoutCheck, summarizeRepo,
  summarizeRecentChanges, recommendNow, chatAboutRepo, chatAboutCommit,
  summarizeCpActivity, extractTasksFromText, walkthroughFile, walkthroughRecap, compareRepos,
  ocrTimetable, autoPickBest, resolveModel, personalContext, buildSystem,
  ping, ensureRunning,
};
