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
  "playlist-modify-public",   // create/reorder/wipe public playlists (manager)
  "playlist-modify-private",  // create/reorder/wipe private playlists (manager)
  "user-library-read",        // for Liked Songs (/me/tracks)
  "user-library-modify",      // for like / unlike the current track
  "user-top-read",            // for top tracks/artists
];
const PLAYLIST_WRITE_SCOPES = ["playlist-modify-public", "playlist-modify-private"];

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
function _saveTokens({ access_token, refresh_token, expires_in, scope }) {
  if (access_token) db.setSetting("spotify.accessToken", access_token);
  if (refresh_token) db.setSetting("spotify.refreshToken", refresh_token);
  if (typeof scope === "string" && scope.trim()) db.setSetting("spotify.scopes", scope.trim());
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
    "spotify.scopes",
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

function _grantedScopes() {
  return String(db.getSetting("spotify.scopes") || "")
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function _missingScopes(required = PLAYLIST_WRITE_SCOPES) {
  const granted = new Set(_grantedScopes());
  if (!granted.size) return [];
  return required.filter((scope) => !granted.has(scope));
}

function _hasKnownScopes(required = PLAYLIST_WRITE_SCOPES) {
  const granted = _grantedScopes();
  if (!granted.length) return null;
  return required.every((scope) => granted.includes(scope));
}

function _compactSpotifyBody(body) {
  const raw = String(body || "").trim();
  if (!raw) return "Request denied";
  try {
    const parsed = JSON.parse(raw);
    const err = parsed?.error;
    if (typeof err === "string") return err;
    if (err?.message) return err.message;
    if (err?.reason) return err.reason;
    if (err?.status) return `Request denied (${err.status})`;
  } catch {}
  return raw.replace(/\s+/g, " ").slice(0, 160);
}

function _isPlaylistWrite(path, init = {}) {
  const method = String(init.method || "GET").toUpperCase();
  if (!["POST", "PUT", "DELETE"].includes(method)) return false;
  const p = String(path || "");
  return /\/playlists\/[^/]+\/tracks/.test(p) || /\/users\/[^/]+\/playlists/.test(p);
}

async function _throwSpotifyApiError(res, path, init = {}) {
  let body = "";
  try { body = await res.text(); } catch {}
  const err = new Error(`Spotify ${res.status}: ${_compactSpotifyBody(body)}`);
  err.status = res.status;
  err.body = body;
  err.path = path;
  if (res.status === 403 && String(path || "").includes("/audio-features")) {
    err.code = "SPOTIFY_AUDIO_FEATURES_FORBIDDEN";
  } else if (res.status === 403 && _isPlaylistWrite(path, init)) {
    err.code = "SPOTIFY_PLAYLIST_WRITE_FORBIDDEN";
  } else if (res.status === 403) {
    err.code = "SPOTIFY_FORBIDDEN";
  }
  throw err;
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
    if (!retry.ok) await _throwSpotifyApiError(retry, path, init);
    return retry.json().catch(() => null);
  }
  if (!res.ok) {
    await _throwSpotifyApiError(res, path, init);
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
    scopes: _grantedScopes(),
    scopesKnown: _grantedScopes().length > 0,
    missingPlaylistWriteScopes: _missingScopes(),
    needsReconnectForPlaylistWrite: _hasKnownScopes() === false,
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


// =============================================================================
// Playlist Manager -- shared helpers
// =============================================================================

const path = require("node:path");
const fs   = require("node:fs");

function _backupDir() {
  const { app } = require("electron");
  const dir = path.join(app.getPath("userData"), "spotify-backups");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function fetchAllLikedSongs(onProgress) {
  const songs = [];
  let url = "/me/tracks?limit=50";
  while (url) {
    const data = await _fetchAuthed(url);
    if (!data) break;
    for (const item of data.items || []) {
      const t = item && item.track;
      if (!t || !t.id) continue;
      const rel = (t.album && t.album.release_date) || "";
      songs.push({
        id:         t.id,
        uri:        t.uri,
        name:       t.name,
        artist:     (t.artists || []).map(function(a){ return a.name; }).join(", "),
        album:      (t.album && t.album.name) || "",
        albumArt:   (t.album && t.album.images && (t.album.images[1] || t.album.images[0]) && (t.album.images[1] || t.album.images[0]).url) || null,
        year:       /^\d{4}/.test(rel) ? parseInt(rel) : 0,
        popularity: t.popularity || 0,
        durationMs: t.duration_ms || 0,
        addedAt:    item.added_at,
      });
    }
    if (onProgress) onProgress({
      message: "Fetching liked songs... " + songs.length + (data.total ? "/" + data.total : ""),
      current: songs.length,
      total:   data.total || songs.length,
    });
    url = data.next ? data.next.replace("https://api.spotify.com/v1", "") : null;
  }
  return songs;
}

async function fetchPlaylistTracksAll(playlistId, onProgress) {
  const tracks = [];
  let url = "/playlists/" + encodeURIComponent(playlistId) + "/tracks?limit=100";
  while (url) {
    const data = await _fetchAuthed(url);
    if (!data) break;
    for (const item of data.items || []) {
      const t = item && item.track;
      if (!t || !t.id) continue;
      const rel = (t.album && t.album.release_date) || "";
      tracks.push({
        id:         t.id,
        uri:        t.uri,
        name:       t.name,
        artist:     (t.artists || []).map(function(a){ return a.name; }).join(", "),
        album:      (t.album && t.album.name) || "",
        albumArt:   (t.album && t.album.images && (t.album.images[1] || t.album.images[0]) && (t.album.images[1] || t.album.images[0]).url) || null,
        year:       /^\d{4}/.test(rel) ? parseInt(rel) : 0,
        popularity: t.popularity || 0,
        durationMs: t.duration_ms || 0,
      });
    }
    if (onProgress) onProgress({ message: "Fetching tracks... " + tracks.length, current: tracks.length, total: data.total || tracks.length });
    url = data.next ? data.next.replace("https://api.spotify.com/v1", "") : null;
  }
  return tracks;
}

async function fetchAudioFeaturesAll(trackIds, onProgress) {
  const features = {};
  const total = Math.ceil(trackIds.length / 100);
  for (let i = 0, batch = 0; i < trackIds.length; i += 100, batch++) {
    const ids  = trackIds.slice(i, i + 100).join(",");
    const data = await _fetchAuthed("/audio-features?ids=" + ids);
    for (const f of (data && data.audio_features) || []) {
      if (f) features[f.id] = f;
    }
    if (onProgress) onProgress({ message: "Fetching audio features... " + Math.min(i + 100, trackIds.length) + "/" + trackIds.length, current: batch + 1, total });
  }
  return features;
}

async function _replacePlaylistAll(playlistId, trackUris) {
  await _fetchAuthed("/playlists/" + encodeURIComponent(playlistId) + "/tracks", {
    method: "PUT",
    body: JSON.stringify({ uris: [] }),
  });
  for (let i = 0; i < trackUris.length; i += 100) {
    await _fetchAuthed("/playlists/" + encodeURIComponent(playlistId) + "/tracks", {
      method: "POST",
      body: JSON.stringify({ uris: trackUris.slice(i, i + 100) }),
    });
  }
}

async function _fetchAllPlaylists(onProgress) {
  const all = [];
  let url = "/me/playlists?limit=50";
  while (url) {
    const data = await _fetchAuthed(url);
    if (!data) break;
    all.push.apply(all, data.items || []);
    if (onProgress) onProgress({ message: "Scanning playlists... " + all.length, current: all.length, total: data.total || all.length });
    url = data.next ? data.next.replace("https://api.spotify.com/v1", "") : null;
  }
  return all;
}

const _EXPORT_MARKER = "apex-liked-export-v1";

// -- exportSyncLiked ----------------------------------------------------------

async function exportSyncLiked(opts, onProgress) {
  const order = (opts && opts.order) || "1";
  try {
    if (onProgress) onProgress({ message: "Fetching your liked songs...", current: 0, total: 0 });
    const liked = await fetchAllLikedSongs(onProgress);

    const userId = db.getSetting("spotify.userId");
    const hash   = crypto.createHash("sha1").update(userId + ":" + _EXPORT_MARKER).digest("hex");
    const marker = "apex-export:" + hash;

    if (onProgress) onProgress({ message: "Looking up existing export playlist...", current: 1, total: 3 });
    let existingPl = null;
    const allPl = await _fetchAllPlaylists();
    for (const p of allPl) {
      if (p.description === marker) { existingPl = p; break; }
    }

    const urisNewest = liked.map(function(s){ return s.uri; });
    const urisOldest = urisNewest.slice().reverse();
    const target     = order === "2" ? urisOldest : urisNewest;

    let added = 0, removed = 0, playlistId, playlistName, created = false;

    if (existingPl) {
      playlistId   = existingPl.id;
      playlistName = existingPl.name;
      if (onProgress) onProgress({ message: "Fetching current playlist tracks...", current: 1, total: 3 });
      const existing    = await fetchPlaylistTracksAll(existingPl.id, onProgress);
      const existingSet = new Set(existing.map(function(t){ return t.uri; }));
      const likedSet    = new Set(urisNewest);
      const toAdd    = urisNewest.filter(function(u){ return !existingSet.has(u); });
      const toRemove = Array.from(existingSet).filter(function(u){ return !likedSet.has(u); });
      added   = toAdd.length;
      removed = toRemove.length;
      if (onProgress) onProgress({ message: "Applying changes...", current: 2, total: 3 });
      if (order === "3") {
        if (toRemove.length) {
          for (let i = 0; i < toRemove.length; i += 100) {
            await _fetchAuthed("/playlists/" + existingPl.id + "/tracks", {
              method: "DELETE",
              body: JSON.stringify({ tracks: toRemove.slice(i, i + 100).map(function(u){ return { uri: u }; }) }),
            });
          }
        }
        if (toAdd.length) {
          const ordered = urisNewest.filter(function(u){ return toAdd.indexOf(u) !== -1; });
          for (let i = 0; i < ordered.length; i += 100) {
            await _fetchAuthed("/playlists/" + existingPl.id + "/tracks", {
              method: "POST",
              body: JSON.stringify({ uris: ordered.slice(i, i + 100) }),
            });
          }
        }
      } else {
        await _replacePlaylistAll(existingPl.id, target);
      }
    } else {
      if (onProgress) onProgress({ message: "Creating new playlist...", current: 2, total: 3 });
      const pl = await _fetchAuthed("/users/" + encodeURIComponent(userId) + "/playlists", {
        method: "POST",
        body: JSON.stringify({ name: "Exported Liked Songs", public: true, description: marker }),
      });
      playlistId   = pl.id;
      playlistName = pl.name;
      created      = true;
      added        = target.length;
      await _replacePlaylistAll(pl.id, target);
    }
    if (onProgress) onProgress({ message: "Done!", current: 3, total: 3 });
    return { ok: true, playlistId: playlistId, playlistName: playlistName, created: created, added: added, removed: removed, total: liked.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -- sortPlaylist --------------------------------------------------------------

async function sortPlaylist(opts, onProgress) {
  const playlistId  = opts && opts.playlistId;
  const fields      = (opts && opts.fields)     || [];
  const directions  = (opts && opts.directions) || [];
  const audioFields = new Set(["bpm", "energy", "danceability", "valence"]);
  try {
    if (onProgress) onProgress({ message: "Fetching playlist tracks...", current: 0, total: 3 });
    const tracks = await fetchPlaylistTracksAll(playlistId, onProgress);
    if (!tracks.length) return { ok: false, error: "Playlist is empty" };

    if (fields.some(function(f){ return audioFields.has(f); })) {
      if (onProgress) onProgress({ message: "Fetching audio features...", current: 1, total: 3 });
      const af = await fetchAudioFeaturesAll(tracks.map(function(t){ return t.id; }), onProgress);
      tracks.forEach(function(t) {
        const f = af[t.id] || {};
        t.bpm          = f.tempo        || 0;
        t.energy       = f.energy       || 0;
        t.danceability = f.danceability || 0;
        t.valence      = f.valence      || 0;
      });
    }

    const sorted = tracks.slice().sort(function(a, b) {
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const dir   = directions[i] === "desc" ? -1 : 1;
        const va    = a[field] != null ? a[field] : 0;
        const vb    = b[field] != null ? b[field] : 0;
        if (typeof va === "string") {
          const cmp = va.localeCompare(vb);
          if (cmp !== 0) return cmp * dir;
        } else {
          if (va !== vb) return (va - vb) * dir;
        }
      }
      return 0;
    });

    if (onProgress) onProgress({ message: "Applying sorted order...", current: 2, total: 3 });
    await _replacePlaylistAll(playlistId, sorted.map(function(t){ return t.uri; }));
    if (onProgress) onProgress({ message: "Done!", current: 3, total: 3 });
    return { ok: true, total: sorted.length, preview: sorted.slice(0, 20).map(function(t){ return { name: t.name, artist: t.artist }; }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -- audioDashboard -----------------------------------------------------------

async function audioDashboard(opts, onProgress) {
  const playlistId = opts && opts.playlistId;
  try {
    if (onProgress) onProgress({ message: "Fetching playlist tracks...", current: 0, total: 2 });
    const tracks = await fetchPlaylistTracksAll(playlistId, onProgress);
    if (!tracks.length) return { ok: false, error: "Playlist is empty" };
    if (onProgress) onProgress({ message: "Fetching audio features...", current: 1, total: 2 });
    const af    = await fetchAudioFeaturesAll(tracks.map(function(t){ return t.id; }), onProgress);
    const feats = Object.values(af);
    if (!feats.length) return { ok: false, error: "No audio features returned" };

    function avg(key) { return feats.reduce(function(s,f){ return s + (f[key] || 0); }, 0) / feats.length; }

    const avgBpm     = avg("tempo");
    const avgEnergy  = avg("energy");
    const avgDance   = avg("danceability");
    const avgValence = avg("valence");

    let mood;
    if      (avgValence > 0.6 && avgEnergy > 0.6)  mood = "Upbeat & Happy";
    else if (avgValence > 0.6 && avgEnergy <= 0.6) mood = "Chill & Positive";
    else if (avgValence <= 0.4 && avgEnergy > 0.6)  mood = "Intense & Dark";
    else if (avgValence <= 0.4 && avgEnergy <= 0.4) mood = "Melancholic";
    else                                            mood = "Mixed / Neutral";

    const eBuckets   = { low: 0, mid: 0, high: 0 };
    const bpmBuckets = { lt80: 0, b80: 0, b100: 0, b120: 0, gt140: 0 };
    feats.forEach(function(f) {
      const e = f.energy || 0;
      if      (e < 0.33) eBuckets.low++;
      else if (e < 0.66) eBuckets.mid++;
      else               eBuckets.high++;
      const b = f.tempo || 0;
      if      (b < 80)  bpmBuckets.lt80++;
      else if (b < 100) bpmBuckets.b80++;
      else if (b < 120) bpmBuckets.b100++;
      else if (b < 140) bpmBuckets.b120++;
      else              bpmBuckets.gt140++;
    });

    const idToName = {};
    tracks.forEach(function(t){ idToName[t.id] = { name: t.name, artist: t.artist }; });
    const top5Energy = feats.slice().sort(function(a,b){ return (b.energy||0)-(a.energy||0); }).slice(0,5).map(function(f){
      const info = idToName[f.id] || {};
      return { id: f.id, name: info.name || f.id, artist: info.artist || "", energy: f.energy, bpm: f.tempo };
    });

    if (onProgress) onProgress({ message: "Done!", current: 2, total: 2 });
    return {
      ok: true, trackCount: feats.length, mood: mood,
      avgBpm: avgBpm, avgEnergy: avgEnergy, avgDance: avgDance, avgValence: avgValence,
      avgAcousticness:     avg("acousticness"),
      avgInstrumentalness: avg("instrumentalness"),
      avgSpeechiness:      avg("speechiness"),
      avgLiveness:         avg("liveness"),
      eBuckets: eBuckets, bpmBuckets: bpmBuckets, top5Energy: top5Energy,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -- detectPlaylistDuplicates -------------------------------------------------

async function detectPlaylistDuplicates(opts, onProgress) {
  const playlistId = opts && opts.playlistId;
  try {
    if (onProgress) onProgress({ message: "Fetching playlist tracks...", current: 0, total: 1 });
    const tracks = await fetchPlaylistTracksAll(playlistId, onProgress);
    const seenIds = {}, seenNames = {}, exact = [], fuzzy = [];
    tracks.forEach(function(t, i) {
      const nkey = t.name.toLowerCase().trim() + "|" + t.artist.toLowerCase().trim();
      if (seenIds[t.id] !== undefined) {
        exact.push({ track: t, firstIdx: seenIds[t.id] + 1, dupeIdx: i + 1 });
      } else {
        seenIds[t.id] = i;
      }
      if (seenNames[nkey] && seenNames[nkey] !== t.id) {
        fuzzy.push({ track: t, dupeIdx: i + 1, note: "same title & artist - possibly a different version" });
      } else if (!seenNames[nkey]) {
        seenNames[nkey] = t.id;
      }
    });
    if (onProgress) onProgress({ message: "Done!", current: 1, total: 1 });
    return { ok: true, totalTracks: tracks.length, exact: exact, fuzzy: fuzzy };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function removeExactDuplicates(opts, onProgress) {
  const playlistId = opts && opts.playlistId;
  try {
    if (onProgress) onProgress({ message: "Fetching playlist tracks...", current: 0, total: 2 });
    const tracks = await fetchPlaylistTracksAll(playlistId, onProgress);
    const seen = new Set(), deduped = [];
    tracks.forEach(function(t) {
      if (!seen.has(t.id)) { deduped.push(t.uri); seen.add(t.id); }
    });
    if (onProgress) onProgress({ message: "Rewriting playlist...", current: 1, total: 2 });
    await _replacePlaylistAll(playlistId, deduped);
    if (onProgress) onProgress({ message: "Done!", current: 2, total: 2 });
    return { ok: true, removed: tracks.length - deduped.length, remaining: deduped.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -- applyMoodArc -------------------------------------------------------------

async function applyMoodArc(opts, onProgress) {
  const playlistId = opts && opts.playlistId;
  const arcType    = (opts && opts.arcType) || "1";
  try {
    if (onProgress) onProgress({ message: "Fetching playlist tracks...", current: 0, total: 3 });
    const tracks = await fetchPlaylistTracksAll(playlistId, onProgress);
    if (!tracks.length) return { ok: false, error: "Playlist is empty" };
    if (onProgress) onProgress({ message: "Fetching audio features...", current: 1, total: 3 });
    const af = await fetchAudioFeaturesAll(tracks.map(function(t){ return t.id; }), onProgress);
    tracks.forEach(function(t) {
      const f = af[t.id] || {};
      t.energy  = f.energy  != null ? f.energy  : 0.5;
      t.valence = f.valence != null ? f.valence : 0.5;
    });
    const asc  = tracks.slice().sort(function(a,b){ return (a.energy+a.valence)-(b.energy+b.valence); });
    const desc = asc.slice().reverse();
    let sorted;
    if (arcType === "1") {
      sorted = asc;
    } else if (arcType === "2") {
      sorted = desc;
    } else if (arcType === "3") {
      const mid = Math.floor(tracks.length / 2);
      sorted = desc.slice(0, mid).reverse().concat(asc.slice(0, tracks.length - mid));
    } else {
      const mid = Math.floor(tracks.length / 2);
      sorted = asc.slice(0, mid + tracks.length % 2).concat(desc.slice(0, tracks.length - mid - tracks.length % 2));
    }
    if (onProgress) onProgress({ message: "Rewriting playlist...", current: 2, total: 3 });
    await _replacePlaylistAll(playlistId, sorted.map(function(t){ return t.uri; }));
    if (onProgress) onProgress({ message: "Done!", current: 3, total: 3 });
    const preview = sorted.slice(0, 8).map(function(t){ return { name: t.name, artist: t.artist, energy: t.energy, valence: t.valence }; });
    return { ok: true, total: sorted.length, preview: preview };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -- Backup & Restore ---------------------------------------------------------

async function backupPlaylist(opts, onProgress) {
  const playlistId   = opts && opts.playlistId;
  const playlistName = opts && opts.playlistName;
  try {
    if (onProgress) onProgress({ message: "Fetching playlist tracks...", current: 0, total: 1 });
    const tracks = await fetchPlaylistTracksAll(playlistId, onProgress);
    const safe = (playlistName || playlistId).replace(/[^a-zA-Z0-9\s_-]/g, "_").slice(0, 50).trim();
    const ts       = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = safe + "_" + ts + ".json";
    const filepath = path.join(_backupDir(), filename);
    const data = { playlistId: playlistId, playlistName: playlistName || playlistId, backedUpAt: new Date().toISOString(), trackCount: tracks.length, tracks: tracks };
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), "utf-8");
    if (onProgress) onProgress({ message: "Backup saved!", current: 1, total: 1 });
    return { ok: true, filename: filename, trackCount: tracks.length, filepath: filepath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function listBackups() {
  try {
    const dir  = _backupDir();
    const files = fs.readdirSync(dir).filter(function(f){ return f.endsWith(".json"); }).sort().reverse();
    const backups = files.map(function(filename) {
      try {
        const filepath = path.join(dir, filename);
        const data     = JSON.parse(fs.readFileSync(filepath, "utf-8"));
        return { filename: filename, playlistName: data.playlistName || filename, playlistId: data.playlistId || null, trackCount: data.trackCount || (data.tracks && data.tracks.length) || 0, backedUpAt: data.backedUpAt || null, sizeKb: Math.round(fs.statSync(filepath).size / 1024) };
      } catch(e) { return { filename: filename, playlistName: filename, trackCount: 0, backedUpAt: null, sizeKb: 0 }; }
    });
    return { ok: true, backups: backups };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function restorePlaylist(opts, onProgress) {
  const filename  = opts && opts.filename;
  const mode      = (opts && opts.mode) || "new";
  const targetId  = opts && opts.targetId;
  try {
    const filepath = path.join(_backupDir(), filename);
    if (!fs.existsSync(filepath)) return { ok: false, error: "Backup file not found" };
    const data  = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    const uris  = (data.tracks || []).map(function(t){ return t.uri; }).filter(Boolean);
    if (mode === "overwrite" && targetId) {
      if (onProgress) onProgress({ message: "Restoring to original playlist...", current: 0, total: 1 });
      await _replacePlaylistAll(targetId, uris);
      if (onProgress) onProgress({ message: "Done!", current: 1, total: 1 });
      return { ok: true, mode: mode, playlistName: data.playlistName, restored: uris.length };
    } else {
      const userId = db.getSetting("spotify.userId");
      if (onProgress) onProgress({ message: "Creating new playlist...", current: 0, total: 2 });
      const pl = await _fetchAuthed("/users/" + encodeURIComponent(userId) + "/playlists", {
        method: "POST",
        body: JSON.stringify({ name: (data.playlistName || "Restored") + " (Restored)", public: true, description: "Restored from backup - originally " + ((data.backedUpAt || "").slice(0, 10) || "unknown") }),
      });
      if (onProgress) onProgress({ message: "Adding " + uris.length + " tracks...", current: 1, total: 2 });
      await _replacePlaylistAll(pl.id, uris);
      if (onProgress) onProgress({ message: "Done!", current: 2, total: 2 });
      return { ok: true, mode: mode, playlistName: pl.name, playlistId: pl.id, restored: uris.length };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -- smartFilter --------------------------------------------------------------

const FOCUS_PLAYLIST_PROFILES = {
  deep: {
    label: "Deep Work",
    energy: 0.55,
    valence: 0.52,
    minEnergy: 0.28,
    maxEnergy: 0.82,
    minValence: 0.24,
    maxValence: 0.88,
    maxSpeechiness: 0.28,
    maxDanceability: 0.88,
  },
  flow: {
    label: "Flow",
    energy: 0.68,
    valence: 0.62,
    minEnergy: 0.42,
    maxEnergy: 0.92,
    minValence: 0.28,
    maxValence: 0.95,
    maxSpeechiness: 0.34,
    maxDanceability: 0.94,
  },
  calm: {
    label: "Calm Study",
    energy: 0.38,
    valence: 0.48,
    minEnergy: 0.12,
    maxEnergy: 0.62,
    minValence: 0.18,
    maxValence: 0.84,
    maxSpeechiness: 0.24,
    maxDanceability: 0.78,
  },
};

function _focusScore(track, profile) {
  const energy = track.energy || 0;
  const valence = track.valence || 0;
  const dance = track.danceability || 0;
  const speech = track.speechiness || 0;
  const popularity = (track.popularity || 0) / 100;
  const energyFit = 1 - Math.min(1, Math.abs(energy - profile.energy) / 0.7);
  const valenceFit = 1 - Math.min(1, Math.abs(valence - profile.valence) / 0.7);
  const speechFit = 1 - Math.min(1, speech / Math.max(0.1, profile.maxSpeechiness));
  const danceFit = dance > profile.maxDanceability
    ? Math.max(0, 1 - (dance - profile.maxDanceability) * 4)
    : 0.85;
  return (
    energyFit * 0.34 +
    valenceFit * 0.24 +
    speechFit * 0.18 +
    danceFit * 0.10 +
    popularity * 0.14
  );
}

function _metadataFocusScore(track, profileKey) {
  const popularity = (track.popularity || 0) / 100;
  const duration = Math.max(0, track.durationMs || 0);
  const minutes = duration / 60000;
  const durationFit = minutes >= 2 && minutes <= 9
    ? 1
    : minutes > 0
      ? Math.max(0.35, 1 - Math.min(1, Math.abs(minutes - 4.5) / 8))
      : 0.6;
  const year = track.year || 0;
  const recency = year > 0 ? Math.max(0, Math.min(1, (year - 1980) / 50)) : 0.5;
  const calmBias = profileKey === "calm" ? 0.08 : 0;
  const flowBias = profileKey === "flow" ? 0.05 : 0;
  return popularity * 0.62 + durationFit * 0.24 + recency * 0.14 + calmBias + flowBias;
}

async function _ensureUserId() {
  const existing = db.getSetting("spotify.userId");
  if (existing) return existing;
  const me = await _fetchAuthed("/me");
  if (me?.id) {
    db.setSetting("spotify.userId", me.id);
    db.setSetting("spotify.userDisplayName", me.display_name || me.id);
    return me.id;
  }
  const err = new Error("Spotify profile is unavailable. Reconnect Spotify and try again.");
  err.code = "SPOTIFY_PROFILE_MISSING";
  throw err;
}

function _spotifyReconnectForPlaylistWrite(err) {
  return {
    ok: false,
    code: "SPOTIFY_RECONNECT_SCOPES",
    reconnect: true,
    missingScopes: _missingScopes(),
    error:
      "Spotify needs playlist write permission. Reconnect Spotify once, then start Zen again.",
    detail: err?.message || null,
  };
}

async function createFocusPlaylist(opts, onProgress) {
  opts = opts || {};
  const profileKey = FOCUS_PLAYLIST_PROFILES[opts.profile] ? opts.profile : "deep";
  const profile = FOCUS_PLAYLIST_PROFILES[profileKey];
  const sourceType = opts.sourceType || "all";
  const sourceId = opts.sourceId || null;
  const maxTracks = Math.max(20, Math.min(120, +opts.maxTracks || 64));
  const scanLimit = Math.max(100, Math.min(2000, +opts.scanLimit || 900));
  const playlistName = (opts.name || ("Apex Focus - " + profile.label)).trim();

  try {
    if (_hasKnownScopes() === false) {
      return _spotifyReconnectForPlaylistWrite();
    }

    let tracks = [];
    let sourcePlaylists = [];

    if (sourceType === "playlist" && sourceId) {
      if (onProgress) onProgress({ message: "Fetching source playlist...", current: 0, total: 4 });
      tracks = await fetchPlaylistTracksAll(sourceId, onProgress);
    } else if (sourceType === "liked") {
      if (onProgress) onProgress({ message: "Fetching liked songs...", current: 0, total: 4 });
      tracks = await fetchAllLikedSongs(onProgress);
    } else {
      if (onProgress) onProgress({ message: "Fetching your playlists...", current: 0, total: 4 });
      sourcePlaylists = await _fetchAllPlaylists();
      let scanned = 0;
      for (let i = 0; i < sourcePlaylists.length && scanned < scanLimit; i += 1) {
        const pl = sourcePlaylists[i];
        if (!pl || !pl.id) continue;
        if ((pl.name || "").toLowerCase() === playlistName.toLowerCase()) continue;
        if (onProgress) {
          onProgress({
            message: "Scanning " + (pl.name || "playlist") + "...",
            current: i + 1,
            total: sourcePlaylists.length,
          });
        }
        const list = await fetchPlaylistTracksAll(pl.id);
        tracks.push.apply(tracks, list);
        scanned += list.length;
      }
    }

    const unique = [];
    const seen = new Set();
    for (const t of tracks) {
      if (!t || !t.id || !t.uri || seen.has(t.id)) continue;
      seen.add(t.id);
      unique.push(t);
      if (unique.length >= scanLimit) break;
    }
    if (!unique.length) {
      return { ok: true, matched: 0, playlistId: null, playlistName: null, preview: [] };
    }

    if (onProgress) onProgress({ message: "Scoring focus tracks...", current: 2, total: 4 });
    let audioFeaturesLimited = false;
    let af = {};
    try {
      af = await fetchAudioFeaturesAll(unique.map(function(t){ return t.id; }), onProgress);
    } catch (err) {
      if (err?.code !== "SPOTIFY_AUDIO_FEATURES_FORBIDDEN") throw err;
      audioFeaturesLimited = true;
      if (onProgress) {
        onProgress({
          message: "Scoring focus tracks from your library...",
          current: 2,
          total: 4,
        });
      }
    }
    unique.forEach(function(t) {
      const f = af[t.id] || {};
      t.hasAudioFeatures = !!af[t.id];
      t.bpm = f.tempo || 0;
      t.energy = f.energy || profile.energy;
      t.danceability = f.danceability || Math.min(profile.maxDanceability, 0.72);
      t.valence = f.valence || profile.valence;
      t.speechiness = f.speechiness || 0.12;
      t.acousticness = f.acousticness || 0;
      t.focusScore = t.hasAudioFeatures
        ? _focusScore(t, profile)
        : _metadataFocusScore(t, profileKey);
    });

    const matched = unique
      .filter(function(t) {
        if (audioFeaturesLimited || !t.hasAudioFeatures) return true;
        return (
          t.energy >= profile.minEnergy &&
          t.energy <= profile.maxEnergy &&
          t.valence >= profile.minValence &&
          t.valence <= profile.maxValence &&
          t.speechiness <= profile.maxSpeechiness &&
          t.danceability <= profile.maxDanceability
        );
      })
      .sort(function(a, b) {
        return b.focusScore - a.focusScore || (b.popularity || 0) - (a.popularity || 0);
      })
      .slice(0, maxTracks);

    if (!matched.length) {
      return { ok: true, matched: 0, playlistId: null, playlistName: null, preview: [] };
    }

    if (onProgress) onProgress({ message: "Writing focus playlist...", current: 3, total: 4 });
    const userId = await _ensureUserId();
    let existing = null;
    const allPlaylists = sourcePlaylists.length ? sourcePlaylists : await _fetchAllPlaylists();
    existing = allPlaylists.find(function(pl) {
      return (
        (pl.name || "").toLowerCase() === playlistName.toLowerCase() &&
        (!pl.owner || !pl.owner.id || pl.owner.id === userId)
      );
    });

    let playlistId;
    let playlistUri;
    let created = false;
    if (existing && opts.updateExisting !== false) {
      playlistId = existing.id;
      playlistUri = existing.uri || ("spotify:playlist:" + existing.id);
    } else {
      const pl = await _fetchAuthed("/users/" + encodeURIComponent(userId) + "/playlists", {
        method: "POST",
        body: JSON.stringify({
          name: playlistName,
          public: false,
          description: "Focus playlist created by Apex for Zen mode.",
        }),
      });
      playlistId = pl.id;
      playlistUri = pl.uri || ("spotify:playlist:" + pl.id);
      created = true;
    }

    await _replacePlaylistAll(playlistId, matched.map(function(t){ return t.uri; }));
    db.setSetting("spotify.focusPlaylistUri", playlistUri);
    db.setSetting("spotify.focusPlaylistName", playlistName);
    // NB: deliberately NOT flipping spotify.autoPlayFocus here. Zen plays its
    // own playlist for the session; whether plain timers auto-play music is
    // the user's call via Settings → Integrations → Spotify.

    if (onProgress) onProgress({ message: "Done!", current: 4, total: 4 });
    return {
      ok: true,
      created,
      matched: matched.length,
      playlistId,
      playlistUri,
      playlistName,
      profile: profileKey,
      featuresLimited: audioFeaturesLimited,
      preview: matched.slice(0, 8).map(function(t) {
        return {
          name: t.name,
          artist: t.artist,
          bpm: Math.round(t.bpm || 0),
          energy: Number((t.energy || 0).toFixed(2)),
        };
      }),
    };
  } catch (err) {
    if (err?.code === "SPOTIFY_PLAYLIST_WRITE_FORBIDDEN") {
      return _spotifyReconnectForPlaylistWrite(err);
    }
    return { ok: false, error: err.message, code: err.code || null };
  }
}

async function smartFilter(opts, onProgress) {
  const sourceType = (opts && opts.sourceType) || "liked";
  const sourceId   = opts && opts.sourceId;
  const filters    = (opts && opts.filters) || {};
  const name       = opts && opts.name;
  try {
    let tracks;
    if (sourceType === "liked") {
      if (onProgress) onProgress({ message: "Fetching liked songs...", current: 0, total: 3 });
      const liked = await fetchAllLikedSongs(onProgress);
      tracks = liked;
      const ids = liked.map(function(s){ return s.id; });
      for (let i = 0; i < ids.length; i += 50) {
        const batch = await _fetchAuthed("/tracks?ids=" + ids.slice(i, i + 50).join(","));
        ((batch && batch.tracks) || []).forEach(function(ft, j) {
          if (!ft) return;
          const rel = (ft.album && ft.album.release_date) || "";
          tracks[i + j].year       = /^\d{4}/.test(rel) ? parseInt(rel) : 0;
          tracks[i + j].popularity = ft.popularity || 0;
          tracks[i + j].durationMs = ft.duration_ms || 0;
        });
      }
    } else {
      if (onProgress) onProgress({ message: "Fetching playlist tracks...", current: 0, total: 3 });
      tracks = await fetchPlaylistTracksAll(sourceId, onProgress);
    }
    if (onProgress) onProgress({ message: "Fetching audio features...", current: 1, total: 3 });
    const af = await fetchAudioFeaturesAll(tracks.map(function(t){ return t.id; }), onProgress);
    tracks.forEach(function(t) {
      const f = af[t.id] || {};
      t.bpm          = f.tempo        || 0;
      t.energy       = f.energy       || 0;
      t.danceability = f.danceability || 0;
      t.valence      = f.valence      || 0;
      t.acousticness = f.acousticness || 0;
    });
    const matched = tracks.filter(function(t) {
      if (filters.yearFrom      != null && t.year         < filters.yearFrom)      return false;
      if (filters.yearTo        != null && t.year         > filters.yearTo)        return false;
      if (filters.bpmFrom       != null && t.bpm          < filters.bpmFrom)       return false;
      if (filters.bpmTo         != null && t.bpm          > filters.bpmTo)         return false;
      if (filters.energyMin     != null && t.energy       < filters.energyMin)     return false;
      if (filters.energyMax     != null && t.energy       > filters.energyMax)     return false;
      if (filters.valenceMin    != null && t.valence      < filters.valenceMin)    return false;
      if (filters.valenceMax    != null && t.valence      > filters.valenceMax)    return false;
      if (filters.danceMin      != null && t.danceability < filters.danceMin)      return false;
      if (filters.popularityMin != null && t.popularity   < filters.popularityMin) return false;
      if (filters.artist        && t.artist.toLowerCase().indexOf(filters.artist.toLowerCase()) === -1) return false;
      return true;
    });
    if (!matched.length) return { ok: true, matched: 0, playlistId: null, playlistName: null };
    if (onProgress) onProgress({ message: "Creating playlist with " + matched.length + " tracks...", current: 2, total: 3 });
    const userId = db.getSetting("spotify.userId");
    const plName = name || ("Filtered - " + new Date().toLocaleDateString());
    const pl = await _fetchAuthed("/users/" + encodeURIComponent(userId) + "/playlists", {
      method: "POST",
      body: JSON.stringify({ name: plName, public: true, description: "Smart Filter playlist - created by Apex" }),
    });
    await _replacePlaylistAll(pl.id, matched.map(function(t){ return t.uri; }));
    if (onProgress) onProgress({ message: "Done!", current: 3, total: 3 });
    return { ok: true, matched: matched.length, playlistId: pl.id, playlistName: pl.name,
      preview: matched.slice(0, 10).map(function(t){ return { name: t.name, artist: t.artist, year: t.year, bpm: Math.round(t.bpm) }; }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -- crossPlaylistDupes -------------------------------------------------------

async function crossPlaylistDupes(onProgress) {
  try {
    if (onProgress) onProgress({ message: "Fetching your playlists...", current: 0, total: 0 });
    const allPl = await _fetchAllPlaylists(onProgress);
    const trackMap = {};
    let done = 0;
    for (const pl of allPl) {
      done++;
      if (onProgress) onProgress({ message: "Scanning \"" + pl.name + "\"...", current: done, total: allPl.length });
      const tracks = await fetchPlaylistTracksAll(pl.id);
      tracks.forEach(function(t) {
        if (!trackMap[t.id]) trackMap[t.id] = { name: t.name, artist: t.artist, playlists: [] };
        if (trackMap[t.id].playlists.indexOf(pl.name) === -1) trackMap[t.id].playlists.push(pl.name);
      });
    }
    const dupes = Object.entries(trackMap)
      .filter(function(e){ return e[1].playlists.length >= 2; })
      .sort(function(a,b){ return b[1].playlists.length - a[1].playlists.length; })
      .map(function(e){ return Object.assign({ id: e[0] }, e[1]); });
    if (onProgress) onProgress({ message: "Done!", current: allPl.length, total: allPl.length });
    return { ok: true, scanned: allPl.length, dupes: dupes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -- mergePlaylists -----------------------------------------------------------

async function mergePlaylists(opts, onProgress) {
  const ids       = (opts && opts.ids)       || [];
  const dedup     = opts && opts.dedup !== false;
  const interleave = !!(opts && opts.interleave);
  const name      = opts && opts.name;
  try {
    const allTracks = [];
    for (let i = 0; i < ids.length; i++) {
      if (onProgress) onProgress({ message: "Fetching playlist " + (i + 1) + "/" + ids.length + "...", current: i, total: ids.length + 1 });
      const tracks = await fetchPlaylistTracksAll(ids[i], onProgress);
      allTracks.push(tracks);
    }
    let merged;
    if (interleave) {
      merged = [];
      const maxLen = Math.max.apply(null, allTracks.map(function(t){ return t.length; }));
      for (let i = 0; i < maxLen; i++) {
        allTracks.forEach(function(pl){ if (i < pl.length) merged.push(pl[i]); });
      }
    } else {
      merged = [];
      allTracks.forEach(function(pl){ pl.forEach(function(t){ merged.push(t); }); });
    }
    if (dedup) {
      const seen = new Set();
      merged = merged.filter(function(t){ if (seen.has(t.id)) return false; seen.add(t.id); return true; });
    }
    if (onProgress) onProgress({ message: "Creating merged playlist (" + merged.length + " tracks)...", current: ids.length, total: ids.length + 1 });
    const userId = db.getSetting("spotify.userId");
    const pl = await _fetchAuthed("/users/" + encodeURIComponent(userId) + "/playlists", {
      method: "POST",
      body: JSON.stringify({ name: name || "Merged Playlist", public: true, description: "Merged by Apex Spotify Manager" }),
    });
    await _replacePlaylistAll(pl.id, merged.map(function(t){ return t.uri; }));
    if (onProgress) onProgress({ message: "Done!", current: ids.length + 1, total: ids.length + 1 });
    return { ok: true, total: merged.length, playlistId: pl.id, playlistName: pl.name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -- timeMachine --------------------------------------------------------------

async function timeMachine(opts, onProgress) {
  const start = opts && opts.start;
  const end   = opts && opts.end;
  const order = (opts && opts.order) || "1";
  const name  = opts && opts.name;
  try {
    if (onProgress) onProgress({ message: "Fetching your liked songs...", current: 0, total: 2 });
    const liked = await fetchAllLikedSongs(onProgress);
    const startMs = new Date(start).getTime();
    const endMs   = new Date(end).getTime() + 86400000;
    const matched = liked.filter(function(s) {
      const t = new Date(s.addedAt).getTime();
      return t >= startMs && t <= endMs;
    });
    if (!matched.length) return { ok: true, matched: 0, playlistId: null, playlistName: null };
    const sorted = order === "1" ? matched.slice().reverse() : matched;
    if (onProgress) onProgress({ message: "Creating playlist with " + sorted.length + " tracks...", current: 1, total: 2 });
    const userId  = db.getSetting("spotify.userId");
    const s       = (start || "").slice(0, 10);
    const e       = (end   || "").slice(0, 10);
    const plName  = name || ("Time Machine: " + s + " to " + e);
    const pl = await _fetchAuthed("/users/" + encodeURIComponent(userId) + "/playlists", {
      method: "POST",
      body: JSON.stringify({ name: plName, public: true, description: "Liked songs from " + s + " to " + e + ". Created by Apex." }),
    });
    await _replacePlaylistAll(pl.id, sorted.map(function(t){ return t.uri; }));
    if (onProgress) onProgress({ message: "Done!", current: 2, total: 2 });
    return { ok: true, matched: sorted.length, playlistId: pl.id, playlistName: pl.name,
      preview: sorted.slice(0, 8).map(function(t){ return { name: t.name, artist: t.artist, addedAt: (t.addedAt || "").slice(0, 10) }; }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// -----------------------------------------------------------------------------

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
  // Playlist Manager
  fetchAllLikedSongs, fetchPlaylistTracksAll, fetchAudioFeaturesAll,
  exportSyncLiked, sortPlaylist, audioDashboard,
  detectPlaylistDuplicates, removeExactDuplicates, applyMoodArc,
  backupPlaylist, listBackups, restorePlaylist,
  createFocusPlaylist,
  smartFilter, crossPlaylistDupes, mergePlaylists, timeMachine,
};
