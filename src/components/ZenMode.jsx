import React, { useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";
import { prettyAppName } from "../lib/appName.js";

const QUICK_MINUTES = [10, 25, 50, 75, 90, 120, 180];
const LOCKED_QUICK_MINUTES = [5, 10, 15, 25, 50, 90, 120, 180];
const MODE_OPTIONS = [
  {
    key: "relaxed",
    label: "Relaxed",
    desc: "Logs drift and nudges blocked apps. You can still stop.",
  },
  {
    key: "strict",
    label: "Strict",
    desc: "Keeps allowed apps in front and brings Apex back on drift.",
  },
  {
    key: "locked",
    label: "Locked",
    desc: "No blocked apps and no stopping until the timer finishes.",
  },
];
const PROFILES = [
  { key: "deep", label: "Deep", name: "Apex Focus - Deep Work" },
  { key: "flow", label: "Flow", name: "Apex Focus - Flow" },
  { key: "calm", label: "Calm", name: "Apex Focus - Calm Study" },
];

export default function ZenMode({ onChanged, onActiveChange }) {
  const [active, setActive] = useState(null);
  const [history, setHistory] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState("strict");
  const [minutes, setMinutes] = useState(50);
  const [title, setTitle] = useState("Deep work");
  const [profile, setProfile] = useState("deep");
  const [allowed, setAllowed] = useState([]);
  const [allowedText, setAllowedText] = useState("");
  const [seededAllowed, setSeededAllowed] = useState(false);
  const [blocked, setBlocked] = useState([]);
  const [blockedText, setBlockedText] = useState("");
  const [allowedSearch, setAllowedSearch] = useState("");
  const [blockedSearch, setBlockedSearch] = useState("");
  const [recentApps, setRecentApps] = useState([]);
  const [attentionApps, setAttentionApps] = useState([]);
  const [activeTimer, setActiveTimer] = useState(null);
  // Off by default — building/playing a Spotify playlist on every Zen start
  // was producing "Focus music skipped" noise whenever no device was active.
  // The choice persists in settings.
  const [createMusic, setCreateMusic] = useState(false);
  useEffect(() => {
    api.settings?.get?.("zen.createMusic").then((v) => {
      if (v === "1") setCreateMusic(true);
    }).catch(() => {});
  }, []);
  function persistCreateMusic(on) {
    setCreateMusic(on);
    api.settings?.set?.("zen.createMusic", on ? "1" : "0").catch(() => {});
  }
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [message, setMessage] = useState(null);
  const [violation, setViolation] = useState(null);
  const [playlistState, setPlaylistState] = useState(null);
  const [lastSummary, setLastSummary] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    refresh();
    const offUpdate = api.zen?.onUpdate?.((payload) => {
      const next = payload?.session || null;
      setActive(next);
      if (payload?.timer !== undefined) setActiveTimer(payload.timer || null);
      onActiveChange?.(!!next, next);
      if (payload?.violation) setViolation(payload.violation);
      if (payload?.playlist) setPlaylistState(payload.playlist);
      if (payload?.ended) {
        setLastSummary(payload.ended);
        setViolation(null);
        loadHistory();
      }
      onChanged?.();
    });
    const offViolation = api.zen?.onViolation?.((payload) => {
      setViolation({
        foreground: payload?.foreground,
        reason: payload?.reason,
      });
    });
    const offTimer = api.timer?.onUpdate?.((t) => setActiveTimer(t || null));
    const offProgress = api.spotify?.onProgress?.((p) => setProgress(p));
    return () => {
      offUpdate?.();
      offViolation?.();
      offTimer?.();
      offProgress?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (seededAllowed) return;
    if (!(mode === "strict" || mode === "locked")) return;
    if (allowedText.trim() || !recentApps.length) return;
    const defaults = recentApps.slice(0, 4).map((x) => x.app);
    setAllowed(defaults);
    setAllowedText(defaults.join(", "));
    setSeededAllowed(true);
  }, [allowedText, mode, recentApps, seededAllowed]);

  async function refresh() {
    const today = new Date().toISOString().slice(0, 10);
    const [z, h, apps, tracker, timer, open] = await Promise.all([
      api.zen?.active?.().catch(() => null),
      api.zen?.history?.(6).catch(() => []),
      api.activity?.topApps?.(today, 14).catch(() => []),
      api.tracker?.status?.().catch(() => null),
      api.timer?.active?.().catch(() => null),
      api.activity?.openApps?.().catch(() => []),
    ]);
    setActive(z || null);
    setActiveTimer(timer || null);
    onActiveChange?.(!!z, z || null);
    setHistory(h || []);

    const openApps = (Array.isArray(open) ? open : [])
      .filter((w) => w && w.app)
      .map((w) => ({
        app: w.app,
        category: w.category || "open",
        title: w.title || "",
      }));
    
    const nextRecent = productiveRecentApps(apps, tracker);
    const recentMap = new Map();
    for (const a of openApps) recentMap.set(a.app.toLowerCase(), a);
    for (const a of nextRecent) {
      if (!recentMap.has(a.app.toLowerCase())) recentMap.set(a.app.toLowerCase(), a);
    }
    setRecentApps(Array.from(recentMap.values()));

    const attnRecent = attentionRecentApps(apps, tracker);
    const attnMap = new Map();
    for (const a of openApps) attnMap.set(a.app.toLowerCase(), a);
    for (const a of attnRecent) {
      if (!attnMap.has(a.app.toLowerCase())) attnMap.set(a.app.toLowerCase(), a);
    }
    setAttentionApps(Array.from(attnMap.values()));
  }

  async function loadHistory() {
    const h = await api.zen?.history?.(6).catch(() => []);
    setHistory(h || []);
  }

  function syncAllowedText(text) {
    setSeededAllowed(true);
    setAllowedText(text);
    setAllowed(parseApps(text));
  }

  function toggleApp(app) {
    setSeededAllowed(true);
    const exists = allowed.some((x) => x.toLowerCase() === app.toLowerCase());
    const next = exists
      ? allowed.filter((x) => x.toLowerCase() !== app.toLowerCase())
      : [...allowed, app];
    setAllowed(next);
    setAllowedText(next.join(", "));
  }

  function syncBlockedText(text) {
    setBlockedText(text);
    setBlocked(parseApps(text));
  }

  function toggleBlockedApp(app) {
    const exists = blocked.some((x) => x.toLowerCase() === app.toLowerCase());
    const next = exists
      ? blocked.filter((x) => x.toLowerCase() !== app.toLowerCase())
      : [...blocked, app];
    setBlocked(next);
    setBlockedText(next.join(", "));
  }

  async function start() {
    setBusy(true);
    setMessage(null);
    setProgress(null);
    setLastSummary(null);
    let playlist = null;
    const selectedProfile = PROFILES.find((p) => p.key === profile) || PROFILES[0];
    try {
      if (createMusic && api.spotify?.createFocusPlaylist) {
        setPlaylistState({ ok: null, status: "building" });
        const r = await api.spotify.createFocusPlaylist({
          profile,
          sourceType: "all",
          name: selectedProfile.name,
          maxTracks: 64,
        });
        if (r?.ok && r.playlistUri) {
          playlist = r;
          setPlaylistState({
            ok: true,
            status: "ready",
            playlistName: r.playlistName,
            matched: r.matched,
            warning: null,
            preview: r.preview || [],
          });
          setMessage(`${r.created ? "Created" : "Updated"} ${r.playlistName} with ${r.matched} tracks.`);
        } else if (r?.error) {
          const friendly = spotifyPlaylistError(r);
          setPlaylistState({
            ok: false,
            status: "skipped",
            error: friendly,
            reconnect: !!r.reconnect,
            code: r.code || null,
          });
          setMessage("Music skipped: " + friendly);
        } else {
          setPlaylistState({ ok: false, status: "skipped", error: "No matching tracks found." });
          setMessage("Music skipped: no matching tracks found.");
        }
      } else {
        setPlaylistState(null);
      }

      const remainingFromTimer = activeTimer ? timerRemainingMinutes(activeTimer) : null;
      const session = await api.zen.start({
        mode,
        title: activeTimer?.title || title.trim() || "Deep work",
        profile,
        allowed_apps: allowed,
        blocked_apps: blocked,
        planned_minutes: remainingFromTimer || minutes,
        bind_existing_timer: !!activeTimer,
        playlist_id: playlist?.playlistId || null,
        playlist_uri: playlist?.playlistUri || null,
        playlist_name: playlist?.playlistName || null,
        created_playlist: !!playlist?.created,
      });
      if (session?.locked || session?.ok === false) {
        setMessage(session.error || "Locked focus is already active.");
        if (session.session) setActive(session.session);
        return;
      }
      setActive(session || null);
      onActiveChange?.(!!session, session || null);
      onChanged?.();
    } finally {
      setBusy(false);
      setProgress(null);
      loadHistory();
    }
  }

  async function stop(reason = "stopped") {
    const ended = await api.zen?.stop?.(reason);
    if (ended?.locked || ended?.ok === false) {
      setMessage(ended.error || "Locked focus can only stop when the timer finishes.");
      if (ended.session) {
        setActive(ended.session);
        onActiveChange?.(true, ended.session);
      }
      return;
    }
    setActive(null);
    onActiveChange?.(false, null);
    setViolation(null);
    if (ended) setLastSummary(ended);
    onChanged?.();
    loadHistory();
  }

  async function reconnectSpotify() {
    setMessage("Opening Spotify reconnect...");
    const r = await api.spotify?.connect?.();
    if (r?.ok) {
      setPlaylistState(null);
      setMessage("Spotify reconnected. Start Zen again to build the focus playlist.");
    } else {
      setMessage("Spotify reconnect failed: " + (r?.error || "unknown"));
    }
  }

  async function extend(mins) {
    const z = await api.zen?.extend?.(mins);
    setActive(z || null);
    onActiveChange?.(!!z, z || null);
    onChanged?.();
  }

  const remaining = useMemo(() => {
    if (!active?.ends_at) return 0;
    return Math.max(0, Math.ceil((new Date(active.ends_at).getTime() - now) / 1000));
  }, [active, now]);

  const elapsedPct = useMemo(() => {
    if (!active) return 0;
    const total = Math.max(1, (active.planned_minutes || 1) * 60);
    return Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
  }, [active, remaining]);

  if (active) {
    const isLocked = active.mode === "locked";
    const activeAllowed = active.allowed_apps || [];
    const activeBlocked = active.blocked_apps || [];
    return (
      <>
        <section className={`zen-panel active mode-${active.mode}`}>
          <div className="zen-meter" style={{ "--zen-progress": `${elapsedPct}%` }} />
          <div className="zen-active-main">
            <div>
              <div className="zen-kicker">
                Zen mode
                <span className={`zen-mode-pill ${active.mode}`}>{active.mode}</span>
              </div>
              <h2 className="zen-title">{active.title}</h2>
              <div className="zen-meta">
                <span>{zenPlaylistLabel(active, playlistState)}</span>
                <span>{active.violations || 0} drift</span>
                {isLocked && <span className="zen-meta-locked">🔒 locked to timer</span>}
              </div>
            </div>
            <div className="zen-clock">
              <strong>{fmtClock(remaining)}</strong>
              <small className="muted">remaining</small>
            </div>
          </div>
          <div className="zen-active-bottom">
            <div className="zen-apps">
              {activeAllowed.slice(0, 8).map((app) => (
                <span key={`allowed-${app}`} className="zen-app-chip">{prettyAppName(app)}</span>
              ))}
              {activeBlocked.slice(0, 8).map((app) => (
                <span key={`blocked-${app}`} className="zen-app-chip blocked">{prettyAppName(app)}</span>
              ))}
              {activeAllowed.length === 0 && activeBlocked.length === 0 && (
                <span className="zen-app-chip muted">watching distracting apps</span>
              )}
            </div>
            <div className="row zen-actions">
              <button className="ghost small" onClick={() => extend(10)}>+10m</button>
              <button className="ghost small" onClick={() => extend(25)}>+25m</button>
              {isLocked ? (
                <button
                  className="ghost small"
                  disabled
                  title="Locked focus ends only when the timer reaches zero"
                >
                  Locked until done
                </button>
              ) : (
                <button className="primary small" onClick={() => stop("stopped")}>End Zen</button>
              )}
            </div>
          </div>
        </section>
        {violation && active.mode !== "relaxed" && (
          <ZenStrictOverlay
            violation={violation}
            mode={active.mode}
            onDismiss={() => setViolation(null)}
          />
        )}
      </>
    );
  }

  return (
    <>
      {lastSummary && (
        <ZenSummaryPanel
          summary={lastSummary}
          onDismiss={() => setLastSummary(null)}
        />
      )}
      {!expanded ? (
        <ZenIdle
          title={title}
          mode={mode}
          setMode={setMode}
          minutes={minutes}
          setMinutes={setMinutes}
          setExpanded={setExpanded}
          start={start}
          busy={busy}
          progress={progress}
          message={message}
          setMessage={setMessage}
          playlistState={playlistState}
          onReconnectSpotify={reconnectSpotify}
          activeTimer={activeTimer}
        />
      ) : (
        <ZenComposer
          title={title}
          setTitle={setTitle}
          mode={mode}
          setMode={setMode}
          minutes={minutes}
          setMinutes={setMinutes}
          profile={profile}
          setProfile={setProfile}
          createMusic={createMusic}
          setCreateMusic={persistCreateMusic}
          allowed={allowed}
          allowedText={allowedText}
          syncAllowedText={syncAllowedText}
          toggleApp={toggleApp}
          blocked={blocked}
          blockedText={blockedText}
          syncBlockedText={syncBlockedText}
          toggleBlockedApp={toggleBlockedApp}
          recentApps={recentApps}
          attentionApps={attentionApps}
          allowedSearch={allowedSearch}
          setAllowedSearch={setAllowedSearch}
          blockedSearch={blockedSearch}
          setBlockedSearch={setBlockedSearch}
          activeTimer={activeTimer}
          progress={progress}
          message={message}
          setMessage={setMessage}
          playlistState={playlistState}
          onReconnectSpotify={reconnectSpotify}
          history={history}
          busy={busy}
          start={start}
          onCollapse={() => setExpanded(false)}
        />
      )}
    </>
  );
}

