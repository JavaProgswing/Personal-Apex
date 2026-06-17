// Apex Recall — model routing (P3). Decides whether a window's recap is produced
// locally (Ollama vision / text) or in the cloud (Gemini), and owns the prompts.
//   recall.model setting: "auto" | "local" | "cloud"
//     auto  → local first; escalate to Gemini if local fails, OR cloud-first for
//             a "deep" window (when a key is set)
//     local → Ollama only
//     cloud → Gemini first, fall back to local
// Privacy: only reduced keyframes + the locally-made transcript ever go to the
// cloud — never raw audio.

const { safeStorage } = require("electron");
const db = require("./db.cjs");
const ollama = require("./ollama.cjs");
const gemini = require("./gemini.cjs");

function setting(k) { try { return db.getSetting(k); } catch { return null; } }

// ── encrypted Gemini key (OS keychain via safeStorage) ───────────────────────
function setGeminiKey(key) {
  if (!key || !key.trim()) { db.setSetting("recall.geminiKeyEnc", ""); return { ok: true, cleared: true }; }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: "OS secure storage unavailable" };
  const enc = safeStorage.encryptString(key.trim()).toString("base64");
  db.setSetting("recall.geminiKeyEnc", enc);
  return { ok: true };
}
function geminiKey() {
  const enc = setting("recall.geminiKeyEnc");
  if (!enc) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, "base64")); } catch { return null; }
}
function hasGeminiKey() { return !!setting("recall.geminiKeyEnc"); }
function geminiModel() { return setting("recall.geminiModel") || "gemini-2.5-flash-lite"; }

async function testGeminiKey() {
  const key = geminiKey();
  if (!key) return { ok: false, error: "no key set" };
  const r = await gemini.ping({ apiKey: key, model: geminiModel() });
  return r.ok ? { ok: true, model: r.model } : r;
}

// ── prompts ──────────────────────────────────────────────────────────────────
// `task` (set for focus-guard sessions) turns the recap into a post-task
// review: same factual summary, plus an explicit on-track verdict + a nudge.
function reviewTail(task) {
  if (!task) return "";
  return `\n\nThe user had set out to work on: "${task}". ` +
    `Judge whether the activity matches that task. End with exactly one line:\n` +
    `VERDICT: on-track — <one-line why> · next: <one concrete suggestion>\n` +
    `(or "VERDICT: drifted — …" if they mostly did something else).`;
}
function audioClause(transcript) {
  if (!transcript) return "";
  return `\n\nAudio heard during this window (system audio / speech, transcribed):\n"""\n` +
    `${transcript.slice(0, 4000)}\n"""\n` +
    `Use the audio to enrich the summary (a video/lecture topic, a call), not as a verbatim quote.`;
}
function visionPrompt(span, frameCount, transcript, task) {
  return (
    `These ${frameCount} screenshots are keyframes captured between ${span} on one desktop, ` +
    `in chronological order. Summarize what the user was actually doing across this window: ` +
    `the main apps/sites, the tasks or topics, and whether it read as focused work or distraction. ` +
    `Be concrete and brief (3–5 sentences). Do not invent detail you cannot see.` +
    audioClause(transcript) + reviewTail(task)
  );
}
function audioOnlyPrompt(span, transcript, task) {
  const body = transcript
    ? `This is audio transcribed from the user's desktop between ${span}. In 2–4 sentences, ` +
      `say what it was about (a video/lecture topic, a call, music, etc.).\n\n"""\n${transcript.slice(0, 4000)}\n"""`
    : `This is system audio captured from the user's desktop between ${span}. In 2–4 sentences, ` +
      `say what it was about (a video/lecture topic, a call, music, etc.).`;
  return body + reviewTail(task);
}
const AUDIO_SYS = "You summarize a short clip/transcript of audio a user heard or spoke during a work session.";

