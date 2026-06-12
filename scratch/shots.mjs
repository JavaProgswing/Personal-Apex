// CDP screenshot harness for the running Electron app (port 9222).
// Usage: node scratch/shots.mjs
import { writeFileSync } from "node:fs";

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
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evaluate = (expression) =>
  send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  await sleep(450); // let transitions/fonts settle
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`scratch/shots/${name}.png`, Buffer.from(data, "base64"));
  console.log("shot", name);
}

// wait for the app to render
for (let i = 0; i < 30; i++) {
  const r = await evaluate("!!document.querySelector('.sidebar .nav-item')");
  if (r.result.value) break;
  await sleep(1000);
}

import { mkdirSync } from "node:fs";
mkdirSync("scratch/shots", { recursive: true });

// 1. dashboard in each curated theme
const themes = ["apex-focus", "library", "tokyo-night", "obsidian", "default-light"];
for (const t of themes) {
  await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(t)}`);
  await shot(`dashboard-${t}`);
}

// 2. settings → appearance, in default theme
await evaluate(`document.documentElement.dataset.theme = "apex-focus"`);
await evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find(n => n.textContent.includes('Settings'))?.click()`);
await sleep(800);
await evaluate(`[...document.querySelectorAll('button, .settings-rail [role], .settings-rail button, nav button, aside button, [class*=rail] button')].find(n => /appearance/i.test(n.textContent))?.click()`);
await sleep(600);
await shot("settings-appearance");

// 3. tasks + upcoming pages for icon/nav check
for (const label of ["Tasks", "Upcoming", "People"]) {
  await evaluate(`[...document.querySelectorAll('.sidebar .nav-item')].find(n => n.textContent.includes(${JSON.stringify(label)}))?.click()`);
  await sleep(700);
  await shot(`page-${label.toLowerCase()}`);
}

ws.close();
console.log("done");
