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
// SRM publishes the timetable on a Zoho page whose slug rotates per
// academic year (`My_Time_Table_2023_24`, `My_Time_Table_2024_25`, …).
// We try the current-year slug first and fall back to older ones until
// one returns HTML containing the actual course table. We also try
// a couple of plausible URL prefixes and a no-year slug.
function _knownTimetableSlugs() {
  const now = new Date();
  // Academic year flips in July: months 7-12 belong to the upcoming year.
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const slugs = [];
  // Year-suffixed slugs in descending order.
  for (let y = startYear; y >= startYear - 3; y--) {
    const b = String(y + 1).slice(-2);
    slugs.push(`My_Time_Table_${y}_${b}`); // e.g. My_Time_Table_2025_26
  }
  // No-year fallback that some Zoho sites use.
  slugs.push('My_Time_Table');
  // De-dupe while preserving order.
  return [...new Set(slugs)];
}

// Zoho serves the same Academia page from BOTH the legacy
// `srm_university/academia-academic-services/...` prefix and the newer
// `portal/academia-academic-services/...` prefix. The older URL still
// works for many accounts; the new login flow lands on `/portal/...`.
// We try both — first hit wins.
function _pageUrlVariants(slug) {
  return [
    `${BASE_URL}/srm_university/academia-academic-services/page/${slug}`,
    `${BASE_URL}/portal/academia-academic-services/page/${slug}`,
  ];
}

// Browser-ish User-Agent + standard request headers. Without these Zoho
// happily 200s a non-page (or login redirect) that has no sanitize()
// payload, which gives the misleading "no sanitize() payload" error.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function _pageHeaders(jar) {
  return {
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': BROWSER_UA,
    'Cache-Control': 'no-cache',
    Cookie: jar.header(),
    Referer: `${BASE_URL}/`,
    'sec-ch-ua': '"Chromium";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'Upgrade-Insecure-Requests': '1',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

// Heuristic — does this body look like a Zoho login redirect / shell
// rather than a real Academia page?
function _looksLikeLogin(body) {
  if (!body) return false;
  if (/\/accounts\/p\/[\w-]+\/signin/i.test(body)) return true;
  if (/iam\.zoho\.com|sign\s*in\s*to/i.test(body) && !/course_tbl/.test(body)) return true;
  return false;
}

// Decode a JS string literal — handles every escape Zoho uses. The old
// implementation only did `\xNN`, which left `\uXXXX`, `\\'`, `\\\\`,
// `\\/`, etc. as literal characters. cheerio then saw `<table>`
// instead of `<table>` and couldn't find any tags, even though the raw
// substring "course_tbl" was present. This is what made diagnose say
// "course_tbl ✓" while sync said "no course table".
function _decodeJsLiteral(s) {
  if (!s) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c !== '\\') { out += c; i++; continue; }
    const next = s[i + 1];
    if (next === undefined) { out += c; i++; continue; }
    // \uXXXX or \u{XXXX}
    if (next === 'u') {
      if (s[i + 2] === '{') {
        const end = s.indexOf('}', i + 3);
        if (end > 0) {
          const cp = parseInt(s.slice(i + 3, end), 16);
          if (Number.isFinite(cp)) { out += String.fromCodePoint(cp); i = end + 1; continue; }
        }
      } else {
        const hex = s.slice(i + 2, i + 6);
        if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6; continue;
        }
      }
    }
    // \xNN
    if (next === 'x') {
      const hex = s.slice(i + 2, i + 4);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4; continue;
      }
    }
    // single-character escapes
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\\': '\\', "'": "'", '"': '"', '`': '`', '/': '/' };
    if (map[next] !== undefined) { out += map[next]; i += 2; continue; }
    // Fallback: drop the backslash, keep the next char literal.
    out += next;
    i += 2;
  }
  return out;
}

