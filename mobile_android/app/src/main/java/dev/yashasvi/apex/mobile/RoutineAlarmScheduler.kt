package dev.yashasvi.apex.mobile

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import java.time.LocalTime
import java.time.ZonedDateTime

const val APEX_ALARM_ACTION = "dev.yashasvi.apex.mobile.ROUTINE_ALARM"
const val EXTRA_ROUTINE_KIND = "routine_kind"
private const val REQ_WAKE_ALARM = 7101
private const val REQ_SLEEP_REMINDER = 7102
private const val REQ_SNOOZE = 7103

object RoutineAlarmScheduler {
    fun scheduleWakeAndSleep(context: Context, routine: ApexRoutine) {
        scheduleConfigured(context, routine)
    }

    fun scheduleConfigured(context: Context, routine: ApexRoutine) {
        val store = ApexStore(context)
        // Persist the times so the fired receiver can reschedule tomorrow's
        // alarm without the app being opened or the network being up.
        store.lastWakeTime = routine.wakeTime
        store.lastSleepTime = routine.sleepTime
        if (store.wakeAlarmEnabled && !routine.wakeTime.isNullOrBlank()) {
            scheduleDaily(context, "wake_alarm", routine.wakeTime, REQ_WAKE_ALARM)
        } else {
            cancelDaily(context, "wake_alarm", REQ_WAKE_ALARM)
        }

        if (store.sleepReminderEnabled && !routine.sleepTime.isNullOrBlank()) {
            scheduleDaily(context, "sleep_reminder", routine.sleepTime, REQ_SLEEP_REMINDER)
        } else {
            cancelDaily(context, "sleep_reminder", REQ_SLEEP_REMINDER)
        }
        scheduleCustomAlarms(context)
    }

    // Called by the receiver after an alarm fires: arm the same alarm for its
    // next occurrence (times persisted in ApexStore).
    fun rescheduleAfterFire(context: Context, kind: String) {
        val store = ApexStore(context)
        if (kind == "wake_alarm" && store.wakeAlarmEnabled) {
            store.lastWakeTime?.let { scheduleDaily(context, kind, it, REQ_WAKE_ALARM) }
        }
        if (kind == "sleep_reminder" && store.sleepReminderEnabled) {
            store.lastSleepTime?.let { scheduleDaily(context, kind, it, REQ_SLEEP_REMINDER) }
        }
        if (kind.startsWith(CUSTOM_PREFIX)) {
            val id = kind.removePrefix(CUSTOM_PREFIX)
            val alarm = store.alarmById(id) ?: return
            if (alarm.once) {
                // One-shot: disable instead of delete, so it stays in the list
                // ready to re-arm.
                store.upsertAlarm(alarm.copy(enabled = false))
            } else if (alarm.enabled) {
                scheduleCustom(context, alarm)
            }
        }
    }

    // ── custom alarms ──────────────────────────────────────────────────────
    const val CUSTOM_PREFIX = "custom:"

    private fun customRequestCode(id: String): Int = 0x7C00000 or (id.hashCode() and 0xFFFF)

    fun scheduleCustomAlarms(context: Context) {
        ApexStore(context).customAlarms.forEach { alarm ->
            if (alarm.enabled) scheduleCustom(context, alarm) else cancelCustom(context, alarm.id)
        }
    }

    fun scheduleCustom(context: Context, alarm: CustomAlarm) {
        scheduleDaily(
            context,
            CUSTOM_PREFIX + alarm.id,
            alarm.hhmm,
            customRequestCode(alarm.id),
            alarm.days,
        )
    }

    fun cancelCustom(context: Context, id: String) {
        cancelDaily(context, CUSTOM_PREFIX + id, customRequestCode(id))
    }

    // Human summary for the alarm list: "daily", "Mon Wed Fri", "once".
    fun describeDays(alarm: CustomAlarm): String = when {
        alarm.once -> "once"
        alarm.days.isEmpty() || alarm.days.size == 7 -> "daily"
        else -> alarm.days.sorted().joinToString(" ") {
            java.time.DayOfWeek.of(it).name.take(3).lowercase().replaceFirstChar(Char::uppercase)
        }
    }

