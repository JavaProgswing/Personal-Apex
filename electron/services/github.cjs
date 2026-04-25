// Apex — GitHub service. Uses the public REST API. An optional token stored
// in settings as 'github.token' unlocks the 5000/hr rate limit. Rate-limit
// errors surface as err.code === 'RATE_LIMIT' with resetAt (unix ms) so the
// UI can show "waiting until Xm".
//
// v0.4 adds:
//   • a shared rate-limit cache populated from response headers so we can
//     proactively slow down before hitting 0
//   • a worker-pool syncAll that fans out to N people in parallel while
//     still respecting rate limits

const db = require('./db.cjs');

const BASE = 'https://api.github.com';
const PER_PAGE = 100;

// Concurrency for syncAll. Each worker handles one person sequentially.
// 3 is conservative — even an authenticated 5000/hr token has a secondary
// abuse-detection limit of ~80 req/sec; 3 workers stay well below that.
const SYNC_CONCURRENCY = 3;
// When fewer than this many requests remain, we start sleeping instead of
// blowing the budget on the rest of a sync.
const RATE_LIMIT_BUFFER = 50;

const rateState = {
  remaining: null,     // last seen x-ratelimit-remaining
  resetAt: null,       // last seen x-ratelimit-reset (ms)
  lastUpdated: 0,
};

function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }

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

// If we're near the rate-limit floor, wait until reset (capped to 60s so the
// UI can still move). Returns true if we slept.
async function awaitBudget() {
  if (rateState.remaining == null) return false;
  if (rateState.remaining > RATE_LIMIT_BUFFER) return false;
  if (!rateState.resetAt) return false;
  const wait = rateState.resetAt - Date.now();
  if (wait <= 0) return false;
  // Cap the wait to 60s — beyond that we let the caller handle a real
  // RATE_LIMIT error instead of stalling forever.
  await sleep(Math.min(wait, 60_000));
  return true;
}

