import React, { useCallback, useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";

// ─── tiny helpers ────────────────────────────────────────────────────────────
const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : "-");
const fmtPct = (n) => (typeof n === "number" ? `${(n * 100).toFixed(0)}%` : "-");
const fmtBpm = (n) => (typeof n === "number" ? Math.round(n) : "-");
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function Bar({ value = 0, max = 1, color = "var(--accent)" }) {
  const pct = clamp((value / max) * 100, 0, 100);
  return (
    <div className="spm-bar-track">
      <div className="spm-bar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function FeaturePill({ label, value, pct }) {
  return (
    <div className="spm-feat-pill">
      <span className="spm-feat-label">{label}</span>
      <Bar value={pct ?? value} max={1} />
      <span className="spm-feat-val">{pct != null ? fmtPct(pct) : fmt(value)}</span>
    </div>
  );
}

function ProgressBar({ prog }) {
  if (!prog) return null;
  const pct = prog.total > 0 ? clamp((prog.current / prog.total) * 100, 0, 100) : null;
  return (
    <div className="spm-progress-wrap">
      <div className="spm-progress-track">
        {pct != null
          ? <div className="spm-progress-fill" style={{ width: `${pct}%` }} />
          : <div className="spm-progress-fill indeterminate" />}
      </div>
      <span className="spm-progress-msg">{prog.message}</span>
    </div>
  );
}

function ResultBanner({ result, onClose }) {
  if (!result) return null;
  const ok = result.ok !== false;
  return (
    <div className={`spm-banner ${ok ? "ok" : "err"}`}>
      <span>{ok ? "✓" : "✕"} {result.message || (ok ? "Done!" : result.error || "Something went wrong")}</span>
      {onClose && <button className="ghost xsmall" onClick={onClose}>✕</button>}
    </div>
  );
}

// Shared playlist picker grid
function PlaylistPicker({ playlists, selected, onSelect, multi = false, label = "Select a playlist" }) {
  const [search, setSearch] = useState("");
  const visible = playlists.filter((p) =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="spm-pl-picker">
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        <input
          className="spm-search"
          placeholder="Filter playlists…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="spm-pl-grid">
        {visible.map((p) => {
          const isSelected = multi
            ? Array.isArray(selected) && selected.includes(p.uri)
            : selected?.uri === p.uri;
          return (
            <button
              key={p.uri}
              type="button"
              className={`spm-pl-card${isSelected ? " selected" : ""}${p.synthetic ? " liked" : ""}`}
              onClick={() => onSelect(p)}
              title={`${p.name} · ${p.tracks} tracks`}
            >
              {p.image
                ? <img src={p.image} alt="" className="spm-pl-art" />
                : <div className="spm-pl-art spm-pl-fallback">{p.synthetic ? "♥" : "♪"}</div>}
              <div className="spm-pl-meta">
                <strong>{p.name}</strong>
                <small className="muted">{p.tracks} tracks{p.owner ? ` · ${p.owner}` : ""}</small>
              </div>
              {isSelected && <span className="spm-pl-check">✓</span>}
            </button>
          );
        })}
        {!visible.length && <p className="muted" style={{ gridColumn: "1/-1", padding: 8 }}>No playlists found.</p>}
      </div>
    </div>
  );
}

// ─── useProgress hook ─────────────────────────────────────────────────────────
function useProgress() {
  const [prog, setProg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const off = api.spotify.onProgress?.((p) => setProg(p));
    return () => off?.();
  }, []);

  const run = useCallback(async (fn) => {
    setBusy(true);
    setProg({ message: "Starting…", current: 0, total: 0 });
    try {
      return await fn();
    } finally {
      setBusy(false);
      setTimeout(() => setProg(null), 1200);
    }
  }, []);

  return { prog, busy, run };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 1 - Library
// ═══════════════════════════════════════════════════════════════════════════════

function LibraryTab() {
  const { prog, busy, run } = useProgress();
  const [result, setResult] = useState(null);

  // Export & Sync
  const [exportOrder, setExportOrder] = useState("2");
  // Time Machine
  const [tmStart, setTmStart] = useState(() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [tmEnd, setTmEnd]     = useState(() => new Date().toISOString().slice(0, 10));
  const [tmOrder, setTmOrder] = useState("1");
  const [tmName, setTmName]   = useState("");

  async function doExport() {
    const r = await run(() => api.spotify.exportSyncLiked({ order: exportOrder }));
    if (r?.ok) {
      setResult({ ok: true, message: `✓ "${r.playlistName}" synced - ${r.added} added, ${r.removed} removed (${r.total} total)` });
    } else {
      setResult({ ok: false, error: r?.error });
    }
  }

  async function doTimeMachine() {
    if (!tmStart || !tmEnd) return;
    const r = await run(() => api.spotify.timeMachine({ start: tmStart, end: tmEnd, order: tmOrder, name: tmName.trim() || undefined }));
    if (r?.ok) {
      if (!r.matched) {
        setResult({ ok: true, message: "No liked songs found in that date range." });
      } else {
        setResult({ ok: true, message: `✓ Created "${r.playlistName}" with ${r.matched} tracks` });
      }
    } else {
      setResult({ ok: false, error: r?.error });
    }
  }

  return (
    <div className="spm-tab-content">
      <ProgressBar prog={prog} />
      <ResultBanner result={result} onClose={() => setResult(null)} />

      {/* Export & Sync */}
      <div className="card spm-section">
        <div className="spm-export-header">
          <div>
            <div className="card-title" style={{ margin: 0 }}>Export &amp; Sync Liked Songs</div>
            <small className="muted">Mirror your Liked Songs to a shareable playlist. Choose how tracks are ordered.</small>
          </div>
        </div>

        {/* Segmented order picker */}
        <div className="spm-seg-wrap">
          <div className="spm-seg">
            {[
              { v: "2", label: "Add Order", tag: "★" },
              { v: "1", label: "Newest First" },
              { v: "3", label: "Preserve Custom" },
            ].map(({ v, label, tag }) => (
              <button
                key={v}
                type="button"
                className={`spm-seg-btn${exportOrder === v ? " active" : ""}`}
                onClick={() => setExportOrder(v)}
              >
                {label}
                {tag && <span className="spm-seg-tag">{tag}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Live description */}
        <div className="spm-export-desc-box">
          {exportOrder === "2" && (
            <>
              <strong>Oldest first</strong> - songs appear in the exact order you liked them over time.
              Perfect for a personal listening timeline. <span className="spm-rec-badge">Recommended</span>
            </>
          )}
          {exportOrder === "1" && (
            <>
              <strong>Newest first</strong> - most recently liked song at the top, matching Spotify&apos;s own Liked Songs view.
            </>
          )}
          {exportOrder === "3" && (
            <>
              <strong>Preserve custom order</strong> - keeps your existing playlist arrangement. Only newly liked songs are appended and unliked ones removed.
            </>
          )}
        </div>

        <button className="primary" style={{ marginTop: 4 }} onClick={doExport} disabled={busy}>
          {busy ? "Syncing…" : "Sync to Playlist"}
        </button>
      </div>

      {/* Time Machine */}
      <div className="card spm-section">
        <div className="spm-export-header">
          <div>
            <div className="card-title" style={{ margin: 0 }}>Time Machine Playlist</div>
            <small className="muted">Snapshot everything you liked between two dates.</small>
          </div>
        </div>

        <div className="spm-tm-range">
          <div className="spm-tm-field">
            <label className="spm-tm-lbl">From</label>
            <input type="date" value={tmStart} onChange={(e) => setTmStart(e.target.value)} />
          </div>
          <span className="spm-tm-sep">→</span>
          <div className="spm-tm-field">
            <label className="spm-tm-lbl">To</label>
            <input type="date" value={tmEnd} onChange={(e) => setTmEnd(e.target.value)} />
          </div>
          <div className="spm-tm-field">
            <label className="spm-tm-lbl">Order</label>
            <select value={tmOrder} onChange={(e) => setTmOrder(e.target.value)}>
              <option value="1">Oldest first ★</option>
              <option value="2">Newest first</option>
            </select>
          </div>
        </div>

        <div className="spm-tm-name-row">
          <input
            placeholder={`Time Machine: ${tmStart} → ${tmEnd}`}
            value={tmName}
            onChange={(e) => setTmName(e.target.value)}
            style={{ flex: 1 }}
          />
          <button
            className="primary"
            onClick={doTimeMachine}
            disabled={busy || !tmStart || !tmEnd}
          >
            {busy ? "Creating…" : "Create Playlist"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 2 - Playlists
// ═══════════════════════════════════════════════════════════════════════════════

const SORT_FIELDS = [
  { key: "year",         label: "Year",         audio: false },
  { key: "popularity",   label: "Popularity",   audio: false },
  { key: "duration",     label: "Duration",     audio: false },
  { key: "artist",       label: "Artist",       audio: false },
  { key: "name",         label: "Title",        audio: false },
  { key: "bpm",          label: "BPM",          audio: true  },
  { key: "energy",       label: "Energy",       audio: true  },
  { key: "danceability", label: "Danceability", audio: true  },
  { key: "valence",      label: "Valence (mood)", audio: true },
];

const ARC_TYPES = [
  { v: "1", label: "Build-up",   icon: "↗", desc: "Calm & mellow → high energy" },
  { v: "2", label: "Wind-down",  icon: "↘", desc: "High energy → calm & reflective" },
  { v: "3", label: "Valley",     icon: "∪", desc: "Energetic → dips low → peaks again" },
  { v: "4", label: "Pyramid",    icon: "∧", desc: "Builds to peak in the middle, then fades" },
];

function PlaylistsTab({ playlists }) {
  const { prog, busy, run } = useProgress();
  const [result, setResult] = useState(null);

  // Shared playlist selection
  const [selPl, setSelPl] = useState(null);

  // Sort state
  const [sortFields, setSortFields] = useState([]);
  const [sortDirs, setSortDirs]     = useState({});
  const toggleSortField = (key) => {
    setSortFields((prev) =>
      prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]
    );
    setSortDirs((prev) => prev[key] ? prev : { ...prev, [key]: "asc" });
  };

  // Mood Arc
  const [arcType, setArcType] = useState("1");

  // Duplicates
  const [dupeResult, setDupeResult] = useState(null);

  // Merger
  const [mergeSelected, setMergeSelected] = useState([]);
  const [mergeDedup, setMergeDedup]       = useState(true);
  const [mergeInterleave, setMergeInterleave] = useState(false);
  const [mergeName, setMergeName]         = useState("");
  const toggleMergePl = (p) =>
    setMergeSelected((prev) =>
      prev.includes(p.uri) ? prev.filter((u) => u !== p.uri) : [...prev, p.uri]
    );

  const setRes = (r, msg) => setResult(r?.ok ? { ok: true, message: msg } : { ok: false, error: r?.error });

  async function doSort() {
    if (!selPl || !sortFields.length) return;
    const r = await run(() => api.spotify.sortPlaylist({
      playlistId: selPl.uri.split(":").pop(),
      fields: sortFields,
      directions: sortFields.map((f) => sortDirs[f] || "asc"),
    }));
    setRes(r, `✓ "${selPl.name}" sorted by ${sortFields.join(", ")} (${r?.total} tracks)`);
  }

  async function doArc() {
    if (!selPl) return;
    const r = await run(() => api.spotify.applyMoodArc({
      playlistId: selPl.uri.split(":").pop(),
      arcType,
    }));
    setRes(r, `✓ ${ARC_TYPES.find((a) => a.v === arcType)?.label} arc applied to "${selPl.name}"`);
  }

  async function doDetectDupes() {
    if (!selPl) return;
    const r = await run(() => api.spotify.detectPlaylistDuplicates({
      playlistId: selPl.uri.split(":").pop(),
    }));
    if (r?.ok) setDupeResult(r);
    else setResult({ ok: false, error: r?.error });
  }

  async function doRemoveDupes() {
    if (!selPl) return;
    const r = await run(() => api.spotify.removeExactDuplicates({
      playlistId: selPl.uri.split(":").pop(),
    }));
    setRes(r, `✓ Removed ${r?.removed} duplicate(s). "${selPl.name}" now has ${r?.remaining} tracks.`);
    setDupeResult(null);
  }

  async function doMerge() {
    if (mergeSelected.length < 2) return;
    const ids = mergeSelected.map((uri) => uri.split(":").pop());
    const r = await run(() => api.spotify.mergePlaylists({
      ids, dedup: mergeDedup, interleave: mergeInterleave,
      name: mergeName.trim() || undefined,
    }));
    setRes(r, `✓ Created "${r?.playlistName}" with ${r?.total} tracks`);
    if (r?.ok) { setMergeSelected([]); setMergeName(""); }
  }

  return (
    <div className="spm-tab-content">
      <ProgressBar prog={prog} />
      <ResultBanner result={result} onClose={() => setResult(null)} />

      {/* Playlist Picker */}
      <div className="card spm-section">
        <div className="card-title" style={{ marginBottom: 8 }}>Active Playlist</div>
        {selPl
          ? <div className="spm-selected-pl">
              <div className="row" style={{ gap: 10, alignItems: "center" }}>
                {selPl.image
                  ? <img src={selPl.image} alt="" style={{ width: 44, height: 44, borderRadius: 8, objectFit: "cover" }} />
                  : <div className="spm-pl-fallback spm-pl-art">{selPl.synthetic ? "♥" : "♪"}</div>}
                <div>
                  <strong>{selPl.name}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>{selPl.tracks} tracks</div>
                </div>
                <button className="ghost xsmall" style={{ marginLeft: "auto" }} onClick={() => setSelPl(null)}>Change</button>
              </div>
            </div>
          : <PlaylistPicker playlists={playlists.filter((p) => !p.synthetic)} selected={selPl} onSelect={setSelPl} />}
      </div>

      {/* Sort */}
      <div className="card spm-section">
        <div className="spm-section-head">
          <span className="spm-section-icon">⇅</span>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Sort Playlist</div>
          </div>
        </div>
        <div className="spm-sort-grid">
          {SORT_FIELDS.map(({ key, label, audio }) => (
            <label key={key} className={`spm-sort-chip${sortFields.includes(key) ? " on" : ""}`}>
              <input type="checkbox" checked={sortFields.includes(key)} onChange={() => toggleSortField(key)} />
              <span>{sortFields.includes(key) ? `${sortFields.indexOf(key) + 1}. ` : ""}{label}</span>
              {audio && <span className="pill gray" style={{ fontSize: 8, marginLeft: 4 }}>audio</span>}
              {sortFields.includes(key) && (
                <select
                  value={sortDirs[key] || "asc"}
                  onChange={(e) => setSortDirs((prev) => ({ ...prev, [key]: e.target.value }))}
                  onClick={(e) => e.stopPropagation()}
                  style={{ marginLeft: 6, fontSize: 11 }}
                >
                  <option value="asc">↑ asc</option>
                  <option value="desc">↓ desc</option>
                </select>
              )}
            </label>
          ))}
        </div>
        {sortFields.length > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Priority: {sortFields.map((f, i) => `${i + 1}. ${f} (${sortDirs[f] || "asc"})`).join(" → ")}
          </div>
        )}
        <button className="primary" style={{ marginTop: 10 }} onClick={doSort}
          disabled={busy || !selPl || !sortFields.length || selPl?.synthetic}>
          {busy ? "Sorting…" : "Apply Sort"}
        </button>
        {selPl?.synthetic && <small className="hint" style={{ marginTop: 6, display: "block" }}>Sort is not available for Liked Songs.</small>}
      </div>

      {/* Mood Arc */}
      <div className="card spm-section">
        <div className="spm-section-head">
          <span className="spm-section-icon">〜</span>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Mood Arc Creator</div>
            <small className="hint">Reorder the playlist to follow an emotional journey using audio energy + valence.</small>
          </div>
        </div>
        <div className="spm-arc-grid">
          {ARC_TYPES.map(({ v, label, icon, desc }) => (
            <button
              key={v}
              type="button"
              className={`spm-arc-card${arcType === v ? " selected" : ""}`}
              onClick={() => setArcType(v)}
            >
              <span className="spm-arc-icon">{icon}</span>
              <strong>{label}</strong>
              <small className="muted">{desc}</small>
            </button>
          ))}
        </div>
        <button className="primary" style={{ marginTop: 10 }} onClick={doArc}
          disabled={busy || !selPl || selPl?.synthetic}>
          {busy ? "Applying Arc…" : `Apply ${ARC_TYPES.find((a) => a.v === arcType)?.label} Arc`}
        </button>
      </div>

      {/* Duplicate Detector */}
      <div className="card spm-section">
        <div className="spm-section-head">
          <span className="spm-section-icon">⊘</span>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Duplicate Detector</div>
            <small className="hint">Finds exact (same track ID) and fuzzy (same title + artist, different version) duplicates.</small>
          </div>
        </div>
        <button className="ghost" onClick={doDetectDupes} disabled={busy || !selPl || selPl?.synthetic}>
          {busy ? "Scanning…" : "Scan for Duplicates"}
        </button>
        {dupeResult && (
          <div className="spm-dupe-results">
            <div className="row between" style={{ marginBottom: 8 }}>
              <span>
                <span className={`pill ${dupeResult.exact.length ? "warn" : "teal"}`}>{dupeResult.exact.length} exact</span>
                {" "}
                <span className={`pill ${dupeResult.fuzzy.length ? "warn" : "teal"}`}>{dupeResult.fuzzy.length} fuzzy</span>
                {" "}
                <span className="muted" style={{ fontSize: 12 }}>of {dupeResult.totalTracks} tracks</span>
              </span>
              {dupeResult.exact.length > 0 && (
                <button className="primary xsmall" onClick={doRemoveDupes} disabled={busy}>
                  Remove {dupeResult.exact.length} exact
                </button>
              )}
            </div>
            {dupeResult.exact.length === 0 && dupeResult.fuzzy.length === 0 && (
              <p className="muted">✓ No duplicates found!</p>
            )}
            {dupeResult.exact.map((d, i) => (
              <div key={i} className="spm-dupe-row exact">
                <span className="pill gray" style={{ fontSize: 9 }}>#{d.dupeIdx}</span>
                <span>{d.track.name}</span>
                <span className="muted">- {d.track.artist}</span>
                <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>first at #{d.firstIdx}</span>
              </div>
            ))}
            {dupeResult.fuzzy.map((d, i) => (
              <div key={i} className="spm-dupe-row fuzzy">
                <span className="pill gray" style={{ fontSize: 9 }}>#{d.dupeIdx}</span>
                <span>{d.track.name}</span>
                <span className="muted">- {d.track.artist}</span>
                <span className="pill gray" style={{ marginLeft: "auto", fontSize: 9 }}>fuzzy</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Merger */}
      <div className="card spm-section">
        <div className="spm-section-head">
          <span className="spm-section-icon">⊕</span>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Playlist Merger</div>
            <small className="hint">Combine two or more playlists into a single new playlist.</small>
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label className="muted" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
            Select playlists to merge ({mergeSelected.length} selected):
          </label>
          <PlaylistPicker
            playlists={playlists.filter((p) => !p.synthetic)}
            selected={mergeSelected}
            onSelect={(p) => toggleMergePl(p)}
            multi
          />
        </div>
        <div className="spm-filter-row" style={{ marginTop: 8 }}>
          <div className="spm-filter-cell">
            <label>New playlist name</label>
            <input
              placeholder="Merged Playlist"
              value={mergeName}
              onChange={(e) => setMergeName(e.target.value)}
            />
          </div>
          <div className="spm-filter-cell" style={{ justifyContent: "flex-end", gap: 12, alignItems: "center", flexDirection: "row" }}>
            <label className="switch" title="Remove duplicate tracks">
              <input type="checkbox" checked={mergeDedup} onChange={(e) => setMergeDedup(e.target.checked)} />
              <span>Deduplicate</span>
            </label>
            <label className="switch" title="Round-robin: 1 song from each playlist in turn">
              <input type="checkbox" checked={mergeInterleave} onChange={(e) => setMergeInterleave(e.target.checked)} />
              <span>Interleave</span>
            </label>
          </div>
        </div>
        <button className="primary" style={{ marginTop: 10 }} onClick={doMerge}
          disabled={busy || mergeSelected.length < 2}>
          {busy ? "Merging…" : `Merge ${mergeSelected.length} Playlists`}
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 3 - Analyse
// ═══════════════════════════════════════════════════════════════════════════════

const MOOD_EMOJI = {
  "Upbeat & Happy":    "🔥",
  "Chill & Positive":  "😊",
  "Intense & Dark":    "😤",
  "Melancholic":       "😔",
  "Mixed / Neutral":   "😐",
};

function AnalyseTab({ playlists }) {
  const { prog, busy, run } = useProgress();
  const [result, setResult] = useState(null);

  // Audio Dashboard
  const [dashPl, setDashPl]       = useState(null);
  const [dashData, setDashData]   = useState(null);

  // Smart Filter
  const [srcType, setSrcType]       = useState("liked");
  const [srcPl, setSrcPl]           = useState(null);
  const [filterName, setFilterName] = useState("");
  const [filters, setFilters]       = useState({
    yearFrom: "", yearTo: "", bpmFrom: "", bpmTo: "",
    energyMin: "", energyMax: "", valenceMin: "", valenceMax: "",
    danceMin: "", popularityMin: "", artist: "",
  });
  const [filterPreview, setFilterPreview] = useState(null);
  const setF = (k) => (e) => setFilters((prev) => ({ ...prev, [k]: e.target.value }));

  const parseFilters = () => {
    const n = (v) => v !== "" && !isNaN(+v) ? +v : undefined;
    const nf = (v) => v !== "" && !isNaN(+v) ? parseFloat(v) : undefined;
    return {
      yearFrom: n(filters.yearFrom), yearTo: n(filters.yearTo),
      bpmFrom: n(filters.bpmFrom), bpmTo: n(filters.bpmTo),
      energyMin: nf(filters.energyMin), energyMax: nf(filters.energyMax),
      valenceMin: nf(filters.valenceMin), valenceMax: nf(filters.valenceMax),
      danceMin: nf(filters.danceMin), popularityMin: n(filters.popularityMin),
      artist: filters.artist.trim() || undefined,
    };
  };

  async function doDashboard() {
    if (!dashPl) return;
    const r = await run(() => api.spotify.audioDashboard({
      playlistId: dashPl.uri.split(":").pop(),
    }));
    if (r?.ok) setDashData(r);
    else setResult({ ok: false, error: r?.error });
  }

  async function doFilter() {
    const r = await run(() => api.spotify.smartFilter({
      sourceType: srcType,
      sourceId:   srcPl?.uri.split(":").pop(),
      filters:    parseFilters(),
      name:       filterName.trim() || undefined,
    }));
    if (r?.ok) {
      setFilterPreview(r);
      setResult({ ok: true, message: r.matched === 0
        ? "No tracks matched those filters - try loosening them."
        : `✓ Created "${r.playlistName}" with ${r.matched} tracks` });
    } else {
      setResult({ ok: false, error: r?.error });
    }
  }

  return (
    <div className="spm-tab-content">
      <ProgressBar prog={prog} />
      <ResultBanner result={result} onClose={() => setResult(null)} />

      {/* Audio Dashboard */}
      <div className="card spm-section">
        <div className="spm-section-head">
          <span className="spm-section-icon">◈</span>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Audio Features Dashboard</div>
            <small className="hint">Visualise the sonic character of any playlist - BPM, energy, mood, danceability, and more.</small>
          </div>
        </div>
        {dashPl
          ? <div className="row" style={{ gap: 10, alignItems: "center", marginBottom: 10 }}>
              <strong>{dashPl.name}</strong>
              <span className="muted">{dashPl.tracks} tracks</span>
              <button className="ghost xsmall" style={{ marginLeft: "auto" }} onClick={() => { setDashPl(null); setDashData(null); }}>Change</button>
            </div>
          : <PlaylistPicker playlists={playlists} selected={dashPl} onSelect={setDashPl} />}
        {dashPl && !dashData && (
          <button className="primary" style={{ marginTop: 10 }} onClick={doDashboard} disabled={busy}>
            {busy ? "Analysing…" : "Analyse Playlist"}
          </button>
        )}
        {dashData && (
          <div className="spm-dash">
            <div className="spm-dash-header">
              <div className="spm-dash-mood">
                <span className="spm-mood-emoji">{MOOD_EMOJI[dashData.mood] || "🎵"}</span>
                <div>
                  <strong>{dashData.mood}</strong>
                  <div className="muted" style={{ fontSize: 12 }}>{dashData.trackCount} tracks analysed</div>
                </div>
              </div>
              <div className="spm-dash-bpm">
                <span className="spm-bpm-num">{fmtBpm(dashData.avgBpm)}</span>
                <span className="muted">avg BPM</span>
              </div>
            </div>

            <div className="spm-feat-grid">
              <FeaturePill label="Energy"       pct={dashData.avgEnergy} />
              <FeaturePill label="Danceability"  pct={dashData.avgDance} />
              <FeaturePill label="Valence (mood)" pct={dashData.avgValence} />
              <FeaturePill label="Acousticness"  pct={dashData.avgAcousticness} />
              <FeaturePill label="Speechiness"   pct={dashData.avgSpeechiness} />
              <FeaturePill label="Liveness"      pct={dashData.avgLiveness} />
              <FeaturePill label="Instrumental"  pct={dashData.avgInstrumentalness} />
            </div>

            <div className="spm-buckets">
              <div className="spm-bucket-group">
                <div className="spm-bucket-title">Energy distribution</div>
                {[
                  { label: "Low (0–0.33)",    val: dashData.eBuckets.low  },
                  { label: "Mid (0.33–0.66)", val: dashData.eBuckets.mid  },
                  { label: "High (0.66–1)",   val: dashData.eBuckets.high },
                ].map(({ label, val }) => (
                  <div key={label} className="spm-bucket-row">
                    <span className="spm-bucket-label">{label}</span>
                    <Bar value={val} max={dashData.trackCount} color="var(--accent)" />
                    <span className="spm-bucket-count">{val}</span>
                  </div>
                ))}
              </div>
              <div className="spm-bucket-group">
                <div className="spm-bucket-title">BPM distribution</div>
                {[
                  { label: "< 80",     val: dashData.bpmBuckets.lt80  },
                  { label: "80–100",   val: dashData.bpmBuckets.b80   },
                  { label: "100–120",  val: dashData.bpmBuckets.b100  },
                  { label: "120–140",  val: dashData.bpmBuckets.b120  },
                  { label: "140+",     val: dashData.bpmBuckets.gt140 },
                ].map(({ label, val }) => (
                  <div key={label} className="spm-bucket-row">
                    <span className="spm-bucket-label">{label}</span>
                    <Bar value={val} max={dashData.trackCount} color="var(--productive)" />
                    <span className="spm-bucket-count">{val}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="spm-top5">
              <div className="spm-bucket-title">⚡ Top 5 most energetic</div>
              {dashData.top5Energy.map((t, i) => (
                <div key={t.id} className="spm-top-row">
                  <span className="spm-top-rank">{i + 1}</span>
                  <div className="spm-top-meta">
                    <strong>{t.name}</strong>
                    <small className="muted">{t.artist}</small>
                  </div>
                  <div className="spm-top-bars">
                    <Bar value={t.energy} max={1} color="var(--accent)" />
                    <span className="muted" style={{ fontSize: 11 }}>energy {fmt(t.energy)} · {fmtBpm(t.bpm)} BPM</span>
                  </div>
                </div>
              ))}
            </div>
            <button className="ghost xsmall" style={{ marginTop: 8 }} onClick={() => setDashData(null)}>Re-analyse</button>
          </div>
        )}
      </div>

      {/* Smart Filter */}
      <div className="card spm-section">
        <div className="spm-section-head">
          <span className="spm-section-icon">⊛</span>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Smart Filter Playlist Creator</div>
            <small className="hint">Filter your Liked Songs (or any playlist) by audio features and metadata, then push the result to a new Spotify playlist.</small>
          </div>
        </div>

        <div className="spm-filter-row" style={{ marginBottom: 10 }}>
          <label className="switch">
            <input type="radio" name="srcType" value="liked" checked={srcType === "liked"} onChange={() => setSrcType("liked")} />
            <span>Liked Songs</span>
          </label>
          <label className="switch">
            <input type="radio" name="srcType" value="playlist" checked={srcType === "playlist"} onChange={() => setSrcType("playlist")} />
            <span>A Playlist</span>
          </label>
        </div>
        {srcType === "playlist" && (
          srcPl
            ? <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 10 }}>
                <strong>{srcPl.name}</strong>
                <button className="ghost xsmall" onClick={() => setSrcPl(null)}>Change</button>
              </div>
            : <PlaylistPicker playlists={playlists.filter((p) => !p.synthetic)} selected={srcPl} onSelect={setSrcPl} />
        )}

        <div className="spm-filter-grid">
          {[
            [{ k: "yearFrom", label: "Year from", ph: "e.g. 2015" }, { k: "yearTo", label: "Year to", ph: "e.g. 2022" }],
            [{ k: "bpmFrom",  label: "BPM from",  ph: "e.g. 100"  }, { k: "bpmTo",  label: "BPM to",  ph: "e.g. 130"  }],
            [{ k: "energyMin",  label: "Energy min",  ph: "0.0–1.0"  }, { k: "energyMax",  label: "Energy max",  ph: "0.0–1.0"  }],
            [{ k: "valenceMin", label: "Valence min",  ph: "0=sad"    }, { k: "valenceMax", label: "Valence max",  ph: "1=happy"  }],
            [{ k: "danceMin",   label: "Danceability min", ph: "0.0–1.0" }, { k: "popularityMin", label: "Popularity min", ph: "0–100" }],
          ].map((row, ri) => (
            <div key={ri} className="spm-filter-row">
              {row.map(({ k, label, ph }) => (
                <div key={k} className="spm-filter-cell">
                  <label>{label}</label>
                  <input placeholder={ph} value={filters[k]} onChange={setF(k)} />
                </div>
              ))}
            </div>
          ))}
          <div className="spm-filter-row">
            <div className="spm-filter-cell">
              <label>Artist keyword</label>
              <input placeholder="e.g. kendrick (partial match)" value={filters.artist} onChange={setF("artist")} />
            </div>
            <div className="spm-filter-cell" style={{ flex: 2 }}>
              <label>New playlist name (optional)</label>
              <input placeholder={`Filtered - ${new Date().toLocaleDateString()}`} value={filterName} onChange={(e) => setFilterName(e.target.value)} />
            </div>
          </div>
        </div>
        <button className="primary" style={{ marginTop: 10 }} onClick={doFilter}
          disabled={busy || (srcType === "playlist" && !srcPl)}>
          {busy ? "Filtering…" : "Create Filtered Playlist"}
        </button>
        {filterPreview?.preview?.length > 0 && (
          <div className="spm-track-list" style={{ marginTop: 10 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Sample matches:</div>
            {filterPreview.preview.map((t, i) => (
              <div key={i} className="spm-track-row">
                <span className="spm-track-num">{i + 1}</span>
                <div className="spm-track-meta"><strong>{t.name}</strong><small className="muted">{t.artist}</small></div>
                <span className="muted" style={{ fontSize: 11 }}>{t.year} · {t.bpm} BPM</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 4 - Tools
// ═══════════════════════════════════════════════════════════════════════════════

function ToolsTab({ playlists }) {
  const { prog, busy, run } = useProgress();
  const [result, setResult] = useState(null);

  // Backup
  const [backupPl, setBackupPl]   = useState(null);
  const [backups, setBackups]     = useState([]);
  const [backupsLoaded, setBL]    = useState(false);

  // Restore
  const [restoreFile, setRestoreFile] = useState(null);
  const [restoreMode, setRestoreMode] = useState("new");

  // Cross-playlist dupes
  const [xDupes, setXDupes] = useState(null);

  const setRes = (r, msg) => setResult(r?.ok ? { ok: true, message: msg } : { ok: false, error: r?.error });

  async function loadBackups() {
    const r = await api.spotify.listBackups();
    setBackups(r?.backups || []);
    setBL(true);
  }

  useEffect(() => { loadBackups(); }, []);

  async function doBackup() {
    if (!backupPl) return;
    const r = await run(() => api.spotify.backupPlaylist({
      playlistId:   backupPl.uri.split(":").pop(),
      playlistName: backupPl.name,
    }));
    setRes(r, `✓ Backed up "${backupPl.name}" (${r?.trackCount} tracks) → ${r?.filename}`);
    if (r?.ok) loadBackups();
  }

  async function doRestore() {
    if (!restoreFile) return;
    const r = await run(() => api.spotify.restorePlaylist({
      filename:  restoreFile.filename,
      mode:      restoreMode,
      targetId:  restoreMode === "overwrite" ? restoreFile.playlistId : undefined,
    }));
    setRes(r, `✓ Restored "${r?.playlistName}" - ${r?.restored} tracks`);
  }

  async function doCrossPlDupes() {
    const r = await run(() => api.spotify.crossPlaylistDupes());
    if (r?.ok) setXDupes(r);
    else setResult({ ok: false, error: r?.error });
  }

  return (
    <div className="spm-tab-content">
      <ProgressBar prog={prog} />
      <ResultBanner result={result} onClose={() => setResult(null)} />

      {/* Backup */}
      <div className="card spm-section">
        <div className="spm-section-head">
          <span className="spm-section-icon">⊞</span>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Playlist Backup</div>
            <small className="hint">Save a complete track snapshot to a local JSON file you can restore from later.</small>
          </div>
        </div>
        {backupPl
          ? <div className="row" style={{ gap: 10, alignItems: "center", marginBottom: 10 }}>
              <strong>{backupPl.name}</strong>
              <span className="muted">{backupPl.tracks} tracks</span>
              <button className="ghost xsmall" style={{ marginLeft: "auto" }} onClick={() => setBackupPl(null)}>Change</button>
            </div>
          : <PlaylistPicker playlists={playlists} selected={backupPl} onSelect={setBackupPl} />}
        <button className="primary" style={{ marginTop: 8 }} onClick={doBackup} disabled={busy || !backupPl}>
          {busy ? "Backing up…" : "Back Up Playlist"}
        </button>
      </div>

      {/* Restore */}
      <div className="card spm-section">
        <div className="spm-section-head">
          <span className="spm-section-icon">⊟</span>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Restore from Backup</div>
            <small className="hint">Reload a previously saved playlist from a local backup file.</small>
          </div>
        </div>
        {!backupsLoaded
          ? <span className="muted">Loading backups…</span>
          : backups.length === 0
            ? <span className="muted">No backups found. Back up a playlist above first.</span>
            : (
              <div className="spm-backup-list">
                {backups.map((b) => (
                  <button
                    key={b.filename}
                    type="button"
                    className={`spm-backup-row${restoreFile?.filename === b.filename ? " selected" : ""}`}
                    onClick={() => setRestoreFile(b)}
                  >
                    <div className="spm-backup-meta">
                      <strong>{b.playlistName}</strong>
                      <small className="muted">{b.trackCount} tracks · {b.backedUpAt?.slice(0, 10)} · {b.sizeKb} KB</small>
                    </div>
                    {restoreFile?.filename === b.filename && <span className="spm-pl-check">✓</span>}
                  </button>
                ))}
              </div>
            )}
        {restoreFile && (
          <div className="spm-filter-row" style={{ marginTop: 10, alignItems: "center" }}>
            <label className="switch">
              <input type="radio" name="restoreMode" value="new" checked={restoreMode === "new"} onChange={() => setRestoreMode("new")} />
              <span>Create new playlist</span>
            </label>
            <label className="switch">
              <input type="radio" name="restoreMode" value="overwrite" checked={restoreMode === "overwrite"} onChange={() => setRestoreMode("overwrite")} />
              <span>Overwrite original</span>
            </label>
            <button className="primary" onClick={doRestore} disabled={busy}>
              {busy ? "Restoring…" : "Restore"}
            </button>
          </div>
        )}
      </div>

      {/* Cross-Playlist Duplicates */}
      <div className="card spm-section">
        <div className="spm-section-head">
          <span className="spm-section-icon">⊗</span>
          <div>
            <div className="card-title" style={{ margin: 0 }}>Cross-Playlist Duplicate Finder</div>
            <small className="hint">Scans all your playlists and surfaces songs that appear in two or more. Useful for cleaning up overlapping collections.</small>
          </div>
        </div>
        <button className="ghost" onClick={doCrossPlDupes} disabled={busy}>
          {busy ? "Scanning all playlists…" : "Scan All Playlists"}
        </button>
        {xDupes && (
          <div style={{ marginTop: 12 }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <span>
                <span className={`pill ${xDupes.dupes.length ? "warn" : "teal"}`}>{xDupes.dupes.length} cross-playlist duplicates</span>
                <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>across {xDupes.scanned} playlists</span>
              </span>
            </div>
            {xDupes.dupes.length === 0
              ? <p className="muted">✓ Your playlists are clean!</p>
              : (
                <div className="spm-track-list">
                  {xDupes.dupes.slice(0, 50).map((d) => (
                    <div key={d.id} className="spm-dupe-row exact">
                      <div className="spm-track-meta">
                        <strong>{d.name}</strong>
                        <small className="muted">{d.artist}</small>
                      </div>
                      <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>
                        in {d.playlists.length} playlists: {d.playlists.slice(0, 3).join(", ")}{d.playlists.length > 3 ? ` +${d.playlists.length - 3} more` : ""}
                      </span>
                    </div>
                  ))}
                  {xDupes.dupes.length > 50 && (
                    <p className="muted" style={{ fontSize: 12 }}>… and {xDupes.dupes.length - 50} more</p>
                  )}
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Spotify page
// ═══════════════════════════════════════════════════════════════════════════════

const TABS = [
  { key: "library",   label: "Library",   icon: "♥" },
  { key: "playlists", label: "Playlists", icon: "▤" },
  { key: "analyse",   label: "Analyse",   icon: "◈" },
  { key: "tools",     label: "Tools",     icon: "⊞" },
];

export default function Spotify() {
  const [tab, setTab]           = useState("library");
  const [status, setStatus]     = useState(null);
  const [playlists, setPlaylists] = useState([]);
  const [plLoading, setPlLoading] = useState(false);
  const [now, setNow]           = useState(null);
  const [hideScopeHint, setHideScopeHint] = useState(
    () => { try { return localStorage.getItem("spm.scopeHint.hidden") === "1"; } catch { return false; } },
  );
  const pollRef = useRef(null);
  function dismissScopeHint() {
    try { localStorage.setItem("spm.scopeHint.hidden", "1"); } catch {}
    setHideScopeHint(true);
  }

  async function loadStatus() {
    const s = await api.spotify.status();
    setStatus(s);
    return s;
  }

  async function loadPlaylists() {
    setPlLoading(true);
    try {
      const r = await api.spotify.myPlaylists(50);
      setPlaylists(r?.items || []);
    } finally {
      setPlLoading(false);
    }
  }

  async function reconnectSpotify() {
    await api.spotify.connect();
    const s = await loadStatus();
    if (s?.connected) { loadPlaylists(); pollNow(); }
  }

  async function pollNow() {
    try {
      const np = await api.spotify.nowPlaying();
      setNow(np?.ok ? np : null);
    } catch { setNow(null); }
  }

  useEffect(() => {
    loadStatus().then((s) => {
      if (s?.connected) { loadPlaylists(); pollNow(); }
    });
    pollRef.current = setInterval(pollNow, 12_000);
    return () => clearInterval(pollRef.current);
  }, []);

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!status) {
    return <div className="spm-page spm-loading"><span className="muted">Loading…</span></div>;
  }

  if (!status.connected) {
    return (
      <div className="spm-page">
        <div className="spm-not-connected">
          <span className="spm-big-icon">♪</span>
          <h2>Spotify Manager</h2>
          <p className="muted">Connect your Spotify account to manage playlists, export liked songs, run audio analytics, and more.</p>
          <button className="primary" onClick={async () => {
            await api.spotify.connect();
            const s = await loadStatus();
            if (s?.connected) { loadPlaylists(); pollNow(); }
          }}>Connect Spotify</button>
          <small className="hint" style={{ marginTop: 12 }}>
            Or connect via Settings → Integrations → Spotify
          </small>
        </div>
      </div>
    );
  }

  // ── Connected ──────────────────────────────────────────────────────────────
  return (
    <div className="spm-page">
      {/* Header */}
      <div className="spm-header">
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <span className="spm-logo">♪</span>
          <div>
            <h2 style={{ margin: 0 }}>Spotify Manager</h2>
            <small className="muted">
              {status.user?.displayName || status.user?.id || "Connected"}
              {playlists.length > 0 && ` · ${playlists.length} playlists`}
            </small>
          </div>
          {plLoading && <span className="pill gray" style={{ marginLeft: "auto" }}>Loading playlists…</span>}
        </div>

        {/* Mini now-playing strip */}
        {now?.item && (
          <div className="spm-np-strip">
            {now.item.albumArt && <img src={now.item.albumArt} alt="" className="spm-np-art" />}
            <div className="spm-np-info">
              <span className="spm-np-track">{now.item.name}</span>
              <span className="muted spm-np-artist">{now.item.artists}</span>
            </div>
            <div className="spm-np-controls">
              <button className="ghost xsmall" onClick={() => api.spotify.previous()} title="Previous">⏮</button>
              {now.playing
                ? <button className="ghost xsmall" onClick={() => api.spotify.pause()} title="Pause">⏸</button>
                : <button className="ghost xsmall" onClick={() => api.spotify.play()} title="Play">▶</button>}
              <button className="ghost xsmall" onClick={() => api.spotify.next()} title="Next">⏭</button>
            </div>
            <span className={`spm-np-dot${now.playing ? " playing" : ""}`} />
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="spm-tabs">
        {TABS.map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            className={`spm-tab${tab === key ? " active" : ""}`}
            onClick={() => setTab(key)}
          >
            <span className="spm-tab-icon">{icon}</span>
            {label}
          </button>
        ))}
      </div>

      {/* Scope warning banner - dismissable */}
      {(!hideScopeHint || status.needsReconnectForPlaylistWrite) && (
        <div className="spm-scope-hint">
          <span className="muted" style={{ fontSize: 12 }}>
            {status.needsReconnectForPlaylistWrite ? (
              <>
                Playlist create/edit permissions are missing on this Spotify token.
                Reconnect once to update Zen focus playlist access.
              </>
            ) : (
              <>
                ℹ Playlist create/edit features require <strong>playlist write permissions</strong>.
                If you see 403 errors, reconnect Spotify.
              </>
            )}
          </span>
          {status.needsReconnectForPlaylistWrite && (
            <button className="ghost xsmall" onClick={reconnectSpotify}>Reconnect</button>
          )}
          <button className="ghost xsmall" onClick={dismissScopeHint} title="Dismiss" aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* Tab content */}
      {tab === "library"   && <LibraryTab />}
      {tab === "playlists" && <PlaylistsTab playlists={playlists} />}
      {tab === "analyse"   && <AnalyseTab  playlists={playlists} />}
      {tab === "tools"     && <ToolsTab    playlists={playlists} />}
    </div>
  );
}

