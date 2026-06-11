package dev.yashasvi.apex.mobile

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

object WellbeingReader {
    fun hasUsageAccess(context: Context): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName,
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                context.packageName,
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    // Per-app foreground aggregate derived from the event stream.
    private class Agg {
        var totalMs: Long = 0
        var firstMs: Long = Long.MAX_VALUE
        var lastMs: Long = 0
        var launches: Int = 0
        fun credit(start: Long, end: Long) {
            if (end <= start) return
            totalMs += end - start
            if (start < firstMs) firstMs = start
            if (end > lastMs) lastMs = end
        }
    }

    // OS plumbing that grabs foreground time but isn't an app the user opened:
    // the bare "android" package, system UI, launchers, IMEs, WebView/
    // TrichromeLibrary, OEM service shims (ThirdPartyClient & co). These were
    // showing up as "android 1h 57m" / "System Launcher 25m" in screen time.
    private val junkPkg = Regex(
        "^(android|com\\.android\\.systemui|com\\.android\\.settings\\.intelligence)$" +
            "|launcher|trichrome|webview|inputmethod|packageinstaller|permissioncontroller" +
            "|wellbeing|com\\.(oplus|coloros|heytap|miui|sec\\.android\\.daemonapp)\\.",
        RegexOption.IGNORE_CASE,
    )

    // Apps whose install label is broken or misleading (Prime Video reports
    // itself as "ThirdPartyClient", Threads as "Barcelona" when label lookup
    // fails). Checked before the PackageManager label.
    private val labelOverrides = mapOf(
        "com.amazon.avod.thirdpartyclient" to "Prime Video",
        "com.instagram.barcelona" to "Threads",
    )

    // Keep only things a human can actually open. The junk regex is the
    // primary gate; the launch-intent check only DEMOTES a package when we can
    // positively see it has no launcher entry. When package visibility hides
    // an app from us (the cause of the "7m vs 2h" undercount), we keep it —
    // a hidden-but-used app is almost certainly a real app.
    private fun isRealApp(packageManager: PackageManager, pkg: String): Boolean {
        if (junkPkg.containsMatchIn(pkg)) return false
        return try {
            val visible = try { packageManager.getApplicationInfo(pkg, 0); true } catch (_: Exception) { false }
            if (!visible) return true // can't inspect it → trust the regex verdict
            packageManager.getLaunchIntentForPackage(pkg) != null
        } catch (_: Exception) { true }
    }

