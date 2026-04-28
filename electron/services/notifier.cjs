// Apex — in-app notification scheduler.
//
// Runs entirely in the main process. Polls every 60 seconds for things
// the user might want to know about right now:
//   • A class is starting within 10 minutes
//   • A task deadline is within 1 hour and the task is still open
//   • The active live timer just hit zero (or is 1 minute from zero)
//
// Notifications are deduped via an in-memory set keyed by `${kind}:${id}`
// + a stable hash of the trigger window so we never spam the same alert
// more than once per "moment". Memory only — restarting Apex resets the
// dedup map, which is fine because the polling cadence is loose.

const db = require('./db.cjs');
const timetable = require('./timetable.cjs');

let _Notification = null;       // injected from main.cjs (electron.Notification)
let _enabled = false;
let _intervalRef = null;
const POLL_MS = 60_000;          // 60s
const _seenKeys = new Set();
const _onClickHandlers = [];

// Settings keys
const KEY_ENABLED = 'notifications.enabled';
const KEY_LEAD_CLASS_MIN = 'notifications.classLeadMinutes';
const KEY_LEAD_DEADLINE_MIN = 'notifications.deadlineLeadMinutes';

function _settingNum(key, fallback) {
  const v = db.getSetting(key);
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _classLead() { return _settingNum(KEY_LEAD_CLASS_MIN, 10); }
function _deadlineLead() { return _settingNum(KEY_LEAD_DEADLINE_MIN, 60); }

function _markSeen(key) { _seenKeys.add(key); }
function _alreadySeen(key) { return _seenKeys.has(key); }

// Drop dedup keys for "old" trigger windows so we don't grow forever.
// We bucket by hour, and keep keys for the current and previous hour.
function _gcSeenKeys(nowMs) {
  if (_seenKeys.size < 200) return;
  const cutoff = Math.floor((nowMs - 2 * 3600 * 1000) / (3600 * 1000));
  for (const k of _seenKeys) {
    const m = k.match(/@h(\d+)$/);
    if (!m) continue;
    if (parseInt(m[1], 10) < cutoff) _seenKeys.delete(k);
  }
}

function fire({ title, body, kind, payload }) {
  if (!_Notification || !_Notification.isSupported()) return false;
  const n = new _Notification({ title, body, silent: false });
  n.on('click', () => {
    for (const h of _onClickHandlers) {
      try { h({ kind, payload }); } catch { /* ignore */ }
    }
  });
  n.show();
  return true;
}

function _checkClasses(now) {
  const lead = _classLead();
  const tt = timetable.today();
  if (!tt?.classes?.length) return;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const c of tt.classes) {
    if (!c.start_time) continue;
    const [sh, sm] = c.start_time.split(':').map(Number);
    if (sh == null) continue;
    const startMin = (sh || 0) * 60 + (sm || 0);
    const delta = startMin - nowMin;
    if (delta > 0 && delta <= lead) {
      const hourBucket = Math.floor(now.getTime() / (3600 * 1000));
      const key = `class:${c.id || c.subject}:${c.start_time}@h${hourBucket}`;
      if (_alreadySeen(key)) continue;
      _markSeen(key);
      const msg =
        delta <= 1
          ? `${c.subject} starts now${c.room ? ` · ${c.room}` : ''}`
          : `${c.subject} in ${delta} min${c.room ? ` · ${c.room}` : ''}`;
      fire({
        title: 'Class starting',
        body: msg,
        kind: 'class',
        payload: { classId: c.id, subject: c.subject },
      });
    }
  }
}

function _checkDeadlines(now) {
  const lead = _deadlineLead();
  const dbh = db._db();
  // Open tasks with a deadline in the next `lead` minutes.
  const cutoffIso = new Date(now.getTime() + lead * 60 * 1000).toISOString();
  const rows = dbh
    .prepare(
      `SELECT id, title, deadline, priority FROM tasks
        WHERE completed = 0
          AND deadline IS NOT NULL
          AND deadline > datetime('now')
          AND deadline <= ?
        ORDER BY deadline ASC LIMIT 6`,
    )
    .all(cutoffIso);
  for (const t of rows) {
    const due = new Date(t.deadline).getTime();
    const minsLeft = Math.max(0, Math.round((due - now.getTime()) / 60000));
    const hourBucket = Math.floor(now.getTime() / (3600 * 1000));
    // Only fire once per (task, hour) so a single deadline doesn't spam
    // every minute as we approach.
    const key = `deadline:${t.id}@h${hourBucket}`;
    if (_alreadySeen(key)) continue;
    _markSeen(key);
    fire({
      title: minsLeft <= 5 ? 'Task due now' : `Task due in ${minsLeft} min`,
      body: t.title,
      kind: 'deadline',
      payload: { taskId: t.id },
    });
  }
}

