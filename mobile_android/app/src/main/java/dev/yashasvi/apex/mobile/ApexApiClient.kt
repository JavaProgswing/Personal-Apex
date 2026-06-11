package dev.yashasvi.apex.mobile

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

// org.json's optString turns an explicit JSON null into the literal string
// "null" - which is how "due null" ended up in the task list. This reads a
// string field as a real nullable.
private fun JSONObject.str(key: String): String? {
    if (!has(key) || isNull(key)) return null
    return optString(key).ifBlank { null }
}

data class ApexPairResult(
    val apiBase: String,
    val token: String,
    val deviceId: String,
    val deviceName: String,
)

data class ApexRoutine(
    val id: String?,
    val date: String,
    val wakeTime: String?,
    val sleepTime: String?,
    val objective: String?,
    val linkedTaskId: String?,
)

data class ApexReminder(
    val kind: String,
    val title: String,
    val overdue: Boolean = false,
    val task: ApexTask? = null,
)

data class ApexTask(
    val id: String?,
    val title: String,
    val status: String?,
    val dueAt: String?,
    val source: String? = null,
    val recurrence: String? = null,
    val priority: Int? = null,
    val courseCode: String? = null,
    val category: String? = null,
)

data class ApexNote(
    val id: String?,
    val date: String,
    val title: String?,
    val body: String,
    val kind: String = "day_note",
    val source: String = "mobile",
    val updatedAt: String? = null,
)

data class DeviceInfo(
    val id: String,
    val name: String,
    val type: String,
    val createdAt: String?,
    val lastSeenAt: String?,
)

data class FocusState(
    val active: Boolean,
    val title: String?,
    val mode: String?,
    val endsAt: String?,
)

data class WellbeingSession(
    val date: String,
    val packageName: String,
    val appName: String?,
    val category: String?,
    val startedAt: String?,
    val endedAt: String?,
    val minutes: Double,
    val launches: Int = 0,
)

