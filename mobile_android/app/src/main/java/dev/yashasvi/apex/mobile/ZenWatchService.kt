package dev.yashasvi.apex.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

// Mobile mirror of desktop Zen mode. While the desktop reports an active
// focus block (GET /focus), this foreground service watches the phone's
// foreground app every few seconds. Distraction apps get bounced back to the
// home screen (when "draw over apps" is granted) or a loud nudge notification
// otherwise. Stops itself when the block ends or the desktop calls it off.
class ZenWatchService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var store: ApexStore
    private var endsAt: Long = 0
    private var title: String = "Focus"
    private var lastNudgeAt = 0L
    private var lastNudgePkg = ""

    private val watcher = object : Runnable {
        override fun run() {
            checkForeground()
            handler.postDelayed(this, CHECK_MS)
        }
    }
    private val refetcher = object : Runnable {
        override fun run() {
            refreshFocus()
            handler.postDelayed(this, REFRESH_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        store = ApexStore(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        title = intent?.getStringExtra(EXTRA_TITLE) ?: "Focus"
        endsAt = intent?.getLongExtra(EXTRA_ENDS_AT, 0L) ?: 0L
        startInForeground()
        handler.removeCallbacks(watcher); handler.post(watcher)
        handler.removeCallbacks(refetcher); handler.postDelayed(refetcher, REFRESH_MS)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        scope.cancel()
        super.onDestroy()
    }

    private fun startInForeground() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Apex focus blocker", NotificationManager.IMPORTANCE_LOW),
            )
            manager.createNotificationChannel(
                NotificationChannel(NUDGE_CHANNEL_ID, "Apex focus violations", NotificationManager.IMPORTANCE_HIGH),
            )
        }
        val until = if (endsAt > 0) " until ${hhmm(endsAt)}" else ""
        val notification = baseBuilder(CHANNEL_ID)
            .setContentTitle("Zen mode - $title")
            .setContentText("Desktop focus active$until. Distraction apps are blocked.")
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(FG_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(FG_ID, notification)
        }
    }

    private fun checkForeground() {
        if (endsAt > 0 && System.currentTimeMillis() > endsAt) { stopSelf(); return }
        if (!WellbeingReader.hasUsageAccess(this)) return
        val pkg = WellbeingReader.currentForegroundPackage(this) ?: return
        if (pkg == packageName) return
        if (WellbeingReader.categoryFor(pkg) != "distraction") return

        store.bumpBlockedToday(java.time.LocalDate.now().toString())
        val canOverlay = Settings.canDrawOverlays(this)
        if (canOverlay) {
            // Bounce to the home screen - the actual "block".
            try {
                startActivity(Intent(Intent.ACTION_MAIN).apply {
                    addCategory(Intent.CATEGORY_HOME)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
            } catch (_: Throwable) { /* fall through to nudge */ }
        }
        val now = System.currentTimeMillis()
        if (pkg == lastNudgePkg && now - lastNudgeAt < NUDGE_COOLDOWN_MS) return
        lastNudgePkg = pkg; lastNudgeAt = now
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val appLabel = try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (_: Exception) { pkg.substringAfterLast('.') }
        manager.notify(NUDGE_ID, baseBuilder(NUDGE_CHANNEL_ID)
            .setContentTitle(if (canOverlay) "Blocked: $appLabel" else "Zen drift: $appLabel")
            .setContentText("Desktop focus block is running - stay with “$title”.")
            .setAutoCancel(true)
            .build())
    }

    private fun refreshFocus() {
        scope.launch {
            val state = try {
                ApexApiClient(store.apiBase, tokenProvider = { store.token }).focus()
            } catch (_: Throwable) { return@launch } // offline: keep local timer
            if (!state.active) stopSelf()
        }
    }

    private fun baseBuilder(channel: String): Notification.Builder {
        val open = PendingIntent.getActivity(
            this, 7401, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, channel)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        return b.setSmallIcon(android.R.drawable.ic_lock_idle_lock).setContentIntent(open)
    }

    private fun hhmm(ms: Long): String {
        val c = java.util.Calendar.getInstance().apply { timeInMillis = ms }
        return String.format("%02d:%02d", c.get(java.util.Calendar.HOUR_OF_DAY), c.get(java.util.Calendar.MINUTE))
    }

    companion object {
        private const val CHANNEL_ID = "apex_zen_watch"
        private const val NUDGE_CHANNEL_ID = "apex_zen_nudge"
        private const val FG_ID = 7402
        private const val NUDGE_ID = 7403
        private const val CHECK_MS = 5_000L
        private const val REFRESH_MS = 120_000L
        private const val NUDGE_COOLDOWN_MS = 30_000L
        const val EXTRA_TITLE = "title"
        const val EXTRA_ENDS_AT = "ends_at"

        fun start(context: Context, title: String?, endsAtIso: String?) {
            val endsAt = try {
                endsAtIso?.let { java.time.Instant.parse(it).toEpochMilli() } ?: 0L
            } catch (_: Exception) {
                // ends_at may carry a timezone offset rather than Z.
                try { java.time.OffsetDateTime.parse(endsAtIso).toInstant().toEpochMilli() } catch (_: Exception) { 0L }
            }
            val intent = Intent(context, ZenWatchService::class.java)
                .putExtra(EXTRA_TITLE, title ?: "Focus")
                .putExtra(EXTRA_ENDS_AT, endsAt)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ZenWatchService::class.java))
        }
    }
}
