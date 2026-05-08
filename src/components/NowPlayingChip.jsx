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
  const wrapRef = useRef(null);
  const pollRef = useRef(null);

  async function refresh() {
    try {
      const s = await api.spotify.status();
      setStatus(s);
      if (s?.connected) {
        const np = await api.spotify.nowPlaying();
        setNow(np?.ok ? np : null);
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
  if (!now?.item) {
    // Connected but nothing playing — render a small idle chip.
    return (
      <div className="now-playing-chip idle" title="Spotify connected — nothing playing">
        <span aria-hidden>♪</span>
        <span className="muted">silence</span>
      </div>
    );
  }

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
      // Brief delay before refresh — Spotify's playback state takes a sec
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
        {it.albumArt ? (
          <img className="np-art" src={it.albumArt} alt="" />
        ) : (
          <span className="np-icon" aria-hidden>♪</span>
        )}
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
