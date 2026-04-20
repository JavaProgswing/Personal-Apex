// Apex — timetable service.
//
// Source of truth: the `classes` table in SQLite (edited via the Schedule
// Editor in Settings). This service additionally:
//   - computes today's day-order from the anchor date
//   - lists reference PNGs from AcademiaScraper/t_data for the UI to render
//   - parses AcademiaScraper/data/timetable.json to (re)seed the classes table
//   - produces an "upcoming" 7-day stream for the Upcoming page
//
// timetable.json schema (from srmtimetable/AcademiaScraper):
//   { "data": [ { "DayOrder": 1,
//                 "Schedule": [ { "Slot", "StartTime", "EndTime",
//                                 "Course": { "Course Code", "Course Type",
//                                             "Title", "Faculty", "Room" } } ] } ] }

const path = require('node:path');
const fs = require('node:fs');
const db = require('./db.cjs');

const DEFAULT_FOLDER = 'C:\\Users\\yashasvi\\Documents\\Python\\AcademiaScraper';

function resolveFolder(folder) {
  return folder || db.getSetting('timetable.folder') || DEFAULT_FOLDER;
}

function findImage(folder, candidateNames) {
  const roots = [folder, path.join(folder, 't_data'), path.join(folder, 'output')];
  for (const root of roots) {
    for (const n of candidateNames) {
      const p = path.join(root, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function load(folder) {
  const resolved = resolveFolder(folder);
  if (!fs.existsSync(resolved)) {
    return { error: `Folder not found: ${resolved}`, folder: resolved };
  }
  const images = {};
  for (let d = 1; d <= 5; d++) {
    const candidates = [
      `day_order_${d}.png`,
      `day${d}.png`,
      `do${d}.png`,
      `DayOrder${d}.png`,
      `timetable_do${d}.png`,
      `timetable_day${d}.png`,
    ];
    const p = findImage(resolved, candidates);
    if (p) images[d] = toProtocol(p);
  }
  const combined = findImage(resolved, ['timetable_combined.png', 'combined.png']);
  const jsonPath = path.join(resolved, 'data', 'timetable.json');
  const jsonExists = fs.existsSync(jsonPath);
  return {
    folder: resolved,
    jsonPath: jsonExists ? jsonPath : null,
    images,
    combined: combined ? toProtocol(combined) : null,
    todayDayOrder: computeTodayDayOrder(),
  };
}

function toProtocol(absPath) {
  return 'apex-img:///' + absPath.replace(/\\/g, '/');
}

function computeTodayDayOrder() {
  // 1) Calendar override beats everything — this is the SRM academic calendar
  //    authoritative day-order (handles holidays + make-up days correctly).
  const todayIso = new Date().toISOString().slice(0, 10);
  const overridden = db.dayOrderForDate(todayIso);
  if (overridden !== undefined) return overridden; // null means holiday

  // 2) Fallback: weekday-count from anchor.
  const anchorDate = db.getSetting('timetable.anchorDate');
  const anchorOrder = parseInt(db.getSetting('timetable.anchorOrder') || '1', 10);
  const today = new Date();
  const dow = today.getDay();
  if (dow === 0 || dow === 6) return null;
  if (anchorDate) {
    const anchor = new Date(anchorDate + 'T00:00:00');
    let weekdays = 0;
    const d = new Date(anchor);
    while (d <= today) {
      const w = d.getDay();
      if (w !== 0 && w !== 6) weekdays++;
      d.setDate(d.getDate() + 1);
    }
    return ((anchorOrder - 1 + (weekdays - 1)) % 5) + 1;
  }
  return dow; // Mon=1..Fri=5 fallback
}

function dayOrderFor(iso) {
  const overridden = db.dayOrderForDate(iso);
  if (overridden !== undefined) return overridden;
  const anchorDate = db.getSetting('timetable.anchorDate');
  const anchorOrder = parseInt(db.getSetting('timetable.anchorOrder') || '1', 10);
  const d = new Date(iso + 'T00:00:00');
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return null;
  if (!anchorDate) return dow;
  const anchor = new Date(anchorDate + 'T00:00:00');
  let weekdays = 0;
  const cur = new Date(anchor);
  while (cur <= d) {
    const w = cur.getDay();
    if (w !== 0 && w !== 6) weekdays++;
    cur.setDate(cur.getDate() + 1);
  }
  if (weekdays === 0) return null;
  return ((anchorOrder - 1 + (weekdays - 1)) % 5) + 1;
}

function today() {
  const dayOrder = computeTodayDayOrder();
  const classes = dayOrder ? db.classesForDayOrder(dayOrder) : [];
  return { dayOrder, classes };
}

// 7-day lookahead used by the Upcoming page. Each entry is a day with its
// day-order classes and any tasks due on that date.
function upcoming(days = 7) {
  const out = [];
  const base = new Date();
  for (let offset = 0; offset < days; offset++) {
    const d = new Date(base);
    d.setDate(base.getDate() + offset);
    const iso = d.toISOString().slice(0, 10);
    const dayOrder = dayOrderFor(iso);
    const classes = dayOrder ? db.classesForDayOrder(dayOrder) : [];
    const deadlines = db._db()
      .prepare(
        `SELECT id, title, category, course_code, priority, deadline, kind
         FROM tasks
         WHERE completed = 0 AND date(deadline) = date(?)
         ORDER BY priority ASC, deadline ASC`
      )
      .all(iso);
    out.push({ date: iso, dayOrder, dow: d.getDay(), classes, deadlines });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Parse the real AcademiaScraper/data/timetable.json. Collapses consecutive
// same-Course slots into a single row so the UI shows "08:00–09:40 PQT"
// rather than two half-hour rows.
// ────────────────────────────────────────────────────────────────────────────
function parseFromJson(jsonPath) {
  if (!fs.existsSync(jsonPath)) return { ok: false, error: 'timetable.json missing at ' + jsonPath };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  catch (e) { return { ok: false, error: 'Invalid JSON: ' + e.message }; }
  const data = raw?.data;
  if (!Array.isArray(data)) return { ok: false, error: 'Expected { data: [...] } at top level' };

  const out = [];
  for (const day of data) {
    const order = day.DayOrder;
    const slots = Array.isArray(day.Schedule) ? day.Schedule : [];
    let i = 0, period = 1;
    while (i < slots.length) {
      const cur = slots[i];
      if (!cur.Course) { i++; continue; }  // free period
      const code = cur.Course['Course Code'] || null;
      const title = cur.Course.Title || code || 'Class';
      const type = cur.Course['Course Type'] || '';
      const room = cur.Course.Room || null;
      const faculty = cur.Course.Faculty || null;
      let end = cur.EndTime;
      let last = i;
      while (last + 1 < slots.length
          && slots[last + 1].Course
          && slots[last + 1].Course['Course Code'] === code) {
        last++;
        end = slots[last].EndTime;
      }
      out.push({
        day_order: order,
        period: period++,
        slot: cur.Slot || null,
        subject: shortenTitle(title, code),
        code,
        room,
        faculty,
        start_time: to24h(cur.StartTime),
        end_time: to24h(end),
        kind: type.toLowerCase().includes('lab') ? 'lab'
             : type.toLowerCase().includes('project') ? 'tutorial'
             : 'lecture',
        note: type,
      });
      i = last + 1;
    }
  }
  return { ok: true, rows: out };
}

// SRM timetables store afternoon times without AM/PM (e.g. "01:20" means 13:20).
// Anything with hour 1..7 is afternoon and gets +12.
function to24h(t) {
  if (!t) return t;
  const [hStr, m] = t.split(':');
  let h = parseInt(hStr, 10);
  if (h >= 1 && h <= 7) h += 12;
  return String(h).padStart(2, '0') + ':' + m;
}

function shortenTitle(title, code) {
  const map = {
    'Probability and Queueing Theory': 'PQT',
    'Artificial Intelligence': 'AI',
    'Design Thinking and Methodology': 'DTM',
    'Design and Analysis of Algorithms': 'DAA',
    'Digital Image Processing': 'DIP',
    'Database Management Systems': 'DBMS',
    'Social Engineering': 'SE',
  };
  if (map[title]) return map[title];
  return title.split(/\s+/).map((w) => w[0]).filter(Boolean).join('').slice(0, 5).toUpperCase() || code || 'Class';
}

function resyncFromAcademia(folderArg) {
  const folder = resolveFolder(folderArg);
  const jsonPath = path.join(folder, 'data', 'timetable.json');
  const parsed = parseFromJson(jsonPath);
  if (!parsed.ok) return parsed;
  db.replaceAllClasses(parsed.rows);
  return { ok: true, count: parsed.rows.length, source: jsonPath };
}

function seedDefaultClasses() {
  const current = db.listClasses();
  if (current.length > 0) return { ok: false, reason: 'classes already exist', count: current.length };
  // prefer the real JSON if the AcademiaScraper folder exists
  const folder = resolveFolder();
  if (fs.existsSync(folder)) {
    const res = resyncFromAcademia(folder);
    if (res.ok) return { ok: true, count: res.count, source: 'json' };
  }
  db.replaceAllClasses(yashasviClasses());
  return { ok: true, count: yashasviClasses().length, source: 'fallback' };
}

function resyncFromDefaults() {
  db.replaceAllClasses(yashasviClasses());
  return { ok: true, count: yashasviClasses().length };
}

// Hand-transcribed fallback. Used only if the AcademiaScraper JSON can't be
// read. Reflects the current term's schedule.
function yashasviClasses() {
  return [
    { day_order: 1, period: 1, subject: 'PQT',  code: '21MAB204T', room: 'TP 205', start_time: '08:00', end_time: '09:40', kind: 'lecture' },
    { day_order: 1, period: 2, subject: 'AI',   code: '21CSC206T', room: 'TP 205', start_time: '09:45', end_time: '11:30', kind: 'lecture' },
    { day_order: 1, period: 3, subject: 'DTM',  code: '21DCS201P', room: 'TP 205', start_time: '11:35', end_time: '12:25', kind: 'lecture' },
    { day_order: 1, period: 4, subject: 'DAA',  code: '21CSC204J', room: 'TP008',  start_time: '15:10', end_time: '16:50', kind: 'lab' },

    { day_order: 2, period: 1, subject: 'DAA',  code: '21CSC204J', room: 'TP 205', start_time: '12:30', end_time: '14:15', kind: 'lab' },
    { day_order: 2, period: 2, subject: 'DTM',  code: '21DCS201P', room: 'TP 205', start_time: '14:20', end_time: '16:00', kind: 'lecture' },
    { day_order: 2, period: 3, subject: 'PQT',  code: '21MAB204T', room: 'TP 205', start_time: '16:00', end_time: '16:50', kind: 'lecture' },

    { day_order: 3, period: 1, subject: 'DIP',  code: '21CSE251T', room: 'TP 704', start_time: '08:00', end_time: '09:40', kind: 'lecture' },
    { day_order: 3, period: 2, subject: 'PQT',  code: '21MAB204T', room: 'TP 205', start_time: '09:45', end_time: '10:35', kind: 'lecture' },
    { day_order: 3, period: 3, subject: 'DBMS', code: '21CSC205P', room: 'TP 205', start_time: '10:40', end_time: '11:30', kind: 'lecture' },
    { day_order: 3, period: 4, subject: 'DAA',  code: '21CSC204J', room: 'TP 205', start_time: '11:35', end_time: '12:25', kind: 'lecture' },

    { day_order: 4, period: 1, subject: 'DBMS', code: '21CSC205P', room: 'TP 205', start_time: '12:30', end_time: '14:15', kind: 'lecture' },
    { day_order: 4, period: 2, subject: 'DAA',  code: '21CSC204J', room: 'TP 205', start_time: '14:20', end_time: '15:10', kind: 'lecture' },
    { day_order: 4, period: 3, subject: 'SE',   code: '21PDH209T', room: 'TP 205', start_time: '15:10', end_time: '16:00', kind: 'lecture' },
    { day_order: 4, period: 4, subject: 'DIP',  code: '21CSE251T', room: 'TP 704', start_time: '16:00', end_time: '16:50', kind: 'lecture' },

    { day_order: 5, period: 1, subject: 'SE',   code: '21PDH209T', room: 'TP 205', start_time: '08:00', end_time: '09:40', kind: 'lecture' },
    { day_order: 5, period: 2, subject: 'DIP',  code: '21CSE251T', room: 'TP 704', start_time: '09:45', end_time: '10:35', kind: 'lecture' },
    { day_order: 5, period: 3, subject: 'AI',   code: '21CSC206T', room: 'TP 205', start_time: '10:40', end_time: '11:30', kind: 'lecture' },
    { day_order: 5, period: 4, subject: 'DBMS', code: '21CSC205P', room: 'TP 205', start_time: '11:35', end_time: '12:25', kind: 'lecture' },
  ];
}

module.exports = {
  load,
  today,
  upcoming,
  dayOrderFor,
  seedDefaultClasses,
  resyncFromDefaults,
  resyncFromAcademia,
  parseFromJson,
  yashasviClasses,
};
