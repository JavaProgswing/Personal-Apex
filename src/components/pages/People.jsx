import React, { useEffect, useMemo, useState } from "react";
import api from "../../lib/api.js";
import ActivityFeed from "../ActivityFeed.jsx";
import { MarkdownBlock } from "../../lib/markdown.jsx";

// Curated preset links shown in the "Import from links" modal. Treated as
// regular `{label, url}` pairs - no special-casing for NextTechLab. Users
// can extend this list at runtime via `ui.linkPresets` in localStorage.
const BUILTIN_LINK_PRESETS = [
  {
    label: "NextTechLab · Satoshi",
    url: "https://nexttechlab.in/labs/satoshi",
  },
  { label: "NextTechLab · Norman", url: "https://nexttechlab.in/labs/norman" },
  { label: "NextTechLab · Pausch", url: "https://nexttechlab.in/labs/pausch" },
  {
    label: "NextTechLab · McCarthy",
    url: "https://nexttechlab.in/labs/mccarthy",
  },
  { label: "NextTechLab · Tesla", url: "https://nexttechlab.in/labs/tesla" },
];
function loadUserLinkPresets() {
  try {
    return JSON.parse(localStorage.getItem("ui.linkPresets") || "[]");
  } catch {
    return [];
  }
}
function saveUserLinkPresets(arr) {
  try {
    localStorage.setItem("ui.linkPresets", JSON.stringify(arr));
  } catch {}
}

const PAGE_SIZE = 18;

export default function People() {
  const [people, setPeople] = useState([]);
  const [filter, setFilter] = useState({
    q: "",
    tag: "",
    source: "",
    only: "",
  });
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
  const [showMergeDuplicates, setShowMergeDuplicates] = useState(false);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [openRepo, setOpenRepo] = useState(null); // repo row to open in detail

  const [ghSync, setGhSync] = useState({
    active: false,
    total: 0,
    done: 0,
    current: null,
    rateLimited: false,
    resetAt: null,
  });
  const [cpSync, setCpSync] = useState({
    active: false,
    total: 0,
    done: 0,
    ok: 0,
    err: 0,
    current: null,
  });
  const [status, setStatus] = useState(null);

  useEffect(() => {
    reload(); /* eslint-disable-next-line */
  }, [filter.q, filter.tag, filter.source, filter.only]);
  useEffect(() => {
    setPage(1);
  }, [filter.q, filter.tag, filter.source, filter.only, groupBy]);

  useEffect(() => {
    // Hydrate sync state from the main process on mount - survives tab
    // switches. Earlier the UI lost track of an in-flight sync the moment
    // you navigated away because state lived only in component memory.
    // Now main owns the truth; we just paint whatever it's holding.
    api.sync
      ?.status?.()
      .then((s) => {
        if (s?.gh) setGhSync((cur) => ({ ...cur, ...s.gh }));
        if (s?.cp) setCpSync((cur) => ({ ...cur, ...s.cp }));
      })
      .catch(() => {});
    const off1 = api.people.onSyncProgress((p) =>
      setGhSync((s) => ({ ...s, ...p })),
    );
    const off2 = api.cp.onProgress((p) => setCpSync((s) => ({ ...s, ...p })));
    return () => {
      off1?.();
      off2?.();
    };
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
            setGhSync({
              active: true,
              total: 0,
              done: 0,
              current: null,
              rateLimited: false,
              resetAt: null,
            });
            try {
              const res = await api.people.syncAll();
              if (cancelled) return;
              setGhSync((s) => ({ ...s, active: false }));
              setStatus({
                msg: `GitHub auto-sync: ${res.filter((r) => r.ok).length} / ${res.length} ok`,
              });
            } catch (e) {
              if (!cancelled) setGhSync((s) => ({ ...s, active: false }));
            }
          })(),
        );
      }
      if (now - lastCp > STALE_MS) {
        localStorage.setItem("apex.people.lastAutoCp", String(now));
        tasks.push(
          (async () => {
            setCpSync({
              active: true,
              total: 0,
              done: 0,
              ok: 0,
              err: 0,
              current: null,
            });
            try {
              const res = await api.cp.fetchAll();
              if (cancelled) return;
              setCpSync((s) => ({ ...s, active: false }));
              setStatus(
                (cur) =>
                  cur ?? {
                    msg: `CP auto-sync: ${res.okCount} / ${res.total} ok`,
                  },
              );
            } catch {
              if (!cancelled) setCpSync((s) => ({ ...s, active: false }));
            }
          })(),
        );
      }
      if (tasks.length) {
        await Promise.all(tasks);
        if (!cancelled) reload();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reload() {
    // Server only knows about q/tag; source/only are client-side pills.
    const list = await api.people.list({ q: filter.q, tag: filter.tag });
    setPeople(list || []);
    // Fetch heat strips in batch - used by PersonCard to render a 14-day
    // commit pulse. Cheap query, but keep payload bounded.
    if (api.people?.heatStrips && list?.length) {
      try {
        const ids = list.map((p) => p.id).slice(0, 200);
        const map = await api.people.heatStrips(ids, 14);
        setHeatStrips(map || {});
      } catch {
        setHeatStrips({});
      }
    }
  }

  async function toggleFollow(p) {
    const tags = Array.isArray(p.tags) ? [...p.tags] : [];
    const i = tags.indexOf("following");
    if (i >= 0) tags.splice(i, 1);
    else tags.push("following");
    await api.people.upsert({ ...p, tags });
    await reload();
  }

  async function openPerson(p) {
    setSelected(p);
    const [r, cp, act] = await Promise.all([
      api.people.repos(p.id),
      api.cp.stats(p.id),
      api.activity.feed
        ? api.activity.feed({ personId: p.id, limit: 40 }).catch(() => [])
        : [],
    ]);
    setRepos(r);
    setCpStats(cp);
    setPersonActivity(act);
  }

  async function syncOneGh(id) {
    setStatus(null);
    try {
      const res = await api.people.sync(id);
      setStatus(
        res.ok
          ? { msg: `Synced ${res.count} repos` }
          : { err: res.error || res.code },
      );
      reload();
      if (selected?.id === id) setRepos(await api.people.repos(id));
    } catch (e) {
      setStatus({ err: e.message });
    }
  }
  async function syncOneCp(id) {
    setStatus(null);
    const res = await api.cp.fetchPerson(id);
    setStatus(
      res.ok
        ? { msg: "CP refreshed" }
        : { err: res.error || "CP refresh failed" },
    );
    if (selected?.id === id) setCpStats(await api.cp.stats(id));
    reload();
  }
  async function syncAllGh() {
    if (ghSync.active) {
      setStatus({
        msg: "GitHub sync already running - wait for it to finish.",
      });
      return;
    }
    setGhSync({
      active: true,
      total: 0,
      done: 0,
      current: null,
      rateLimited: false,
      resetAt: null,
    });
    const res = await api.people.syncAll();
    // Main guards against double-runs and returns this error if you slip
    // through; surface it instead of crashing on res.filter().
    if (res && res.ok === false && res.error === "already-running") {
      setStatus({ msg: "GitHub sync is already running in the background." });
      return;
    }
    setGhSync((s) => ({ ...s, active: false }));
    if (Array.isArray(res)) {
      setStatus({
        msg: `GitHub sync: ${res.filter((r) => r.ok).length} / ${res.length} ok`,
      });
    } else if (res?.ok === false) {
      setStatus({ err: "GitHub sync failed: " + (res?.error || "unknown") });
    }
    reload();
  }
  function handleClearData() {
    setShowBulkDelete(true);
  }
  async function syncAllCp() {
    if (cpSync.active) {
      setStatus({ msg: "CP sync already running - wait for it to finish." });
      return;
    }
    setCpSync({
      active: true,
      total: 0,
      done: 0,
      ok: 0,
      err: 0,
      current: null,
    });
    try {
      const res = await api.cp.fetchAll();
      if (res?.ok === false && res?.error === "already-running") {
        setStatus({ msg: "CP sync is already running in the background." });
        return;
      }
      if (!res || res.ok === false) {
        setStatus({ err: "CP sync: " + (res?.error || "unknown error") });
      } else if ((res.total || 0) === 0) {
        setStatus({
          msg: "CP sync: nobody has a LeetCode/CF/CC handle yet - set one in Settings or import classmates first.",
        });
      } else {
        setStatus({ msg: `CP sync: ${res.okCount} / ${res.total} ok` });
      }
    } catch (err) {
      setStatus({ err: "CP sync failed: " + err.message });
    } finally {
      setCpSync((s) => ({ ...s, active: false }));
      reload();
    }
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
    else if (filter.only === "cp")
      out = out.filter(
        (p) =>
          p.leetcode_username || p.codeforces_username || p.codechef_username,
      );
    else if (filter.only === "unsynced")
      out = out.filter((p) => !p.last_scraped_at);
    else if (filter.only === "following")
      out = out.filter(
        (p) => Array.isArray(p.tags) && p.tags.includes("following"),
      );

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
    const push = (k, p) => {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    };
    for (const p of filtered) {
      if (groupBy === "source") push(p.source || "-", p);
      else if (groupBy === "tag") {
        if (!p.tags?.length) push("-", p);
        else p.tags.forEach((t) => push(t, p));
      } else if (groupBy === "syncstate")
        push(p.last_scraped_at ? "synced" : "never", p);
    }
    return [...map.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, rows]) => ({ key, rows }));
  }, [filtered, groupBy]);

  // Pagination - flat across groups (simple approach: limit to page * PAGE_SIZE)
  const paged = useMemo(() => {
    const limit = page * PAGE_SIZE;
    let n = 0;
    return groups
      .map((g) => {
        if (n >= limit) return { ...g, rows: [] };
        const take = Math.min(g.rows.length, limit - n);
        n += take;
        return { ...g, rows: g.rows.slice(0, take) };
      })
      .filter((g) => g.rows.length > 0);
  }, [groups, page]);
  const totalRows = filtered.length;
  const shownRows = paged.reduce((s, g) => s + g.rows.length, 0);
  const hasFilters = !!(filter.q || filter.tag || filter.source || filter.only);
  const peopleStats = useMemo(() => {
    const following = people.filter(
      (p) => Array.isArray(p.tags) && p.tags.includes("following"),
    ).length;
    const github = people.filter((p) => p.github_username).length;
    const cp = people.filter(
      (p) =>
        p.leetcode_username || p.codeforces_username || p.codechef_username,
    ).length;
    const unsynced = people.filter((p) => !p.last_scraped_at).length;
    return { following, github, cp, unsynced };
  }, [people]);

  return (
    <>
      <section className="people-hero">
        <div className="people-hero-copy">
          <h1 className="page-title">People</h1>
          <p className="muted">
            Track classmates, builders, GitHub repos, CP handles, and recent
            activity without turning the page into a spreadsheet.
          </p>
        </div>
        <div className="people-hero-actions">
          <PeopleAddMenu
            onImport={() => setShowImport(true)}
            onAdd={() => setShowAdd(true)}
            onMergeDuplicates={() => setShowMergeDuplicates(true)}
            onClearData={handleClearData}
          />
          <PeopleSyncMenu
            ghActive={ghSync.active}
            cpActive={cpSync.active}
            onSyncGh={syncAllGh}
            onSyncCp={syncAllCp}
            onSyncSrm={reload}
          />
        </div>
      </section>

      <div className="people-overview-grid">
        <PeopleOverviewCard
          label="Directory"
          value={people.length}
          detail={`${filtered.length} in current view`}
          tone="info"
        />
        <PeopleOverviewCard
          label="Following"
          value={peopleStats.following}
          detail="Pinned people"
          tone={peopleStats.following ? "ok" : "warn"}
        />
        <PeopleOverviewCard
          label="GitHub"
          value={peopleStats.github}
          detail="Repo sync ready"
          tone={peopleStats.github ? "ok" : "warn"}
        />
        <PeopleOverviewCard
          label="CP handles"
          value={peopleStats.cp}
          detail="Leaderboard ready"
          tone={peopleStats.cp ? "ok" : "warn"}
        />
        <PeopleOverviewCard
          label="Needs sync"
          value={peopleStats.unsynced}
          detail="No scrape yet"
          tone={peopleStats.unsynced ? "danger" : "ok"}
        />
      </div>

      {ghSync.active && <SyncBar label="GitHub" {...ghSync} />}
      {ghSync.rateLimited && (
        <div className="card rose" style={{ margin: "6px 0" }}>
          GitHub rate-limited. Resets{" "}
          {ghSync.resetAt
            ? "at " + new Date(ghSync.resetAt).toLocaleTimeString()
            : "soon"}
          . Add a token in Settings → GitHub.
        </div>
      )}
      {cpSync.active && <SyncBar label="Competitive programming" {...cpSync} />}

      {/* Search + chips on the primary row. The advanced selects (tag,
          source, sort, group) live behind an expandable "Advanced ▾"
          control so the toolbar reads as a single tidy line by default. */}
      <PeopleControlsRow
        filter={filter}
        setFilter={setFilter}
        people={people}
        sortBy={sortBy}
        setSortBy={setSortBy}
        groupBy={groupBy}
        setGroupBy={setGroupBy}
        tagOptions={tagOptions}
        sourceOptions={sourceOptions}
        status={status}
        onLeaderboard={() => setShowLeaderboard(true)}
      />

      {/* Browse repos and Recent activity are collapsible so the default
          view is the people grid (the actual content). Click to expand. */}
      <details className="people-collapsible">
        <summary>
          <h3>Browse repos</h3>
          <span
            className="count-pill"
            title="Search across cached repos + public GitHub"
          >
            by topic / framework
          </span>
          <span className="people-collapsible-chevron" aria-hidden>
            ▸
          </span>
        </summary>
        <div className="people-collapsible-body">
          <RepoTopicSearch
            onOpenRepo={(r, person) => setOpenRepo({ repo: r, person })}
          />
        </div>
      </details>

      <details className="people-collapsible">
        <summary>
          <h3>Recent activity</h3>
          <span className="count-pill" title="Across everyone you follow">
            live feed
          </span>
          <span className="people-collapsible-chevron" aria-hidden>
            ▸
          </span>
        </summary>
        <div className="people-collapsible-body">
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
        </div>
      </details>

      {/* Everyone - grouped grid. This is the primary view and stays open. */}
      <section className="people-section">
        <div className="people-section-head">
          <h3>Everyone</h3>
          <span className="count-pill">
            {shownRows} {shownRows === 1 ? "person" : "people"}
          </span>
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
                  following={
                    Array.isArray(p.tags) && p.tags.includes("following")
                  }
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
          <PeopleEmptyState
            hasFilters={hasFilters}
            onClearFilters={() =>
              setFilter({ q: "", tag: "", source: "", only: "" })
            }
            onImport={() => setShowImport(true)}
            onAdd={() => setShowAdd(true)}
          />
        )}

        {/* Pager */}
        {shownRows < totalRows && (
          <div
            className="pager row"
            style={{ justifyContent: "center", marginTop: 8 }}
          >
            <small className="muted">
              {shownRows} / {totalRows}
            </small>
            <button className="primary" onClick={() => setPage((p) => p + 1)}>
              Show more
            </button>
          </div>
        )}
      </section>

      {showMergeDuplicates && (
        <MergeDuplicatesModal
          onClose={() => setShowMergeDuplicates(false)}
          onMerged={() => {
            setShowMergeDuplicates(false);
            reload();
          }}
        />
      )}

      {showBulkDelete && (
        <BulkDeleteModal
          people={people}
          onClose={() => setShowBulkDelete(false)}
          onDeleted={() => {
            setShowBulkDelete(false);
            reload();
            setStatus({ msg: "Selected people deleted" });
          }}
        />
      )}

      {selected && (
        <PersonModal
          person={selected}
          repos={repos}
          cpStats={cpStats}
          activity={personActivity}
          onClose={() => {
            setSelected(null);
            setRepos([]);
            setCpStats([]);
            setPersonActivity([]);
          }}
          onSyncGh={() => syncOneGh(selected.id)}
          onSyncCp={() => syncOneCp(selected.id)}
          onDelete={async () => {
            await api.people.delete(selected.id);
            setSelected(null);
            reload();
          }}
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
      {showAdd && (
        <AddPersonModal
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            reload();
          }}
        />
      )}
      {showImport && (
        <ImportByLinkModal
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            reload();
          }}
        />
      )}
      {showLeaderboard && (
        <LeaderboardModal onClose={() => setShowLeaderboard(false)} />
      )}
    </>
  );
}

