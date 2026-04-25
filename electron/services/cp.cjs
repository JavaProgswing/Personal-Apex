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

module.exports = {
  fetchLeetCode,
  fetchCodeforces,
  fetchCodeChef,
  fetchAllForPerson,
  fetchAllPeople,
  fetchSelf,
  selfCached,
};
