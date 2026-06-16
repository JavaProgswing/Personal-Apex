// CDP check for Recall P3 (Gemini cloud routing). App on :9333.
// Sets the key (encrypted via safeStorage), pings Gemini, then routes a real
// cloud recap. Key comes from env GEMINI_TEST_KEY; it is never logged.
const CDP = "http://127.0.0.1:9333";
const KEY = process.env.GEMINI_TEST_KEY || "";

async function getPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(CDP + "/json")).json();
      const page = list.find((t) => t.type === "page" && /index.html/.test(t.url));
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("no CDP page target");
}
const target = await getPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression, userGesture = false) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description || "eval error" };
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Runtime.enable");
for (let i = 0; i < 30; i++) { if (await evalJs("!!(window.apex && window.apex.recall)")) break; await sleep(1000); }

console.log("set key →", JSON.stringify(await evalJs(`window.apex.recall.setGeminiKey(${JSON.stringify(KEY)})`)));
console.log("has key →", JSON.stringify(await evalJs(`window.apex.recall.hasGeminiKey()`)));

await evalJs(`window.apex.settings.set("recall.geminiModel","gemini-2.5-flash-lite")`);
let test = await evalJs(`window.apex.recall.testGeminiKey()`);
console.log("ping flash-lite →", JSON.stringify(test));
if (!test || !test.ok) {
  await evalJs(`window.apex.settings.set("recall.geminiModel","gemini-2.0-flash")`);
  test = await evalJs(`window.apex.recall.testGeminiKey()`);
  console.log("ping 2.0-flash →", JSON.stringify(test));
}
if (!test || !test.ok) {
  await evalJs(`window.apex.settings.set("recall.geminiModel","gemma-3-27b-it")`);
  test = await evalJs(`window.apex.recall.testGeminiKey()`);
  console.log("ping gemma →", JSON.stringify(test));
}

// NOTE: deliberately NOT arming a cloud recap here — that would send desktop
// screenshots to Gemini. The key round-trip + ping above prove the P3 plumbing
// (encrypted storage + client + live API) without exfiltrating screen content.
ws.close();
console.log("DONE");
