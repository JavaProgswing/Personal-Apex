package com.apex.zen.session

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Process-wide snapshot of the active focus session.
 *
 * The accessibility service runs in the same process as the UI on Android
 * (unless we deliberately fork), so we can read the session via a simple
 * StateFlow without IPC. The DB is still the source of truth; this is just
 * a low-latency mirror so the blocker doesn't have to hit Room on every
 * window change.
 */
object SessionState {
    data class Active(
        val id: Long,
        val startedAt: Long,
        val endsAt: Long,
        val label: String?,
        val interceptions: Int,
    )

    private val _active = MutableStateFlow<Active?>(null)
    val activeSession: StateFlow<Active?> = _active.asStateFlow()

    fun begin(id: Long, startedAt: Long, endsAt: Long, label: String?) {
        _active.value = Active(id, startedAt, endsAt, label, 0)
    }

    fun clear() {
        _active.value = null
    }

    fun recordInterception() {
        _active.update { it?.copy(interceptions = it.interceptions + 1) }
    }
}

// tiny helper to avoid importing kotlin.jvm.Synchronized update everywhere
private fun <T> MutableStateFlow<T>.update(block: (T) -> T) {
    while (true) {
        val cur = value
        val next = block(cur)
        if (compareAndSet(cur, next)) return
    }
}
