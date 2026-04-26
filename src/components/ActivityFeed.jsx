import React, { useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";

// "What your classmates shipped recently." Enhanced v0.3:
//  • time-range chips (24h / 7d / 30d / 90d)
//  • tag + person filters
//  • group-by-day toggle
//  • paginated "Show more"
//  • expand a push → commit messages from activity_feed
//
// Data sources:
//   api.activity.recentPushes({ days, tag }) → repo-level pushes
//   api.activity.feed({ personId, days })   → per-commit events

const RANGES = [
  { key: 1, label: "24h" },
  { key: 7, label: "7d" },
  { key: 30, label: "30d" },
  { key: 90, label: "90d" },
];
const PAGE_SIZE = 10;

export default function ActivityFeed({ onOpenPerson, onOpenRepo }) {
  const [days, setDays] = useState(30);
  const [tag, setTag] = useState("");
  const [personId, setPersonId] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [pushes, setPushes] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState(new Set()); // repo ids
  const [commitsByPerson, setCommitsByPerson] = useState({}); // { personId: rows } (cached gh events)
  const [loadingCommits, setLoadingCommits] = useState(new Set());
  // Live commits + AI summary, keyed per-repo. Live commits are fetched
  // straight from the GitHub API on first expand, so we never have to fall
  // back to "no cached individual commits" again.
  const [liveCommitsByRepo, setLiveCommitsByRepo] = useState({});
  const [loadingLiveByRepo, setLoadingLiveByRepo] = useState(new Set());
  const [summaryByRepo, setSummaryByRepo] = useState({});
  const [summaryLoadingByRepo, setSummaryLoadingByRepo] = useState(new Set());

  useEffect(() => {
    (async () => {
      try {
        setPeople((await api.people.list({})) || []);
      } catch {
        setPeople([]);
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const raw =
          (await api.activity.recentPushes({
            days,
            tag: tag || null,
          })) || [];
        if (!cancelled) {
          setPushes(raw);
          setLimit(PAGE_SIZE);
          setExpanded(new Set());
        }
      } catch {
        if (!cancelled) setPushes([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days, tag]);

  const tagOptions = useMemo(() => {
    const s = new Set();
    people.forEach((p) => (p.tags || []).forEach((t) => s.add(t)));
    return [...s].sort();
  }, [people]);

  const filtered = useMemo(() => {
    let rows = pushes;
    if (personId) rows = rows.filter((r) => r.person_id === +personId);
    return rows;
  }, [pushes, personId]);

  const visible = filtered.slice(0, limit);
  const canShowMore = filtered.length > visible.length;

  const groups = useMemo(() => {
    if (!grouped) return null;
    const buckets = new Map();
    for (const r of visible) {
      const k = dayKey(r.pushed_at);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    return [...buckets.entries()];
  }, [visible, grouped]);

  async function toggleExpand(repo) {
    const id = repo.id;
    const nextExpanded = new Set(expanded);
    if (nextExpanded.has(id)) {
      nextExpanded.delete(id);
      setExpanded(nextExpanded);
      return;
    }
    nextExpanded.add(id);
    setExpanded(nextExpanded);

    // Fetch in parallel:
    //   • cached gh events (per-person feed, used as fallback)
    //   • live commits from the GitHub REST API for this repo
    const tasks = [];
    if (!commitsByPerson[repo.person_id] && api.activity.feed) {
      tasks.push(loadCachedFeed(repo));
    }
    if (!liveCommitsByRepo[id] && api.repo?.recentCommits && repo.full_name) {
      tasks.push(loadLiveCommits(repo));
    }
    await Promise.allSettled(tasks);
  }

  async function loadCachedFeed(repo) {
    const next = new Set(loadingCommits);
    next.add(repo.person_id);
    setLoadingCommits(next);
    try {
      const rows =
        (await api.activity.feed({
          personId: repo.person_id,
          days: Math.max(days, 30),
          limit: 80,
        })) || [];
      setCommitsByPerson((prev) => ({ ...prev, [repo.person_id]: rows }));
    } catch {
      setCommitsByPerson((prev) => ({ ...prev, [repo.person_id]: [] }));
    } finally {
      setLoadingCommits((prev) => {
        const s = new Set(prev);
        s.delete(repo.person_id);
        return s;
      });
    }
  }

  async function loadLiveCommits(repo) {
    setLoadingLiveByRepo((prev) => new Set(prev).add(repo.id));
    try {
      const sinceDays = Math.max(days, 14);
      const res = await api.repo.recentCommits({
        fullName: repo.full_name,
        days: sinceDays,
        limit: 20,
      });
      const commits = res?.ok ? res.commits : [];
      setLiveCommitsByRepo((prev) => ({ ...prev, [repo.id]: commits }));
    } catch {
      setLiveCommitsByRepo((prev) => ({ ...prev, [repo.id]: [] }));
    } finally {
      setLoadingLiveByRepo((prev) => {
        const s = new Set(prev);
        s.delete(repo.id);
        return s;
      });
    }
  }

  async function summariseRepo(repo) {
    setSummaryLoadingByRepo((prev) => new Set(prev).add(repo.id));
    try {
      const res = await api.repo.summarizeRecentChanges({
        repoId: repo.id,
        fullName: repo.full_name,
        days: Math.max(days, 14),
      });
      setSummaryByRepo((prev) => ({ ...prev, [repo.id]: res || { ok: false } }));
    } catch (err) {
      setSummaryByRepo((prev) => ({
        ...prev,
        [repo.id]: { ok: false, error: err?.message || "Failed" },
      }));
    } finally {
      setSummaryLoadingByRepo((prev) => {
        const s = new Set(prev);
        s.delete(repo.id);
        return s;
      });
    }
  }

  function openPush(r) {
    onOpenPerson?.({
      id: r.person_id,
      name: r.person_name,
      github_username: r.github_username,
      avatar_url: r.avatar_url,
      tags: r.person_tags,
    });
  }

  return (
    <div className="card feed-card" style={{ marginBottom: 16 }}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="card-title" style={{ margin: 0 }}>
          Classmate activity · recent pushes{" "}
          <span className="muted" style={{ fontWeight: 400 }}>
            ({filtered.length})
          </span>
        </div>
        <div className="row feed-filters" style={{ flexWrap: "wrap", gap: 6 }}>
          <div className="chip-row">
            {RANGES.map((r) => (
              <button
                key={r.key}
                className={
                  "chip" + (days === r.key ? " active" : "")
                }
                onClick={() => setDays(r.key)}
                type="button"
              >
                {r.label}
              </button>
            ))}
          </div>
          <select
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            style={{ width: 150 }}
          >
            <option value="">all tags</option>
            {tagOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
            style={{ width: 170 }}
          >
            <option value="">all people</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={"chip" + (grouped ? " active" : "")}
            onClick={() => setGrouped((g) => !g)}
            title={grouped ? "flatten" : "group by day"}
          >
            {grouped ? "by day" : "flat"}
          </button>
        </div>
      </div>

      {loading && (
        <div className="muted" style={{ marginTop: 10 }}>
          Loading…
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="muted" style={{ marginTop: 10 }}>
          No activity in this window. Sync people from GitHub first, widen the
          range, or clear filters.
        </div>
      )}

      {!loading && grouped && groups && (
        <div className="feed-groups">
          {groups.map(([label, rows]) => (
            <div key={label} className="feed-group">
              <div className="feed-day-label">{label}</div>
              {rows.map((r) => (
                <PushRow
                  key={r.id}
                  r={r}
                  expanded={expanded.has(r.id)}
                  liveCommits={liveCommitsByRepo[r.id] ?? null}
                  liveLoading={loadingLiveByRepo.has(r.id)}
                  cachedCommits={
                    commitsByPerson[r.person_id]
                      ? commitsByPerson[r.person_id].filter(
                          (c) =>
                            c.repo === r.full_name ||
                            c.repo === r.name ||
                            (c.url || "").includes("/" + r.full_name + "/"),
                        )
                      : null
                  }
                  cachedLoading={loadingCommits.has(r.person_id)}
                  summary={summaryByRepo[r.id] ?? null}
                  summaryLoading={summaryLoadingByRepo.has(r.id)}
                  onSummarise={() => summariseRepo(r)}
                  onToggle={() => toggleExpand(r)}
                  onOpenPerson={() => openPush(r)}
                  onOpenRepo={() => onOpenRepo?.(r)}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {!loading && !grouped && (
        <div className="feed-flat">
          {visible.map((r) => (
            <PushRow
              key={r.id}
              r={r}
              expanded={expanded.has(r.id)}
              liveCommits={liveCommitsByRepo[r.id] ?? null}
              liveLoading={loadingLiveByRepo.has(r.id)}
              cachedCommits={
                commitsByPerson[r.person_id]
                  ? commitsByPerson[r.person_id].filter(
                      (c) =>
                        c.repo === r.full_name ||
                        c.repo === r.name ||
                        (c.url || "").includes("/" + r.full_name + "/"),
                    )
                  : null
              }
              cachedLoading={loadingCommits.has(r.person_id)}
              summary={summaryByRepo[r.id] ?? null}
              summaryLoading={summaryLoadingByRepo.has(r.id)}
              onSummarise={() => summariseRepo(r)}
              onToggle={() => toggleExpand(r)}
              onOpenPerson={() => openPush(r)}
              onOpenRepo={() => onOpenRepo?.(r)}
            />
          ))}
        </div>
      )}

      {canShowMore && (
        <div className="row center" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="button"
            onClick={() =>
              setLimit((l) => Math.min(filtered.length, l + PAGE_SIZE))
            }
          >
            Show {Math.min(PAGE_SIZE, filtered.length - visible.length)} more
          </button>
        </div>
      )}
    </div>
  );
}

function PushRow({
  r,
  expanded,
  liveCommits,
  liveLoading,
  cachedCommits,
  cachedLoading,
  summary,
  summaryLoading,
  onSummarise,
  onToggle,
  onOpenPerson,
  onOpenRepo,
}) {
  const when = r.pushed_at ? new Date(r.pushed_at) : null;
  const repoUrl =
    r?.url || (r?.full_name ? `https://github.com/${r.full_name}` : "#");

  // Click anywhere on the head → open the in-app project overview
  // (RepoDetailModal). The "↗" icon and the caret are the only controls
  // that do something else.
  const openOverview = (e) => {
    if (e) {
      // Children that have their own click handlers — let them run instead
      // of double-firing the parent. .push-repo also calls onOpenRepo, so
      // skipping here just avoids redundancy.
      const interactive = e.target?.closest?.(
        ".push-repo, .push-gh-link, .push-caret, .push-person",
      );
      if (interactive) return;
      e.preventDefault?.();
    }
    onOpenRepo?.();
  };

  return (
    <div className={"push-card" + (expanded ? " expanded" : "")}>
      <div
        className="push-head"
        onClick={openOverview}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openOverview();
          }
        }}
        title={`Open ${r.full_name || "repo"} overview`}
        style={{ cursor: "pointer" }}
      >
        <div className="push-avatar">
          {r.avatar_url ? (
            <img src={r.avatar_url} alt="" />
          ) : (
            <div className="push-avatar-fallback">
              {(r.person_name || "?").slice(0, 1)}
            </div>
          )}
        </div>
        <div className="push-body">
          <div className="push-line">
            <button
              type="button"
              className="push-repo"
              title={`Open ${r.full_name} overview`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenRepo?.();
              }}
            >
              {r.full_name}
            </button>
            {r.url && (
              <a
                href={repoUrl}
                className="push-gh-link"
                title="Open on GitHub"
                aria-label={`Open ${r.full_name} on GitHub`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (repoUrl && repoUrl !== "#") api.ext.open(repoUrl);
                }}
              >
                ↗
              </a>
            )}
            {r.language && <span className="pill gray">{r.language}</span>}
            {(r.topics || []).slice(0, 2).map((t) => (
              <span key={t} className="pill">
                {t}
              </span>
            ))}
            <span className="push-stars">★ {r.stars ?? 0}</span>
          </div>
          {r.description && (
            <div className="push-desc" title={r.description}>
              {r.description}
            </div>
          )}
          <div className="push-meta muted">
            <span
              className="push-person"
              onClick={(e) => {
                e.stopPropagation();
                onOpenPerson();
              }}
            >
              by {r.person_name}
            </span>
            {when && <span> · {relativeTime(when)}</span>}
            {(r.person_tags || []).slice(0, 3).map((t) => (
              <span key={t} className="pill" style={{ marginLeft: 6 }}>
                {t}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          className={"push-caret" + (expanded ? " open" : "")}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onToggle();
          }}
          title={expanded ? "Hide commits" : "Show commits"}
          aria-label={expanded ? "Hide commits" : "Show commits"}
          style={{
            background: "transparent",
            border: "none",
            color: "inherit",
            cursor: "pointer",
            padding: "4px 8px",
            font: "inherit",
          }}
        >
          ▾
        </button>
      </div>

      {expanded && (
        <div className="push-expanded">
          {/* AI summary action row — sits at the top of the expand panel. */}
          <div className="push-expanded-actions">
            <button
              type="button"
              className="ghost small"
              onClick={onSummarise}
              disabled={summaryLoading}
              title="Have Ollama summarise the recent commits"
            >
              {summaryLoading
                ? "Summarising…"
                : summary?.ok
                  ? "↻ Re-summarise"
                  : "✨ Summarise recent changes"}
            </button>
            {summary?.themes && summary.themes.length > 0 && (
              <div className="push-themes">
                {summary.themes.slice(0, 5).map((t, i) => (
                  <span key={i} className="pill">{t}</span>
                ))}
              </div>
            )}
          </div>

          {summary?.ok && summary.summary && (
            <div className="push-summary">
              <p>{summary.summary}</p>
              {summary.highlight && (
                <small className="muted">
                  <strong>Highlight: </strong>{summary.highlight}
                </small>
              )}
            </div>
          )}
          {summary && !summary.ok && summary.error && (
            <div className="error" style={{ fontSize: 12 }}>
              Couldn't summarise: {summary.error}
            </div>
          )}

          {/* Commit list — live commits from the GitHub API take priority,
              cached gh events are a fallback. */}
          <div className="section-label" style={{ marginTop: 10 }}>
            Recent commits
          </div>
          {liveLoading && <div className="muted">Loading commits from GitHub…</div>}
          {!liveLoading && Array.isArray(liveCommits) && liveCommits.length > 0 && (
            <ul className="commit-list">
              {liveCommits.slice(0, 12).map((c) => (
                <li key={c.sha} className="commit-row">
                  <span className="commit-kind">▸</span>
                  <a
                    href={c.url}
                    onClick={(e) => {
                      e.preventDefault();
                      if (c.url) api.ext.open(c.url);
                    }}
                    className="commit-msg"
                    title={c.message || ""}
                  >
                    {truncate((c.message || "").split("\n")[0] || "(no message)", 160)}
                  </a>
                  <span className="commit-when muted">
                    {c.date ? relativeTime(new Date(c.date)) : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!liveLoading &&
            Array.isArray(liveCommits) &&
            liveCommits.length === 0 &&
            cachedCommits &&
            cachedCommits.length > 0 && (
              <ul className="commit-list">
                {cachedCommits.slice(0, 8).map((c) => (
                  <li key={c.id} className="commit-row">
                    <span className="commit-kind">
                      {c.kind === "push" ? "▸" : "•"}
                    </span>
                    <a
                      href={c.url}
                      onClick={(e) => {
                        e.preventDefault();
                        if (c.url) api.ext.open(c.url);
                      }}
                      className="commit-msg"
                      title={c.message || ""}
                    >
                      {truncate(c.message || "(no message)", 160)}
                    </a>
                    <span className="commit-when muted">
                      {c.at ? relativeTime(new Date(c.at)) : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          {!liveLoading &&
            (!liveCommits || liveCommits.length === 0) &&
            (!cachedCommits || cachedCommits.length === 0) &&
            !cachedLoading && (
              <div className="muted">
                Couldn't pull commits — repo may be private, rate-limited, or
                empty for the chosen window.
              </div>
            )}
        </div>
      )}
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────

function dayKey(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "—";
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function relativeTime(d) {
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.round(hrs / 24);
  if (days < 7) return days + "d ago";
  return d.toLocaleDateString();
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