// Decode HTML entities — needed because some Zoho pages double-wrap the
// payload (JS-quoted string containing HTML-entity-encoded HTML).
function _decodeHtmlEntities(s) {
  if (!s || !/&[#a-zA-Z0-9]+;/.test(s)) return s;
  return s
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // leave amp last
}

// Returns the most-likely "real page" decoded HTML. Tries every sanitize()
// payload on the page, decodes it through both layers, and picks the one
// containing a recognisable Academia marker.
function _extractTimetableHtml(rawText) {
  const reSingle = /pageSanitizer\.sanitize\('([\s\S]+?)'\)/g;
  const reDouble = /pageSanitizer\.sanitize\("([\s\S]+?)"\)/g;
  const candidates = [];
  let m;
  while ((m = reSingle.exec(rawText)) != null) candidates.push(m[1]);
  while ((m = reDouble.exec(rawText)) != null) candidates.push(m[1]);
  if (candidates.length === 0) return null;

  const fullyDecode = (enc) => {
    let s = _decodeJsLiteral(enc);
    // If after JS-literal decode we STILL don't see real tags, try HTML
    // entity decode — some Zoho skins wrap the payload twice.
    if (!/<\w/.test(s) && /&lt;\w/.test(s)) {
      s = _decodeHtmlEntities(s);
    }
    return s;
  };

  // Prefer payloads with the real markers.
  for (const enc of candidates) {
    const decoded = fullyDecode(enc);
    if (/class\s*=\s*["']?(course_tbl|mainDiv)/.test(decoded)) return decoded;
  }
  // Fallback: largest payload (often the body even without a clean class match).
  let largest = candidates[0];
  for (const c of candidates) if (c.length > largest.length) largest = c;
  return fullyDecode(largest);
}

async function _tryFetchPage(url, jar) {
  let res;
  try {
    res = await fetch(url, { headers: _pageHeaders(jar), redirect: 'follow' });
  } catch (err) {
    return { url, ok: false, error: err.message };
  }
  let text = '';
  try { text = await res.text(); } catch {}
  return {
    url,
    ok: res.ok,
    status: res.status,
    finalUrl: res.url || url,
    bodyLen: text.length,
    bodyPreview: text.slice(0, 200).replace(/\s+/g, ' ').trim(),
    body: text,
    looksLikeLogin: _looksLikeLogin(text),
  };
}

async function fetchTimetableHtml(jar) {
  // If no jar passed, build one from the Electron persistent session.
  if (!jar) jar = await _jarFromElectronSession();
  if (!jar) {
    throw new Error('No SRM cookies available — run "Log in to SRM" first.');
  }
  const slugs = _knownTimetableSlugs();
  const errors = [];
  let sawLoginRedirect = false;

  for (const slug of slugs) {
    for (const url of _pageUrlVariants(slug)) {
      const r = await _tryFetchPage(url, jar);
      if (!r.ok) {
        errors.push(`${slug} @ ${url.replace(BASE_URL, '')}: HTTP ${r.status || 'fetch'} ${r.error || ''}`);
        continue;
      }
      // Detect login redirect — body is the signin shell rather than the
      // real Academia page. Surface a clear "session expired" message.
      if (r.looksLikeLogin) {
        sawLoginRedirect = true;
        errors.push(
          `${slug} @ ${url.replace(BASE_URL, '')}: got login page (session expired or wrong scope)`,
        );
        continue;
      }
      let decoded = _extractTimetableHtml(r.body);
      // Fallback — page may embed HTML inline without a sanitize() wrapper.
      if (!decoded || !/course_tbl|Course Code/i.test(decoded)) {
        try {
          const $$ = cheerio.load(r.body);
          const direct = $$('div.mainDiv').first();
          if (direct && direct.length > 0 && /course_tbl|Course Code/i.test($$.html(direct))) {
            decoded = $$.html(direct);
          }
        } catch { /* ignore */ }
      }
      if (!decoded) {
        errors.push(
          `${slug} @ ${url.replace(BASE_URL, '')}: no sanitize() payload AND no inline mainDiv (${r.bodyLen}B; "${r.bodyPreview.slice(0, 80)}")`,
        );
        continue;
      }
      const $ = cheerio.load(decoded);
      // Selector hierarchy — most specific first, falling back to any
      // element with the .course_tbl class (Zoho occasionally wraps the
      // table in a <div> or puts the class on a parent for newer skins).
      let container =
        $('div.mainDiv').first().length > 0 ? $('div.mainDiv').first() :
        $('table.course_tbl').first().length > 0 ? $('table.course_tbl').first().parents().last() :
        $('.course_tbl').first().length > 0 ? $('.course_tbl').first().parents().last() :
        null;
      // Final fallback: if cheerio sees ANY <table> with at least 11 cells
      // (the Course Code / Title / Credit / … header row), take that.
      if (!container || container.length === 0) {
        $('table').each((_, t) => {
          if (container && container.length > 0) return;
          const cells = $(t).find('td, th');
          if (cells.length >= 11) {
            const text = $(t).text();
            if (/Course Code|Course Title|Slot/i.test(text)) container = $(t);
          }
        });
      }
      if (container && container.length > 0) {
        const html = $.html(container);
        if (/course_tbl|Course Code/i.test(html)) {
          return html;
        }
      }
      // Capture a decoded sample so we can inspect what the parser saw.
      const decodedSample = decoded.slice(0, 500).replace(/\s+/g, ' ');
      errors.push(
        `${slug} @ ${url.replace(BASE_URL, '')}: decoded ${decoded.length}B but no course table — sample: "${decodedSample.slice(0, 200)}"`,
      );
    }
  }
  if (sawLoginRedirect) {
    const err = new Error(
      'SRM session expired or scoped wrong — please click "Log in to SRM" again.',
    );
    err.needsLogin = true;
    err.debug = errors;
    throw err;
  }
  const err = new Error(
    'Timetable not found on any known page slug. Tried: ' + errors.join(' | '),
  );
  err.debug = errors;
  throw err;
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
  const errors = [];
  let sawLoginRedirect = false;
  for (const slug of slugsToTry) {
    for (const url of _pageUrlVariants(slug)) {
      const r = await _tryFetchPage(url, jar);
      if (!r.ok) {
        errors.push(`${slug} @ ${url.replace(BASE_URL, '')}: HTTP ${r.status || 'fetch'} ${r.error || ''}`);
        continue;
      }
      if (r.looksLikeLogin) {
        sawLoginRedirect = true;
        errors.push(`${slug} @ ${url.replace(BASE_URL, '')}: got login page`);
        continue;
      }

      // Try the sanitize() wrapper first; fall back to direct HTML in the
      // body (newer Zoho skins ship the page HTML inline in a
      // `<div id="zppagesLive">` block — no JS string wrapper).
      let candidate = _extractTimetableHtml(r.body);
      if (!candidate || !/>DO[<\s]|>D\.?O\.?\s|Day\s*Order/i.test(candidate)) {
        try {
          const $$ = cheerio.load(r.body);
          const md = $$('div.mainDiv').first();
          if (md && md.length > 0) {
            const inner = $$.html(md);
            if (/>DO[<\s]|Day\s*Order/i.test(inner)) candidate = inner;
          }
        } catch { /* ignore */ }
      }
      if (!candidate) {
        errors.push(
          `${slug} @ ${url.replace(BASE_URL, '')}: no sanitize() payload AND no inline mainDiv (${r.bodyLen}B)`,
        );
        continue;
      }
      if (!/(>DO<|>DO\s|Day\s*Order)/i.test(candidate)) {
        errors.push(`${slug} @ ${url.replace(BASE_URL, '')}: no DO column`);
        continue;
      }
      return { html: candidate, planName: slug };
    }
  }
  if (sawLoginRedirect) {
    const err = new Error('Calendar fetch hit login page — session expired.');
    err.needsLogin = true;
    err.debug = errors;
    throw err;
  }
  const err = new Error(
    `Could not fetch academic planner. Tried: ${errors.join(' | ')}`,
  );
  err.debug = errors;
  throw err;
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
    // If the request 401'd or got bounced to the login shell, signal the
    // UI to re-prompt the browser-window login. Detailed debug strings
    // are attached for the Settings panel.
    return {
      ok: false,
      needsLogin: !!err.needsLogin,
      error: `Timetable: ${err.message}`,
      debug: err.debug || null,
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

// ─── diagnose ───────────────────────────────────────────────────────────
// Exercises every URL × prefix combo and reports back a rich debug
// payload — request status, body length, body preview, sanitize() match
// counts, mainDiv presence, login-redirect heuristic. Used by the
// "Diagnose" button in Settings → Schedule so the user can see exactly
// what SRM is returning when sync fails.
async function diagnose() {
  const out = {
    ok: true,
    cookieCount: 0,
    cookieNames: [],
    isLoggedIn: false,
    timetableAttempts: [],
    calendarAttempts: [],
    suggestion: null,
  };
  if (!_electronSession) {
    out.ok = false;
    out.suggestion =
      'No persistent SRM session attached yet. Restart Apex; then click Log in to SRM.';
    return out;
  }
  try {
    const cookies = await _electronSession.cookies.get({ url: BASE_URL });
    out.cookieCount = cookies.length;
    out.cookieNames = cookies.map((c) => c.name);
    out.isLoggedIn = await isLoggedIn();
  } catch (err) {
    out.ok = false;
    out.suggestion = `Couldn't read cookies: ${err.message}`;
    return out;
  }
  const jar = await _jarFromElectronSession();
  if (!jar) {
    out.ok = false;
    out.suggestion = 'No SRM cookies — click Log in to SRM.';
    return out;
  }
  // Try every timetable slug × prefix combo and collect everything.
  for (const slug of _knownTimetableSlugs()) {
    for (const url of _pageUrlVariants(slug)) {
      const r = await _tryFetchPage(url, jar);
      const sanitizeMatches = (r.body || '').match(
        /pageSanitizer\.sanitize\(['"]/g,
      );
      let mainDivFound = false;
      let courseTblFound = false;
      let courseTblIsTable = false;     // .course_tbl IS on a <table> element
      let cheerioFoundTable = false;    // cheerio's selector actually matches
      let pickedPayloadLen = 0;
      let decodedSample = null;
      try {
        const decoded = _extractTimetableHtml(r.body || '');
        if (decoded) {
          pickedPayloadLen = decoded.length;
          mainDivFound = /class\s*=\s*["']?mainDiv/.test(decoded);
          courseTblFound = /class\s*=\s*["']?course_tbl/.test(decoded);
          courseTblIsTable = /<table[^>]*class\s*=\s*["']?course_tbl/i.test(decoded);
          // Check cheerio's selector behaviour explicitly, mirroring
          // what fetchTimetableHtml does.
          try {
            const $$ = cheerio.load(decoded);
            cheerioFoundTable = $$('table.course_tbl').length > 0
              || $$('div.mainDiv').length > 0
              || $$('.course_tbl').length > 0;
          } catch { /* ignore */ }
          // Capture a 600-char sample around the first occurrence so we
          // can see what the decoded body actually looks like.
          const idx = decoded.search(/course_tbl|mainDiv/);
          const start = Math.max(0, idx - 200);
          decodedSample = decoded
            .slice(start, start + 600)
            .replace(/\s+/g, ' ')
            .trim();
        }
      } catch { /* ignore */ }
      out.timetableAttempts.push({
        slug,
        url: url.replace(BASE_URL, ''),
        ok: r.ok,
        status: r.status || null,
        bodyLen: r.bodyLen || 0,
        bodyPreview: r.bodyPreview,
        sanitizeMatches: sanitizeMatches?.length || 0,
        looksLikeLogin: !!r.looksLikeLogin,
        mainDivFound,
        courseTblFound,
        courseTblIsTable,
        cheerioFoundTable,
        pickedPayloadLen,
        decodedSample,
        finalUrl: r.finalUrl ? r.finalUrl.replace(BASE_URL, '') : null,
      });
    }
  }
  // Same exhaustive scan for the academic planner.
  for (const slug of KNOWN_PLAN_SLUGS) {
    for (const url of _pageUrlVariants(slug)) {
      const r = await _tryFetchPage(url, jar);
      const body = r.body || '';
      const sanitizeMatches = body.match(/pageSanitizer\.sanitize\(['"]/g);
      const altSanitize = body.match(/pageSanitizer[\[\.](?:["']?sanitize)/g);
      // Look for raw markers anywhere in the (possibly-undecoded) body.
      const rawMarkers = {
        hasMainDiv: /mainDiv/.test(body),
        hasCourseTbl: /course_tbl/.test(body),
        hasDOheader: />DO\s*<|>DO\s*<\/(?:font|th|strong)/i.test(body),
        hasDayOrder: /Day\s*Order/i.test(body),
        hasZmlValue: /zmlvalue/.test(body),
        hasPagesId: /pagelinkname=/.test(body),
      };
      // If the body has a real planner page (134KB with DO header in raw
      // form), try to extract the embedded HTML even without sanitize().
      let extractedFromRaw = false;
      if (!sanitizeMatches && rawMarkers.hasMainDiv) {
        try {
          // Some Zoho skins put the page HTML directly inside a
          // `<div id="zppagesLive" ...>` block as plain HTML — no
          // sanitize() wrapper.
          const $$ = cheerio.load(body);
          const md = $$('div.mainDiv').first();
          extractedFromRaw = md.length > 0;
        } catch { /* ignore */ }
      }
      out.calendarAttempts.push({
        slug,
        url: url.replace(BASE_URL, ''),
        ok: r.ok,
        status: r.status || null,
        bodyLen: r.bodyLen || 0,
        sanitizeMatches: sanitizeMatches?.length || 0,
        altSanitizeMatches: altSanitize?.length || 0,
        looksLikeLogin: !!r.looksLikeLogin,
        hasDoColumn: />DO[<\s]/.test(body),
        rawMarkers,
        extractedFromRaw,
        finalUrl: r.finalUrl ? r.finalUrl.replace(BASE_URL, '') : null,
      });
    }
  }

  // Heuristic suggestion based on what we saw.
  const ttHits = out.timetableAttempts.filter((a) => a.courseTblFound);
  const ttLoginRedir = out.timetableAttempts.some((a) => a.looksLikeLogin);
  if (ttHits.length > 0) {
    out.suggestion =
      `Found a working slug: ${ttHits[0].slug} on ${ttHits[0].url}. ` +
      `If sync still fails, the problem is downstream of fetching.`;
  } else if (ttLoginRedir) {
    out.suggestion =
      'Every page request returned the SRM login shell — your browser session is no longer accepted. ' +
      'Click "Log in to SRM" again to refresh cookies.';
  } else if (out.cookieCount === 0) {
    out.suggestion =
      'No SRM cookies in the persistent partition. Click "Log in to SRM" first.';
  } else {
    const sanitizeFound = out.timetableAttempts.find((a) => a.sanitizeMatches > 0);
    if (sanitizeFound) {
      out.suggestion =
        `Got sanitize() payloads but no course_tbl marker on ${sanitizeFound.slug}. ` +
        'SRM may have changed the page slug for your account — open the timetable in a browser, copy the URL slug from the address bar, and we can wire it up.';
    } else {
      out.suggestion =
        'Every page returned bodies with NO sanitize() payload at all. ' +
        'SRM Academia is likely rejecting the request scope — try logging in again, or check if academia.srmist.edu.in is reachable from your network.';
    }
  }
  return out;
}

module.exports = {
  login,
  fetchTimetableHtml,
  parseStudentDetails,
  fetchCalendarHtml,
  parseCalendarEvents,
  buildClassesRows,
  syncAll,
  diagnose,
  // Browser-based session helpers
  attachElectronSession: _attachElectronSession,
  isLoggedIn,
  clearCookies,
  BASE_URL,
};
