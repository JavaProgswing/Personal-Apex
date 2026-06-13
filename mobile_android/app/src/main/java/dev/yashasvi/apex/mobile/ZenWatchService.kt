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

// Persistent mobile focus guard. Runs as a foreground service the whole time
// the blocker is enabled (there is no push channel in this self-hosted setup,
// so the phone has to poll). Every poll tick it asks the sync API for the
// desktop's focus state; when a block is live it watches the foreground app
// every CHECK_MS and bounces / nudges distraction apps at the matching
// intensity. When idle it just keeps polling, so the NEXT desktop Zen is
// caught within ~30s instead of waiting for the app to be opened.
class ZenWatchService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var store: ApexStore

    private var focusActive = false
    private var endsAt: Long = 0
    private var title: String = "Focus"
    private var intensity: String = "strict"
    private var lastNudgeAt = 0L
    private var lastNudgePkg = ""

    private data class Enforcement(
        val bounce: Boolean,
        val bounceEveryCheck: Boolean,
        val cooldownMs: Long,
        val loud: Boolean,
        val label: String,
    )
    private fun enforcementFor(i: String): Enforcement = when (i) {
        "notify" -> Enforcement(false, false, 5 * 60_000L, false, "Focus timer")
        "relaxed" -> Enforcement(false, false, 90_000L, true, "Zen - relaxed")
        "strict" -> Enforcement(true, false, 30_000L, true, "Zen - strict")
        "locked" -> Enforcement(true, true, 15_000L, true, "Zen - locked")
        else -> Enforcement(true, false, 30_000L, true, "Zen")
    }

    private val watcher = object : Runnable {
        override fun run() {
            if (focusActive) checkForeground()
            handler.postDelayed(this, CHECK_MS)
        }
    }
    private val poller = object : Runnable {
        override fun run() {
            refreshFocus()
            // Adaptive: poll fast while a block is live (catch extends / early
            // stop within seconds), relaxed while idle (just waiting for the
            // next desktop block to start). Saves battery vs a flat fast poll.
            handler.postDelayed(this, if (focusActive) POLL_ACTIVE_MS else POLL_IDLE_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        store = ApexStore(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Guard is off when the user disabled the blocker or unpaired.
        if (!store.blockerEnabled || store.token.isNullOrBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground()
        handler.removeCallbacks(watcher); handler.post(watcher)
        handler.removeCallbacks(poller); handler.post(poller) // poll immediately
        // STICKY: a focus guard the user opted into should come back if the OS
        // kills it.
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        scope.cancel()
        super.onDestroy()
    }

    private fun ensureChannels(manager: NotificationManager) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Apex focus guard", NotificationManager.IMPORTANCE_LOW),
        )
        manager.createNotificationChannel(
            NotificationChannel(NUDGE_CHANNEL_ID, "Apex focus violations", NotificationManager.IMPORTANCE_HIGH),
        )
        manager.createNotificationChannel(
            NotificationChannel(REMIND_CHANNEL_ID, "Apex focus reminders", NotificationManager.IMPORTANCE_DEFAULT),
        )
    }

    private fun startInForeground() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannels(manager)
        val notification = guardNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(FG_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(FG_ID, notification)
        }
    }

    // The ongoing notification reflects whether a block is live right now.
    private fun guardNotification(): Notification {
        return if (focusActive) {
            val enf = enforcementFor(intensity)
            val until = if (endsAt > 0) " until ${hhmm(endsAt)}" else ""
            val what = if (enf.bounce) "Distraction apps get sent home." else "You'll get a nudge on distraction apps."
            baseBuilder(CHANNEL_ID)
                .setContentTitle("${enf.label} - $title")
                .setContentText("Desktop focus active$until. $what")
                .setOngoing(true)
                .build()
        } else {
            baseBuilder(CHANNEL_ID)
                .setContentTitle("Focus guard on")
                .setContentText("Watching for a desktop focus block.")
                .setOngoing(true)
                .build()
        }
    }

    private fun updateNotification() {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(FG_ID, guardNotification())
    }

    private fun checkForeground() {
        if (endsAt > 0 && System.currentTimeMillis() > endsAt) {
            // Block elapsed locally; stay running (idle) and let the next poll
            // confirm — but stop enforcing now.
            focusActive = false
            updateNotification()
            return
        }
        if (!WellbeingReader.hasUsageAccess(this)) return
        // Wide window so an app the user is ALREADY sitting on (its last
        // foreground event may be many minutes old) is still detected, not
        // just freshly-opened apps.
        val pkg = WellbeingReader.currentForegroundPackage(this, FG_WINDOW_MS) ?: return
        if (pkg == packageName) return
        if (WellbeingReader.categoryFor(pkg) != "distraction") return

        val enf = enforcementFor(intensity)
        val now = System.currentTimeMillis()
        val onCooldown = pkg == lastNudgePkg && now - lastNudgeAt < enf.cooldownMs

        val canOverlay = Settings.canDrawOverlays(this)
        if (enf.bounce && canOverlay && (enf.bounceEveryCheck || !onCooldown)) {
            store.bumpBlockedToday(java.time.LocalDate.now().toString())
            try {
                startActivity(Intent(Intent.ACTION_MAIN).apply {
                    addCategory(Intent.CATEGORY_HOME)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
            } catch (_: Throwable) { /* fall through to nudge */ }
        }

        if (onCooldown) return
        lastNudgePkg = pkg; lastNudgeAt = now
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val appLabel = try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (_: Exception) { pkg.substringAfterLast('.') }
        val channel = if (enf.loud) NUDGE_CHANNEL_ID else REMIND_CHANNEL_ID
        val heading = when {
            enf.bounce && canOverlay -> "Blocked: $appLabel"
            enf.bounce -> "Off track: $appLabel"
            else -> "Heads up: $appLabel"
        }
        manager.notify(NUDGE_ID, baseBuilder(channel)
            .setContentTitle(heading)
            .setContentText("Focus block running - stay with “$title”.")
            .setAutoCancel(true)
            .build())
    }

    private fun refreshFocus() {
        scope.launch {
            // Stop the guard if the user turned the blocker off / unpaired.
            if (!store.blockerEnabled || store.token.isNullOrBlank()) { stopSelf(); return@launch }
            val state = try {
                ApexApiClient(store.apiBase, tokenProvider = { store.token }).focus()
            } catch (_: Throwable) { return@launch } // offline: keep last known state

            val wasActive = focusActive
            if (state.active) {
                focusActive = true
                title = state.title ?: "Focus"
                // mode-derived: a plain focus timer (mode="timer") enforces as
                // "notify" (gentle), Zen modes as themselves. Fixes the bug
                // where every block behaved like strict.
                intensity = state.effectiveIntensity
                state.endsAt?.let { iso ->
                    val ms = runCatching { java.time.Instant.parse(iso).toEpochMilli() }
                        .getOrElse { runCatching { java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrDefault(0L) }
                    endsAt = if (ms > 0) ms else 0L
                } ?: run { endsAt = 0L }
                // A fresh block just started — enforce immediately rather than
                // waiting up to CHECK_MS.
                if (!wasActive) { updateNotification(); warnIfToothless(); checkForeground() }
                else updateNotification()
            } else if (wasActive) {
                focusActive = false
                updateNotification()
            }
        }
    }

    // When a bounce-level block (strict/locked) starts but overlay permission
    // is missing OR usage access is off, the guard can only nudge — which
    // reads as "the blocker doesn't work". Tell the user exactly what to grant,
    // with a tap target. Once per block start.
    private fun warnIfToothless() {
        val enf = enforcementFor(intensity)
        val noOverlay = enf.bounce && !Settings.canDrawOverlays(this)
        val noUsage = !WellbeingReader.hasUsageAccess(this)
        if (!noOverlay && !noUsage) return
        val (msg, intent) = when {
            noUsage -> "Grant usage access so Apex can see which app is on screen." to
                Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            else -> "Allow “display over other apps” so Apex can send distractions home." to
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:$packageName"))
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(
            this, 7404, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NUDGE_ID + 1, baseBuilder(NUDGE_CHANNEL_ID)
            .setContentTitle("Focus blocker can't enforce yet")
            .setContentText(msg)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build())
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
        private const val REMIND_CHANNEL_ID = "apex_focus_remind"
        private const val FG_ID = 7402
        private const val NUDGE_ID = 7403
        private const val CHECK_MS = 5_000L          // foreground-app scan while active
        private const val POLL_ACTIVE_MS = 10_000L   // /focus poll while a block is live
        private const val POLL_IDLE_MS = 25_000L     // /focus poll while waiting for one
        private const val FG_WINDOW_MS = 10 * 60_000L // detect already-open apps

        // Start (or keep alive) the persistent guard. No-op-ish if already
        // running — onStartCommand just re-validates. Call whenever the blocker
        // is enabled: app open, toggle, boot, periodic worker.
        fun start(context: Context) {
            val intent = Intent(context, ZenWatchService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (_: Throwable) {
                // Android 12+ can block starting a foreground service from the
                // background. The most reliable starts are app-open / boot /
                // overlay-granted; a blocked attempt just retries next tick.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, ZenWatchService::class.java))
        }
    }
}
