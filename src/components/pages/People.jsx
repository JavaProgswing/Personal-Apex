import React, { useEffect, useMemo, useState } from "react";
import api from "../../lib/api.js";
import ActivityFeed from "../ActivityFeed.jsx";

// Curated preset links shown in the "Import from links" modal. Includes the
// five NextTechLab labs plus a couple of generic GitHub org pages. The user
// can also paste any URL (github.com profile/org, linkedin, arbitrary page).
const LINK_PRESETS = [
  { label: "NextTechLab · Satoshi",  url: "https://nexttechlab.in/labs/satoshi"  },
  { label: "NextTechLab · Norman",   url: "https://nexttechlab.in/labs/norman"   },
  { label: "NextTechLab · Pausch",   url: "https://nexttechlab.in/labs/pausch"   },
  { label: "NextTechLab · McCarthy", url: "https://nexttechlab.in/labs/mccarthy" },
  { label: "NextTechLab · Tesla",    url: "https://nexttechlab.in/labs/tesla"    },
];

const PAGE_SIZE = 18;

export default function People() {
  const [people, setPeople] = useState([]);
  const [filter, setFilter] = useState({ q: "", tag: "", source: "", only: "" });
  const [groupBy, setGroupBy] = useState("none");
  const [page, setPage] = useState(1);

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

  async function reload() {
    // Server only knows about q/tag; source/only are client-side pills.
    setPeople(await api.people.list({ q: filter.q, tag: filter.tag }));
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
    return out;
  }, [people, filter.source, filter.only]);

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
        </div>
      </div>

      {ghSync.active && <SyncBar label="GitHub" {...ghSync} />}
      {ghSync.rateLimited && (
        <div className="card rose" style={{ margin: "6px 0" }}>
          GitHub rate-limited. Resets {ghSync.resetAt ? "at " + new Date(ghSync.resetAt).toLocaleTimeString() : "soon"}. Add a token in Settings → GitHub.
        </div>
      )}
      {cpSync.active && <SyncBar label="Competitive programming" {...cpSync} />}

      {/* Search + grouping controls */}
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <input placeholder="Search name / GitHub…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} style={{ maxWidth: 300 }} />
        <select value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })} style={{ maxWidth: 200 }}>
          <option value="">All tags</option>
          {tagOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value })} style={{ maxWidth: 180 }}>
          <option value="">All sources</option>
          {sourceOptions.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={{ maxWidth: 170 }}>
          <option value="none">No grouping</option>
          <option value="source">Group by source</option>
          <option value="tag">Group by tag</option>
          <option value="syncstate">Group by sync state</option>
        </select>
        <button className="ghost" onClick={() => setShowLeaderboard(true)}>🏆 Leaderboard</button>
      </div>

      {/* Only-filter chips */}
      <div className="chip-row" style={{ marginBottom: 14 }}>
        <button className={"chip" + (filter.only === "" ? " active" : "")} onClick={() => setFilter({ ...filter, only: "" })}>All · {people.length}</button>
        <button className={"chip" + (filter.only === "gh" ? " active" : "")} onClick={() => setFilter({ ...filter, only: "gh" })}>Has GitHub</button>
        <button className={"chip" + (filter.only === "cp" ? " active" : "")} onClick={() => setFilter({ ...filter, only: "cp" })}>Has CP handle</button>
        <button className={"chip" + (filter.only === "unsynced" ? " active" : "")} onClick={() => setFilter({ ...filter, only: "unsynced" })}>Never synced</button>
        {status?.msg && <small className="muted" style={{ marginLeft: "auto" }}>{status.msg}</small>}
        {status?.err && <small className="error" style={{ marginLeft: "auto" }}>{status.err}</small>}
      </div>

      {/* Recent activity feed */}
      <ActivityFeed onOpenPerson={openPerson} />

      {/* Grouped grid */}
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
              <PersonCard key={p.id} p={p} onOpen={() => openPerson(p)} onRetryGh={() => syncOneGh(p.id)} onRetryCp={() => syncOneCp(p.id)} />
            ))}
          </div>
        </section>
      ))}
      {filtered.length === 0 && (
        <div className="muted">No people match. Try clearing filters or import from a link.</div>
      )}

      {/* Pager */}
      {shownRows < totalRows && (
        <div className="pager row" style={{ justifyContent: "center", marginTop: 8 }}>
          <small className="muted">{shownRows} / {totalRows}</small>
          <button className="primary" onClick={() => setPage((p) => p + 1)}>Show more</button>
        </div>
      )}

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

