package com.apex.zen.services

import android.accessibilityservice.AccessibilityService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import com.apex.zen.data.ZenDatabase
import com.apex.zen.session.SessionState
import com.apex.zen.ui.BlockOverlayActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Detects when a new app comes to the foreground and, if:
 *   1. a focus session is running, and
 *   2. that app is on the blocklist,
 * slides in an overlay that nudges (or forces) the user back out.
 *
 * Important: we deliberately don't read window content — `canRetrieveWindowContent`
 * is false in the XML config. We only need the package name from the event.
 */
class BlockerAccessibilityService : AccessibilityService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val mutex = Mutex()
    private var lastPackage: String? = null
    private var lastInterceptAt: Long = 0L

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return

        val pkg = event.packageName?.toString() ?: return

        // Skip our own app and the system UI — otherwise we recurse on the overlay.
        if (pkg == packageName) return
        if (pkg.startsWith("com.android.systemui")) return
        if (pkg == "android") return

        // Skip launchers so going home isn't treated as "opening an app."
        if (isLauncher(pkg)) {
            lastPackage = null
            return
        }

        // Same package as last event? Skip — usually a sub-activity of the same app.
        if (pkg == lastPackage) return
        lastPackage = pkg

        scope.launch { maybeBlock(pkg) }
    }

    private suspend fun maybeBlock(pkg: String) = mutex.withLock {
        val active = SessionState.activeSession.value ?: return
        if (active.endsAt <= System.currentTimeMillis()) return

        val blockedPackages = ZenDatabase.get(applicationContext)
            .blockedApps()
            .packages()
            .toSet()
        if (pkg !in blockedPackages) return

        // Debounce: if we just kicked the user out and they're bouncing back,
        // don't spam overlays. 750ms is enough to avoid double-fires.
        val now = System.currentTimeMillis()
        if (now - lastInterceptAt < 750) return
        lastInterceptAt = now

        SessionState.recordInterception()

        // Go home first so the blocked app isn't left at the top of the back stack.
        performGlobalAction(GLOBAL_ACTION_HOME)

        val intent = Intent(this, BlockOverlayActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra(BlockOverlayActivity.EXTRA_PACKAGE, pkg)
        }
        startActivity(intent)
    }

    private fun isLauncher(pkg: String): Boolean {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val resolved: ComponentName? = intent.resolveActivity(packageManager)
        return resolved?.packageName == pkg
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        super.onDestroy()
        try {
            (applicationContext as Context).also { /* no-op — scope auto-cancels */ }
        } catch (t: Throwable) {
            Log.w("ApexZen", "accessibility onDestroy", t)
        }
    }
}
