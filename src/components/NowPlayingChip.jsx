import React, { useEffect, useRef, useState } from "react";
import api from "../lib/api.js";

// Compact "now playing" chip for the dashboard header. Polls Spotify
// every ~10 seconds for the currently-playing track. Click to expand a
// transport popover (play/pause + skip).
//
// Hides itself when not connected so it doesn't take up space until the
// user has linked their Spotify account.
export default function NowPlayingChip() {
  const [status, setStatus] = useState(null);   // status() result
  const [now, setNow] = useState(null);         // nowPlaying() result
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Extra player state - we read these from /me/player so the popover can
  // reflect shuffle / repeat / volume without an extra round-trip per click.
  const [playerState, setPlayerState] = useState({
    shuffle: false,
    repeat: "off", // "off" | "track" | "context"
    volume: 70,
    saved: false, // is the current track in Liked Songs?
  });
  const wrapRef = useRef(null);
  const pollRef = useRef(null);

  async function refresh() {
    try {
      const s = await api.spotify.status();
      setStatus(s);
      if (s?.connected) {
        const np = await api.spotify.nowPlaying();
        setNow(np?.ok ? np : null);
        // Best-effort: read player state for shuffle/repeat/volume + the
        // saved flag for the current track. If any call fails, fall back
        // to the previous local state silently.
        try {
          const devs = await api.spotify.devices();
          const active = (devs?.devices || []).find((d) => d.is_active);
          let saved = false;
          if (np?.item?.uri) {
            try {
              const r = await api.spotify.isTrackSaved(np.item.uri);
              saved = !!r?.saved;
            } catch { /* ignore */ }
          }
          setPlayerState((p) => ({
            ...p,
            volume: active ? (active.volume_percent ?? p.volume) : p.volume,
            saved,
          }));
        } catch { /* ignore */ }
      } else {
        setNow(null);
      }
    } catch {
      setNow(null);
    }
  }

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, 10_000);
    return () => clearInterval(pollRef.current);
  }, []);

  // Outside-click closes the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!status?.connected) return null;
  if (!now?.item) return null;

  const it = now.item;

  async function press(action) {
    setBusy(true);
    try {
      if (action === "play")     await api.spotify.play();
      else if (action === "pause") await api.spotify.pause();
      else if (action === "next")  await api.spotify.next();
      else if (action === "prev")  await api.spotify.previous();
    } finally {
      setBusy(false);
      // Brief delay before refresh - Spotify's playback state takes a sec
      // to flip on its end.
      setTimeout(refresh, 600);
    }
  }

  return (
    <div className="now-playing-chip-wrap" ref={wrapRef}>
      <button
        type="button"
        className={"now-playing-chip" + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        title={`${it.name} · ${it.artists}`}
      >
        {/* Album art rotates while playing - a vinyl-record nod that
            makes the chip feel alive instead of static. CSS handles the
            spin via `data-playing` so we don't reapply animation classes
            and reset the transform on every poll. */}
        <span
          className="np-vinyl-wrap"
          data-playing={now.playing ? "1" : "0"}
        >
          {it.albumArt ? (
            <img className="np-art np-vinyl" src={it.albumArt} alt="" />
          ) : (
            <span className="np-vinyl np-vinyl-fallback" aria-hidden>♪</span>
          )}
        </span>
        <div className="np-meta">
          <span className="np-track">{it.name}</span>
          <span className="np-artist muted">{it.artists}</span>
        </div>
        <span className={"np-dot" + (now.playing ? " playing" : "")} aria-hidden />
      </button>
      {open && (
        <div className="now-playing-popover">
          <div className="np-pop-head">
            {it.albumArt && (
              <img src={it.albumArt} alt="" className="np-pop-art" />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong className="np-pop-track" title={it.name}>{it.name}</strong>
              <small className="muted np-pop-artist" title={it.artists}>{it.artists}</small>
              {it.album && (
                <small className="muted np-pop-album" title={it.album}>
                  {it.album}
                </small>
              )}
            </div>
          </div>
          <div className="np-controls">
            <button className="ghost" onClick={() => press("prev")} disabled={busy} title="Previous">
              ⏮
            </button>
            {now.playing ? (
              <button className="primary" onClick={() => press("pause")} disabled={busy} title="Pause">
                ⏸
              </button>
            ) : (
              <button className="primary" onClick={() => press("play")} disabled={busy} title="Play">
                ▶
              </button>
            )}
            <button className="ghost" onClick={() => press("next")} disabled={busy} title="Next">
              ⏭
            </button>
          </div>
          <div className="np-controls" style={{ marginTop: 4 }}>
            <button
              className={"ghost xsmall" + (playerState.shuffle ? " active" : "")}
              title="Shuffle"
              disabled={busy}
              onClick={async () => {
                const next = !playerState.shuffle;
                setPlayerState((p) => ({ ...p, shuffle: next }));
                await api.spotify.setShuffle(next);
              }}
            >
              🔀
            </button>
            <button
              className={"ghost xsmall" + (playerState.repeat !== "off" ? " active" : "")}
              title={`Repeat: ${playerState.repeat}`}
              disabled={busy}
              onClick={async () => {
                const order = ["off", "context", "track"];
                const next = order[(order.indexOf(playerState.repeat) + 1) % 3];
                setPlayerState((p) => ({ ...p, repeat: next }));
                await api.spotify.setRepeat(next);
              }}
            >
              {playerState.repeat === "track" ? "🔂" : "🔁"}
            </button>
            <button
              className={"ghost xsmall" + (playerState.saved ? " active" : "")}
              title={playerState.saved ? "Remove from Liked Songs" : "Save to Liked Songs"}
              disabled={busy || !it.uri}
              onClick={async () => {
                if (!it.uri) return;
                const next = !playerState.saved;
                setPlayerState((p) => ({ ...p, saved: next }));
                if (next) await api.spotify.saveTrack(it.uri);
                else await api.spotify.unsaveTrack(it.uri);
              }}
            >
              {playerState.saved ? "♥" : "♡"}
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={playerState.volume}
              title={`Volume: ${playerState.volume}%`}
              style={{ flex: 1, marginLeft: 6 }}
              onChange={(e) => {
                const v = +e.target.value;
                setPlayerState((p) => ({ ...p, volume: v }));
              }}
              onMouseUp={(e) => api.spotify.setVolume(+e.target.value)}
              onTouchEnd={(e) => api.spotify.setVolume(+e.target.value)}
            />
          </div>
          {status.focusPlaylistUri && (
            <button
              type="button"
              className="ghost xsmall np-focus-link"
              onClick={async () => { await api.spotify.playFocusPlaylist(); setTimeout(refresh, 600); }}
              title={status.focusPlaylistName || "Start focus playlist"}
            >
              ▶ Start focus playlist
            </button>
          )}
          {it.url && (
            <button
              type="button"
              className="ghost xsmall"
              onClick={() => api.ext?.open?.(it.url)}
              title="Open in Spotify"
            >
              Open in Spotify ↗
            </button>
          )}
        </div>
      )}
    </div>
  );
}
