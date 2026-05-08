// Apex — Spotify integration via OAuth Authorization Code with PKCE.
//
// Flow:
//   1. We open a child BrowserWindow at accounts.spotify.com/authorize with
//      a generated PKCE challenge + a 127.0.0.1 redirect URI.
//   2. The user signs in. Spotify redirects to our redirect URI with
//      ?code=…  We intercept that navigation in the BrowserWindow's
//      `did-navigate`/`will-redirect` and pull the code.
//   3. Exchange code → access_token + refresh_token (no client secret —
//      that's the whole point of PKCE).
//   4. Persist refresh_token in settings; refresh access_token on demand
//      whenever it expires.
//
// Token storage:
//   settings.spotify.accessToken
//   settings.spotify.refreshToken
//   settings.spotify.expiresAt    (unix ms)
//   settings.spotify.userId
//   settings.spotify.userDisplayName
//   settings.spotify.clientId     (optional override; defaults to public id)
//   settings.spotify.focusPlaylistUri
//   settings.spotify.focusPlaylistName
//   settings.spotify.autoPlayFocus   "1" | "0"

const crypto = require("node:crypto");
const db = require("./db.cjs");

// Default Spotify Developer App credentials. The redirect URI MUST be
// whitelisted in the Spotify dashboard — http://127.0.0.1:8000/callback
// is the one configured for the bundled client. Users with their own app
// can override the client_id in Settings → Integrations → Spotify; the
// redirect URI for any custom app must match this exact string.
const DEFAULT_CLIENT_ID = "ec8d15f5377e40699a668cbd38643a3c";
const REDIRECT_URI = "http://127.0.0.1:8000/callback";
const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-recently-played",
  "user-read-private",
  "user-read-email",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",       // for Liked Songs (/me/tracks)
  "user-library-modify",     // for like / unlike the current track
  "user-top-read",            // for top tracks/artists
];

// Sentinel URI we use internally to mean "the user's Liked Songs".
// Spotify itself uses spotify:user:<id>:collection for this in the desktop
// client, but it's not officially supported via the Web API context_uri,
// so we intercept this sentinel and play /me/tracks manually.
const LIKED_SONGS_URI = "apex:liked-songs";

function _clientId() {
  return (db.getSetting("spotify.clientId") || DEFAULT_CLIENT_ID).trim();
}

// PKCE helpers
function _b64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function _verifier() {
  return _b64url(crypto.randomBytes(48));
}
function _challenge(verifier) {
  return _b64url(crypto.createHash("sha256").update(verifier).digest());
}

// ─── token storage ──────────────────────────────────────────────────────
function _saveTokens({ access_token, refresh_token, expires_in }) {
  if (access_token) db.setSetting("spotify.accessToken", access_token);
  if (refresh_token) db.setSetting("spotify.refreshToken", refresh_token);
  if (Number.isFinite(+expires_in)) {
    const expiresAt = Date.now() + (+expires_in - 30) * 1000;
    db.setSetting("spotify.expiresAt", String(expiresAt));
  }
}
function _readTokens() {
  return {
    accessToken: db.getSetting("spotify.accessToken") || null,
    refreshToken: db.getSetting("spotify.refreshToken") || null,
    expiresAt: parseInt(db.getSetting("spotify.expiresAt") || "0", 10) || 0,
  };
}
function _clearTokens() {
  for (const k of [
    "spotify.accessToken",
    "spotify.refreshToken",
    "spotify.expiresAt",
    "spotify.userId",
    "spotify.userDisplayName",
  ]) {
    db.setSetting(k, null);
  }
}