// ── route implementations ─────────────────────────────────────────────────────
// `audio` ({ b64, mime }) is only usable by a native-audio model (Gemini); the
// local path can't hear, so it transcribes upstream and only sees `transcript`.
async function localRecap({ frames, transcript, span, task }) {
  if (frames.length) {
    const r = await ollama.analyzeImages({ imagesBase64: frames, prompt: visionPrompt(span, frames.length, transcript, task) });
    return r.ok ? { ok: true, summary: r.content.trim(), model: r.model } : { ok: false, error: r.error };
  }
  if (!transcript) return { ok: false, error: "local model can't analyze raw audio (no transcript)" };
  const r = await ollama.chat({ system: AUDIO_SYS, user: audioOnlyPrompt(span, transcript, task) });
  return r.ok ? { ok: true, summary: r.content.trim(), model: r.model } : { ok: false, error: r.error };
}

async function cloudRecap({ frames, transcript, audio, span, task }) {
  const key = geminiKey();
  if (!key) return { ok: false, error: "no Gemini key" };
  const model = geminiModel();
  const prompt = frames.length
    ? visionPrompt(span, frames.length, transcript, task)
    : audioOnlyPrompt(span, transcript, task);
  const r = await gemini.generate({
    apiKey: key, model, prompt,
    imagesBase64: frames,
    audio: audio || null, // sent inline when present; skips local transcription
    system: frames.length ? undefined : AUDIO_SYS,
  });
  return r.ok ? { ok: true, summary: r.content.trim(), model: r.model } : { ok: false, error: r.error };
}

// recap({ frames:[b64], transcript, audio, span, deep, task }) → { ok, summary, model }
async function recap({ frames = [], transcript = "", audio = null, span, deep = false, task = null }) {
  const mode = setting("recall.model") || "auto";
  // Default = CLOUD-FIRST for speed: Gemini Flash-Lite recaps in ~1–2s vs the
  // local VLM's minute-plus, so when a key is set, auto routes cloud→local.
  // "Prefer local" flips it back to local-first for privacy/offline.
  const preferLocal = setting("recall.preferLocal") === "1";
  let order;
  if (mode === "local") order = ["local"];
  else if (mode === "cloud") order = ["cloud", "local"];
  else if (preferLocal) order = ["local", "cloud"];            // auto + prefer-local
  else order = hasGeminiKey() ? ["cloud", "local"] : ["local"]; // auto: cloud-first when keyed
  // Raw audio (no transcript) can only be read by the cloud model — make sure
  // cloud is tried first in that case so we don't dead-end on local.
  if (audio && !transcript && !frames.length && order[0] !== "cloud") order = ["cloud", ...order.filter((r) => r !== "cloud")];

  let lastErr = "no model available";
  for (const route of order) {
    if (route === "cloud" && !hasGeminiKey()) { lastErr = "no Gemini key"; continue; }
    let r = route === "cloud"
      ? await cloudRecap({ frames, transcript, audio, span, task })
      : await localRecap({ frames, transcript, span, task });
    // One retry on a transient connection blip ("fetch failed" = couldn't
    // reach Ollama/Gemini) before giving up on this route + falling through.
    if (!r.ok && /fetch failed|ECONNREFUSED|ETIMEDOUT|network/i.test(r.error || "")) {
      await new Promise((res) => setTimeout(res, 800));
      r = route === "cloud"
        ? await cloudRecap({ frames, transcript, audio, span, task })
        : await localRecap({ frames, transcript, span, task });
    }
    if (r.ok) return r;
    // Friendlier message for the common local case.
    lastErr = route === "local" && /fetch failed|ECONNREFUSED/i.test(r.error || "")
      ? "Ollama not reachable — is it running? (or set Recap model to Cloud)"
      : r.error;
  }
  return { ok: false, summary: `Summary failed: ${lastErr}`, model: null };
}

module.exports = {
  recap, setGeminiKey, hasGeminiKey, geminiModel, testGeminiKey,
};