    // Re-arm the same kind N minutes from now (snooze button on the ringing
    // alarm). Request code derives from the kind so concurrent snoozes of
    // different alarms can't cancel each other; offset from the daily codes
    // so a snooze can't replace the standing schedule.
    fun snooze(context: Context, kind: String, minutes: Int) {
        val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val req = REQ_SNOOZE xor (kind.hashCode() and 0x7FFF)
        val intent = Intent(context, RoutineAlarmReceiver::class.java)
            .setAction(APEX_ALARM_ACTION)
            .putExtra(EXTRA_ROUTINE_KIND, kind)
        val pending = PendingIntent.getBroadcast(
            context, req,
            intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val at = System.currentTimeMillis() + minutes * 60_000L
        // Snoozes ride setAlarmClock too — a snoozed wake-up that fires 40
        // minutes late defeats the point.
        val show = PendingIntent.getActivity(
            context, req + 100,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        alarm.setAlarmClock(AlarmManager.AlarmClockInfo(at, show), pending)
    }

    private fun scheduleDaily(context: Context, kind: String, hhmm: String, requestCode: Int, days: List<Int> = emptyList()) {
        val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val target = nextOccurrence(hhmm, days)
        val intent = Intent(context, RoutineAlarmReceiver::class.java)
            .setAction(APEX_ALARM_ACTION)
            .putExtra(EXTRA_ROUTINE_KIND, kind)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getBroadcast(context, requestCode, intent, flags)

        // setAlarmClock(): the one alarm API that is always exact, fires
        // through Doze, and survives OEM windowing heuristics (the plain
        // exact path was being widened to a 1-hour window on this ROM).
        // Loud vs quiet is decided at fire time, not here.
        val show = PendingIntent.getActivity(
            context, requestCode + 100,
            Intent(context, MainActivity::class.java),
            flags,
        )
        alarm.setAlarmClock(
            AlarmManager.AlarmClockInfo(target.toInstant().toEpochMilli(), show),
            pending,
        )
    }

    private fun cancelDaily(context: Context, kind: String, requestCode: Int) {
        val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(context, RoutineAlarmReceiver::class.java)
            .setAction(APEX_ALARM_ACTION)
            .putExtra(EXTRA_ROUTINE_KIND, kind)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pending = PendingIntent.getBroadcast(context, requestCode, intent, flags)
        alarm.cancel(pending)
    }

    // Next occurrence of hh:mm, optionally restricted to ISO weekdays
    // (1 = Monday … 7 = Sunday). Empty list = any day.
    private fun nextOccurrence(hhmm: String, days: List<Int> = emptyList()): ZonedDateTime {
        val parts = hhmm.split(":")
        val localTime = LocalTime.of(
            parts.getOrNull(0)?.toIntOrNull() ?: 7,
            parts.getOrNull(1)?.toIntOrNull() ?: 0,
        )
        var target = ZonedDateTime.now()
            .withHour(localTime.hour)
            .withMinute(localTime.minute)
            .withSecond(0)
            .withNano(0)
        if (!target.isAfter(ZonedDateTime.now())) target = target.plusDays(1)
        if (days.isNotEmpty()) {
            var guard = 0
            while (target.dayOfWeek.value !in days && guard++ < 8) target = target.plusDays(1)
        }
        return target
    }
}

class RoutineAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != APEX_ALARM_ACTION) return
        val kind = intent.getStringExtra(EXTRA_ROUTINE_KIND) ?: return
        // Arm tomorrow's occurrence first — alarms must survive the app never
        // being reopened.
        RoutineAlarmScheduler.rescheduleAfterFire(context, kind)
        val store = ApexStore(context)
        val loud = when {
            // Custom alarms are always real alarms — quiet ones are what the
            // sync-API reminders already cover.
            kind.startsWith(RoutineAlarmScheduler.CUSTOM_PREFIX) -> true
            kind == "sleep_reminder" -> store.sleepStyle == "alarm"
            else -> store.wakeStyle == "alarm"
        }
        if (loud) {
            // Real alarm: looping ringtone + vibration + full-screen notification.
            AlarmRingService.ring(context, kind)
        } else {
            RoutineNotificationBridge.showRoutineNotification(context, kind)
        }
    }
}

object RoutineNotificationBridge {
    private const val SLEEP_CHANNEL_ID = "apex_sleep_quiet"

    fun showRoutineNotification(context: Context, kind: String) {
        val store = ApexStore(context)
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val wakeSound = store.wakeRingtoneUri?.let { runCatching { Uri.parse(it) }.getOrNull() }
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        val isSleep = kind == "sleep_reminder"
        // Each can be a loud alarm or a quiet reminder — user picks per row.
        val loud = if (isSleep) store.sleepStyle == "alarm" else store.wakeStyle == "alarm"
        val channelId = if (loud) {
            "apex_loud_${wakeSound.toString().hashCode().toString().replace("-", "n")}"
        } else {
            SLEEP_CHANNEL_ID
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = if (!loud) {
                NotificationChannel(
                    channelId,
                    "Apex quiet reminders",
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = "Silent routine reminders from Apex Mobile"
                    setSound(null, null)
                    enableVibration(false)
                }
            } else {
                NotificationChannel(
                    channelId,
                    "Apex alarms",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    description = "Loud routine alarms from Apex Mobile"
                    setSound(
                        wakeSound,
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                    enableVibration(true)
                }
            }
            manager.createNotificationChannel(channel)
        }

        val openIntent = Intent(context, MainActivity::class.java)
        val pending = PendingIntent.getActivity(
            context,
            7201,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val title = if (isSleep) "Wind down" else "Wake up"
        val body = if (isSleep) {
            "Wrap up and get offline."
        } else {
            "Good morning. Open Apex for today's plan."
        }

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(context, channelId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(context).apply {
                if (loud) setSound(wakeSound) else setSound(null)
            }
        }

        val notification = builder
            .setSmallIcon(R.drawable.ic_stat_alarm)
            .setColor(0xFF38D8C4.toInt())
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .build()

        manager.notify(if (isSleep) REQ_SLEEP_REMINDER else REQ_WAKE_ALARM, notification)
    }
}
