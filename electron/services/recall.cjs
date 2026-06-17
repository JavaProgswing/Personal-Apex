// Apex Recall — timed on-device screen capture + local AI "what was happening".
//
// P1 (this file): desktop-only, fully local, ephemeral. While a session is
// armed for a fixed window, grab a downscaled full-screen screenshot every
// interval, dedup near-identical frames (average-hash), and at window end (or
// on manual stop) send the kept keyframes to the local vision model for a
// prose summary. Frames live in memory only and are discarded after the
// summary is stored — nothing leaves the device, no raw media persisted.
//
// Later phases add: screen audio + Whisper, Gemini routing, encrypted blob
// storage, and cloud sync. None of that is wired here.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { desktopCapturer, screen, nativeImage } = require("electron");
const db = require("./db.cjs");
const routine = require("./routine.cjs");
const recallModel = require("./recall-model.cjs");
const recallAudio = require("./recall-audio.cjs");
const activityTracker = require("./activityTracker.cjs");
const notifier = require("./notifier.cjs");

// Tunables (overridable per-session via start()).
const MIN_INTERVAL_SEC = 5;
const MAX_FRAMES_TO_MODEL = 12;   // cap keyframes sent to the VLM per summary
const MAX_CHECKIN_FRAMES = 6;     // fewer per check-in → fast enough on a local VLM
const CAPTURE_MAX_WIDTH = 1280;   // screenshot capture width (downscaled)
const MODEL_MAX_WIDTH = 768;      // further downscale before the model (1 tile)
const AHASH_DISTANCE_KEEP = 6;    // hamming distance over a 64-bit aHash to count as "changed"

let session = null;   // { id, startedAt, endsAt, intervalMs, frames:[{ts,b64,hash}], lastHash, timer, summarizing }
let emit = () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function init(emitter) {
  if (typeof emitter === "function") emit = emitter;
  ensureTable();
}

