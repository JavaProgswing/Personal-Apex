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
    for (const p of _expandWindowsPaths()) {
      tried.push(p);
      if (!fs.existsSync(p)) continue;
      try {
        if (p.toLowerCase().endsWith('.lnk')) {
          // Start-Process can follow .lnk shortcuts.
          spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath "${p}"`], {
            detached: true, stdio: 'ignore', windowsHide: true,
          }).unref();
        } else {
          spawn(p, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        }
        launched = true;
        break;
      } catch (e) { err = e; }
    }
    // Absolute last resort: try `ollama.exe serve` on PATH.
    if (!launched) {
      tried.push('ollama.exe serve (PATH)');
      try {
        spawn('ollama.exe', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        launched = true;
      } catch (e) { err = e; }
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
function personalContext() {
  // Profile is stored as a JSON string in settings. Tolerate legacy objects.
  let profile = {};
  const raw = db.getSetting('user.profile');
  if (raw) {
    try { profile = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { profile = {}; }
  }
  const extra = (db.getSetting('user.extraContext') || '').toString().trim();
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
  return [
    `USER PROFILE`,
    `- Name: ${name}`,
    `- Education: ${major}, ${year}, ${college}`,
    `- Core interests: ${interests}`,
    `- Long-term goals: ${goals}`,
    `- Preferred tone: ${tone}`,
    extra ? `- Extra context: ${extra}` : null,
  ].filter(Boolean).join('\n');
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
// planDay — produce a structured day plan respecting classes, energy, dread.
// ───────────────────────────────────────────────────────────────────────────
async function planDay({ tasks, checkin, energyCap, dayOrder, classes, model }) {
  const system = buildSystem(`You are Apex, a calm, precise personal day planner.
Output ONLY valid JSON. No preamble. No markdown.
Hard constraints:
- Never schedule deep work during classes or labs; block those times out.
- Respect energy: if energy<=4, cap any single deep-work block at 60 min.
- If dread>=7, the FIRST item in the plan must be an easy win (<=25 min).
- Insert a 10-minute walk/break after every 90 min deep work.
- Always include at least one Leisure slot (20–30 min) — not optional.
- Chain hard+easy: pair one hard problem with one easy follow-up when possible.
- Prefer a realistic plan over an ambitious one; leave 20% slack.
Output style:
- "summary": one sentence — read of the day + what today is for.
- "plan": array in chronological order; times in 24h HH:MM; duration in minutes.
- "skip": only for tasks you actively recommend pushing, each with a reason.`);

  const classLines = (classes || [])
    .map((c) => `${c.start_time}–${c.end_time} ${c.subject}${c.room ? ' (' + c.room + ')' : ''}`)
    .join('; ');

  const user = `Today's context:
- Day order: ${dayOrder ?? 'weekend'}
- Classes today: ${classLines || '(none / weekend)'}
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
async function burnoutSuggest({ checkin, todaysTasks, classes, model }) {
  const system = buildSystem(`Given a mood check-in and what's planned for today, give 2–4 concrete suggestions.
Rules:
- Each suggestion is EITHER actionable in <5 min OR a clear boundary ("cap deep work at 45 min today").
- At least one must be a micro-body action (walk, stretch, water) if dread>=6 or energy<=4.
- Reference actual task titles where relevant — not generic advice.
- Output ONLY valid JSON.`);

  const classLines = (classes || []).map((c) => `${c.start_time}–${c.end_time} ${c.subject}`).join('; ');
  const user = `Mood check-in (1–10 scales):
${JSON.stringify(checkin ?? {}, null, 2)}

Today's classes: ${classLines || '(none)'}

Today's planned tasks: ${JSON.stringify(
    (todaysTasks || []).map((t) => ({
      id: t.id, title: t.title, priority: t.priority, estimated_minutes: t.estimated_minutes,
    })), null, 2
  )}

Return JSON:
{
  "mood_read": "one sentence",
  "suggestions": [
    { "type": "action|boundary|swap|music", "text": "...", "link": "optional spotify:track: or https://…" }
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
// ocrTimetable — vision-OCR one or more timetable images.
// Each image is expected to depict (part of) a weekly class schedule.
// Returns rows matching the classes table schema.
// ───────────────────────────────────────────────────────────────────────────
async function ocrTimetable({ imagesBase64, hint, model }) {
  if (!Array.isArray(imagesBase64) || imagesBase64.length === 0) {
    return { ok: false, error: 'No images provided' };
  }
  // Require a vision-capable model. If the caller didn't specify, try to
  // auto-select from a known-good vision list.
  const installed = await cachedModels();
  const visionRank = ['llama3.2-vision', 'llama3.2-vision:11b', 'minicpm-v',
    'llava', 'llava-llama3', 'llava-phi3', 'bakllava'];
  let chosen = model;
  if (!chosen || !installed.includes(chosen)) {
    for (const v of visionRank) {
      const found = installed.find((m) => m === v || m.startsWith(v + ':'));
      if (found) { chosen = found; break; }
    }
  }
  if (!chosen) {
    return {
      ok: false,
      error: 'No Ollama vision model installed. Try `ollama pull llama3.2-vision` first.',
    };
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
  if (!parsed.ok) return parsed;
  return { ok: true, rows: Array.isArray(parsed.rows) ? parsed.rows : [], model: chosen };
}

function safeParseJson(content) {
  try { return { ok: true, ...JSON.parse(content) }; } catch {}
  const m = content.match(/\{[\s\S]*\}/);
  if (m) {
    try { return { ok: true, ...JSON.parse(m[0]) }; } catch {}
  }
  return { ok: false, error: 'Could not parse Ollama output as JSON', raw: content };
}

module.exports = {
  listModels, chat, planDay, burnoutSuggest, eveningReview, burnoutCheck, summarizeRepo,
  ocrTimetable, autoPickBest, resolveModel, personalContext, buildSystem,
  ping, ensureRunning,
};
