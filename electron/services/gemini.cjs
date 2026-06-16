// Apex — Gemini (Google Generative Language API) client. Apex's first cloud LLM,
// used only by Recall's "auto/cloud" routing for deep or low-confidence recaps.
// The API key is stored encrypted (OS keychain via Electron safeStorage) and
// decrypted on use — never written to settings in plaintext. Raw audio never
// goes here; only reduced keyframes + the locally-produced transcript.

const HOST = "https://generativelanguage.googleapis.com";

// generate({ apiKey, model, prompt, imagesBase64?, audio?, system?, temperature? })
//   audio: { b64, mime } — sent inline; Gemini hears it natively (ogg/wav/mp3/…),
//   which lets Recall skip local Whisper transcription when configured.
//   → { ok, content, model } | { ok:false, error }
async function generate({ apiKey, model, prompt, imagesBase64 = [], audio = null, system, temperature = 0.3 }) {
  if (!apiKey) return { ok: false, error: "no Gemini API key set" };
  const mdl = model || "gemini-2.5-flash-lite";
  const parts = [];
  if (prompt) parts.push({ text: prompt });
  for (const b of imagesBase64) {
    parts.push({ inline_data: { mime_type: "image/png", data: b } });
  }
  if (audio && audio.b64) {
    // Normalize container label to what Gemini expects (audio/ogg etc.).
    const mime = /ogg/i.test(audio.mime || "") ? "audio/ogg"
      : /wav/i.test(audio.mime || "") ? "audio/wav"
      : /mp3|mpeg/i.test(audio.mime || "") ? "audio/mp3"
      : /aac|m4a/i.test(audio.mime || "") ? "audio/aac"
      : /flac/i.test(audio.mime || "") ? "audio/flac"
      : audio.mime || "audio/ogg";
    parts.push({ inline_data: { mime_type: mime, data: audio.b64 } });
  }
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  try {
    const res = await fetch(
      `${HOST}/v1beta/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json();
        detail = j?.error?.message || "";
      } catch { /* non-JSON */ }
      const hint = res.status === 400 && /API key/i.test(detail) ? " (bad API key)"
        : res.status === 403 ? " (key lacks access / billing)"
        : res.status === 404 ? ` (model "${mdl}" not found for this key)` : "";
      return { ok: false, error: `Gemini ${res.status}${hint}${detail ? ": " + detail.slice(0, 180) : ""}` };
    }
    const data = await res.json();
    const cand = data?.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!text) {
      const blocked = data?.promptFeedback?.blockReason || cand?.finishReason;
      return { ok: false, error: blocked ? `no output (${blocked})` : "empty response" };
    }
    return { ok: true, content: text, model: `gemini:${mdl}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Lightweight key check — a 1-token call that confirms the key/model work.
async function ping({ apiKey, model }) {
  return generate({ apiKey, model, prompt: "Reply with the single word: ok", temperature: 0 });
}

module.exports = { generate, ping };