function ensureTable() {
  db._db().exec(`
    CREATE TABLE IF NOT EXISTS recall_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      frame_count INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      summary TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recall_date ON recall_summaries(date);
  `);
  // P2/P5 columns — added after the table shipped; ignore "duplicate column".
  for (const col of [
    "transcript TEXT",
    "audio_seconds INTEGER NOT NULL DEFAULT 0",
    "transcribe_model TEXT",
    "frames_json TEXT",   // P5: a few small thumbnails [{ts,b64,mime}] for review
    "focus_task TEXT",    // P6: set when the recap wrapped a focus session (review)
    "verdict TEXT",       // P7: parsed on-track | drifted from the model's review
    "next_step TEXT",     // P7: the model's one-line "next:" suggestion
  ]) {
    try { db._db().exec(`ALTER TABLE recall_summaries ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

function broadcast() {
  emit("recall:update", status());
}

// P7: main registers an escalation hook (raise/flash the Apex window) so a
// "drifted" verdict during a strict/locked Zen check-in is enforced, not just
// shown. recall.cjs can't reach the BrowserWindow itself.
let onEscalate = () => {};
function setHooks({ escalate } = {}) {
  if (typeof escalate === "function") onEscalate = escalate;
}

// ── average-hash (64-bit) over a tiny grayscale of the frame, for dedup ──────
function aHash(nativeImage) {
  const small = nativeImage.resize({ width: 8, height: 8, quality: "good" });
  const bmp = small.getBitmap(); // BGRA, 8*8*4
  const gray = [];
  for (let i = 0; i < bmp.length; i += 4) {
    gray.push((bmp[i] + bmp[i + 1] + bmp[i + 2]) / 3);
  }
  const avg = gray.reduce((s, v) => s + v, 0) / gray.length;
  let bits = 0n;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] >= avg) bits |= (1n << BigInt(i));
  }
  return bits;
}

function hamming(a, b) {
  let x = a ^ b;
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

// Gemini accepts these audio containers inline; NOT webm. So the "send the
// file to the model" path only applies when the capture is in one of these.
function geminiAudioOk(mime) {
  return /ogg|wav|mp3|mpeg|aac|flac|aiff|m4a/i.test(String(mime || ""));
}

async function captureOnce() {
  if (!session) return;
  try {
    const primary = screen.getPrimaryDisplay();
    const scale = primary.scaleFactor || 1;
    const w = Math.min(CAPTURE_MAX_WIDTH, Math.round(primary.size.width * scale));
    const h = Math.round((primary.size.height / primary.size.width) * w);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: w, height: h },
    });
    const src = sources[0];
    if (!src || src.thumbnail.isEmpty()) return;
    const img = src.thumbnail;
    const hash = aHash(img);
    // Dedup: skip frames near-identical to the last KEPT one.
    if (session.lastHash !== null && hamming(hash, session.lastHash) < AHASH_DISTANCE_KEEP) {
      return;
    }
    session.lastHash = hash;
    const forModel = img.getSize().width > MODEL_MAX_WIDTH
      ? img.resize({ width: MODEL_MAX_WIDTH, quality: "good" })
      : img;
    session.frames.push({
      ts: new Date().toISOString(),
      b64: forModel.toPNG().toString("base64"),
      hash,
    });
    broadcast();
    pushLive(liveState(), 25000); // throttled live heartbeat
    maybeNudgeDistraction();
  } catch {
    /* a single failed grab is non-fatal */
  }
}

// Focus-guard nudge: while a focus session is being recalled, if the live
// foreground app reads as a distraction, call it out (throttled). Uses the
// activity tracker's already-computed category — no extra model call.
function maybeNudgeDistraction() {
  const s = session;
  if (!s || !s.focusTask) return;
  const now = Date.now();
  if (now - s.lastNudgeAt < 120_000) return; // at most one nudge / 2 min
  let cur = null;
  try { cur = activityTracker.status()?.current || null; } catch { cur = null; }
  if (!cur || cur.category !== "distraction") return;
  s.lastNudgeAt = now;
  const app = cur.app || "a distraction app";
  const msg = `${app} during “${s.focusTask}” — that's off-task.`;
  try { notifier.fire?.({ title: "Off task", body: msg, kind: "recall", payload: { app } }); } catch {}
  emit("activity:nudge", { app, category: "distraction", source: "recall", message: msg, task: s.focusTask });
}

// Extend the active session's window by N minutes — called when the user
// extends the linked focus timer (+10/+15) so recall keeps recording to the
// end of the task instead of stopping at the original planned time.
function extendSession(extraMinutes) {
  if (!session) return { ok: false, error: "no active recall session" };
  const add = Math.max(1, Math.round(+extraMinutes || 0));
  session.endsAt += add * 60_000;
  broadcast();
  pushLive(liveState());
  return { ok: true, endsAt: new Date(session.endsAt).toISOString() };
}

async function tick() {
  if (!session) return;
  if (Date.now() >= session.endsAt) {
    stop("window-elapsed");
    return;
  }
  // A focus-linked session ends when its focus does — self-stop so the review
  // fires right when the task wraps, without hooking every completion path.
  if (session.focusTask) {
    let stillFocused = false;
    try { stillFocused = !!(db.getActiveTimer?.() || db.activeZenSession?.()); } catch { stillFocused = true; }
    if (!stillFocused) { stop("focus-done"); return; }
  }
  await captureOnce();
  // P7: periodic check-in — recap the sub-window, judge it, act on the verdict.
  // checkinInFlight serializes them so a slow local recap can't pile up while
  // the capture loop keeps ticking.
  const s = session;
  if (s && s.checkInMs && !s.summarizing && !s.checkinInFlight &&
      Date.now() - s.lastCheckInAt >= s.checkInMs &&
      s.frames.length > s.checkInBaseIdx) {
    await runCheckIn(s, false);
  }
}

function start({ windowMinutes = 60, intervalSeconds = 0, audio = false, deep = false, focusTask = null, mode = null, checkInMinutes = 0 } = {}) {
  if (session) return { ok: false, error: "A recall session is already running." };
  const win = Math.max(1, Math.min(8 * 60, Math.round(+windowMinutes || 60)));
  // Interval: explicit arg → user's recall.captureIntervalSec setting → 20s.
  const cfgInterval = +(db.getSetting("recall.captureIntervalSec") || 0) || 0;
  const intervalMs = Math.max(MIN_INTERVAL_SEC, Math.round(+intervalSeconds || cfgInterval || 20)) * 1000;
  const now = Date.now();
  const checkInMs = Math.max(0, Math.round(+checkInMinutes || 0)) * 60_000;
  session = {
    id: `recall_${now}`,
    startedAt: new Date(now).toISOString(),
    endsAt: now + win * 60_000,
    intervalMs,
    frames: [],
    lastHash: null,
    timer: null,
    summarizing: false,
    // Focus-guard (P6): when this session is tied to a productive focus timer/
    // Zen, recall nudges on detected distraction during the block and writes a
    // post-task review of whether the task actually got worked on.
    focusTask: focusTask ? String(focusTask).slice(0, 200) : null,
    lastNudgeAt: 0,
    // P7 periodic check-ins: when checkInMs is set (Zen strict/locked owns the
    // session), every checkInMs we recap the frames since the last check-in,
    // parse the on-track/drifted verdict, surface it, and escalate on drift.
    mode: mode || null,                 // zen mode: relaxed | strict | locked | null
    checkInMs,
    checkInBaseIdx: 0,                  // frame index where the current sub-window starts
    checkInStartedAt: new Date(now).toISOString(),
    lastCheckInAt: now,
    checkInCount: 0,
    lastVerdict: null,
    // audio (P2): the renderer recorder streams base64 chunks into audioChunks
    // while audio===true; we never persist them, only the derived transcript.
    audio: !!audio,
    deep: !!deep,
    audioChunks: [],
    audioBytes: 0,
    audioMime: "audio/webm",
    audioCapturing: false,
    audioError: null,
  };
  captureOnce(); // grab one immediately
  session.timer = setInterval(tick, intervalMs);
  broadcast();
  pushLive(liveState());
  return { ok: true, ...status() };
}

// Renderer → main: a base64 chunk of the loopback audio recording. Buffered in
// memory for the life of the session, then transcribed and discarded on stop.
function pushAudio(b64) {
  if (!session || !session.audio || !b64) return;
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length === 0) return;
    session.audioChunks.push(buf);
    session.audioBytes += buf.length;
  } catch { /* ignore a bad chunk */ }
}

// Renderer reports whether loopback capture actually started (and any error,
// e.g. permission denied), so the UI can show "audio: on / unavailable".
function setAudioState(st) {
  if (!session) return;
  if (st && typeof st === "object") {
    if (typeof st.capturing === "boolean") session.audioCapturing = st.capturing;
    if (st.mime) session.audioMime = String(st.mime);
    if (typeof st.seconds === "number") session.audioSeconds = Math.round(st.seconds);
    session.audioError = st.error ? String(st.error) : null;
  }
  broadcast();
}

async function stop(reason = "manual") {
  if (!session) return { ok: false, error: "No recall session running." };
  const s = session;
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  // Signal the renderer recorder to stop and flush its last chunk BEFORE we
  // transcribe — status reports ending:true, the recorder reacts, its final
  // ondataavailable lands in audioChunks while the session still exists.
  if (s.audio && s.audioCapturing) {
    s.ending = true;
    broadcast();
    await sleep(1600);
  }
  s.summarizing = true;
  broadcast();
  // Periodic check-in (Zen-owned) session: a FINAL check-in over the last
  // sub-window if anything new was captured. runCheckIn persists, pushes, and
  // emits recall:review itself, so we don't also call summarize/maybePushRecall.
  if (s.checkInMs) {
    // Skip the final check-in if an interim is still running (it'll persist +
    // emit on its own); otherwise recap the last sub-window.
    const summaryRow = (!s.checkinInFlight && s.frames.length > s.checkInBaseIdx)
      ? await runCheckIn(s, true) : null;
    session = null;
    broadcast();
    pushLive({ active: false, source: "desktop" });
    return { ok: true, summary: summaryRow };
  }
  const summaryRow = await summarize(s, reason);
  session = null;
  broadcast();
  pushLive({ active: false, source: "desktop" });
  maybePushRecall(summaryRow.id); // fire-and-forget cloud sync
  return { ok: true, summary: summaryRow };
}

// Concatenate buffered audio chunks → temp file → transcriber → text. The file
// is deleted immediately after; P2 persists no raw audio, only the transcript.
async function finalizeAudio(s) {
  let tmp = null;
  try {
    const buf = Buffer.concat(s.audioChunks);
    if (buf.length < 2000) return { transcript: "", error: "no audio captured" };
    const ext = String(s.audioMime || "").includes("ogg") ? "ogg" : "webm";
    tmp = path.join(os.tmpdir(), `${s.id}.${ext}`);
    fs.writeFileSync(tmp, buf);
    const r = await recallAudio.transcribe(tmp, s.audioMime);
    return {
      transcript: r.ok ? (r.text || "").trim() : "",
      model: r.ok ? r.model : null,
      seconds: r.seconds || s.audioSeconds || 0,
      error: r.ok ? null : r.error,
    };
  } catch (e) {
    return { transcript: "", error: e.message };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

// P5: pick a few "major" keyframes (first, last, evenly spread) and shrink them
// to small JPEG thumbnails for review on web/phone. Returns [{ts, b64, mime}].
function pickThumbnails(frames, max = 4, width = 360) {
  if (!frames.length) return [];
  const idxs = [];
  if (frames.length <= max) {
    for (let i = 0; i < frames.length; i++) idxs.push(i);
  } else {
    for (let k = 0; k < max; k++) idxs.push(Math.round((k * (frames.length - 1)) / (max - 1)));
  }
  const out = [];
  for (const i of idxs) {
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(frames[i].b64, "base64"));
      const small = img.getSize().width > width ? img.resize({ width, quality: "good" }) : img;
      out.push({ ts: frames[i].ts, b64: small.toJPEG(55).toString("base64"), mime: "image/jpeg" });
    } catch { /* skip a bad frame */ }
  }
  return out;
}

// P7: pull the structured judgement out of the model's free-text recap. The
// model is instructed (recall-model.reviewTail) to end with a single line:
//   "VERDICT: on-track — <why> · next: <suggestion>"  (or "drifted").
function parseVerdict(text) {
  const t = String(text || "");
  const m = t.match(/VERDICT:\s*(on[\s-]?track|drift\w*)\b([^\n]*)/i);
  if (!m) return { status: null, why: "", next: "" };
  const status = /drift/i.test(m[1]) ? "drifted" : "on-track";
  const rest = m[2] || "";
  let next = "";
  const nx = rest.match(/(?:·\s*)?\bnext:\s*(.+)$/i);
  if (nx) next = nx[1].trim();
  let why = rest.replace(/^[\s—:-]+/, "").replace(/·?\s*next:.*$/i, "").replace(/[—-]\s*$/, "").trim();
  return { status, why, next };
}

// Escalate a "drifted" verdict by mode. relaxed → soft toast; strict/locked →
// stronger toast + raise/flash the Apex window (the registered escalate hook).
function actOnVerdict(s, v) {
  if (v.status !== "drifted") return; // on-track is surfaced in-UI only (no spam)
  const strict = s.mode === "strict" || s.mode === "locked";
  const body = v.next ? `Off “${s.focusTask}”. ${v.next}` : `You've drifted from “${s.focusTask}”.`;
  try { notifier.fire?.({ title: strict ? "⚠ Off track" : "Drifted", body, kind: "recall", payload: { task: s.focusTask } }); } catch {}
  if (strict) { try { onEscalate({ task: s.focusTask, next: v.next, mode: s.mode }); } catch {} }
}

// One periodic check-in: recap the frames captured since the last check-in,
// parse + persist the verdict, surface it to the focus UI, and act on a drift.
// Keeps the session alive (unlike stop) so the next interval continues.
async function runCheckIn(s, final) {
  s.checkinInFlight = true;
  try {
  const frames = s.frames.slice(s.checkInBaseIdx).slice(-MAX_CHECKIN_FRAMES);
  const startIso = s.checkInStartedAt;
  const endedAt = new Date().toISOString();
  // Advance the sub-window NOW so a slow model call can't double-count frames.
  s.checkInBaseIdx = s.frames.length;
  s.checkInStartedAt = endedAt;
  s.lastCheckInAt = Date.now();
  s.checkInCount = (s.checkInCount || 0) + 1;

  const date = startIso.slice(0, 10);
  const fmt = (iso) => iso.slice(11, 16);
  const span = `${fmt(startIso)}–${fmt(endedAt)}`;

  let summaryText = "Screen idle / unchanged this interval.";
  let model = null;
  if (frames.length > 0) {
    const r = await recallModel.recap({
      frames: frames.map((f) => f.b64),
      transcript: "", audio: null, span, deep: false, task: s.focusTask || null,
    });
    summaryText = r.summary;
    model = r.model;
  }
  const v = parseVerdict(summaryText);
  s.lastVerdict = v.status;

  ensureTable();
  const framesJson = JSON.stringify(pickThumbnails(frames));
  const created = new Date().toISOString();
  const info = db._db().prepare(
    `INSERT INTO recall_summaries
       (date, started_at, ended_at, frame_count, model, summary, source, created_at,
        frames_json, focus_task, verdict, next_step)
     VALUES (?, ?, ?, ?, ?, ?, 'desktop', ?, ?, ?, ?, ?)`,
  ).run(date, startIso, endedAt, frames.length, model, summaryText, created,
    framesJson, s.focusTask || null, v.status, v.next || null);
  const row = {
    id: info.lastInsertRowid, date, started_at: startIso, ended_at: endedAt,
    frame_count: frames.length, model, summary: summaryText,
    focus_task: s.focusTask || null, verdict: v.status, next_step: v.next || null,
  };

  emit("recall:checkin", {
    status: v.status, why: v.why, next: v.next, task: s.focusTask || null,
    at: endedAt, mode: s.mode || null, final: !!final, count: s.checkInCount,
    summary: summaryText, id: row.id,
  });
  if (final && s.focusTask) {
    emit("recall:review", row);
    try { notifier.fire?.({ title: `Focus review · ${s.focusTask}`, body: summaryText.slice(0, 220), kind: "recall" }); } catch {}
  }
  actOnVerdict(s, v);
  pushLive(liveState({ verdict: v.status, next: v.next || null }));
  maybePushRecall(row.id);
  return row;
  } finally {
    s.checkinInFlight = false;
  }
}

async function summarize(s, reason) {
  const frames = s.frames.slice(-MAX_FRAMES_TO_MODEL);
  const endedAt = new Date().toISOString();
  const date = s.startedAt.slice(0, 10);
  const fmt = (iso) => iso.slice(11, 16);
  const span = `${fmt(s.startedAt)}–${fmt(endedAt)}`;

  // Audio handling. Two paths, chosen by recall.audioToModel:
  //   transcript → always Whisper → text (works with any recap model)
  //   file       → hand the raw audio to the recap model when it hears natively
  //   auto       → send the file iff the recap will go to Gemini AND the format
  //                is one Gemini accepts; else transcribe locally.
  // Ollama vision/text models can't hear, so a local recap always needs text.
  let transcript = "";
  let transcribeModel = null;
  let audioSeconds = s.audioSeconds || 0;
  let audioNote = "";
  let audioForModel = null; // { b64, mime, seconds } sent inline to a native-audio model
  if (s.audio && s.audioChunks.length) {
    audioSeconds = s.audioSeconds || audioSeconds;
    const mode = (db.getSetting("recall.audioToModel") || "auto").toLowerCase();
    const modelMode = (db.getSetting("recall.model") || "auto").toLowerCase();
    const cloudPreferred = modelMode === "cloud" || ((modelMode === "auto") && !!s.deep);
    const wantFile =
      mode !== "transcript" &&
      recallModel.hasGeminiKey?.() &&
      (mode === "file" || cloudPreferred) &&
      geminiAudioOk(s.audioMime);
    if (wantFile) {
      try {
        const buf = Buffer.concat(s.audioChunks);
        if (buf.length >= 2000) {
          audioForModel = { b64: buf.toString("base64"), mime: s.audioMime, seconds: audioSeconds };
        }
      } catch { /* fall through to transcript */ }
    }
    if (!audioForModel) {
      const a = await finalizeAudio(s);
      transcript = a.transcript || "";
      transcribeModel = a.model || null;
      if (a.seconds) audioSeconds = a.seconds;
      if (!transcript) {
        audioNote = a.error
          ? `\n\n[Audio captured ~${audioSeconds}s but not transcribed: ${a.error}.]`
          : `\n\n[Audio captured ~${audioSeconds}s — no speech detected.]`;
      }
    }
  }

  let summaryText = "";
  let model = null;
  if (frames.length === 0 && !transcript && !audioForModel) {
    summaryText =
      "No distinct screens captured during this window (screen idle or unchanged)." + audioNote;
  } else {
    // Route local (Ollama) vs cloud (Gemini) per recall.model + the deep flag.
    const r = await recallModel.recap({
      frames: frames.map((f) => f.b64),
      transcript,
      audio: audioForModel,
      span,
      deep: !!s.deep,
      task: s.focusTask || null,
    });
    summaryText = r.summary + audioNote;
    model = r.model;
    if (audioForModel) transcribeModel = `native:${r.model || "cloud"}`;
  }

  const framesJson = JSON.stringify(pickThumbnails(frames));
  ensureTable();
  const created = new Date().toISOString();
  const info = db._db().prepare(
    `INSERT INTO recall_summaries
       (date, started_at, ended_at, frame_count, model, summary, source, created_at,
        transcript, audio_seconds, transcribe_model, frames_json, focus_task)
     VALUES (?, ?, ?, ?, ?, ?, 'desktop', ?, ?, ?, ?, ?, ?)`,
  ).run(
    date, s.startedAt, endedAt, frames.length, model, summaryText, created,
    transcript || null, audioSeconds, transcribeModel, framesJson, s.focusTask || null,
  );
  // Raw frames + audio are intentionally dropped here — P2 keeps no raw media.
  const row = {
    id: info.lastInsertRowid,
    date, started_at: s.startedAt, ended_at: endedAt,
    frame_count: frames.length, model, summary: summaryText, reason,
    audio_seconds: audioSeconds, transcribe_model: transcribeModel,
    has_transcript: !!transcript,
    focus_task: s.focusTask || null,
  };
  // Post-task review: surface the recap prominently when it wrapped a focus
  // session (the summary already carries the on-track/drifted verdict because
  // summarize passed `task` to the model). Desktop shows a review card.
  if (s.focusTask) {
    emit("recall:review", row);
    try {
      notifier.fire?.({
        title: `Task review · ${s.focusTask}`,
        body: summaryText.slice(0, 220),
        kind: "recall",
      });
    } catch {}
  }
  return row;
}

function status() {
  if (!session) return { active: false };
  return {
    active: true,
    id: session.id,
    startedAt: session.startedAt,
    endsAt: new Date(session.endsAt).toISOString(),
    intervalSeconds: session.intervalMs / 1000,
    framesKept: session.frames.length,
    summarizing: session.summarizing,
    ending: !!session.ending,
    remainingSeconds: Math.max(0, Math.round((session.endsAt - Date.now()) / 1000)),
    audio: !!session.audio,
    audioCapturing: !!session.audioCapturing,
    audioError: session.audioError || null,
    audioSeconds: session.audioSeconds || 0,
    audioBytes: session.audioBytes || 0,
    focusTask: session.focusTask || null,
    mode: session.mode || null,
    checkInMinutes: session.checkInMs ? session.checkInMs / 60000 : 0,
    checkInCount: session.checkInCount || 0,
    lastVerdict: session.lastVerdict || null,
  };
}

function recentSummaries(limit = 20) {
  ensureTable();
  return db._db().prepare(
    `SELECT * FROM recall_summaries ORDER BY started_at DESC LIMIT ?`,
  ).all(Math.max(1, Math.min(100, +limit || 20)));
}

// Delete one recap (local + cloud). The cloud key is the row's started_at
// (see toCloud), so delete there by that.
function deleteSummary(id) {
  ensureTable();
  const row = db._db().prepare("SELECT started_at FROM recall_summaries WHERE id = ?").get(id);
  const info = db._db().prepare("DELETE FROM recall_summaries WHERE id = ?").run(id);
  if (row?.started_at) deleteFromCloud(row.started_at);
  return { ok: true, deleted: info.changes };
}

function clearSummaries() {
  ensureTable();
  const info = db._db().prepare("DELETE FROM recall_summaries").run();
  deleteFromCloud(null); // clear all on cloud too
  return { ok: true, deleted: info.changes };
}

// Best-effort cloud delete — one recap by its started_at id, or all (id=null).
async function deleteFromCloud(id) {
  if (db.getSetting("recall.sync") === "0") return;
  const cfg = routine.getConfig();
  const base = String(cfg.apiBase || "").trim().replace(/\/+$/, "");
  const token = String(cfg.deviceToken || "").trim();
  if (!base || !token) return;
  const url = id ? `${base}/recall/${encodeURIComponent(id)}` : `${base}/recall`;
  try {
    await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  } catch { /* best-effort */ }
}

// ── cloud sync (P4) ──────────────────────────────────────────────────────────
// Push recaps (TEXT only — summary + transcript) to the sync API so they can be
// reviewed on web / phone. Raw frames + audio are never uploaded. Reuses the
// desktop's pairing (apiBase + deviceToken from the routine guard config).
function toCloud(row) {
  return {
    id: row.started_at,            // stable natural key — unique per session
    date: row.date,
    started_at: row.started_at,
    ended_at: row.ended_at,
    frame_count: row.frame_count || 0,
    audio_seconds: row.audio_seconds || 0,
    model: row.model || null,
    transcribe_model: row.transcribe_model || null,
    summary: row.summary || "",
    transcript: row.transcript || null,
    frames: (() => { try { return JSON.parse(row.frames_json || "[]"); } catch { return []; } })(),
    source: row.source || "desktop",
    created_at: row.created_at || null,
  };
}

async function pushToCloud(items) {
  if (!items.length) return { ok: true, saved: 0 };
  const cfg = routine.getConfig();
  const base = String(cfg.apiBase || "").trim().replace(/\/+$/, "");
  const token = String(cfg.deviceToken || "").trim();
  if (!base || !token) return { ok: false, error: "cloud-not-paired" };
  try {
    const res = await fetch(base + "/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
    db.setSetting("recall.cloud.lastSyncAt", new Date().toISOString());
    db.setSetting("recall.cloud.lastError", "");
    return { ok: true, saved: j.saved || items.length };
  } catch (e) {
    db.setSetting("recall.cloud.lastError", e.message);
    return { ok: false, error: e.message };
  }
}

// Best-effort push of one freshly-stored recap (only when sync on + paired).
async function maybePushRecall(id) {
  if (db.getSetting("recall.sync") === "0") return;
  try {
    const row = db._db().prepare("SELECT * FROM recall_summaries WHERE id = ?").get(id);
    if (row) await pushToCloud([toCloud(row)]);
  } catch { /* best-effort */ }
}

// P5 live status — publish "recording now" so phone/web can show a live laptop
// session. Singleton on the server (like focus_state). Best-effort, sync-gated.
let _lastLivePush = 0;
async function pushLive(state, throttleMs = 0) {
  if (db.getSetting("recall.sync") === "0") return;
  if (throttleMs) {
    const now = Date.now();
    if (now - _lastLivePush < throttleMs) return;
    _lastLivePush = now;
  }
  const cfg = routine.getConfig();
  const base = String(cfg.apiBase || "").trim().replace(/\/+$/, "");
  const token = String(cfg.deviceToken || "").trim();
  if (!base || !token) return;
  try {
    await fetch(base + "/recall/live", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(state),
    });
  } catch { /* best-effort */ }
}

function liveState(extra = {}) {
  if (!session) return { active: false, source: "desktop" };
  return {
    active: true,
    started_at: session.startedAt,
    ends_at: new Date(session.endsAt).toISOString(),
    frames_kept: session.frames.length,
    audio: !!session.audio,
    task: session.focusTask || null, // shown in the phone/web "recording" banner
    verdict: session.lastVerdict || null,
    source: "desktop",
    ...extra,
  };
}

// Manual "sync now" — re-push recent recaps (id upsert is idempotent).
async function syncToCloud(limit = 50) {
  ensureTable();
  const rows = db._db().prepare(
    "SELECT * FROM recall_summaries ORDER BY started_at DESC LIMIT ?",
  ).all(Math.max(1, Math.min(200, +limit || 50)));
  return pushToCloud(rows.map(toCloud));
}

module.exports = {
  init, start, stop, status, recentSummaries, pushAudio, setAudioState, syncToCloud,
  extendSession, deleteSummary, clearSummaries, setHooks,
};