    fun readToday(context: Context): List<WellbeingSession> {
        val usage = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val zone = ZoneId.systemDefault()
        val start = LocalDate.now().atStartOfDay(zone).toInstant().toEpochMilli()
        val now = Instant.now().toEpochMilli()
        val date = LocalDate.now().toString()
        val packageManager = context.packageManager
        // User-hidden apps (long-press a usage bar) vanish from the dashboard
        // AND uploads — hiding means hiding.
        val ignored = ApexStore(context).ignoredPkgs

        // Event-derived foreground intervals - mirrors the desktop tracker's
        // RESUMED/PAUSED accounting, so we get accurate time plus real first/
        // last timestamps instead of a coarse daily total.
        val agg = HashMap<String, Agg>()
        val active = HashMap<String, Long>()
        val events = usage.queryEvents(start, now)
        if (events != null) {
            val ev = UsageEvents.Event()
            while (events.hasNextEvent()) {
                events.getNextEvent(ev)
                val pkg = ev.packageName ?: continue
                when (ev.eventType) {
                    UsageEvents.Event.MOVE_TO_FOREGROUND -> {
                        // A second foreground without a pause: close the prior
                        // interval at this point so its time isn't lost.
                        active.remove(pkg)?.let { s -> agg.getOrPut(pkg) { Agg() }.credit(s, ev.timeStamp) }
                        active[pkg] = ev.timeStamp
                        agg.getOrPut(pkg) { Agg() }.launches += 1
                    }
                    UsageEvents.Event.MOVE_TO_BACKGROUND -> {
                        active.remove(pkg)?.let { s -> agg.getOrPut(pkg) { Agg() }.credit(s, ev.timeStamp) }
                    }
                    // Screen off / keyguard / shutdown: nothing is "in use"
                    // anymore even though no MOVE_TO_BACKGROUND fired. Without
                    // this clamp a locked phone kept crediting the last app,
                    // which is why Apex's numbers ran way past Digital
                    // Wellbeing's.
                    UsageEvents.Event.SCREEN_NON_INTERACTIVE,
                    UsageEvents.Event.KEYGUARD_SHOWN,
                    UsageEvents.Event.DEVICE_SHUTDOWN -> {
                        for ((p, s) in active) agg.getOrPut(p) { Agg() }.credit(s, ev.timeStamp)
                        active.clear()
                    }
                }
            }
        }
        // Apps still foregrounded at "now" - close them at the current time.
        for ((pkg, s) in active) agg.getOrPut(pkg) { Agg() }.credit(s, now)

        val fromEvents = agg.entries
            .filter { it.value.totalMs >= 60_000 && it.key !in ignored && isRealApp(packageManager, it.key) }
            .sortedByDescending { it.value.totalMs }
            .take(120)
            .map { (pkg, a) ->
                WellbeingSession(
                    date = date,
                    packageName = pkg,
                    appName = resolveAppName(packageManager, pkg),
                    category = inferCategory(pkg),
                    startedAt = if (a.firstMs != Long.MAX_VALUE) Instant.ofEpochMilli(a.firstMs).toString() else null,
                    endedAt = if (a.lastMs > 0) Instant.ofEpochMilli(a.lastMs).toString() else null,
                    minutes = a.totalMs / 60_000.0,
                    launches = a.launches,
                )
            }
        if (fromEvents.isNotEmpty()) return fromEvents

        // Fallback: some OEMs return an empty event stream. Use the coarse
        // daily totals so we still report something.
        val stats = usage.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, start, now) ?: emptyList()
        return stats
            .asSequence()
            .filter { it.totalTimeInForeground >= 60_000 && it.packageName !in ignored && isRealApp(packageManager, it.packageName) }
            .sortedByDescending { it.totalTimeInForeground }
            .take(120)
            .map { stat ->
                WellbeingSession(
                    date = date,
                    packageName = stat.packageName,
                    appName = resolveAppName(packageManager, stat.packageName),
                    category = inferCategory(stat.packageName),
                    startedAt = null,
                    endedAt = null,
                    minutes = stat.totalTimeInForeground / 60_000.0,
                )
            }
            .toList()
    }

    private fun resolveAppName(packageManager: PackageManager, packageName: String): String {
        labelOverrides[packageName]?.let { return it }
        return try {
            val info = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(info).toString()
        } catch (_: Exception) {
            packageName.substringAfterLast('.').replaceFirstChar { it.uppercase() }
        }
    }

    // Public alias used by the Zen blocker service.
    fun categoryFor(packageName: String): String = inferCategory(packageName)

    // Best-effort "what app is on screen right now": newest MOVE_TO_FOREGROUND
    // event in the last [windowMs]. Null when nothing surfaced in the window.
    fun currentForegroundPackage(context: Context, windowMs: Long = 60_000): String? {
        val usage = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val now = System.currentTimeMillis()
        val events = usage.queryEvents(now - windowMs, now) ?: return null
        val ev = UsageEvents.Event()
        var latestPkg: String? = null
        var latestTs = 0L
        while (events.hasNextEvent()) {
            events.getNextEvent(ev)
            when (ev.eventType) {
                UsageEvents.Event.MOVE_TO_FOREGROUND -> if (ev.timeStamp >= latestTs) {
                    latestTs = ev.timeStamp; latestPkg = ev.packageName
                }
                UsageEvents.Event.MOVE_TO_BACKGROUND -> if (ev.packageName == latestPkg && ev.timeStamp > latestTs) {
                    latestPkg = null
                }
                // Screen off = nothing foreground; stops the Zen blocker from
                // "bouncing" apps while the phone is locked in a pocket.
                UsageEvents.Event.SCREEN_NON_INTERACTIVE,
                UsageEvents.Event.KEYGUARD_SHOWN -> if (ev.timeStamp > latestTs) {
                    latestTs = ev.timeStamp; latestPkg = null
                }
            }
        }
        return latestPkg
    }

    private fun inferCategory(packageName: String): String {
        val lower = packageName.lowercase()
        return when {
            Regex("whatsapp|instagram|twitter|xhs|reddit|tiktok|snapchat|youtube|netflix|hotstar|discord|telegram|facebook|avod|primevideo|disney|jiocinema|crunchyroll")
                .containsMatchIn(lower) -> "distraction"
            Regex("spotify|music|audible|kindle|books|podcast").containsMatchIn(lower) -> "leisure"
            Regex("calendar|drive|notion|obsidian|mail|gmail|docs|sheets|classroom").containsMatchIn(lower) -> "productive"
            else -> "mobile"
        }
    }
}
