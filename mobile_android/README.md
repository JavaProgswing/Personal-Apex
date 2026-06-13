# Apex Mobile

Installable Android companion for the Apex desktop app. It pairs with the Apex
Sync API and pushes your phone's Digital Wellbeing usage to the cloud, so the
desktop sees your mobile screen-time **without USB or ADB**.

| Today | Activity |
|---|---|
| <img src="../docs/screenshots/android-today.png" width="280"> | <img src="../docs/screenshots/android-activity.png" width="280"> |

## Features

- **Bottom-nav tabs** - Today (plan + alarms + quick capture), Tasks, Notes,
  Activity, Settings — slide-up tab transitions, badge counts on Tasks.
- **Real alarms** - wake/sleep times editable with clock pickers (synced both
  ways with the desktop routine); scheduled via `setAlarmClock()` so they are
  exact through Doze and OEM battery savers, survive reboots
  (`BOOT_COMPLETED` receiver), and actually **ring**: looping ringtone on the
  alarm stream + vibration + full-screen Dismiss / Snooze-10 / **"I'm awake ✓"**
  (which logs `wake_done` and triggers the desktop's morning brief).
- **Zen blocker** - mirrors desktop Zen mode: while a focus block runs, a
  foreground watcher bounces distraction apps back to home (with the overlay
  permission) or nudges loudly. Bounce count shows in Activity.
- **Accurate screen time** - parity with Digital Wellbeing: event-stream
  accounting clamped at screen-off/keyguard, launch counts per app, system
  services filtered out, day-scoped (no stale yesterday data after midnight),
  long-press to hide an app.
- **Gap logging** - 3+ hours with no screen use during waking hours → a
  notification asks "what were you up to?"; one line + a category lands the
  block in desktop screen time as a manual entry.
- **Synced notes** - write/edit day notes from the phone; they flow through
  the sync API alongside tasks.
- **Sharing controls** - toggle usage sharing entirely, or strip readable app
  names (package ids only).
- **Two-way tasks** - the Tasks tab lists your desktop's top open tasks
  (pushed every desktop sync cycle), tap a row to complete it (flows back to
  the desktop), and quick-add new tasks that appear in desktop Apex.
- **Pairing card (Settings tab)** - explicit `● PAIRED - <name>` /
  `○ NOT PAIRED` badge, device id, API base, last upload, server-side token
  check via `/me`, plus **Unpair**. Admin can audit/revoke any device via
  `GET/DELETE /devices` on the sync API.

- **QR pairing (one tap)** - **Scan pairing QR** opens the camera (ZXing) and
  reads the code shown on the desktop (`/pairing-codes/{code}/qr.png`). The QR
  encodes `{type:"apex_pair", api_base, code}`, so it fills the API base + code
  and pairs automatically. Manual 6-digit entry still works.
- **Connection indicator** - a header dot pings `/health` (green = reachable);
  once paired it verifies the token via `/me` and shows the device name + last
  seen. An **overflow (⋮) menu** holds Refresh / Sync / Usage access /
  Background-sync / Check-connection / Forget.
- **Today view** - pulls today's routine (wake/sleep, main objective), open
  tasks, and due reminders. Buttons to log **Wake done / Sleep done / Goal done**
  back to Apex.
- **On-device usage preview** - shows today's top apps + total minutes read
  locally from Usage Access, before you sync.
- **Routine notifications** - morning/night local notifications via
  `AlarmManager`, even when the app is closed.
- **Usage sync** - reads the Android `UsageEvents` stream into accurate per-app
  foreground time (+ first/last timestamps) and pushes it. Each row is keyed by
  `(device, day, package)` so repeated syncs upsert instead of duplicating.
- **Background sync** - a `WorkManager` periodic job uploads usage roughly every
  couple of hours while online, no app open and no cable. Survives reboots.

## How the no-cable sync works

```
Phone (Usage Access) ──push──▶ Apex Sync API (Oracle, Docker)
                                      ▲
Desktop Apex ──pull (every 15 min)────┘   → activity_sessions(source='mobile')
```

Both devices pair independently with the same sync API. The phone pushes; the
desktop pulls (Settings → **Mobile** → **Sync phone now** or **Auto every 15 min**).

## Build In Android Studio

1. Open `mobile_android/` in Android Studio.
2. Let Gradle sync download the Android Gradle plugin + dependencies
   (okhttp, kotlinx-coroutines, **androidx.work**).
3. Build/run `app` on a connected phone.

> `gradle.properties` now sets `android.useAndroidX=true` (required by
> WorkManager). The app uses no legacy support libraries, so Jetifier stays off.

## Build From CLI

Use the checked-in Gradle wrapper so the build runs with the Android Gradle
Plugin's required Gradle version:

```powershell
cd "C:\Users\yashasvi\Documents\College Prod\mobile_android"
.\gradlew.bat assembleDebug
& "C:\Program Files (x86)\Minimal ADB and Fastboot\adb.exe" install -r ".\app\build\outputs\apk\debug\app-debug.apk"
```

## First-run setup

1. **Show a pairing QR.** On desktop: Settings → **Mobile** → **Phone pairing
   code** (needs the admin token). It shows a 6-digit code; open the QR at
   `https://apex.yashasviallen.is-a.dev/pairing-codes/<code>/qr.png`. Or mint one
   by hand:
   ```bash
   curl -X POST https://apex.yashasviallen.is-a.dev/pairing-codes \
     -H "Authorization: Bearer <APEX_SYNC_ADMIN_TOKEN>"
   ```
2. In Apex Mobile, tap **Scan pairing QR** and point the camera at it (or type
   the 6-digit code and tap **Pair**). Allow the camera prompt the first time.
3. Tap **Usage access** → allow Apex Mobile → return and tap **Sync usage**.
4. Tap **Background sync: Off** to flip it **On** for hands-free uploads.
5. On Android 13+, allow notifications when prompted (for wake/sleep nudges).