function PersonCard({ p, onOpen, onRetryGh, onRetryCp }) {
  const liHandle = !p.github_username ? linkedinHandle(p.linkedin_url) : null;
  const hasCp = !!(p.leetcode_username || p.codeforces_username || p.codechef_username);
  const hasAnyLink = !!(p.github_username || liHandle || p.linkedin_url || hasCp);

  return (
    <div
      className={"card person-card" + (!p.github_username && liHandle ? " li-only" : "")}
      style={{ cursor: "pointer", position: "relative" }}
      onClick={onOpen}
    >
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

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" style={{ width: 900 }}>
        <div className="row between">
          <div>
            <h3 style={{ margin: 0 }}>{person.name}</h3>
            {person.github_username && (
              <div className="muted">
                <a href="#" onClick={(e) => { e.preventDefault(); api.ext.open(`https://github.com/${person.github_username}`); }}>
                  github.com/{person.github_username}
                </a>
              </div>
            )}
            {person.linkedin_url && (
              <div className="muted">
                <a href="#" onClick={(e) => { e.preventDefault(); api.ext.open(person.linkedin_url); }}>{person.linkedin_url}</a>
              </div>
            )}
          </div>
          <button onClick={onClose} className="ghost">✕</button>
        </div>
        <div className="tags" style={{ margin: "10px 0" }}>
          {(person.tags || []).map((t) => <span key={t} className="pill">{t}</span>)}
        </div>

        <div className="row" style={{ margin: "10px 0", flexWrap: "wrap", gap: 6 }}>
          <button className="primary" onClick={onSyncGh}>Sync GitHub</button>
          <button onClick={onSyncCp}>Sync CP</button>
          <button onClick={() => setEditMode((v) => !v)}>{editMode ? "Cancel edit" : "Edit handles"}</button>
          <button className="ghost" onClick={onDelete}>Delete</button>
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

        {/* CP stats */}
        <div className="section-label" style={{ marginTop: 12 }}>Competitive programming</div>
        {cpStats.length === 0 && <div className="muted">No CP handles set. Click "Edit handles" above.</div>}
        {cpStats.map((cp) => <CpStatCard key={cp.id} cp={cp} />)}

        {/* Repos */}
        <div className="row between" style={{ marginTop: 14 }}>
          <div className="section-label" style={{ margin: 0 }}>Repos ({repos.length})</div>
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
        </div>
        {repos.length === 0 && <div className="muted">No repos cached. Click "Sync GitHub".</div>}
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

// Replacement for the old NextTechLab-only import. Accepts any URL; the
// NextTechLab 4 presets are one-click so the old flow stays frictionless.
function ImportByLinkModal({ onClose, onImported }) {
  const [url, setUrl] = useState("");
  const [tab, setTab] = useState("paste");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null); // { candidates: [...] }
  const [ntl, setNtl] = useState(null);          // { 'ntl:satoshi': res, ... }
  const [picked, setPicked] = useState(new Set()); // keys into candidates: `${source}:${i}`
  const [err, setErr] = useState(null);

  async function runPreview() {
    if (!url.trim()) return;
    setErr(null); setLoading(true); setPreview(null);
    try {
      const res = await api.import.preview(url.trim());
      if (!res.ok) setErr(res.error || "Preview failed");
      else {
        setPreview(res);
        const all = new Set((res.candidates || []).map((_, i) => `ext:${i}`));
        setPicked(all);
      }
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  async function runNtl4() {
    setErr(null); setLoading(true); setNtl(null);
    try {
      const res = await api.import.previewNtl4();
      setNtl(res);
      const all = new Set();
      Object.entries(res || {}).forEach(([k, r]) => {
        if (r?.ok) (r.candidates || []).forEach((_, i) => all.add(`${k}:${i}`));
      });
      setPicked(all);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  async function commit() {
    const toImport = [];
    if (tab === "paste" && preview) {
      (preview.candidates || []).forEach((c, i) => {
        if (picked.has(`ext:${i}`)) toImport.push({ ...c, source: preview.source });
      });
    } else if (tab === "ntl4" && ntl) {
      Object.entries(ntl).forEach(([k, r]) => {
        if (r?.ok) (r.candidates || []).forEach((c, i) => {
          if (picked.has(`${k}:${i}`)) toImport.push({ ...c, source: k });
        });
      });
    }
    if (toImport.length === 0) return;
    const res = await api.import.commit(toImport);
    if (res?.ok) onImported();
    else setErr(res?.error || "Import failed");
  }

  const allRows = useMemo(() => {
    const rows = [];
    if (tab === "paste" && preview) {
      (preview.candidates || []).forEach((c, i) => rows.push({ key: `ext:${i}`, c }));
    } else if (tab === "ntl4" && ntl) {
      Object.entries(ntl).forEach(([k, r]) => {
        if (r?.ok) (r.candidates || []).forEach((c, i) => rows.push({ key: `${k}:${i}`, c, group: k }));
      });
    }
    return rows;
  }, [tab, preview, ntl]);

  return (
    <div className="modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" style={{ width: 820 }}>
        <div className="row between">
          <h3 style={{ margin: 0 }}>Import people from links</h3>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <p className="muted">Paste a URL (GitHub profile/org, LinkedIn, or any page that links to people) — Apex extracts GitHub handles + LinkedIn URLs for you. Or hit "NextTechLab 4" to scrape all five labs at once.</p>

        <div className="chip-row" style={{ marginBottom: 12 }}>
          <button className={"chip" + (tab === "paste" ? " active" : "")} onClick={() => setTab("paste")}>Paste link</button>
          <button className={"chip" + (tab === "ntl4" ? " active" : "")} onClick={() => setTab("ntl4")}>NextTechLab 4</button>
        </div>

        {tab === "paste" && (
          <>
            <div className="row" style={{ gap: 6 }}>
              <input autoFocus placeholder="https://github.com/octocat or https://nexttechlab.in/labs/satoshi"
                value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }}
                onKeyDown={(e) => { if (e.key === "Enter") runPreview(); }} />
              <button className="primary" onClick={runPreview} disabled={loading || !url.trim()}>{loading ? "…" : "Preview"}</button>
            </div>
            <div className="chip-row" style={{ marginTop: 8 }}>
              {LINK_PRESETS.map((p) => (
                <button key={p.url} className="chip" onClick={() => { setUrl(p.url); }}>{p.label}</button>
              ))}
            </div>
          </>
        )}
        {tab === "ntl4" && (
          <div className="row">
            <button className="primary" onClick={runNtl4} disabled={loading}>{loading ? "Scraping…" : "Scrape all 5 NTL labs"}</button>
            {ntl && (
              <small className="muted">
                {Object.entries(ntl).map(([k, r]) => `${k.replace("ntl:", "")}: ${r?.ok ? (r.candidates?.length || 0) : "err"}`).join(" · ")}
              </small>
            )}
          </div>
        )}

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
              {allRows.map(({ key, c, group }) => (
                <label key={key} className="todo-row" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={picked.has(key)} onChange={(e) => {
                    const n = new Set(picked);
                    if (e.target.checked) n.add(key); else n.delete(key);
                    setPicked(n);
                  }} />
                  <div>
                    <div className="title">{c.name || c.github_username || c.linkedin_url}</div>
                    <div className="sub">
                      {group && <span className="pill gray">{group}</span>}{" "}
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

        {rows.map((r, i) => (
          <div key={r.person_id} className="row" style={{ alignItems: "center", gap: 10, margin: "8px 0" }}>
            <span className="pill">{i + 1}</span>
            {r.avatar_url ? <img className="avatar" src={r.avatar_url} alt="" style={{ width: 32, height: 32 }} /> : <div className="avatar" style={{ width: 32, height: 32 }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="title">{r.person_name}</div>
              <div className="sub muted row" style={{ gap: 10, flexWrap: "wrap" }}>
                <span>LC: {statCell(r.leetcode, "leetcode")}</span>
                <span>CF: {statCell(r.codeforces, "codeforces")}</span>
                <span>CC: {statCell(r.codechef, "codechef")}</span>
              </div>
            </div>
          </div>
        ))}
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
        if (d?.summary) setAiSummary(d.summary);
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

        {loading && <div className="muted" style={{ marginTop: 14 }}>Loading detail…</div>}
        {detail && (
          <>
            {/* Tech stack bar */}
            {tech.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 14 }}>Tech stack</div>
                <div className="lang-bar">
                  {tech.map((t, i) => (
                    <div key={t.name} className={`lang-seg seg-${i % 6}`} style={{ width: `${t.pct}%` }} title={`${t.name} ${t.pct}%`}>
                      <small>{t.name} {t.pct}%</small>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* AI summary */}
            <div className="section-label" style={{ marginTop: 14 }}>AI overview</div>
            <div className="card" style={{ background: "var(--bg-elev-2)" }}>
              {!aiSummary && !aiLoading && (
                <div className="row" style={{ gap: 6 }}>
                  <span className={"pill " + (ollamaOk ? "teal" : "rose")}>{ollamaOk ? "ollama" : "offline"}</span>
                  <select value={model} onChange={(e) => setModel(e.target.value)} style={{ maxWidth: 160 }}>
                    {models.length === 0 && <option value="">(no models)</option>}
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <button className="primary" onClick={runSummary} disabled={!ollamaOk || !model}>
                    Summarize with Ollama
                  </button>
                  <small className="muted">reads README + recent commits</small>
                </div>
              )}
              {aiLoading && <div className="muted">Thinking…</div>}
              {aiErr && <div className="error">{aiErr}</div>}
              {aiSummary && (
                <>
                  <div className="row between">
                    <strong>Summary</strong>
                    <button className="ghost small" onClick={runSummary} disabled={aiLoading || !ollamaOk}>↻ Re-summarize</button>
                  </div>
                  {aiSummary.summary && <p style={{ margin: "6px 0" }}>{aiSummary.summary}</p>}
                  {Array.isArray(aiSummary.techStack) && aiSummary.techStack.length > 0 && (
                    <div className="chip-row">
                      {aiSummary.techStack.map((t, i) => <span key={i} className="chip">{t}</span>)}
                    </div>
                  )}
                  {Array.isArray(aiSummary.guidance) && aiSummary.guidance.length > 0 && (
                    <>
                      <div className="section-label" style={{ marginTop: 10 }}>How to explore it</div>
                      <ul style={{ paddingLeft: 18, margin: "4px 0" }}>
                        {aiSummary.guidance.map((g, i) => <li key={i}>{g}</li>)}
                      </ul>
                    </>
                  )}
                  {Array.isArray(aiSummary.learn) && aiSummary.learn.length > 0 && (
                    <>
                      <div className="section-label">Worth learning</div>
                      <div className="chip-row">
                        {aiSummary.learn.map((l, i) => <span key={i} className="chip">{l}</span>)}
                      </div>
                    </>
                  )}
                  {Array.isArray(aiSummary.similarToYours) && aiSummary.similarToYours.length > 0 && (
                    <>
                      <div className="section-label">Similar to things you've built</div>
                      <ul style={{ paddingLeft: 18, margin: "4px 0" }}>
                        {aiSummary.similarToYours.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </>
                  )}
                </>
              )}
            </div>

            {/* README preview */}
            {detail.readme && (
              <>
                <div className="section-label" style={{ marginTop: 14 }}>README</div>
                <pre style={{ maxHeight: 300, overflow: "auto", padding: 12, background: "var(--bg-elev-2)", borderRadius: 10, whiteSpace: "pre-wrap", fontSize: 12 }}>
                  {detail.readme.slice(0, 4000)}{detail.readme.length > 4000 ? "\n…truncated" : ""}
                </pre>
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
      </div>
    </div>
  );
}