function PeopleOverviewCard({ label, value, detail, tone = "info" }) {
  return (
    <div className={"people-overview-card " + tone}>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

function PeopleEmptyState({ hasFilters, onClearFilters, onImport, onAdd }) {
  return (
    <div className="people-empty-state">
      <div className="people-empty-mark" aria-hidden>
        <span />
      </div>
      <div>
        <strong>
          {hasFilters ? "No one matches this view" : "Build your people graph"}
        </strong>
        <p className="muted">
          {hasFilters
            ? "The directory is here, but the current filters are hiding everyone."
            : "Import a lab page, GitHub profile, LinkedIn profile, or add one person manually to start tracking projects and CP activity."}
        </p>
      </div>
      <div className="people-empty-actions">
        {hasFilters && (
          <button className="ghost small" onClick={onClearFilters}>
            Clear filters
          </button>
        )}
        <button className="primary small" onClick={onImport}>
          Import links
        </button>
        <button className="ghost small" onClick={onAdd}>
          Add manually
        </button>
      </div>
    </div>
  );
}

function SyncBar({ label, total, done, ok, err, current, rateLimited }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div className="row between">
        <strong>{label} sync</strong>
        <small className="muted">
          {done} / {total} {ok != null ? `· ${ok} ok · ${err} err` : ""}
        </small>
      </div>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <small className="muted">
        {rateLimited
          ? "rate-limited; stopped"
          : current
            ? `current: ${current}`
            : "…"}
      </small>
    </div>
  );
}

// Compact "+ Add" split-button - one primary CTA with a chevron menu for
// the secondary add path. Keeps the People header from sprouting buttons.
// Compact, tidy controls bar for the People page. Top row: search +
// "scope" chips + leaderboard. Below that, a collapsible Advanced panel
// holding the (rarely-used) tag/source/sort/group selects. Reduces the
// default visual surface from ~9 controls in one row to 5.
function PeopleControlsRow({
  filter,
  setFilter,
  people,
  sortBy,
  setSortBy,
  groupBy,
  setGroupBy,
  tagOptions,
  sourceOptions,
  status,
  onLeaderboard,
}) {
  // Auto-expand if any advanced filter is non-default so the user
  // doesn't lose state behind a closed drawer.
  const isAdvancedActive =
    !!filter.tag ||
    !!filter.source ||
    sortBy !== "activity" ||
    groupBy !== "none";
  const [open, setOpen] = useState(isAdvancedActive);

  return (
    <div className="page-people-controls">
      {/* Primary line - search + scope chips + leaderboard. */}
      <div className="people-controls-primary">
        <input
          className="people-controls-search"
          placeholder="Search name, GitHub, LeetCode…"
          value={filter.q}
          onChange={(e) => setFilter({ ...filter, q: e.target.value })}
        />
        <div className="chip-row people-scope-chips">
          <button
            className={"chip" + (filter.only === "" ? " active" : "")}
            onClick={() => setFilter({ ...filter, only: "" })}
          >
            All <small className="muted">{people.length}</small>
          </button>
          <button
            className={"chip" + (filter.only === "following" ? " active" : "")}
            onClick={() => setFilter({ ...filter, only: "following" })}
          >
            ★ Following
          </button>
          <button
            className={"chip" + (filter.only === "gh" ? " active" : "")}
            onClick={() => setFilter({ ...filter, only: "gh" })}
          >
            GitHub
          </button>
          <button
            className={"chip" + (filter.only === "cp" ? " active" : "")}
            onClick={() => setFilter({ ...filter, only: "cp" })}
          >
            CP
          </button>
          <button
            className={"chip" + (filter.only === "unsynced" ? " active" : "")}
            onClick={() => setFilter({ ...filter, only: "unsynced" })}
          >
            Unsynced
          </button>
        </div>
        <button
          type="button"
          className={
            "ghost people-controls-advanced-toggle" + (open ? " active" : "")
          }
          onClick={() => setOpen((v) => !v)}
          title="Tag / source / sort / group filters"
        >
          Filters {open ? "▴" : "▾"}
        </button>
        <button
          className="ghost"
          onClick={onLeaderboard}
          title="Open leaderboard"
        >
          Leaderboard
        </button>
      </div>

      {/* Advanced - tucked behind a toggle. */}
      {open && (
        <div className="people-controls-advanced">
          <FilterField label="Tag">
            <select
              value={filter.tag}
              onChange={(e) => setFilter({ ...filter, tag: e.target.value })}
            >
              <option value="">All</option>
              {tagOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Source">
            <select
              value={filter.source}
              onChange={(e) => setFilter({ ...filter, source: e.target.value })}
            >
              <option value="">All</option>
              {sourceOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Sort">
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="activity">Recent activity</option>
              <option value="name">Name</option>
            </select>
          </FilterField>
          <FilterField label="Group">
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
            >
              <option value="none">None</option>
              <option value="source">Source</option>
              <option value="tag">Tag</option>
              <option value="syncstate">Sync state</option>
            </select>
          </FilterField>
          {(filter.tag ||
            filter.source ||
            sortBy !== "activity" ||
            groupBy !== "none") && (
            <button
              type="button"
              className="ghost xsmall"
              onClick={() => {
                setFilter({ ...filter, tag: "", source: "" });
                setSortBy("activity");
                setGroupBy("none");
              }}
            >
              Reset
            </button>
          )}
        </div>
      )}

      {(status?.msg || status?.err) && (
        <small
          className={status.err ? "error" : "muted"}
          style={{ marginTop: 4, display: "block" }}
        >
          {status.msg || status.err}
        </small>
      )}
    </div>
  );
}

function FilterField({ label, children }) {
  return (
    <div className="filter-field">
      <small className="filter-field-label">{label}</small>
      {children}
    </div>
  );
}

function PeopleAddMenu({ onImport, onAdd, onMergeDuplicates, onClearData }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button onClick={onAdd}>+ Add person</button>
      <button
        onClick={() => setOpen((v) => !v)}
        title="More ways to add"
        style={{ marginLeft: 4, padding: "0 8px" }}
      >
        ▾
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 4,
            minWidth: 220,
            zIndex: 10,
            boxShadow: "var(--shadow-md)",
          }}
        >
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setOpen(false);
              onImport();
            }}
            style={{ display: "block", width: "100%", textAlign: "left" }}
          >
            + Import from links…
          </button>
          {onMergeDuplicates && (
            <>
              <hr className="soft" style={{ margin: "4px 0" }} />
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setOpen(false);
                  onMergeDuplicates();
                }}
                style={{ display: "block", width: "100%", textAlign: "left" }}
                title="Find people that are likely duplicates and merge them"
              >
                Merge duplicates…
              </button>
            </>
          )}
          {onClearData && (
            <>
              <hr className="soft" style={{ margin: "4px 0" }} />
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setOpen(false);
                  onClearData();
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  color: "#ef6b5a",
                }}
                title="Bulk delete specific people or everyone"
              >
                🗑 Bulk delete people…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Single sync button with a dropdown that fans out to GitHub / CP / SRM
