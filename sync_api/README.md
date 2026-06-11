# Apex Sync API

FastAPI service for pairing the Apex desktop app with a mobile app, syncing daily routines, wake/sleep timers, objectives, tasks, close reasons, distraction events, and mobile wellbeing usage.

## Endpoints

- `GET /health`
- `POST /pairing-codes` with `Authorization: Bearer <APEX_SYNC_ADMIN_TOKEN>`
- `GET /pairing-codes/{code}/qr.png`
- `POST /pair`
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
