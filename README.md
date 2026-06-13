# Apex

**Your day, in one place - and honest about it.**

A personal productivity OS for college life: timetable, tasks, focus guarding,
desktop + phone screen time in one timeline, real alarms, a local AI planner,
and a private journal. Everything runs on your machine; sync is opt-in and
goes through your own server.

[Download the latest release](https://github.com/JavaProgswing/Personal-Apex/releases/latest) -
Windows installer, portable exe, Android APK.

## Screenshots

| Dashboard | Ask Apex | Day summary |
|---|---|---|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Ask Apex](docs/screenshots/ask-apex.png) | ![Day summary](docs/screenshots/day-summary.png) |

Zen mode, locked to a running timer:

![Zen locked](docs/screenshots/zen-locked.png)

| Android - Today | Android - Activity | Close guard |
|---|---|---|
| <img src="docs/screenshots/android-today.png" width="240"> | <img src="docs/screenshots/android-activity.png" width="240"> | ![Close guard](docs/screenshots/close-guard.png) |

## Features

- **One dashboard** - classes (day-order aware), tasks, weekly goals, a live
  timer, and a 7-day picture of where your time went.
- **Screen time everywhere** - desktop foreground tracking (app, site,
  idle-aware: walk away mid-timer and it stops counting as focus) plus the
  phone's usage synced over the network, launch counts and all. One timeline,
  Digital Wellbeing accuracy.
- **Focus defense, graduated** - Zen mode in relaxed / strict / locked flavors;
  locked cannot be stopped until the timer ends. The phone mirrors the block at
  matching intensity: a plain timer only nudges, relaxed nudges louder, strict
  bounces distraction apps to the home screen, locked re-bounces relentlessly.
  Quitting the app asks for a reason that lands in your day log.
- **Real alarms** - the phone rings (looping, full-screen, snooze); marking
  yourself awake triggers a morning brief on the desktop.
- **Local AI** - Ask Apex streams from Ollama with your schedule, tasks, and
  screen time in context. Plans evenings, triages backlogs, extracts tasks
  from PDFs. Offline.
- **College-aware planning** - syllabus context, CT-date prioritization,
  contest reminders, and a classmate radar (GitHub + LeetCode/CF/CC).
- **Honest day close** - per-day debrief (focus sittings, distractions, wins)
  and a passcode-gated journal that never syncs.

## Pieces

| Piece | What | Where |
|---|---|---|
| Desktop | Electron + React + SQLite, all local | this repo, [releases](https://github.com/JavaProgswing/Personal-Apex/releases/latest) |
| Android | Kotlin companion: alarms, screen time, tasks, notes, Zen mirror | [`mobile_android/`](mobile_android/README.md) |
| Sync server | Self-hosted FastAPI: pairing, sync, focus state, web app | [`sync_api/`](sync_api/README.md) |

## Privacy

One SQLite file in `Documents/Apex`. AI on localhost. Journal passcode-gated,
never synced. Nothing leaves your machine except syncs you set up to your own
server and lookups you trigger by hand.

## Docs

- [Usage and technical guide](docs/USAGE.md) - setup, architecture, internals.
- [Android app](mobile_android/README.md) - features, build, pairing.
- [Sync API](sync_api/README.md) - endpoints, deploy, environment.
