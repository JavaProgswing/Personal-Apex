// Apex — SRMIST Academia scraper, ported from
// /AcademiaScraper/srmtimetable/academia.py to native JS so we don't need
// Python to populate the timetable + day-order calendar.
//
// Two-step Zoho login:
//   1) POST /accounts/.../signin/v2/lookup/<netid>@srmist.edu.in with a CSRF
//      token cookie. Returns { lookup: { identifier, digest }, message }.
//   2) POST /accounts/.../signin/v2/primary/<identifier>/password?digest=...
//      with the password JSON. On success, the cookie jar holds the auth
//      cookie that /portal endpoints accept.
//
// All HTTP uses Node's global `fetch` + a custom cookie jar so we can
// thread cookies through every step ourselves (Node fetch doesn't ship
// with one). Cookies are stored as { name → value } and serialised to
// the standard "name=value; name2=value2" header on each request.

const cheerio = require('cheerio');
const db = require('./db.cjs');

const BASE_URL = 'https://academia.srmist.edu.in';

// Pre-shared CSRF token + initial cookie blob from the Python scraper.
// These get the lookup call past Zoho's CSRF guard. The auth cookie
// itself is what we collect from the response.
const PRELOGIN_CSRF =
  '3c59613cb190a67effa5b17eaba832ef1eddaabeb7610c8c6a518b753bc73848b483b007a63f24d94d67d14dda0eca9f0c69e027c0ebd1bb395e51b2c6291d63';

function defaultPreloginCookies() {
  return {
    npfwg: '1',
    ZCNEWUIPUBLICPORTAL: 'true',
    iamcsr: PRELOGIN_CSRF,
    _zcsr_tmp: PRELOGIN_CSRF,
    zccpn: PRELOGIN_CSRF,
    cli_rgn: 'IN',
  };
}

// ─── tiny cookie jar ────────────────────────────────────────────────────
function makeJar(initial) {
  const jar = { ...(initial || {}) };
  return {
    set(name, value) { jar[name] = value; },
    setCookieHeader(setCookie) {
      // Set-Cookie may be a comma-joined list (Node fetch joins multiple
      // values) — we split on commas that introduce a new "key=value;"
      // pair (i.e. ", \w+=") to avoid splitting Expires=Mon, 02 Jan…
      if (!setCookie) return;
      const parts = setCookie.split(/, (?=[A-Za-z0-9_-]+=)/);
      for (const part of parts) {
        const first = part.split(';')[0].trim();
        const eq = first.indexOf('=');
        if (eq < 1) continue;
        const k = first.slice(0, eq).trim();
        const v = first.slice(eq + 1).trim();
        if (k) jar[k] = v;
      }
    },
    header() {
      return Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    },
    raw() { return { ...jar }; },
  };
}

