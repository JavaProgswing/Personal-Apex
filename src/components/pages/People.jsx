import React, { useEffect, useMemo, useState } from "react";
import api from "../../lib/api.js";
import ActivityFeed from "../ActivityFeed.jsx";
import { MarkdownBlock } from "../../lib/markdown.jsx";

// Curated preset links shown in the "Import from links" modal. Treated as
// regular `{label, url}` pairs — no special-casing for NextTechLab. Users
// can extend this list at runtime via `ui.linkPresets` in localStorage.
const BUILTIN_LINK_PRESETS = [
  { label: "NextTechLab · Satoshi",  url: "https://nexttechlab.in/labs/satoshi"  },
  { label: "NextTechLab · Norman",   url: "https://nexttechlab.in/labs/norman"   },
  { label: "NextTechLab · Pausch",   url: "https://nexttechlab.in/labs/pausch"   },
  { label: "NextTechLab · McCarthy", url: "https://nexttechlab.in/labs/mccarthy" },
  { label: "NextTechLab · Tesla",    url: "https://nexttechlab.in/labs/tesla"    },
];
function loadUserLinkPresets() {
  try { return JSON.parse(localStorage.getItem("ui.linkPresets") || "[]"); }
  catch { return []; }
}
function saveUserLinkPresets(arr) {
  try { localStorage.setItem("ui.linkPresets", JSON.stringify(arr)); } catch {}
}

const PAGE_SIZE = 18;