class ApexApiClient(
    private val apiBase: String,
    private val tokenProvider: () -> String?,
    private val http: OkHttpClient = OkHttpClient(),
) {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    suspend fun health(): JSONObject = withContext(Dispatchers.IO) {
        request("GET", "$apiBase/health", auth = false)
    }

    suspend fun pair(code: String, deviceName: String): ApexPairResult = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("code", code.trim())
            .put("device_name", deviceName.trim())
            .put("device_type", "android")
            .toString()
            .toRequestBody(jsonType)
        val json = request("POST", "$apiBase/pair", body, auth = false)
        val device = json.getJSONObject("device")
        ApexPairResult(
            apiBase = json.getString("api_base"),
            token = json.getString("token"),
            deviceId = device.getString("id"),
            deviceName = device.getString("name"),
        )
    }

    suspend fun bootstrap(): JSONObject = withContext(Dispatchers.IO) {
        request("GET", "$apiBase/bootstrap")
    }

    // Current device for this token - confirms the pairing is still valid.
    suspend fun me(): JSONObject = withContext(Dispatchers.IO) {
        request("GET", "$apiBase/me")
    }

    // Every paired device + which one is us. Powers the Settings device list.
    suspend fun devices(): Pair<String?, List<DeviceInfo>> = withContext(Dispatchers.IO) {
        val json = request("GET", "$apiBase/devices")
        val selfId = json.str("self")
        val arr = json.optJSONArray("devices") ?: org.json.JSONArray()
        val list = (0 until arr.length()).map { i ->
            val d = arr.getJSONObject(i)
            DeviceInfo(
                id = d.getString("id"),
                name = d.optString("name", "device"),
                type = d.optString("type", "unknown"),
                createdAt = d.str("created_at"),
                lastSeenAt = d.str("last_seen_at"),
            )
        }
        selfId to list
    }

    suspend fun revokeDevice(id: String): JSONObject = withContext(Dispatchers.IO) {
        request("DELETE", "$apiBase/devices/$id")
    }

    // Desktop's focus (Zen) state - drives the mobile distraction blocker.
    suspend fun focus(): FocusState = withContext(Dispatchers.IO) {
        val json = request("GET", "$apiBase/focus")
        FocusState(
            active = json.optBoolean("active", false),
            title = json.str("title"),
            mode = json.str("mode"),
            endsAt = json.str("ends_at"),
        )
    }

    suspend fun todayRoutine(): ApexRoutine = withContext(Dispatchers.IO) {
        val json = request("GET", "$apiBase/routine/today")
        val payload = json.optJSONObject("payload")
        ApexRoutine(
            id = json.str("id"),
            date = json.getString("date"),
            wakeTime = json.str("wake_time"),
            sleepTime = json.str("sleep_time"),
            objective = payload?.str("objective"),
            linkedTaskId = json.str("linked_task_id"),
        )
    }

    private fun taskFromJson(item: JSONObject): ApexTask {
        val payload = item.optJSONObject("payload")
        return ApexTask(
            id = item.str("id"),
            title = item.optString("title", "Untitled"),
            status = item.str("status"),
            dueAt = item.str("due_at"),
            source = item.str("source"),
            recurrence = payload?.str("recurrence"),
            priority = payload?.takeIf { it.has("priority") && !it.isNull("priority") }?.optInt("priority"),
            courseCode = payload?.str("course_code"),
            category = payload?.str("category"),
        )
    }

    private fun noteFromJson(item: JSONObject): ApexNote =
        ApexNote(
            id = item.str("id"),
            date = item.optString("date", java.time.LocalDate.now().toString()),
            title = item.str("title"),
            body = item.optString("body", ""),
            kind = item.optString("kind", "day_note"),
            source = item.optString("source", "mobile"),
            updatedAt = item.str("updated_at"),
        )

    suspend fun tasks(): List<ApexTask> = withContext(Dispatchers.IO) {
        val arr = requestArray("GET", "$apiBase/tasks")
        (0 until arr.length()).map { i ->
            taskFromJson(arr.getJSONObject(i))
        }
    }

    // Create or update a task. Omitting id lets the server mint one; passing an
    // existing id upserts (used to flip status to done from the phone).
    suspend fun saveTask(task: ApexTask): ApexTask = withContext(Dispatchers.IO) {
        // Priority/category travel in the payload — the desktop import reads
        // them when turning phone todos into full Apex tasks.
        val payload = JSONObject()
        task.priority?.let { payload.put("priority", it) }
        task.category?.let { payload.put("category", it) }
        task.recurrence?.let { payload.put("recurrence", it) }
        task.courseCode?.let { payload.put("course_code", it) }
        val body = JSONObject()
            .apply { task.id?.let { put("id", it) } }
            .put("title", task.title)
            .put("status", task.status ?: "open")
            .put("due_at", task.dueAt)
            .put("source", task.source ?: "mobile")
            .put("payload", payload)
            .toString()
            .toRequestBody(jsonType)
        val json = request("POST", "$apiBase/tasks", body)
        taskFromJson(json)
    }

    suspend fun deleteTask(id: String): JSONObject = withContext(Dispatchers.IO) {
        request("DELETE", "$apiBase/tasks/$id")
    }

    suspend fun notes(limit: Int = 20): List<ApexNote> = withContext(Dispatchers.IO) {
        val arr = requestArray("GET", "$apiBase/notes?limit=$limit")
        (0 until arr.length()).map { i -> noteFromJson(arr.getJSONObject(i)) }
    }

    suspend fun saveNote(note: ApexNote): ApexNote = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .apply { note.id?.let { put("id", it) } }
            .put("date", note.date)
            .put("title", note.title)
            .put("body", note.body)
            .put("kind", note.kind)
            .put("source", note.source)
            .put("payload", JSONObject())
            .toString()
            .toRequestBody(jsonType)
        noteFromJson(request("POST", "$apiBase/notes", body))
    }

    suspend fun deleteNote(id: String): JSONObject = withContext(Dispatchers.IO) {
        request("DELETE", "$apiBase/notes/$id")
    }

    suspend fun dueReminders(): List<ApexReminder> = withContext(Dispatchers.IO) {
        val arr = requestArray("GET", "$apiBase/reminders/due")
        (0 until arr.length()).map { i ->
            val item = arr.getJSONObject(i)
            ApexReminder(
                kind = item.getString("kind"),
                title = item.optString("title", item.getString("kind")),
                overdue = item.optBoolean("overdue", false),
                task = item.optJSONObject("task")?.let { taskFromJson(it) },
            )
        }
    }

    suspend fun markEvent(kind: String, payload: JSONObject = JSONObject()): JSONObject = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("kind", kind)
            .put("payload", payload)
            .toString()
            .toRequestBody(jsonType)
        request("POST", "$apiBase/events", body)
    }

    // `deviceId` makes the row id deterministic per (device, day, package) so a
    // re-sync UPSERTs the same row instead of piling up duplicates - the phone
    // reports each day's running total, not deltas.
    suspend fun pushWellbeing(sessions: List<WellbeingSession>, deviceId: String? = null): JSONObject = withContext(Dispatchers.IO) {
        val prefix = deviceId?.takeIf { it.isNotBlank() } ?: "dev"
        val arr = JSONArray()
        sessions.forEach { session ->
            arr.put(
                JSONObject()
                    .put("id", "wb_${prefix}_${session.date}_${session.packageName}")
                    .put("date", session.date)
                    .put("package_name", session.packageName)
                    .put("app_name", session.appName)
                    .put("category", session.category)
                    .put("started_at", session.startedAt)
                    .put("ended_at", session.endedAt)
                    .put("minutes", session.minutes)
                    .put("payload", JSONObject().put("launches", session.launches)),
            )
        }
        request("POST", "$apiBase/wellbeing", arr.toString().toRequestBody(jsonType))
    }

    // Update today's wake/sleep from the phone. Marks the edit as mobile-made
    // so the desktop adopts the new times instead of overwriting them on its
    // next push.
    suspend fun saveRoutineTimes(routine: ApexRoutine): ApexRoutine = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .apply { routine.id?.let { put("id", it) } }
            .put("date", routine.date)
            .put("name", "Apex daily routine")
            .put("wake_time", routine.wakeTime)
            .put("sleep_time", routine.sleepTime)
            .put("linked_task_id", routine.linkedTaskId)
            .put("payload", JSONObject()
                .put("objective", routine.objective ?: "")
                .put("lastEditedBy", "mobile")
                .put("editedAt", java.time.Instant.now().toString()))
            .toString()
            .toRequestBody(jsonType)
        val json = request("PUT", "$apiBase/routine/today", body)
        val payload = json.optJSONObject("payload")
        ApexRoutine(
            id = json.str("id"),
            date = json.optString("date", routine.date),
            wakeTime = json.str("wake_time"),
            sleepTime = json.str("sleep_time"),
            objective = payload?.str("objective"),
            linkedTaskId = json.str("linked_task_id"),
        )
    }

    suspend fun pushRoutineState(routine: ApexRoutine, objectiveDone: Boolean = false): JSONObject =
        withContext(Dispatchers.IO) {
            val routineJson = JSONObject()
                .put("id", routine.id)
                .put("date", routine.date)
                .put("name", "Apex mobile routine")
                .put("wake_time", routine.wakeTime)
                .put("sleep_time", routine.sleepTime)
                .put("linked_task_id", routine.linkedTaskId)
                .put("payload", JSONObject().put("objective", routine.objective))

            val events = JSONArray()
            if (objectiveDone) {
                events.put(JSONObject().put("kind", "objective_done").put("payload", JSONObject()))
            }

            val body = JSONObject()
                .put("routines", JSONArray().put(routineJson))
                .put("objectives", JSONArray())
                .put("tasks", JSONArray())
                .put("events", events)
                .put("wellbeing", JSONArray())
                .toString()
                .toRequestBody(jsonType)
            request("POST", "$apiBase/sync/push", body)
        }

    private fun authed(builder: Request.Builder): Request.Builder {
        val token = tokenProvider()
        if (!token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
        return builder
    }

    private fun request(
        method: String,
        url: String,
        body: RequestBody? = null,
        auth: Boolean = true,
    ): JSONObject {
        val builder = Request.Builder().url(url)
        if (auth) authed(builder)
        val request = builder.method(method, body).build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("Apex API ${response.code}: $text")
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }

    private fun requestArray(method: String, url: String): JSONArray {
        val builder = Request.Builder().url(url)
        authed(builder)
        val request = builder.method(method, null).build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error("Apex API ${response.code}: $text")
            return if (text.isBlank()) JSONArray() else JSONArray(text)
        }
    }
}
