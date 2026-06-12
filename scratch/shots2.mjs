// Day-summary modal screenshots via CDP.
import { writeFileSync, mkdirSync } from "node:fs";

const CDP = "http://127.0.0.1:9222";
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
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = (expression) => send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
mkdirSync("scratch/shots", { recursive: true });
async function shot(name) {
  await sleep(450);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`scratch/shots/${name}.png`, Buffer.from(data, "base64"));
  console.log("shot", name);
}
for (let i = 0; i < 30; i++) {
  const r = await evaluate("!!document.querySelector('.sidebar .nav-item')");
  if (r.result.value) break;
  await sleep(1000);
}
await sleep(1500);
// open the Day summary modal
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'View log')?.click()`);
await sleep(1200);
await shot("day-summary-new");
// expand the merged focus session
await evaluate(`document.querySelector('.focus-session-head.expandable')?.click()`);
await shot("day-summary-expanded");
ws.close();
console.log("done");
