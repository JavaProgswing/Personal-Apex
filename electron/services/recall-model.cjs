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
function visionPrompt(span, frameCount, transcript) {
  let p =
    `These ${frameCount} screenshots are keyframes captured between ${span} on one desktop, ` +
    `in chronological order. Summarize what the user was actually doing across this window: ` +
    `the main apps/sites, the tasks or topics, and whether it read as focused work or distraction. ` +
    `Be concrete and brief (3–5 sentences). Do not invent detail you cannot see.`;
  if (transcript) {
    p += `\n\nAudio heard during this window (system audio / speech, transcribed):\n"""\n` +
      `${transcript.slice(0, 4000)}\n"""\n` +
      `Use the audio to enrich the summary (e.g. a video/lecture topic, a call), not as a verbatim quote.`;
  }
  return p;
}
function audioOnlyPrompt(span, transcript) {
  return `This is audio transcribed from the user's desktop between ${span}. In 2–4 sentences, ` +
    `say what it was about (a video/lecture topic, a call, music, etc.).\n\n"""\n${transcript.slice(0, 4000)}\n"""`;
}
const AUDIO_SYS = "You summarize a short transcript of audio a user heard or spoke during a work session.";

// ── route implementations ─────────────────────────────────────────────────────
async function localRecap({ frames, transcript, span }) {
  if (frames.length) {
    const r = await ollama.analyzeImages({ imagesBase64: frames, prompt: visionPrompt(span, frames.length, transcript) });
    return r.ok ? { ok: true, summary: r.content.trim(), model: r.model } : { ok: false, error: r.error };
  }
  const r = await ollama.chat({ system: AUDIO_SYS, user: audioOnlyPrompt(span, transcript) });
  return r.ok ? { ok: true, summary: r.content.trim(), model: r.model } : { ok: false, error: r.error };
}

async function cloudRecap({ frames, transcript, span }) {
  const key = geminiKey();
  if (!key) return { ok: false, error: "no Gemini key" };
  const model = geminiModel();
  const r = frames.length
    ? await gemini.generate({ apiKey: key, model, prompt: visionPrompt(span, frames.length, transcript), imagesBase64: frames })
    : await gemini.generate({ apiKey: key, model, system: AUDIO_SYS, prompt: audioOnlyPrompt(span, transcript) });
  return r.ok ? { ok: true, summary: r.content.trim(), model: r.model } : { ok: false, error: r.error };
}

// recap({ frames:[b64], transcript, span, deep }) → { ok, summary, model } | { ok:false, summary, model:null }
async function recap({ frames = [], transcript = "", span, deep = false }) {
  const mode = setting("recall.model") || "auto";
  let order;
  if (mode === "local") order = ["local"];
  else if (mode === "cloud") order = ["cloud", "local"];
  else order = deep ? ["cloud", "local"] : ["local", "cloud"]; // auto

  let lastErr = "no model available";
  for (const route of order) {
    if (route === "cloud" && !hasGeminiKey()) { lastErr = "no Gemini key"; continue; }
    const r = route === "cloud"
      ? await cloudRecap({ frames, transcript, span })
      : await localRecap({ frames, transcript, span });
    if (r.ok) return r;
    lastErr = r.error;
  }
  return { ok: false, summary: `Summary failed: ${lastErr}`, model: null };
}

module.exports = {
  recap, setGeminiKey, hasGeminiKey, geminiModel, testGeminiKey,
};
