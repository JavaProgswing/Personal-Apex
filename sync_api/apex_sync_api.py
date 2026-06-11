from __future__ import annotations

import hashlib
import io
import json
import os
import secrets
import sqlite3
import threading
import uuid
from collections import deque
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from time import monotonic  # NB: `time` name is datetime.time here, so import the fn directly
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


from zoneinfo import ZoneInfo

APP_NAME = "Apex Sync API"
# The user's wall-clock timezone. Routine windows ("wake at 07:00") are local
# times; the server itself runs UTC, so all "what time is it for the user"
# logic must go through USER_TZ.
USER_TZ = ZoneInfo(os.environ.get("APEX_SYNC_TZ", "Asia/Kolkata"))
DB_PATH = os.environ.get("APEX_SYNC_DB", "/data/apex_sync.sqlite")
PUBLIC_BASE = os.environ.get("APEX_SYNC_PUBLIC_BASE", "http://localhost:8787").rstrip("/")
ADMIN_TOKEN = os.environ.get("APEX_SYNC_ADMIN_TOKEN", "")
PAIRING_TTL_MINUTES = int(os.environ.get("APEX_SYNC_PAIRING_TTL_MINUTES", "15"))


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now_utc().isoformat(timespec="seconds")


def today_iso() -> str:
    return datetime.now(USER_TZ).date().isoformat()


def json_dump(value: Any) -> str:
    return json.dumps(value or {}, separators=(",", ":"), ensure_ascii=False)


