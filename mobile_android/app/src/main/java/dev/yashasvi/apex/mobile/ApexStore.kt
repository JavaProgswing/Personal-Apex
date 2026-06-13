package dev.yashasvi.apex.mobile

import android.content.Context
import android.os.Build

class ApexStore(context: Context) {
    private val prefs = context.getSharedPreferences("apex_mobile", Context.MODE_PRIVATE)

    var apiBase: String
        get() = prefs.getString(KEY_API_BASE, DEFAULT_API_BASE) ?: DEFAULT_API_BASE
        set(value) = prefs.edit().putString(KEY_API_BASE, value.trim().trimEnd('/')).apply()

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_TOKEN, value?.trim()).apply()

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value?.trim()).apply()

    var autoSync: Boolean
        get() = prefs.getBoolean(KEY_AUTO_SYNC, false)
        set(value) = prefs.edit().putBoolean(KEY_AUTO_SYNC, value).apply()

    // ── sharing controls ────────────────────────────────────────────────
    // Usage sharing is the app's whole point, so it defaults ON; the user
    // can still turn it off and nothing leaves the phone.
    var shareUsage: Boolean
        get() = prefs.getBoolean(KEY_SHARE_USAGE, true)
        set(value) = prefs.edit().putBoolean(KEY_SHARE_USAGE, value).apply()

    // OFF ⇒ usage rows go up with package names only (no human-readable
    // app labels).
    var shareAppNames: Boolean
        get() = prefs.getBoolean(KEY_SHARE_APP_NAMES, true)
        set(value) = prefs.edit().putBoolean(KEY_SHARE_APP_NAMES, value).apply()

    // Mirror desktop Zen mode with a mobile distraction blocker.
    var blockerEnabled: Boolean
        get() = prefs.getBoolean(KEY_BLOCKER, false)
        set(value) = prefs.edit().putBoolean(KEY_BLOCKER, value).apply()

    var deviceName: String
        get() = prefs.getString(KEY_DEVICE_NAME, defaultDeviceName()) ?: defaultDeviceName()
        set(value) = prefs.edit().putString(KEY_DEVICE_NAME, value.trim().ifBlank { defaultDeviceName() }).apply()

    var lastSyncAt: String?
        get() = prefs.getString(KEY_LAST_SYNC_AT, null)
        set(value) = prefs.edit().putString(KEY_LAST_SYNC_AT, value).apply()

    var lastRoutineSummary: String?
        get() = prefs.getString(KEY_LAST_ROUTINE_SUMMARY, null)
        set(value) = prefs.edit().putString(KEY_LAST_ROUTINE_SUMMARY, value).apply()

    var wakeAlarmEnabled: Boolean
        get() = prefs.getBoolean(KEY_WAKE_ALARM_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_WAKE_ALARM_ENABLED, value).apply()

    var sleepReminderEnabled: Boolean
        get() = prefs.getBoolean(KEY_SLEEP_REMINDER_ENABLED, true)
        set(value) = prefs.edit().putBoolean(KEY_SLEEP_REMINDER_ENABLED, value).apply()

    // Last times the alarms were scheduled for — lets the fired receiver
    // reschedule tomorrow without needing the app to be opened or online.
    var lastWakeTime: String?
        get() = prefs.getString(KEY_LAST_WAKE_TIME, null)
        set(value) = prefs.edit().putString(KEY_LAST_WAKE_TIME, value).apply()

    var lastSleepTime: String?
        get() = prefs.getString(KEY_LAST_SLEEP_TIME, null)
        set(value) = prefs.edit().putString(KEY_LAST_SLEEP_TIME, value).apply()

    // When the ringing alarm last auto-snoozed itself after going unanswered.
    // Guards against an endless ring → snooze → ring loop.
    var lastAutoSnoozeAt: Long
        get() = prefs.getLong("last_auto_snooze_at", 0L)
        set(value) = prefs.edit().putLong("last_auto_snooze_at", value).apply()

    // ── Custom alarms ────────────────────────────────────────────────────
    // User-defined alarms beyond wake/sleep, persisted as a JSON array.
    // `hard` alarms can only be stopped with the alarm PIN (or by powering
    // the phone off) — no snooze, no dismiss.
    var customAlarms: List<CustomAlarm>
        get() = runCatching {
            val arr = org.json.JSONArray(prefs.getString("custom_alarms", "[]") ?: "[]")
            (0 until arr.length()).mapNotNull { i ->
                val o = arr.optJSONObject(i) ?: return@mapNotNull null
                CustomAlarm(
                    id = o.optString("id").ifBlank { return@mapNotNull null },
                    label = o.optString("label", "Alarm"),
                    hhmm = o.optString("hhmm", "08:00"),
                    enabled = o.optBoolean("enabled", true),
                    hard = o.optBoolean("hard", false),
                    days = (0 until (o.optJSONArray("days")?.length() ?: 0))
                        .mapNotNull { j -> o.optJSONArray("days")?.optInt(j) },
                    once = o.optBoolean("once", false),
                )
            }
        }.getOrDefault(emptyList())
        set(value) {
            val arr = org.json.JSONArray()
            value.forEach { a ->
                arr.put(org.json.JSONObject().apply {
                    put("id", a.id); put("label", a.label); put("hhmm", a.hhmm)
                    put("enabled", a.enabled); put("hard", a.hard); put("once", a.once)
                    put("days", org.json.JSONArray(a.days))
                })
            }
            prefs.edit().putString("custom_alarms", arr.toString()).apply()
        }

    fun upsertAlarm(alarm: CustomAlarm) {
        customAlarms = customAlarms.filter { it.id != alarm.id } + alarm
    }

    fun removeAlarm(id: String) {
        customAlarms = customAlarms.filter { it.id != id }
    }

    fun alarmById(id: String): CustomAlarm? = customAlarms.find { it.id == id }

    // Alarm PIN — required to stop a `hard` alarm. Stored as SHA-256 so a
    // casual prefs dump doesn't show it (this is friction, not security).
    var alarmPinHash: String?
        get() = prefs.getString("alarm_pin_hash", null)
        set(value) = prefs.edit().putString("alarm_pin_hash", value).apply()

    fun setAlarmPin(pin: String) { alarmPinHash = sha256(pin) }
    fun checkAlarmPin(pin: String): Boolean = alarmPinHash != null && alarmPinHash == sha256(pin)

    private fun sha256(s: String): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(s.toByteArray())
            .joinToString("") { "%02x".format(it) }

    // "alarm" = loud (ringtone channel), "quiet" = silent notification.
    var wakeStyle: String
        get() = prefs.getString(KEY_WAKE_STYLE, "alarm") ?: "alarm"
        set(value) = prefs.edit().putString(KEY_WAKE_STYLE, if (value == "quiet") "quiet" else "alarm").apply()

    var sleepStyle: String
        get() = prefs.getString(KEY_SLEEP_STYLE, "quiet") ?: "quiet"
        set(value) = prefs.edit().putString(KEY_SLEEP_STYLE, if (value == "alarm") "alarm" else "quiet").apply()

    // Apps the user hid from screen time (long-press a usage bar). Hidden
    // apps are excluded from both the local dashboard and uploads.
    var ignoredPkgs: Set<String>
        get() = prefs.getStringSet(KEY_IGNORED_PKGS, emptySet()) ?: emptySet()
        set(value) = prefs.edit().putStringSet(KEY_IGNORED_PKGS, value).apply()

    var wakeRingtoneUri: String?
        get() = prefs.getString(KEY_WAKE_RINGTONE_URI, null)
        set(value) = prefs.edit().putString(KEY_WAKE_RINGTONE_URI, value).apply()

    var wakeRingtoneName: String
        get() = prefs.getString(KEY_WAKE_RINGTONE_NAME, "System alarm") ?: "System alarm"
        set(value) = prefs.edit().putString(KEY_WAKE_RINGTONE_NAME, value.ifBlank { "System alarm" }).apply()

    // Zen-blocker bounce counter, reset daily. Written by ZenWatchService,
    // read by the Activity tab.
    var blockedDate: String
        get() = prefs.getString(KEY_BLOCKED_DATE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_BLOCKED_DATE, value).apply()

    var blockedCount: Int
        get() = prefs.getInt(KEY_BLOCKED_COUNT, 0)
        set(value) = prefs.edit().putInt(KEY_BLOCKED_COUNT, value).apply()

    fun bumpBlockedToday(today: String) {
        if (blockedDate != today) { blockedDate = today; blockedCount = 0 }
        blockedCount += 1
    }

    fun blockedToday(today: String): Int = if (blockedDate == today) blockedCount else 0

    // When we last nudged the user to log an untracked gap — one nudge per gap.
    var lastGapNudgeAt: Long
        get() = prefs.getLong(KEY_LAST_GAP_NUDGE, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_GAP_NUDGE, value).apply()

    fun clearToken() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_DEVICE_ID).apply()
    }

    private fun defaultDeviceName(): String = "Android ${Build.MODEL ?: "phone"}"

    companion object {
        const val DEFAULT_API_BASE = "https://apex.yashasviallen.is-a.dev"
        private const val KEY_API_BASE = "api_base"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_AUTO_SYNC = "auto_sync"
        private const val KEY_SHARE_USAGE = "share_usage"
        private const val KEY_SHARE_APP_NAMES = "share_app_names"
        private const val KEY_BLOCKER = "blocker_enabled"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_LAST_SYNC_AT = "last_sync_at"
        private const val KEY_LAST_ROUTINE_SUMMARY = "last_routine_summary"
        private const val KEY_WAKE_ALARM_ENABLED = "wake_alarm_enabled"
        private const val KEY_SLEEP_REMINDER_ENABLED = "sleep_reminder_enabled"
        private const val KEY_WAKE_RINGTONE_URI = "wake_ringtone_uri"
        private const val KEY_WAKE_RINGTONE_NAME = "wake_ringtone_name"
        private const val KEY_BLOCKED_DATE = "blocked_date"
        private const val KEY_BLOCKED_COUNT = "blocked_count"
        private const val KEY_LAST_GAP_NUDGE = "last_gap_nudge"
        private const val KEY_WAKE_STYLE = "wake_style"
        private const val KEY_SLEEP_STYLE = "sleep_style"
        private const val KEY_LAST_WAKE_TIME = "last_wake_time"
        private const val KEY_LAST_SLEEP_TIME = "last_sleep_time"
        private const val KEY_IGNORED_PKGS = "ignored_pkgs"
    }
}

// A user-defined alarm. `days` uses ISO day numbers (1 = Monday … 7 = Sunday);
// an empty list means every day. `once` alarms disable themselves after they
// fire. `hard` alarms ignore Dismiss/Snooze and only stop on a correct PIN.
data class CustomAlarm(
    val id: String,
    val label: String,
    val hhmm: String,
    val enabled: Boolean = true,
    val hard: Boolean = false,
    val days: List<Int> = emptyList(),
    val once: Boolean = false,
)
