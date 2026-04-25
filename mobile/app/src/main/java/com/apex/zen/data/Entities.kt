package com.apex.zen.data

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * One focus session the user started, completed, or aborted.
 *
 * A session either runs to `plannedEndAt` (completed = true) or gets ended
 * early (completed = false, `endedAt < plannedEndAt`). We keep aborted
 * sessions so the stats page can show streak honesty.
 */
@Entity(tableName = "focus_sessions")
data class FocusSession(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val startedAt: Long,
    val plannedEndAt: Long,
    val endedAt: Long?,
    val completed: Boolean,
    val label: String?,   // e.g. "DSA revision"
    val blockedCount: Int, // how many times a blocked app was intercepted
    val syncedAt: Long?,   // null until the desktop has this session
)

/**
 * One package the user wants blocked during focus sessions.
 *
 * `soft` means "show the overlay but let the user bypass with a 10s delay."
 * `hard` means "no bypass, just kick out." Default is soft — we lean gentle.
 */
@Entity(tableName = "blocklist")
data class BlockedApp(
    @PrimaryKey val packageName: String,
    val displayName: String,
    val soft: Boolean = true,
    val addedAt: Long = System.currentTimeMillis(),
)

/**
 * Hourly snapshot of per-package foreground time, for the stats page and
 * for sync to the desktop. Keyed by (date, package).
 */
@Entity(tableName = "usage_hourly", primaryKeys = ["date", "hour", "pkg"])
data class UsageHourly(
    val date: String,   // "2026-04-24", local
    val hour: Int,      // 0..23
    val pkg: String,
    val minutes: Int,
    val syncedAt: Long?,
)
