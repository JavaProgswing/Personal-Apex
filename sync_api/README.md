# Apex Sync API

FastAPI service for pairing the Apex desktop app with the Android app and the web app, syncing daily routines, wake/sleep timers, objectives, tasks, notes, focus state, close reasons, distraction events, and mobile wellbeing usage.

## Web app

`GET /web` serves `web_app.html` — a single self-contained browser version of Apex (Three.js background, GSAP motion, tasks/notes/activity/focus views). It pairs as its own device (`device_type: "web"`); the desktop's **Settings → Mobile → Open web app** button mints a one-shot code and opens `/web#pair=CODE` so the browser signs itself in. The token lives in `localStorage`. The page is served with `Cache-Control: no-store`, so redeploys are instant.

## Endpoints

- `GET /health`
- `GET /web` — the browser app (no auth; the page itself pairs)
- `GET /me` — device info for the calling token
- `GET /devices` / `DELETE /devices/{id}` — list / revoke pairings (admin or any device token)
- `GET /focus` / `PUT /focus` — live focus-block state; desktop publishes (Zen + productive timers), the phone polls it to run its distraction blocker; auto-expires past `ends_at`
- `POST /pairing-codes` with `Authorization: Bearer <APEX_SYNC_ADMIN_TOKEN>` (rate-limited)
- `GET /pairing-codes/{code}/qr.png`
- `POST /pair` (rate-limited)
- `GET /bootstrap`
- `GET /sync/pull?since=...`
- `POST /sync/push`
- `GET /routine/today`
- `PUT /routine/today`
- `GET /objectives`
- `POST /objectives`
- `PATCH /objectives/{objective_id}`
- `GET /tasks`
- `POST /tasks`
- `DELETE /tasks/{task_id}`
- `GET /notes`
- `POST /notes`
- `DELETE /notes/{note_id}`
- `POST /events`
- `POST /wellbeing`
- `POST /close-reasons`
- `GET /reminders/due`

All non-pairing endpoints except `/health`, `/pair`, and the QR image require `Authorization: Bearer <device token>`.

## Mobile wellbeing sync

The phone (`POST /wellbeing`) reports each day's *running* foreground total per
app, not deltas. The server therefore **upserts idempotently** per
`(device, date, package_name)` - a re-sync replaces the prior row rather than
accumulating. Rows carry an `updated_at` so `GET /sync/pull?since=<iso>` can
fetch only what changed. `/sync/pull` returns wellbeing across **all** devices
(not scoped to the caller): the desktop is a different device pulling the
phone's data into its `activity_sessions(source='mobile')` table.

## Environment

```bash
APEX_SYNC_ADMIN_TOKEN=change-this-long-random-token
APEX_SYNC_PUBLIC_BASE=https://apex.yashasviallen.is-a.dev
APEX_SYNC_DB=/data/apex_sync.sqlite
APEX_SYNC_PORT=8787
APEX_SYNC_PAIRING_TTL_MINUTES=15
APEX_SYNC_CORS_ORIGINS=
# User's wall-clock timezone — the server runs UTC, but reminder windows
# ("wake at 07:00") are local times. Defaults to Asia/Kolkata.
APEX_SYNC_TZ=Asia/Kolkata
```

## Local Run

```bash
cd sync_api
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
set APEX_SYNC_ADMIN_TOKEN=change-this
set APEX_SYNC_PUBLIC_BASE=http://localhost:8787
uvicorn apex_sync_api:app --host 0.0.0.0 --port 8787
```

Create a pairing code:

```bash
curl -X POST http://localhost:8787/pairing-codes -H "Authorization: Bearer change-this"
```

The response includes a six digit code, a JSON QR payload, and a QR PNG URL. The mobile app scans the QR payload or submits the code to `POST /pair`.

## Production deploy (current setup)

The live instance runs on an Oracle Cloud Ubuntu box as a Docker Compose
project at `/opt/apex` (`apex-sync-api` service built from this folder, behind
`jc21/nginx-proxy-manager` for TLS; sqlite persisted via `./apex-data:/data`).
Redeploy after editing `apex_sync_api.py` or `web_app.html`:

```bash
scp -i <key> apex_sync_api.py web_app.html ubuntu@<host>:/tmp/
ssh -i <key> ubuntu@<host> 'cd /opt/apex \
  && cp sync_api/apex_sync_api.py sync_api/apex_sync_api.py.bak-$(date +%F-%H%M%S) \
  && mv /tmp/apex_sync_api.py /tmp/web_app.html sync_api/ \
  && docker compose up -d --build apex-sync-api'
curl https://apex.yashasviallen.is-a.dev/health
```

Gotcha: `init_db()` runs an `executescript` on every boot — any index on a
migrated-in column must be created *after* its guarded `ALTER TABLE`, or
existing databases crash on startup.

## Pterodactyl Docker

1. Create a new Python or custom Docker server.
2. Mount a persistent volume to `/data`.
3. Set the startup command to:

```bash
uvicorn apex_sync_api:app --host 0.0.0.0 --port ${SERVER_PORT:-8787}
```

4. Set variables:

```bash
APEX_SYNC_ADMIN_TOKEN=<long random value>
APEX_SYNC_PUBLIC_BASE=https://apex.yashasviallen.is-a.dev
APEX_SYNC_DB=/data/apex_sync.sqlite
```

5. Upload this folder or build from the included `Dockerfile`.
6. Allocate the local port you want Pterodactyl to expose. The app respects `SERVER_PORT`, which Pterodactyl usually injects.

## Nginx

Use `nginx.example.conf` as the base reverse proxy and point it at the Pterodactyl allocation/local port. Add TLS with Certbot:

```bash
sudo certbot --nginx -d apex.yashasviallen.is-a.dev
```

For mobile reminders and auth, use HTTPS on the public subdomain. Keep `APEX_SYNC_ADMIN_TOKEN` private; device tokens are generated only after a valid pairing code is used.
