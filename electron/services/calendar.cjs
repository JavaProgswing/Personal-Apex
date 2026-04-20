// Apex — SRM academic calendar parser.
//
// The calendar.html file from AcademiaScraper is a wide HTML table where each
// row contains cells for 6 months side-by-side. For each month block there
// are 5 cells: Dt | Day | Event | DO (day order) | spacer.
//
// This service:
//   1. Finds the month headers to determine order (e.g. Jan'26, Feb'26, …)
//   2. Walks every row, pulls out (date, dayOrder) pairs
//   3. Writes them into `day_order_overrides` so timetable.today() resolves
//      the *actual* day order for today (including the rotation resetting
//      after holidays, which the naive weekday-counter can't do).

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db.cjs');

const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

// Extract <tr>…</tr> blocks, then <td>…</td> within each.
function splitTable(html) {
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    const cells = [];
    let c;
    while ((c = cellRe.exec(m[1])) !== null) cells.push(stripTags(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function parseMonthHeaders(html) {
  // Pull first-pass month+year tokens in document order.
  const re = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*'?\s*(\d{2})/g;
  const seen = [];
  let m;
  const keys = new Set();
  while ((m = re.exec(html)) !== null) {
    const key = m[1] + '-' + m[2];
    if (!keys.has(key)) { keys.add(key); seen.push({ month: m[1], year2: m[2] }); }
  }
  return seen;
}

function parseCalendarHtml(htmlPath) {
  if (!fs.existsSync(htmlPath)) return { ok: false, error: 'calendar.html not found at ' + htmlPath };
  const html = fs.readFileSync(htmlPath, 'utf8');
  const months = parseMonthHeaders(html);
  if (months.length === 0) return { ok: false, error: 'no month headers detected' };

  const rows = splitTable(html);
  // SRM's calendar uses 5 cells per month block: Dt, Day, Event, DO, spacer.
  // The longest "day" rows should have length >= months.length * 5.
  const blockSize = 5;
  const expected = months.length * blockSize;
  const overrides = []; // { date: 'YYYY-MM-DD', dayOrder: 1..5|null, event: string }
  for (const cells of rows) {
    if (cells.length < expected - (blockSize - 1)) continue; // too short
    for (let i = 0; i < months.length; i++) {
      const off = i * blockSize;
      const dt = cells[off + 0];
      const do_ = cells[off + 3];
      const event = cells[off + 2] || '';
      const day = parseInt(dt, 10);
      if (!Number.isInteger(day) || day < 1 || day > 31) continue;
      const month = months[i];
      const year = 2000 + parseInt(month.year2, 10);
      const mIdx = MONTHS[month.month];
      const date = iso(year, mIdx, day);
      if (!date) continue;
      let dayOrder = null;
      const num = parseInt(do_, 10);
      if (Number.isInteger(num) && num >= 1 && num <= 5) dayOrder = num;
      overrides.push({ date, dayOrder, event: event || null });
    }
  }
  // Dedupe — keep last occurrence.
  const map = new Map();
  for (const o of overrides) map.set(o.date, o);
  return {
    ok: true,
    months: months.map((m) => `${m.month} '${m.year2}`),
    count: map.size,
    overrides: [...map.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function iso(y, m, d) {
  const dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// Write into day_order_overrides. `clear` wipes the table first.
function syncFromHtml(htmlPath, { clear = true } = {}) {
  const parsed = parseCalendarHtml(htmlPath);
  if (!parsed.ok) return parsed;
  const rawDb = db._db();
  const tx = rawDb.transaction((rows) => {
    if (clear) rawDb.prepare('DELETE FROM day_order_overrides').run();
    const ins = rawDb.prepare(
      'INSERT OR REPLACE INTO day_order_overrides (date, day_order) VALUES (?, ?)'
    );
    for (const r of rows) ins.run(r.date, r.dayOrder);
  });
  tx(parsed.overrides);
  // Persist when we last synced so the UI can show "Last synced: …".
  db.setSetting('calendar.lastSyncAt', new Date().toISOString());
  db.setSetting('calendar.lastSyncCount', String(parsed.count));
  db.setSetting('calendar.lastSyncPath', htmlPath);
  return { ok: true, count: parsed.count, months: parsed.months, path: htmlPath };
}

// Given an ISO date string, return the SRM day-order from day_order_overrides,
// or null if the day is a holiday or unknown.
function dayOrderForDate(iso) {
  return db.dayOrderForDate(iso);
}

// List all overrides (for debugging UI).
function listOverrides(limit = 400) {
  return db._db()
    .prepare('SELECT date, day_order FROM day_order_overrides ORDER BY date ASC LIMIT ?')
    .all(limit);
}

module.exports = {
  parseCalendarHtml,
  syncFromHtml,
  dayOrderForDate,
  listOverrides,
};