// leaderboard. The visible label reflects whichever sync is currently
// running. Replaces the three separate sync buttons in the header.
// Richer sync menu - three sync paths, each with its own "last sync"
// timestamp and live status row. Replaces the old flat button list with
// a card-style dropdown that reads like a control panel.
function PeopleSyncMenu({ ghActive, cpActive, onSyncGh, onSyncCp, onSyncSrm }) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState(null);
  const [progress, setProgress] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [ghLast, setGhLast] = useState(null);
  const [cpLast, setCpLast] = useState(null);
  const ref = React.useRef(null);

  // Load last-sync timestamps for each path on mount. GitHub + CP keep
  // theirs on the most-recently-scraped person; SRM has a dedicated key.
  React.useEffect(() => {
    api.cp
      .srmLeaderboardLastSync?.()
      .then((r) => setLast(r))
      .catch(() => {});
    api.settings
      ?.get?.("github.lastSync")
      ?.then((v) => v && setGhLast(v))
      .catch(() => {});
    api.settings
      ?.get?.("cp.lastSync")
      ?.then((v) => v && setCpLast(v))
      .catch(() => {});
    // Hydrate SRM busy state from main on mount - survives tab switches.
    api.sync
      ?.status?.()
      .then((s) => {
        if (s?.srm?.active) {
          setBusy(true);
          setProgress({
            stage: s.srm.stage,
            page: s.srm.page,
            totalSoFar: s.srm.totalSoFar,
          });
        }
      })
      .catch(() => {});
    const off = api.cp.onSrmLeaderboardProgress?.((info) => {
      setProgress(info);
      // The main process now broadcasts an end-of-job event with
      // active:false - flip our local busy to match.
      if (info && info.active === false) setBusy(false);
      else if (info && info.active === true) setBusy(true);
    });
    return () => {
      try {
        off?.();
      } catch {}
    };
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Stamp the timestamps locally when the parent's sync flips off.
  React.useEffect(() => {
    if (!ghActive && ghLast === null) return;
    if (!ghActive) {
      const now = new Date().toISOString();
      setGhLast(now);
      api.settings?.set?.("github.lastSync", now);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghActive]);
  React.useEffect(() => {
    if (!cpActive && cpLast === null) return;
    if (!cpActive) {
      const now = new Date().toISOString();
      setCpLast(now);
      api.settings?.set?.("cp.lastSync", now);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpActive]);

  async function runSrm() {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    setProgress(null);
    setMsg(null);
    try {
      const r = await api.cp.syncSrmLeaderboard();
      if (r?.ok === false && r.error === "already-running") {
        setMsg("Already syncing - wait for it to finish.");
      } else if (!r?.ok) {
        setMsg("Failed: " + (r?.error || "unknown"));
      } else {
        setMsg(`Imported ${r.imported}, updated ${r.updated} of ${r.total}.`);
        setLast({ at: r.fetchedAt, ...r });
        onSyncSrm?.();
      }
    } catch (e) {
      setMsg("Error: " + e.message);
    } finally {
      setBusy(false);
      setProgress(null);
      setTimeout(() => setMsg(null), 5000);
    }
  }

  let label = "Sync";
  if (ghActive) label = "Syncing GitHub…";
  else if (cpActive) label = "Syncing CP…";
  else if (busy) {
    if (progress?.stage === "paginating" && progress.page)
      label = `SRM p.${progress.page}…`;
    else label = "Syncing…";
  } else if (msg) label = msg;

  const anyBusy = ghActive || cpActive || busy;
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        className="primary"
        onClick={() => setOpen((v) => !v)}
        disabled={anyBusy}
        title="Sync · GitHub / CP / SRM Leaderboard"
      >
        {label}
        {!anyBusy && " ▾"}
      </button>
      {open && (
        <div className="people-sync-menu">
          <div className="people-sync-menu-head">Sync sources</div>
          <SyncMenuRow
            label="GitHub"
            sub="Repos · activity · commits"
            lastAt={ghLast}
            active={ghActive}
            onRun={() => {
              setOpen(false);
              onSyncGh();
            }}
          />
          <SyncMenuRow
            label="Competitive programming"
            sub="LeetCode · Codeforces · CodeChef"
            lastAt={cpLast}
            active={cpActive}
            onRun={() => {
              setOpen(false);
              onSyncCp();
            }}
          />
          <SyncMenuRow
            label="SRM Leaderboard"
            sub="Classmates from lead.aakarsh.xyz"
            lastAt={last?.at}
            active={busy}
            extra={
              last
                ? `${last.imported || 0} new · ${last.updated || 0} updated`
                : null
            }
            onRun={runSrm}
          />
        </div>
      )}
    </div>
  );
}

// One row in the sync menu - title, sub, last-sync, and a Run button.
function SyncMenuRow({ label, sub, lastAt, active, extra, onRun }) {
  const ago = lastAt ? humanAgo(new Date(lastAt)) : "never synced";
  return (
    <button
      type="button"
      className="people-sync-row"
      onClick={onRun}
      disabled={active}
    >
      <div className="people-sync-row-main">
        <div className="people-sync-row-label">
          <strong>{label}</strong>
          {active && (
            <span className="spinner-row" style={{ marginLeft: 6 }}>
              <span className="spinner" aria-hidden />
            </span>
          )}
        </div>
        <small className="muted">{sub}</small>
      </div>
      <div className="people-sync-row-meta">
        <small className="muted">{ago}</small>
        {extra && (
          <small className="muted" style={{ fontSize: 10 }}>
            {extra}
          </small>
        )}
      </div>
    </button>
  );
}

function humanAgo(d) {
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dd = Math.floor(h / 24);
  if (dd < 7) return `${dd}d ago`;
  return d.toLocaleDateString();
}

// One-click button that scrapes the SRM CP leaderboard
// (https://lead.aakarsh.xyz/leaderboard/master) and imports / updates
// people. Pulls name + reg + LeetCode handle + section.
function SrmLeaderboardButton({ onSynced }) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [msg, setMsg] = useState(null);
  const [progress, setProgress] = useState(null); // {stage, page, totalSoFar, ...}

  useEffect(() => {
    api.cp
      .srmLeaderboardLastSync?.()
      .then((r) => setLast(r))
      .catch(() => {});
    // Stream progress events from the scraper so the user can see it
    // working through pages instead of staring at "Syncing…" for 30s.
    const off = api.cp.onSrmLeaderboardProgress?.((info) => setProgress(info));
    return () => {
      try {
        off?.();
      } catch {}
    };
  }, []);

  async function run() {
    setBusy(true);
    setProgress(null);
    setMsg("Fetching SRM leaderboard…");
    try {
      const r = await api.cp.syncSrmLeaderboard();
      if (!r?.ok) {
        setMsg("Failed: " + (r?.error || "unknown"));
      } else {
        const partialNote = r.partial ? " (partial - JS-paginated source)" : "";
        setMsg(
          `Imported ${r.imported}, updated ${r.updated} of ${r.total}${partialNote}.`,
        );
        setLast({ at: r.fetchedAt, ...r });
        onSynced?.();
      }
    } catch (e) {
      setMsg("Error: " + e.message);
    } finally {
      setBusy(false);
      setProgress(null);
      setTimeout(() => setMsg(null), 5000);
    }
  }

  // Build the live label.
  let label = "Sync SRM leaderboard";
  if (busy) {
    if (progress?.stage === "paginating" && progress.page) {
      label = `Page ${progress.page}… (${progress.totalSoFar || 0} so far)`;
    } else if (progress?.stage === "trying-json") {
      label = "Trying JSON endpoint…";
    } else if (progress?.stage === "parsing-next-data") {
      label = "Parsing initial data…";
    } else if (progress?.stage === "done") {
      label = `Got ${progress.total || 0}…`;
    } else {
      label = "Syncing leaderboard…";
    }
  } else if (msg) {
    label = msg;
  }

  return (
    <button
      className="ghost"
      onClick={run}
      disabled={busy}
      title={
        last
          ? `Last sync: ${new Date(last.at).toLocaleString()} · ${last.imported || 0} new, ${last.updated || 0} updated · via ${last.via || "?"}`
          : "Pull classmates from lead.aakarsh.xyz/leaderboard/master"
      }
    >
      {label}
    </button>
  );
}

function PersonCard({
  p,
  heat,
  following,
  onOpen,
  onToggleFollow,
  onRetryGh,
  onRetryCp,
}) {
  const liHandle = !p.github_username ? linkedinHandle(p.linkedin_url) : null;
  const hasCp = !!(
    p.leetcode_username ||
    p.codeforces_username ||
    p.codechef_username
  );
  const hasAnyLink = !!(
    p.github_username ||
    liHandle ||
    p.linkedin_url ||
    hasCp
  );

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
        onClick={(e) => {
          e.stopPropagation();
          onToggleFollow?.();
        }}
        title={following ? "Unfollow" : "Follow this person"}
        aria-label={following ? "Unfollow" : "Follow"}
      >
        {following ? "★" : "☆"}
      </button>
      {p.avatar_url ? (
        <img className="avatar" src={p.avatar_url} alt="" />
      ) : (
        <div className="avatar avatar-fallback">
          {(p.name || "?").slice(0, 1).toUpperCase()}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="name">{p.name}</div>

        {/* Primary handle: GitHub first, else LinkedIn */}
        <div className="handle-row">
          {p.github_username ? (
            <span className="handle">
              <span className="handle-icon" aria-hidden>
                @
              </span>
              {p.github_username}
            </span>
          ) : liHandle ? (
            <span className="handle li">
              <span className="handle-icon" aria-hidden>
                in
              </span>
              /{liHandle}
            </span>
          ) : (
            <span className="handle muted">no linked profile</span>
          )}
        </div>

        {p.bio && (
          <div
            className="muted person-bio"
            style={{
              fontSize: 12,
              marginTop: 4,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {p.bio}
          </div>
        )}

        {hasCp && (
          <div className="tags" style={{ marginTop: 6 }}>
            {p.leetcode_username && (
              <span className="pill gray">LC: {p.leetcode_username}</span>
            )}
            {p.codeforces_username && (
              <span className="pill gray">CF: {p.codeforces_username}</span>
            )}
            {p.codechef_username && (
              <span className="pill gray">CC: {p.codechef_username}</span>
            )}
          </div>
        )}

        <small className="muted" style={{ display: "block", marginTop: 6 }}>
          {p.github_username
            ? p.last_scraped_at
              ? `synced ${new Date(p.last_scraped_at + "Z").toLocaleDateString()}`
              : "never synced"
            : liHandle
              ? "LinkedIn profile"
              : hasAnyLink
                ? ""
                : "no GitHub / LinkedIn"}
        </small>
      </div>
      {/* Hover action rail — one Sync that refreshes everything the person
          has (GitHub + CP), plus LinkedIn for link-only profiles. */}
      <div className="person-card-actions">
        {(p.github_username || hasCp) && (
          <button
            className="ghost small"
            title="Sync GitHub + CP data"
            onClick={(e) => {
              e.stopPropagation();
              if (p.github_username) onRetryGh();
              if (hasCp) onRetryCp();
            }}
          >
            ↻ Sync
          </button>
        )}
        {!p.github_username && p.linkedin_url && (
          <button
            className="ghost small"
            title="Open LinkedIn"
            onClick={(e) => {
              e.stopPropagation();
              api.ext.open(p.linkedin_url);
            }}
          >
            ↗
          </button>
        )}
      </div>
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

function PersonModal({
  person,
  repos,
  cpStats,
  activity,
  onClose,
  onSyncGh,
  onSyncCp,
  onDelete,
  onChanged,
  onOpenRepo,
}) {
  const [editMode, setEditMode] = useState(false);
  const [repoQ, setRepoQ] = useState("");
  const [repoLang, setRepoLang] = useState("");
  const [repoSort, setRepoSort] = useState("pushed");

  const hasGh = !!person.github_username;
  const hasCpHandles = !!(
    person.leetcode_username ||
    person.codeforces_username ||
    person.codechef_username
  );

  const languages = useMemo(() => {
    const s = new Set();
    repos.forEach((r) => r.language && s.add(r.language));
    return [...s].sort();
  }, [repos]);

  const filteredRepos = useMemo(() => {
    let out = repos;
    if (repoQ.trim()) {
      const n = repoQ.toLowerCase();
      out = out.filter(
        (r) =>
          r.name?.toLowerCase().includes(n) ||
          r.description?.toLowerCase().includes(n),
      );
    }
    if (repoLang) out = out.filter((r) => r.language === repoLang);
    if (repoSort === "pushed")
      out = [...out].sort((a, b) =>
        (b.pushed_at || "").localeCompare(a.pushed_at || ""),
      );
    else if (repoSort === "stars")
      out = [...out].sort((a, b) => (b.stars || 0) - (a.stars || 0));
    else if (repoSort === "name")
      out = [...out].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    return out;
  }, [repos, repoQ, repoLang, repoSort]);

  const recent = useMemo(() => {
    return (activity || []).slice(0, 8);
  }, [activity]);

  const shortLinkedin = (url) => {
    if (!url) return "";
    try {
      const u = new URL(url);
      return `${u.hostname.replace(/^www\./, "")}${u.pathname}`.replace(
        /\/$/,
        "",
      );
    } catch {
      return url;
    }
  };

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal wide person-modal" style={{ width: 900 }}>
        {/* Header: identity + actions in one row */}
        <div className="person-modal-head">
          <div className="person-modal-ident">
            <h3 style={{ margin: 0 }}>{person.name}</h3>
            <div className="person-modal-links">
              {hasGh && (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    api.ext.open(
                      `https://github.com/${person.github_username}`,
                    );
                  }}
                >
                  github.com/{person.github_username}
                </a>
              )}
              {person.linkedin_url && (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    api.ext.open(person.linkedin_url);
                  }}
                >
                  {shortLinkedin(person.linkedin_url)}
                </a>
              )}
            </div>
            {(person.tags || []).length > 0 && (
              <div className="tags" style={{ marginTop: 8 }}>
                {(person.tags || []).map((t) => (
                  <span key={t} className="pill">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="person-modal-actions">
            {hasGh && (
              <button
                className="small primary"
                onClick={onSyncGh}
                title="Fetch repos from GitHub"
              >
                Sync GitHub
              </button>
            )}
            {hasCpHandles && (
              <button
                className="small"
                onClick={onSyncCp}
                title="Refresh CP stats"
              >
                Sync CP
              </button>
            )}
            <button
              className="small ghost"
              onClick={() => setEditMode((v) => !v)}
            >
              {editMode ? "Cancel" : "Edit profile"}
            </button>
            <button
              className="small ghost danger"
              onClick={onDelete}
              title="Remove this person"
            >
              Delete
            </button>
            <button
              onClick={onClose}
              className="ghost icon-btn"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {editMode && (
          <HandleEdit
            person={person}
            onSaved={() => {
              setEditMode(false);
              onChanged();
            }}
          />
        )}

        {/* Recent activity for this person */}
        {recent.length > 0 && (
          <>
            <div className="section-label">Recently worked on</div>
            <div className="card" style={{ padding: 10 }}>
              {recent.map((e, i) => (
                <div
                  key={i}
                  className="row between"
                  style={{ margin: "4px 0", fontSize: 13 }}
                >
                  <span>
                    <span className="pill gray">{e.kind || "push"}</span>{" "}
                    <a
                      href="#"
                      onClick={(evt) => {
                        evt.preventDefault();
                        api.ext.open(e.url);
                      }}
                    >
                      {e.repo_name || e.summary}
                    </a>
                    {e.summary && e.summary !== e.repo_name && (
                      <span className="muted"> · {e.summary}</span>
                    )}
                  </span>
                  <small className="muted">
                    {e.at ? new Date(e.at).toLocaleString() : ""}
                  </small>
                </div>
              ))}
            </div>
          </>
        )}

        {/* CP stats - only show when handles are set OR we already have stats */}
        {(hasCpHandles || cpStats.length > 0) && (
          <>
            <div className="section-label" style={{ marginTop: 12 }}>
              Competitive programming
            </div>
            {cpStats.length === 0 ? (
              <div className="muted small" style={{ padding: "4px 0" }}>
                No stats yet - hit Sync CP to fetch.
              </div>
            ) : (
              cpStats.map((cp) => <CpStatCard key={cp.id} cp={cp} />)
            )}
          </>
        )}

        {/* Repos - only show when GH is connected OR we already have repos */}
        {(hasGh || repos.length > 0) && (
          <>
            <div
              className="row between"
              style={{
                marginTop: 14,
                marginBottom: 10,
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <div className="section-label" style={{ margin: 0 }}>
                Repos ({repos.length})
              </div>
              {repos.length > 0 && (
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <input
                    placeholder="Filter…"
                    value={repoQ}
                    onChange={(e) => setRepoQ(e.target.value)}
                    style={{ maxWidth: 160 }}
                  />
                  <select
                    value={repoLang}
                    onChange={(e) => setRepoLang(e.target.value)}
                    style={{ maxWidth: 130 }}
                  >
                    <option value="">All langs</option>
                    {languages.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <select
                    value={repoSort}
                    onChange={(e) => setRepoSort(e.target.value)}
                    style={{ maxWidth: 150 }}
                  >
                    <option value="pushed">Recently pushed</option>
                    <option value="stars">Most stars</option>
                    <option value="name">Name (A-Z)</option>
                  </select>
                </div>
              )}
            </div>
            {repos.length === 0 && (
              <div className="muted small" style={{ padding: "4px 0" }}>
                No repos cached yet - hit Sync GitHub.
              </div>
            )}
            <div className="grid-auto">
              {filteredRepos.map((r) => (
                <div
                  key={r.id}
                  className="repo-card"
                  onClick={() => onOpenRepo(r)}
                >
                  <div className="repo-title row between">
                    <strong>{r.name}</strong>
                    <small className="muted">★ {r.stars ?? 0}</small>
                  </div>
                  {r.description && (
                    <div className="repo-desc">{r.description}</div>
                  )}
                  <div className="chip-row" style={{ marginTop: 6 }}>
                    {r.language && <span className="chip">{r.language}</span>}
                    {(r.topics || []).slice(0, 3).map((t) => (
                      <span key={t} className="chip">
                        {t}
                      </span>
                    ))}
                  </div>
                  <div className="repo-meta" style={{ marginTop: 6 }}>
                    {r.forks ?? 0} forks · pushed{" "}
                    {r.pushed_at
                      ? new Date(r.pushed_at).toLocaleDateString()
                      : "-"}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* When neither GH nor CP is set, offer a hint instead of an empty modal */}
        {!hasGh &&
          !hasCpHandles &&
          cpStats.length === 0 &&
          repos.length === 0 && (
            <div
              className="card"
              style={{ marginTop: 12, textAlign: "center", padding: 16 }}
            >
              <div className="muted" style={{ marginBottom: 6 }}>
                No GitHub or CP handles linked yet for this profile.
              </div>
              <button
                className="small primary"
                onClick={() => setEditMode(true)}
              >
                Add handles
              </button>
            </div>
          )}
      </div>
    </div>
  );
}

function CpStatCard({ cp }) {
  const s = typeof cp.stats === "string" ? safeJson(cp.stats) : cp.stats || {};
  const hasError = !!cp.error;
  return (
    <div className="card" style={{ marginTop: 6 }}>
      <div className="row between">
        <strong>{cp.platform}</strong>
        <small className="muted">
          {cp.handle ? `@${cp.handle}` : "no handle"}
          {cp.fetched_at && (
            <> · {new Date(cp.fetched_at + "Z").toLocaleString()}</>
          )}
        </small>
      </div>
      {hasError ? (
        <div className="error" style={{ marginTop: 4 }}>
          error: {cp.error}
        </div>
      ) : (
        <div className="cp-stat-chips">
          {s.rating != null && (
            <span className="cp-stat-chip">
              <small>rating</small>
              <strong>{s.rating}</strong>
              {s.maxRating ? (
                <small className="muted">max {s.maxRating}</small>
              ) : null}
            </span>
          )}
          {s.totalSolved != null && (
            <span className="cp-stat-chip">
              <small>solved</small>
              <strong>{s.totalSolved}</strong>
              {s.easy != null ? (
                <small className="muted">
                  {s.easy}E·{s.medium}M·{s.hard}H
                </small>
              ) : null}
            </span>
          )}
          {s.stars != null && (
            <span className="cp-stat-chip">
              <small>stars</small>
              <strong>{s.stars}★</strong>
            </span>
          )}
          {s.contests != null && (
            <span className="cp-stat-chip">
              <small>contests</small>
              <strong>{s.contests}</strong>
            </span>
          )}
          {s.rank && (
            <span className="cp-stat-chip">
              <small>rank</small>
              <strong>{s.rank}</strong>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
function safeJson(v) {
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

function HandleEdit({ person, onSaved }) {
  const [form, setForm] = useState({
    name: person.name || "",
    leetcode_username: person.leetcode_username || "",
    codeforces_username: person.codeforces_username || "",
    codechef_username: person.codechef_username || "",
  });
  async function save() {
    if (!form.name.trim()) return alert("Name is required");
    await api.people.upsert({ ...person, ...form });
    onSaved();
  }
  return (
    <div
      className="card"
      style={{ background: "var(--bg-elev-2)", marginBottom: 8 }}
    >
      <div className="form-row">
        <label>Display name</label>
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Arnav Singh Negi"
        />
      </div>
      <div className="grid-2">
        <div className="form-row">
          <label>LeetCode username</label>
          <input
            value={form.leetcode_username}
            onChange={(e) =>
              setForm({ ...form, leetcode_username: e.target.value })
            }
          />
        </div>
        <div className="form-row">
          <label>Codeforces handle</label>
          <input
            value={form.codeforces_username}
            onChange={(e) =>
              setForm({ ...form, codeforces_username: e.target.value })
            }
          />
        </div>
      </div>
      <div className="form-row">
        <label>CodeChef handle</label>
        <input
          value={form.codechef_username}
          onChange={(e) =>
            setForm({ ...form, codechef_username: e.target.value })
          }
        />
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="primary" onClick={save}>
          Save changes
        </button>
      </div>
    </div>
  );
}

// Find-and-merge UI for duplicate people. Lists groups of likely-same
// people, shows the matching signal (registration / handle / name), and
// lets you confirm each merge with a single click. The "primary" (most-
// complete row) becomes the keeper; the rest are merged into it. Repos +
// CP stats + submissions are reassigned to the keeper inside one DB tx.
// Topic-driven repo browser. Two parallel result rails:
//   1. From your people - repos cached locally for anyone you've added.
//   2. From the wider community - top stars on github.com for the same query.
// Quick chips below the search seed common topics. Click any card → opens
// the existing RepoDetailModal (Overview & Chat / Walkthrough / Compare).
const REPO_TOPIC_QUICK = [
  "react",
  "next.js",
  "tauri",
  "electron",
  "rust",
  "blockchain",
  "linear regression",
  "transformer",
  "computer vision",
  "rag",
  "fastapi",
  "redis",
  "graph",
];
function RepoTopicSearch({ onOpenRepo }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [localRows, setLocalRows] = useState([]);
  const [publicRows, setPublicRows] = useState([]);
  const [loadingLocal, setLoadingLocal] = useState(false);
  const [loadingPublic, setLoadingPublic] = useState(false);
  const [err, setErr] = useState(null);
  // Semantic-summary build state - when the user clicks "Build summaries"
  // we kick off a batch summarize and stream per-repo progress here so
  // the UI shows the queue burning down.
  const [stats, setStats] = useState(null); // { total, withSummary, stale }
  const [summarizing, setSummarizing] = useState(false);
  const [progress, setProgress] = useState(null); // { i, total, current }

  // Load stats once + subscribe to per-repo progress while building.
  useEffect(() => {
    api.repo
      .summarizeStats?.()
      .then((r) => r && setStats(r))
      .catch(() => {});
    const off = api.repo.onSummarizeProgress?.((info) => setProgress(info));
    return () => {
      try {
        off?.();
      } catch {}
    };
  }, []);

  async function buildSummaries(force = false) {
    setSummarizing(true);
    setProgress(null);
    try {
      const r = await api.repo.summarizeAll({ force, max: 20 });
      if (r?.ok) {
        // Refresh stats and re-trigger the current search so semantic
        // matches show up immediately.
        const s = await api.repo.summarizeStats();
        setStats(s);
        if (debounced) {
          const local = await api.repo.searchLocal(debounced, 60);
          setLocalRows(Array.isArray(local) ? local : []);
        }
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setSummarizing(false);
      setProgress(null);
    }
  }

  // Debounce typing → search.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!debounced) {
      setLocalRows([]);
      setPublicRows([]);
      return;
    }
    let cancelled = false;
    setLoadingLocal(true);
    setLoadingPublic(true);
    setErr(null);
    api.repo
      .searchLocal(debounced, 60)
      .then((r) => {
        if (!cancelled) setLocalRows(Array.isArray(r) ? r : []);
      })
      .finally(() => !cancelled && setLoadingLocal(false));
    api.repo
      .searchPublic(debounced, { mode: "free", limit: 12 })
      .then((r) => {
        if (cancelled) return;
        if (r?.ok) setPublicRows(r.items || []);
        else setErr(r?.error || "GitHub search failed");
      })
      .finally(() => !cancelled && setLoadingPublic(false));
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  function openLocal(r) {
    onOpenRepo?.(
      {
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
      {
        id: r.person_id,
        name: r.person_name,
        github_username: r.person_handle,
        avatar_url: r.person_avatar,
      },
    );
  }

  return (
    <div className="repo-topic-search">
      <div className="repo-topic-search-bar">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a topic, framework, idea… (e.g. linear regression, blockchain, rag)"
          className="repo-topic-search-input"
        />
        {q && (
          <button
            className="ghost xsmall"
            onClick={() => setQ("")}
            title="Clear"
          >
            ✕
          </button>
        )}
      </div>

      {/* Semantic-summary status + builder. The local search hay
          already folds the stored AI summaries into the match, so
          having more repos summarised = better non-keyword hits. */}
      {stats && stats.total > 0 && (
        <div className="repo-topic-stats">
          <small className="muted">
            <strong>{stats.withSummary}</strong> of{" "}
            <strong>{stats.total}</strong> repos summarised
            {stats.stale > 0 && <> · {stats.stale} stale</>}
          </small>
          <div className="row" style={{ gap: 6 }}>
            {summarizing && progress && (
              <small className="muted">
                <span className="spinner" aria-hidden />{" "}
                {progress.current ? `Summarising ${progress.current}` : "…"}
                {progress.total ? ` · ${progress.i + 1}/${progress.total}` : ""}
              </small>
            )}
            {stats.stale > 0 && !summarizing && (
              <button
                type="button"
                className="ghost xsmall"
                onClick={() => buildSummaries(false)}
                title="Summarise the stale ones - runs through Ollama, ~30s each"
              >
                Build summaries
              </button>
            )}
            {!summarizing && stats.stale === 0 && stats.total > 0 && (
              <button
                type="button"
                className="ghost xsmall"
                onClick={() => buildSummaries(true)}
                title="Re-summarise everything, even if cached"
              >
                Rebuild all
              </button>
            )}
          </div>
        </div>
      )}

      {!debounced && (
        <div className="repo-topic-quick">
          <small className="muted">Try:</small>
          {REPO_TOPIC_QUICK.map((t) => (
            <button
              key={t}
              type="button"
              className="chip"
              onClick={() => setQ(t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {debounced && (
        <div className="repo-topic-results">
          {/* From your people */}
          <div className="repo-topic-col">
            <div className="repo-topic-col-head">
              <strong>From your people</strong>
              <small className="muted">
                {loadingLocal
                  ? "…"
                  : `${localRows.length} match${localRows.length === 1 ? "" : "es"}`}
              </small>
            </div>
            {loadingLocal && (
              <div className="spinner-row">
                <span className="spinner" aria-hidden />
                <span>Searching cache…</span>
              </div>
            )}
            {!loadingLocal && localRows.length === 0 && (
              <div className="muted" style={{ padding: 12, fontSize: 12 }}>
                Nobody in your list has a repo matching this yet.
              </div>
            )}
            {localRows.slice(0, 12).map((r) => (
              <button
                key={r.id}
                type="button"
                className="repo-topic-card"
                onClick={() => openLocal(r)}
                title={r.full_name}
              >
                <div className="row between">
                  <strong>{r.name}</strong>
                  <small className="muted">★ {r.stars || 0}</small>
                </div>
                <small className="muted repo-topic-card-desc">
                  {r.description || "(no description)"}
                </small>
                <div
                  className="row"
                  style={{ gap: 4, marginTop: 4, flexWrap: "wrap" }}
                >
                  <span className="pill teal">
                    @{r.person_handle || r.person_name}
                  </span>
                  {r.language && (
                    <span className="pill gray">{r.language}</span>
                  )}
                  {(r.topics || []).slice(0, 3).map((t) => (
                    <span key={t} className="pill" style={{ fontSize: 10 }}>
                      {t}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>

          {/* From the wider community */}
          <div className="repo-topic-col">
            <div className="repo-topic-col-head">
              <strong>From GitHub · public</strong>
              <small className="muted">
                {loadingPublic ? "…" : `top ${publicRows.length}`}
              </small>
            </div>
            {loadingPublic && (
              <div className="spinner-row">
                <span className="spinner" aria-hidden />
                <span>Searching GitHub…</span>
              </div>
            )}
            {err && (
              <div className="error" style={{ fontSize: 12 }}>
                {err}
              </div>
            )}
            {!loadingPublic && publicRows.length === 0 && !err && (
              <div className="muted" style={{ padding: 12, fontSize: 12 }}>
                No public results.
              </div>
            )}
            {publicRows.map((r) => (
              <a
                key={r.id}
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="repo-topic-card"
                title={r.full_name}
              >
                <div className="row between">
                  <strong>{r.name}</strong>
                  <small className="muted">★ {r.stars || 0}</small>
                </div>
                <small className="muted repo-topic-card-desc">
                  {r.description || "(no description)"}
                </small>
                <div
                  className="row"
                  style={{ gap: 4, marginTop: 4, flexWrap: "wrap" }}
                >
                  <span className="pill gray">{r.owner}</span>
                  {r.language && (
                    <span className="pill" style={{ fontSize: 10 }}>
                      {r.language}
                    </span>
                  )}
                  {(r.topics || []).slice(0, 3).map((t) => (
                    <span key={t} className="pill" style={{ fontSize: 10 }}>
                      {t}
                    </span>
                  ))}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MergeDuplicatesModal({ onClose, onMerged }) {
  const [data, setData] = useState({ groups: [], placeholders: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("duplicates"); // duplicates | placeholders
  const [keeperByGroup, setKeeperByGroup] = useState({});
  const [doneIds, setDoneIds] = useState(new Set());
  // Per-person rename buffer keyed by person id.
  const [renames, setRenames] = useState({});

  async function load() {
    setLoading(true);
    setErr(null);
    setDoneIds(new Set());
    try {
      const res = await api.people.findDuplicates();
      // Backwards-compat: old API returned an array, new returns
      // { groups, placeholders }.
      const shaped = Array.isArray(res)
        ? { groups: res, placeholders: [] }
        : res && typeof res === "object"
          ? res
          : { groups: [], placeholders: [] };
      setData(shaped);
      const init = {};
      for (let i = 0; i < shaped.groups.length; i++) {
        init[i] = shaped.groups[i].members[0]?.id;
      }
      setKeeperByGroup(init);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function saveRename(member) {
    const next = (renames[member.id] || "").trim();
    if (!next || next === member.name) {
      setRenames((r) => {
        const c = { ...r };
        delete c[member.id];
        return c;
      });
      return;
    }
    try {
      // Pass the full row + new name so other columns (notes, tags, handles)
      // aren't wiped by the COALESCE-less UPDATE branch in upsertPerson.
      let tags = member.tags;
      if (typeof tags === "string") {
        try {
          tags = JSON.parse(tags);
        } catch {
          tags = [];
        }
      }
      await api.people.upsert({
        ...member,
        name: next,
        tags: Array.isArray(tags) ? tags : [],
      });
      // Reflect locally so the row repaints with the new name.
      setData((d) => ({
        ...d,
        groups: d.groups.map((g) => ({
          ...g,
          members: g.members.map((m) =>
            m.id === member.id ? { ...m, name: next } : m,
          ),
        })),
        placeholders: d.placeholders.map((g) => ({
          ...g,
          members: g.members.map((m) =>
            m.id === member.id ? { ...m, name: next } : m,
          ),
        })),
      }));
      setRenames((r) => {
        const c = { ...r };
        delete c[member.id];
        return c;
      });
    } catch (e) {
      setErr(e.message);
    }
  }

  async function deleteMember(member) {
    if (!window.confirm(`Delete ${member.name}? This cannot be undone.`))
      return;
    try {
      await api.people.delete(member.id);
      load();
    } catch (e) {
      setErr(e.message);
    }
  }

  async function mergeGroup(idx, list = data.groups) {
    const g = list[idx];
    if (!g) return;
    const keepId = keeperByGroup[idx] || g.members[0].id;
    const mergeIds = g.members.map((m) => m.id).filter((id) => id !== keepId);
    if (!mergeIds.length) return;
    setBusy(true);
    try {
      const r = await api.people.merge({ keepId, mergeIds });
      if (r?.ok) setDoneIds((s) => new Set(s).add(idx));
      else setErr(r?.error || "merge failed");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function mergeAll() {
    setBusy(true);
    for (let i = 0; i < data.groups.length; i++) {
      if (doneIds.has(i)) continue;
      const g = data.groups[i];
      const keepId = keeperByGroup[i] || g.members[0].id;
      const mergeIds = g.members.map((m) => m.id).filter((id) => id !== keepId);
      if (!mergeIds.length) continue;
      try {
        const r = await api.people.merge({ keepId, mergeIds });
        if (r?.ok) setDoneIds((s) => new Set(s).add(i));
      } catch {}
    }
    setBusy(false);
    onMerged?.();
  }

  const list = tab === "duplicates" ? data.groups : data.placeholders;
  const showCount = (data.placeholders || []).length;

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal wide merge-modal">
        <div className="row between" style={{ marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>Merge & clean people</h3>
            <small className="muted">
              Likely duplicates from LinkedIn, GitHub, and leaderboard imports.
            </small>
          </div>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Tabs - duplicates vs placeholder names. */}
        <div className="chip-row" style={{ marginBottom: 10 }}>
          <button
            className={"chip" + (tab === "duplicates" ? " active" : "")}
            onClick={() => setTab("duplicates")}
          >
            Duplicates · {data.groups.length}
          </button>
          <button
            className={"chip" + (tab === "placeholders" ? " active" : "")}
            onClick={() => setTab("placeholders")}
            disabled={showCount === 0}
            title={
              showCount === 0
                ? "No placeholder-name groups"
                : 'People imported with the same junk name (e.g. "syndicate") - fix their names so they stop being grouped together.'
            }
          >
            Fix names · {showCount}
          </button>
        </div>

        {loading && (
          <div className="spinner-block" style={{ padding: 28 }}>
            <span className="spinner lg" aria-hidden />
            <span>Scanning for duplicates…</span>
          </div>
        )}
        {err && <div className="error">{err}</div>}

        {!loading && list.length === 0 && tab === "duplicates" && (
          <div className="muted" style={{ padding: 24, textAlign: "center" }}>
            No likely duplicates found. Looking clean ✓
          </div>
        )}
        {!loading && list.length === 0 && tab === "placeholders" && (
          <div className="muted" style={{ padding: 24, textAlign: "center" }}>
            No placeholder-name groups.
          </div>
        )}

        {!loading && list.length > 0 && (
          <>
            {tab === "duplicates" && (
              <div className="row between" style={{ marginBottom: 10 }}>
                <small className="muted">
                  {list.length} group{list.length === 1 ? "" : "s"}
                  {" · "}
                  {doneIds.size} merged
                </small>
                <button
                  className="primary small"
                  onClick={mergeAll}
                  disabled={busy}
                >
                  {busy ? "Merging…" : "Merge all"}
                </button>
              </div>
            )}
            {tab === "placeholders" && (
              <div
                className="card"
                style={{
                  marginBottom: 10,
                  padding: "10px 12px",
                  background: "var(--bg-elev-2)",
                }}
              >
                <strong style={{ fontSize: 13 }}>What is this?</strong>
                <small
                  className="muted"
                  style={{ display: "block", marginTop: 4 }}
                >
                  Some imports saved every person under the same name (e.g.
                  "syndicate"). Click ✎ next to each row to give them their real
                  name - they'll stop being grouped after that.
                </small>
              </div>
            )}

            <div className="merge-modal-list">
              {list.map((g, i) => {
                const isDone = doneIds.has(i);
                return (
                  <div
                    key={i}
                    className="merge-group"
                    style={{
                      opacity: isDone ? 0.55 : 1,
                      borderColor: isDone ? "var(--ok)" : undefined,
                    }}
                  >
                    <div className="merge-group-head">
                      <strong>{g.members[0].name || "(no name)"}</strong>
                      <small className="muted">
                        {g.members.length} rows · matched on{" "}
                        {g.reasons.join(", ")}
                      </small>
                    </div>
                    {g.members.map((m) => {
                      let notes = {};
                      try {
                        notes = JSON.parse(m.notes || "{}");
                      } catch {}
                      const isKeeper = keeperByGroup[i] === m.id;
                      const isRenaming = m.id in renames;
                      const handles = [
                        m.github_username && `gh:${m.github_username}`,
                        m.leetcode_username && `lc:${m.leetcode_username}`,
                        m.linkedin_url && "linkedin",
                        notes.registration && `reg:${notes.registration}`,
                        notes.section && `§ ${notes.section}`,
                      ].filter(Boolean);
                      return (
                        <div
                          key={m.id}
                          className={"merge-row" + (isKeeper ? " keeper" : "")}
                        >
                          {tab === "duplicates" && (
                            <input
                              type="radio"
                              name={`keeper-${i}`}
                              checked={isKeeper}
                              disabled={isDone}
                              onChange={() =>
                                setKeeperByGroup({
                                  ...keeperByGroup,
                                  [i]: m.id,
                                })
                              }
                              title="Make this the kept row"
                              className="merge-row-radio"
                            />
                          )}
                          <div className="merge-row-body">
                            <div className="merge-row-name">
                              {isRenaming ? (
                                <>
                                  <input
                                    type="text"
                                    autoFocus
                                    value={renames[m.id]}
                                    onChange={(e) =>
                                      setRenames((r) => ({
                                        ...r,
                                        [m.id]: e.target.value,
                                      }))
                                    }
                                    onBlur={() => saveRename(m)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") saveRename(m);
                                      else if (e.key === "Escape")
                                        setRenames((r) => {
                                          const c = { ...r };
                                          delete c[m.id];
                                          return c;
                                        });
                                    }}
                                    className="merge-row-name-input"
                                  />
                                </>
                              ) : (
                                <>
                                  <strong className="merge-row-name-text">
                                    {m.name}
                                  </strong>
                                  <div className="row" style={{ gap: 4 }}>
                                    <button
                                      type="button"
                                      className="ghost xsmall"
                                      onClick={() =>
                                        setRenames((r) => ({
                                          ...r,
                                          [m.id]: m.name,
                                        }))
                                      }
                                      title="Rename this person"
                                    >
                                      ✎
                                    </button>
                                    <button
                                      type="button"
                                      className="ghost xsmall"
                                      style={{
                                        color: "#ef6b5a",
                                        padding: "0 6px",
                                      }}
                                      onClick={() => deleteMember(m)}
                                      title="Delete this person"
                                    >
                                      🗑
                                    </button>
                                  </div>
                                </>
                              )}
                              {isKeeper && tab === "duplicates" && (
                                <span className="pill teal merge-row-pill">
                                  keep
                                </span>
                              )}
                              {m.source && (
                                <span className="pill gray merge-row-pill">
                                  {m.source}
                                </span>
                              )}
                            </div>
                            <div className="merge-row-handles">
                              {handles.length
                                ? handles.join("  ·  ")
                                : "(no handles)"}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {tab === "duplicates" && (
                      <div className="merge-group-actions">
                        <button
                          className="ghost xsmall"
                          onClick={() => mergeGroup(i)}
                          disabled={isDone || busy}
                          title={`Merge ${g.members.length - 1} into the kept row`}
                        >
                          {isDone ? "✓ Merged" : "Merge this group"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="row between" style={{ marginTop: 10 }}>
              <small className="muted">
                {tab === "duplicates"
                  ? "Merging combines handles, tags, links, repos, CP stats - keeper wins on conflicts."
                  : "Renaming will re-cluster this group on next scan."}
              </small>
              <div className="row" style={{ gap: 6 }}>
                <button className="ghost" onClick={load} disabled={busy}>
                  ↻ Rescan
                </button>
                <button
                  className="ghost"
                  onClick={() => {
                    onMerged?.();
                    onClose();
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AddPersonModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    name: "",
    github_username: "",
    linkedin_url: "",
    tags: "",
    leetcode_username: "",
    codeforces_username: "",
    codechef_username: "",
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
      tags: form.tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    onSaved();
  }
  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <h3>Add person</h3>
        <div className="form-row">
          <label>Name</label>
          <input
            autoFocus
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label>GitHub username</label>
          <input
            value={form.github_username}
            onChange={(e) =>
              setForm({ ...form, github_username: e.target.value })
            }
          />
        </div>
        <div className="form-row">
          <label>LinkedIn URL</label>
          <input
            value={form.linkedin_url}
            onChange={(e) => setForm({ ...form, linkedin_url: e.target.value })}
          />
        </div>
        <div className="grid-2">
          <div className="form-row">
            <label>LeetCode</label>
            <input
              value={form.leetcode_username}
              onChange={(e) =>
                setForm({ ...form, leetcode_username: e.target.value })
              }
            />
          </div>
          <div className="form-row">
            <label>Codeforces</label>
            <input
              value={form.codeforces_username}
              onChange={(e) =>
                setForm({ ...form, codeforces_username: e.target.value })
              }
            />
          </div>
        </div>
        <div className="form-row">
          <label>CodeChef</label>
          <input
            value={form.codechef_username}
            onChange={(e) =>
              setForm({ ...form, codechef_username: e.target.value })
            }
          />
        </div>
        <div className="form-row">
          <label>Tags (comma-separated)</label>
          <input
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
            placeholder="e.g. classmate, lab:tesla, AI/ML"
          />
        </div>
        <div
          className="row"
          style={{ justifyContent: "flex-end", marginTop: 12 }}
        >
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={!form.name.trim()}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// Single-flow link import. NextTechLab is no longer a separate tab - its
// labs sit alongside any other preset as `{label, url}` pairs. Users can
// add their own presets via the "+ Add preset" row (persisted to
// localStorage). Multi-URL bulk scrape (e.g. all 5 NTL labs at once) is a
// single chip that ships with the built-in presets.
function ImportByLinkModal({ onClose, onImported }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  // Combined results - both single-URL previews and multi-URL bulk runs end
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
    setNewLabel("");
    setNewUrl("");
    setAdding(false);
  }
  function deletePreset(p) {
    if (!userPresets.find((x) => x.url === p.url && x.label === p.label))
      return;
    const next = userPresets.filter(
      (x) => !(x.url === p.url && x.label === p.label),
    );
    setUserPresets(next);
    saveUserLinkPresets(next);
  }

  async function runPreview(targetUrl = url) {
    const u = (targetUrl || "").trim();
    if (!u) return;
    setErr(null);
    setLoading(true);
    try {
      const res = await api.import.preview(u);
      if (!res.ok) setErr(res.error || "Preview failed");
      else {
        setResults((prev) => [
          ...prev,
          { source: res.source || u, candidates: res.candidates || [] },
        ]);
        const start = results.reduce((s, r) => s + r.candidates.length, 0);
        const next = new Set(picked);
        (res.candidates || []).forEach((_, i) => next.add(`${start + i}`));
        setPicked(next);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function runNtl4Bulk() {
    setErr(null);
    setLoading(true);
    try {
      const res = await api.import.previewNtl4();
      const newResults = [];
      Object.entries(res || {}).forEach(([k, r]) => {
        if (r?.ok)
          newResults.push({ source: k, candidates: r.candidates || [] });
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
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
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
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal wide" style={{ width: 820 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }}>Import people from links</h3>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="muted">
          Paste any URL (GitHub profile/org, LinkedIn, or any page that links to
          people). Apex extracts GitHub handles + LinkedIn URLs. Add your own
          preset URLs below for one-click runs later.
        </p>

        <div className="row" style={{ gap: 6 }}>
          <input
            autoFocus
            placeholder="https://github.com/octocat or any URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 1 }}
            onKeyDown={(e) => {
              if (e.key === "Enter") runPreview();
            }}
          />
          <button
            className="primary"
            onClick={() => runPreview()}
            disabled={loading || !url.trim()}
          >
            {loading ? "…" : "Preview"}
          </button>
        </div>

        {/* Preset chips - built-ins + user presets, with the bulk-scrape
            shortcut and an "+ Add preset" row that mirrors normal link
            convention (title + URL). */}
        <div style={{ marginTop: 12 }}>
          <div className="section-label" style={{ marginBottom: 6 }}>
            Presets
          </div>
          <div className="chip-row">
            {allPresets.map((p) => {
              const isUser = userPresets.some(
                (x) => x.url === p.url && x.label === p.label,
              );
              return (
                <span
                  key={p.url + ":" + p.label}
                  style={{ position: "relative", display: "inline-flex" }}
                >
                  <button
                    className="chip"
                    onClick={() => {
                      setUrl(p.url);
                      runPreview(p.url);
                    }}
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
              All NTL labs
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
            <div
              className="row"
              style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}
            >
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
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPreset();
                }}
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

        {err && (
          <div className="error" style={{ marginTop: 10 }}>
            {err}
          </div>
        )}

        {/* Candidate checklist */}
        {allRows.length > 0 && (
          <>
            <hr className="soft" />
            <div
              className="row between"
              style={{ alignItems: "center", margin: "10px 0" }}
            >
              <small className="muted">
                {allRows.length} candidates · {picked.size} selected
              </small>
              <div className="row" style={{ gap: 6 }}>
                <button
                  className="ghost small"
                  onClick={() => setPicked(new Set(allRows.map((r) => r.key)))}
                >
                  Select all
                </button>
                <button
                  className="ghost small"
                  onClick={() => setPicked(new Set())}
                >
                  Clear
                </button>
              </div>
            </div>
            <div
              style={{
                maxHeight: 380,
                overflowY: "auto",
                marginTop: 10,
                paddingRight: 4,
              }}
            >
              {allRows.map(({ key, c, source }) => (
                <label
                  key={key}
                  className="todo-row"
                  style={{
                    cursor: "pointer",
                    alignItems: "center",
                    padding: "12px 8px",
                    borderRadius: "var(--r-md)",
                    transition: "background 100ms",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(key)}
                    onChange={(e) => {
                      const n = new Set(picked);
                      if (e.target.checked) n.add(key);
                      else n.delete(key);
                      setPicked(n);
                    }}
                    style={{ marginTop: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      className="title"
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      {c.name || c.github_username || c.linkedin_url}
                      {c.role && (
                        <span
                          className="pill amber"
                          style={{ fontSize: "9px", padding: "1px 6px" }}
                        >
                          {c.role}
                        </span>
                      )}
                    </div>
                    <div
                      className="sub"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      {source && (
                        <span className="pill gray" style={{ fontSize: "9px" }}>
                          {source}
                        </span>
                      )}
                      {c.github_username && <span>@{c.github_username}</span>}
                      {c.linkedin_url && <span>· linkedin</span>}
                      {c.reg_number && (
                        <span className="mono" style={{ opacity: 0.8 }}>
                          · {c.reg_number}
                        </span>
                      )}
                      {c.lab && (
                        <span className="pill teal" style={{ fontSize: "9px" }}>
                          {c.lab}
                        </span>
                      )}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </>
        )}

        <div
          className="row"
          style={{ justifyContent: "flex-end", marginTop: 14, gap: 6 }}
        >
          <button onClick={onClose}>Close</button>
          <button
            className="primary"
            onClick={commit}
            disabled={picked.size === 0}
          >
            Import {picked.size}
          </button>
        </div>
      </div>
    </div>
  );
}

// Combined leaderboard: single card listing all three platforms side-by-side,
// with weekly deltas and streaks where available. Replaces the three separate
// modals.
function LeaderboardModal({ onClose }) {
  const [data, setData] = useState({
    leetcode: null,
    codeforces: null,
    codechef: null,
  });
  const [sort, setSort] = useState("leetcode-combined"); // platform-mode key
  const [loading, setLoading] = useState(true);
  // CP summaries - keyed per person_id. Each entry is the result of
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
        const cur = map.get(r.person_id) || {
          person_id: r.person_id,
          person_name: r.person_name,
          avatar_url: r.avatar_url,
        };
        cur[plat] = r;
        map.set(r.person_id, cur);
      }
    }
    const all = [...map.values()];
    // Sort key like "leetcode-combined" / "codeforces" - split into platform
    // + mode, then read whichever pre-computed field the row exposes.
    const [platform, mode = "rating"] = sort.split("-");
    all.sort((a, b) => {
      const av = leaderboardMetric(a[platform], mode) ?? -1;
      const bv = leaderboardMetric(b[platform], mode) ?? -1;
      return bv - av;
    });
    return all;
  }, [data, sort]);

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal wide" style={{ width: 820 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }}>Leaderboard · LC / CF / CC</h3>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="chip-row" style={{ marginTop: 8 }}>
          <small className="muted">Rank by</small>
          {[
            {
              key: "leetcode-combined",
              label: "LC combined",
              platform: "leetcode",
              mode: "combined",
            },
            {
              key: "leetcode-solved",
              label: "LC solved",
              platform: "leetcode",
              mode: "solved",
            },
            {
              key: "leetcode-rating",
              label: "LC contest",
              platform: "leetcode",
              mode: "rating",
            },
            {
              key: "codeforces",
              label: "CF rating",
              platform: "codeforces",
              mode: "rating",
            },
            {
              key: "codechef",
              label: "CC rating",
              platform: "codechef",
              mode: "rating",
            },
          ].map((p) => (
            <button
              key={p.key}
              className={"chip" + (sort === p.key ? " active" : "")}
              onClick={() => setSort(p.key)}
              title={
                p.platform === "leetcode" && p.mode === "combined"
                  ? "totalSolved + contestRating × 0.1 (mixes grind + contest skill)"
                  : undefined
              }
            >
              {p.label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="muted" style={{ padding: 12 }}>
            Loading…
          </div>
        )}
        {!loading && rows.length === 0 && (
          <div className="muted" style={{ padding: 12 }}>
            No data. Add CP handles in People and sync.
          </div>
        )}

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
                      : "Summarise"}
                </button>
              </div>
              {summary && summary.ok && (
                <div className="cp-summary-block">
                  {summary.summary && (
                    <p className="cp-summary-text">{summary.summary}</p>
                  )}
                  {Array.isArray(summary.topics) &&
                    summary.topics.length > 0 && (
                      <div className="cp-summary-row">
                        <small className="muted cp-summary-label">Topics</small>
                        <div className="chip-row">
                          {summary.topics.slice(0, 6).map((t, k) => (
                            <span key={k} className="pill">
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  {Array.isArray(summary.strengths) &&
                    summary.strengths.length > 0 && (
                      <div className="cp-summary-row">
                        <small className="muted cp-summary-label">
                          Strong in
                        </small>
                        <div className="chip-row">
                          {summary.strengths.slice(0, 4).map((s, k) => (
                            <span key={k} className="pill teal">
                              {s}
                            </span>
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

function leaderboardMetric(r, mode) {
  if (!r) return null;
  // The DB layer pre-computes combinedScore + promotes rating/totalSolved
  // to the top level so we don't have to dig into stats on every sort.
  if (mode === "combined") return r.combinedScore ?? r.totalSolved ?? null;
  if (mode === "rating") return r.rating ?? null;
  if (mode === "solved") return r.totalSolved ?? r.stats?.totalSolved ?? null;
  return r.combinedScore ?? r.totalSolved ?? null;
}
function statCell(r, plat) {
  if (!r) return "-";
  if (r.error) return <span className="error">{r.error}</span>;
  const s = r.stats || {};
  if (plat === "leetcode") {
    const solved =
      s.totalSolved != null
        ? `${s.totalSolved} (${s.easy || 0}/${s.medium || 0}/${s.hard || 0})`
        : "-";
    const rating = s.rating ? ` · ${s.rating}` : "";
    const contests = s.contests ? ` · ${s.contests} contests` : "";
    return solved + rating + contests;
  }
  if (plat === "codeforces")
    return s.rating != null
      ? `${s.rating}${s.maxRating ? ` (max ${s.maxRating})` : ""}${s.totalSolved ? ` · ${s.totalSolved} solved` : ""}`
      : "-";
  if (plat === "codechef")
    return s.rating != null
      ? `${s.rating}${s.stars ? ` · ${s.stars}★` : ""}`
      : "-";
  return "-";
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
  // Tabs: chat (default - overview lives inside as a context card) |
  // walkthrough | compare. The standalone Overview tab is gone; its
  // content now sits at the top of Chat so users get one combined view.
  const [tab, setTab] = useState("chat");
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
        // - the failure is informative.
      } else {
        setChatHistory((h) => [
          ...h,
          { role: "assistant", content: res.reply || "(empty reply)" },
        ]);
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
        if (savedModel && (mResp?.models || []).includes(savedModel))
          setModel(savedModel);
        else if (mResp?.models?.length) setModel(mResp.models[0]);
        // If we already have a cached summary, show it.
        // The IPC returns `{ ok, ...detail, cached, cachedModel }` where
        // `cached` is the previously-saved Ollama JSON payload.
        if (d?.cached) {
          setAiSummary(d.cached);
          if (d.cachedModel) setModel(d.cachedModel);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [repo.id]);

  async function runSummary() {
    setAiLoading(true);
    setAiErr(null);
    setAiSummary(null);
    const res = await api.repo.summarize({ repoId: repo.id, model });
    setAiLoading(false);
    if (!res?.ok) setAiErr(res?.error || "Ollama error");
    else setAiSummary(res);
  }

  const tech = useMemo(() => {
    if (!detail) return [];
    const langs = detail.languages || {};
    const total = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(langs)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ name: k, pct: Math.round((v / total) * 100) }));
  }, [detail]);

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal wide" style={{ width: 900 }}>
        <div className="row between">
          <div>
            <h3 style={{ margin: 0 }}>{repo.name}</h3>
            <small className="muted">
              by {person.name}
              {" · "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  api.ext.open(repo.url);
                }}
              >
                {repo.url}
              </a>
            </small>
          </div>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        {repo.description && (
          <p style={{ marginTop: 10 }}>{repo.description}</p>
        )}
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="pill">★ {repo.stars ?? 0}</span>
          <span className="pill">{repo.forks ?? 0} forks</span>
          {repo.language && <span className="pill">{repo.language}</span>}
          {(repo.topics || []).slice(0, 6).map((t) => (
            <span key={t} className="pill gray">
              {t}
            </span>
          ))}
          <span className="pill gray">
            pushed{" "}
            {repo.pushed_at
              ? new Date(repo.pushed_at).toLocaleDateString()
              : "-"}
          </span>
        </div>

        {/* Tab strip - overview vs. project chat. Chat has read-access to
            the same context the AI summary uses, so the user can ask
            grounded questions like "what does it actually do?" or
            "where is auth handled?". */}
        <div className="repo-modal-tabs" style={{ marginTop: 12 }}>
          <button
            type="button"
            className={"today-tab" + (tab === "chat" ? " active" : "")}
            onClick={() => setTab("chat")}
            title="Project overview + Q&A grounded in the repo"
          >
            Overview & Chat{" "}
            {chatHistory.length > 0
              ? `· ${Math.ceil(chatHistory.length / 2)}`
              : ""}
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
          <RepoWalkthroughPanel repo={repo} ollamaOk={ollamaOk} model={model} />
        ) : tab === "compare" ? (
          <RepoComparePanel repo={repo} />
        ) : (
          // Overview & Chat - single combined view. Overview content sits
          // inside a collapsible card so the chat input is always within
          // reach without losing access to the project facts.
          <>
            {loading && (
              <div className="spinner-row" style={{ marginTop: 14 }}>
                <span className="spinner" aria-hidden />
                <span>Loading project detail…</span>
              </div>
            )}
            {detail && (
              <RepoOverviewCard defaultOpen={!aiSummary && !aiLoading}>
                <>
                  {/* Tech stack bar */}
                  {tech.length > 0 && (
                    <>
                      <div className="section-label" style={{ marginTop: 14 }}>
                        Tech stack
                      </div>
                      <div
                        className="lang-bar"
                        title={tech
                          .map((t) => `${t.name} ${t.pct}%`)
                          .join(" · ")}
                      >
                        {tech.map((t, i) => (
                          <div
                            key={t.name}
                            className={`lang-seg seg-${i % 6}`}
                            style={{ width: `${t.pct}%` }}
                            title={`${t.name} ${t.pct}%`}
                          >
                            <small>
                              {t.name} {t.pct}%
                            </small>
                          </div>
                        ))}
                      </div>
                      <div className="lang-legend">
                        {tech.map((t, i) => (
                          <span
                            key={t.name}
                            className={`lang-dot seg-${i % 6}`}
                          >
                            <i />
                            {t.name} <small className="muted">{t.pct}%</small>
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  {/* AI summary */}
                  <div className="section-label" style={{ marginTop: 14 }}>
                    Overview
                  </div>
                  <div
                    className="card"
                    style={{ background: "var(--bg-elev-2)" }}
                  >
                    {!aiSummary && !aiLoading && (
                      <div className="ai-summary-empty">
                        <div>
                          <strong>What is this project?</strong>
                          <small className="muted" style={{ display: "block" }}>
                            One-paragraph read: architecture, stack, and what's
                            worth stealing.
                          </small>
                        </div>
                        <div className="row" style={{ gap: 6 }}>
                          <select
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            style={{ maxWidth: 160 }}
                          >
                            {models.length === 0 && (
                              <option value="">(no models)</option>
                            )}
                            {models.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                          <button
                            className="primary small"
                            onClick={runSummary}
                            disabled={!ollamaOk || !model}
                          >
                            Summarise
                          </button>
                        </div>
                      </div>
                    )}
                    {aiLoading && (
                      <div
                        className="muted"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <span className="pulse" /> Reading the repo…
                      </div>
                    )}
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
                          <p className="ai-summary-lead">
                            {aiSummary.oneliner}
                          </p>
                        )}
                        {aiSummary.architecture && (
                          <div className="ai-summary-block">
                            <div className="section-label">Architecture</div>
                            <p className="ai-summary-text">
                              {aiSummary.architecture}
                            </p>
                          </div>
                        )}
                        {Array.isArray(aiSummary.tech_stack) &&
                          aiSummary.tech_stack.length > 0 && (
                            <div className="ai-summary-block">
                              <div className="section-label">Tech stack</div>
                              <div className="chip-row">
                                {aiSummary.tech_stack.map((t, i) => (
                                  <span key={i} className="chip">
                                    {t}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        {Array.isArray(aiSummary.things_to_learn) &&
                          aiSummary.things_to_learn.length > 0 && (
                            <div className="ai-summary-block">
                              <div className="section-label">
                                Worth learning
                              </div>
                              <ul className="ai-summary-list">
                                {aiSummary.things_to_learn.map((l, i) => (
                                  <li key={i}>{l}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        {Array.isArray(aiSummary.similar_mine) &&
                          aiSummary.similar_mine.length > 0 && (
                            <div className="ai-summary-block">
                              <div className="section-label">
                                Similar to things you've built
                              </div>
                              <ul className="ai-summary-list">
                                {aiSummary.similar_mine.map((s, i) => (
                                  <li key={i}>{s}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        {aiSummary.starter_project && (
                          <div className="ai-summary-block">
                            <div className="section-label">
                              Starter project idea
                            </div>
                            <p className="ai-summary-text">
                              {aiSummary.starter_project}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* README preview */}
                  {detail.readme && (
                    <>
                      <div className="section-label" style={{ marginTop: 14 }}>
                        README
                      </div>
                      <div className="readme-md">
                        <MarkdownBlock
                          text={
                            detail.readme.slice(0, 8000) +
                            (detail.readme.length > 8000
                              ? "\n\n_…truncated_"
                              : "")
                          }
                        />
                      </div>
                    </>
                  )}

                  {/* Recent commits */}
                  {Array.isArray(detail.recentCommits) &&
                    detail.recentCommits.length > 0 && (
                      <>
                        <div
                          className="section-label"
                          style={{ marginTop: 14 }}
                        >
                          Recent commits
                        </div>
                        {detail.recentCommits.slice(0, 8).map((c, i) => (
                          <div
                            key={i}
                            className="sub"
                            style={{ margin: "4px 0" }}
                          >
                            <code>{c.sha?.slice(0, 7)}</code>{" "}
                            {c.message?.split("\n")[0]}
                            <small className="muted">
                              {" "}
                              ·{" "}
                              {c.at ? new Date(c.at).toLocaleDateString() : ""}
                            </small>
                          </div>
                        ))}
                      </>
                    )}
                </>
              </RepoOverviewCard>
            )}

            {/* Chat - always present below the overview so users can ask
            questions without changing tabs. */}
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
              onClear={() => {
                setChatHistory([]);
                setChatErr(null);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

// Collapsible overview card - sits above Chat in the merged tab. Default
// collapsed state shows a one-line "summary strip"; expanded shows the
// full Overview content (tech stack, AI summary, repo links, etc.).
function RepoOverviewCard({ children, defaultOpen = false }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div
      className="card"
      style={{
        marginTop: 12,
        marginBottom: 14,
        background: "var(--bg-elev)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          width: "100%",
          padding: "2px 0",
        }}
      >
        <div className="card-title" style={{ margin: 0 }}>
          Overview
        </div>
        <small className="muted">{open ? "▾ hide" : "▸ show details"}</small>
      </button>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
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
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
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
        <span />
        <div className="row" style={{ gap: 6 }}>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            disabled={!ollamaOk || models.length === 0}
            style={{ maxWidth: 200 }}
            title="Local Ollama model — answers use the README, file tree, manifests & recent commits"
          >
            {models.length === 0 && <option value="">(no models)</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {history.length > 0 && (
            <button
              className="ghost xsmall"
              onClick={onClear}
              title="Clear conversation"
            >
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
            ollamaOk ? "Ask anything about this project…" : "Ollama is offline"
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
  const [fullscreen, setFullscreen] = React.useState(false);
  // Esc exits fullscreen.
  React.useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // Build the deterministic guided tour. Each step has a `path` AND a
  // `purpose` label - the model uses the purpose to give a focused
  // explanation, and the user sees it in the toolbar so they know WHY
  // we're at this file. Order encodes a logical reading flow:
  //   1. Orientation (README, manifest)  - "what is this project"
  //   2. Entry point (src/index.*, main.*)  - "where execution starts"
  //   3. Core layers (App, router, server) - "the wiring"
  //   4. Representative source files from the rest  - "the surface area"
  // Files never repeat in the tour. At the end the user gets a "How it
  // all fits together?" recap prompt.
  const tourPlan = React.useMemo(() => {
    const paths = tree.map((p) => p.path);
    if (!paths.length) return [];
    const taken = new Set();
    const steps = [];
    const add = (p, purpose) => {
      if (p && !taken.has(p)) {
        taken.add(p);
        steps.push({ path: p, purpose });
      }
    };

    // 1) Orientation files.
    const orient = [
      [
        /^README(\.md|\.rst|\.txt)?$/i,
        "Orientation - README, the project's pitch",
      ],
      [/^package\.json$/, "Orientation - package manifest"],
      [/^pyproject\.toml$/, "Orientation - Python project manifest"],
      [/^requirements\.txt$/, "Orientation - dependency list"],
      [/^Cargo\.toml$/, "Orientation - Rust manifest"],
      [/^go\.mod$/, "Orientation - Go modules"],
    ];
    for (const [re, why] of orient) {
      const m = paths.find((p) => re.test(p));
      if (m) add(m, why);
    }

    // 2) Entry points.
    const entries = [
      [/^src\/index\.(jsx?|tsx?|mjs|cjs)$/, "Entry - JS bootstrap"],
      [/^src\/main\.(jsx?|tsx?|py|go|rs|java|kt|c|cpp)$/, "Entry - main()"],
      [/^src\/App\.(jsx?|tsx?)$/, "Core - root component"],
      [/^index\.(jsx?|tsx?|html|py|js)$/, "Entry - root file"],
      [/^main\.(py|go|rs|java|c|cpp)$/, "Entry - main()"],
      [/^app\.(jsx?|tsx?|py)$/, "Entry - app boot"],
      [/^server\.(jsx?|tsx?|py|go)$/, "Core - server"],
      [/^app\/page\.(jsx?|tsx?)$/, "Core - Next.js root page"],
      [/^app\/layout\.(jsx?|tsx?)$/, "Core - Next.js root layout"],
      [/^pages\/_app\.(jsx?|tsx?)$/, "Core - Next.js _app shell"],
    ];
    for (const [re, why] of entries) {
      const m = paths.find((p) => re.test(p));
      if (m) add(m, why);
    }

    // 3) Surface area - one or two files per meaningful folder.
    const noise =
      /(^|\/)(node_modules|dist|build|\.next|\.cache|coverage|vendor|target|venv|__pycache__|tests?|spec|docs?|examples?|fixtures|assets|public|images?)\//i;
    const codeExt =
      /\.(jsx?|tsx?|py|go|rs|java|kt|c|cpp|h|hpp|rb|php|cs|swift|sh|cjs|mjs|svelte|vue)$/i;
    const folders = new Map();
    for (const p of paths) {
      if (noise.test(p)) continue;
      if (!codeExt.test(p)) continue;
      const dir = p.split("/").slice(0, 2).join("/");
      if (!folders.has(dir)) folders.set(dir, []);
      folders.get(dir).push(p);
    }
    const prefer = (a, b) => {
      const score = (s) =>
        /\b(main|index|core|app|router|server|cli|entry)\b/i.test(s) ? 1 : 0;
      return score(b) - score(a) || a.localeCompare(b);
    };
    for (const [dir, list] of folders.entries()) {
      list.sort(prefer);
      add(list[0], `Surface - ${dir}/`);
      if (list.length > 4) add(list[1], `Surface - ${dir}/ (more)`);
    }
    return steps.slice(0, 12);
  }, [tree]);

  // Backward-compatible flat list for indexing.
  const essentialFiles = React.useMemo(
    () => tourPlan.map((s) => s.path),
    [tourPlan],
  );
  const currentStep = tourPlan.find((s) => s.path === currentPath) || null;

  const essentialIdx = essentialFiles.indexOf(currentPath);
  const canPrev = essentialIdx > 0;
  const canNext = essentialIdx >= 0 && essentialIdx < essentialFiles.length - 1;
  const goPrev = () => canPrev && walkTo(essentialFiles[essentialIdx - 1]);
  const goNext = () => canNext && walkTo(essentialFiles[essentialIdx + 1]);

  // Load tree on mount, then auto-walk to the first essential file.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.repo.tree(repo.full_name);
        if (!cancelled && r?.ok) setTree(r.paths || []);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.full_name]);
  // Auto-walk to the entry once the essential list is ready.
  React.useEffect(() => {
    if (currentPath || !essentialFiles.length) return;
    walkTo(essentialFiles[0], []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [essentialFiles.length]);

  async function walkTo(path, prevVisited = visited) {
    if (!path) return;
    setBusy(true);
    setErr(null);
    setCurrentPath(path);
    setContent("");
    setExplanation(null);
    try {
      const idx = tourPlan.findIndex((s) => s.path === path);
      const r = await api.repo.walkthrough({
        repoId: repo.id,
        fullName: repo.full_name,
        filePath: path,
        visitedPaths: prevVisited,
        tourPlan: tourPlan.length ? tourPlan : null,
        stepIndex: idx,
        model,
      });
      if (!r?.ok) {
        setErr(r?.error || "walkthrough failed");
      } else {
        setContent(r.fileContent || "");
        setExplanation(r.content || r.text || r.summary || "");
        setVisited((prev) => (prev.includes(path) ? prev : [...prev, path]));
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // End-of-tour synthesis. Triggered by the "How it all fits together"
  // button when the user has reached the last step.
  async function askRecap() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.repo.walkthroughRecap({
        repoId: repo.id,
        fullName: repo.full_name,
        tourPlan,
        model,
      });
      if (r?.ok) {
        const text = r.content || r.text || "";
        setQaHistory((h) => [
          ...h,
          { role: "user", content: "How does it all fit together?" },
          { role: "assistant", content: text },
        ]);
      } else {
        setErr(r?.error || "recap failed");
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Pull "Look at next: <path>" from the explanation if present. The model
  // wraps the marker in **bold** and the path in `inline-code`, so we
  // skip those formatting characters explicitly. Validate the result is
  // a plausible file path before returning it (otherwise Jump → goes to
  // garbage like "**" or the literal placeholder text).
  function suggestedNext() {
    if (!explanation) return null;
    // Match: "Look at next:" optionally followed by ** (bold close) and
    // a backtick, then capture the path inside backticks OR up to space.
    const re = /look\s+at\s+next\s*:?\s*\**\s*`?([^\s`\n*]+)/i;
    const m = explanation.match(re);
    if (!m) return null;
    let path = m[1].replace(/[.,)]+$/, "").trim();
    // Reject obvious garbage: pure punctuation, or a "<placeholder>".
    if (!path || /^[*<>{}\[\]()_`-]+$/.test(path)) return null;
    if (/^<.+>$/.test(path)) return null;
    // Must look like a path: at least a slash OR a known file extension.
    const looksLikePath =
      path.includes("/") ||
      /\.(jsx?|tsx?|py|go|rs|java|kt|c|cpp|h|hpp|rb|php|cs|swift|sh|cjs|mjs|svelte|vue|html|css|md|json|toml|yaml|yml|ya?ml|lock|env)$/i.test(
        path,
      );
    if (!looksLikePath) return null;
    // And it should actually exist in the tree we know about.
    if (tree.length && !tree.some((t) => t.path === path)) {
      // Try a relaxed match (basename only) before giving up.
      const base = path.split("/").pop();
      const hit = tree.find(
        (t) => t.path.endsWith("/" + base) || t.path === base,
      );
      if (hit) return hit.path;
      return null;
    }
    return path;
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
    <div className={"repo-walkthrough" + (fullscreen ? " fullscreen" : "")}>
      {/* Toolbar - < / > cycle through the essential-files tour, then the
          current file path, then a progress bar of the tour, then a "next
          suggested" jump if the AI proposed one outside the tour. */}
      <div className="repo-walkthrough-toolbar">
        <button
          className="ghost xsmall"
          onClick={goPrev}
          disabled={!canPrev || busy}
          title={
            canPrev
              ? `Previous: ${essentialFiles[essentialIdx - 1]}`
              : "Already at the first essential file"
          }
        >
          ◀
        </button>
        <button
          className="ghost xsmall"
          onClick={goNext}
          disabled={!canNext || busy}
          title={
            canNext
              ? `Next: ${essentialFiles[essentialIdx + 1]}`
              : "End of the essential-files tour"
          }
        >
          ▶
        </button>
        <code className="repo-walk-path" title={currentPath || ""}>
          {currentPath || "(no file selected)"}
        </code>
        {currentStep && (
          <span
            className="pill"
            style={{
              fontSize: 10,
              background: "var(--accent-soft)",
              color: "var(--accent)",
            }}
            title="Why this file is in the tour"
          >
            {currentStep.purpose}
          </span>
        )}
        {tourPlan.length > 0 && essentialIdx >= 0 && (
          <small className="muted" title="Position in the planned tour">
            tour {essentialIdx + 1} / {tourPlan.length}
          </small>
        )}
        <div className="repo-walk-progress">
          <div
            className="repo-walk-progress-bar"
            style={{
              width: essentialFiles.length
                ? `${((essentialIdx + 1) / essentialFiles.length) * 100}%`
                : "0%",
            }}
          />
        </div>
        {next && next !== currentPath && (
          <button
            className="primary small"
            onClick={() => walkTo(next)}
            disabled={busy}
            title={`AI suggests: ${next}`}
          >
            Jump → {next.split("/").pop()}
          </button>
        )}
        <button
          className="ghost xsmall"
          onClick={() => setFullscreen((v) => !v)}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Expand to fullscreen"}
          style={{ marginLeft: 4 }}
        >
          {fullscreen ? "✕ Exit" : "⤢ Fullscreen"}
        </button>
      </div>

      <div className="repo-walkthrough-grid">
        {/* File tree */}
        <div className="repo-walk-tree">
          <div className="section-label">Files</div>
          {tree.length === 0 && (
            <div className="spinner-block" style={{ padding: "16px 8px" }}>
              <span className="spinner" aria-hidden />
              <small>Loading tree…</small>
            </div>
          )}
          {tree.map((p) => {
            const visited_ = visited.includes(p.path);
            const active = p.path === currentPath;
            return (
              <div
                key={p.path}
                onClick={() => walkTo(p.path)}
                title={p.path}
                className={
                  "repo-walk-tree-row" +
                  (active ? " active" : "") +
                  (visited_ ? " visited" : "")
                }
              >
                <span className="repo-walk-tree-mark">
                  {visited_ ? "●" : "○"}
                </span>
                <span className="repo-walk-tree-name">{p.path}</span>
              </div>
            );
          })}
        </div>

        {/* File viewer - spinner instead of bare "loading…" text. */}
        {busy && !content ? (
          <div className="repo-walk-viewer">
            <div className="spinner-block">
              <span className="spinner lg" aria-hidden />
              <span>
                Fetching {currentPath ? currentPath.split("/").pop() : "file"}…
              </span>
              <small>from github.com/{repo.full_name}</small>
            </div>
          </div>
        ) : (
          <pre className="repo-walk-viewer">{content || "(empty)"}</pre>
        )}

        {/* AI explanation + Q&A */}
        <div className="repo-walk-side">
          <div className="section-label">Apex says</div>
          <div className="repo-walk-side-stream">
            {!ollamaOk && (
              <div className="muted">
                Ollama is offline - start it from Settings.
              </div>
            )}
            {busy && !explanation && (
              <div className="spinner-row" style={{ marginTop: 4 }}>
                <span className="spinner" aria-hidden />
                <span>Reading the file &amp; thinking…</span>
              </div>
            )}
            {explanation && <MarkdownBlock text={explanation} />}
            {qaHistory.map((m, i) => (
              <div key={i} className={"repo-walk-msg " + m.role}>
                <strong>{m.role === "user" ? "YOU" : "APEX"}</strong>
                <MarkdownBlock text={m.content} />
              </div>
            ))}
          </div>
          {/* End-of-tour synthesis button - appears once you've reached
              the last step OR explicitly visited every tour file. The
              click feeds the planned tour back into Ollama for a recap
              that connects the dots between everything you saw. */}
          {tourPlan.length > 0 &&
            (essentialIdx === tourPlan.length - 1 ||
              visited.length >= tourPlan.length) && (
              <button
                className="primary small"
                onClick={askRecap}
                disabled={busy || !ollamaOk}
                title="Ollama synthesises the whole tour"
                style={{ marginTop: 4 }}
              >
                ⏵ How does it all fit together?
              </button>
            )}
          <form
            className="repo-walk-ask"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) askQuestion();
            }}
          >
            <input
              placeholder={
                currentPath
                  ? `Ask about ${currentPath.split("/").pop()}…`
                  : "Ask…"
              }
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={!ollamaOk || busy || !currentPath}
            />
            <button
              className="primary small"
              type="submit"
              disabled={!question.trim() || busy}
            >
              Ask
            </button>
          </form>
          {err && <div className="error">{err}</div>}
        </div>
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
  const [errCode, setErrCode] = React.useState(null);
  const [meta, setMeta] = React.useState({
    myUsername: "",
    myRepoCount: 0,
    viaLive: false,
    target: { languages: [] },
  });

  // Selected match's full comparison + chat history.
  const [selected, setSelected] = React.useState(null); // { repo, score, overlapLangs, ... }
  const [analysis, setAnalysis] = React.useState(null);
  const [analysisLoading, setAnalysisLoading] = React.useState(false);
  const [analysisErr, setAnalysisErr] = React.useState(null);
  const [chatHistory, setChatHistory] = React.useState([]);
  const [chatInput, setChatInput] = React.useState("");
  const [chatBusy, setChatBusy] = React.useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    setErrCode(null);
    try {
      const u = (await api.settings?.get?.("github.username")) || "";
      const r = await api.repo.similarToMine({
        repoId: repo.id,
        myUsername: u,
      });
      if (r?.ok) {
        setMatches(r.matches || []);
        setMeta({
          myUsername: r.myUsername || u,
          myRepoCount: r.myRepoCount || 0,
          viaLive: !!r.viaLive,
          target: r.target || { languages: [] },
        });
        // Auto-pick the top match if there's a clear winner.
        if (r.matches?.length) selectMatch(r.matches[0]);
      } else {
        setErr(r?.message || r?.error || "compare failed");
        setErrCode(r?.error || null);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function selectMatch(m) {
    setSelected(m);
    setAnalysis(null);
    setAnalysisErr(null);
    setChatHistory([]);
    if (!m?.repo?.full_name) {
      // Live-fetched repos may not have full_name; reconstruct from username.
      const fn =
        m?.repo?.full_name ||
        (meta.myUsername ? `${meta.myUsername}/${m?.repo?.name || ""}` : null);
      if (!fn) return;
      m = { ...m, repo: { ...m.repo, full_name: fn } };
      setSelected(m);
    }
    setAnalysisLoading(true);
    try {
      const r = await api.repo.compareWithMine({
        repoId: repo.id,
        mineFullName: m.repo.full_name,
      });
      if (r?.ok) setAnalysis(r.content || r.text || "");
      else setAnalysisErr(r?.error || "comparison failed");
    } catch (e) {
      setAnalysisErr(e.message);
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function sendChat(q) {
    const question = (q ?? chatInput).trim();
    if (!question || !selected?.repo?.full_name) return;
    setChatBusy(true);
    setChatHistory((h) => [...h, { role: "user", content: question }]);
    setChatInput("");
    try {
      const r = await api.repo.compareWithMine({
        repoId: repo.id,
        mineFullName: selected.repo.full_name,
        history: chatHistory,
        question,
      });
      const text = r?.ok
        ? r.content || r.text || ""
        : "Error: " + (r?.error || "unknown");
      setChatHistory((h) => [...h, { role: "assistant", content: text }]);
    } catch (e) {
      setChatHistory((h) => [
        ...h,
        { role: "assistant", content: "Error: " + e.message },
      ]);
    } finally {
      setChatBusy(false);
    }
  }

  React.useEffect(() => {
    load(); /* eslint-disable-next-line */
  }, [repo.id]);

  if (loading)
    return (
      <div className="spinner-block" style={{ marginTop: 14 }}>
        <span className="spinner lg" aria-hidden />
        <span>Scanning your repos…</span>
        <small>Fetching from GitHub if needed</small>
      </div>
    );

  if (errCode === "no-username") {
    return (
      <div className="card" style={{ marginTop: 14, padding: 16 }}>
        <strong>Set your GitHub username</strong>
        <p className="muted" style={{ marginTop: 6, marginBottom: 10 }}>
          Compare needs to know who you are on GitHub so it can find your own
          repos. Add it once in Settings → Integrations → GitHub.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="primary"
            onClick={() => {
              try {
                window.location.hash = "#settings/integrations";
              } catch {}
            }}
          >
            Open Settings
          </button>
          <button className="ghost" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (err) {
    return (
      <div className="error" style={{ marginTop: 14 }}>
        {err}
        <div style={{ marginTop: 6 }}>
          <button className="ghost xsmall" onClick={load}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="repo-compare">
      {/* Header - who we matched against, how many, and meta. */}
      <div
        className="row between"
        style={{ marginBottom: 10, alignItems: "baseline" }}
      >
        <div>
          <div className="section-label">
            Compare {repo.name} with your repos
          </div>
          <small className="muted">
            Matched on shared languages, GitHub topics, and name/description
            keywords. {matches.length} of your {meta.myRepoCount} repo
            {meta.myRepoCount === 1 ? "" : "s"} look related.
          </small>
        </div>
        <small className="muted">
          @{meta.myUsername} · {meta.viaLive ? "live" : "cached"}
        </small>
      </div>

      {matches.length === 0 ? (
        <div
          className="muted"
          style={{ padding: "20px 8px", textAlign: "center" }}
        >
          No clear matches - none of your repos share a language, topic, or
          obvious keyword with this one.
        </div>
      ) : (
        <div className="repo-compare-grid">
          {/* Left rail - list of similar repos with scores */}
          <div className="repo-compare-list">
            <div className="section-label" style={{ marginBottom: 6 }}>
              Your similar repos
            </div>
            {matches.map((m) => {
              const isSel = selected?.repo?.id === m.repo.id;
              return (
                <button
                  key={m.repo.id}
                  type="button"
                  className={"repo-compare-item" + (isSel ? " active" : "")}
                  onClick={() => selectMatch(m)}
                  title={`Score: ${m.score}`}
                >
                  <div
                    className="row between"
                    style={{ alignItems: "baseline" }}
                  >
                    <strong>{m.repo.name}</strong>
                    <small className="muted">{m.score}</small>
                  </div>
                  {m.repo.description && (
                    <small className="muted compare-desc">
                      {m.repo.description}
                    </small>
                  )}
                  <div className="compare-tags">
                    {m.overlapTopics?.slice(0, 3).map((t) => (
                      <span key={t} className="pill teal">
                        {t}
                      </span>
                    ))}
                    {m.overlapLangs?.slice(0, 2).map((l) => (
                      <span key={l} className="pill gray">
                        {l}
                      </span>
                    ))}
                    {m.overlapKeywords?.slice(0, 3).map((k) => (
                      <span key={k} className="pill" style={{ fontSize: 10 }}>
                        {k}
                      </span>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right pane - full AI comparison + chat for the selected match */}
          <div className="repo-compare-detail">
            {!selected ? (
              <div
                className="muted"
                style={{ padding: 20, textAlign: "center" }}
              >
                Pick a repo on the left to see how it compares.
              </div>
            ) : (
              <>
                <div className="row between" style={{ marginBottom: 8 }}>
                  <strong>
                    {repo.name} <span className="muted">vs</span>{" "}
                    {selected.repo.name}
                  </strong>
                  {selected.repo.url && (
                    <a
                      href={selected.repo.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ghost xsmall"
                    >
                      open ↗
                    </a>
                  )}
                </div>
                <div className="repo-compare-stream">
                  {analysisLoading && (
                    <div className="spinner-row">
                      <span className="spinner" aria-hidden />
                      <span>Reading both projects &amp; comparing…</span>
                    </div>
                  )}
                  {analysisErr && <div className="error">{analysisErr}</div>}
                  {analysis && <MarkdownBlock text={analysis} />}
                  {chatHistory.map((m, i) => (
                    <div key={i} className={"repo-walk-msg " + m.role}>
                      <strong>{m.role === "user" ? "YOU" : "APEX"}</strong>
                      <MarkdownBlock text={m.content} />
                    </div>
                  ))}
                  {chatBusy && (
                    <div className="repo-walk-msg assistant">
                      <strong>APEX</strong>
                      <div className="spinner-row" style={{ marginTop: 4 }}>
                        <span className="spinner" aria-hidden />
                        <span>Thinking…</span>
                      </div>
                    </div>
                  )}
                </div>
                <form
                  className="repo-walk-ask"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!chatBusy) sendChat();
                  }}
                >
                  <input
                    placeholder={`Ask about ${repo.name} vs ${selected.repo.name}…`}
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    disabled={chatBusy || analysisLoading}
                  />
                  <button
                    className="primary small"
                    type="submit"
                    disabled={!chatInput.trim() || chatBusy}
                  >
                    Ask
                  </button>
                </form>
                {/* Quick-prompt chips */}
                {!chatBusy && analysis && (
                  <div
                    className="row"
                    style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}
                  >
                    {[
                      "What patterns from this should I borrow into mine?",
                      "Show me a code shape for the main difference",
                      "What's the simpler / cleaner approach?",
                    ].map((p, i) => (
                      <button
                        key={i}
                        type="button"
                        className="ghost xsmall"
                        onClick={() => sendChat(p)}
                        disabled={chatBusy}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BulkDeleteModal({ people, onClose, onDeleted }) {
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [source, setSource] = useState("");
  const [picked, setPicked] = useState(new Set());
  const [busy, setBusy] = useState(false);

  // Derived options with cleanup
  const tagOptions = useMemo(() => {
    const s = new Set();
    people.forEach((p) => {
      if (Array.isArray(p.tags)) {
        p.tags.forEach((t) => {
          if (t) s.add(t);
        });
      }
    });
    return [...s].sort();
  }, [people]);

  const sourceOptions = useMemo(() => {
    const s = new Set();
    people.forEach((p) => {
      if (p.source) s.add(p.source);
    });
    return [...s].sort();
  }, [people]);

  const filtered = useMemo(() => {
    const lowQ = q.toLowerCase();
    return people.filter((p) => {
      if (tag) {
        const pTags = Array.isArray(p.tags) ? p.tags : [];
        if (!pTags.includes(tag)) return false;
      }
      if (source && p.source !== source) return false;
      if (q) {
        const name = (p.name || "").toLowerCase();
        const gh = (p.github_username || "").toLowerCase();
        if (!name.includes(lowQ) && !gh.includes(lowQ)) return false;
      }
      return true;
    });
  }, [people, q, tag, source]);

  const toggleAll = () => {
    if (picked.size === filtered.length && filtered.length > 0) {
      setPicked(new Set());
    } else {
      setPicked(new Set(filtered.map((p) => p.id)));
    }
  };

  const toggleOne = (id) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const doDelete = async () => {
    const ids = Array.from(picked);
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Are you sure you want to delete ${ids.length} people? This cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.people.deleteBulk(ids);
      onDeleted();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="modal wide"
        style={{
          width: 640,
          display: "flex",
          flexDirection: "column",
          maxHeight: "90vh",
        }}
      >
        <div className="row between" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>Bulk delete people</h3>
          <button className="ghost" onClick={onClose} style={{ fontSize: 20 }}>
            ✕
          </button>
        </div>

        <div
          className="row"
          style={{ gap: 8, marginBottom: 16, alignItems: "stretch" }}
        >
          <input
            placeholder="Search name or handle…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{
              flex: 1,
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-elev-2)",
              color: "var(--text)",
            }}
          />
          {tagOptions.length > 0 && (
            <select
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              style={{
                padding: "0 8px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-elev-2)",
                color: "var(--text)",
                minWidth: 120,
              }}
            >
              <option value="">All tags</option>
              {tagOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          {sourceOptions.length > 0 && (
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              style={{
                padding: "0 8px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-elev-2)",
                color: "var(--text)",
                minWidth: 120,
              }}
            >
              <option value="">All sources</option>
              {sourceOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>

        <div
          className="bulk-delete-list"
          style={{
            flex: 1,
            overflowY: "auto",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-elev)",
          }}
        >
          {filtered.map((p) => (
            <label
              key={p.id}
              className="row"
              style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--border)",
                gap: 12,
                cursor: "pointer",
                transition: "background 0.2s",
              }}
            >
              <input
                type="checkbox"
                checked={picked.has(p.id)}
                onChange={() => toggleOne(p.id)}
                style={{ width: 16, height: 16, cursor: "pointer" }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                {p.github_username && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    @{p.github_username}
                  </div>
                )}
              </div>
              {p.source && (
                <span className="pill gray xsmall" style={{ opacity: 0.7 }}>
                  {p.source}
                </span>
              )}
            </label>
          ))}
          {filtered.length === 0 && (
            <div className="muted" style={{ padding: 40, textAlign: "center" }}>
              No people match your filters
            </div>
          )}
        </div>

        <div className="row between" style={{ marginTop: 20 }}>
          <div className="row" style={{ gap: 12 }}>
            <button
              className="ghost xsmall"
              onClick={toggleAll}
              disabled={filtered.length === 0}
              style={{ padding: "4px 8px" }}
            >
              {picked.size === filtered.length && filtered.length > 0
                ? "Deselect All"
                : `Select All ${filtered.length > 0 ? filtered.length : ""}`}
            </button>
            <span className="muted" style={{ fontSize: 13 }}>
              {picked.size} of {people.length} selected
            </span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary danger"
              disabled={picked.size === 0 || busy}
              onClick={doDelete}
              style={{ padding: "8px 16px" }}
            >
              {busy ? "Deleting…" : `Delete ${picked.size} selected`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
