# Apex Mobile

Installable Android companion for the Apex desktop app. It pairs with the Apex
Sync API and pushes your phone's Digital Wellbeing usage to the cloud, so the
desktop sees your mobile screen-time **without USB or ADB**.

| Today | Activity |
|---|---|
| <img src="../docs/screenshots/android-today.png" width="280"> | <img src="../docs/screenshots/android-activity.png" width="280"> |

## Features

- **Bottom-nav tabs** - Today (plan + alarms + quick capture + Now), Tasks,
  Notes, Activity, Settings. Tabs use restrained icons, slide-up transitions,
  haptic feedback, and badge counts on Tasks.
- **Today dashboard** - compact hero, live focus/Zen stop card, routine plan,
  an alarm status row, quick Note/Todo capture, recent notes, and a Now section
  that shows active nudges, next due item, or an actual all-clear instead of a
  wall of text.
- **Real alarms** - wake/sleep times editable with clock pickers (synced both
  ways with the desktop routine); scheduled via `setAlarmClock()` so they are
  exact through Doze and OEM battery savers, survive reboots
  (`BOOT_COMPLETED` receiver), and actually **ring**: looping ringtone on the
  alarm stream + vibration + full-screen Dismiss / Snooze-10 / **"I'm awake"**
  (which logs `wake_done` and triggers the desktop's morning brief). The alarm
  card now shows what is armed locally, exposes ringtone/PIN controls, supports
  custom alarms, and keeps hard alarms tied to the on-device PIN.
- **Zen blocker** - mirrors desktop Zen mode: while a focus block runs, a
  foreground watcher bounces distraction apps back to home (with the overlay
  permission) or nudges loudly. The overlay is a calmer guard panel with
  **Leave and refocus**, plus **Stop focus on all devices** when the session is
  not locked. The foreground notification has a **Stop focus** action, and the
  Today tab shows an explicit Stop card while a block is live. Bounce count
  shows in Activity.
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
- **Two-way tasks** - the Tasks tab lists your desktop's open tasks (pushed
  every desktop sync cycle), groups them into Overdue / Today / Upcoming /
  Someday / Done, shows open/completed/archived counts, lets you tap a row to
  complete it, and archives completed tasks without deleting their sync history.
- **Pairing card (Settings tab)** - QR scan is the primary path; manual 6-digit
  pairing is tucked behind a collapsible **Manual pairing code** control. The
  status badge shows `PAIRED - <name>`, `NOT PAIRED`, or token errors, plus
  server-side token checks via `/me`.

- **QR pairing (one tap)** - **Scan pairing QR** opens the camera (ZXing) and
  reads the code shown on the desktop (`/pairing-codes/{code}/qr.png`). The QR
  encodes `{type:"apex_pair", api_base, code}`, so it fills the API base + code
  and pairs automatically. Manual 6-digit entry still works.
- **Connection indicator** - a header dot pings `/health` (green = reachable);
  once paired it verifies the token via `/me` and shows the device name + last
  seen. The overflow menu holds Refresh / Sync / Usage access /
  Background-sync / Check-connection / Forget.
- **Quick capture** - one text box with explicit destinations: save the whole
  thought as a day note, turn the first line into a synced todo, or jump into
  the full Notes/Tasks tabs when the capture needs more structure.
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
cd ..
npm run mobile:install
```

The install script auto-detects `adb.exe` from PATH, `ANDROID_HOME`,
`ANDROID_SDK_ROOT`, `%LOCALAPPDATA%\Android\Sdk\platform-tools`, or Minimal ADB.
To build and install in one shot:

```powershell
cd "C:\Users\yashasvi\Documents\College Prod"
npm run mobile:install:build
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
2. In Apex Mobile, tap **Scan desktop QR** and point the camera at it. If the
   camera path is unavailable, open **Manual pairing code**, type the 6-digit
   code, and tap **Pair with code**. Allow the camera prompt the first time.
3. Tap **Usage access** → allow Apex Mobile → return and tap **Sync usage**.
4. Tap **Background sync: Off** to flip it **On** for hands-free uploads.
5. On Android 13+, allow notifications when prompted (for wake/sleep nudges).
