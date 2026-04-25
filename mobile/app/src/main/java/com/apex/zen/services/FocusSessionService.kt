package com.apex.zen.services

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.apex.zen.MainActivity
import com.apex.zen.R
import com.apex.zen.data.FocusSession
import com.apex.zen.data.ZenDatabase
import com.apex.zen.session.SessionState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Foreground service that keeps a focus session alive while the screen is off
 * or the app is backgrounded. It:
 *   - posts a sticky notification with a countdown
 *   - ticks every ~10s to update the notification
 *   - writes the FocusSession row when the session ends (natural or abort)
 *
 * The notification is "persistent" (ongoing) so the user can't swipe it away
 * while focus is running — this is a feature, not a bug. Seeing the timer
 * bar while scrolling another app helps make the session real.
 */
class FocusSessionService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var tickJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        when (action) {
            ACTION_START -> {
                val durationMin = intent.getIntExtra(EXTRA_DURATION_MIN, 25)
                val label = intent.getStringExtra(EXTRA_LABEL)
                startSession(durationMin, label)
            }
            ACTION_STOP -> {
                stopSession(completed = false)
            }
            else -> {
                // Service recreated by system — just recover from DB.
                scope.launch { recover() }
            }
        }
        return START_STICKY
    }

    private fun startSession(durationMin: Int, label: String?) {
        val now = System.currentTimeMillis()
        val endsAt = now + durationMin * 60_000L

        scope.launch {
            val db = ZenDatabase.get(applicationContext)
            val id = db.focusSessions().insert(
                FocusSession(
                    startedAt = now,
                    plannedEndAt = endsAt,
                    endedAt = null,
                    completed = false,
                    label = label,
                    blockedCount = 0,
                    syncedAt = null,
                )
            )
            SessionState.begin(id, now, endsAt, label)
            startInForegroundCompat(buildNotification(endsAt, label))
            scheduleTicks(endsAt, label)
        }
    }

    private fun stopSession(completed: Boolean) {
        tickJob?.cancel()
        val snapshot = SessionState.activeSession.value
        SessionState.clear()
        scope.launch {
            if (snapshot != null) {
                val db = ZenDatabase.get(applicationContext)
                db.focusSessions().update(
                    FocusSession(
                        id = snapshot.id,
                        startedAt = snapshot.startedAt,
                        plannedEndAt = snapshot.endsAt,
                        endedAt = System.currentTimeMillis(),
                        completed = completed,
                        label = snapshot.label,
                        blockedCount = snapshot.interceptions,
                        syncedAt = null,
                    )
                )
            }
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private suspend fun recover() {
        val db = ZenDatabase.get(applicationContext)
        val row = db.focusSessions().active() ?: run { stopSelf(); return }
        if (row.plannedEndAt <= System.currentTimeMillis()) {
            // Session ran to completion while the service was dead. Close it out.
            db.focusSessions().update(
                row.copy(endedAt = row.plannedEndAt, completed = true, syncedAt = null),
            )
            stopSelf()
            return
        }
        SessionState.begin(row.id, row.startedAt, row.plannedEndAt, row.label)
        startInForegroundCompat(buildNotification(row.plannedEndAt, row.label))
        scheduleTicks(row.plannedEndAt, row.label)
    }

    private fun scheduleTicks(endsAt: Long, label: String?) {
        tickJob?.cancel()
        tickJob = scope.launch {
            while (true) {
                val now = System.currentTimeMillis()
                if (now >= endsAt) {
                    stopSession(completed = true)
                    return@launch
                }
                updateNotification(buildNotification(endsAt, label))
                // 10s tick is a nice trade-off — minute-precision display without
                // waking the SoC too often.
                delay(10_000)
            }
        }
    }

    private fun buildNotification(endsAt: Long, label: String?): Notification {
        ensureChannel()

        val remainingMs = (endsAt - System.currentTimeMillis()).coerceAtLeast(0)
        val minutes = (remainingMs / 60_000).toInt()
        val title = label?.takeIf { it.isNotBlank() } ?: "Focus session"
        val text = if (minutes >= 1) "$minutes min remaining" else "Wrapping up…"

        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, FocusSessionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_focus_notification)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
            .addAction(0, "End", stopIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification(notification: Notification) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, notification)
    }

    private fun startInForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun ensureChannel() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Focus sessions",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shows a live countdown while a focus session is running."
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }

    companion object {
        const val ACTION_START = "com.apex.zen.focus.START"
        const val ACTION_STOP = "com.apex.zen.focus.STOP"
        const val EXTRA_DURATION_MIN = "durationMin"
        const val EXTRA_LABEL = "label"
        private const val CHANNEL_ID = "focus_session"
        private const val NOTIF_ID = 1001
    }
}
