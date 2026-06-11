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
    private val autoStop = Runnable { stopRinging("timed out") }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
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
        startInForeground(kind)
        startRinging()
        handler.removeCallbacks(autoStop)
        handler.postDelayed(autoStop, RING_FOR_MS)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
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
        val notification = builder
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle(if (isSleep) "Sleep alarm" else "Wake up")
            .setContentText(if (isSleep) "Time to wind down." else "Good morning — rise and shine.")
            .setCategory(Notification.CATEGORY_ALARM)
            .setOngoing(true)
            .setFullScreenIntent(fullScreen, true)
            .addAction(action(ACTION_SNOOZE, "Snooze 10", 7502))
            .addAction(action(ACTION_DISMISS, "Dismiss", 7503))
            .addAction(action(ACTION_AWAKE, if (isSleep) "Going to bed ✓" else "I'm awake ✓", 7504))
            .build()
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
        releasePlayer()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
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
        private const val FG_ID = 7500
        private const val RING_FOR_MS = 3 * 60_000L
        const val ACTION_DISMISS = "dev.yashasvi.apex.mobile.ALARM_DISMISS"
        const val ACTION_SNOOZE = "dev.yashasvi.apex.mobile.ALARM_SNOOZE"
        const val ACTION_AWAKE = "dev.yashasvi.apex.mobile.ALARM_AWAKE"
        const val EXTRA_KIND = "kind"

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