function _checkTimer(now) {
  const t = db.getActiveTimer ? db.getActiveTimer() : null;
  if (!t) return;
  const total =
    ((t.planned_minutes || 0) + (t.extended_minutes || 0)) * 60;
  const elapsedSec = Math.floor((now.getTime() - new Date(t.started_at).getTime()) / 1000);
  const remainingSec = total - elapsedSec;
  // Fire once when remaining <= 60s and once when remaining <= 0 (not yet
  // auto-stopped). Keys are tied to the timer's start so a brand new
  // timer with the same kind/title gets fresh notifications.
  if (remainingSec > 0 && remainingSec <= 60) {
    const key = `timer:lowwarn:${t.started_at}`;
    if (!_alreadySeen(key)) {
      _markSeen(key);
      fire({
        title: 'Timer almost done',
        body: `"${t.title}" — 1 minute left`,
        kind: 'timer-low',
        payload: { timer: t },
      });
    }
  } else if (remainingSec <= 0) {
    const key = `timer:expired:${t.started_at}`;
    if (!_alreadySeen(key)) {
      _markSeen(key);
      fire({
        title: 'Timer up',
        body: `"${t.title}" finished`,
        kind: 'timer-expired',
        payload: { timer: t },
      });
    }
  }
}

function tick() {
  if (!_enabled) return;
  const now = new Date();
  try { _checkClasses(now); } catch (e) { console.warn('[notifier.classes]', e.message); }
  try { _checkDeadlines(now); } catch (e) { console.warn('[notifier.deadlines]', e.message); }
  try { _checkTimer(now); } catch (e) { console.warn('[notifier.timer]', e.message); }
  _gcSeenKeys(now.getTime());
}

function start() {
  // Honour saved setting; default ON.
  const stored = db.getSetting(KEY_ENABLED);
  _enabled = stored == null ? true : stored === '1' || stored === 'true' || stored === true;
  if (_intervalRef) clearInterval(_intervalRef);
  _intervalRef = setInterval(tick, POLL_MS);
  // Fire one tick at boot so a class starting in <1 min still alerts.
  setTimeout(tick, 5_000);
  return { ok: true, enabled: _enabled };
}

function stop() {
  if (_intervalRef) clearInterval(_intervalRef);
  _intervalRef = null;
  return { ok: true };
}

function setEnabled(on) {
  _enabled = !!on;
  db.setSetting(KEY_ENABLED, _enabled ? '1' : '0');
  return { ok: true, enabled: _enabled };
}

function getStatus() {
  return {
    ok: true,
    enabled: _enabled,
    classLeadMinutes: _classLead(),
    deadlineLeadMinutes: _deadlineLead(),
    seenKeys: _seenKeys.size,
    polling: !!_intervalRef,
    supported: !!(_Notification && _Notification.isSupported && _Notification.isSupported()),
  };
}

function setLeads({ classLeadMinutes, deadlineLeadMinutes }) {
  if (classLeadMinutes != null) {
    db.setSetting(KEY_LEAD_CLASS_MIN, String(Math.max(1, +classLeadMinutes || 10)));
  }
  if (deadlineLeadMinutes != null) {
    db.setSetting(KEY_LEAD_DEADLINE_MIN, String(Math.max(5, +deadlineLeadMinutes || 60)));
  }
  return getStatus();
}

function attach(NotificationClass) { _Notification = NotificationClass; }
function onClick(handler) { _onClickHandlers.push(handler); }

module.exports = {
  attach,
  start,
  stop,
  tick,
  fire,
  setEnabled,
  setLeads,
  getStatus,
  onClick,
};
