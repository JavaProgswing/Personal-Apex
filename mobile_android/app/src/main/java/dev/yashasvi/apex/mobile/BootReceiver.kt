package dev.yashasvi.apex.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// AlarmManager alarms die on reboot. Re-arm wake/sleep from the locally
// persisted times and re-enqueue the background usage sync, so everything
// keeps working without the app ever being opened.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) return
        val store = ApexStore(context)
        RoutineAlarmScheduler.scheduleConfigured(
            context,
            ApexRoutine(
                id = null,
                date = java.time.LocalDate.now().toString(),
                wakeTime = store.lastWakeTime,
                sleepTime = store.lastSleepTime,
                objective = null,
                linkedTaskId = null,
            ),
        )
        if (!store.token.isNullOrBlank() && store.autoSync) {
            WellbeingSyncWorker.enqueue(context)
        }
        // Re-arm the persistent focus guard (BOOT_COMPLETED is allowed to start
        // a foreground service); it polls /focus on its own from here.
        if (!store.token.isNullOrBlank() && store.blockerEnabled) {
            ZenWatchService.start(context)
        }
    }
}