// ─── login ──────────────────────────────────────────────────────────────
// Returns { ok, jar, error?, captcha? } — `jar` is the cookie jar that
// every subsequent fetch (timetable, calendar) needs to include.
async function login(username, password) {
  if (!username || !password) {
    return { ok: false, error: 'Username and password are required.' };
  }
  const jar = makeJar(defaultPreloginCookies());

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-zcsrf-token': `iamcsrcoo=${PRELOGIN_CSRF}`,
    Cookie: jar.header(),
    Referer: `${BASE_URL}/accounts/p/10002227248/signin?hide_fp=true&servicename=ZohoCreator&service_language=en`,
  };

  // Step 1 — lookup
  const lookupBody = new URLSearchParams({
    mode: 'primary',
    cli_time: String(Date.now()),
    servicename: 'ZohoCreator',
    service_language: 'en',
    serviceurl: `${BASE_URL}/portal/academia-academic-services/redirectFromLogin`,
  }).toString();

  let lookupRes;
  try {
    lookupRes = await fetch(
      `${BASE_URL}/accounts/p/40-10002227248/signin/v2/lookup/${encodeURIComponent(username)}@srmist.edu.in`,
      { method: 'POST', headers, body: lookupBody },
    );
  } catch (err) {
    return { ok: false, error: `Network error during lookup: ${err.message}` };
  }
  jar.setCookieHeader(lookupRes.headers.get('set-cookie'));

  let lookupJson;
  try {
    lookupJson = await lookupRes.json();
  } catch {
    return { ok: false, error: `Lookup returned non-JSON (HTTP ${lookupRes.status})` };
  }

  if (lookupJson.errors && lookupJson.errors.length > 0) {
    const msg = lookupJson.errors[0]?.message || 'Lookup failed';
    if ((lookupJson.message || '').includes('HIP') || msg.includes('HIP') || msg.includes('captcha')) {
      return { ok: false, captcha: true, error: 'Captcha required — login through the SRM portal once, then retry.' };
    }
    return { ok: false, error: `Lookup failed: ${msg}` };
  }
  if (!String(lookupJson.message || '').includes('User exists')) {
    const m = lookupJson.localized_message || lookupJson.message || 'User does not exist';
    return { ok: false, error: m };
  }

  const identifier = lookupJson.lookup?.identifier;
  const digest = lookupJson.lookup?.digest;
  if (!identifier || !digest) {
    return { ok: false, error: 'Invalid lookup response (missing identifier/digest)' };
  }

  // Step 2 — password
  const passwordHeaders = {
    ...headers,
    'Content-Type': 'application/json;charset=UTF-8',
    Cookie: jar.header(),
  };
  const passwordBody = JSON.stringify({ passwordauth: { password } });
  const passwordUrl =
    `${BASE_URL}/accounts/p/40-10002227248/signin/v2/primary/${encodeURIComponent(identifier)}/password` +
    `?digest=${encodeURIComponent(digest)}&cli_time=${Math.floor(Date.now() / 1000)}` +
    `&servicename=ZohoCreator&service_language=en` +
    `&serviceurl=${encodeURIComponent(`${BASE_URL}/portal/academia-academic-services/redirectFromLogin`)}`;

  let passRes;
  try {
    passRes = await fetch(passwordUrl, {
      method: 'POST',
      headers: passwordHeaders,
      body: passwordBody,
    });
  } catch (err) {
    return { ok: false, error: `Network error during password step: ${err.message}` };
  }
  jar.setCookieHeader(passRes.headers.get('set-cookie'));

  let passJson;
  try { passJson = await passRes.json(); } catch { passJson = null; }
  if (passJson && passJson.errors && passJson.errors.length > 0) {
    const m = passJson.errors[0]?.message || 'Password step failed';
    return { ok: false, error: `Login failed: ${m}` };
  }
  if (passJson && passJson.message && /invalid/i.test(passJson.message)) {
    return { ok: false, error: `Login failed: ${passJson.message}` };
  }
  // Heuristic: a successful login response carries a new auth cookie. If
  // we still have only the prelogin cookies, the password was likely
  // wrong even if the API didn't say so explicitly.
  const cookies = jar.raw();
  if (!cookies.JSESSIONID && !cookies['_iamadt'] && !cookies['IAMTFAID']) {
    // Some accounts skip a JSESSIONID; bail out only if we still don't
    // have anything beyond the prelogin set.
    const got = Object.keys(cookies).length;
    if (got <= Object.keys(defaultPreloginCookies()).length + 2) {
      return {
        ok: false,
        error: 'Login appeared to fail — no auth cookie received. Check your password.',
      };
    }
  }

  return { ok: true, jar };
}

// ─── cookies via Electron persistent session ──────────────────────────
// We persist the Academia auth cookies in the Electron session partition
// `persist:srm`. After the user signs in once via the browser-window flow,
// the cookies are available to every subsequent fetch — no captcha, no
// password handling on our side, no fragile header fingerprinting.
let _electronSession = null;
function _attachElectronSession(electronSession) {
  _electronSession = electronSession;
}

function _cookieHeaderValue(name, value) {
  return `${name}=${value}`;
}

async function _cookieHeaderFromElectron() {
  if (!_electronSession) return null;
  try {
    const cookies = await _electronSession.cookies.get({ url: BASE_URL });
    if (!cookies || cookies.length === 0) return null;
    return cookies.map((c) => _cookieHeaderValue(c.name, c.value)).join('; ');
  } catch {
    return null;
  }
}

// Build a jar-like object from Electron session cookies so the rest of
// this file (which expects `.header()`) doesn't need to change.
async function _jarFromElectronSession() {
  const header = await _cookieHeaderFromElectron();
  if (!header) return null;
  return {
    header: () => header,
    raw: () => ({}),
    set: () => {},
    setCookieHeader: () => {},
  };
}

