// CDP check for Recall P2 audio path. Needs the app running on :9222.
// 1. direct getDisplayMedia loopback (does Windows system-audio grant work?)
// 2. arm a recall session with audio → does the renderer recorder capture +
//    stream chunks to main (audioBytes > 0)? → stop and read the summary row.
const CDP = "http://127.0.0.1:9333";

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(CDP + "/json")).json();
      const page = list.find((t) => t.type === "page" && !/devtools/.test(t.url));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("no CDP page target");
}

const target = await getPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
  }
};
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evalJs = async (expression, userGesture = false) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || "eval error" };
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Runtime.enable");

// wait for the renderer bridge
for (let i = 0; i < 30; i++) {
  if (await evalJs("!!(window.apex && window.apex.recall)")) break;
  await sleep(1000);
}

console.log("1) direct getDisplayMedia loopback:");
const direct = await evalJs(`(async () => {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const a = s.getAudioTracks().length, v = s.getVideoTracks().length;
    const label = s.getAudioTracks()[0]?.label || null;
    s.getTracks().forEach(t => t.stop());
    return { audioTracks: a, videoTracks: v, audioLabel: label };
  } catch (e) { return { error: e.name + ': ' + e.message }; }
})()`, true);
console.log("   ", JSON.stringify(direct));

console.log("2) arm recall w/ audio:");
const started = await evalJs(`window.apex.recall.start({ windowMinutes: 1, intervalSeconds: 10, audio: true })`, true);
console.log("    start →", JSON.stringify(started));

await sleep(16000);
const st = await evalJs(`window.apex.recall.status()`);
console.log("    status →", JSON.stringify(st));

const stopped = await evalJs(`window.apex.recall.stop()`);
console.log("3) stop → summary row:");
console.log("   ", JSON.stringify(stopped?.summary || stopped));

ws.close();
console.log("DONE");
