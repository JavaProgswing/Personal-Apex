package com.apex.zen.sync

import android.content.Context
import com.apex.zen.data.ZenDatabase
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * HTTP client that talks to the desktop Apex instance on the same LAN.
 *
 * The desktop exposes a tiny server (bound to 0.0.0.0:8427 by default, see
 * `electron/services/syncServer.cjs`) with two endpoints:
 *   - POST /sync/focus   — upload completed focus sessions
 *   - POST /sync/usage   — upload hourly per-package minutes
 *
 * Auth is a simple pre-shared token the user pastes once from the desktop
 * Settings page. We don't need TLS on a trusted home network; the token
 * keeps roommates honest.
 */
class ApexClient(
    private val baseUrl: String, // e.g. "http://192.168.1.7:8427"
    private val token: String,
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    suspend fun sync(ctx: Context): Result<SyncReport> = runCatching {
        val db = ZenDatabase.get(ctx)
        val now = System.currentTimeMillis()

        val focus = db.focusSessions().unsynced()
        if (focus.isNotEmpty()) {
            val arr = JSONArray()
            for (f in focus) {
                arr.put(JSONObject().apply {
                    put("id", f.id)
                    put("started_at", f.startedAt)
                    put("planned_end_at", f.plannedEndAt)
                    put("ended_at", f.endedAt)
                    put("completed", f.completed)
                    put("label", f.label ?: JSONObject.NULL)
                    put("blocked_count", f.blockedCount)
                })
            }
            post("/sync/focus", JSONObject().put("sessions", arr).toString())
            db.focusSessions().markSynced(focus.map { it.id }, now)
        }

        val usage = db.usage().unsynced()
        if (usage.isNotEmpty()) {
            val arr = JSONArray()
            for (u in usage) {
                arr.put(JSONObject().apply {
                    put("date", u.date)
                    put("hour", u.hour)
                    put("pkg", u.pkg)
                    put("minutes", u.minutes)
                })
            }
            post("/sync/usage", JSONObject().put("rows", arr).toString())
            for (u in usage) db.usage().markSynced(u.date, u.hour, u.pkg, now)
        }

        SyncReport(focusCount = focus.size, usageCount = usage.size)
    }

    private fun post(path: String, body: String): String {
        val req = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .header("Authorization", "Bearer $token")
            .post(body.toRequestBody(JSON))
            .build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw RuntimeException("Apex returned ${resp.code}: ${resp.body?.string().orEmpty()}")
            }
            return resp.body?.string().orEmpty()
        }
    }

    data class SyncReport(val focusCount: Int, val usageCount: Int)

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
