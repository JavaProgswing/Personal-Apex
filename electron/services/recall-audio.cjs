// Apex Recall — audio transcription (P2). Fully local and optional. Turns a
// captured loopback-audio file into a transcript via a user-provided or
// auto-detected Whisper command. If none is available it degrades gracefully —
// the recap then notes that audio was captured but not transcribed (mirrors how
// P1's vision summary degrades when no VLM is installed).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const db = require("./db.cjs");

function runCmd(cmd, args, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: "", err: e.message });
    }
    const to = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.stdout?.on("data", (d) => (out += d));
    proc.stderr?.on("data", (d) => (err += d));
    proc.on("error", (e) => { clearTimeout(to); resolve({ code: -1, out, err: err || e.message }); });
    proc.on("close", (code) => { clearTimeout(to); resolve({ code, out, err }); });
  });
}

async function onPath(cmd) {
  const finder = process.platform === "win32" ? "where" : "which";
  const r = await runCmd(finder, [cmd], { timeoutMs: 5000 });
  return r.code === 0;
}

function setting(key) {
  try { return db.getSetting(key); } catch { return null; }
}

// Whisper streams a tqdm progress bar to stderr; keep only a real error line.
function cleanErr(s) {
  const lines = String(s || "").split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean);
  const real = lines.filter((l) => !/\d+%\|/.test(l) && !/iB\/s/.test(l) && !/\|.*\|/.test(l));
  return (real[real.length - 1] || "transcription failed").slice(0, 160);
}

// Recover a produced "<base>.txt" from either the output dir or next to the
// input, return its trimmed text, and delete it (P2 keeps no derived files).
function readOutputTxt(filePath, outDir) {
  const base = path.basename(filePath).replace(/\.[^.]+$/, "");
  const candidates = [
    path.join(outDir, base + ".txt"),
    filePath.replace(/\.[^.]+$/, "") + ".txt",
  ];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand)) {
        const t = fs.readFileSync(cand, "utf8").trim();
        try { fs.unlinkSync(cand); } catch {}
        return t;
      }
    } catch { /* keep trying */ }
  }
  return null;
}

async function runOpenaiWhisper(filePath, outDir) {
  const model = setting("recall.whisperModel") || "base.en";
  const r = await runCmd("whisper", [
    filePath, "--model", model, "--output_format", "txt",
    "--output_dir", outDir, "--fp16", "False", "--language", "en", "--verbose", "False",
  ]);
  const txt = readOutputTxt(filePath, outDir);
  // whisper writes the .txt even for silence (empty file) → ok with empty text.
  if (txt != null) return { ok: true, text: txt, model: `whisper:${model}` };
  return { ok: false, error: cleanErr(r.err) };
}

// A user-set template, e.g. for whisper.cpp:
//   "whisper-cli -m C:\\models\\ggml-base.bin -f {input} -otxt -of {outdir}\\out"
// Placeholders: {input} (audio file), {outdir} (a temp dir for outputs).
async function runTemplate(tmpl, filePath, outDir) {
  const filled = tmpl.replace(/\{input\}/g, filePath).replace(/\{outdir\}/g, outDir);
  const parts = (filled.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((p) => p.replace(/^"|"$/g, ""));
  if (!parts.length) return { ok: false, error: "empty recall.whisperCmd" };
  const r = await runCmd(parts[0], parts.slice(1));
  const txt = readOutputTxt(filePath, outDir) ?? (r.code === 0 ? r.out.trim() : null);
  if (txt != null) return { ok: true, text: txt, model: "whisper:custom" };
  return { ok: false, error: cleanErr(r.err) };
}

// transcribe(filePath, mime) → { ok, text, model } | { ok:false, error }
async function transcribe(filePath, _mime) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: "audio file missing" };
  const outDir = path.join(os.tmpdir(), "apex-recall-tx");
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

  const tmpl = setting("recall.whisperCmd");
  if (tmpl && tmpl.trim()) return runTemplate(tmpl.trim(), filePath, outDir);

  if (await onPath("whisper")) return runOpenaiWhisper(filePath, outDir);

  return { ok: false, error: "no transcriber (install `whisper` or set recall.whisperCmd)" };
}

module.exports = { transcribe };