function ZenIdle({
  title,
  mode,
  setMode,
  minutes,
  setMinutes,
  setExpanded,
  start,
  busy,
  progress,
  message,
  setMessage,
  playlistState,
  onReconnectSpotify,
  activeTimer,
}) {
  const modeMeta = MODE_OPTIONS.find((m) => m.key === mode) || MODE_OPTIONS[1];
  const timerMinutes = activeTimer ? timerRemainingMinutes(activeTimer) : null;
  return (
    <section className="zen-panel zen-panel-compact">
      <div className="zen-quick">
        <div className="zen-quick-main">
          <div className="zen-kicker">Zen mode</div>
          <strong className="zen-quick-title">
            {activeTimer?.title || title || "Lock in"}
          </strong>
          <small className="muted">
            {activeTimer
              ? timerMinutes
                ? `Protecting current timer - about ${timerMinutes}m left`
                : "Protecting current timer"
              : modeMeta.desc}
          </small>
        </div>
        <div className="zen-segment">
          {MODE_OPTIONS.map((m) => (
            <button
              key={m.key}
              type="button"
              className={mode === m.key ? "active" : ""}
              onClick={() => setMode(m.key)}
              title={m.desc}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="zen-quick-minutes">
          {(mode === "locked" ? [5, 10, 25, 50, 90] : [25, 50, 90]).map((m) => (
            <button
              key={m}
              type="button"
              className={minutes === m ? "chip active" : "chip"}
              onClick={() => setMinutes(m)}
              disabled={!!activeTimer}
              title={activeTimer ? "Zen will use the current timer's remaining time" : undefined}
            >
              {m}m
            </button>
          ))}
        </div>
        <button className="ghost small" onClick={() => setExpanded(true)}>
          Tune
        </button>
        <button className="primary small" onClick={start} disabled={busy || !minutes}>
          {busy ? "Starting..." : activeTimer ? "Protect timer" : mode === "locked" ? "Start locked" : "Start Zen"}
        </button>
      </div>
      <PlaylistStatus state={playlistState} compact onReconnect={onReconnectSpotify} />
      {(progress || message) && (
        <div className="zen-status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            {progress?.message || message}
            {progress?.total > 0 && (
              <span> {Math.round((progress.current / progress.total) * 100)}%</span>
            )}
          </div>
          {!progress && message && (
            <button className="ghost small" style={{ marginLeft: 8, padding: '2px 6px' }} onClick={() => setMessage?.(null)}>✕</button>
          )}
        </div>
      )}
    </section>
  );
}

function ZenComposer({
  title,
  setTitle,
  mode,
  setMode,
  minutes,
  setMinutes,
  profile,
  setProfile,
  createMusic,
  setCreateMusic,
  allowed,
  allowedText,
  syncAllowedText,
  toggleApp,
  blocked,
  blockedText,
  syncBlockedText,
  toggleBlockedApp,
  recentApps,
  attentionApps,
  allowedSearch,
  setAllowedSearch,
  blockedSearch,
  setBlockedSearch,
  activeTimer,
  progress,
  message,
  setMessage,
  playlistState,
  onReconnectSpotify,
  history,
  busy,
  start,
  onCollapse,
}) {
  const modeMeta = MODE_OPTIONS.find((m) => m.key === mode) || MODE_OPTIONS[1];
  const durationOptions = mode === "locked" ? LOCKED_QUICK_MINUTES : QUICK_MINUTES;
  const timerMinutes = activeTimer ? timerRemainingMinutes(activeTimer) : null;
  const allApps = Array.from(new Map([...recentApps, ...attentionApps].map(a => [a.app.toLowerCase(), a])).values());
  return (
    <section className="zen-panel">
      <div className="zen-compose">
        <div className="zen-compose-head">
          <div>
            <div className="zen-kicker">Zen mode</div>
            <h2 className="zen-title">Lock in</h2>
          </div>
          <div className="zen-compose-actions">
            <button className="ghost small" onClick={onCollapse}>
              Done
            </button>
            <div className="zen-segment">
              {MODE_OPTIONS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={mode === m.key ? "active" : ""}
                  onClick={() => setMode(m.key)}
                  title={m.desc}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={`zen-mode-note mode-${mode}`}>
          <strong>{modeMeta.label}</strong>
          <span>{modeMeta.desc}</span>
          {activeTimer && (
            <small>
              {timerMinutes
                ? `This will wrap "${activeTimer.title}" and end with its remaining ${timerMinutes}m timer.`
                : `This will wrap "${activeTimer.title}" and end with the current timer.`}
            </small>
          )}
        </div>

        <div className="zen-grid">
          <div className="zen-field wide">
            <label>Focus</label>
            <input
              value={activeTimer?.title || title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!!activeTimer}
              title={activeTimer ? "Zen will use the active timer title" : undefined}
            />
          </div>
          <div className="zen-field">
            <label>Duration</label>
            <div className="zen-duration-row">
              {durationOptions.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={minutes === m ? "chip active" : "chip"}
                  onClick={() => setMinutes(m)}
                  disabled={!!activeTimer}
                >
                  {m}m
                </button>
              ))}
              <input
                type="number"
                min={5}
                max={600}
                step={5}
                value={timerMinutes || minutes}
                onChange={(e) => setMinutes(Math.max(5, +e.target.value || 50))}
                disabled={!!activeTimer}
                title={activeTimer ? "Extend the timer first if you want a longer locked block" : "Custom minutes"}
              />
            </div>
          </div>
          <div className="zen-field">
            <label>Music</label>
            <div className="zen-profile-row">
              {PROFILES.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={profile === p.key ? "active" : ""}
                  onClick={() => setProfile(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <label className="zen-check">
              <input
                type="checkbox"
                checked={createMusic}
                onChange={(e) => setCreateMusic(e.target.checked)}
              />
              <span>Create and play focus playlist</span>
            </label>
            <PlaylistStatus state={playlistState} onReconnect={onReconnectSpotify} />
          </div>
          <div className="zen-field wide">
            <label>Allowed productive apps</label>
            <input
              value={allowedText}
              onChange={(e) => syncAllowedText(e.target.value)}
              placeholder={
                mode === "relaxed"
                  ? "Optional: relaxed mode can leave this blank"
                  : "Only these apps stay in bounds; pick from productive recents below"
              }
            />
            <div className="zen-search-row" style={{ marginTop: 8, marginBottom: 8 }}>
              <input
                type="search"
                className="small"
                placeholder="Search open or recent apps..."
                value={allowedSearch}
                onChange={(e) => setAllowedSearch(e.target.value)}
              />
            </div>
            <div className="zen-suggestions">
              {recentApps.length === 0 && (
                <small className="muted">
                  Productive open/recent apps appear here after the tracker records activity.
                </small>
              )}
              {(allowedSearch ? allApps : recentApps)
                .filter((app) => !allowedSearch || app.app.toLowerCase().includes(allowedSearch.toLowerCase()))
                .slice(0, 20)
                .map(({ app, minutes: appMinutes, category }) => {
                const on = allowed.some((x) => x.toLowerCase() === app.toLowerCase());
                return (
                  <button
                    key={`allowed-${app}`}
                    type="button"
                    className={on ? "on" : ""}
                    onClick={() => toggleApp(app)}
                    title={`${app} - ${category || "productive"}`}
                  >
                    {prettyAppName(app)}
                    {appMinutes ? <small>{Math.round(appMinutes)}m</small> : null}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="zen-field wide">
            <label>{mode === "relaxed" ? "Apps to nudge away from" : "Blocked apps"}</label>
            <input
              value={blockedText}
              onChange={(e) => syncBlockedText(e.target.value)}
              placeholder={
                mode === "locked"
                  ? "e.g. Valorant, Discord, Steam - locked mode blocks these until done"
                  : "e.g. YouTube, Discord, Steam - relaxed logs/nudges these"
              }
            />
            <div className="zen-search-row" style={{ marginTop: 8, marginBottom: 8 }}>
              <input
                type="search"
                className="small"
                placeholder="Search open or recent apps..."
                value={blockedSearch}
                onChange={(e) => setBlockedSearch(e.target.value)}
              />
            </div>
            <div className="zen-suggestions">
              {attentionApps.length === 0 && (
                <small className="muted">
                  Distracting open/recent apps appear here after the tracker records activity.
                </small>
              )}
              {(blockedSearch ? allApps : attentionApps)
                .filter((app) => !blockedSearch || app.app.toLowerCase().includes(blockedSearch.toLowerCase()))
                .slice(0, 20)
                .map(({ app, minutes: appMinutes, category }) => {
                const on = blocked.some((x) => x.toLowerCase() === app.toLowerCase());
                return (
                  <button
                    key={`blocked-${app}`}
                    type="button"
                    className={on ? "on danger" : ""}
                    onClick={() => toggleBlockedApp(app)}
                    title={`${app} - ${category || "attention"}`}
                  >
                    {prettyAppName(app)}
                    {appMinutes ? <small>{Math.round(appMinutes)}m</small> : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {(progress || message) && (
          <div className="zen-status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              {progress?.message || message}
              {progress?.total > 0 && (
                <span> {Math.round((progress.current / progress.total) * 100)}%</span>
              )}
            </div>
            {!progress && message && (
              <button className="ghost small" style={{ marginLeft: 8, padding: '2px 6px' }} onClick={() => setMessage?.(null)}>✕</button>
            )}
          </div>
        )}

        <div className="zen-footer">
          <div className="zen-history">
            {history.slice(0, 3).map((z) => (
              <span key={z.id}>{z.status} - {z.planned_minutes}m - {z.violations || 0} drift</span>
            ))}
          </div>
          <button className="primary zen-start" onClick={start} disabled={busy || !minutes}>
            {busy ? "Starting..." : activeTimer ? "Protect timer" : mode === "locked" ? "Start locked" : "Start Zen"}
          </button>
        </div>
      </div>
    </section>
  );
}

function ZenStrictOverlay({ violation, mode, onDismiss }) {
  const [wait, setWait] = useState(3);
  useEffect(() => {
    setWait(3);
    const id = setInterval(() => setWait((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(id);
  }, [violation]);
  return (
    <div className="zen-lock-scrim">
      <div className="zen-lock-panel intrusive">
        <div className="zen-lock-eyebrow">
          {mode === "locked" ? "Locked focus" : "Outside Zen"}
        </div>
        <h3>{prettyAppName(violation.foreground?.app) || "Blocked app"}</h3>
        <p className="muted">{violation.foreground?.title || violation.reason}</p>
        <button className="primary" onClick={onDismiss} disabled={wait > 0}>
          {wait > 0 ? `Back in ${wait}` : "Back to work"}
        </button>
      </div>
    </div>
  );
}

function ZenSummaryPanel({ summary, onDismiss }) {
  const events = summary?.violation_events || [];
  const start = summary?.started_at ? new Date(summary.started_at) : null;
  const end = summary?.ended_at ? new Date(summary.ended_at) : new Date();
  const actualMinutes = start
    ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000))
    : summary?.planned_minutes;
  const topDistractions = summarizeViolations(events);
  return (
    <section className="zen-panel zen-summary">
      <div className="zen-summary-head">
        <div>
          <div className="zen-kicker">Zen summary</div>
          <h2 className="zen-title">{summary?.title || "Focus block"}</h2>
          <div className="zen-meta">
            <span>{actualMinutes || 0}m</span>
            <span>{summary?.status || "ended"}</span>
            <span>{summary?.violations || 0} drift</span>
          </div>
        </div>
        <button className="ghost small" onClick={onDismiss}>Dismiss</button>
      </div>
      <div className="zen-summary-grid">
        <div>
          <small className="muted">Mode</small>
          <strong>{summary?.mode || "strict"}</strong>
        </div>
        <div>
          <small className="muted">Playlist</small>
          <strong>{summary?.playlist_name || "none"}</strong>
        </div>
        <div>
          <small className="muted">Distractions</small>
          <strong>{topDistractions || "clean"}</strong>
        </div>
      </div>
      {events.length > 0 && (
        <div className="zen-summary-events">
          {events.slice(0, 5).map((event, i) => (
            <div key={`${event.at}-${i}`} className="zen-summary-event">
              <span>{prettyAppName(event.app) || event.app || "App"}</span>
              <small className="muted">
                {event.reason || "drift"} - {event.at ? shortTime(event.at) : ""}
              </small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PlaylistStatus({ state, compact = false, onReconnect }) {
  if (!state) return null;
  if (state.status === "building") {
    return (
      <div className={"zen-playlist-status" + (compact ? " compact" : "")}>
        Building focus playlist...
      </div>
    );
  }
  if (state.ok === true) {
    return (
      <div className={"zen-playlist-status ok" + (compact ? " compact" : "")}>
        Focus music ready{state.device ? ` on ${state.device}` : state.playlistName ? ` - ${state.playlistName}` : ""}
        {state.warning ? <small>{state.warning}</small> : null}
      </div>
    );
  }
  if (state.ok === false) {
    return (
      <div className={"zen-playlist-status warn" + (compact ? " compact" : "")}>
        <span>Music skipped: {state.error}</span>
        {state.reconnect && onReconnect ? (
          <button type="button" className="ghost xsmall" onClick={onReconnect}>
            Reconnect Spotify
          </button>
        ) : null}
      </div>
    );
  }
  return null;
}

function parseApps(text) {
  return String(text || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function spotifyPlaylistError(result) {
  if (result?.code === "SPOTIFY_RECONNECT_SCOPES" || result?.reconnect) {
    return "Spotify needs playlist write permission. Reconnect Spotify once, then start Zen again.";
  }
  const raw = String(result?.error || "Could not build the focus playlist.").trim();
  if (/Spotify 403/i.test(raw)) {
    return "Spotify denied that music request. Apex will keep Zen running; reconnect Spotify if playlist creation keeps failing.";
  }
  return raw;
}

function productiveRecentApps(rows, tracker) {
  const out = [];
  const push = (entry) => {
    const app = String(entry?.app || "").trim();
    if (!app) return;
    const category = entry?.category || "productive";
    if (category !== "productive") return;
    const srcs = (entry?.sources || entry?.source || "").toString();
    if (srcs.includes("mobile") && !srcs.includes("desktop")) return;
    const key = app.toLowerCase();
    if (out.some((x) => x.app.toLowerCase() === key)) return;
    out.push({
      app,
      category,
      minutes: Math.max(0, Math.round(+entry?.minutes || 0)),
    });
  };

  if (tracker?.current?.category === "productive") {
    push({
      app: tracker.current.app,
      category: tracker.current.category,
      minutes: tracker.current.minutes,
    });
  }
  for (const row of rows || []) push(row);
  return out.slice(0, 12);
}

function attentionRecentApps(rows, tracker) {
  const out = [];
  const push = (entry) => {
    const app = String(entry?.app || "").trim();
    if (!app) return;
    const category = entry?.category || "neutral";
    if (category === "productive") return;
    const srcs = (entry?.sources || entry?.source || "").toString();
    if (srcs.includes("mobile") && !srcs.includes("desktop")) return;
    const key = app.toLowerCase();
    if (out.some((x) => x.app.toLowerCase() === key)) return;
    out.push({
      app,
      category,
      minutes: Math.max(0, Math.round(+entry?.minutes || 0)),
    });
  };

  if (tracker?.current?.category && tracker.current.category !== "productive") {
    push({
      app: tracker.current.app,
      category: tracker.current.category,
      minutes: tracker.current.minutes,
    });
  }
  for (const row of rows || []) push(row);
  return out.slice(0, 12);
}

function timerRemainingMinutes(timer) {
  if (!timer?.started_at) return null;
  const total = ((+timer.planned_minutes || 0) + (+timer.extended_minutes || 0)) * 60;
  const started = new Date(timer.started_at).getTime();
  if (!Number.isFinite(started)) return Math.max(1, Math.ceil(total / 60) || 1);
  const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
  return Math.max(1, Math.ceil(Math.max(0, total - elapsed) / 60));
}

function zenPlaylistLabel(active, playlistState) {
  if (playlistState?.ok === true && playlistState.device) return `Playing on ${playlistState.device}`;
  if (playlistState?.ok === false) return "Focus music skipped";
  return active.playlist_name || "No focus playlist";
}

function summarizeViolations(events) {
  const counts = new Map();
  for (const e of events || []) {
    const name = prettyAppName(e.app) || e.app;
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`)
    .join(", ");
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function shortTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
