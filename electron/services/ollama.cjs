// Apex — Ollama integration. Talks to the local Ollama daemon at
// http://127.0.0.1:11434. Used for the day planner, burnout analysis,
// evening review, the freeform Ask-Apex chat, and repo summaries.

const db = require('./db.cjs');

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

// Pick the best model: prefer (1) the one the caller passed, (2) the setting,
// (3) whichever one IS installed from a preferred list, (4) first installed.
async function resolveModel(preferred) {
  const installed = await cachedModels();
  if (preferred && installed.includes(preferred)) return preferred;
  const configured = db.getSetting('ollama.model');
  if (configured && installed.includes(configured)) return configured;
  const rank = ['llama3.2', 'llama3.1', 'llama3', 'qwen2.5', 'mistral', 'phi3', 'gemma2'];
  for (const name of rank) {
    const found = installed.find((m) => m === name || m.startsWith(name + ':'));
    if (found) return found;
  }
  return installed[0] || null;
}

async function chat({ model, system, user, json = false, temperature = 0.4 }) {
  try {
    const chosen = await resolveModel(model);
    if (!chosen) {
      return {
        ok: false,
        error: 'No Ollama models installed. Run `ollama pull llama3.2` first, then Refresh models.',
      };
    }
    const res = await fetch(`${host()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chosen,
        messages: [
          system ? { role: 'system', content: system } : null,
          { role: 'user', content: user },
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
  const system = `You are Apex, a calm, precise personal planner for a CS student (Yashasvi).
Output ONLY valid JSON. No preamble. No markdown.
Respect burnout caps: if energy <= 4, cap deep work at 60 minutes; if dread >= 7, start with one small win.
Never schedule deep work during classes or labs.
Anti-burnout: max 90 min deep work in a row, insert a 10 min walk break, pair one hard problem with one easy win.
Always include at least one Leisure slot (20-30 min) — this is not optional.`;

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
  const system = `You are Apex, a calm and honest personal assistant for Yashasvi, a CS student.
Given a mood check-in and what's planned for today, give 2–4 short concrete suggestions.
Avoid pep talk. Avoid hedging. Each suggestion must be actionable in under 5 minutes OR
be a clear boundary ("cap deep work at 45 min today"). Output ONLY valid JSON.`;

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
  const system = `You are Apex, a calm, honest end-of-day journal partner for Yashasvi.
Output ONLY valid JSON. Keep total words under 120. Be specific, not generic.
Reference task titles, not vague categories.`;

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
  const system = `You are Apex, Yashasvi's burnout-aware personal coach.
Output ONLY valid JSON. You analyse the gap between what was PLANNED and what got DONE,
factoring in mood (check-in), classes, time log, and 7-day activity trend. You keep
things kind but honest. If the day was over-packed or badly aligned with energy,
say so and recommend a concrete fix. Suggestions should ALWAYS include at least one of:
  - a music break (type:"music", link:"spotify:app" or playlist URL)
  - a body/walk suggestion (type:"body")
  - a "swap" (swap an overdue deep-work task for a lighter win tomorrow)
Keep total output under 200 words of JSON content.`;

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
async function summarizeRepo({ repo, readme, ownRepos = [], model }) {
  const system = `You are Apex, a terse, technical project-explainer.
Output ONLY valid JSON. Keep each field under 2 sentences.
"things_to_learn" should be concrete topics/tools Yashasvi can go study if he wants to
build something like this. "similar_mine" should cite the user's own repo names verbatim.`;

  const readmeSlice = (readme || '').slice(0, 6000);
  const user = `Repo: ${repo?.full_name || repo?.name || 'unknown'}
Description: ${repo?.description || '(none)'}
Languages: ${Array.isArray(repo?.languages) ? repo.languages.join(', ') : (repo?.language || 'unknown')}
Topics: ${Array.isArray(repo?.topics) ? repo.topics.join(', ') : '(none)'}
Stars: ${repo?.stargazers_count ?? repo?.stars ?? 0}
Pushed: ${repo?.pushed_at || '(unknown)'}

Yashasvi's own repos (for "similar_mine"): ${ownRepos.slice(0, 50).join(', ')}

README (truncated):
${readmeSlice || '(no README)'}

Return JSON:
{
  "oneliner": "≤18 words: what this project is",
  "architecture": "1-2 sentences on how it works at a high level",
  "tech_stack": ["Language/Framework", "Key library"],
  "things_to_learn": ["specific topic 1", "specific topic 2", "specific topic 3"],
  "similar_mine": ["repo-name-1", "repo-name-2"],
  "starter_project": "one concrete mini-project Yashasvi could build to level up toward this"
}`;

  const resp = await chat({ model, system, user, json: true, temperature: 0.3 });
  if (!resp.ok) return resp;
  return safeParseJson(resp.content);
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
};