export default function People() {
  const [people, setPeople] = useState([]);
  const [filter, setFilter] = useState({ q: "", tag: "", source: "", only: "" });
  const [groupBy, setGroupBy] = useState("none");
  const [sortBy, setSortBy] = useState("activity"); // activity | name | stars | cp
  const [page, setPage] = useState(1);
  // Per-person 14-day push counts → tiny heat-strip on each card.
  const [heatStrips, setHeatStrips] = useState({});

  const [selected, setSelected] = useState(null);
  const [repos, setRepos] = useState([]);
  const [cpStats, setCpStats] = useState([]);
  const [personActivity, setPersonActivity] = useState([]);

  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [openRepo, setOpenRepo] = useState(null); // repo row to open in detail

  const [ghSync, setGhSync] = useState({ active: false, total: 0, done: 0, current: null, rateLimited: false, resetAt: null });
  const [cpSync, setCpSync] = useState({ active: false, total: 0, done: 0, ok: 0, err: 0, current: null });
  const [status, setStatus] = useState(null);

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [filter.q, filter.tag, filter.source, filter.only]);
  useEffect(() => { setPage(1); }, [filter.q, filter.tag, filter.source, filter.only, groupBy]);

  useEffect(() => {
    const off1 = api.people.onSyncProgress((p) => setGhSync((s) => ({ ...s, ...p, active: p.done < p.total })));
    const off2 = api.cp.onProgress((p) => setCpSync((s) => ({ ...s, ...p, active: p.done < p.total })));
    return () => { off1?.(); off2?.(); };
  }, []);

  // Auto-sync on mount if data is stale. We kick off GH and CP syncs in
  // parallel; each one runs its own concurrent worker pool internally so
  // people are processed simultaneously rather than one-by-one.
  // "Stale" = last sync more than 6 hours ago (or never). Stored in
  // localStorage so it survives navigation but resets on quit.
  useEffect(() => {
    const STALE_MS = 6 * 60 * 60 * 1000; // 6h
    let cancelled = false;
    (async () => {
      const lastGh = +localStorage.getItem("apex.people.lastAutoGh") || 0;
      const lastCp = +localStorage.getItem("apex.people.lastAutoCp") || 0;
      const now = Date.now();
      const tasks = [];
      if (now - lastGh > STALE_MS) {
        localStorage.setItem("apex.people.lastAutoGh", String(now));
        tasks.push(
          (async () => {
            setGhSync({ active: true, total: 0, done: 0, current: null, rateLimited: false, resetAt: null });
            try {
              const res = await api.people.syncAll();
              if (cancelled) return;
              setGhSync((s) => ({ ...s, active: false }));
              setStatus({ msg: `GitHub auto-sync: ${res.filter((r) => r.ok).length} / ${res.length} ok` });
            } catch (e) {
              if (!cancelled) setGhSync((s) => ({ ...s, active: false }));
            }
          })()
        );
      }
      if (now - lastCp > STALE_MS) {
        localStorage.setItem("apex.people.lastAutoCp", String(now));
        tasks.push(
          (async () => {
            setCpSync({ active: true, total: 0, done: 0, ok: 0, err: 0, current: null });
            try {
              const res = await api.cp.fetchAll();
              if (cancelled) return;
              setCpSync((s) => ({ ...s, active: false }));
              setStatus((cur) => cur ?? { msg: `CP auto-sync: ${res.okCount} / ${res.total} ok` });
            } catch {
              if (!cancelled) setCpSync((s) => ({ ...s, active: false }));
            }
          })()
        );
      }
      if (tasks.length) {
        await Promise.all(tasks);
        if (!cancelled) reload();
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reload() {
    // Server only knows about q/tag; source/only are client-side pills.
    const list = await api.people.list({ q: filter.q, tag: filter.tag });
    setPeople(list || []);
    // Fetch heat strips in batch — used by PersonCard to render a 14-day
    // commit pulse. Cheap query, but keep payload bounded.
    if (api.people?.heatStrips && list?.length) {
      try {
        const ids = list.map((p) => p.id).slice(0, 200);
        const map = await api.people.heatStrips(ids, 14);
        setHeatStrips(map || {});
      } catch { setHeatStrips({}); }
    }
  }

  async function toggleFollow(p) {
    const tags = Array.isArray(p.tags) ? [...p.tags] : [];
    const i = tags.indexOf("following");
    if (i >= 0) tags.splice(i, 1); else tags.push("following");
    await api.people.upsert({ ...p, tags });
    await reload();
  }

  async function openPerson(p) {
    setSelected(p);
    const [r, cp, act] = await Promise.all([
      api.people.repos(p.id),
      api.cp.stats(p.id),
      api.activity.feed ? api.activity.feed({ personId: p.id, limit: 40 }).catch(() => []) : [],
    ]);
    setRepos(r);
    setCpStats(cp);
    setPersonActivity(act);
  }

  async function syncOneGh(id) {
    setStatus(null);
    try {
      const res = await api.people.sync(id);
      setStatus(res.ok ? { msg: `Synced ${res.count} repos` } : { err: res.error || res.code });
      reload();
      if (selected?.id === id) setRepos(await api.people.repos(id));
    } catch (e) { setStatus({ err: e.message }); }
  }
  async function syncOneCp(id) {
    setStatus(null);
    const res = await api.cp.fetchPerson(id);
    setStatus(res.ok ? { msg: "CP refreshed" } : { err: res.error || "CP refresh failed" });
    if (selected?.id === id) setCpStats(await api.cp.stats(id));
    reload();
  }
  async function syncAllGh() {
    setGhSync({ active: true, total: 0, done: 0, current: null, rateLimited: false, resetAt: null });
    const res = await api.people.syncAll();
    setGhSync((s) => ({ ...s, active: false }));
    setStatus({ msg: `GitHub sync: ${res.filter((r) => r.ok).length} / ${res.length} ok` });
    reload();
  }
  async function syncAllCp() {
    setCpSync({ active: true, total: 0, done: 0, ok: 0, err: 0, current: null });
    const res = await api.cp.fetchAll();
    setCpSync((s) => ({ ...s, active: false }));
    setStatus({ msg: `CP sync: ${res.okCount} / ${res.total} ok` });
    reload();
  }

  // Tags available + source options derived from loaded people.
  const tagOptions = useMemo(() => {
    const s = new Set();
    people.forEach((p) => (p.tags || []).forEach((t) => s.add(t)));
    return [...s].sort();
  }, [people]);
  const sourceOptions = useMemo(() => {
    const s = new Set();
    people.forEach((p) => p.source && s.add(p.source));
    return [...s].sort();
  }, [people]);

  // Client-side filtering (only + source pill)
  const filtered = useMemo(() => {
    let out = people;
    if (filter.source) out = out.filter((p) => p.source === filter.source);
    if (filter.only === "gh") out = out.filter((p) => p.github_username);
    else if (filter.only === "cp") out = out.filter((p) => p.leetcode_username || p.codeforces_username || p.codechef_username);
    else if (filter.only === "unsynced") out = out.filter((p) => !p.last_scraped_at);
    else if (filter.only === "following")
      out = out.filter((p) => Array.isArray(p.tags) && p.tags.includes("following"));

    // Sort. "activity" uses heat-strip totals (recent commits across the
    // 14d window); falls back to last_scraped_at then name.
    const sorted = [...out];
    if (sortBy === "name") {
      sorted.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    } else if (sortBy === "activity") {
      const score = (p) => {
        const h = heatStrips[p.id] || [];
        return h.reduce((s, r) => s + (r.n || 0), 0);
      };
      sorted.sort((a, b) => {
        const d = score(b) - score(a);
        if (d) return d;
        return (b.last_scraped_at || "").localeCompare(a.last_scraped_at || "");
      });
    }
    // 'stars' / 'cp' need per-person joins which the listing endpoint doesn't
    // provide; fall back to name when the data isn't there.
    return sorted;
  }, [people, filter.source, filter.only, sortBy, heatStrips]);

  // Group-by builder
  const groups = useMemo(() => {
    if (groupBy === "none") return [{ key: "All", rows: filtered }];
    const map = new Map();
    const push = (k, p) => { if (!map.has(k)) map.set(k, []); map.get(k).push(p); };
    for (const p of filtered) {
      if (groupBy === "source") push(p.source || "—", p);
      else if (groupBy === "tag") {
        if (!p.tags?.length) push("—", p);
        else p.tags.forEach((t) => push(t, p));
      } else if (groupBy === "syncstate") push(p.last_scraped_at ? "synced" : "never", p);
    }
    return [...map.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, rows]) => ({ key, rows }));
  }, [filtered, groupBy]);

  // Pagination — flat across groups (simple approach: limit to page * PAGE_SIZE)
  const paged = useMemo(() => {
    const limit = page * PAGE_SIZE;
    let n = 0;
    return groups.map((g) => {
      if (n >= limit) return { ...g, rows: [] };
      const take = Math.min(g.rows.length, limit - n);
      n += take;
      return { ...g, rows: g.rows.slice(0, take) };
    }).filter((g) => g.rows.length > 0);
  }, [groups, page]);
  const totalRows = filtered.length;
  const shownRows = paged.reduce((s, g) => s + g.rows.length, 0);

  return (
    <>
      <div className="row between" style={{ marginBottom: 18 }}>
        <div>
          <h1 className="page-title">People</h1>
          <p className="page-sub">Classmates, friends, and their projects. GitHub + LeetCode/CF/CC. Click a person to see repos, activity, and AI-generated project overviews.</p>
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <button onClick={() => setShowImport(true)}>+ Import from links</button>
          <button onClick={() => setShowAdd(true)}>+ Add person</button>
          <button onClick={syncAllGh} disabled={ghSync.active}>{ghSync.active ? "Syncing GH…" : "Sync GitHub"}</button>
          <button className="primary" onClick={syncAllCp} disabled={cpSync.active}>{cpSync.active ? "Syncing CP…" : "Sync CP"}</button>
          <SrmLeaderboardButton onSynced={reload} />
        </div>
      </div>

      {ghSync.active && <SyncBar label="GitHub" {...ghSync} />}
      {ghSync.rateLimited && (
        <div className="card rose" style={{ margin: "6px 0" }}>
          GitHub rate-limited. Resets {ghSync.resetAt ? "at " + new Date(ghSync.resetAt).toLocaleTimeString() : "soon"}. Add a token in Settings → GitHub.
        </div>
      )}
      {cpSync.active && <SyncBar label="Competitive programming" {...cpSync} />}

      {/* Search + grouping controls — collapsed into two clean rows.
          Row 1: search + quick chips. Row 2: tag/source/sort/group +
          leaderboard. Reduces visual clutter from the old 9-control row. */}
      <div
        className="page-people-controls"
        style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            placeholder="Search name, GitHub, LeetCode…"
            value={filter.q}
            onChange={(e) => setFilter({ ...filter, q: e.target.value })}
            style={{ flex: 1, minWidth: 220, maxWidth: 380 }}
          />
          <div className="chip-row" style={{ flex: 1, justifyContent: "flex-start" }}>
            <button className={"chip" + (filter.only === "" ? " active" : "")} onClick={() => setFilter({ ...filter, only: "" })}>
              All · {people.length}
            </button>
            <button className={"chip" + (filter.only === "following" ? " active" : "")} onClick={() => setFilter({ ...filter, only: "following" })}>
              ★ Following · {people.filter((p) => Array.isArray(p.tags) && p.tags.includes("following")).length}
            </button>
            <button className={"chip" + (filter.only === "gh" ? " active" : "")} onClick={() => setFilter({ ...filter, only: "gh" })}>
              GitHub
            </button>
            <button className={"chip" + (filter.only === "cp" ? " active" : "")} onClick={() => setFilter({ ...filter, only: "cp" })}>
              CP
            </button>
            <button className={"chip" + (filter.only === "unsynced" ? " active" : "")} onClick={() => setFilter({ ...filter, only: "unsynced" })}>
              Unsynced
            </button>
          </div>
          <button className="ghost" onClick={() => setShowLeaderboard(true)} title="Open leaderboard">
            🏆 Leaderboard
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <small className="muted" style={{ minWidth: 38 }}>Filter</small>
          <select value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })} style={{ minWidth: 140 }}>
            <option value="">All tags</option>
            {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value })} style={{ minWidth: 140 }}>
            <option value="">All sources</option>
            {sourceOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="muted" style={{ width: 1, height: 18, background: "var(--border)" }} />
          <small className="muted" style={{ minWidth: 30 }}>Sort</small>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ minWidth: 160 }}>
            <option value="activity">Recent activity</option>
            <option value="name">Name</option>
          </select>
          <small className="muted" style={{ minWidth: 38 }}>Group</small>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ minWidth: 140 }}>
            <option value="none">None</option>
            <option value="source">Source</option>
            <option value="tag">Tag</option>
            <option value="syncstate">Sync state</option>
          </select>
          {status?.msg && <small className="muted" style={{ marginLeft: "auto" }}>{status.msg}</small>}
          {status?.err && <small className="error" style={{ marginLeft: "auto" }}>{status.err}</small>}
        </div>
      </div>

      {/* Recent activity feed — its own section */}
      <section className="people-section">
        <div className="people-section-head">
          <h3>Recent activity</h3>
          <span className="count-pill" title="Across everyone you follow">live feed</span>
        </div>
        <ActivityFeed
          onOpenPerson={openPerson}
          onOpenRepo={(r) =>
            setOpenRepo({
              repo: {
                id: r.id,
                name: r.name,
                full_name: r.full_name,
                description: r.description,
                url: r.url,
                language: r.language,
                languages: r.languages,
                topics: r.topics,
                stars: r.stars,
                forks: r.forks,
                pushed_at: r.pushed_at,
                person_id: r.person_id,
              },
              person: {
                id: r.person_id,
                name: r.person_name,
                github_username: r.github_username,
                avatar_url: r.avatar_url,
                tags: r.person_tags,
              },
            })
          }
        />
      </section>

      {/* Everyone — grouped grid */}
      <section className="people-section">
        <div className="people-section-head">
          <h3>Everyone</h3>
          <span className="count-pill">{shownRows} {shownRows === 1 ? "person" : "people"}</span>
        </div>
        {paged.map((g) => (
        <section key={g.key} style={{ marginBottom: 16 }}>
          {groupBy !== "none" && (
            <div className="section-label row between">
              <span>{g.key}</span>
              <small className="muted">{g.rows.length}</small>
            </div>
          )}
          <div className="people-grid">
            {g.rows.map((p) => (
              <PersonCard
                key={p.id}
                p={p}
                heat={heatStrips[p.id] || []}
                following={Array.isArray(p.tags) && p.tags.includes("following")}
                onOpen={() => openPerson(p)}
                onToggleFollow={() => toggleFollow(p)}
                onRetryGh={() => syncOneGh(p.id)}
                onRetryCp={() => syncOneCp(p.id)}
              />
            ))}
          </div>
        </section>
        ))}
        {filtered.length === 0 && (
          <div className="muted" style={{ padding: "20px 8px", textAlign: "center" }}>
            No people match. Try clearing filters or import from a link.
          </div>
        )}

        {/* Pager */}
        {shownRows < totalRows && (
          <div className="pager row" style={{ justifyContent: "center", marginTop: 8 }}>
            <small className="muted">{shownRows} / {totalRows}</small>
            <button className="primary" onClick={() => setPage((p) => p + 1)}>Show more</button>
          </div>
        )}
      </section>


      {selected && (
        <PersonModal
          person={selected}
          repos={repos}
          cpStats={cpStats}
          activity={personActivity}
          onClose={() => { setSelected(null); setRepos([]); setCpStats([]); setPersonActivity([]); }}
          onSyncGh={() => syncOneGh(selected.id)}
          onSyncCp={() => syncOneCp(selected.id)}
          onDelete={async () => { await api.people.delete(selected.id); setSelected(null); reload(); }}
          onChanged={reload}
          onOpenRepo={(r) => setOpenRepo({ repo: r, person: selected })}
        />
      )}
      {openRepo && (
        <RepoDetailModal
          repo={openRepo.repo}
          person={openRepo.person}
          onClose={() => setOpenRepo(null)}
        />
      )}
      {showAdd && <AddPersonModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); reload(); }} />}
      {showImport && <ImportByLinkModal onClose={() => setShowImport(false)} onImported={() => { setShowImport(false); reload(); }} />}
      {showLeaderboard && <LeaderboardModal onClose={() => setShowLeaderboard(false)} />}
    </>
  );
}