def json_load(value: str | None, fallback: Any = None) -> Any:
    if not value:
        return fallback if fallback is not None else {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback if fallback is not None else {}


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


@contextmanager
def db() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                last_seen_at TEXT
            );
            CREATE TABLE IF NOT EXISTS pairing_codes (
                code TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used_by TEXT,
                used_at TEXT
            );
            CREATE TABLE IF NOT EXISTS routines (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                name TEXT NOT NULL,
                wake_time TEXT,
                sleep_time TEXT,
                objective_id TEXT,
                linked_task_id TEXT,
                payload_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS objectives (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'general',
                status TEXT NOT NULL DEFAULT 'active',
                linked_task_id TEXT,
                routine_id TEXT,
                due_date TEXT,
                payload_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                due_at TEXT,
                source TEXT NOT NULL DEFAULT 'desktop',
                payload_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                device_id TEXT,
                date TEXT NOT NULL,
                title TEXT,
                body TEXT NOT NULL DEFAULT '',
                kind TEXT NOT NULL DEFAULT 'day_note',
                source TEXT NOT NULL DEFAULT 'mobile',
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(device_id) REFERENCES devices(id)
            );
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                device_id TEXT,
                kind TEXT NOT NULL,
                at TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY(device_id) REFERENCES devices(id)
            );
            CREATE TABLE IF NOT EXISTS wellbeing_sessions (
                id TEXT PRIMARY KEY,
                device_id TEXT,
                date TEXT NOT NULL,
                package_name TEXT NOT NULL,
                app_name TEXT,
                category TEXT,
                started_at TEXT,
                ended_at TEXT,
                minutes REAL NOT NULL DEFAULT 0,
                payload_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT,
                FOREIGN KEY(device_id) REFERENCES devices(id)
            );
            CREATE TABLE IF NOT EXISTS focus_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                active INTEGER NOT NULL DEFAULT 0,
                title TEXT,
                mode TEXT,
                ends_at TEXT,
                source_device TEXT,
                updated_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_at ON events(at);
            CREATE INDEX IF NOT EXISTS idx_routines_date ON routines(date);
            CREATE INDEX IF NOT EXISTS idx_objectives_updated ON objectives(updated_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);
            CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
            CREATE INDEX IF NOT EXISTS idx_notes_date ON notes(date);
            CREATE INDEX IF NOT EXISTS idx_wellbeing_dev_date_pkg
                ON wellbeing_sessions(device_id, date, package_name);
            """
        )
        # Guarded migration for DBs created before updated_at existed. This MUST
        # run before any index on updated_at, because CREATE TABLE IF NOT EXISTS
        # is a no-op on an existing (pre-column) table.
        cols = {row[1] for row in conn.execute("PRAGMA table_info(wellbeing_sessions)")}
        if "updated_at" not in cols:
            conn.execute("ALTER TABLE wellbeing_sessions ADD COLUMN updated_at TEXT")
            conn.execute("UPDATE wellbeing_sessions SET updated_at = COALESCE(ended_at, date)")
        # Safe now that the column is guaranteed to exist.
        conn.execute("CREATE INDEX IF NOT EXISTS idx_wellbeing_updated ON wellbeing_sessions(updated_at)")


app = FastAPI(title=APP_NAME, version="1.0.0")

cors_origins = [
    origin.strip()
    for origin in os.environ.get("APEX_SYNC_CORS_ORIGINS", "").split(",")
    if origin.strip()
]
if cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.on_event("startup")
def on_startup() -> None:
    init_db()


class Device(BaseModel):
    id: str
    name: str
    type: str
    created_at: str
    last_seen_at: str | None = None


class PairingCodeResponse(BaseModel):
    code: str
    expires_at: str
    qr_payload: str
    qr_png_url: str


class PairRequest(BaseModel):
    code: str
    device_name: str = Field(min_length=1, max_length=80)
    device_type: str = Field(default="android", max_length=32)


class PairResponse(BaseModel):
    device: Device
    token: str
    api_base: str


class RoutineIn(BaseModel):
    id: str | None = None
    date: str = Field(default_factory=today_iso)
    name: str = "Daily routine"
    wake_time: str | None = "07:00"
    sleep_time: str | None = "23:30"
    objective_id: str | None = None
    linked_task_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class ObjectiveIn(BaseModel):
    id: str | None = None
    title: str = Field(min_length=1, max_length=300)
    kind: str = "general"
    status: str = "active"
    linked_task_id: str | None = None
    routine_id: str | None = None
    due_date: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class TaskIn(BaseModel):
    id: str | None = None
    title: str = Field(min_length=1, max_length=300)
    status: str = "open"
    due_at: str | None = None
    source: str = "desktop"
    payload: dict[str, Any] = Field(default_factory=dict)


class NoteIn(BaseModel):
    id: str | None = None
    date: str = Field(default_factory=today_iso)
    title: str | None = Field(default=None, max_length=160)
    body: str = Field(default="", max_length=8000)
    kind: str = Field(default="day_note", max_length=40)
    source: str = Field(default="mobile", max_length=40)
    payload: dict[str, Any] = Field(default_factory=dict)


class EventIn(BaseModel):
    id: str | None = None
    kind: str = Field(min_length=1, max_length=80)
    at: str = Field(default_factory=now_iso)
    payload: dict[str, Any] = Field(default_factory=dict)


class WellbeingSessionIn(BaseModel):
    id: str | None = None
    date: str = Field(default_factory=today_iso)
    package_name: str = Field(min_length=1, max_length=200)
    app_name: str | None = None
    category: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    minutes: float = 0
    payload: dict[str, Any] = Field(default_factory=dict)


class SyncPush(BaseModel):
    routines: list[RoutineIn] = Field(default_factory=list)
    objectives: list[ObjectiveIn] = Field(default_factory=list)
    tasks: list[TaskIn] = Field(default_factory=list)
    notes: list[NoteIn] = Field(default_factory=list)
    events: list[EventIn] = Field(default_factory=list)
    wellbeing: list[WellbeingSessionIn] = Field(default_factory=list)


def require_admin(authorization: str | None = Header(default=None)) -> None:
    if not ADMIN_TOKEN:
        raise HTTPException(503, "APEX_SYNC_ADMIN_TOKEN is not configured")
    token = parse_bearer(authorization)
    if not token or not secrets.compare_digest(token, ADMIN_TOKEN):
        raise HTTPException(401, "Admin token required")


def parse_bearer(authorization: str | None) -> str | None:
    if not authorization:
        return None
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        return None
    return authorization[len(prefix) :].strip()


def admin_or_device(authorization: str | None = Header(default=None)) -> Device | None:
    """Accept either the admin token (returns None) or a paired device's token
    (returns the Device). Single-user system: any paired device may see and
    manage the device list, which is what powers unlink-from-either-side."""
    token = parse_bearer(authorization)
    if ADMIN_TOKEN and token and secrets.compare_digest(token, ADMIN_TOKEN):
        return None
    return current_device(authorization)


def current_device(authorization: str | None = Header(default=None)) -> Device:
    token = parse_bearer(authorization)
    if not token:
        raise HTTPException(401, "Bearer token required")
    with db() as conn:
        row = conn.execute(
            "SELECT id, name, type, created_at, last_seen_at FROM devices WHERE token_hash = ?",
            (hash_token(token),),
        ).fetchone()
        if not row:
            raise HTTPException(401, "Invalid device token")
        conn.execute("UPDATE devices SET last_seen_at = ? WHERE id = ?", (now_iso(), row["id"]))
        return Device(**dict(row))


def routine_from_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["payload"] = json_load(data.pop("payload_json", "{}"))
    return data


def objective_from_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["payload"] = json_load(data.pop("payload_json", "{}"))
    return data


def task_from_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["payload"] = json_load(data.pop("payload_json", "{}"))
    return data


def note_from_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["payload"] = json_load(data.pop("payload_json", "{}"))
    return data


def event_from_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["payload"] = json_load(data.pop("payload_json", "{}"))
    return data


def wellbeing_from_row(row: sqlite3.Row) -> dict[str, Any]:
    data = dict(row)
    data["payload"] = json_load(data.pop("payload_json", "{}"))
    return data


def upsert_routine(conn: sqlite3.Connection, item: RoutineIn) -> str:
    item_id = item.id or make_id("routine")
    conn.execute(
        """
        INSERT INTO routines (id, date, name, wake_time, sleep_time, objective_id, linked_task_id, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            date = excluded.date,
            name = excluded.name,
            wake_time = excluded.wake_time,
            sleep_time = excluded.sleep_time,
            objective_id = excluded.objective_id,
            linked_task_id = excluded.linked_task_id,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        """,
        (
            item_id,
            item.date,
            item.name,
            item.wake_time,
            item.sleep_time,
            item.objective_id,
            item.linked_task_id,
            json_dump(item.payload),
            now_iso(),
        ),
    )
    return item_id


def upsert_objective(conn: sqlite3.Connection, item: ObjectiveIn) -> str:
    item_id = item.id or make_id("objective")
    conn.execute(
        """
        INSERT INTO objectives (id, title, kind, status, linked_task_id, routine_id, due_date, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            kind = excluded.kind,
            status = excluded.status,
            linked_task_id = excluded.linked_task_id,
            routine_id = excluded.routine_id,
            due_date = excluded.due_date,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        """,
        (
            item_id,
            item.title,
            item.kind,
            item.status,
            item.linked_task_id,
            item.routine_id,
            item.due_date,
            json_dump(item.payload),
            now_iso(),
        ),
    )
    return item_id


def upsert_task(conn: sqlite3.Connection, item: TaskIn) -> str:
    item_id = item.id or make_id("task")
    conn.execute(
        """
        INSERT INTO tasks (id, title, status, due_at, source, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            status = excluded.status,
            due_at = excluded.due_at,
            source = excluded.source,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        """,
        (item_id, item.title, item.status, item.due_at, item.source, json_dump(item.payload), now_iso()),
    )
    return item_id


def upsert_note(conn: sqlite3.Connection, device_id: str | None, item: NoteIn) -> str:
    item_id = item.id or make_id("note")
    stamped = now_iso()
    conn.execute(
        """
        INSERT INTO notes (id, device_id, date, title, body, kind, source, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            device_id = excluded.device_id,
            date = excluded.date,
            title = excluded.title,
            body = excluded.body,
            kind = excluded.kind,
            source = excluded.source,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        """,
        (
            item_id,
            device_id,
            item.date,
            item.title,
            item.body,
            item.kind,
            item.source,
            json_dump(item.payload),
            stamped,
            stamped,
        ),
    )
    return item_id


def insert_event(conn: sqlite3.Connection, device_id: str, item: EventIn) -> str:
    item_id = item.id or make_id("event")
    conn.execute(
        """
        INSERT OR REPLACE INTO events (id, device_id, kind, at, payload_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (item_id, device_id, item.kind, item.at, json_dump(item.payload)),
    )
    return item_id


def upsert_wellbeing(conn: sqlite3.Connection, device_id: str, item: WellbeingSessionIn) -> str:
    item_id = item.id or make_id("wellbeing")
    # The phone reports each day's running foreground total, not deltas, so a
    # re-sync must REPLACE the prior row for the same (device, day, package)
    # rather than accumulate. Clear any stale match first (covers clients that
    # send a non-deterministic id), then upsert by id.
    conn.execute(
        "DELETE FROM wellbeing_sessions WHERE device_id = ? AND date = ? AND package_name = ?",
        (device_id, item.date, item.package_name),
    )
    conn.execute(
        """
        INSERT OR REPLACE INTO wellbeing_sessions
        (id, device_id, date, package_name, app_name, category, started_at, ended_at, minutes, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            item_id,
            device_id,
            item.date,
            item.package_name,
            item.app_name,
            item.category,
            item.started_at,
            item.ended_at,
            item.minutes,
            json_dump(item.payload),
            now_iso(),
        ),
    )
    return item_id


# ── Rate limiting ────────────────────────────────────────────────────────────
# In-memory fixed-window limiter keyed by client IP. Guards the unauthenticated
# brute-force surfaces: /pair (6-digit codes) and /pairing-codes (admin token).
# Single-process uvicorn, so a process-local dict is sufficient; behind nginx-
# proxy-manager the real client IP arrives via X-Forwarded-For.
def client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# Factory returns a plain closure (not a class instance) so FastAPI can read
# its __globals__ and resolve the `Request` annotation under
# `from __future__ import annotations`.
def make_rate_limiter(limit: int, window_seconds: int, name: str):
    hits: dict[str, deque] = {}
    lock = threading.Lock()

    def limiter(request: Request) -> None:
        key = client_ip(request)
        now = monotonic()
        cutoff = now - window_seconds
        with lock:
            dq = hits.setdefault(key, deque())
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= limit:
                retry = int(dq[0] + window_seconds - now) + 1
                raise HTTPException(429, f"Too many {name} attempts; retry in {retry}s")
            dq.append(now)
            # Opportunistic prune so idle IPs don't accumulate forever.
            if len(hits) > 2048:
                for k in [k for k, v in hits.items() if not v]:
                    hits.pop(k, None)

    return limiter


pair_limiter = make_rate_limiter(limit=12, window_seconds=60, name="pairing")
code_limiter = make_rate_limiter(limit=30, window_seconds=60, name="pairing-code")


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "name": APP_NAME, "time": now_iso()}


@app.get("/me")
def whoami(device: Device = Depends(current_device)) -> Device:
    """Return the calling device - lets a client confirm its token is valid
    and surface the paired device name / last-seen time."""
    return device


@app.get("/devices")
def list_devices(caller: Device | None = Depends(admin_or_device)) -> dict[str, Any]:
    """List every paired device (no token hashes). Works with the admin token
    or any paired device's token; `self` marks the calling device so UIs can
    label "this device"."""
    with db() as conn:
        rows = conn.execute(
            "SELECT id, name, type, created_at, last_seen_at FROM devices ORDER BY created_at"
        ).fetchall()
    return {
        "self": caller.id if caller else None,
        "devices": [dict(row) for row in rows],
    }


@app.delete("/devices/{device_id}")
def revoke_device(device_id: str, caller: Device | None = Depends(admin_or_device)) -> dict[str, Any]:
    """Revoke a device's pairing - its token stops working immediately. Any
    paired device (or the admin) may unlink any device, including itself.
    Synced data (events / wellbeing rows) is kept for history."""
    with db() as conn:
        cur = conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Device not found")
    return {"ok": True, "revoked": device_id, "was_self": bool(caller and caller.id == device_id)}


class FocusIn(BaseModel):
    active: bool = False
    title: str | None = None
    mode: str = "zen"
    ends_at: str | None = None


@app.put("/focus")
def put_focus(payload: FocusIn, device: Device = Depends(current_device)) -> dict[str, Any]:
    """Desktop publishes its focus state here when Zen mode starts/stops; the
    phone polls it to run the mobile distraction blocker."""
    with db() as conn:
        conn.execute(
            """
            INSERT INTO focus_state (id, active, title, mode, ends_at, source_device, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                active = excluded.active, title = excluded.title, mode = excluded.mode,
                ends_at = excluded.ends_at, source_device = excluded.source_device,
                updated_at = excluded.updated_at
            """,
            (1 if payload.active else 0, payload.title, payload.mode, payload.ends_at, device.id, now_iso()),
        )
    return {"ok": True, "active": payload.active}


@app.get("/focus")
def get_focus(device: Device = Depends(current_device)) -> dict[str, Any]:
    with db() as conn:
        row = conn.execute("SELECT * FROM focus_state WHERE id = 1").fetchone()
    if not row:
        return {"active": False, "title": None, "mode": None, "ends_at": None}
    data = dict(row)
    active = bool(data.get("active"))
    ends_at = data.get("ends_at")
    # Auto-expire: a stale "active" row past its end time reads as inactive,
    # so a crashed desktop can't leave the phone blocked forever.
    if active and ends_at:
        try:
            if datetime.fromisoformat(ends_at) < now_utc():
                active = False
        except ValueError:
            pass
    return {
        "active": active,
        "title": data.get("title"),
        "mode": data.get("mode"),
        "ends_at": ends_at,
        "updated_at": data.get("updated_at"),
    }


@app.post("/pairing-codes", dependencies=[Depends(code_limiter), Depends(require_admin)])
def create_pairing_code() -> PairingCodeResponse:
    code = f"{secrets.randbelow(1_000_000):06d}"
    created = now_utc()
    expires = created + timedelta(minutes=PAIRING_TTL_MINUTES)
    payload = json.dumps({"type": "apex_pair", "api_base": PUBLIC_BASE, "code": code}, separators=(",", ":"))
    with db() as conn:
        conn.execute(
            "INSERT INTO pairing_codes (code, created_at, expires_at) VALUES (?, ?, ?)",
            (code, created.isoformat(timespec="seconds"), expires.isoformat(timespec="seconds")),
        )
    return PairingCodeResponse(
        code=code,
        expires_at=expires.isoformat(timespec="seconds"),
        qr_payload=payload,
        qr_png_url=f"{PUBLIC_BASE}/pairing-codes/{code}/qr.png",
    )


@app.get("/pairing-codes/{code}/qr.png")
def pairing_qr(code: str) -> Response:
    with db() as conn:
        row = conn.execute(
            "SELECT code, expires_at, used_at FROM pairing_codes WHERE code = ?",
            (code,),
        ).fetchone()
    if not row:
        raise HTTPException(404, "Pairing code not found")
    if row["used_at"]:
        raise HTTPException(410, "Pairing code already used")
    if datetime.fromisoformat(row["expires_at"]) < now_utc():
        raise HTTPException(410, "Pairing code expired")
    import qrcode

    payload = json.dumps({"type": "apex_pair", "api_base": PUBLIC_BASE, "code": code}, separators=(",", ":"))
    image = qrcode.make(payload)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@app.post("/pair", dependencies=[Depends(pair_limiter)])
def pair_device(payload: PairRequest) -> PairResponse:
    with db() as conn:
        row = conn.execute(
            "SELECT code, expires_at, used_at FROM pairing_codes WHERE code = ?",
            (payload.code,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Pairing code not found")
        if row["used_at"]:
            raise HTTPException(410, "Pairing code already used")
        if datetime.fromisoformat(row["expires_at"]) < now_utc():
            raise HTTPException(410, "Pairing code expired")

        token = secrets.token_urlsafe(32)
        device_id = make_id("device")
        created = now_iso()
        conn.execute(
            "INSERT INTO devices (id, name, type, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
            (device_id, payload.device_name, payload.device_type, hash_token(token), created, created),
        )
        conn.execute(
            "UPDATE pairing_codes SET used_by = ?, used_at = ? WHERE code = ?",
            (device_id, created, payload.code),
        )
        device = Device(id=device_id, name=payload.device_name, type=payload.device_type, created_at=created, last_seen_at=created)
    return PairResponse(device=device, token=token, api_base=PUBLIC_BASE)


@app.get("/bootstrap")
def bootstrap(device: Device = Depends(current_device)) -> dict[str, Any]:
    with db() as conn:
        routines = [routine_from_row(row) for row in conn.execute("SELECT * FROM routines ORDER BY date DESC LIMIT 30")]
        objectives = [objective_from_row(row) for row in conn.execute("SELECT * FROM objectives ORDER BY updated_at DESC LIMIT 100")]
        tasks = [task_from_row(row) for row in conn.execute("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 100")]
        notes = [note_from_row(row) for row in conn.execute("SELECT * FROM notes ORDER BY updated_at DESC LIMIT 60")]
    return {
        "device": device.model_dump(),
        "server_time": now_iso(),
        "routines": routines,
        "objectives": objectives,
        "tasks": tasks,
        "notes": notes,
    }


@app.get("/sync/pull")
def pull_sync(
    since: str | None = Query(default=None),
    device: Device = Depends(current_device),
) -> dict[str, Any]:
    where = "WHERE updated_at > ?" if since else ""
    params = (since,) if since else ()
    event_where = "WHERE at > ?" if since else ""
    with db() as conn:
        routines = [routine_from_row(row) for row in conn.execute(f"SELECT * FROM routines {where} ORDER BY updated_at", params)]
        objectives = [objective_from_row(row) for row in conn.execute(f"SELECT * FROM objectives {where} ORDER BY updated_at", params)]
        tasks = [task_from_row(row) for row in conn.execute(f"SELECT * FROM tasks {where} ORDER BY updated_at", params)]
        notes = [note_from_row(row) for row in conn.execute(f"SELECT * FROM notes {where} ORDER BY updated_at", params)]
        events = [event_from_row(row) for row in conn.execute(f"SELECT * FROM events {event_where} ORDER BY at", params)]
        # Wellbeing is intentionally NOT scoped to the requesting device: the
        # desktop pulls the *phone's* usage. `since` (on updated_at) keeps
        # incremental pulls cheap once a baseline has been fetched.
        if since:
            wb_rows = conn.execute(
                "SELECT * FROM wellbeing_sessions WHERE COALESCE(updated_at, date) > ? "
                "ORDER BY date DESC, minutes DESC LIMIT 500",
                (since,),
            )
        else:
            wb_rows = conn.execute(
                "SELECT * FROM wellbeing_sessions ORDER BY date DESC, minutes DESC LIMIT 500"
            )
        wellbeing = [wellbeing_from_row(row) for row in wb_rows]
    return {
        "server_time": now_iso(),
        "routines": routines,
        "objectives": objectives,
        "tasks": tasks,
        "notes": notes,
        "events": events,
        "wellbeing": wellbeing,
    }


@app.post("/sync/push")
def push_sync(payload: SyncPush, device: Device = Depends(current_device)) -> dict[str, Any]:
    ids: dict[str, list[str]] = {"routines": [], "objectives": [], "tasks": [], "notes": [], "events": [], "wellbeing": []}
    with db() as conn:
        for item in payload.routines:
            ids["routines"].append(upsert_routine(conn, item))
        for item in payload.objectives:
            ids["objectives"].append(upsert_objective(conn, item))
        for item in payload.tasks:
            ids["tasks"].append(upsert_task(conn, item))
        for item in payload.notes:
            ids["notes"].append(upsert_note(conn, device.id, item))
        for item in payload.events:
            ids["events"].append(insert_event(conn, device.id, item))
        for item in payload.wellbeing:
            ids["wellbeing"].append(upsert_wellbeing(conn, device.id, item))
    return {"ok": True, "server_time": now_iso(), "ids": ids}


@app.get("/routine/today")
def get_today_routine(day: str | None = Query(default=None), device: Device = Depends(current_device)) -> dict[str, Any]:
    day = day or today_iso()
    with db() as conn:
        row = conn.execute("SELECT * FROM routines WHERE date = ? ORDER BY updated_at DESC LIMIT 1", (day,)).fetchone()
    if row:
        return routine_from_row(row)
    return {
        "id": None,
        "date": day,
        "name": "Daily routine",
        "wake_time": "07:00",
        "sleep_time": "23:30",
        "objective_id": None,
        "linked_task_id": None,
        "payload": {"source": "default"},
        "updated_at": now_iso(),
    }


@app.put("/routine/today")
def put_today_routine(payload: RoutineIn, device: Device = Depends(current_device)) -> dict[str, Any]:
    payload.date = payload.date or today_iso()
    with db() as conn:
        routine_id = upsert_routine(conn, payload)
        row = conn.execute("SELECT * FROM routines WHERE id = ?", (routine_id,)).fetchone()
    return routine_from_row(row)


@app.get("/objectives")
def list_objectives(device: Device = Depends(current_device)) -> list[dict[str, Any]]:
    with db() as conn:
        return [objective_from_row(row) for row in conn.execute("SELECT * FROM objectives ORDER BY updated_at DESC LIMIT 200")]


@app.post("/objectives")
def save_objective(payload: ObjectiveIn, device: Device = Depends(current_device)) -> dict[str, Any]:
    with db() as conn:
        objective_id = upsert_objective(conn, payload)
        row = conn.execute("SELECT * FROM objectives WHERE id = ?", (objective_id,)).fetchone()
    return objective_from_row(row)


@app.patch("/objectives/{objective_id}")
def patch_objective(objective_id: str, payload: dict[str, Any], device: Device = Depends(current_device)) -> dict[str, Any]:
    allowed = {"title", "kind", "status", "linked_task_id", "routine_id", "due_date"}
    updates = {key: value for key, value in payload.items() if key in allowed}
    if "payload" in payload:
        updates["payload_json"] = json_dump(payload["payload"])
    if not updates:
        raise HTTPException(400, "No valid fields to update")
    updates["updated_at"] = now_iso()
    sql = ", ".join(f"{key} = ?" for key in updates)
    with db() as conn:
        conn.execute(f"UPDATE objectives SET {sql} WHERE id = ?", (*updates.values(), objective_id))
        row = conn.execute("SELECT * FROM objectives WHERE id = ?", (objective_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Objective not found")
    return objective_from_row(row)


@app.get("/tasks")
def list_tasks(device: Device = Depends(current_device)) -> list[dict[str, Any]]:
    with db() as conn:
        return [task_from_row(row) for row in conn.execute("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 200")]


@app.post("/tasks")
def save_task(payload: TaskIn, device: Device = Depends(current_device)) -> dict[str, Any]:
    with db() as conn:
        task_id = upsert_task(conn, payload)
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return task_from_row(row)


@app.delete("/tasks/{task_id}")
def delete_task(task_id: str, device: Device = Depends(current_device)) -> dict[str, Any]:
    with db() as conn:
        cur = conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    if cur.rowcount == 0:
        raise HTTPException(404, "Task not found")
    return {"ok": True, "deleted": task_id}


@app.get("/notes")
def list_notes(
    limit: int = Query(default=60, ge=1, le=200),
    device: Device = Depends(current_device),
) -> list[dict[str, Any]]:
    with db() as conn:
        return [
            note_from_row(row)
            for row in conn.execute("SELECT * FROM notes ORDER BY updated_at DESC LIMIT ?", (limit,))
        ]


@app.post("/notes")
def save_note(payload: NoteIn, device: Device = Depends(current_device)) -> dict[str, Any]:
    payload.source = payload.source or device.type or "mobile"
    with db() as conn:
        note_id = upsert_note(conn, device.id, payload)
        row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return note_from_row(row)


@app.delete("/notes/{note_id}")
def delete_note(note_id: str, device: Device = Depends(current_device)) -> dict[str, Any]:
    with db() as conn:
        cur = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    if cur.rowcount == 0:
        raise HTTPException(404, "Note not found")
    return {"ok": True, "deleted": note_id}


@app.post("/events")
def save_event(payload: EventIn, device: Device = Depends(current_device)) -> dict[str, Any]:
    with db() as conn:
        event_id = insert_event(conn, device.id, payload)
        row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    return event_from_row(row)


@app.post("/wellbeing")
def save_wellbeing(payload: list[WellbeingSessionIn], device: Device = Depends(current_device)) -> dict[str, Any]:
    ids: list[str] = []
    with db() as conn:
        for item in payload:
            ids.append(upsert_wellbeing(conn, device.id, item))
    return {"ok": True, "ids": ids}


@app.post("/close-reasons")
def save_close_reason(payload: EventIn, device: Device = Depends(current_device)) -> dict[str, Any]:
    if payload.kind == "close_reason":
        event = payload
    else:
        event = EventIn(id=payload.id, kind="close_reason", at=payload.at, payload=payload.payload)
    with db() as conn:
        event_id = insert_event(conn, device.id, event)
        row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    return event_from_row(row)


def parse_hhmm(value: str | None) -> time | None:
    if not value:
        return None
    try:
        hour, minute = value.split(":", 1)
        return time(hour=int(hour), minute=int(minute))
    except ValueError:
        return None


@app.get("/reminders/due")
def due_reminders(device: Device = Depends(current_device)) -> list[dict[str, Any]]:
    """What deserves the user's attention right now.

    - Wake reminder: from wake time until wake+4h, unless wake_done was logged.
      Falls back to the default routine when the desktop hasn't pushed one, so
      a fresh pairing still gets morning/night nudges.
    - Sleep reminder: from sleep time until 04:00, unless sleep_done was logged.
    - Tasks: anything due today (flagged `overdue` once past-due). Naive and
      timezone-tolerant: compares the date part for "today", full ISO for
      overdue.
    """
    reminders: list[dict[str, Any]] = []
    today = today_iso()
    now_local = datetime.now(USER_TZ)
    now_min = now_local.hour * 60 + now_local.minute
    with db() as conn:
        routine = conn.execute("SELECT * FROM routines WHERE date = ? ORDER BY updated_at DESC LIMIT 1", (today,)).fetchone()
        recent_events = {
            row["kind"]
            for row in conn.execute(
                "SELECT kind FROM events WHERE at >= ?",
                (datetime.combine(now_local.date(), time.min).isoformat(),),
            )
        }
        open_tasks = [
            task_from_row(row)
            for row in conn.execute(
                "SELECT * FROM tasks WHERE status != 'done' AND due_at IS NOT NULL ORDER BY due_at LIMIT 40"
            )
        ]

    routine_data = routine_from_row(routine) if routine else {
        "id": None, "date": today, "name": "Daily routine",
        "wake_time": "07:00", "sleep_time": "23:30",
        "payload": {"source": "default"},
    }
    wake = parse_hhmm(routine_data.get("wake_time"))
    sleep = parse_hhmm(routine_data.get("sleep_time"))
    if wake and "wake_done" not in recent_events:
        wake_min = wake.hour * 60 + wake.minute
        if wake_min <= now_min <= wake_min + 240:
            reminders.append({"kind": "wake", "title": "Morning check-in - open today's plan", "routine": routine_data})
    if sleep and "sleep_done" not in recent_events:
        sleep_min = sleep.hour * 60 + sleep.minute
        # Window wraps past midnight: sleep..23:59 plus 00:00..04:00.
        if now_min >= sleep_min or now_min <= 240:
            reminders.append({"kind": "sleep", "title": "Night wind-down - wrap up cleanly", "routine": routine_data})

    now_full = now_local.replace(tzinfo=None).isoformat(timespec="seconds")
    for task in open_tasks:
        due_at = str(task.get("due_at") or "")
        if not due_at:
            continue
        due_day = due_at[:10]
        if due_day > today:
            continue
        overdue = due_day < today or (len(due_at) > 10 and due_at[:19] < now_full)
        reminders.append({
            "kind": "task",
            "title": task["title"],
            "overdue": overdue,
            "due_at": due_at,
            "task": task,
        })
    return reminders
