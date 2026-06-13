package dev.yashasvi.apex.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

// An actual alarm, not a notification ding: loops the chosen ringtone on the
// ALARM audio stream, vibrates, shows a full-screen high-priority notification
// with Dismiss / Snooze, and stops itself after a few minutes if ignored.
class AlarmRingService : Service() {
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private val handler = Handler(Looper.getMainLooper())
    private var currentKind: String = "wake_alarm"
    // Unanswered for the full ring window → snooze once automatically (you
    // were probably asleep), instead of going silent forever. A second
    // unanswered ring gives up with a "missed alarm" notification.
    private val autoStop = Runnable {
        val store = ApexStore(this)
        if (hardAlarmFor(currentKind) != null) {
            // Hard alarms never give up: 3 min ringing, 2 min of silence,
            // ring again — forever, until the PIN stops it (or the phone is
            // powered off). The gap keeps the speaker + battery alive.
            RoutineAlarmScheduler.snooze(this, currentKind, 2)
            stopRinging("hard re-ring cycle")
            return@Runnable
        }
        val recentAutoSnooze =
            System.currentTimeMillis() - store.lastAutoSnoozeAt < 25 * 60_000L
        if (recentAutoSnooze) {
            postMissedNotification(currentKind)
        } else {
            store.lastAutoSnoozeAt = System.currentTimeMillis()
            RoutineAlarmScheduler.snooze(this, currentKind, 10)
            postMissedNotification(currentKind, snoozed = true)
        }
        stopRinging("timed out")
    }

    // Non-null when `kind` is a custom alarm flagged hard (PIN-locked).
    private fun hardAlarmFor(kind: String?): CustomAlarm? {
        if (kind == null || !kind.startsWith(RoutineAlarmScheduler.CUSTOM_PREFIX)) return null
        return ApexStore(this).alarmById(kind.removePrefix(RoutineAlarmScheduler.CUSTOM_PREFIX))
            ?.takeIf { it.hard }
    }

    private fun customAlarmFor(kind: String?): CustomAlarm? {
        if (kind == null || !kind.startsWith(RoutineAlarmScheduler.CUSTOM_PREFIX)) return null
        return ApexStore(this).alarmById(kind.removePrefix(RoutineAlarmScheduler.CUSTOM_PREFIX))
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Hard (PIN-locked) alarms ignore every stop verb unless the intent
        // carries the PIN-verified flag set by the in-app unlock screen.
        val actionKind = intent?.getStringExtra(EXTRA_KIND) ?: currentKind
        val pinLocked = hardAlarmFor(actionKind) != null && intent?.getBooleanExtra(EXTRA_PIN_OK, false) != true
        when (intent?.action) {
            ACTION_DISMISS, ACTION_SNOOZE, ACTION_AWAKE -> if (pinLocked) return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_DISMISS -> { stopRinging("dismissed"); return START_NOT_STICKY }
            ACTION_AWAKE -> {
                // Mark the routine done on the sync API — suppresses the
                // reminder everywhere and lets the desktop fire its morning
                // brief when it next pulls.
                val kind = intent.getStringExtra(EXTRA_KIND) ?: "wake_alarm"
                val event = if (kind == "sleep_reminder") "sleep_done" else "wake_done"
                val store = ApexStore(this)
                Thread {
                    runCatching {
                        kotlinx.coroutines.runBlocking {
                            ApexApiClient(store.apiBase, tokenProvider = { store.token }).markEvent(event)
                        }
                    }
                }.start()
                stopRinging("awake")
                return START_NOT_STICKY
            }
            ACTION_SNOOZE -> {
                val kind = intent.getStringExtra(EXTRA_KIND) ?: "wake_alarm"
                RoutineAlarmScheduler.snooze(this, kind, 10)
                stopRinging("snoozed 10 min")
                return START_NOT_STICKY
            }
        }
        val kind = intent?.getStringExtra(EXTRA_KIND) ?: "wake_alarm"
        currentKind = kind
        ringingKind = kind
        startInForeground(kind)
        startRinging()
        handler.removeCallbacks(autoStop)
        handler.postDelayed(autoStop, RING_FOR_MS)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        ringingKind = null
        handler.removeCallbacksAndMessages(null)
        releasePlayer()
        super.onDestroy()
    }