function SyncBar({ label, total, done, ok, err, current, rateLimited }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div className="row between">
        <strong>{label} sync</strong>
        <small className="muted">{done} / {total} {ok != null ? `· ${ok} ok · ${err} err` : ""}</small>
      </div>
      <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <small className="muted">{rateLimited ? "rate-limited; stopped" : current ? `current: ${current}` : "…"}</small>
    </div>
  );
}

// One-click button that scrapes the SRM CP leaderboard
// (https://lead.aakarsh.xyz/leaderboard/master) and imports / updates
// people. Pulls name + reg + LeetCode handle + section.
function SrmLeaderboardButton({ onSynced }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    api.cp.srmLeaderboardLastSync?.().then((r) => setLast(r)).catch(() => {});
  }, []);

  async function run() {
    setBusy(true);
    setMsg("Fetching SRM leaderboard…");
    try {
      const r = await api.cp.syncSrmLeaderboard();
      if (!r?.ok) {
        setMsg("Failed: " + (r?.error || "unknown"));
      } else {
        setMsg(`Imported ${r.imported}, updated ${r.updated} of ${r.total}.`);
        setLast({ at: r.fetchedAt, ...r });
        onSynced?.();
      }
    } catch (e) {
      setMsg("Error: " + e.message);
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 4000);
    }
  }

  return (
    <button
      className="ghost"
      onClick={run}
      disabled={busy}
      title={
        last
          ? `Last sync: ${new Date(last.at).toLocaleString()} · ${last.imported || 0} new, ${last.updated || 0} updated`
          : "Pull classmates from lead.aakarsh.xyz/leaderboard/master"
      }
    >
      {busy ? "Syncing leaderboard…" : msg || "Sync SRM leaderboard"}
    </button>
  );
}

function PersonCard({ p, heat, following, onOpen, onToggleFollow, onRetryGh, onRetryCp }) {
  const liHandle = !p.github_username ? linkedinHandle(p.linkedin_url) : null;
  const hasCp = !!(p.leetcode_username || p.codeforces_username || p.codechef_username);
  const hasAnyLink = !!(p.github_username || liHandle || p.linkedin_url || hasCp);

  return (
    <div
      className={
        "card person-card" +
        (!p.github_username && liHandle ? " li-only" : "") +
        (following ? " following" : "")
      }
      style={{ cursor: "pointer", position: "relative" }}
      onClick={onOpen}
    >
      <button
        type="button"
        className={"person-follow" + (following ? " on" : "")}
        onClick={(e) => { e.stopPropagation(); onToggleFollow?.(); }}
        title={following ? "Unfollow" : "Follow this person"}
        aria-label={following ? "Unfollow" : "Follow"}
      >
        {following ? "★" : "☆"}
      </button>
      {p.avatar_url ? <img className="avatar" src={p.avatar_url} alt="" /> : (
        <div className="avatar avatar-fallback">{(p.name || "?").slice(0, 1).toUpperCase()}</div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="name">{p.name}</div>

        {/* Primary handle: GitHub first, else LinkedIn */}
        {p.github_username ? (
          <div className="handle">
            <span className="handle-icon" aria-hidden>⌥</span>@{p.github_username}
          </div>
        ) : liHandle ? (
          <div className="handle li">
            <span className="handle-icon" aria-hidden>in</span>/{liHandle}
          </div>
        ) : (
          <div className="handle muted">no linked profile</div>
        )}

        {p.bio && (
          <div
            className="muted person-bio"
            style={{ fontSize: 12, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {p.bio}
          </div>
        )}

        {hasCp && (
          <div className="tags" style={{ marginTop: 6 }}>
            {p.leetcode_username   && <span className="pill gray">LC: {p.leetcode_username}</span>}
            {p.codeforces_username && <span className="pill gray">CF: {p.codeforces_username}</span>}
            {p.codechef_username   && <span className="pill gray">CC: {p.codechef_username}</span>}
          </div>
        )}

        <small className="muted" style={{ display: "block", marginTop: 6 }}>
          {p.github_username
            ? (p.last_scraped_at ? `synced ${new Date(p.last_scraped_at + "Z").toLocaleDateString()}` : "never synced")
            : liHandle
              ? "LinkedIn profile"
              : hasAnyLink ? "" : "no GitHub / LinkedIn"}
        </small>
        {/* 14-day commit pulse from activity_feed. Cells get progressively
            brighter for higher push counts; empty days are muted. */}
        {p.github_username && (
          <PersonHeatStrip days={14} heat={heat} />
        )}
      </div>
      <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 4 }}>
        {p.github_username && <button className="ghost small" title="Retry GitHub" onClick={(e) => { e.stopPropagation(); onRetryGh(); }}>↻ GH</button>}
        {!p.github_username && p.linkedin_url && (
          <button
            className="ghost small"
            title="Open LinkedIn"
            onClick={(e) => { e.stopPropagation(); api.ext.open(p.linkedin_url); }}
          >
            ↗ LinkedIn
          </button>
        )}
        {hasCp && (
          <button className="ghost small" title="Retry CP" onClick={(e) => { e.stopPropagation(); onRetryCp(); }}>↻ CP</button>
        )}
      </div>
    </div>
  );
}

// Tiny calendar of recent commits — 14 cells, one per day, brightness
// scales with that day's push count. Empty days are dimmed; today is on
// the right.
function PersonHeatStrip({ days = 14, heat = [] }) {
  // Build map { 'YYYY-MM-DD' → count } and walk the last `days` days.
  const map = new Map();
  let max = 0;
  for (const r of heat || []) {
    map.set(r.date, r.n || 0);
    if ((r.n || 0) > max) max = r.n || 0;
  }
  const cells = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const n = map.get(iso) || 0;
    cells.push({ iso, n });
  }
  return (
    <div className="person-heat" title={`${heat.reduce((s, r) => s + (r.n || 0), 0)} commits in ${days}d`}>
      {cells.map((c) => {
        const intensity = max > 0 ? Math.min(1, c.n / Math.max(3, max)) : 0;
        return (
          <span
            key={c.iso}
            className={"person-heat-cell" + (c.n > 0 ? " hot" : "")}
            style={c.n > 0 ? { opacity: 0.35 + intensity * 0.65 } : null}
            title={`${c.iso} · ${c.n} commit${c.n === 1 ? "" : "s"}`}
          />
        );
      })}
    </div>
  );
}

// Extract a LinkedIn vanity handle from a linkedin_url. Handles the common
// shapes: https://linkedin.com/in/<handle>/, https://www.linkedin.com/in/<h>,
// linkedin.com/in/<h>, with or without trailing slashes or query strings.
function linkedinHandle(url) {
  if (!url) return null;
  const m = String(url).match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).replace(/\/+$/, "") : null;
}

