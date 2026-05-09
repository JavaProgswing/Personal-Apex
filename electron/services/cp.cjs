// Apex — competitive programming stats.
// Pulls public profile info + recent submissions from LeetCode, Codeforces,
// and CodeChef. No API keys needed — all endpoints are public.
//
// Each fetcher returns {ok, ...stats} or {ok:false, error, retryAfter?}.
// Errors are persisted to cp_stats.error so the UI can show "rate-limited,
// retry in 60s" without the caller doing anything fancy.

const db = require('./db.cjs');

// ───────────────────────────────────────────────────────────────────────────
// Rate-limit / retry helper. Wraps fetch with:
//   - User-Agent
//   - exponential backoff on 429/503
//   - respects Retry-After
// ───────────────────────────────────────────────────────────────────────────
async function safeFetch(url, opts = {}, { retries = 2, timeoutMs = 15000 } = {}) {
  const headers = { 'User-Agent': 'Apex/0.2 (+local dev, yashasvi)', ...(opts.headers || {}) };
  let attempt = 0;
  while (true) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, headers, signal: ctl.signal });
      clearTimeout(t);
      if (res.status === 429 || res.status === 503) {
        const ra = parseInt(res.headers.get('retry-after') || '0', 10);
        if (attempt < retries) {
          const waitMs = ra ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt);
          await sleep(waitMs);
          attempt++;
          continue;
        }
        const e = new Error(`rate-limited (HTTP ${res.status})`);
        e.status = res.status;
        e.retryAfter = ra || null;
        throw e;
      }
      return res;
    } catch (err) {
      clearTimeout(t);
      if (err.name === 'AbortError') {
        if (attempt < retries) { attempt++; continue; }
        throw new Error(`timeout after ${timeoutMs}ms`);
      }
      throw err;
    }
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ───────────────────────────────────────────────────────────────────────────
// LeetCode (GraphQL). Also pulls recent AC submissions for the sparkline.
// ───────────────────────────────────────────────────────────────────────────
async function fetchLeetCode(handle) {
  if (!handle) return { ok: false, error: 'no handle' };
  const query = `
    query userPublicProfile($username: String!) {
      matchedUser(username: $username) {
        username
        profile { ranking realName userAvatar }
        submitStats { acSubmissionNum { difficulty count submissions } }
      }
      userContestRanking(username: $username) {
        attendedContestsCount rating globalRanking topPercentage
      }
      recentAcSubmissionList(username: $username, limit: 10) {
        id title titleSlug timestamp
      }
    }
  `;
  try {
    const res = await safeFetch('https://leetcode.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: `https://leetcode.com/${handle}/`,
      },
      body: JSON.stringify({ query, variables: { username: handle } }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const m = data?.data?.matchedUser;
    if (!m) return { ok: false, error: 'profile not found' };
    const ac = m.submitStats?.acSubmissionNum || [];
    const byDiff = Object.fromEntries(ac.map((r) => [r.difficulty.toLowerCase(), r.count]));
    const contest = data?.data?.userContestRanking ?? {};
    const submissions = (data?.data?.recentAcSubmissionList ?? []).map((s) => ({
      problem_id: s.titleSlug,
      title: s.title,
      verdict: 'AC',
      submitted_at: new Date(parseInt(s.timestamp, 10) * 1000).toISOString(),
      url: `https://leetcode.com/problems/${s.titleSlug}/`,
    }));
    return {
      ok: true,
      handle,
      platform: 'leetcode',
      totalSolved: byDiff.all ?? ((byDiff.easy || 0) + (byDiff.medium || 0) + (byDiff.hard || 0)),
      easy: byDiff.easy ?? 0,
      medium: byDiff.medium ?? 0,
      hard: byDiff.hard ?? 0,
      rating: contest.rating ? Math.round(contest.rating) : null,
      contests: contest.attendedContestsCount ?? 0,
      ranking: m.profile?.ranking ?? null,
      realName: m.profile?.realName ?? null,
      avatar: m.profile?.userAvatar ?? null,
      submissions,
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err), retryAfter: err.retryAfter ?? null };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Codeforces (official JSON API, generous limits). Grabs user.info plus a
// recent-submissions window for the sparkline.
// ───────────────────────────────────────────────────────────────────────────
async function fetchCodeforces(handle) {
  if (!handle) return { ok: false, error: 'no handle' };
  try {
    const [infoRes, statusRes] = await Promise.all([
      safeFetch(`https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`),
      safeFetch(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=200`),
    ]);
    if (!infoRes.ok) return { ok: false, error: `user.info HTTP ${infoRes.status}` };
    const info = await infoRes.json();
    if (info.status !== 'OK' || !info.result?.[0]) return { ok: false, error: info.comment || 'not found' };
    const u = info.result[0];

    const solvedSet = new Set();
    const submissions = [];
    if (statusRes.ok) {
      const s = await statusRes.json();
      if (s.status === 'OK') {
        for (const sub of s.result) {
          if (!sub.problem) continue;
          const pid = `${sub.problem.contestId}_${sub.problem.index}`;
          if (sub.verdict === 'OK') solvedSet.add(pid);
          if (submissions.length < 10) {
            submissions.push({
              problem_id: pid,
              title: sub.problem.name,
              verdict: sub.verdict,
              rating: sub.problem.rating ?? null,
              submitted_at: new Date(sub.creationTimeSeconds * 1000).toISOString(),
              url: `https://codeforces.com/contest/${sub.problem.contestId}/problem/${sub.problem.index}`,
            });
          }
        }
      }
    }

    return {
      ok: true,
      handle,
      platform: 'codeforces',
      rating: u.rating ?? null,
      maxRating: u.maxRating ?? null,
      rank: u.rank ?? 'unrated',
      maxRank: u.maxRank ?? null,
      totalSolved: solvedSet.size,
      avatar: u.titlePhoto ?? u.avatar ?? null,
      submissions,
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err), retryAfter: err.retryAfter ?? null };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// CodeChef (HTML scrape — no API). Defensive parsing.
// ───────────────────────────────────────────────────────────────────────────
async function fetchCodeChef(handle) {
  if (!handle) return { ok: false, error: 'no handle' };
  try {
    const res = await safeFetch(`https://www.codechef.com/users/${encodeURIComponent(handle)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 Apex/0.2' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    if (/User not found/i.test(html)) return { ok: false, error: 'user not found' };
    const ratingMatch = html.match(/rating-number[^>]*>(\d+)/i) || html.match(/"rating"\s*:\s*(\d+)/);
    const starsMatch = html.match(/rating-star[\s\S]*?(\d)\s*star/i) || html.match(/(\d)★/);
    const solvedMatch =
      html.match(/Problems Solved[\s\S]*?<h\d[^>]*>\s*(\d+)\s*<\/h\d>/i) ||
      html.match(/Total Problems Solved[^<]*<[^>]*>\s*(\d+)/i);
    return {
      ok: true,
      handle,
      platform: 'codechef',
      rating: ratingMatch ? parseInt(ratingMatch[1], 10) : null,
      stars: starsMatch ? parseInt(starsMatch[1], 10) : null,
      totalSolved: solvedMatch ? parseInt(solvedMatch[1], 10) : null,
      submissions: [],
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err), retryAfter: err.retryAfter ?? null };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Driver — one person → all 3 platforms. Persists stats AND errors so the UI
// can always render a status pill.
// ───────────────────────────────────────────────────────────────────────────
async function fetchAllForPerson(personId) {
  const person = db._db().prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) return { ok: false, error: 'person not found' };
  const results = {};
  const jobs = [];
  if (person.leetcode_username)
    jobs.push(fetchLeetCode(person.leetcode_username).then((r) => (results.leetcode = r)));
  if (person.codeforces_username)
    jobs.push(fetchCodeforces(person.codeforces_username).then((r) => (results.codeforces = r)));
  if (person.codechef_username)
    jobs.push(fetchCodeChef(person.codechef_username).then((r) => (results.codechef = r)));
  await Promise.all(jobs);
  for (const [platform, r] of Object.entries(results)) {
    if (r.ok) {
      db.upsertCpStats(personId, platform, r, null);
      if (Array.isArray(r.submissions)) db.insertCpSubmissions(personId, platform, r.submissions);
    } else {
      // keep the last good stats, just record the error for the badge
      db.upsertCpStats(personId, platform, { handle: person[`${platform}_username`] }, r.error);
    }
  }
  db.touchPersonScraped(personId);
  return { ok: true, results };
}

// Self-stats. We don't persist these to cp_stats (no person row for self);
// cache them in settings as apex.cp.self.cache for the Dashboard to read.
async function fetchSelf() {
  const handles = {
    leetcode: db.getSetting('cp.leetcode') || '',
    codeforces: db.getSetting('cp.codeforces') || '',
    codechef: db.getSetting('cp.codechef') || '',
  };
  const out = {};
  if (handles.leetcode)   out.leetcode   = await fetchLeetCode(handles.leetcode);
  if (handles.codeforces) out.codeforces = await fetchCodeforces(handles.codeforces);
  if (handles.codechef)   out.codechef   = await fetchCodeChef(handles.codechef);
  db.setSetting('cp.self.cache', JSON.stringify({ ...out, cached_at: new Date().toISOString() }));
  return { ok: true, results: out };
}

function selfCached() {
  const raw = db.getSetting('cp.self.cache');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// CP sites (LeetCode especially) rate-limit aggressively, so we cap at 2
// concurrent workers and keep the 400ms per-call pacing.
const CP_CONCURRENCY = 2;

// Loop over people who have any CP handle using a small worker pool.
// `onProgress` is optional and called after every person completes.
async function fetchAllPeople(onProgress) {
  const people = db._db().prepare(
    `SELECT id, name FROM people WHERE
       leetcode_username IS NOT NULL
       OR codeforces_username IS NOT NULL
       OR codechef_username IS NOT NULL`
  ).all();
  const total = people.length;
  let cursor = 0, done = 0, ok = 0, err = 0;
  const inFlight = new Set();

  function emit(extra = {}) {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ total, done, ok, err, inFlight: [...inFlight], ...extra });
    } catch {}
  }

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= people.length) return;
      const p = people[idx];
      inFlight.add(p.name);
      emit({ current: p.name });
      try {
        const r = await fetchAllForPerson(p.id);
        if (r.ok) ok++; else err++;
      } catch { err++; }
      done++;
      inFlight.delete(p.name);
      emit();
      // gentle pacing per worker — keeps total request rate at ~2.5/sec/worker
      await sleep(400);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CP_CONCURRENCY, total) }, () => worker())
  );
  return { ok: true, total, done, okCount: ok, errCount: err };
}

// ───────────────────────────────────────────────────────────────────────────
// SRM Leaderboard scraper · https://lead.aakarsh.xyz/leaderboard/master
// The page is a Next.js app with client-side pagination (483 rows / 49
// pages by default). To get the full list we try, in order:
//   1) Pull the embedded `__NEXT_DATA__` script — Next.js inlines initial
//      SSR state there, often containing the entire dataset. One request,
//      done. Cheapest path.
//   2) Hit common JSON endpoints (`/api/leaderboard`, `/api/master`, the
//      `_next/data/<buildId>/leaderboard/master.json` file).
//   3) Fall back to walking pages by HTML — fetch ?page=1, ?page=2, … and
//      merge unique rows (deduped by registration number) until we get
//      either an empty page or hit a 60-page safety cap.
// All three converge into the same row schema:
//   {rank, name, leetcodeHandle, registration, section, easy, medium,
//    hard, points, total}
// ───────────────────────────────────────────────────────────────────────────
const SRM_LEADERBOARD_BASE = 'https://lead.aakarsh.xyz/leaderboard/master';
const SRM_LEADERBOARD_PAGE_CAP = 60; // safety upper bound

const stripTags = (s) =>
  String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// Parse one HTML chunk's <tbody> rows.
function parseSrmTbody(html) {
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return [];
  const rowMatches = [...tbodyMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rows = [];
  for (const m of rowMatches) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (cells.length < 9) continue;

    const rankRaw = stripTags(cells[0]);
    const rank = parseInt(rankRaw.match(/(\d+)/)?.[1] || '0', 10);
    const nameMatch  = cells[1].match(/<div class="font-medium"[^>]*>([\s\S]*?)<\/div>/i);
    const handleMatch = cells[1].match(/break-all"[^>]*>([\s\S]*?)<\/div>/i);
    const name   = nameMatch  ? stripTags(nameMatch[1])  : stripTags(cells[1]);
    const handle = handleMatch ? stripTags(handleMatch[1]) : null;
    const reg     = stripTags(cells[2]);
    const section = stripTags(cells[3]);
    const easy    = parseInt(stripTags(cells[4]) || '0', 10);
    const medium  = parseInt(stripTags(cells[5]) || '0', 10);
    const hard    = parseInt(stripTags(cells[6]) || '0', 10);
    const points  = parseInt(stripTags(cells[7]) || '0', 10);
    const total   = parseInt(stripTags(cells[8]) || '0', 10);
    if (!name || !reg) continue;
    rows.push({ rank, name, leetcodeHandle: handle, registration: reg, section, easy, medium, hard, points, total });
  }
  return rows;
}

// Best-effort: extract the full list from __NEXT_DATA__ if it exists.
// Different Next.js builds nest data under varying paths; we walk the
// tree looking for any array of objects that look like leaderboard rows.
function extractFromNextData(html) {
  const m = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!m) return null;
  let payload;
  try { payload = JSON.parse(m[1]); } catch { return null; }

  const candidates = [];
  function looksLikeRow(o) {
    if (!o || typeof o !== 'object') return false;
    return (
      ('registration' in o || 'reg' in o || 'regNo' in o || 'registrationNo' in o) &&
      ('name' in o || 'student' in o || 'studentName' in o)
    );
  }
  function walk(node) {
    if (Array.isArray(node)) {
      if (node.length > 5 && node.every(looksLikeRow)) candidates.push(node);
      else node.forEach(walk);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  }
  walk(payload);
  if (!candidates.length) return null;

  // Pick the longest candidate.
  const best = candidates.reduce((a, b) => (b.length > a.length ? b : a));
  return best.map((o, i) => ({
    rank: +o.rank || i + 1,
    name: stripTags(o.name || o.student || o.studentName || ''),
    leetcodeHandle: stripTags(o.leetcode || o.handle || o.leetcodeHandle || o.leetcodeUsername || '') || null,
    registration: stripTags(o.registration || o.reg || o.regNo || o.registrationNo || ''),
    section: stripTags(o.section || o.deptSec || o.dept_section || ''),
    easy: +o.easy || 0,
    medium: +o.medium || 0,
    hard: +o.hard || 0,
    points: +o.points || +o.score || 0,
    total: +o.total || +o.totalSolved || 0,
  })).filter((r) => r.name && r.registration);
}

// Best-effort: try the JSON endpoint Next.js exposes per-route.
async function tryJsonEndpoints(html) {
  const buildIdMatch = html.match(/"buildId":"([^"]+)"/);
  const candidateUrls = [];
  if (buildIdMatch) {
    candidateUrls.push(
      `https://lead.aakarsh.xyz/_next/data/${buildIdMatch[1]}/leaderboard/master.json`,
    );
  }
  candidateUrls.push(
    'https://lead.aakarsh.xyz/api/leaderboard?type=master',
    'https://lead.aakarsh.xyz/api/leaderboard/master',
    'https://lead.aakarsh.xyz/api/master',
  );
  for (const u of candidateUrls) {
    try {
      const res = await safeFetch(u, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      // Walk the JSON the same way we walk __NEXT_DATA__.
      const candidates = [];
      function looks(o) {
        return o && typeof o === 'object' &&
          ('registration' in o || 'reg' in o || 'regNo' in o) &&
          ('name' in o || 'student' in o);
      }
      function walk(node) {
        if (Array.isArray(node)) {
          if (node.length > 5 && node.every(looks)) candidates.push(node);
          else node.forEach(walk);
        } else if (node && typeof node === 'object') {
          Object.values(node).forEach(walk);
        }
      }
      walk(data);
      if (!candidates.length) continue;
      const best = candidates.reduce((a, b) => (b.length > a.length ? b : a));
      return best.map((o, i) => ({
        rank: +o.rank || i + 1,
        name: stripTags(o.name || o.student || ''),
        leetcodeHandle: stripTags(o.leetcode || o.handle || o.leetcodeHandle || '') || null,
        registration: stripTags(o.registration || o.reg || o.regNo || ''),
        section: stripTags(o.section || o.deptSec || ''),
        easy: +o.easy || 0,
        medium: +o.medium || 0,
        hard: +o.hard || 0,
        points: +o.points || +o.score || 0,
        total: +o.total || +o.totalSolved || 0,
      })).filter((r) => r.name && r.registration);
    } catch { /* try next */ }
  }
  return null;
}

// Primary path: hit the documented JSON API (different subdomain than the
// page itself!) — returns all 483 rows in one shot. The page-walking
// fallback below stays in place so the integration survives if the API
// schema or path ever changes.
const SRM_LEADERBOARD_API =
  'https://api.lead.aakarsh.xyz/api/leaderboard/master';

async function fetchFromApi() {
  try {
    const res = await safeFetch(SRM_LEADERBOARD_API, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || json.status !== 'success' || !Array.isArray(json.data)) {
      return null;
    }
    return json.data.map((o, i) => {
      const stats = o.stats || {};
      const dept = stripTags(o.department || '');
      const sec = stripTags(o.section || '');
      const combined = [dept, sec].filter(Boolean).join(' ');
      return {
        rank: +o.rank || i + 1,
        name: stripTags(o.name || ''),
        leetcodeHandle: stripTags(o.leetcodeUsername || o.leetcodeHandle || '') || null,
        registration: stripTags(o.regNo || o.registration || ''),
        section: combined || sec,
        easy: +stats.easySolved || 0,
        medium: +stats.mediumSolved || 0,
        hard: +stats.hardSolved || 0,
        points: +stats.points || 0,
        total: +stats.totalSolved || 0,
      };
    }).filter((r) => r.name && r.registration);
  } catch {
    return null;
  }
}

async function fetchSrmLeaderboard(onProgress) {
  const emit = (info) => { try { onProgress?.(info); } catch {} };

  // Step 0 — primary path: the documented JSON API. One GET, full dataset.
  emit({ stage: 'trying-api', url: SRM_LEADERBOARD_API });
  const apiRows = await fetchFromApi();
  if (apiRows && apiRows.length > 0) {
    emit({ stage: 'done', via: 'api', total: apiRows.length });
    return {
      ok: true,
      rows: apiRows,
      fetchedAt: new Date().toISOString(),
      via: 'api',
    };
  }

  // Step 1: fall through to HTML scraping if the API ever 404s.
  let firstPageHtml;
  try {
    emit({ stage: 'fetching-home' });
    const res = await safeFetch(SRM_LEADERBOARD_BASE, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    firstPageHtml = await res.text();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Try __NEXT_DATA__ first.
  emit({ stage: 'parsing-next-data' });
  let rows = extractFromNextData(firstPageHtml);
  if (rows && rows.length > 30) {
    emit({ stage: 'done', via: 'next-data', total: rows.length });
    return { ok: true, rows, fetchedAt: new Date().toISOString(), via: 'next-data' };
  }

  // Try the heuristic JSON endpoints (legacy guesses).
  emit({ stage: 'trying-json' });
  rows = await tryJsonEndpoints(firstPageHtml);
  if (rows && rows.length > 30) {
    emit({ stage: 'done', via: 'json-fallback', total: rows.length });
    return { ok: true, rows, fetchedAt: new Date().toISOString(), via: 'json-fallback' };
  }

  // Fall back to walking pages. The page accepts ?page=N as a query
  // string; some Next.js apps use ?p=N instead, so we'll try both shapes
  // for the first page and pick whichever returns a different rowset.
  emit({ stage: 'paginating', cap: SRM_LEADERBOARD_PAGE_CAP });
  const seen = new Map(); // registration -> row (dedup)
  const firstRows = parseSrmTbody(firstPageHtml);
  for (const r of firstRows) seen.set(r.registration, r);
  emit({ stage: 'paginating', page: 1, totalSoFar: seen.size });

  // Detect the right query-param shape by trying ?page=2 once.
  const tryParams = ['page', 'p'];
  let paramName = null;
  for (const p of tryParams) {
    try {
      const url = `${SRM_LEADERBOARD_BASE}?${p}=2`;
      const res = await safeFetch(url, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (!res.ok) continue;
      const html = await res.text();
      const r = parseSrmTbody(html);
      if (!r.length) continue;
      // If page-2 rows differ from page-1, this is the right param.
      const newOnes = r.filter((x) => !seen.has(x.registration));
      if (newOnes.length > 0) {
        paramName = p;
        for (const row of r) seen.set(row.registration, row);
        emit({ stage: 'paginating', page: 2, totalSoFar: seen.size, paramName });
        break;
      }
    } catch { /* try next */ }
  }

  // If neither query param produced new rows, the site doesn't support
  // server-side pagination via query string — return what we have from
  // page 1 with a clear note.
  if (!paramName) {
    if (seen.size === 0) return { ok: false, error: 'unable to extract rows' };
    return {
      ok: true,
      partial: true,
      via: 'html-page-1',
      note: 'Only the first 10 rows are visible without a JS runtime. Install puppeteer / hit the JSON endpoint for the rest.',
      rows: [...seen.values()],
      fetchedAt: new Date().toISOString(),
    };
  }

  // Walk subsequent pages until empty or until we stop gaining new rows.
  for (let page = 3; page <= SRM_LEADERBOARD_PAGE_CAP; page++) {
    const before = seen.size;
    try {
      const url = `${SRM_LEADERBOARD_BASE}?${paramName}=${page}`;
      const res = await safeFetch(url, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (!res.ok) break;
      const html = await res.text();
      const r = parseSrmTbody(html);
      if (!r.length) break;
      for (const row of r) seen.set(row.registration, row);
      emit({ stage: 'paginating', page, totalSoFar: seen.size });
      // Stop when a fetch adds no new rows (we've wrapped past the end).
      if (seen.size === before) break;
      // Tiny politeness sleep so we don't hammer the host.
      await sleep(200);
    } catch (err) {
      emit({ stage: 'page-error', page, err: err.message });
      break;
    }
  }

  emit({ stage: 'done', via: paramName, total: seen.size });
  return {
    ok: true,
    rows: [...seen.values()],
    fetchedAt: new Date().toISOString(),
    via: `html-${paramName}`,
  };
}

// Import / sync rows into the people table. Existing people are matched by
// registration number first (rock-solid identity), then by LeetCode handle.
// Updates leetcode_username / tags / source on existing rows so re-running
// is idempotent. Returns counts: {imported, updated, skipped}.
function syncSrmLeaderboardToPeople(rows = []) {
  const dbh = db._db();
  let imported = 0, updated = 0, skipped = 0;

  // Cache existing people once; building a Map by registration + by LC handle.
  const existing = dbh.prepare(`SELECT id, name, leetcode_username, tags, source FROM people`).all();
  const byHandle = new Map();
  for (const p of existing) {
    if (p.leetcode_username) byHandle.set(p.leetcode_username.toLowerCase(), p);
  }
  // We'll also key by reg-number stored in the `notes` field.
  const byReg = new Map();
  for (const p of existing) {
    let n;
    try { n = JSON.parse(p.notes || '{}'); } catch { n = {}; }
    if (n?.registration) byReg.set(n.registration.toUpperCase(), p);
  }

  for (const row of rows) {
    if (!row.name || !row.registration) { skipped++; continue; }
    const regKey = row.registration.toUpperCase();
    const lcKey = (row.leetcodeHandle || '').toLowerCase();
    const match = byReg.get(regKey) || (lcKey && byHandle.get(lcKey)) || null;

    const tags = ['classmate', 'srm-leaderboard'];
    if (row.section) tags.push(`section:${row.section.toLowerCase().replace(/\s+/g, '-')}`);
    // The API returns "CTECH" + "H1" separately; we tag both so users can
    // group by department alone (e.g. all CTECH people) without needing
    // section granularity.
    const sectionParts = (row.section || '').trim().split(/\s+/).filter(Boolean);
    if (sectionParts[0]) tags.push(`dept:${sectionParts[0].toLowerCase()}`);

    if (match) {
      // Update existing — top up LC handle if missing, refresh notes.
      let prevNotes = {};
      try { prevNotes = JSON.parse(match.notes || '{}'); } catch {}
      const notes = {
        ...prevNotes,
        registration: regKey,
        section: row.section,
        srmLeaderboard: {
          rank: row.rank, points: row.points, total: row.total,
          easy: row.easy, medium: row.medium, hard: row.hard,
          fetchedAt: new Date().toISOString(),
        },
      };
      dbh.prepare(
        `UPDATE people
            SET leetcode_username = COALESCE(leetcode_username, ?),
                tags = ?,
                notes = ?,
                source = COALESCE(NULLIF(source, ''), 'srm-leaderboard')
          WHERE id = ?`,
      ).run(row.leetcodeHandle || null, JSON.stringify(tags), JSON.stringify(notes), match.id);
      updated++;
    } else {
      // Insert new — match the canonical INSERT shape used elsewhere in
      // db.cjs. The `people` table has no created_at / updated_at; the
      // freshness signal lives in `last_scraped_at`.
      const notes = {
        registration: regKey,
        section: row.section,
        srmLeaderboard: {
          rank: row.rank, points: row.points, total: row.total,
          easy: row.easy, medium: row.medium, hard: row.hard,
          fetchedAt: new Date().toISOString(),
        },
      };
      dbh.prepare(
        `INSERT INTO people (name, leetcode_username, tags, notes, source)
          VALUES (?, ?, ?, ?, 'srm-leaderboard')`,
      ).run(row.name, row.leetcodeHandle || null, JSON.stringify(tags), JSON.stringify(notes));
      imported++;
    }
  }

  db.setSetting(
    'cp.srmLeaderboard.lastSync',
    JSON.stringify({ at: new Date().toISOString(), imported, updated, skipped, total: rows.length }),
  );
  return { ok: true, imported, updated, skipped, total: rows.length };
}

module.exports = {
  fetchLeetCode,
  fetchCodeforces,
  fetchCodeChef,
  fetchAllForPerson,
  fetchAllPeople,
  fetchSelf,
  selfCached,
  fetchSrmLeaderboard,
  syncSrmLeaderboardToPeople,
};