    private fun startInForeground(kind: String) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Apex ringing alarm", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "The actively ringing Apex alarm"
                    setSound(null, null) // the service plays audio itself
                    enableVibration(false)
                    setBypassDnd(true)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                },
            )
        }
        val isSleep = kind == "sleep_reminder"
        val fullScreen = PendingIntent.getActivity(
            this, 7501,
            Intent(this, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_FROM_ALARM, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        fun action(actionStr: String, title: String, req: Int): Notification.Action {
            val pi = PendingIntent.getService(
                this, req,
                Intent(this, AlarmRingService::class.java).setAction(actionStr).putExtra(EXTRA_KIND, kind),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            return Notification.Action.Builder(null, title, pi).build()
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        val custom = customAlarmFor(kind)
        val hard = custom?.hard == true
        val title = custom?.label ?: if (isSleep) "Sleep alarm" else "Wake up"
        val text = when {
            hard -> "Locked alarm - open Apex and enter your PIN to stop it."
            custom != null -> "Rings 3 min, then snoozes itself."
            isSleep -> "Time to wind down.  Rings 3 min, then snoozes itself."
            else -> "Good morning - rise and shine.  Rings 3 min, then snoozes itself."
        }
        builder
            .setSmallIcon(R.drawable.ic_stat_alarm)
            .setColor((if (hard) 0xFFE5675C else 0xFF38D8C4).toInt())
            .setContentTitle(title)
            .setContentText(text)
            .setCategory(Notification.CATEGORY_ALARM)
            .setOngoing(true)
            .setShowWhen(true)
            .setFullScreenIntent(fullScreen, true)
        if (!hard) {
            // A hard alarm gets NO stop verbs in the shade — the only way out
            // is the in-app PIN screen (the full-screen intent opens it).
            builder
                .addAction(action(ACTION_SNOOZE, "Snooze 10", 7502))
                .addAction(action(ACTION_DISMISS, "Dismiss", 7503))
                .addAction(action(ACTION_AWAKE, if (isSleep) "Going to bed" else "I'm awake", 7504))
        }
        val notification = builder.build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(FG_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(FG_ID, notification)
        }
    }

    private fun startRinging() {
        if (player?.isPlaying == true) return
        val store = ApexStore(this)
        val uri: Uri = store.wakeRingtoneUri?.let { runCatching { Uri.parse(it) }.getOrNull() }
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        try {
            player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                setDataSource(this@AlarmRingService, uri)
                isLooping = true
                prepare()
                start()
            }
        } catch (_: Throwable) {
            // Broken/unreadable ringtone URI — fall back to the system default.
            runCatching {
                player = MediaPlayer.create(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))
                player?.isLooping = true
                player?.start()
            }
        }
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION") getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        runCatching {
            vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 500), 0))
        }
    }

    private fun stopRinging(reason: String) {
        ringingKind = null
        releasePlayer()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // Quiet trace of an unanswered alarm — so an auto-snoozed or missed
    // wake-up is visible in the shade instead of vanishing silently.
    private fun postMissedNotification(kind: String, snoozed: Boolean = false) {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(MISSED_CHANNEL_ID, "Missed alarms", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    setSound(null, null)
                },
            )
        }
        val open = PendingIntent.getActivity(
            this, 7506,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val isSleep = kind == "sleep_reminder"
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, MISSED_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        manager.notify(
            FG_ID + 1,
            builder
                .setSmallIcon(R.drawable.ic_stat_alarm)
                .setColor(0xFFF5B84B.toInt())
                .setContentTitle(if (isSleep) "Sleep alarm unanswered" else "Wake alarm unanswered")
                .setContentText(
                    if (snoozed) "Rang for 3 minutes - ringing again in 10."
                    else "Rang twice with no answer. Giving up until tomorrow.",
                )
                .setContentIntent(open)
                .setAutoCancel(true)
                .build(),
        )
    }

    private fun releasePlayer() {
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
        runCatching { vibrator?.cancel() }
        vibrator = null
    }

    companion object {
        private const val CHANNEL_ID = "apex_ring"
        private const val MISSED_CHANNEL_ID = "apex_missed_alarm"
        private const val FG_ID = 7500
        private const val RING_FOR_MS = 3 * 60_000L

        // Which alarm kind is ringing RIGHT NOW (null = silent). MainActivity
        // polls this to show its in-app dismiss overlay — the fix for "alarm
        // rings, full-screen activity covers the notification, and there is
        // no button anywhere to stop it".
        @Volatile var ringingKind: String? = null
            internal set
        const val ACTION_DISMISS = "dev.yashasvi.apex.mobile.ALARM_DISMISS"
        const val ACTION_SNOOZE = "dev.yashasvi.apex.mobile.ALARM_SNOOZE"
        const val ACTION_AWAKE = "dev.yashasvi.apex.mobile.ALARM_AWAKE"
        const val EXTRA_KIND = "kind"
        // Set by MainActivity after a correct PIN — the only way a hard
        // alarm accepts a stop verb.
        const val EXTRA_PIN_OK = "pin_ok"

        fun ring(context: Context, kind: String) {
            val intent = Intent(context, AlarmRingService::class.java).putExtra(EXTRA_KIND, kind)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
