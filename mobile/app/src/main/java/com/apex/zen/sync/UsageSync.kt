package com.apex.zen.sync

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import com.apex.zen.data.UsageHourly
import com.apex.zen.data.ZenDatabase
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Reads the UsageEvents stream and turns it into hourly per-package minutes.
 *
 * This mirrors the logic in desktop Apex's `parseUsagestats` — we don't sum
 * totals blindly, we walk RESUMED/PAUSED pairs and credit the overlap with
 * each hour bucket. That way a session that spans :59 → :01 gets split
 * across two rows instead of dumping all its minutes into one.
 *
 * Requires `PACKAGE_USAGE_STATS` — user grants it in Settings > Usage access.
 */
object UsageSync {

    private val dateFmt = DateTimeFormatter.ofPattern("yyyy-MM-dd")

    /**
     * Ingest everything that happened since [since] (epoch ms) up to now and
     * write hourly rows to the DB. Idempotent per (date, hour, pkg) thanks
     * to REPLACE on the composite primary key.
     */
    suspend fun ingest(ctx: Context, since: Long) {
        val now = System.currentTimeMillis()
        val mgr = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as? UsageStatsManager
            ?: return

        val events = mgr.queryEvents(since, now)
        val buckets = HashMap<Triple<String, Int, String>, Long>() // (date, hour, pkg) -> ms

        // Walk per-package resume/pause pairs. Android emits MOVE_TO_FOREGROUND
        // and MOVE_TO_BACKGROUND; we tolerate back-to-back foregrounds by
        // closing the prior one at the new foreground's timestamp (same fix
        // as the ADB parser on desktop).
        val active = HashMap<String, Long>() // pkg -> startMs
        val evt = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(evt)
            val pkg = evt.packageName ?: continue
            val ts = evt.timeStamp
            when (evt.eventType) {
                UsageEvents.Event.MOVE_TO_FOREGROUND -> {
                    active[pkg]?.let { credit(buckets, pkg, it, ts) }
                    active[pkg] = ts
                }
                UsageEvents.Event.MOVE_TO_BACKGROUND,
                UsageEvents.Event.ACTIVITY_STOPPED -> {
                    active.remove(pkg)?.let { credit(buckets, pkg, it, ts) }
                }
            }
        }
        // Apps still active at end of window: close at `now`.
        for ((pkg, start) in active) credit(buckets, pkg, start, now)

        val rows = buckets.entries.map { (k, ms) ->
            UsageHourly(
                date = k.first,
                hour = k.second,
                pkg = k.third,
                minutes = (ms / 60_000L).toInt(),
                syncedAt = null,
            )
        }.filter { it.minutes > 0 }

        if (rows.isNotEmpty()) {
            ZenDatabase.get(ctx).usage().insertAll(rows)
        }
    }

    private fun credit(
        buckets: HashMap<Triple<String, Int, String>, Long>,
        pkg: String,
        start: Long,
        end: Long,
    ) {
        if (end <= start) return
        // Split across hour boundaries so minutes land in the right bucket.
        var cursor = start
        while (cursor < end) {
            val hourEnd = hourFloor(cursor) + 3_600_000L
            val slice = minOf(hourEnd, end) - cursor
            val date = Instant.ofEpochMilli(cursor).atZone(ZoneId.systemDefault()).toLocalDate().format(dateFmt)
            val hour = Instant.ofEpochMilli(cursor).atZone(ZoneId.systemDefault()).hour
            val key = Triple(date, hour, pkg)
            buckets[key] = (buckets[key] ?: 0) + slice
            cursor += slice
        }
    }

    private fun hourFloor(ms: Long): Long {
        val zdt = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())
            .withMinute(0).withSecond(0).withNano(0)
        return zdt.toInstant().toEpochMilli()
    }
}