// True if the session cookies look authenticated (we have at least one
// IAM/Zoho cookie that comes from a successful login flow).
async function isLoggedIn() {
  if (!_electronSession) return false;
  try {
    const cookies = await _electronSession.cookies.get({ url: BASE_URL });
    if (!cookies || cookies.length === 0) return false;
    return cookies.some((c) =>
      /^(JSESSIONID|_iamadt|IAMTFAID|IAMAUTHTOKEN)/.test(c.name) ||
      /^_iam/.test(c.name) ||
      c.name === '_zcsr_user',
    );
  } catch {
    return false;
  }
}

async function clearCookies() {
  if (!_electronSession) return { ok: false };
  try {
    const cookies = await _electronSession.cookies.get({});
    for (const c of cookies) {
      const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`;
      try { await _electronSession.cookies.remove(url, c.name); } catch {}
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── fetch + parse: timetable ───────────────────────────────────────────
async function fetchTimetableHtml(jar) {
  // If no jar passed, build one from the Electron persistent session.
  if (!jar) jar = await _jarFromElectronSession();
  if (!jar) {
    throw new Error('No SRM cookies available — run "Log in to SRM" first.');
  }
  const url =
    `${BASE_URL}/srm_university/academia-academic-services/page/My_Time_Table_2023_24`;
  const res = await fetch(url, {
    headers: {
      Accept: '*/*',
      Cookie: jar.header(),
      Referer: `${BASE_URL}/`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  if (!res.ok) throw new Error(`Timetable fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  // Zoho wraps the real HTML inside `pageSanitizer.sanitize('...')`.
  const m = text.match(/pageSanitizer\.sanitize\('([\s\S]+?)'\)/);
  if (!m) throw new Error('Timetable sanitize() payload not found');
  // Decode \xNN escapes back to UTF-8.
  const decoded = m[1].replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  const $ = cheerio.load(decoded);
  const main = $('div.mainDiv').first();
  if (!main || main.length === 0) {
    throw new Error('Timetable mainDiv not found after decoding');
  }
  return $.html(main);
}

function parseStudentDetails(html) {
  const $ = cheerio.load(html);

  let regNumber = null, name = null, batchStr = null, mobile = null;
  let department = null, semesterStr = null;
  // The student-info table is the "<table border=0 align=left>" near the
  // top of the page — grab every td label/value pair.
  const infoTable = $('table[border="0"][align="left"]').first();
  if (infoTable && infoTable.length > 0) {
    const tds = infoTable.find('td');
    for (let i = 0; i < tds.length; i++) {
      const label = $(tds[i]).text().trim();
      if (label === 'Registration Number:') regNumber = $(tds[i + 1]).text().trim();
      else if (label === 'Name:') name = $(tds[i + 1]).text().trim();
      else if (label === 'Combo / Batch:') {
        const v = $(tds[i + 1]).text().trim();
        const last = v.split('/').pop().trim();
        batchStr = last;
      }
      else if (label === 'Mobile:') mobile = $(tds[i + 1]).text().trim();
      else if (label === 'Department:') department = $(tds[i + 1]).text().trim();
      else if (label === 'Semester:') semesterStr = $(tds[i + 1]).text().trim();
    }
  }

  // Course table — class "course_tbl". 11 cells per row including header.
  const courseTable = $('table.course_tbl').first();
  if (!courseTable || courseTable.length === 0) {
    throw new Error('Course table not found in timetable HTML');
  }
  const allTd = courseTable.find('td');
  const cols = 11;
  const courses = [];
  for (let i = cols; i + cols <= allTd.length; i += cols) {
    const tds = allTd.slice(i, i + cols);
    const cell = (k) => $(tds[k]).text().trim();
    courses.push({
      'S.No': cell(0),
      'Course Code': cell(1),
      'Course Title': cell(2),
      Credit: cell(3),
      'Regn. Type': cell(4),
      Category: cell(5),
      'Course Type': cell(6),
      'Faculty Name': cell(7),
      Slot: cell(8),
      'Room No.': cell(9),
      'Academic Year': cell(10),
    });
  }

  return {
    RegNumber: regNumber,
    Name: name,
    Batch: parseInt(batchStr, 10) || null,
    Mobile: mobile,
    Department: department,
    Semester: parseInt(semesterStr, 10) || null,
    Courses: courses,
  };
}

// ─── fetch + parse: calendar / day-order map ─────────────────────────────
// SRM publishes the academic planner as a Zoho page with 5 month-columns
// per row (Jan-May, Jun-Oct etc. depending on EVEN/ODD term). Each column
// has [date, day-name, event-or-blank, day-order, separator] cells.
//
// We try a list of well-known plan slugs in order — the most recent
// term first. The first one that returns a parseable table wins.
const KNOWN_PLAN_SLUGS = [
  'Academic_Planner_2025_26_EVEN',
  'Academic_Planner_2025_26_ODD',
  'Academic_Planner_2024_25_EVEN',
  'Academic_Planner_2024_25_ODD',
];

async function fetchCalendarHtml(jar, planName) {
  if (!jar) jar = await _jarFromElectronSession();
  if (!jar) throw new Error('No SRM cookies available — run "Log in to SRM" first.');
  const slugsToTry = planName ? [planName] : KNOWN_PLAN_SLUGS;
  let lastErr = null;
  for (const slug of slugsToTry) {
    const url =
      `${BASE_URL}/srm_university/academia-academic-services/page/${slug}`;
    try {
      const res = await fetch(url, {
        headers: {
          Accept: '*/*',
          Cookie: jar.header(),
          Referer: `${BASE_URL}/`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status} for ${slug}`;
        continue;
      }
      const text = await res.text();
      const m = text.match(/pageSanitizer\.sanitize\('([\s\S]+?)'\)/);
      if (!m) { lastErr = `sanitize() payload missing in ${slug}`; continue; }
      const decoded = m[1].replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
      // Quick sanity: does the mainDiv contain a table with "DO" header?
      if (!/(>DO<|>DO\s)/.test(decoded)) { lastErr = `no DO column in ${slug}`; continue; }
      return { html: decoded, planName: slug };
    } catch (err) {
      lastErr = err.message;
    }
  }
  throw new Error(`Could not fetch academic planner. Last error: ${lastErr || 'unknown'}`);
}

// Walks the planner table → array of { date: 'YYYY-MM-DD', day_order: int, event?: string }.
// Returns an empty array if the table doesn't match the expected shape.
function parseCalendarEvents(html) {
  const $ = cheerio.load(html);
  // The planner main table is usually the first big table inside .mainDiv.
  const tables = $('table');
  let plannerTable = null;
  let monthHeaders = null;
  tables.each((_, t) => {
    const $t = $(t);
    const headerCells = $t.find('th, td').slice(0, 25);
    const txts = headerCells.map((__, c) => $(c).text().trim()).get();
    // Header row: Dt | Day | <Mon 'YY> | DO | (sep) repeated 5x.
    const months = [];
    for (let i = 0; i < txts.length - 3; i++) {
      if (
        /^Dt$/i.test(txts[i]) &&
        /^Day$/i.test(txts[i + 1]) &&
        /^DO$/i.test(txts[i + 3])
      ) {
        months.push({ headerCellIdx: i, name: txts[i + 2] });
      }
    }
    if (months.length >= 1 && (!plannerTable || months.length > monthHeaders.length)) {
      plannerTable = $t;
      monthHeaders = months;
    }
  });
  if (!plannerTable) return [];

  // Year inference — month label might be "Jan '26" or "January 2026".
  function parseMonthHeader(label) {
    if (!label) return null;
    const cleaned = label.replace(/’/g, "'").trim();
    let m = cleaned.match(/^([A-Za-z]+)\s*'?(\d{2,4})$/);
    if (!m) return null;
    const monthName = m[1].slice(0, 3).toLowerCase();
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const monthIdx = months.indexOf(monthName);
    if (monthIdx < 0) return null;
    let year = parseInt(m[2], 10);
    if (year < 100) year = 2000 + year;
    return { monthIdx, year };
  }

  const monthInfos = monthHeaders.map((h) => ({ ...h, ...(parseMonthHeader(h.name) || {}) }));

  const out = [];
  // Body rows: each <tr> is one day-of-month, with 5 month columns laid out.
  // Cells per month: [dt, day-name, event/blank, do, separator] = 5.
  // Total columns ≈ months.length * 5 (the separator between months may
  // collapse — handle either 5 or 4 stride per month).
  const rows = plannerTable.find('tr');
  rows.each((__, tr) => {
    const cells = $(tr).find('td');
    if (cells.length === 0) return;
    const cellTxts = cells.map((___, c) => $(c).text().replace(/ /g, ' ').trim()).get();
    monthInfos.forEach((info, monthIdx) => {
      // Try the most common stride first. Some HTMLs have a 4-cell stride
      // (no trailing separator on the last column); accept both.
      const strides = [5, 4];
      for (const stride of strides) {
        const base = monthIdx * stride;
        const dtTxt = cellTxts[base];
        const dayTxt = cellTxts[base + 1];
        const eventTxt = cellTxts[base + 2];
        const doTxt = cellTxts[base + 3];
        if (!dtTxt) continue;
        const dt = parseInt(dtTxt, 10);
        if (!(dt >= 1 && dt <= 31)) continue;
        if (info.year == null || info.monthIdx == null) continue;
        const iso = `${info.year}-${String(info.monthIdx + 1).padStart(2, '0')}-${String(dt).padStart(2, '0')}`;
        const doNum = parseInt(doTxt, 10);
        const dayOrder = doNum >= 1 && doNum <= 5 ? doNum : null;
        const event = eventTxt && !/^\s*$/.test(eventTxt) ? eventTxt : null;
        out.push({ date: iso, day_order: dayOrder, day: dayTxt || null, event });
        break; // first matching stride wins for this month/row
      }
    });
  });
  return out;
}

// ─── slot times → DB-shaped rows ────────────────────────────────────────
const BATCH_1 = {
  Batch: 1,
  Slots: [
    { DayOrder: 1, Slots: ['A','A','F','F','G','P6','P7','P8','P9','P10'] },
    { DayOrder: 2, Slots: ['P11','P12','P13','P14','P15','B','B','G','G','A'] },
    { DayOrder: 3, Slots: ['C','C','A','D','B','P26','P27','P28','P29','P30'] },
    { DayOrder: 4, Slots: ['P31','P32','P33','P34','P35','D','D','B','E','C'] },
    { DayOrder: 5, Slots: ['E','E','C','F','D','P46','P47','P48','P49','P50'] },
  ],
};
const BATCH_2 = {
  Batch: 2,
  Slots: [
    { DayOrder: 1, Slots: ['P1','P2','P3','P4','P5','A','A','F','F','G'] },
    { DayOrder: 2, Slots: ['B','B','G','G','A','P16','P17','P18','P19','P20'] },
    { DayOrder: 3, Slots: ['P21','P22','P23','P24','P25','C','C','A','D','B'] },
    { DayOrder: 4, Slots: ['D','D','B','E','C','P36','P37','P38','P39','P40'] },
    { DayOrder: 5, Slots: ['P41','P42','P43','P44','P45','E','E','C','F','D'] },
  ],
};

const SLOT_TIMES_24H = [
  ['08:00', '08:50'], ['08:50', '09:40'], ['09:45', '10:35'],
  ['10:40', '11:30'], ['11:35', '12:25'], ['12:30', '13:20'],
  ['13:25', '14:15'], ['14:20', '15:10'], ['15:10', '16:00'],
  ['16:00', '16:50'],
];

// Build DB-shaped rows. Output matches the `classes` table:
// { day_order, period, slot, subject, code, room, faculty, start_time, end_time, kind }.
function buildClassesRows(student) {
  if (!student?.Courses?.length) return [];
  const batch = student.Batch === 1 ? BATCH_1 : BATCH_2;

  // slot → course
  const slotToCourse = {};
  for (const c of student.Courses) {
    const slots = (c.Slot || '').split('-').filter(Boolean);
    for (const s of slots) {
      slotToCourse[s] = {
        code: c['Course Code'] || null,
        title: c['Course Title'] || c['Course Code'] || 'Class',
        type: (c['Course Type'] || '').toLowerCase(),
        room: c['Room No.'] || null,
        faculty: c['Faculty Name'] || null,
      };
    }
  }

  const rows = [];
  for (const day of batch.Slots) {
    let period = 1;
    day.Slots.forEach((slot, i) => {
      const course = slotToCourse[slot];
      if (!course) return; // skip empty slots — same as Python pipeline
      const [start, end] = SLOT_TIMES_24H[i] || ['', ''];
      const kind = /lab/i.test(course.type) ? 'lab' : /tutorial|project/i.test(course.type) ? 'tutorial' : 'lecture';
      const title = course.title || course.code || 'Class';
      rows.push({
        day_order: day.DayOrder,
        period: period++,
        slot,
        subject: shortenSubject(title, course.code),
        code: course.code,
        room: course.room,
        faculty: course.faculty,
        start_time: start,
        end_time: end,
        kind,
      });
    });
  }
  return rows;
}

function shortenSubject(title, code) {
  const map = {
    'Object Oriented Programming using JAVA': 'OOPJ',
    'Probability and Queueing Theory': 'PQT',
    'Database Management Systems': 'DBMS',
    'Computer Networks': 'CN',
    'Operating Systems': 'OS',
    'Theory of Computation': 'TOC',
    'Design and Analysis of Algorithms': 'DAA',
    'Software Engineering': 'SE',
    'Compiler Design': 'CD',
    'Artificial Intelligence': 'AI',
    'Machine Learning': 'ML',
  };
  if (map[title]) return map[title];
  // Build initials for capitalised words; fall back to course code or
  // the first 5 chars of the title.
  const initials = (title || '')
    .split(/\s+/)
    .filter((w) => /^[A-Z]/.test(w))
    .map((w) => w[0])
    .join('');
  if (initials.length >= 2) return initials.slice(0, 5);
  if (code) return code;
  return (title || 'Class').slice(0, 5);
}

// ─── high-level: one-shot sync ──────────────────────────────────────────
async function syncAll({ username, password, planName, useStoredSession } = {}) {
  // Path A — preferred: cookies from a previous browser-window login,
  // persisted in the Electron `persist:srm` partition. No password
  // handling on our side, no captcha drama.
  let jar = null;
  if (useStoredSession !== false) {
    jar = await _jarFromElectronSession();
  }

  // Path B — legacy headless POST flow with NetID + password, kept for
  // users who'd rather not click through a popup. Will hit captcha for
  // most accounts.
  if (!jar) {
    const u = username || db.getSetting('srm.netid');
    const p = password || db.getSetting('srm.password');
    if (!u || !p) {
      return {
        ok: false,
        needsLogin: true,
        error:
          'No SRM session. Open Settings → Schedule and click "Log in to SRM" to sign in once — Apex remembers the session.',
      };
    }
    const log = await login(u, p);
    if (!log.ok) {
      return { ...log, needsLogin: log.captcha === true };
    }
    jar = log.jar;
  }

  let student;
  try {
    const html = await fetchTimetableHtml(jar);
    student = parseStudentDetails(html);
  } catch (err) {
    // If the request 401'd because cookies expired, signal the UI to
    // re-prompt the browser-window login.
    return {
      ok: false,
      needsLogin: /unauthorized|401|sanitize|not found/i.test(err.message),
      error: `Timetable: ${err.message}`,
    };
  }

  // Optional: fetch + parse the academic planner.
  let calendarRows = [];
  let plannerSlug = null;
  try {
    const cal = await fetchCalendarHtml(jar, planName);
    calendarRows = parseCalendarEvents(cal.html);
    plannerSlug = cal.planName;
  } catch (err) {
    // Calendar is non-fatal — timetable can still work without it.
    // eslint-disable-next-line no-console
    console.warn('[srm.syncAll] calendar fetch/parse failed:', err.message);
  }

  // Persist to DB.
  const classes = buildClassesRows(student);
  if (classes.length === 0) {
    return { ok: false, error: 'No courses found in timetable. Are you enrolled this term?' };
  }
  db.replaceAllClasses(classes);

  // Day-order overrides for the term — only write rows where day_order is
  // null (holidays/events). Real day-orders use the rotation. Skip null
  // and also skip dates already past the cutoff (purely future-looking).
  for (const r of calendarRows) {
    if (r.day_order == null) {
      // Holiday — skip class for that date.
      try { db.setDayOrderForDate(r.date, null); } catch { /* ignore */ }
    } else {
      // Pin to the actual day order from the planner.
      try { db.setDayOrderForDate(r.date, r.day_order); } catch { /* ignore */ }
    }
  }

  return {
    ok: true,
    classes: classes.length,
    calendar_rows: calendarRows.length,
    student: {
      name: student.Name,
      reg: student.RegNumber,
      batch: student.Batch,
      department: student.Department,
      semester: student.Semester,
    },
    planner: plannerSlug,
  };
}

module.exports = {
  login,
  fetchTimetableHtml,
  parseStudentDetails,
  fetchCalendarHtml,
  parseCalendarEvents,
  buildClassesRows,
  syncAll,
  // Browser-based session helpers
  attachElectronSession: _attachElectronSession,
  isLoggedIn,
  clearCookies,
  BASE_URL,
};
