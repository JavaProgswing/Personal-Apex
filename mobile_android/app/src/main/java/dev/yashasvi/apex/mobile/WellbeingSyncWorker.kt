package dev.yashasvi.apex.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.time.Instant
import java.util.concurrent.TimeUnit

// Battery-friendly background sync, every ~30 minutes while online. Pushes
// usage, mirrors desktop Zen state for the blocker, and nudges the user to
// log untracked gaps so the day's record stays complete.
class WellbeingSyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val store = ApexStore(applicationContext)
        val token = store.token
        if (token.isNullOrBlank()) return Result.success() // not paired - nothing to do
        val client = ApexApiClient(store.apiBase, tokenProvider = { store.token })

        // Even when usage sharing is off, keep mirroring the desktop's focus
        // state so the Zen blocker still works in the background.
        try {
            val focus = client.focus()
            if (focus.active && store.blockerEnabled) {
                ZenWatchService.start(applicationContext, focus.title, focus.endsAt, focus.intensity)
            }
        } catch (_: Throwable) { /* offline - fine */ }

        if (!store.shareUsage) return Result.success()
        if (!WellbeingReader.hasUsageAccess(applicationContext)) {
            // Permission revoked; retry later rather than failing hard.
            return Result.retry()
        }
        return try {
            var sessions = WellbeingReader.readToday(applicationContext)
            if (!store.shareAppNames) sessions = sessions.map { it.copy(appName = null) }
            if (sessions.isNotEmpty()) {
                client.pushWellbeing(sessions, store.deviceId)
                store.lastSyncAt = Instant.now().toString()
            }
            maybeNudgeGapLog(sessions)
            Result.success()
        } catch (_: Throwable) {
            Result.retry()
        }
    }

    // If the phone saw no foreground use for 3+ hours during waking hours,
    // the user was probably away from screens — ask them to log what the
    // block was (gym, class, sleep, …) so the day's record has no holes.
    private fun maybeNudgeGapLog(sessions: List<WellbeingSession>) {
        val store = ApexStore(applicationContext)
        val now = System.currentTimeMillis()
        val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
        if (hour < 9 || hour > 23) return
        val latestEnd = sessions.mapNotNull { s ->
            s.endedAt?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }
        }.maxOrNull() ?: return
        val gapMs = now - latestEnd
        if (gapMs < GAP_MS) return
        // One nudge per gap: skip if we already asked for this window.
        if (store.lastGapNudgeAt > latestEnd) return
        store.lastGapNudgeAt = now

        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Apex gap log", NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        val fmt = java.text.SimpleDateFormat("HH:mm", java.util.Locale.US)
        val rangeText = "${fmt.format(java.util.Date(latestEnd))}–${fmt.format(java.util.Date(now))}"
        val open = PendingIntent.getActivity(
            applicationContext, 7601,
            Intent(applicationContext, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_GAP_START, latestEnd)
                .putExtra(MainActivity.EXTRA_GAP_END, now)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(applicationContext, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(applicationContext)
        }
        manager.notify(GAP_ID, builder
            .setSmallIcon(android.R.drawable.ic_menu_recent_history)
            .setContentTitle("What were you up to? ($rangeText)")
            .setContentText("No screen time for a while — tap to log it so today's record is complete.")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build())
    }

    companion object {
        private const val UNIQUE_NAME = "apex-wellbeing-sync"
        private const val CHANNEL_ID = "apex_gaplog"
        private const val GAP_ID = 7602
        private const val GAP_MS = 3 * 60 * 60_000L

        fun enqueue(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = PeriodicWorkRequestBuilder<WellbeingSyncWorker>(30, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                request,
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(UNIQUE_NAME)
        }
    }
}