// ─── auth ───────────────────────────────────────────────────────────────
let _authResolver = null; // resolves the open `connect` promise from the redirect
async function connect({ BrowserWindow, session }) {
  if (_authResolver) {
    return { ok: false, error: "Auth window already open" };
  }
  const verifier = _verifier();
  const challenge = _challenge(verifier);
  const state = _b64url(crypto.randomBytes(8));

  const params = new URLSearchParams({
    response_type: "code",
    client_id: _clientId(),
    scope: SCOPES.join(" "),
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  });
  const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;

  return await new Promise((resolve) => {
    let resolved = false;
    // Use a fresh in-memory partition each time so old Spotify cookies
    // never interfere with a new auth attempt — a stale state token from
    // a previous session was a cause of the white-screen mystery.
    const partition = `spotify-auth-${Date.now()}`;
    const win = new BrowserWindow({
      width: 520,
      height: 700,
      title: "Sign in to Spotify",
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    _authResolver = resolve;
    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      _authResolver = null;
      try { win.destroy(); } catch {}
      resolve(val);
    };

    const handleCallback = async (callbackUrl) => {
      try {
        const u = new URL(callbackUrl);
        const code = u.searchParams.get("code");
        const returnedState = u.searchParams.get("state");
        const error = u.searchParams.get("error");
        if (error) return finish({ ok: false, error });
        if (!code) return finish({ ok: false, error: "No code in callback URL" });
        if (returnedState !== state) {
          return finish({ ok: false, error: "State mismatch — auth aborted" });
        }
        const tokRes = await fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            client_id: _clientId(),
            code_verifier: verifier,
          }).toString(),
        });
        if (!tokRes.ok) {
          let body = "";
          try { body = await tokRes.text(); } catch {}
          return finish({
            ok: false,
            error: `Token exchange ${tokRes.status}: ${body.slice(0, 200)}`,
          });
        }
        const tok = await tokRes.json();
        _saveTokens(tok);
        // Best-effort: fetch profile to display in settings.
        try {
          const me = await _fetchAuthed("/me");
          if (me?.id) {
            db.setSetting("spotify.userId", me.id);
            db.setSetting("spotify.userDisplayName", me.display_name || me.id);
          }
        } catch { /* ignore */ }
        finish({ ok: true });
      } catch (err) {
        finish({ ok: false, error: err.message });
      }
    };

    // PRIMARY interception path: webRequest.onBeforeRequest fires BEFORE
    // the BrowserWindow tries to actually fetch the (non-existent)
    // 127.0.0.1 URL, so we never see the blank ERR_CONNECTION_REFUSED
    // page that was breaking the previous flow. We cancel the request
    // outright and pull the code out of the URL.
    const ses = session.fromPartition(partition);
    try {
      ses.webRequest.onBeforeRequest(
        { urls: [`${REDIRECT_URI}*`] },
        (details, cb) => {
          cb({ cancel: true });
          handleCallback(details.url);
        },
      );
    } catch (e) {
      console.warn("[spotify] webRequest filter failed:", e.message);
    }

    // Backup paths: in case webRequest doesn't fire (some Electron
    // versions / scenarios), also listen for navigation events. Each
    // calls handleCallback, which is idempotent via the `resolved` guard.
    const onNav = (_evt, url) => {
      if (typeof url === "string" && url.startsWith(REDIRECT_URI)) {
        try { _evt?.preventDefault?.(); } catch {}
        handleCallback(url);
      }
    };
    win.webContents.on("will-redirect", onNav);
    win.webContents.on("will-navigate", onNav);
    win.webContents.on("did-navigate", onNav);
    // If the browser DID try to load the localhost URL and failed, the
    // failed-load event still carries the URL — recover the code from it.
    win.webContents.on("did-fail-load", (_e, _code, _desc, validatedURL) => {
      if (typeof validatedURL === "string" && validatedURL.startsWith(REDIRECT_URI)) {
        handleCallback(validatedURL);
      }
    });

    win.on("closed", () => finish({ ok: false, error: "User closed the auth window" }));
    win.loadURL(authUrl);
  });
}

async function refreshAccessToken() {
  const t = _readTokens();
  if (!t.refreshToken) return null;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refreshToken,
      client_id: _clientId(),
    }).toString(),
  });
  if (!res.ok) return null;
  const j = await res.json();
  _saveTokens(j); // Spotify may rotate refresh_token on refresh
  return j.access_token;
}
async function _accessToken() {
  const t = _readTokens();
  if (t.accessToken && Date.now() < t.expiresAt) return t.accessToken;
  return await refreshAccessToken();
}

