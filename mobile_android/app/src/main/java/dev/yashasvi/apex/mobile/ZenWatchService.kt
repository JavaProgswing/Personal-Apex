package dev.yashasvi.apex.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
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
        if (intent?.action == ACTION_STOP_FOCUS) {
            startInForeground()
            stopFocusFromNotification()
            return START_STICKY
        }
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
        hideBlockOverlay()
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
            val what = if (enf.bounce) "Distraction apps are blocked." else "Distraction apps send nudges."
            baseBuilder(CHANNEL_ID)
                .setContentTitle("${enf.label} - $title")
                .setContentText("Desktop focus active$until. $what")
                .setOngoing(true)
                .addAction(stopAction())
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
            hideBlockOverlay()
            updateNotification()
            return
        }
        if (!WellbeingReader.hasUsageAccess(this)) return
        // Wide window so an app the user is ALREADY sitting on (its last
        // foreground event may be many minutes old) is still detected, not
        // just freshly-opened apps.
        val pkg = WellbeingReader.currentForegroundPackage(this, FG_WINDOW_MS)
        // Not on a distraction app (or back in Apex) → tear the overlay down.
        if (pkg == null || pkg == packageName || WellbeingReader.categoryFor(pkg) != "distraction") {
            hideBlockOverlay()
            return
        }

        val enf = enforcementFor(intensity)
        val now = System.currentTimeMillis()
        val appLabel = try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (_: Exception) { pkg.substringAfterLast('.') }

        if (enf.bounce) {
            // The reliable enforcement: a full-screen overlay covering the
            // distraction app. startActivity(HOME) is silently denied from a
            // background service on aggressive OEMs (ColorOS/MIUI etc.) — the
            // overlay always renders because SYSTEM_ALERT_WINDOW is granted.
            if (Settings.canDrawOverlays(this)) {
                store.bumpBlockedToday(java.time.LocalDate.now().toString())
                showBlockOverlay(appLabel, enf.label, locked = enf.bounceEveryCheck)
                return // overlay IS the nudge; no need for a notification too
            }
            // Best-effort legacy bounce when overlay isn't granted (works on
            // lenient OEMs); falls through to the notification below.
            try {
                startActivity(Intent(Intent.ACTION_MAIN).apply {
                    addCategory(Intent.CATEGORY_HOME)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                })
            } catch (_: Throwable) { /* fall through to nudge */ }
        }

        val onCooldown = pkg == lastNudgePkg && now - lastNudgeAt < enf.cooldownMs
        if (onCooldown) return
        lastNudgePkg = pkg; lastNudgeAt = now
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = if (enf.loud) NUDGE_CHANNEL_ID else REMIND_CHANNEL_ID
        val heading = if (enf.bounce) "Off track: $appLabel" else "Heads up: $appLabel"
        manager.notify(NUDGE_ID, baseBuilder(channel)
            .setContentTitle(heading)
            .setContentText("Focus block running - stay with \"$title\".")
            .addAction(stopAction(7407))
            .setAutoCancel(true)
            .build())
    }

    // ── full-screen block overlay ────────────────────────────────────────────
    // Drawn over the distraction app via TYPE_APPLICATION_OVERLAY. Unlike a
    // background activity start, this is permitted from the background once
    // SYSTEM_ALERT_WINDOW is granted — so it actually works on locked-down
    // OEMs. Rebuilt only when the blocked app changes (avoids flicker).
    private var blockOverlay: View? = null
    private var overlayForApp: String = ""

    private fun showBlockOverlay(appLabel: String, modeLabel: String, locked: Boolean) {
        if (blockOverlay != null && overlayForApp == appLabel) return // already up for this app
        hideBlockOverlay()
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#F20B0D12"))
            setPadding(dp(32), dp(32), dp(32), dp(32))
            isClickable = true // swallow taps so the app behind stays unusable
        }
        root.addView(TextView(this).apply {
            text = "APEX GUARD"
            setTextColor(Color.parseColor("#38D8C4"))
            textSize = 14f
            letterSpacing = 0.22f
            gravity = Gravity.CENTER
        })
        root.addView(TextView(this).apply {
            text = modeLabel.uppercase()
            setTextColor(Color.parseColor("#38D8C4"))
            textSize = 13f
            letterSpacing = 0.18f
            gravity = Gravity.CENTER
            setPadding(0, dp(14), 0, dp(6))
        })
        root.addView(TextView(this).apply {
            text = "$appLabel is blocked"
            setTextColor(Color.parseColor("#F4F7FB"))
            textSize = 23f
            gravity = Gravity.CENTER
        })
        root.addView(TextView(this).apply {
            text = if (locked) "Locked focus - stay with \"$title\"." else "Focus block running - back to \"$title\"."
            setTextColor(Color.parseColor("#9AA8BA"))
            textSize = 14f
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(8), dp(16), dp(24))
        })
        root.addView(Button(this).apply {
            text = "Leave and refocus"
            setOnClickListener {
                hideBlockOverlay()
                try {
                    startActivity(Intent(Intent.ACTION_MAIN).apply {
                        addCategory(Intent.CATEGORY_HOME)
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    })
                } catch (_: Throwable) {}
            }
        })
        if (!locked) {
            root.addView(TextView(this).apply {
                text = "Need it for a minute? Press Home. Apex will nudge if you linger."
                setTextColor(Color.parseColor("#667385"))
                textSize = 11.5f
                gravity = Gravity.CENTER
                setPadding(dp(16), dp(14), dp(16), 0)
            })
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT,
        )
        runCatching {
            wm.addView(root, params)
            blockOverlay = root
            overlayForApp = appLabel
        }
    }

    private fun hideBlockOverlay() {
        val v = blockOverlay ?: return
        blockOverlay = null
        overlayForApp = ""
        runCatching { (getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(v) }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

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
                hideBlockOverlay()
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
            else -> "Allow display over other apps so Apex can send distractions home." to
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

    private fun stopFocusFromNotification() {
        scope.launch {
            runCatching { ApexApiClient(store.apiBase, tokenProvider = { store.token }).stopFocus() }
            focusActive = false
            hideBlockOverlay()
            updateNotification()
        }
    }

    private fun stopAction(requestCode: Int = 7405): Notification.Action {
        val pi = PendingIntent.getService(
            this, requestCode,
            Intent(this, ZenWatchService::class.java).setAction(ACTION_STOP_FOCUS),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Action.Builder(null, "Stop focus", pi).build()
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
        return b
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setColor(Color.parseColor("#38D8C4"))
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
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
        private const val ACTION_STOP_FOCUS = "dev.yashasvi.apex.mobile.STOP_FOCUS"

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
