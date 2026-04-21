// Apex — Windows battery-report parser.
//
// Windows ships with `powercfg /batteryreport /duration <N>` which writes
// an HTML report containing a "Usage history" table — for each calendar
// date, how long the machine was Active (foreground awake) and in
// Connected-standby, broken out by battery vs. AC. That's a surprisingly
// reliable proxy for desktop screen-time that we can use WITHOUT needing
// a per-app tracker running in the background.
//
// We shell out to powercfg, write to a temp path, parse with cheerio,
// and return per-day active-minutes. Windows-only; on other platforms
// the `generate()` call returns { ok: false, platform: ... }.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { load } = require('cheerio');
const db = require('./db.cjs');

function supported() {
  return process.platform === 'win32';
}

// ───────────────────────────────────────────────────────────────────────────
// generate — run powercfg and return the path to the HTML report.
// duration: number of days to cover (powercfg default is 3, max is 14 days).
// Returns { ok, htmlPath?, error? }.
// ───────────────────────────────────────────────────────────────────────────
function generate(duration = 14) {
  if (!supported()) {
    return { ok: false, platform: process.platform, error: 'Battery report only works on Windows' };
  }
  const outPath = path.join(os.tmpdir(), `apex-battery-${Date.now()}.html`);
  try {
    execFileSync('powercfg', [
      '/batteryreport',
      '/output', outPath,
      '/duration', String(Math.max(1, Math.min(14, duration))),
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    return { ok: false, error: 'powercfg failed: ' + (err.stderr?.toString?.() || err.message) };
  }
  if (!fs.existsSync(outPath)) {
    return { ok: false, error: 'powercfg ran but the report file is missing' };
  }
  return { ok: true, htmlPath: outPath };
}

// ───────────────────────────────────────────────────────────────────────────
// parse — read the HTML at htmlPath and return per-day active minutes.
// Structure of the "Usage history" section in the report:
//   <h2>Usage history</h2>
//   <table>
//     <tr><th>Period</th><th colspan=2>Active</th><th colspan=2>Connected standby</th></tr>
//     <tr><th></th><th>Battery</th><th>AC</th><th>Battery</th><th>AC</th></tr>
//     <tr><td>2026-04-15</td><td>1:23:45</td><td>4:12:00</td>...</tr>
//     ...
//   </table>
// ───────────────────────────────────────────────────────────────────────────
function parse(htmlPath) {
  if (!fs.existsSync(htmlPath)) return { ok: false, error: 'File not found: ' + htmlPath };
  const html = fs.readFileSync(htmlPath, 'utf8');
  const $ = load(html);

  // Find the Usage-history heading, then its following table.
  let section = null;
  $('h1, h2, h3').each((_, el) => {
    const t = $(el).text().trim().toLowerCase();
    if (t === 'usage history') section = el;
  });
  if (!section) return { ok: false, error: 'No "Usage history" heading in the report' };

  const table = $(section).nextAll('table').first();
  if (!table.length) return { ok: false, error: 'No table after Usage history heading' };

  const rows = [];
  table.find('tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (cells.length < 3) return; // header/spacer
    const dateCell = $(cells[0]).text().trim();
    const iso = normaliseDate(dateCell);
    if (!iso) return; // "Date" header or weekly summary row
    const activeBatteryMin = hmsToMinutes($(cells[1]).text());
    const activeAcMin      = hmsToMinutes($(cells[2]).text());
    const csBatteryMin     = cells.length > 3 ? hmsToMinutes($(cells[3]).text()) : 0;
    const csAcMin          = cells.length > 4 ? hmsToMinutes($(cells[4]).text()) : 0;
    rows.push({
      date: iso,
      active_minutes: activeBatteryMin + activeAcMin,
      standby_minutes: csBatteryMin + csAcMin,
      active_battery: activeBatteryMin,
      active_ac: activeAcMin,
    });
  });
  if (rows.length === 0) return { ok: false, error: 'Parsed the table but no daily rows matched' };
  // Usage-history rows are newest-first in the report; we return newest-first
  // so callers don't have to re-sort.
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return { ok: true, days: rows };
}

// ───────────────────────────────────────────────────────────────────────────
// run — convenience: generate + parse in one call, and cache the result
// on disk (so the dashboard can read it without re-running powercfg which
// takes a few seconds).
// ───────────────────────────────────────────────────────────────────────────
function run(duration = 14) {
  const gen = generate(duration);
  if (!gen.ok) return gen;
  const parsed = parse(gen.htmlPath);
  // best-effort delete of the temp file; not fatal if it fails
  try { fs.unlinkSync(gen.htmlPath); } catch { /* ignore */ }
  if (!parsed.ok) return parsed;
  const cached = {
    generatedAt: new Date().toISOString(),
    days: parsed.days,
  };
  try { db.setSetting('battery.lastReport', JSON.stringify(cached)); } catch { /* non-fatal */ }
  return { ok: true, ...cached };
}

// ───────────────────────────────────────────────────────────────────────────
// syncToActivity — import the latest battery-report days into activity_sessions
// so they surface in Top apps / totals / trend alongside mobile & desktop data.
// We use source='battery' with app='Desktop (battery report)' so it's clearly
// distinguishable, and the idempotent (source, started_at) upsert means you
// can call this repeatedly without dupes.
// ───────────────────────────────────────────────────────────────────────────
function syncToActivity({ duration = 14 } = {}) {
  const res = run(duration);
  if (!res.ok) return res;
  let added = 0;
  for (const d of res.days || []) {
    if (!d.date || !(d.active_minutes > 0)) continue;
    const started = `${d.date}T00:00:00`;
    const ended = `${d.date}T23:59:59`;
    try {
      db.upsertActivitySession({
        date: d.date,
        source: 'battery',
        app: 'Desktop (battery report)',
        window_title: `active ${d.active_minutes} min · standby ${d.standby_minutes} min`,
        category: 'neutral',
        started_at: started,
        ended_at: ended,
        minutes: d.active_minutes,
      });
      added += 1;
    } catch { /* skip */ }
  }
  return { ok: true, added, days: res.days };
}

function latest() {
  try {
    const raw = db.getSetting('battery.lastReport');
    if (!raw) return { ok: false, error: 'No report cached yet' };
    return { ok: true, ...JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// "01:23:45" → 83 minutes; empty / "—" → 0
function hmsToMinutes(s) {
  const txt = String(s || '').trim().replace(/\s+/g, '');
  if (!txt || txt === '—' || txt === '-') return 0;
  const m = txt.match(/^(\d+):(\d+):(\d+)(?:\.\d+)?$/);
  if (m) {
    const h = +m[1], mn = +m[2], sc = +m[3];
    return h * 60 + mn + Math.round(sc / 60);
  }
  // Some reports have "1 d 2:15:00" for long spans; collapse to minutes.
  const m2 = txt.match(/^(\d+)d(\d+):(\d+):(\d+)/i);
  if (m2) {
    return (+m2[1]) * 1440 + (+m2[2]) * 60 + (+m2[3]);
  }
  return 0;
}

// Accept "2026-04-15", "2026-04-15 Wed", "Wed 4/15/2026", etc. → "YYYY-MM-DD".
// Returns null if this is clearly not a date cell (e.g. a weekly summary).
function normaliseDate(cellText) {
  const t = String(cellText || '').trim();
  if (!t) return null;
  // Reject obvious non-date rows
  if (/^(date|period)$/i.test(t)) return null;
  if (/week\s+of/i.test(t)) return null;
  // ISO first
  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // US M/D/YYYY
  const us = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (us) return `${us[3]}-${String(us[1]).padStart(2, '0')}-${String(us[2]).padStart(2, '0')}`;
  // EU DD-MM-YYYY
  const eu = t.match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
  if (eu) return `${eu[3]}-${String(eu[2]).padStart(2, '0')}-${String(eu[1]).padStart(2, '0')}`;
  return null;
}

module.exports = {
  supported,
  generate,
  parse,
  run,
  latest,
  syncToActivity,
  // exposed for unit-testing
  _hmsToMinutes: hmsToMinutes,
  _normaliseDate: normaliseDate,
};