// ─── HTTP helpers ───────────────────────────────────────────────────────
async function _fetchAuthed(path, init = {}) {
  const tok = await _accessToken();
  if (!tok) {
    const err = new Error("Not connected to Spotify");
    err.code = "NOT_CONNECTED";
    throw err;
  }
  const url = path.startsWith("http") ? path : `https://api.spotify.com/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (res.status === 204) return null; // no content (e.g. nothing playing)
  if (res.status === 401) {
    // Token might have just expired — try one refresh + retry.
    const fresh = await refreshAccessToken();
    if (!fresh) throw new Error("Spotify auth expired; please reconnect.");
    const retry = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${fresh}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    if (retry.status === 204) return null;
    if (!retry.ok) throw new Error(`Spotify ${retry.status}`);
    return retry.json().catch(() => null);
  }
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch {}
    throw new Error(`Spotify ${res.status}: ${body.slice(0, 160)}`);
  }
  return res.json().catch(() => null);
}

// ─── public API ─────────────────────────────────────────────────────────
function status() {
  const t = _readTokens();
  const focusPlaylistUri = db.getSetting("spotify.focusPlaylistUri") || null;
  const focusPlaylistName = db.getSetting("spotify.focusPlaylistName") || null;
  const autoPlayFocus = db.getSetting("spotify.autoPlayFocus") === "1";
  return {
    ok: true,
    connected: !!t.refreshToken,
    user: t.refreshToken
      ? {
          id: db.getSetting("spotify.userId") || null,
          displayName: db.getSetting("spotify.userDisplayName") || null,
        }
      : null,
    focusPlaylistUri,
    focusPlaylistName,
    autoPlayFocus,
    clientId: db.getSetting("spotify.clientId") || null, // null = using default
  };
}

function disconnect() {
  _clearTokens();
  return { ok: true };
}

async function nowPlaying() {
  try {
    const data = await _fetchAuthed("/me/player/currently-playing");
    if (!data || !data.item) return { ok: true, playing: false, item: null };
    const it = data.item;
    return {
      ok: true,
      playing: !!data.is_playing,
      progress_ms: data.progress_ms || 0,
      item: {
        name: it.name,
        artists: (it.artists || []).map((a) => a.name).join(", "),
        album: it.album?.name || "",
        albumArt: it.album?.images?.[1]?.url || it.album?.images?.[0]?.url || null,
        durationMs: it.duration_ms,
        url: it.external_urls?.spotify || null,
        uri: it.uri,
      },
    };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code };
  }
}

// Resolve a device to play on. Spotify Web API will 404 with "No active
// device" if nothing is currently the playback target — even if Spotify
// is open. So we always check /me/player/devices first, prefer the
// active one, and otherwise transfer playback to whatever exists.
async function _resolveDevice() {
  try {
    const data = await _fetchAuthed("/me/player/devices");
    const devs = (data && data.devices) || [];
    if (!devs.length) return { ok: false, error: "NO_DEVICES" };
    const active = devs.find((d) => d.is_active && !d.is_restricted);
    if (active) return { ok: true, device: active, transferred: false };
    // No active device but at least one is reachable -- transfer.
    const target =
      devs.find((d) => !d.is_restricted) || devs[0];
    try {
      await _fetchAuthed("/me/player", {
        method: "PUT",
        body: JSON.stringify({ device_ids: [target.id], play: false }),
      });
      // Spotify needs a tick to actually mark it active.
      await new Promise((r) => setTimeout(r, 350));
      return { ok: true, device: target, transferred: true };
    } catch (e) {
      return { ok: false, error: "TRANSFER_FAILED", detail: e.message };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function devices() {
  try {
    const data = await _fetchAuthed("/me/player/devices");
    return { ok: true, devices: data?.devices || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function play(uri) {
  try {
    let body = null;
    if (uri === LIKED_SONGS_URI) {
      // Liked Songs has no playable context_uri; pull the first 50
      // saved tracks and play those as a uris[] batch. Spotify will
      // continue with whatever it auto-chooses next, but the first
      // batch will be your saved library.
      const data = await _fetchAuthed("/me/tracks?limit=50");
      const trackUris = (data?.items || [])
        .map((it) => it?.track?.uri)
        .filter(Boolean);
      if (!trackUris.length) {
        return { ok: false, error: "No liked songs to play", code: "EMPTY" };
      }
      body = { uris: trackUris };
    } else if (uri) {
      body = uri.includes("track:")
        ? { uris: [uri] }
        : { context_uri: uri }; // playlist / album / artist URI
    }

    // Pre-flight: make sure SOME device is reachable. The /play call
    // itself returns 404 "Player command failed: No active device
    // found" if nothing is selected, so we resolve+transfer first.
    const dev = await _resolveDevice();
    if (!dev.ok) {
      return { ok: false, error: dev.error, code: dev.error };
    }

    const path =
      `/me/player/play?device_id=${encodeURIComponent(dev.device.id)}`;
    await _fetchAuthed(path, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: true, device: dev.device.name };
  } catch (err) {
    // Common Premium-only failures: 403 "Restriction violated" or
    // "PREMIUM_REQUIRED". Bubble up so the caller can show a hint.
    const msg = err.message || "";
    let code = null;
    if (/403/.test(msg)) code = "PREMIUM_REQUIRED";
    else if (/404/.test(msg)) code = "NO_ACTIVE_DEVICE";
    return { ok: false, error: msg, code };
  }
}

// ─── extra controls ─────────────────────────────────────────────────────
async function setShuffle(on) {
  try {
    await _fetchAuthed(
      `/me/player/shuffle?state=${on ? "true" : "false"}`,
      { method: "PUT" },
    );
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function setRepeat(state) {
  // state: "track" | "context" | "off"
  const s = ["track", "context", "off"].includes(state) ? state : "off";
  try {
    await _fetchAuthed(`/me/player/repeat?state=${s}`, { method: "PUT" });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function setVolume(percent) {
  const v = Math.max(0, Math.min(100, Math.round(+percent || 0)));
  try {
    await _fetchAuthed(`/me/player/volume?volume_percent=${v}`, { method: "PUT" });
    return { ok: true, volume: v };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function seek(positionMs) {
  const p = Math.max(0, Math.round(+positionMs || 0));
  try {
    await _fetchAuthed(`/me/player/seek?position_ms=${p}`, { method: "PUT" });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function transferTo(deviceId, startPlaying = false) {
  if (!deviceId) return { ok: false, error: "No device id" };
  try {
    await _fetchAuthed("/me/player", {
      method: "PUT",
      body: JSON.stringify({ device_ids: [deviceId], play: !!startPlaying }),
    });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function addToQueue(uri) {
  if (!uri) return { ok: false, error: "No uri" };
  try {
    await _fetchAuthed(
      `/me/player/queue?uri=${encodeURIComponent(uri)}`,
      { method: "POST" },
    );
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function recent(limit = 25) {
  try {
    const data = await _fetchAuthed(
      `/me/player/recently-played?limit=${Math.min(50, +limit || 25)}`,
    );
    const items = (data?.items || []).map((x) => ({
      played_at: x.played_at,
      name: x.track?.name,
      artists: (x.track?.artists || []).map((a) => a.name).join(", "),
      uri: x.track?.uri,
      url: x.track?.external_urls?.spotify || null,
      durationMs: x.track?.duration_ms,
      albumArt: x.track?.album?.images?.[1]?.url || x.track?.album?.images?.[0]?.url || null,
    }));
    return { ok: true, items };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function topTracks(limit = 25) {
  try {
    const data = await _fetchAuthed(
      `/me/top/tracks?limit=${Math.min(50, +limit || 25)}&time_range=short_term`,
    );
    const items = (data?.items || []).map((t) => ({
      name: t.name,
      artists: (t.artists || []).map((a) => a.name).join(", "),
      uri: t.uri,
      url: t.external_urls?.spotify || null,
      durationMs: t.duration_ms,
      albumArt: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
    }));
    return { ok: true, items };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function likedSongs(limit = 50) {
  // For browsing — actually playing them goes through play(LIKED_SONGS_URI).
  try {
    const data = await _fetchAuthed(
      `/me/tracks?limit=${Math.min(50, +limit || 50)}`,
    );
    const items = (data?.items || []).map((it) => ({
      added_at: it.added_at,
      name: it.track?.name,
      artists: (it.track?.artists || []).map((a) => a.name).join(", "),
      uri: it.track?.uri,
      url: it.track?.external_urls?.spotify || null,
      durationMs: it.track?.duration_ms,
      albumArt: it.track?.album?.images?.[1]?.url || it.track?.album?.images?.[0]?.url || null,
    }));
    return { ok: true, total: data?.total || items.length, items };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function isTrackSaved(uri) {
  if (!uri || !uri.includes("track:")) return { ok: false, error: "Not a track uri" };
  const id = uri.split(":").pop();
  try {
    const data = await _fetchAuthed(`/me/tracks/contains?ids=${id}`);
    return { ok: true, saved: !!(Array.isArray(data) && data[0]) };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function saveTrack(uri) {
  if (!uri || !uri.includes("track:")) return { ok: false, error: "Not a track uri" };
  const id = uri.split(":").pop();
  try {
    await _fetchAuthed(`/me/tracks?ids=${id}`, { method: "PUT" });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function unsaveTrack(uri) {
  if (!uri || !uri.includes("track:")) return { ok: false, error: "Not a track uri" };
  const id = uri.split(":").pop();
  try {
    await _fetchAuthed(`/me/tracks?ids=${id}`, { method: "DELETE" });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function pause() {
  try { await _fetchAuthed("/me/player/pause", { method: "PUT" }); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
}
async function next() {
  try { await _fetchAuthed("/me/player/next", { method: "POST" }); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
}
async function previous() {
  try { await _fetchAuthed("/me/player/previous", { method: "POST" }); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message }; }
}

async function myPlaylists(limit = 50) {
  try {
    // Front-load Liked Songs as a synthetic playlist so the user can pick
    // it just like a regular one. /me/playlists does NOT include it.
    const synthetic = [];
    try {
      const liked = await _fetchAuthed("/me/tracks?limit=1");
      if (liked) {
        synthetic.push({
          uri: LIKED_SONGS_URI,
          name: "Liked Songs",
          owner: "You",
          image: null,
          tracks: liked.total || 0,
          synthetic: true,
        });
      }
    } catch { /* ignore — show real playlists anyway */ }

    const data = await _fetchAuthed(`/me/playlists?limit=${Math.min(50, +limit || 50)}`);
    const real = (data?.items || []).map((p) => ({
      uri: p.uri,
      name: p.name,
      owner: p.owner?.display_name,
      image: p.images?.[0]?.url || null,
      tracks: p.tracks?.total || 0,
      // /me/playlists already returns user's PRIVATE + collaborative
      // playlists too (that's what user-read-private + playlist-read-
      // private/collaborative scopes give us).
      private: p.public === false,
    }));
    return { ok: true, items: [...synthetic, ...real] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
async function searchPlaylists(q, limit = 20) {
  try {
    const data = await _fetchAuthed(
      `/search?type=playlist&q=${encodeURIComponent(q || "")}&limit=${Math.min(50, +limit || 20)}`,
    );
    return {
      ok: true,
      items: (data?.playlists?.items || []).map((p) => ({
        uri: p.uri,
        name: p.name,
        owner: p.owner?.display_name,
        image: p.images?.[0]?.url || null,
        tracks: p.tracks?.total || 0,
      })),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
function setFocusPlaylist({ uri, name } = {}) {
  if (!uri) {
    db.setSetting("spotify.focusPlaylistUri", null);
    db.setSetting("spotify.focusPlaylistName", null);
    return { ok: true, cleared: true };
  }
  db.setSetting("spotify.focusPlaylistUri", uri);
  db.setSetting("spotify.focusPlaylistName", name || null);
  return { ok: true };
}
function setAutoPlayFocus(on) {
  db.setSetting("spotify.autoPlayFocus", on ? "1" : "0");
  return { ok: true };
}
function setClientId(id) {
  if (!id) db.setSetting("spotify.clientId", null);
  else db.setSetting("spotify.clientId", String(id).trim());
  return { ok: true };
}
async function playFocusPlaylist() {
  const uri = db.getSetting("spotify.focusPlaylistUri");
  if (!uri) return { ok: false, error: "No focus playlist set" };
  return await play(uri);
}

module.exports = {
  connect, disconnect, status,
  nowPlaying, play, pause, next, previous,
  myPlaylists, searchPlaylists, devices,
  setShuffle, setRepeat, setVolume, seek, transferTo, addToQueue,
  recent, topTracks, likedSongs,
  isTrackSaved, saveTrack, unsaveTrack,
  setFocusPlaylist, setAutoPlayFocus, setClientId,
  playFocusPlaylist, refreshAccessToken,
  REDIRECT_URI, LIKED_SONGS_URI,
};
