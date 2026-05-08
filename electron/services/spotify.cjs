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

// Public client ID — works for personal use up to Spotify's quota. The user
// can override in Settings by pasting their own from a Spotify Dev app.
const DEFAULT_CLIENT_ID = "0a8b0c2c4f8d4a18b2c0f6c0fcd3e7a4";
const REDIRECT_URI = "http://127.0.0.1:7787/spotify/callback";
const SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-recently-played",
  "user-read-private",
  "user-read-email",
  "playlist-read-private",
  "playlist-read-collaborative",
];

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
async function connect({ BrowserWindow }) {
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
    const win = new BrowserWindow({
      width: 520,
      height: 700,
      title: "Sign in to Spotify",
      autoHideMenuBar: true,
      webPreferences: {
        partition: "persist:spotify",
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
    const onNav = async (_evt, url) => {
      if (!url.startsWith(REDIRECT_URI)) return;
      try {
        const u = new URL(url);
        const code = u.searchParams.get("code");
        const returnedState = u.searchParams.get("state");
        const error = u.searchParams.get("error");
        if (error) return finish({ ok: false, error });
        if (!code || returnedState !== state) {
          return finish({ ok: false, error: "Bad state or missing code" });
        }
        // Exchange code → tokens.
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
          return finish({ ok: false, error: `Token exchange ${tokRes.status}: ${body.slice(0, 200)}` });
        }
        const tok = await tokRes.json();
        _saveTokens(tok);
        // Best-effort fetch user profile to display in settings.
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
    win.webContents.on("will-redirect", onNav);
    win.webContents.on("did-navigate", onNav);
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

async function play(uri) {
  try {
    const body = uri
      ? uri.includes("track:")
        ? { uris: [uri] }
        : { context_uri: uri } // playlist / album / artist URI
      : null;
    await _fetchAuthed(`/me/player/play`, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    const data = await _fetchAuthed(`/me/playlists?limit=${Math.min(50, +limit || 50)}`);
    return {
      ok: true,
      items: (data?.items || []).map((p) => ({
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
  myPlaylists, searchPlaylists,
  setFocusPlaylist, setAutoPlayFocus, setClientId,
  playFocusPlaylist, refreshAccessToken,
  REDIRECT_URI,
};