function PersonModal({ person, repos, cpStats, activity, onClose, onSyncGh, onSyncCp, onDelete, onChanged, onOpenRepo }) {
  const [editMode, setEditMode] = useState(false);
  const [repoQ, setRepoQ] = useState("");
  const [repoLang, setRepoLang] = useState("");
  const [repoSort, setRepoSort] = useState("pushed");

  const hasGh = !!person.github_username;
  const hasCpHandles = !!(person.leetcode_username || person.codeforces_username || person.codechef_username);

  const languages = useMemo(() => {
    const s = new Set();
    repos.forEach((r) => r.language && s.add(r.language));
    return [...s].sort();
  }, [repos]);

  const filteredRepos = useMemo(() => {
    let out = repos;
    if (repoQ.trim()) {
      const n = repoQ.toLowerCase();
      out = out.filter((r) => r.name?.toLowerCase().includes(n) || r.description?.toLowerCase().includes(n));
    }
    if (repoLang) out = out.filter((r) => r.language === repoLang);
    if (repoSort === "pushed") out = [...out].sort((a, b) => (b.pushed_at || "").localeCompare(a.pushed_at || ""));
    else if (repoSort === "stars") out = [...out].sort((a, b) => (b.stars || 0) - (a.stars || 0));
    else if (repoSort === "name") out = [...out].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return out;
  }, [repos, repoQ, repoLang, repoSort]);

  const recent = useMemo(() => {
    return (activity || []).slice(0, 8);
  }, [activity]);

  const shortLinkedin = (url) => {
    if (!url) return "";
    try {
      const u = new URL(url);
      return `${u.hostname.replace(/^www\./, "")}${u.pathname}`.replace(/\/$/, "");
    } catch {
      return url;
    }
  };

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide person-modal" style={{ width: 900 }}>
        {/* Header: identity + actions in one row */}
        <div className="person-modal-head">
          <div className="person-modal-ident">
            <h3 style={{ margin: 0 }}>{person.name}</h3>
            <div className="person-modal-links">
              {hasGh && (
                <a href="#" onClick={(e) => { e.preventDefault(); api.ext.open(`https://github.com/${person.github_username}`); }}>
                  github.com/{person.github_username}
                </a>
              )}
              {person.linkedin_url && (
                <a href="#" onClick={(e) => { e.preventDefault(); api.ext.open(person.linkedin_url); }}>
                  {shortLinkedin(person.linkedin_url)}
                </a>
              )}
            </div>
            {(person.tags || []).length > 0 && (
              <div className="tags" style={{ marginTop: 8 }}>
                {(person.tags || []).map((t) => <span key={t} className="pill">{t}</span>)}
              </div>
            )}
          </div>
          <div className="person-modal-actions">
            {hasGh && <button className="small primary" onClick={onSyncGh} title="Fetch repos from GitHub">Sync GitHub</button>}
            {hasCpHandles && <button className="small" onClick={onSyncCp} title="Refresh CP stats">Sync CP</button>}
            <button className="small ghost" onClick={() => setEditMode((v) => !v)}>{editMode ? "Cancel" : "Edit handles"}</button>
            <button className="small ghost danger" onClick={onDelete} title="Remove this person">Delete</button>
            <button onClick={onClose} className="ghost icon-btn" aria-label="Close">✕</button>
          </div>
        </div>

        {editMode && <HandleEdit person={person} onSaved={() => { setEditMode(false); onChanged(); }} />}

        {/* Recent activity for this person */}
        {recent.length > 0 && (
          <>
            <div className="section-label">Recently worked on</div>
            <div className="card" style={{ padding: 10 }}>
              {recent.map((e, i) => (
                <div key={i} className="row between" style={{ margin: "4px 0", fontSize: 13 }}>
                  <span>
                    <span className="pill gray">{e.kind || "push"}</span>{" "}
                    <a href="#" onClick={(evt) => { evt.preventDefault(); api.ext.open(e.url); }}>
                      {e.repo_name || e.summary}
                    </a>
                    {e.summary && e.summary !== e.repo_name && <span className="muted"> · {e.summary}</span>}
                  </span>
                  <small className="muted">{e.at ? new Date(e.at).toLocaleString() : ""}</small>
                </div>
              ))}
            </div>
          </>
        )}

        {/* CP stats — only show when handles are set OR we already have stats */}
        {(hasCpHandles || cpStats.length > 0) && (
          <>
            <div className="section-label" style={{ marginTop: 12 }}>Competitive programming</div>
            {cpStats.length === 0 ? (
              <div className="muted small" style={{ padding: "4px 0" }}>No stats yet — hit Sync CP to fetch.</div>
            ) : (
              cpStats.map((cp) => <CpStatCard key={cp.id} cp={cp} />)
            )}
          </>
        )}

        {/* Repos — only show when GH is connected OR we already have repos */}
        {(hasGh || repos.length > 0) && (
          <>
            <div className="row between" style={{ marginTop: 14 }}>
              <div className="section-label" style={{ margin: 0 }}>Repos ({repos.length})</div>
              {repos.length > 0 && (
                <div className="row" style={{ gap: 6 }}>
                  <input placeholder="filter repos…" value={repoQ} onChange={(e) => setRepoQ(e.target.value)} style={{ maxWidth: 180 }} />
                  <select value={repoLang} onChange={(e) => setRepoLang(e.target.value)} style={{ maxWidth: 130 }}>
                    <option value="">All langs</option>
                    {languages.map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                  <select value={repoSort} onChange={(e) => setRepoSort(e.target.value)} style={{ maxWidth: 140 }}>
                    <option value="pushed">Recently pushed</option>
                    <option value="stars">Most stars</option>
                    <option value="name">Name (A-Z)</option>
                  </select>
                </div>
              )}
            </div>
            {repos.length === 0 && (
              <div className="muted small" style={{ padding: "4px 0" }}>No repos cached yet — hit Sync GitHub.</div>
            )}
            <div className="grid-auto">
              {filteredRepos.map((r) => (
                <div key={r.id} className="repo-card" onClick={() => onOpenRepo(r)}>
                  <div className="repo-title row between">
                    <strong>{r.name}</strong>
                    <small className="muted">★ {r.stars ?? 0}</small>
                  </div>
                  {r.description && <div className="repo-desc">{r.description}</div>}
                  <div className="chip-row" style={{ marginTop: 6 }}>
                    {r.language && <span className="chip">{r.language}</span>}
                    {(r.topics || []).slice(0, 3).map((t) => <span key={t} className="chip">{t}</span>)}
                  </div>
                  <div className="repo-meta" style={{ marginTop: 6 }}>
                    ⑂ {r.forks ?? 0} · pushed {r.pushed_at ? new Date(r.pushed_at).toLocaleDateString() : "—"}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* When neither GH nor CP is set, offer a hint instead of an empty modal */}
        {!hasGh && !hasCpHandles && cpStats.length === 0 && repos.length === 0 && (
          <div className="card" style={{ marginTop: 12, textAlign: "center", padding: 16 }}>
            <div className="muted" style={{ marginBottom: 6 }}>
              No GitHub or CP handles linked yet for this profile.
            </div>
            <button className="small primary" onClick={() => setEditMode(true)}>Add handles</button>
          </div>
        )}
      </div>
    </div>
  );
}

function CpStatCard({ cp }) {
  const s = typeof cp.stats === "string" ? safeJson(cp.stats) : (cp.stats || {});
  const hasError = !!cp.error;
  return (
    <div className="card" style={{ marginTop: 6 }}>
      <div className="row between">
        <strong>{cp.platform}</strong>
        <small className="muted">
          {cp.handle ? `@${cp.handle}` : "no handle"}
          {cp.fetched_at && <> · {new Date(cp.fetched_at + "Z").toLocaleString()}</>}
        </small>
      </div>
      {hasError ? (
        <div className="error" style={{ marginTop: 4 }}>error: {cp.error}</div>
      ) : (
        <div className="sub" style={{ marginTop: 4 }}>
          {s.rating != null && <>rating <strong>{s.rating}</strong>{s.maxRating ? ` (max ${s.maxRating})` : ""} · </>}
          {s.totalSolved != null && <>solved <strong>{s.totalSolved}</strong>{s.easy != null ? ` (${s.easy}E/${s.medium}M/${s.hard}H)` : ""} · </>}
          {s.stars != null && <>stars {s.stars}★ · </>}
          {s.contests != null && <>contests {s.contests} · </>}
          {s.rank && <>rank {s.rank}</>}
        </div>
      )}
    </div>
  );
}
function safeJson(v) { try { return JSON.parse(v); } catch { return {}; } }

function HandleEdit({ person, onSaved }) {
  const [form, setForm] = useState({
    leetcode_username: person.leetcode_username || "",
    codeforces_username: person.codeforces_username || "",
    codechef_username: person.codechef_username || "",
  });
  async function save() {
    await api.people.upsert({ ...person, ...form });
    onSaved();
  }
  return (
    <div className="card" style={{ background: "var(--bg-elev-2)", marginBottom: 8 }}>
      <div className="grid-2">
        <div className="form-row"><label>LeetCode username</label><input value={form.leetcode_username} onChange={(e) => setForm({ ...form, leetcode_username: e.target.value })} /></div>
        <div className="form-row"><label>Codeforces handle</label><input value={form.codeforces_username} onChange={(e) => setForm({ ...form, codeforces_username: e.target.value })} /></div>
      </div>
      <div className="form-row"><label>CodeChef handle</label><input value={form.codechef_username} onChange={(e) => setForm({ ...form, codechef_username: e.target.value })} /></div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="primary" onClick={save}>Save handles</button>
      </div>
    </div>
  );
}

function AddPersonModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    name: "", github_username: "", linkedin_url: "", tags: "",
    leetcode_username: "", codeforces_username: "", codechef_username: "",
  });
  async function save() {
    await api.people.upsert({
      name: form.name.trim(),
      github_username: form.github_username.trim() || null,
      linkedin_url: form.linkedin_url.trim() || null,
      leetcode_username: form.leetcode_username.trim() || null,
      codeforces_username: form.codeforces_username.trim() || null,
      codechef_username: form.codechef_username.trim() || null,
      source: "manual",
      tags: form.tags.split(",").map((s) => s.trim()).filter(Boolean),
    });
    onSaved();
  }
  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>Add person</h3>
        <div className="form-row"><label>Name</label><input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="form-row"><label>GitHub username</label><input value={form.github_username} onChange={(e) => setForm({ ...form, github_username: e.target.value })} /></div>
        <div className="form-row"><label>LinkedIn URL</label><input value={form.linkedin_url} onChange={(e) => setForm({ ...form, linkedin_url: e.target.value })} /></div>
        <div className="grid-2">
          <div className="form-row"><label>LeetCode</label><input value={form.leetcode_username} onChange={(e) => setForm({ ...form, leetcode_username: e.target.value })} /></div>
          <div className="form-row"><label>Codeforces</label><input value={form.codeforces_username} onChange={(e) => setForm({ ...form, codeforces_username: e.target.value })} /></div>
        </div>
        <div className="form-row"><label>CodeChef</label><input value={form.codechef_username} onChange={(e) => setForm({ ...form, codechef_username: e.target.value })} /></div>
        <div className="form-row"><label>Tags (comma-separated)</label><input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="e.g. classmate, lab:tesla, AI/ML" /></div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!form.name.trim()} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

// Single-flow link import. NextTechLab is no longer a separate tab — its
// labs sit alongside any other preset as `{label, url}` pairs. Users can
// add their own presets via the "+ Add preset" row (persisted to
// localStorage). Multi-URL bulk scrape (e.g. all 5 NTL labs at once) is a
// single chip that ships with the built-in presets.
function ImportByLinkModal({ onClose, onImported }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  // Combined results — both single-URL previews and multi-URL bulk runs end
  // up here as one flat candidate list, keyed `${source}:${i}`.
  const [results, setResults] = useState([]); // [{source, candidates}]
  const [picked, setPicked] = useState(new Set());
  const [err, setErr] = useState(null);

  // Custom presets from localStorage merged with the built-ins.
  const [userPresets, setUserPresets] = useState(loadUserLinkPresets());
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const allPresets = useMemo(
    () => [...BUILTIN_LINK_PRESETS, ...userPresets],
    [userPresets],
  );

  function addPreset() {
    const lbl = newLabel.trim();
    const u = newUrl.trim();
    if (!lbl || !u) return;
    const next = [...userPresets, { label: lbl, url: u }];
    setUserPresets(next);
    saveUserLinkPresets(next);
    setNewLabel(""); setNewUrl(""); setAdding(false);
  }
  function deletePreset(p) {
    if (!userPresets.find((x) => x.url === p.url && x.label === p.label)) return;
    const next = userPresets.filter((x) => !(x.url === p.url && x.label === p.label));
    setUserPresets(next);
    saveUserLinkPresets(next);
  }

  async function runPreview(targetUrl = url) {
    const u = (targetUrl || "").trim();
    if (!u) return;
    setErr(null); setLoading(true);
    try {
      const res = await api.import.preview(u);
      if (!res.ok) setErr(res.error || "Preview failed");
      else {
        setResults((prev) => [...prev, { source: res.source || u, candidates: res.candidates || [] }]);
        const start = results.reduce((s, r) => s + r.candidates.length, 0);
        const next = new Set(picked);
        (res.candidates || []).forEach((_, i) => next.add(`${start + i}`));
        setPicked(next);
      }
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }
  async function runNtl4Bulk() {
    setErr(null); setLoading(true);
    try {
      const res = await api.import.previewNtl4();
      const newResults = [];
      Object.entries(res || {}).forEach(([k, r]) => {
        if (r?.ok) newResults.push({ source: k, candidates: r.candidates || [] });
      });
      setResults((prev) => {
        const merged = [...prev, ...newResults];
        // Auto-select all newly added candidates.
        let cursor = prev.reduce((s, r) => s + r.candidates.length, 0);
        const next = new Set(picked);
        for (const r of newResults) {
          for (let i = 0; i < r.candidates.length; i++) next.add(`${cursor++}`);
        }
        setPicked(next);
        return merged;
      });
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  // Flat list of candidates with stable keys.
  const allRows = useMemo(() => {
    const rows = [];
    let i = 0;
    for (const r of results) {
      for (const c of r.candidates) {
        rows.push({ key: String(i), c, source: r.source });
        i++;
      }
    }
    return rows;
  }, [results]);

  async function commit() {
    const toImport = allRows
      .filter((r) => picked.has(r.key))
      .map((r) => ({ ...r.c, source: r.source }));
    if (toImport.length === 0) return;
    const res = await api.import.commit(toImport);
    if (res?.ok) onImported();
    else setErr(res?.error || "Import failed");
  }

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" style={{ width: 820 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }}>Import people from links</h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <p className="muted">
          Paste any URL (GitHub profile/org, LinkedIn, or any page that links
          to people). Apex extracts GitHub handles + LinkedIn URLs. Add your
          own preset URLs below for one-click runs later.
        </p>

        <div className="row" style={{ gap: 6 }}>
          <input
            autoFocus
            placeholder="https://github.com/octocat or any URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1 }}
            onKeyDown={(e) => { if (e.key === "Enter") runPreview(); }}
          />
          <button
            className="primary"
            onClick={() => runPreview()}
            disabled={loading || !url.trim()}
          >
            {loading ? "…" : "Preview"}
          </button>
        </div>

        {/* Preset chips — built-ins + user presets, with the bulk-scrape
            shortcut and an "+ Add preset" row that mirrors normal link
            convention (title + URL). */}
        <div style={{ marginTop: 12 }}>
          <div className="section-label" style={{ marginBottom: 6 }}>
            Presets
          </div>
          <div className="chip-row">
            {allPresets.map((p) => {
              const isUser = userPresets.some((x) => x.url === p.url && x.label === p.label);
              return (
                <span key={p.url + ":" + p.label} style={{ position: "relative", display: "inline-flex" }}>
                  <button
                    className="chip"
                    onClick={() => { setUrl(p.url); runPreview(p.url); }}
                    title={p.url}
                  >
                    {p.label}
                  </button>
                  {isUser && (
                    <button
                      type="button"
                      className="ghost xsmall"
                      onClick={() => deletePreset(p)}
                      title="Remove preset"
                      style={{ marginLeft: 2 }}
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
            <button
              className="chip"
              onClick={runNtl4Bulk}
              disabled={loading}
              title="Scrape all 5 NextTechLab labs in one shot"
            >
              ⚡ All NTL labs
            </button>
            <button
              className="chip"
              onClick={() => setAdding((v) => !v)}
              title="Add your own preset"
            >
              {adding ? "Cancel" : "+ Add preset"}
            </button>
          </div>
          {adding && (
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              <input
                placeholder="Title (e.g. My class GitHub list)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                style={{ flex: 1, minWidth: 200 }}
              />
              <input
                placeholder="https://…"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                style={{ flex: 1, minWidth: 240 }}
                onKeyDown={(e) => { if (e.key === "Enter") addPreset(); }}
              />
              <button
                className="primary small"
                onClick={addPreset}
                disabled={!newLabel.trim() || !newUrl.trim()}
              >
                Save preset
              </button>
            </div>
          )}
        </div>

        {err && <div className="error" style={{ marginTop: 10 }}>{err}</div>}

        {/* Candidate checklist */}
        {allRows.length > 0 && (
          <>
            <hr className="soft" />
            <div className="row between">
              <small className="muted">{allRows.length} candidates · {picked.size} selected</small>
              <div className="row" style={{ gap: 6 }}>
                <button className="ghost small" onClick={() => setPicked(new Set(allRows.map((r) => r.key)))}>Select all</button>
                <button className="ghost small" onClick={() => setPicked(new Set())}>Clear</button>
              </div>
            </div>
            <div style={{ maxHeight: 360, overflowY: "auto", marginTop: 8 }}>
              {allRows.map(({ key, c, source }) => (
                <label key={key} className="todo-row" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={picked.has(key)} onChange={(e) => {
                    const n = new Set(picked);
                    if (e.target.checked) n.add(key); else n.delete(key);
                    setPicked(n);
                  }} />
                  <div>
                    <div className="title">{c.name || c.github_username || c.linkedin_url}</div>
                    <div className="sub">
                      {source && <span className="pill gray">{source}</span>}{" "}
                      {c.github_username && <>@{c.github_username}</>}
                      {c.linkedin_url && <> · linkedin</>}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="row" style={{ justifyContent: "flex-end", marginTop: 14, gap: 6 }}>
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={commit} disabled={picked.size === 0}>Import {picked.size}</button>
        </div>
      </div>
    </div>
  );
}

// Combined leaderboard: single card listing all three platforms side-by-side,
// with weekly deltas and streaks where available. Replaces the three separate
// modals.
function LeaderboardModal({ onClose }) {
  const [data, setData] = useState({ leetcode: null, codeforces: null, codechef: null });
  const [sort, setSort] = useState("leetcode"); // which platform drives ranking
  const [loading, setLoading] = useState(true);
  // CP summaries — keyed per person_id. Each entry is the result of
  // api.cp.summarize for that person, plus a loading flag.
  const [summaries, setSummaries] = useState({});
  const [summariseLoading, setSummariseLoading] = useState(new Set());

  async function summarisePerson(personId, name) {
    setSummariseLoading((prev) => new Set(prev).add(personId));
    try {
      const res = await api.cp.summarize({ personId });
      setSummaries((prev) => ({ ...prev, [personId]: res || { ok: false } }));
    } catch (e) {
      setSummaries((prev) => ({
        ...prev,
        [personId]: { ok: false, error: e?.message || "Failed" },
      }));
    } finally {
      setSummariseLoading((prev) => {
        const s = new Set(prev);
        s.delete(personId);
        return s;
      });
    }
  }

  useEffect(() => {
    (async () => {
      const [lc, cf, cc] = await Promise.all([
        api.cp.leaderboard("leetcode"),
        api.cp.leaderboard("codeforces"),
        api.cp.leaderboard("codechef"),
      ]);
      setData({ leetcode: lc, codeforces: cf, codechef: cc });
      setLoading(false);
    })();
  }, []);

  const rows = useMemo(() => {
    // Merge: map person_id → row with all platforms
    const map = new Map();
    for (const [plat, list] of Object.entries(data)) {
      for (const r of list || []) {
        const cur = map.get(r.person_id) || { person_id: r.person_id, person_name: r.person_name, avatar_url: r.avatar_url };
        cur[plat] = r;
        map.set(r.person_id, cur);
      }
    }
    const all = [...map.values()];
    all.sort((a, b) => {
      const av = metric(a[sort], sort) ?? -1;
      const bv = metric(b[sort], sort) ?? -1;
      return bv - av;
    });
    return all;
  }, [data, sort]);

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" style={{ width: 820 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }}>Leaderboard · LC / CF / CC</h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="chip-row" style={{ marginTop: 8 }}>
          <small className="muted">Rank by</small>
          {["leetcode", "codeforces", "codechef"].map((p) => (
            <button key={p} className={"chip" + (sort === p ? " active" : "")} onClick={() => setSort(p)}>
              {p === "leetcode" ? "LC solved" : p === "codeforces" ? "CF rating" : "CC rating"}
            </button>
          ))}
        </div>

        {loading && <div className="muted" style={{ padding: 12 }}>Loading…</div>}
        {!loading && rows.length === 0 && <div className="muted" style={{ padding: 12 }}>No data. Add CP handles in People and sync.</div>}

        {rows.map((r, i) => {
          const sumLoading = summariseLoading.has(r.person_id);
          const summary = summaries[r.person_id];
          return (
            <div key={r.person_id} className="cp-leaderboard-row">
              <div className="cp-leaderboard-head">
                <span className="pill">{i + 1}</span>
                {r.avatar_url ? (
                  <img
                    className="avatar"
                    src={r.avatar_url}
                    alt=""
                    style={{ width: 32, height: 32 }}
                  />
                ) : (
                  <div className="avatar" style={{ width: 32, height: 32 }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="title">{r.person_name}</div>
                  <div
                    className="sub muted row"
                    style={{ gap: 10, flexWrap: "wrap" }}
                  >
                    <span>LC: {statCell(r.leetcode, "leetcode")}</span>
                    <span>CF: {statCell(r.codeforces, "codeforces")}</span>
                    <span>CC: {statCell(r.codechef, "codechef")}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => summarisePerson(r.person_id, r.person_name)}
                  disabled={sumLoading}
                  title="Ollama summary of recent topics + strengths"
                >
                  {sumLoading
                    ? "…"
                    : summary?.ok
                      ? "↻ Re-summarise"
                      : "✨ Summarise"}
                </button>
              </div>
              {summary && summary.ok && (
                <div className="cp-summary-block">
                  {summary.summary && (
                    <p className="cp-summary-text">{summary.summary}</p>
                  )}
                  {Array.isArray(summary.topics) && summary.topics.length > 0 && (
                    <div className="cp-summary-row">
                      <small className="muted cp-summary-label">Topics</small>
                      <div className="chip-row">
                        {summary.topics.slice(0, 6).map((t, k) => (
                          <span key={k} className="pill">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {Array.isArray(summary.strengths) && summary.strengths.length > 0 && (
                    <div className="cp-summary-row">
                      <small className="muted cp-summary-label">Strong in</small>
                      <div className="chip-row">
                        {summary.strengths.slice(0, 4).map((s, k) => (
                          <span key={k} className="pill teal">{s}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {summary && !summary.ok && summary.error && (
                <div className="error" style={{ fontSize: 12, marginTop: 6 }}>
                  Couldn't summarise: {summary.error}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function metric(r, plat) {
  if (!r || !r.stats) return null;
  if (plat === "leetcode")   return r.stats.totalSolved ?? null;
  if (plat === "codeforces") return r.stats.rating      ?? null;
  if (plat === "codechef")   return r.stats.rating      ?? null;
  return null;
}
function statCell(r, plat) {
  if (!r) return "—";
  if (r.error) return <span className="error">{r.error}</span>;
  const s = r.stats || {};
  if (plat === "leetcode") return s.totalSolved != null ? `${s.totalSolved} (${s.easy || 0}/${s.medium || 0}/${s.hard || 0})` : "—";
  if (plat === "codeforces") return s.rating != null ? `${s.rating}${s.maxRating ? ` (max ${s.maxRating})` : ""}` : "—";
  if (plat === "codechef") return s.rating != null ? `${s.rating}${s.stars ? ` · ${s.stars}★` : ""}` : "—";
  return "—";
}

// Full-fat repo detail modal with tech stack, README preview, Ollama summary,
// and cross-links to the owner's other similar repos.
function RepoDetailModal({ repo, person, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [aiSummary, setAiSummary] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiErr, setAiErr] = useState(null);
  const [model, setModel] = useState("");
  const [ollamaOk, setOllamaOk] = useState(false);
  const [models, setModels] = useState([]);
  const [tab, setTab] = useState("overview"); // overview | chat
  // Chat: history is { role: "user" | "assistant", content }, plus per-send
  // loading + an error slot. Lives only as long as the modal is open.
  const [chatHistory, setChatHistory] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatErr, setChatErr] = useState(null);

  async function sendChatQuestion(q) {
    const question = (q || "").trim();
    if (!question) return;
    setChatErr(null);
    const newHistory = [...chatHistory, { role: "user", content: question }];
    setChatHistory(newHistory);
    setChatInput("");
    setChatLoading(true);
    try {
      const res = await api.repo.chat({
        repoId: repo.id,
        fullName: repo.full_name,
        question,
        history: chatHistory, // send the prior history (without the new turn)
        model,
      });
      if (!res?.ok) {
        setChatErr(res?.error || "Chat failed.");
        // Roll back the user message so they can retry without dupes? Keep it
        // — the failure is informative.
      } else {
        setChatHistory((h) => [...h, { role: "assistant", content: res.reply || "(empty reply)" }]);
      }
    } catch (e) {
      setChatErr(e?.message || "Chat failed.");
    } finally {
      setChatLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [d, mResp, savedModel] = await Promise.all([
          api.repo.detail(repo.id),
          api.ollama.listModels().catch(() => ({ ok: false, models: [] })),
          api.settings.get("ollama.model"),
        ]);
        setDetail(d);
        setModels(mResp?.models || []);
        setOllamaOk(mResp?.ok ?? false);
        if (savedModel && (mResp?.models || []).includes(savedModel)) setModel(savedModel);
        else if (mResp?.models?.length) setModel(mResp.models[0]);
        // If we already have a cached summary, show it.
        // The IPC returns `{ ok, ...detail, cached, cachedModel }` where
        // `cached` is the previously-saved Ollama JSON payload.
        if (d?.cached) {
          setAiSummary(d.cached);
          if (d.cachedModel) setModel(d.cachedModel);
        }
      } finally { setLoading(false); }
    })();
  }, [repo.id]);

  async function runSummary() {
    setAiLoading(true); setAiErr(null); setAiSummary(null);
    const res = await api.repo.summarize({ repoId: repo.id, model });
    setAiLoading(false);
    if (!res?.ok) setAiErr(res?.error || "Ollama error");
    else setAiSummary(res);
  }

  const tech = useMemo(() => {
    if (!detail) return [];
    const langs = detail.languages || {};
    const total = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, pct: Math.round((v / total) * 100) }));
  }, [detail]);

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" style={{ width: 900 }}>
        <div className="row between">
          <div>
            <h3 style={{ margin: 0 }}>{repo.name}</h3>
            <small className="muted">
              by {person.name}
              {" · "}
              <a href="#" onClick={(e) => { e.preventDefault(); api.ext.open(repo.url); }}>{repo.url}</a>
            </small>
          </div>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>

        {repo.description && <p style={{ marginTop: 10 }}>{repo.description}</p>}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="pill">★ {repo.stars ?? 0}</span>
          <span className="pill">⑂ {repo.forks ?? 0}</span>
          {repo.language && <span className="pill">{repo.language}</span>}
          {(repo.topics || []).slice(0, 6).map((t) => <span key={t} className="pill gray">{t}</span>)}
          <span className="pill gray">pushed {repo.pushed_at ? new Date(repo.pushed_at).toLocaleDateString() : "—"}</span>
        </div>

        {/* Tab strip — overview vs. project chat. Chat has read-access to
            the same context the AI summary uses, so the user can ask
            grounded questions like "what does it actually do?" or
            "where is auth handled?". */}
        <div className="repo-modal-tabs" style={{ marginTop: 12 }}>
          <button
            type="button"
            className={"today-tab" + (tab === "overview" ? " active" : "")}
            onClick={() => setTab("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            className={"today-tab" + (tab === "chat" ? " active" : "")}
            onClick={() => setTab("chat")}
            title="Ask Ollama questions about this project"
          >
            Chat {chatHistory.length > 0 ? `· ${Math.ceil(chatHistory.length / 2)}` : ""}
          </button>
          <button
            type="button"
            className={"today-tab" + (tab === "walkthrough" ? " active" : "")}
            onClick={() => setTab("walkthrough")}
            title="AI walks you through the repo file by file"
          >
            Walkthrough
          </button>
          <button
            type="button"
            className={"today-tab" + (tab === "compare" ? " active" : "")}
            onClick={() => setTab("compare")}
            title="Compare this repo to your own projects"
          >
            Compare
          </button>
        </div>

        {tab === "walkthrough" ? (
          <RepoWalkthroughPanel
            repo={repo}
            ollamaOk={ollamaOk}
            model={model}
          />
        ) : tab === "compare" ? (
          <RepoComparePanel repo={repo} />
        ) : tab === "chat" ? (
          <RepoChatPanel
            repo={repo}
            history={chatHistory}
            input={chatInput}
            setInput={setChatInput}
            onSend={sendChatQuestion}
            loading={chatLoading}
            err={chatErr}
            ollamaOk={ollamaOk}
            model={model}
            models={models}
            onModelChange={setModel}
            onClear={() => { setChatHistory([]); setChatErr(null); }}
          />
        ) : (
          <>

        {loading && <div className="muted" style={{ marginTop: 14 }}>Loading detail…</div>}
        {detail && (
          <>
            {/* Tech stack bar */}
            {tech.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 14 }}>Tech stack</div>
                <div className="lang-bar" title={tech.map((t) => `${t.name} ${t.pct}%`).join(" · ")}>
                  {tech.map((t, i) => (
                    <div
                      key={t.name}
                      className={`lang-seg seg-${i % 6}`}
                      style={{ width: `${t.pct}%` }}
                      title={`${t.name} ${t.pct}%`}
                    >
                      <small>{t.name} {t.pct}%</small>
                    </div>
                  ))}
                </div>
                <div className="lang-legend">
                  {tech.map((t, i) => (
                    <span key={t.name} className={`lang-dot seg-${i % 6}`}>
                      <i />{t.name} <small className="muted">{t.pct}%</small>
                    </span>
                  ))}
                </div>
              </>
            )}

            {/* AI summary */}
            <div className="section-label" style={{ marginTop: 14 }}>Overview</div>
            <div className="card" style={{ background: "var(--bg-elev-2)" }}>
              {!aiSummary && !aiLoading && (
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <select value={model} onChange={(e) => setModel(e.target.value)} style={{ maxWidth: 160 }}>
                    {models.length === 0 && <option value="">(no models)</option>}
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <button className="primary small" onClick={runSummary} disabled={!ollamaOk || !model}>
                    Summarise
                  </button>
                </div>
              )}
              {aiLoading && <div className="muted">Thinking…</div>}
              {aiErr && <div className="error">{aiErr}</div>}
              {aiSummary && (
                <div className="ai-summary">
                  <div className="ai-summary-head">
                    <strong>Summary</strong>
                    <button
                      className="ghost small"
                      onClick={runSummary}
                      disabled={aiLoading || !ollamaOk}
                      title="Re-run Ollama summary"
                    >
                      ↻ Re-summarize
                    </button>
                  </div>
                  {/* Ollama returns: { oneliner, architecture, tech_stack[],
                      things_to_learn[], similar_mine[], starter_project } */}
                  {aiSummary.oneliner && (
                    <p className="ai-summary-lead">{aiSummary.oneliner}</p>
                  )}
                  {aiSummary.architecture && (
                    <div className="ai-summary-block">
                      <div className="section-label">Architecture</div>
                      <p className="ai-summary-text">{aiSummary.architecture}</p>
                    </div>
                  )}
                  {Array.isArray(aiSummary.tech_stack) && aiSummary.tech_stack.length > 0 && (
                    <div className="ai-summary-block">
                      <div className="section-label">Tech stack</div>
                      <div className="chip-row">
                        {aiSummary.tech_stack.map((t, i) => (
                          <span key={i} className="chip">{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {Array.isArray(aiSummary.things_to_learn) && aiSummary.things_to_learn.length > 0 && (
                    <div className="ai-summary-block">
                      <div className="section-label">Worth learning</div>
                      <ul className="ai-summary-list">
                        {aiSummary.things_to_learn.map((l, i) => <li key={i}>{l}</li>)}
                      </ul>
                    </div>
                  )}
                  {Array.isArray(aiSummary.similar_mine) && aiSummary.similar_mine.length > 0 && (
                    <div className="ai-summary-block">
                      <div className="section-label">Similar to things you've built</div>
                      <ul className="ai-summary-list">
                        {aiSummary.similar_mine.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                  {aiSummary.starter_project && (
                    <div className="ai-summary-block">
                      <div className="section-label">Starter project idea</div>
                      <p className="ai-summary-text">{aiSummary.starter_project}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* README preview */}
            {detail.readme && (
              <>
                <div className="section-label" style={{ marginTop: 14 }}>README</div>
                <div className="readme-md">
                  <MarkdownBlock text={detail.readme.slice(0, 8000) + (detail.readme.length > 8000 ? "\n\n_…truncated_" : "")} />
                </div>
              </>
            )}

            {/* Recent commits */}
            {Array.isArray(detail.recentCommits) && detail.recentCommits.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 14 }}>Recent commits</div>
                {detail.recentCommits.slice(0, 8).map((c, i) => (
                  <div key={i} className="sub" style={{ margin: "4px 0" }}>
                    <code>{c.sha?.slice(0, 7)}</code> {c.message?.split("\n")[0]}
                    <small className="muted"> · {c.at ? new Date(c.at).toLocaleDateString() : ""}</small>
                  </div>
                ))}
              </>
            )}
          </>
        )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── RepoChatPanel ───────────────────────────────────────────────────────
// The "Chat" tab inside RepoDetailModal. Lets the user ask the local LLM
// open-ended questions about a repo (architecture, where X is implemented,
// "how would I run this?", etc.). The backend assembles the same rich
// context summarizeRepo uses, so the model is grounded in real files.
function RepoChatPanel({
  repo,
  history,
  input,
  setInput,
  onSend,
  loading,
  err,
  ollamaOk,
  model,
  models,
  onModelChange,
  onClear,
}) {
  const scrollRef = React.useRef(null);
  React.useEffect(() => {
    // Stick to the bottom on new messages.
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history.length, loading]);

  const suggestionList = [
    "What does this project actually do?",
    "How would I run it locally?",
    "Walk me through the architecture",
    "What's the most interesting part of the code?",
    "How would I extend this for my own use?",
  ];

  return (
    <div className="repo-chat" style={{ marginTop: 12 }}>
      <div className="repo-chat-controls">
        <small className="muted">
          Asks Ollama with the README, file tree, manifests &amp; recent
          commits as context. All local.
        </small>
        <div className="row" style={{ gap: 6 }}>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={!ollamaOk || models.length === 0}
            style={{ maxWidth: 200 }}
          >
            {models.length === 0 && <option value="">(no models)</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {history.length > 0 && (
            <button className="ghost xsmall" onClick={onClear} title="Clear conversation">
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="repo-chat-stream" ref={scrollRef}>
        {history.length === 0 && (
          <div className="repo-chat-empty">
            <div className="muted" style={{ marginBottom: 8 }}>
              Start with one of these, or ask anything about{" "}
              <strong>{repo.name}</strong>:
            </div>
            <div className="repo-chat-suggestions">
              {suggestionList.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  className="ghost small"
                  onClick={() => onSend(s)}
                  disabled={loading || !ollamaOk}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {history.map((m, i) => (
          <div key={i} className={"repo-chat-msg role-" + m.role}>
            <div className="repo-chat-role">
              {m.role === "user" ? "You" : "Apex"}
            </div>
            <div className="repo-chat-bubble">
              <MarkdownBlock text={m.content} />
            </div>
          </div>
        ))}

        {loading && (
          <div className="repo-chat-msg role-assistant">
            <div className="repo-chat-role">Apex</div>
            <div className="repo-chat-bubble">
              <em className="muted">Reading the project &amp; thinking…</em>
            </div>
          </div>
        )}

        {err && (
          <div className="error" style={{ marginTop: 8 }}>
            {err}
          </div>
        )}
      </div>

      <form
        className="repo-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading && input.trim()) onSend(input);
        }}
      >
        <input
          value={input}
          placeholder={
            ollamaOk
              ? "Ask anything about this project…"
              : "Ollama is offline"
          }
          disabled={!ollamaOk || loading}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
        <button
          type="submit"
          className="primary"
          disabled={!ollamaOk || loading || !input.trim()}
          title="Send"
        >
          {loading ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

// ─── RepoWalkthroughPanel ────────────────────────────────────────────────
// Interactive guided tour of a repo. Sidebar shows the file tree (entry
// files highlighted), centre shows the current file's contents, right
// shows the AI's per-file explanation. "Next" advances to the AI's
// suggested next file, but you can click any file in the sidebar to jump.
function RepoWalkthroughPanel({ repo, ollamaOk, model }) {
  const [tree, setTree] = React.useState([]);
  const [currentPath, setCurrentPath] = React.useState(null);
  const [content, setContent] = React.useState("");
  const [explanation, setExplanation] = React.useState(null);
  const [visited, setVisited] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const [question, setQuestion] = React.useState("");
  const [qaHistory, setQaHistory] = React.useState([]);

  // Load tree on mount.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.repo.tree(repo.full_name);
        if (!cancelled && r?.ok) {
          setTree(r.paths || []);
          // Auto-suggest entry: README, then package.json, then src/index.*
          const paths = (r.paths || []).map((p) => p.path);
          const entryRegex = [
            /^README\.md$/i,
            /^package\.json$/,
            /^src\/index\.(js|ts|tsx|jsx)$/,
            /^src\/main\.(js|ts|py|go|rs)$/,
            /^index\.html$/,
            /^main\.py$/,
          ];
          let entry = null;
          for (const re of entryRegex) {
            entry = paths.find((p) => re.test(p));
            if (entry) break;
          }
          if (!entry) entry = paths[0];
          if (entry) walkTo(entry, []);
        }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.full_name]);

  async function walkTo(path, prevVisited = visited) {
    if (!path) return;
    setBusy(true); setErr(null);
    setCurrentPath(path);
    setContent(""); setExplanation(null);
    try {
      const r = await api.repo.walkthrough({
        repoId: repo.id,
        fullName: repo.full_name,
        filePath: path,
        visitedPaths: prevVisited,
        model,
      });
      if (!r?.ok) {
        setErr(r?.error || "walkthrough failed");
      } else {
        setContent(r.fileContent || "");
        setExplanation(r.text || r.summary || "");
        setVisited([...prevVisited, path]);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Pull "Look at next: <path>" from the explanation if present.
  function suggestedNext() {
    if (!explanation) return null;
    const m = explanation.match(/look at next[:\s]*\`?([^\s`\n]+)\`?/i);
    return m ? m[1].replace(/[.,]$/, "") : null;
  }

  async function askQuestion() {
    const q = question.trim();
    if (!q || !currentPath) return;
    setBusy(true);
    try {
      const r = await api.repo.chat({
        repoId: repo.id,
        fullName: repo.full_name,
        question: `In the file \`${currentPath}\`: ${q}`,
        history: qaHistory,
        model,
      });
      if (r?.ok) {
        setQaHistory([
          ...qaHistory,
          { role: "user", content: q },
          { role: "assistant", content: r.text || "" },
        ]);
        setQuestion("");
      } else {
        setErr(r?.error || "Q&A failed");
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const next = suggestedNext();

  return (
    <div className="repo-walkthrough" style={{ marginTop: 12, display: "grid", gridTemplateColumns: "200px 1fr 1fr", gap: 10, minHeight: 460 }}>
      {/* File tree */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "auto", maxHeight: 600, padding: 6 }}>
        <div className="section-label" style={{ marginBottom: 4, padding: "0 4px" }}>Files</div>
        {tree.length === 0 && <small className="muted" style={{ padding: 6 }}>Loading tree…</small>}
        {tree.map((p) => {
          const visited_ = visited.includes(p.path);
          const active = p.path === currentPath;
          return (
            <div
              key={p.path}
              onClick={() => walkTo(p.path)}
              title={p.path}
              style={{
                fontSize: 11,
                padding: "3px 6px",
                cursor: "pointer",
                borderRadius: 4,
                background: active ? "var(--accent-soft)" : visited_ ? "var(--bg-elev-2)" : "transparent",
                color: active ? "var(--accent)" : "var(--text-dim)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                fontFamily: "var(--font-mono, monospace)",
              }}
            >
              {visited_ ? "● " : "○ "}{p.path}
            </div>
          );
        })}
      </div>

      {/* File viewer */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div className="row between" style={{ padding: "6px 10px", background: "var(--bg-elev-2)", borderBottom: "1px solid var(--border)" }}>
          <code style={{ fontSize: 11 }}>{currentPath || "(no file)"}</code>
          <small className="muted">{visited.length} / {tree.length} visited</small>
        </div>
        <pre style={{ flex: 1, margin: 0, padding: 10, overflow: "auto", fontSize: 11, fontFamily: "var(--font-mono, monospace)", maxHeight: 540 }}>
          {busy && !content ? "loading…" : content}
        </pre>
      </div>

      {/* AI explanation + Q&A */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", maxHeight: 600 }}>
        <div className="section-label" style={{ marginBottom: 6 }}>Apex says</div>
        <div style={{ flex: 1, overflowY: "auto", fontSize: 12 }}>
          {!ollamaOk && <div className="muted">Ollama is offline — start it from Settings.</div>}
          {busy && !explanation && <em className="muted">Reading the file…</em>}
          {explanation && <MarkdownBlock text={explanation} />}
          {qaHistory.map((m, i) => (
            <div key={i} style={{ marginTop: 8, padding: 8, borderRadius: 6, background: m.role === "user" ? "var(--accent-soft)" : "var(--bg-elev-2)" }}>
              <strong style={{ fontSize: 10, color: "var(--text-faint)" }}>{m.role === "user" ? "YOU" : "APEX"}</strong>
              <MarkdownBlock text={m.content} />
            </div>
          ))}
        </div>
        {next && (
          <button
            className="primary small"
            onClick={() => walkTo(next)}
            disabled={busy}
            style={{ marginTop: 8 }}
            title={`Walk to ${next}`}
          >
            Next → {next}
          </button>
        )}
        <form
          style={{ marginTop: 8, display: "flex", gap: 6 }}
          onSubmit={(e) => { e.preventDefault(); if (!busy) askQuestion(); }}
        >
          <input
            placeholder={currentPath ? `Ask about ${currentPath.split("/").pop()}…` : "Ask…"}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            style={{ flex: 1, fontSize: 12 }}
            disabled={!ollamaOk || busy || !currentPath}
          />
          <button className="ghost xsmall" type="submit" disabled={!question.trim() || busy}>Ask</button>
        </form>
        {err && <div className="error" style={{ marginTop: 6, fontSize: 11 }}>{err}</div>}
      </div>
    </div>
  );
}

// ─── RepoComparePanel ────────────────────────────────────────────────────
// Lists the user's own repos that share at least one language with the
// target repo. Shows them side-by-side so the user can self-compare.
function RepoComparePanel({ repo }) {
  const [matches, setMatches] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState(null);
  const [myUser, setMyUser] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = (await api.settings?.get?.("github.username")) || "";
        if (!cancelled) setMyUser(u);
        const r = await api.repo.similarToMine({ repoId: repo.id, myUsername: u });
        if (!cancelled) {
          if (r?.ok) setMatches(r.matches || []);
          else setErr(r?.error || "compare failed");
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) { setErr(e.message); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [repo.id]);

  if (loading) return <div className="muted" style={{ marginTop: 14 }}>Looking at your repos…</div>;
  if (err) return <div className="error" style={{ marginTop: 14 }}>{err}</div>;
  if (!myUser) return (
    <div className="muted" style={{ marginTop: 14 }}>
      Set your GitHub username in Settings → Integrations → GitHub to see comparisons.
    </div>
  );

  return (
    <div style={{ marginTop: 14 }}>
      <div className="section-label" style={{ marginBottom: 8 }}>
        Your repos that share a language with {repo.name}
      </div>
      {matches.length === 0 ? (
        <div className="muted">
          No matches — none of your repos share a primary language with this one.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
          {matches.map((m) => (
            <div key={m.repo.id} className="card" style={{ padding: 12 }}>
              <div className="row between">
                <strong>{m.repo.name}</strong>
                {m.repo.language && (
                  <span className="pill gray" style={{ fontSize: 10 }}>{m.repo.language}</span>
                )}
              </div>
              {m.repo.description && (
                <small className="muted" style={{ display: "block", marginTop: 4 }}>
                  {m.repo.description}
                </small>
              )}
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <small className="muted">★ {m.repo.stars || 0}</small>
                {m.repo.url && (
                  <a href={m.repo.url} target="_blank" rel="noreferrer" className="ghost xsmall">
                    open ↗
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