async function gh(pathname, opts = {}) {
  await awaitBudget();
  const res = await fetch(`${BASE}${pathname}`, { headers: headers() });

  // Always update rate state from headers, even on errors.
  const rem = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (rem != null) rateState.remaining = +rem;
  if (reset != null) rateState.resetAt = +reset * 1000;
  rateState.lastUpdated = Date.now();

  if (res.status === 403 || res.status === 429) {
    const err = new Error(
      `GitHub rate-limited (${rem ?? '?'} remaining). Resets at ${
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

// Sync everyone with a small worker pool. Workers consume from a shared
// queue; each worker syncs one person at a time but multiple workers run
// concurrently. Rate-limit handling:
//   • before each `gh()` request the awaitBudget guard sleeps if we're
//     near zero remaining requests
//   • a hard 403/429 response sets a `stop` flag that drains the pool
//     gracefully and surfaces resetAt to the UI
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
  let cursor = 0;
  let done = 0;
  let stopped = false;
  let stopReset = null;
  const inFlight = new Set();

  function emit(extra = {}) {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({
        total,
        done,
        inFlight: [...inFlight],
        rateRemaining: rateState.remaining,
        ...extra,
      });
    } catch { /* ignore listener errors */ }
  }

  async function worker(workerId) {
    while (!stopped) {
      const idx = cursor++;
      if (idx >= people.length) return;
      const p = people[idx];
      inFlight.add(p.name);
      emit({ current: p.name, id: p.id, worker: workerId });
      try {
        const r = await syncPerson(p.id);
        results.push({ id: p.id, name: p.name, ok: r.ok, count: r.count });
      } catch (err) {
        results.push({
          id: p.id, name: p.name, ok: false,
          code: err.code, error: err.message,
        });
        if (err.code === 'RATE_LIMIT') {
          stopped = true;
          stopReset = err.resetAt;
        }
      } finally {
        inFlight.delete(p.name);
        done++;
        emit();
      }
    }
  }

  emit({ phase: 'starting' });
  const workers = Array.from({ length: Math.min(SYNC_CONCURRENCY, total) }, (_, i) => worker(i));
  await Promise.all(workers);
  emit({
    phase: 'done',
    rateLimited: stopped,
    resetAt: stopReset,
  });
  return results;
}

// Manifest files we extract verbatim (truncated) so the Ollama summary
// has a grounded view of the actual stack, scripts, and dependencies.
const MANIFEST_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  'environment.yml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'pubspec.yaml',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'next.config.js',
  'next.config.mjs',
  'vite.config.js',
  'vite.config.ts',
  'tailwind.config.js',
  'tailwind.config.ts',
  'tsconfig.json',
  'app.json',          // Expo / React Native
  'expo.json',
  'capacitor.config.ts',
  'turbo.json',
  'nx.json',
  'Makefile',
  'CMakeLists.txt',
];

// One-repo file tree (recursive). Truncated by GitHub for large repos —
// they set `truncated: true`. We still get a useful sample either way.
async function fetchTree(fullName, branch) {
  if (!fullName) return null;
  const ref = encodeURIComponent(branch || 'HEAD');
  try {
    return await gh(`/repos/${fullName}/git/trees/${ref}?recursive=1`);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

// Fetches a file via the Contents API. Returns decoded UTF-8 text or null.
async function fetchFileContent(fullName, filePath, maxBytes = 8 * 1024) {
  try {
    const data = await gh(
      `/repos/${fullName}/contents/${encodeURI(filePath)}`,
    );
    if (!data || data.type !== 'file' || !data.content) return null;
    const raw = Buffer.from(data.content, data.encoding || 'base64').toString('utf8');
    return raw.slice(0, maxBytes);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return null;
    return null;
  }
}

// One-repo deep fetch used by the repo detail modal. v0.5: fetches README,
// languages, the recursive file tree, and any well-known manifest files
// (package.json, requirements.txt, Cargo.toml, etc.) so the Ollama summary
// is grounded in the actual project — not just the README.
async function fetchRepoDetail(repoId) {
  const dbh = db._db();
  const repo = dbh.prepare('SELECT * FROM repos WHERE id = ?').get(repoId);
  if (!repo) throw new Error('Unknown repo id: ' + repoId);

  const [readme, languages, tree] = await Promise.all([
    fetchReadme(repo.full_name).catch(() => null),
    fetchLanguages(repo.full_name).catch(() => ({})),
    fetchTree(repo.full_name).catch(() => null),
  ]);

  // Walk the tree to find which manifests actually exist at the root or
  // one directory down (so monorepo apps still register).
  let manifests = {};
  let topPaths = [];
  if (tree && Array.isArray(tree.tree)) {
    const allPaths = tree.tree
      .filter((n) => n.type === 'blob')
      .map((n) => n.path);
    topPaths = allPaths.slice(0, 200);

    const wanted = new Set(
      allPaths.filter((p) => {
        const name = p.split('/').pop();
        return MANIFEST_FILES.includes(name) && p.split('/').length <= 3;
      }),
    );
    // Cap to ~6 manifests so we never blow the prompt budget.
    const picked = [...wanted].slice(0, 6);
    const fetched = await Promise.all(
      picked.map((p) =>
        fetchFileContent(repo.full_name, p).then((txt) => [p, txt]),
      ),
    );
    for (const [p, txt] of fetched) {
      if (txt) manifests[p] = txt;
    }
  }

  return {
    repo,
    readme: readme || null,
    languages: languages || {},
    treeTruncated: tree?.truncated ?? false,
    paths: topPaths,
    manifests,
  };
}

module.exports = {
  fetchUser, fetchRepos, fetchLanguages, fetchReadme, fetchRecentActivity,
  fetchRepoDetail, fetchTree, fetchFileContent,
  syncPerson, syncAll, rateLimit,
};
