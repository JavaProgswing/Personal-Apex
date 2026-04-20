// Apex — GitHub service. Uses the public REST API. An optional token stored
// in settings as 'github.token' unlocks the 5000/hr rate limit. Rate-limit
// errors surface as err.code === 'RATE_LIMIT' with resetAt (unix ms) so the
// UI can show "waiting until Xm".

const db = require('./db.cjs');

const BASE = 'https://api.github.com';
const PER_PAGE = 100;

function headers() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'apex-desktop',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const tok = db.getSetting('github.token');
  if (tok) h.Authorization = `Bearer ${tok}`;
  return h;
}

async function gh(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, { headers: headers() });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    const remaining = res.headers.get('x-ratelimit-remaining');
    const err = new Error(
      `GitHub rate-limited (${remaining ?? '?'} remaining). Resets at ${
        reset ? new Date(+reset * 1000).toLocaleTimeString() : 'soon'
      }. Add a token in Settings → GitHub.`
    );
    err.code = 'RATE_LIMIT';
    err.resetAt = reset ? +reset * 1000 : null;
    throw err;
  }
  if (res.status === 404) {
    const err = new Error(`Not found: ${pathname}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (res.status === 304) return opts.ifNoneMatchFallback ?? null;
  if (!res.ok) throw new Error(`GitHub ${pathname} returned ${res.status}`);
  if (opts.raw) return res.text();
  return res.json();
}

function rateLimit() {
  return fetch(`${BASE}/rate_limit`, { headers: headers() })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

async function fetchUser(username) {
  return gh(`/users/${encodeURIComponent(username)}`);
}

// Paginates /users/:u/repos across ALL pages. type=owner returns everything
// owned (public + private if token scope allows, sources + forks). We then
// filter forks client-side unless includeForks=true.
async function fetchRepos(username, { includeForks = false } = {}) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const path =
      `/users/${encodeURIComponent(username)}/repos` +
      `?per_page=${PER_PAGE}&page=${page}&sort=pushed&direction=desc&type=owner`;
    const list = await gh(path);
    if (!Array.isArray(list) || list.length === 0) break;
    out.push(...list);
    if (list.length < PER_PAGE) break;
  }
  return includeForks ? out : out.filter((r) => !r.fork);
}

async function fetchLanguages(fullName) {
  return gh(`/repos/${fullName}/languages`);
}

// Returns decoded README text (≤200 KB) or null if missing. GitHub returns
// base64-encoded content in the `content` field.
async function fetchReadme(fullName) {
  try {
    const data = await gh(`/repos/${fullName}/readme`);
    if (!data || !data.content) return null;
    const raw = Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
    return raw.slice(0, 200 * 1024);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

// Recent pushes — uses /users/:u/events/public (public event stream, last 90).
async function fetchRecentActivity(username, limit = 30) {
  try {
    const evs = await gh(`/users/${encodeURIComponent(username)}/events/public?per_page=${limit}`);
    const pushes = [];
    for (const e of evs || []) {
      if (e.type !== 'PushEvent') continue;
      for (const c of (e.payload?.commits || [])) {
        pushes.push({
          repo: e.repo?.name,
          url: `https://github.com/${e.repo?.name}/commit/${c.sha}`,
          message: c.message,
          at: e.created_at,
        });
      }
    }
    return pushes;
  } catch {
    return [];
  }
}

// Fetch one person's profile + all repos. Persists everything into SQLite.
async function syncPerson(personId) {
  const dbh = db._db();
  const person = dbh.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  if (!person) throw new Error('No such person');
  if (!person.github_username) return { ok: false, error: 'Person has no github_username set' };

  const user = await fetchUser(person.github_username);
  db.upsertPerson({
    id: person.id,
    name: person.name,
    github_username: person.github_username,
    linkedin_url: person.linkedin_url,
    source: person.source,
    tags: JSON.parse(person.tags || '[]'),
    notes: person.notes,
    avatar_url: user.avatar_url,
    bio: user.bio,
  });

  const repos = await fetchRepos(person.github_username);
  for (const r of repos) {
    let languages = {};
    try { languages = await fetchLanguages(r.full_name); } catch { /* per-repo fail is fine */ }
    db.upsertRepo({
      person_id: person.id,
      github_id: r.id,
      name: r.name,
      full_name: r.full_name,
      description: r.description,
      url: r.html_url,
      language: r.language,
      languages,
      topics: r.topics || [],
      stars: r.stargazers_count,
      forks: r.forks_count,
      pushed_at: r.pushed_at,
    });
  }
  // Persist recent pushes into activity_feed via the activity service.
  try {
    const pushes = await fetchRecentActivity(person.github_username, 30);
    if (pushes.length) db.insertActivityFeed(person.id, pushes);
  } catch { /* ignore */ }
  db.touchPersonScraped(person.id);
  return { ok: true, count: repos.length };
}

// Sync everyone. Emits progress via `onProgress` after each person.
async function syncAll(onProgress) {
  const dbh = db._db();
  const people = dbh
    .prepare(
      `SELECT id, name FROM people
       WHERE github_username IS NOT NULL AND TRIM(github_username) != ''`
    )
    .all();
  const total = people.length;
  const results = [];
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    if (typeof onProgress === 'function') {
      try { onProgress({ total, done: i, current: p.name, id: p.id }); } catch {}
    }
    try {
      const r = await syncPerson(p.id);
      results.push({ id: p.id, name: p.name, ok: r.ok, count: r.count });
    } catch (err) {
      results.push({ id: p.id, name: p.name, ok: false, code: err.code, error: err.message });
      if (err.code === 'RATE_LIMIT') {
        if (typeof onProgress === 'function') {
          try { onProgress({ total, done: i, current: p.name, rateLimited: true, resetAt: err.resetAt }); } catch {}
        }
        break;
      }
    }
  }
  if (typeof onProgress === 'function') {
    try { onProgress({ total, done: total }); } catch {}
  }
  return results;
}

// One-repo deep fetch used by the repo detail modal. Returns the cached DB
// record merged with fresh README/languages.
async function fetchRepoDetail(repoId) {
  const dbh = db._db();
  const repo = dbh.prepare('SELECT * FROM repos WHERE id = ?').get(repoId);
  if (!repo) throw new Error('Unknown repo id: ' + repoId);
  const [readme, languages] = await Promise.all([
    fetchReadme(repo.full_name).catch(() => null),
    fetchLanguages(repo.full_name).catch(() => ({})),
  ]);
  return {
    repo,
    readme: readme || null,
    languages: languages || {},
  };
}

module.exports = {
  fetchUser, fetchRepos, fetchLanguages, fetchReadme, fetchRecentActivity,
  fetchRepoDetail, syncPerson, syncAll, rateLimit,
};
