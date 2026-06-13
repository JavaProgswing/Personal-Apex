package dev.yashasvi.apex.mobile

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognizerIntent
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant
import java.util.Locale
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    companion object {
        const val EXTRA_FROM_ALARM = "from_alarm"
        const val EXTRA_GAP_START = "gap_start"
        const val EXTRA_GAP_END = "gap_end"
        private const val FOCUS_POLL_MS = 12_000L // in-app focus banner refresh
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var store: ApexStore

    // ── shared chrome ────────────────────────────────────────────────────────
    private lateinit var statusText: TextView
    private lateinit var statusDot: View
    private lateinit var contentFrame: FrameLayout
    private val tabViews = HashMap<String, View>()
    private val navButtons = HashMap<String, TextView>()
    private var currentTab = ""

    // ── Today tab ────────────────────────────────────────────────────────────
    private lateinit var focusBanner: LinearLayout
    private lateinit var focusBannerTitle: TextView
    private lateinit var focusBannerDetail: TextView
    private lateinit var routineText: TextView
    private lateinit var planBox: LinearLayout
    private lateinit var scheduleBox: LinearLayout
    private lateinit var quickCaptureInput: EditText
    private lateinit var todayNotesBox: LinearLayout
    private lateinit var remindersBox: LinearLayout
    private var currentRoutine: ApexRoutine? = null
    private var reminders: List<ApexReminder> = emptyList()
    private var notes: List<ApexNote> = emptyList()

    // ── Tasks tab ────────────────────────────────────────────────────────────
    private lateinit var taskAddInput: EditText
    private lateinit var taskSummaryText: TextView
    private lateinit var taskListBox: LinearLayout
    private var pendingVoiceTodo = false
    private var tasks: List<ApexTask> = emptyList()

    // ── Notes tab ────────────────────────────────────────────────────────────
    private lateinit var noteTitleInput: EditText
    private lateinit var noteBodyInput: EditText
    private lateinit var noteSearchInput: EditText
    private lateinit var noteEditBadge: TextView
    private lateinit var notesListBox: LinearLayout
    private var editingNoteId: String? = null

    // ── Activity tab ─────────────────────────────────────────────────────────
    private lateinit var usageAccessText: TextView
    private lateinit var usageTotalText: TextView
    private lateinit var usageInsightText: TextView
    private lateinit var usageBarsBox: LinearLayout
    private lateinit var syncText: TextView
    private lateinit var bgSyncButton: Button

    // Pull-to-refresh wrappers (one per tab) so any async completion can stop
    // all the spinners at once.
    private val swipeLayouts = ArrayList<SwipeRefreshLayout>()

    private val hideStatusRunnable = Runnable {
        if (::statusText.isInitialized) {
            statusText.animate().alpha(0f).setDuration(250).withEndAction {
                statusText.visibility = View.GONE
                statusText.alpha = 1f
            }.start()
        }
    }

    // ── Settings tab ─────────────────────────────────────────────────────────
    private lateinit var pairBadge: TextView
    private lateinit var pairDetailText: TextView
    private lateinit var apiBaseInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var deviceInput: EditText
    private lateinit var devicesBox: LinearLayout
    private lateinit var deviceCountText: TextView
    private lateinit var readinessBox: LinearLayout
    private lateinit var pairButton: Button

    // ── palette ──────────────────────────────────────────────────────────────
    private val bg = Color.parseColor("#0B0D12")
    private val panel = Color.parseColor("#141922")
    private val panel2 = Color.parseColor("#1B2230")
    private val border = Color.parseColor("#263244")
    private val border2 = Color.parseColor("#2A3444")
    private val textColor = Color.parseColor("#F4F7FB")
    private val muted = Color.parseColor("#9AA8BA")
    private val faint = Color.parseColor("#667386")
    private val accent = Color.parseColor("#38D8C4")
    private val accent2 = Color.parseColor("#2BC4D8")
    private val accentSoft = Color.argb(38, 56, 216, 196)
    private val amber = Color.parseColor("#F5B84B")
    private val green = Color.parseColor("#3DD68C")
    private val red = Color.parseColor("#E5675C")

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { handleScan(it) }
    }

    private val ringtoneLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@registerForActivityResult
        val picked: Uri? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            result.data?.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI, Uri::class.java)
        } else {
            @Suppress("DEPRECATION")
            result.data?.getParcelableExtra(RingtoneManager.EXTRA_RINGTONE_PICKED_URI)
        }
        val title = ringtoneTitle(picked)
        store.wakeRingtoneUri = picked?.toString()
        store.wakeRingtoneName = title
        renderScheduleControls()
        statusText.text = "Alarm sound set to $title."
    }

    private val speechLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@registerForActivityResult
        val spoken = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?.trim()
            .orEmpty()
        if (spoken.isBlank()) {
            statusText.text = "No todo heard."
            return@registerForActivityResult
        }
        if (pendingVoiceTodo) {
            pendingVoiceTodo = false
            addTaskFromText(spoken, "Voice todo saved")
        } else if (::quickCaptureInput.isInitialized) {
            quickCaptureInput.setText(spoken)
            statusText.text = "Captured voice text. Choose note or todo."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = ApexStore(this)
        // Launched by the ringing alarm's full-screen intent: show over the
        // lock screen and light the display so Dismiss/Snooze are reachable.
        if (intent?.getBooleanExtra(EXTRA_FROM_ALARM, false) == true &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1
        ) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        }
        requestNotificationPermission()
        buildUi()
        renderStoredState()
        selectTab(if (store.token.isNullOrBlank()) "settings" else "today")
        pingHealth()
        refreshFromServer()
        renderLocalUsage()
        // The periodic worker is the background safety-net that revives the
        // focus guard if the OS killed it — so it must run whenever EITHER
        // background sync OR the blocker is on (previously tied to autoSync
        // only, which left a blocker-on/sync-off user with no background poll).
        if (!store.token.isNullOrBlank() && (store.autoSync || store.blockerEnabled)) {
            WellbeingSyncWorker.enqueue(this)
        }
        // Opened from a gap-log notification → straight into the log dialog.
        val gapStart = intent?.getLongExtra(EXTRA_GAP_START, 0L) ?: 0L
        val gapEnd = intent?.getLongExtra(EXTRA_GAP_END, 0L) ?: 0L
        if (gapStart > 0 && gapEnd > gapStart) showGapLogDialog(gapStart, gapEnd)
        maybeShowRingingOverlay()
    }

    // ── In-app alarm dismissal ───────────────────────────────────────────────
    // The full-screen intent launches THIS activity over the lock screen —
    // which covers the very notification that holds Dismiss/Snooze. Without
    // an in-app control the alarm is unstoppable (the "had to power off the
    // phone" bug). So: whenever AlarmRingService is ringing, lay a dismissal
    // panel over everything.
    private var ringOverlay: View? = null
    private val ringPoll = object : Runnable {
        override fun run() {
            if (AlarmRingService.ringingKind == null) hideRingingOverlay()
            else contentFrame.postDelayed(this, 700)
        }
    }

    private fun maybeShowRingingOverlay() {
        val kind = AlarmRingService.ringingKind ?: return
        if (ringOverlay != null) return
        val isSleep = kind == "sleep_reminder"
        val custom = if (kind.startsWith(RoutineAlarmScheduler.CUSTOM_PREFIX)) {
            store.alarmById(kind.removePrefix(RoutineAlarmScheduler.CUSTOM_PREFIX))
        } else null
        val hard = custom?.hard == true
        val overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.argb(244, 11, 13, 18))
            isClickable = true // swallow touches to the UI underneath
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }
        overlay.addView(label(
            when {
                hard -> "LOCKED"
                custom != null -> "ALARM"
                isSleep -> "SLEEP"
                else -> "WAKE"
            },
            22f, if (hard) red else if (isSleep) accent else amber, true,
        ))
        overlay.addView(space(8))
        overlay.addView(label(
            java.text.SimpleDateFormat("HH:mm", Locale.US).format(java.util.Date()),
            56f, textColor, true,
        ))
        overlay.addView(label(
            custom?.label ?: if (isSleep) "Time to wind down" else "Good morning - rise and shine",
            15f, muted, false,
        ))
        overlay.addView(space(34))
        fun act(action: String, status: String, pinOk: Boolean = false) {
            startService(Intent(this, AlarmRingService::class.java)
                .setAction(action)
                .putExtra(AlarmRingService.EXTRA_KIND, kind)
                .putExtra(AlarmRingService.EXTRA_PIN_OK, pinOk))
            hideRingingOverlay()
            statusText.text = status
        }
        if (hard) {
            // Hard mode: the PIN is the only exit. No snooze, no dismiss.
            val pinInput = input("Alarm PIN").apply {
                inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
                gravity = Gravity.CENTER
                textSize = 22f
            }
            overlay.addView(pinInput)
            overlay.addView(space(12))
            overlay.addView(wideButton("Unlock & stop") {
                if (store.checkAlarmPin(pinInput.text.toString().trim())) {
                    act(AlarmRingService.ACTION_DISMISS, "Hard alarm unlocked.", pinOk = true)
                } else {
                    pinInput.setText("")
                    pinInput.hint = "Wrong PIN - alarm keeps ringing"
                    hapticPress(pinInput)
                }
            }.apply { minHeight = dp(58) })
            overlay.addView(space(10))
            overlay.addView(label(
                "This is a hard alarm. It rings in 3-minute cycles until the PIN stops it.",
                11.5f, faint, false,
            ).apply { gravity = Gravity.CENTER })
        } else {
            overlay.addView(wideButton(
                when {
                    custom != null -> "Done"
                    isSleep -> "Going to bed"
                    else -> "I'm awake"
                },
            ) {
                if (custom != null) act(AlarmRingService.ACTION_DISMISS, "${custom.label} done.")
                else act(AlarmRingService.ACTION_AWAKE, "Routine logged.")
            }.apply { minHeight = dp(58) })
            overlay.addView(space(12))
            overlay.addView(buttonRow(
                quietButton("Snooze 10 min") { act(AlarmRingService.ACTION_SNOOZE, "Snoozed - rings again in 10 min.") },
                quietButton("Dismiss") { act(AlarmRingService.ACTION_DISMISS, "Alarm dismissed.") },
            ))
        }
        addContentView(overlay, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT,
        ))
        ringOverlay = overlay
        contentFrame.postDelayed(ringPoll, 700) // dismissed elsewhere → overlay follows
    }

    private fun hideRingingOverlay() {
        contentFrame.removeCallbacks(ringPoll)
        ringOverlay?.let { (it.parent as? ViewGroup)?.removeView(it) }
        ringOverlay = null
    }

    // Quick "what was that block of time?" logger. One line + a category →
    // pushed as a manual wellbeing session, lands in desktop screen time.
    private fun showGapLogDialog(startMs: Long, endMs: Long) {
        val fmt = java.text.SimpleDateFormat("HH:mm", Locale.US)
        val range = "${fmt.format(java.util.Date(startMs))}-${fmt.format(java.util.Date(endMs))}"
        val categories = arrayOf("productive", "leisure", "rest", "distraction")
        var picked = 1 // default: leisure
        val inputBox = EditText(this).apply {
            hint = "What were you doing? e.g. gym, class, nap..."
            setTextColor(textColor)
            setHintTextColor(faint)
            setPadding(dp(20), dp(12), dp(20), dp(12))
        }
        android.app.AlertDialog.Builder(this)
            .setTitle("Log $range")
            .setSingleChoiceItems(categories, picked) { _, which -> picked = which }
            .setView(inputBox)
            .setPositiveButton("Log it") { _, _ ->
                val what = inputBox.text.toString().trim().ifBlank { "Away from screens" }
                if (store.token.isNullOrBlank()) { statusText.text = "Pair first (Settings tab)."; return@setPositiveButton }
                runTask("Logging $range...") {
                    client().pushWellbeing(listOf(WellbeingSession(
                        date = java.time.LocalDate.now().toString(),
                        packageName = "manual.log.${startMs / 60000}",
                        appName = what,
                        category = categories[picked],
                        startedAt = java.time.Instant.ofEpochMilli(startMs).toString(),
                        endedAt = java.time.Instant.ofEpochMilli(endMs).toString(),
                        minutes = (endMs - startMs) / 60_000.0,
                    )), store.deviceId)
                    statusText.text = "Logged $what for $range."
                }
            }
            .setNegativeButton("Skip", null)
            .show()
    }

    override fun onResume() {
        super.onResume()
        if (::usageAccessText.isInitialized) { renderUsageAccess(); renderLocalUsage() }
        renderReadiness()
        maybeShowRingingOverlay()
        // Most reliable guard (re)start: the app is foreground here, so the
        // foreground-service start is always permitted. Keeps the blocker armed
        // even if the OS killed the service or a background start was denied.
        if (store.blockerEnabled && !store.token.isNullOrBlank()) ZenWatchService.start(this)
        startFocusPolling()
    }

    override fun onPause() {
        stopFocusPolling()
        super.onPause()
    }

    override fun onDestroy() {
        stopFocusPolling()
        scope.cancel()
        super.onDestroy()
    }

    // Live focus banner: while the app is on-screen, poll /focus every 12s so
    // toggling Zen / starting a timer on the desktop reflects on the phone
    // within seconds — no manual pull-to-refresh. (The persistent
    // ZenWatchService handles enforcement in the background; this only keeps
    // the in-app banner honest while the user is looking at it.)
    private val focusPoll = object : Runnable {
        override fun run() {
            if (currentTab == "today" && !store.token.isNullOrBlank()) checkFocusState()
            if (::contentFrame.isInitialized) contentFrame.postDelayed(this, FOCUS_POLL_MS)
        }
    }
    private fun startFocusPolling() {
        if (!::contentFrame.isInitialized) return
        contentFrame.removeCallbacks(focusPoll)
        contentFrame.postDelayed(focusPoll, FOCUS_POLL_MS)
    }
    private fun stopFocusPolling() {
        if (::contentFrame.isInitialized) contentFrame.removeCallbacks(focusPoll)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Layout: header / swappable content / bottom nav
    // ═══════════════════════════════════════════════════════════════════════
    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            // Deep vertical gradient instead of a flat fill — cards float on it.
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.parseColor("#0A0C11"), Color.parseColor("#0D1018"), Color.parseColor("#0A0D14")),
            )
        }

        root.addView(buildHeader().apply {
            setPadding(dp(16), dp(18), dp(16), dp(8))
        })

        // Transient status chip — appears on activity, slides away after a few
        // seconds so "Synced — n open tasks" doesn't nag forever.
        statusText = label("", 12.5f, muted, false).apply {
            setPadding(dp(14), dp(7), dp(14), dp(7))
            background = rounded(panel2, dp(12), border2)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).also { it.setMargins(dp(16), dp(2), dp(16), dp(8)) }
            visibility = View.GONE
            addTextChangedListener(object : android.text.TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun afterTextChanged(s: android.text.Editable?) {
                    removeCallbacks(hideStatusRunnable)
                    if (s.isNullOrBlank()) { visibility = View.GONE; return }
                    visibility = View.VISIBLE
                    alpha = 1f
                    postDelayed(hideStatusRunnable, 5_000)
                }
            })
        }
        root.addView(statusText)

        contentFrame = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        }
        root.addView(contentFrame)
        // Hairline above the nav so it reads as a docked bar, not a color block.
        root.addView(View(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
            setBackgroundColor(Color.parseColor("#222B3A"))
        })
        root.addView(buildBottomNav())
        setContentView(root)
    }

    private fun buildHeader(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val titleCol = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            // Gradient wordmark — same teal→blue ramp as the web app's logo.
            titleCol.addView(label("Apex", 26f, textColor, true).apply {
                post {
                    paint.shader = LinearGradient(
                        0f, 0f, paint.measureText(text.toString()), 0f,
                        intArrayOf(Color.parseColor("#7CF5E6"), accent, Color.parseColor("#2BA8D8")),
                        null, Shader.TileMode.CLAMP,
                    )
                    invalidate()
                }
            })
            addView(titleCol)
            statusDot = View(this@MainActivity).apply {
                layoutParams = LinearLayout.LayoutParams(dp(11), dp(11)).also { it.marginEnd = dp(12) }
                background = dot(amber)
            }
            addView(statusDot)
            addView(iconButton("⋮") { anchor -> showMenu(anchor) })
        }
    }

    private fun buildBottomNav(): LinearLayout {
        val navBg = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setBackgroundColor(panel)
            setPadding(dp(8), dp(6), dp(8), dp(10))
        }
        listOf(
            Triple("today", "☀", "Today"),
            Triple("tasks", "✓", "Tasks"),
            Triple("notes", "✎", "Notes"),
            Triple("activity", "▤", "Activity"),
            Triple("settings", "⚙", "Settings"),
        ).forEach { (key, glyph, title) ->
            val btn = TextView(this).apply {
                tag = "$glyph\n$title" // base label; updateNavBadges() appends counts
                text = "$glyph\n$title"
                gravity = Gravity.CENTER
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                setTextColor(muted)
                setLineSpacing(dp(2).toFloat(), 1f)
                background = rippleRounded(Color.TRANSPARENT, dp(10), Color.TRANSPARENT)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                setPadding(0, dp(6), 0, dp(6))
                setOnClickListener {
                    hapticTap(this)
                    selectTab(key)
                }
            }
            navButtons[key] = btn
            navBg.addView(btn)
        }
        return navBg
    }

    private fun selectTab(key: String) {
        if (key == currentTab) return
        currentTab = key
        navButtons.forEach { (k, b) ->
            val active = k == key
            b.setTextColor(if (active) accent else muted)
            b.setTypeface(null, if (active) Typeface.BOLD else Typeface.NORMAL)
            // Soft accent pill behind the active tab, with a small scale pop.
            b.background = rippleRounded(if (active) accentSoft else Color.TRANSPARENT, dp(12), Color.TRANSPARENT)
            if (active) {
                b.scaleX = 0.9f; b.scaleY = 0.9f
                b.animate().scaleX(1f).scaleY(1f).setDuration(180).start()
            }
        }
        contentFrame.removeAllViews()
        val view = tabViews.getOrPut(key) {
            scrollWrap(when (key) {
                "today" -> buildTodayTab()
                "tasks" -> buildTasksTab()
                "notes" -> buildNotesTab()
                "activity" -> buildActivityTab()
                else -> buildSettingsTab()
            })
        }
        contentFrame.addView(view)
        // Slide-up fade so tab switches feel intentional rather than abrupt.
        view.alpha = 0f
        view.translationY = dp(10).toFloat()
        view.animate().alpha(1f).translationY(0f)
            .setDuration(220).setInterpolator(DecelerateInterpolator()).start()
        when (key) {
            "tasks" -> renderTasks()
            "notes" -> renderNotesList()
            "activity" -> { renderUsageAccess(); renderLocalUsage() }
            "settings" -> { renderStoredState(); loadDevices() }
        }
    }

    private fun scrollWrap(content: View): SwipeRefreshLayout {
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            addView(content)
        }
        return SwipeRefreshLayout(this).apply {
            setColorSchemeColors(accent)
            setProgressBackgroundColorSchemeColor(panel2)
            addView(scroll)
            setOnRefreshListener { fullRefresh() }
            swipeLayouts.add(this)
        }
    }

    private fun fullRefresh() {
        if (store.token.isNullOrBlank()) {
            statusText.text = "Not paired - open Settings to pair."
            stopSpinners()
            renderLocalUsage()
            return
        }
        refreshFromServer()
        renderLocalUsage()
        if (currentTab == "settings") loadDevices()
    }

    private fun stopSpinners() {
        swipeLayouts.forEach { it.isRefreshing = false }
    }

    private fun tabColumn(builder: LinearLayout.() -> Unit): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(8), dp(16), dp(20))
            builder()
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Today
    // ═══════════════════════════════════════════════════════════════════════
    private fun buildTodayTab(): LinearLayout = tabColumn {
        val hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
        val greeting = when {
            hour < 5 -> "Late night ☽"
            hour < 12 -> "Good morning ☀"
            hour < 17 -> "Good afternoon"
            else -> "Good evening ☽"
        }
        addView(todayHero(
            greeting,
            java.time.LocalDate.now().format(
                java.time.format.DateTimeFormatter.ofPattern("EEEE, d MMMM"),
            ),
        ))
        addView(space(14))

        focusBanner = focusBannerCard()
        addView(focusBanner)
        addView(space(4))
        addView(card {
            addView(sectionTitle("Today's plan"))
            routineText = label("No routine loaded.", 14f, textColor, false)
            addView(routineText)
            addView(space(10))
            planBox = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(planBox)
        })
        addView(card {
            addView(sectionTitle("Alarms"))
            addView(label(
                "Routine times sync with desktop. Alarm sound, hard mode, and snooze controls stay on this phone.",
                12.2f, muted, false,
            ))
            addView(space(10))
            scheduleBox = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(scheduleBox)
            addView(space(10))
            addView(buttonRow(
                quietButton("Test wake alarm") {
                    AlarmRingService.ring(this@MainActivity, "wake_alarm")
                    statusText.text = "Test alarm ringing. Dismiss it from the alarm screen or notification."
                },
                quietButton(if (store.alarmPinHash == null) "Set alarm PIN" else "Alarm PIN") {
                    showSetPinDialog()
                },
            ))
        })
        addView(card {
            addView(sectionTitle("Quick capture"))
            addView(label(
                "One inbox, two destinations. Save a thought as a day note or turn the first line into a synced todo.",
                12.2f, muted, false,
            ))
            addView(space(10))
            val inputRow = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            quickCaptureInput = input("Write it here, then choose Note or Todo").apply {
                setSingleLine(false)
                minLines = 2
                gravity = Gravity.TOP
                inputType = InputType.TYPE_CLASS_TEXT or
                    InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                    InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                setPadding(dp(12), dp(10), dp(12), dp(10))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            inputRow.addView(quickCaptureInput)
            inputRow.addView(View(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
            inputRow.addView(iconButton("🎙") { launchVoiceTodo() })
            addView(inputRow)
            addView(space(12))
            // Two clearly-labelled destinations so note vs todo is never a guess.
            addView(buttonRow(
                captureChoice("✎  Note", "Save to Notes", accent) { addQuickNote() },
                captureChoice("✓  Todo", "Sync to Tasks", amber) { addQuickTodo() },
            ))
            addView(space(10))
            addView(buttonRow(
                quietButton("Open Notes") { selectTab("notes") },
                quietButton("Open Tasks") { selectTab("tasks") },
            ))
            addView(space(12))
            addView(label("Recent notes", 11f, faint, true).apply {
                letterSpacing = 0.08f
                text = text.toString().uppercase()
            })
            addView(space(8))
            todayNotesBox = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(todayNotesBox)
        })
        addView(card {
            addView(sectionTitle("Now"))
            addView(label(
                "Live routine nudges, due tasks, and focus state. If it is quiet here, the day is actually clear.",
                12.2f, muted, false,
            ))
            addView(space(10))
            remindersBox = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(remindersBox)
        })
        renderReminders()
        renderTodayNotes()
        renderScheduleControls()
    }

    private fun todayHero(greeting: String, date: String): LinearLayout {
        val paired = !store.token.isNullOrBlank()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            background = GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(Color.parseColor("#142032"), Color.parseColor("#101722")),
            ).apply {
                cornerRadius = dp(18).toFloat()
                setStroke(dp(1), Color.parseColor("#2B3A4D"))
            }
            elevation = dp(3).toFloat()
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).also { it.setMargins(0, 0, 0, dp(14)) }

            val top = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            top.addView(label("TODAY", 10.5f, accent, true).apply {
                letterSpacing = 0.14f
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            top.addView(statusPill(if (paired) "Synced" else "Pair setup", if (paired) green else amber))
            addView(top)
            addView(space(6))
            addView(label(greeting, 24f, textColor, true))
            addView(space(2))
            addView(label(
                date + if (paired) "  ·  tasks, notes, alarms linked" else "  ·  pair to sync",
                12.5f, if (paired) muted else amber, false,
            ))
        }
    }

    private fun focusBannerCard(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(12), dp(12), dp(12))
            background = rippleRounded(panel2, dp(16), accent)
            visibility = View.GONE
            isClickable = true
            setOnClickListener {
                hapticPress(this)
                confirmEmergencyStop()
            }

            val col = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            focusBannerTitle = label("", 14.5f, textColor, true)
            focusBannerDetail = label("", 11.8f, muted, false)
            col.addView(focusBannerTitle)
            col.addView(space(3))
            col.addView(focusBannerDetail)
            addView(col)
            addView(View(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(10), 1) })
            addView(baseButton("Stop", red, Color.WHITE) { confirmEmergencyStop() }.apply {
                minHeight = dp(42)
                setTypeface(typeface, Typeface.BOLD)
            })
        }
    }

    private fun renderTodayNotes() {
        if (!::todayNotesBox.isInitialized) return
        todayNotesBox.removeAllViews()
        val recent = notes.filter { it.body.isNotBlank() }.take(4)
        if (recent.isEmpty()) {
            todayNotesBox.addView(label("No notes yet. Capture one here or open Notes.", 12.5f, muted, false))
            return
        }
        recent.forEachIndexed { i, note ->
            if (i > 0) todayNotesBox.addView(space(8))
            todayNotesBox.addView(noteRow(note, compact = true))
        }
    }

    private fun noteRow(note: ApexNote, compact: Boolean = false): LinearLayout {
        val preview = note.body.trim().lineSequence().firstOrNull().orEmpty()
        val date = note.date.takeIf { it.isNotBlank() } ?: java.time.LocalDate.now().toString()
        return LinearLayout(this).apply {
            orientation = if (compact) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
            gravity = if (compact) Gravity.CENTER_VERTICAL else Gravity.NO_GRAVITY
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(panel2, dp(10), border2)
            val col = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = if (compact) {
                    LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                } else {
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                }
            }
            col.addView(label(note.title?.takeIf { it.isNotBlank() } ?: preview.take(48).ifBlank { "Phone note" }, 13.5f, textColor, false))
            col.addView(space(3))
            col.addView(label("${date.substring(5)} - ${preview.take(if (compact) 72 else 180)}", 11.5f, faint, false))
            addView(col)
            note.id?.let { id ->
                if (compact) {
                    addView(baseButton("Delete", panel, red) { deleteNote(id) }.apply { minHeight = dp(34) })
                } else {
                    setOnClickListener {
                        editingNoteId = id
                        if (::noteTitleInput.isInitialized) noteTitleInput.setText(note.title.orEmpty())
                        if (::noteBodyInput.isInitialized) noteBodyInput.setText(note.body)
                        if (::noteEditBadge.isInitialized) noteEditBadge.visibility = View.VISIBLE
                        statusText.text = "Editing note. Save updates it, Discard cancels."
                    }
                    addView(space(10))
                    addView(buttonRow(
                        quietButton("Use as todo") { addTaskFromText(note.title ?: preview, "Todo created from note") },
                        baseButton("Delete note", panel, red) { deleteNote(id) },
                    ))
                }
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Notes - full mobile day-note access synced through the API
    // ═══════════════════════════════════════════════════════════════════════
    private fun buildNotesTab(): LinearLayout = tabColumn {
        addView(card {
            val head = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            head.addView(sectionTitle("Write").apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            noteEditBadge = label("Editing", 11.5f, amber, true).apply { visibility = View.GONE }
            head.addView(noteEditBadge)
            addView(head)
            noteTitleInput = input("Title (optional)")
            addView(field("Title", noteTitleInput))
            noteBodyInput = input("What happened, what changed, what to remember...").apply {
                setSingleLine(false)
                minLines = 4
                gravity = Gravity.TOP
                inputType = InputType.TYPE_CLASS_TEXT or
                    InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                    InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                setPadding(dp(12), dp(10), dp(12), dp(10))
            }
            addView(field("Body", noteBodyInput))
            addView(buttonRow(
                actionButton("Save") { saveNoteFromEditor() },
                quietButton("Discard") { clearNoteEditor() },
            ))
        })
        addView(card {
            val head = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            head.addView(sectionTitle("All notes").apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            head.addView(baseButton("Sync", panel2, textColor) { refreshFromServer() }.apply { minHeight = dp(38) })
            addView(head)
            addView(space(6))
            noteSearchInput = input("Search notes...").apply {
                addTextChangedListener(object : android.text.TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                    override fun afterTextChanged(s: android.text.Editable?) { renderNotesList() }
                })
            }
            addView(noteSearchInput)
            addView(space(12))
            notesListBox = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(notesListBox)
        })
        renderNotesList()
    }

    private fun clearNoteEditor() {
        editingNoteId = null
        if (::noteTitleInput.isInitialized) noteTitleInput.setText("")
        if (::noteBodyInput.isInitialized) noteBodyInput.setText("")
        if (::noteEditBadge.isInitialized) noteEditBadge.visibility = View.GONE
    }

    private fun renderNotesList() {
        if (!::notesListBox.isInitialized) return
        notesListBox.removeAllViews()
        val q = if (::noteSearchInput.isInitialized) noteSearchInput.text.toString().trim().lowercase() else ""
        val visible = notes.filter {
            it.body.isNotBlank() &&
                (q.isBlank() || it.body.lowercase().contains(q) || (it.title ?: "").lowercase().contains(q))
        }
        if (visible.isEmpty()) {
            notesListBox.addView(label(
                if (q.isBlank()) "No notes yet. Write one above or capture from Today."
                else "No notes match \"$q\".",
                12.5f, muted, false,
            ))
            return
        }
        // Group by date with a small day label between groups.
        var lastDate = ""
        visible.forEach { note ->
            val d = note.date.ifBlank { "undated" }
            if (d != lastDate) {
                if (lastDate.isNotEmpty()) notesListBox.addView(space(12))
                notesListBox.addView(label(prettyDay(d), 10.5f, faint, true).apply {
                    letterSpacing = 0.08f
                    text = text.toString().uppercase()
                })
                notesListBox.addView(space(6))
                lastDate = d
            } else {
                notesListBox.addView(space(8))
            }
            notesListBox.addView(noteRow(note, compact = false))
        }
    }

    private fun prettyDay(iso: String): String {
        val today = java.time.LocalDate.now().toString()
        val yesterday = java.time.LocalDate.now().minusDays(1).toString()
        return when (iso) {
            today -> "Today"
            yesterday -> "Yesterday"
            else -> iso
        }
    }

    private fun saveNoteFromEditor() {
        val body = noteBodyInput.text.toString().trim()
        if (body.isBlank()) return
        if (store.token.isNullOrBlank()) { statusText.text = "Pair first (Settings tab)."; return }
        val title = noteTitleInput.text.toString().trim()
            .ifBlank { body.lineSequence().firstOrNull().orEmpty().take(80) }
            .ifBlank { "Phone note" }
        val noteId = editingNoteId
        runTask(if (noteId == null) "Saving note..." else "Updating note...") {
            val saved = client().saveNote(ApexNote(
                id = noteId,
                date = java.time.LocalDate.now().toString(),
                title = title,
                body = body,
                kind = "day_note",
                source = "mobile",
            ))
            clearNoteEditor()
            notes = listOf(saved) + notes.filter { it.id != saved.id }
            renderTodayNotes()
            renderNotesList()
            statusText.text = "Note synced."
        }
    }

    private fun deleteNote(id: String) {
        if (store.token.isNullOrBlank()) { statusText.text = "Pair first (Settings tab)."; return }
        runTask("Deleting note...") {
            client().deleteNote(id)
            if (editingNoteId == id) {
                editingNoteId = null
                if (::noteTitleInput.isInitialized) noteTitleInput.setText("")
                if (::noteBodyInput.isInitialized) noteBodyInput.setText("")
            }
            notes = notes.filter { it.id != id }
            renderTodayNotes()
            renderNotesList()
            statusText.text = "Note deleted."
        }
    }

    private fun renderScheduleControls() {
        if (!::scheduleBox.isInitialized) return
        scheduleBox.removeAllViews()
        val routine = currentRoutine
        val customs = store.customAlarms.sortedBy { it.hhmm }
        scheduleBox.addView(alarmOverviewRow(routine, customs))
        scheduleBox.addView(space(10))
        val wakeLoud = store.wakeStyle == "alarm"
        scheduleBox.addView(scheduleRow(
            title = "☀ Wake · ${routine?.wakeTime ?: "--:--"}",
            detail = (if (wakeLoud) "♪ ${store.wakeRingtoneName}" else "Quiet notification") + " · tap to change time",
            enabled = store.wakeAlarmEnabled,
            color = amber,
            onTimeTap = { showTimePicker("wake") },
            onToggle = { on ->
                store.wakeAlarmEnabled = on
                routine?.let { RoutineAlarmScheduler.scheduleConfigured(this, it) }
                renderScheduleControls()
            },
            actionText = if (wakeLoud) "♪ Sound" else null,
            onAction = if (wakeLoud) ({ pickWakeRingtone() }) else null,
            styleText = if (wakeLoud) "⏰ Alarm" else "Quiet",
            onStyleTap = {
                store.wakeStyle = if (wakeLoud) "quiet" else "alarm"
                renderScheduleControls()
                statusText.text = "Wake is now a ${if (store.wakeStyle == "alarm") "loud alarm" else "quiet reminder"}."
            },
        ))
        scheduleBox.addView(space(8))
        val sleepLoud = store.sleepStyle == "alarm"
        scheduleBox.addView(scheduleRow(
            title = "☽ Sleep · ${routine?.sleepTime ?: "--:--"}",
            detail = (if (sleepLoud) "♪ ${store.wakeRingtoneName}" else "Quiet notification") + " · tap to change time",
            enabled = store.sleepReminderEnabled,
            color = accent,
            onTimeTap = { showTimePicker("sleep") },
            onToggle = { on ->
                store.sleepReminderEnabled = on
                routine?.let { RoutineAlarmScheduler.scheduleConfigured(this, it) }
                renderScheduleControls()
            },
            actionText = null,
            onAction = null,
            styleText = if (sleepLoud) "⏰ Alarm" else "Quiet",
            onStyleTap = {
                store.sleepStyle = if (sleepLoud) "quiet" else "alarm"
                renderScheduleControls()
                statusText.text = "Sleep is now a ${if (store.sleepStyle == "alarm") "loud alarm" else "quiet reminder"}."
            },
        ))
        // Custom alarms: tap edits, long-press deletes, switch arms/disarms.
        customs.forEach { a ->
            scheduleBox.addView(space(8))
            scheduleBox.addView(customAlarmRow(a))
        }
        scheduleBox.addView(space(10))
        scheduleBox.addView(quietButton("＋ Add alarm") { showAlarmEditor(null) }.fullWidth())
    }

    private fun alarmOverviewRow(routine: ApexRoutine?, customs: List<CustomAlarm>): LinearLayout {
        val armedCustoms = customs.count { it.enabled }
        val armed = store.wakeAlarmEnabled || store.sleepReminderEnabled || armedCustoms > 0
        val parts = mutableListOf<String>()
        parts += "Wake ${routine?.wakeTime ?: "--"} ${if (store.wakeAlarmEnabled) store.wakeStyle else "off"}"
        parts += "Sleep ${routine?.sleepTime ?: "--"} ${if (store.sleepReminderEnabled) store.sleepStyle else "off"}"
        if (armedCustoms > 0) parts += "$armedCustoms custom"
        return readinessRow(
            if (armed) "Armed on this phone" else "No alarms armed",
            parts.joinToString(" - "),
            if (armed) green else faint,
        )
    }

    private fun customAlarmRow(a: CustomAlarm): LinearLayout {
        val violet = Color.parseColor("#B69CFF")
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rippleRounded(panel2, dp(12), if (a.enabled) (if (a.hard) red else violet) else border2)
            addView(View(this@MainActivity).apply {
                layoutParams = LinearLayout.LayoutParams(dp(9), dp(9)).also { it.marginEnd = dp(10) }
                background = dot(if (a.enabled) (if (a.hard) red else violet) else faint)
            })
            val col = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            col.addView(label("${a.hhmm} - ${a.label}" + if (a.hard) "  HARD" else "", 13.5f, textColor, true))
            col.addView(label(
                RoutineAlarmScheduler.describeDays(a) + if (a.hard) " - PIN to stop" else "",
                11.5f, if (a.enabled) muted else faint, false,
            ))
            addView(col)
            addView(android.widget.Switch(this@MainActivity).apply {
                isChecked = a.enabled
                tintSwitch(this)
                setOnCheckedChangeListener { buttonView, on ->
                    if (!buttonView.isPressed) return@setOnCheckedChangeListener
                    hapticTap(buttonView)
                    store.upsertAlarm(a.copy(enabled = on))
                    if (on) RoutineAlarmScheduler.scheduleCustom(this@MainActivity, a.copy(enabled = true))
                    else RoutineAlarmScheduler.cancelCustom(this@MainActivity, a.id)
                    renderScheduleControls()
                    statusText.text = "${a.label} ${if (on) "armed for ${a.hhmm}" else "off"}."
                }
            })
            setOnClickListener {
                hapticTap(this)
                showAlarmEditor(a)
            }
            setOnLongClickListener {
                android.app.AlertDialog.Builder(this@MainActivity)
                    .setTitle("Delete ${a.label}?")
                    .setPositiveButton("Delete") { _, _ ->
                        RoutineAlarmScheduler.cancelCustom(this@MainActivity, a.id)
                        store.removeAlarm(a.id)
                        renderScheduleControls()
                        statusText.text = "Alarm deleted."
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
                true
            }
        }
    }

    // ── custom alarm editor ──────────────────────────────────────────────
    private fun showAlarmEditor(existing: CustomAlarm?) {
        var hhmm = existing?.hhmm ?: "08:00"
        var hard = existing?.hard ?: false
        var once = existing?.once ?: false
        val pickedDays = (existing?.days ?: emptyList()).toMutableSet()

        val pad = dp(20)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, dp(12), pad, dp(4))
        }
        val labelInput = input("e.g. Gym, DSA hour, meds...").apply {
            setText(existing?.label ?: "")
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        }
        root.addView(field("Label", labelInput))

        val timeBtn = quietButton("Time $hhmm") {}
        timeBtn.setOnClickListener {
            val parts = hhmm.split(":")
            android.app.TimePickerDialog(this, { _, h, m ->
                hhmm = String.format("%02d:%02d", h, m)
                timeBtn.text = "Time $hhmm"
            }, parts[0].toIntOrNull() ?: 8, parts.getOrNull(1)?.toIntOrNull() ?: 0, true).show()
        }
        root.addView(timeBtn.fullWidth())
        root.addView(space(12))

        root.addView(label("REPEAT - leave all off for every day", 10.5f, faint, true))
        root.addView(space(6))
        val daysBar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val dayNames = listOf("M", "T", "W", "T", "F", "S", "S")
        lateinit var refreshDays: () -> Unit
        val dayChips = dayNames.mapIndexed { i, name ->
            val iso = i + 1
            baseButton(name, panel2, textColor) {
                if (!pickedDays.add(iso)) pickedDays.remove(iso)
                refreshDays()
            }.apply {
                minHeight = dp(36)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    .also { it.marginEnd = dp(4) }
            }
        }
        refreshDays = {
            dayChips.forEachIndexed { i, c ->
                val active = (i + 1) in pickedDays
                c.background = rippleRounded(if (active) accent else panel2, dp(10), Color.TRANSPARENT)
                c.setTextColor(if (active) bg else textColor)
            }
        }
        dayChips.forEach { daysBar.addView(it) }
        refreshDays()
        root.addView(daysBar)
        root.addView(space(12))

        root.addView(toggleRow("One-time", "Disables itself after it rings once.", once) { once = it })
        root.addView(space(6))
        lateinit var hardToggleRefresh: () -> Unit
        val hardRow = toggleRow(
            "Hard mode",
            "No snooze, no dismiss - rings in 3-min cycles until your PIN stops it (or the phone is powered off).",
            hard,
        ) { on ->
            if (on && store.alarmPinHash == null) {
                showSetPinDialog(
                    onSet = { hard = true },
                    onCancel = { hard = false; hardToggleRefresh() },
                )
            } else hard = on
        }
        hardToggleRefresh = {
            (hardRow.getChildAt(1) as? android.widget.Switch)?.isChecked = hard
        }
        root.addView(hardRow)

        android.app.AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(if (existing == null) "New alarm" else "Edit alarm")
            .setView(ScrollView(this).apply { addView(root) })
            .setPositiveButton("Save") { _, _ ->
                val alarm = CustomAlarm(
                    id = existing?.id ?: "a${System.currentTimeMillis()}",
                    label = labelInput.text.toString().trim().ifBlank { "Alarm" }.take(60),
                    hhmm = hhmm,
                    enabled = true,
                    hard = hard,
                    days = pickedDays.sorted(),
                    once = once,
                )
                store.upsertAlarm(alarm)
                RoutineAlarmScheduler.scheduleCustom(this, alarm)
                renderScheduleControls()
                statusText.text = "${alarm.label} armed for ${alarm.hhmm}" +
                    (if (alarm.hard) " - hard mode" else "") + "."
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

        // PIN setup: two matching 4-8 digit entries. Used the first time hard
        // mode is enabled, and from Settings > System to change it.
    private fun showSetPinDialog(onSet: (() -> Unit)? = null, onCancel: (() -> Unit)? = null) {
        val pad = dp(20)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, dp(12), pad, dp(4))
        }
        fun pinField(hintText: String) = input(hintText).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
        }
        val p1 = pinField("4-8 digits")
        val p2 = pinField("Repeat it")
        root.addView(field("New alarm PIN", p1))
        root.addView(field("Confirm", p2))
        root.addView(label(
            "Stops hard-mode alarms. Don't pick something you can type half-asleep without waking up.",
            11.5f, faint, false,
        ))
        android.app.AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(if (store.alarmPinHash == null) "Set alarm PIN" else "Change alarm PIN")
            .setView(root)
            .setPositiveButton("Save") { _, _ ->
                val a = p1.text.toString().trim()
                val b = p2.text.toString().trim()
                when {
                    !a.matches(Regex("\\d{4,8}")) -> { statusText.text = "PIN must be 4-8 digits."; onCancel?.invoke() }
                    a != b -> { statusText.text = "PINs didn't match - try again."; onCancel?.invoke() }
                    else -> {
                        store.setAlarmPin(a)
                        if (::scheduleBox.isInitialized) renderScheduleControls()
                        statusText.text = "Alarm PIN saved."
                        onSet?.invoke()
                    }
                }
            }
            .setNegativeButton("Cancel") { _, _ -> onCancel?.invoke() }
            .setOnCancelListener { onCancel?.invoke() }
            .show()
    }

    // Clock picker → PUT the new time to the sync API, marked as a mobile edit
    // so the desktop adopts it instead of overwriting on its next push.
    private fun showTimePicker(kind: String) {
        val routine = currentRoutine ?: ApexRoutine(
            id = null, date = java.time.LocalDate.now().toString(),
            wakeTime = "07:00", sleepTime = "23:30", objective = null, linkedTaskId = null,
        )
        val current = (if (kind == "wake") routine.wakeTime else routine.sleepTime) ?: "07:00"
        val parts = current.split(":")
        val h = parts.getOrNull(0)?.toIntOrNull() ?: 7
        val m = parts.getOrNull(1)?.toIntOrNull() ?: 0
        android.app.TimePickerDialog(this, { _, hour, minute ->
            val hhmm = String.format("%02d:%02d", hour, minute)
            val next = if (kind == "wake") routine.copy(wakeTime = hhmm) else routine.copy(sleepTime = hhmm)
            if (store.token.isNullOrBlank()) {
                // Unpaired: keep it local so alarms still work.
                currentRoutine = next
                RoutineAlarmScheduler.scheduleConfigured(this, next)
                renderScheduleControls()
                statusText.text = "${if (kind == "wake") "Wake" else "Sleep"} time set to $hhmm (local only)."
                return@TimePickerDialog
            }
            runTask("Saving ${if (kind == "wake") "wake" else "sleep"} time...") {
                val saved = client().saveRoutineTimes(next)
                currentRoutine = saved
                RoutineAlarmScheduler.scheduleConfigured(this, saved)
                renderScheduleControls()
                if (::routineText.isInitialized) {
                    routineText.text = "Morning ${saved.wakeTime ?: "--"}   -   Night ${saved.sleepTime ?: "--"}" +
                        (saved.objective?.takeIf { it.isNotBlank() }?.let { "\nMain goal: $it" } ?: "")
                }
            statusText.text = "${if (kind == "wake") "Wake" else "Sleep"} time set to $hhmm. Desktop picks it up next sync."
            }
        }, h, m, true).show()
    }

    private fun scheduleRow(
        title: String,
        detail: String,
        enabled: Boolean,
        color: Int,
        onToggle: (Boolean) -> Unit,
        actionText: String?,
        onAction: (() -> Unit)?,
        onTimeTap: (() -> Unit)? = null,
        styleText: String? = null,
        onStyleTap: (() -> Unit)? = null,
    ): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(panel2, dp(12), if (enabled) color else border2)
            addView(View(this@MainActivity).apply {
                layoutParams = LinearLayout.LayoutParams(dp(9), dp(9)).also { it.marginEnd = dp(10) }
                background = dot(if (enabled) color else faint)
            })
            val col = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                if (onTimeTap != null) {
                    isClickable = true
                    setOnClickListener {
                        hapticTap(this)
                        onTimeTap()
                    }
                }
            }
            col.addView(label(title, 13.5f, textColor, true))
            col.addView(label(detail, 11.5f, if (enabled) muted else faint, false))

            val chipRow = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            if (styleText != null && onStyleTap != null) {
                chipRow.addView(quietButton(styleText, onStyleTap).apply {
                    minHeight = dp(32)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
                })
                chipRow.addView(View(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(6), 1) })
            }
            if (actionText != null && onAction != null) {
                chipRow.addView(quietButton(actionText, onAction).apply {
                    minHeight = dp(32)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f)
                })
            }
            if (chipRow.childCount > 0) {
                col.addView(space(6))
                col.addView(chipRow)
            }
            addView(col)
            
            addView(android.widget.Switch(this@MainActivity).apply {
                setOnCheckedChangeListener(null)
                isChecked = enabled
                tintSwitch(this)
                setOnCheckedChangeListener { buttonView, on ->
                    if (buttonView.isPressed) {
                        hapticTap(buttonView)
                        buttonView.post { onToggle(on) }
                    }
                }
            })
        }
    }

    // Human-readable ringtone name. getTitle() returns the bare media id
    // ("247") for some content URIs, so try MediaStore's TITLE column first.
    private fun ringtoneTitle(uri: Uri?): String {
        if (uri == null) return "Default alarm"
        runCatching {
            contentResolver.query(uri, arrayOf(android.provider.MediaStore.Audio.Media.TITLE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val t = c.getString(0)
                    if (!t.isNullOrBlank() && !t.matches(Regex("\\d+"))) return t
                }
            }
        }
        val fromRingtone = runCatching {
            RingtoneManager.getRingtone(this, uri)?.getTitle(this)
        }.getOrNull()
        return fromRingtone?.takeIf { it.isNotBlank() && !it.matches(Regex("\\d+")) }
            ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { !it.matches(Regex("\\d+")) }
            ?: "Custom sound"
    }

    private fun pickWakeRingtone() {
        val existing = store.wakeRingtoneUri?.let { runCatching { Uri.parse(it) }.getOrNull() }
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        val intent = Intent(RingtoneManager.ACTION_RINGTONE_PICKER)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_ALARM)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_TITLE, "Choose Apex wake alarm")
            .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
            .putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, existing)
        ringtoneLauncher.launch(intent)
    }

    private fun launchVoiceTodo() {
        if (store.token.isNullOrBlank()) { statusText.text = "Pair first (Settings tab)."; return }
        pendingVoiceTodo = true
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Say the todo")
        runCatching { speechLauncher.launch(intent) }.onFailure {
            pendingVoiceTodo = false
            statusText.text = "Voice capture unavailable on this phone."
        }
    }

    // Top 4 things on today's plate: overdue first, then due-today, then the
    // highest-priority open task. Tap to complete, just like the Tasks tab.
    private fun renderTodayPlan() {
        if (!::planBox.isInitialized) return
        planBox.removeAllViews()
        val today = java.time.LocalDate.now().toString()
        val open = tasks.filter { it.status != "done" && it.status != "archived" }
        val planned = (
            open.filter { (it.dueAt?.take(10) ?: "9999") < today } +
            open.filter { it.dueAt?.take(10) == today } +
            open.filter { it.dueAt == null && (it.priority ?: 3) <= 2 }
        ).distinctBy { it.id }.take(4)
        if (planned.isEmpty()) {
            planBox.addView(label(
                if (open.isEmpty()) "No open tasks. Quick-add below or pull from desktop."
                else "Nothing due today. ${open.size} open task${if (open.size == 1) "" else "s"} in the backlog.",
                12.5f, muted, false,
            ))
            return
        }
        planned.forEachIndexed { i, t ->
            if (i > 0) planBox.addView(space(8))
            planBox.addView(taskRow(t))
        }
    }

    private fun renderReminders() {
        if (!::remindersBox.isInitialized) return
        remindersBox.removeAllViews()
        if (reminders.isNotEmpty()) {
            remindersBox.addView(statusPill("${reminders.size} active", amber))
            remindersBox.addView(space(10))
            reminders.forEachIndexed { i, r ->
                if (i > 0) remindersBox.addView(space(8))
                remindersBox.addView(reminderRow(r))
            }
            return
        }
        // Never an empty void: show a compact digest of where the day stands.
        val open = tasks.count { it.status != "done" && it.status != "archived" }
        val nextDue = tasks
            .filter { it.status != "done" && it.status != "archived" && it.dueAt != null }
            .minByOrNull { it.dueAt!! }
        remindersBox.addView(readinessRow(
            "All clear",
            if (open > 0) "$open open task${if (open == 1) "" else "s"} waiting in Tasks" else "No routine or task needs action right now",
            green,
            onTap = { selectTab("tasks") },
        ))
        nextDue?.let {
            remindersBox.addView(space(8))
            remindersBox.addView(readinessRow(
                "Next due",
                "${it.title.take(44)} - ${it.dueAt!!.take(10).substring(5)}${hhmmOf(it.dueAt)}",
                amber,
                onTap = { selectTab("tasks") },
            ))
        }
        currentRoutine?.let {
            remindersBox.addView(space(8))
            remindersBox.addView(readinessRow(
                "Routine",
                "Wake ${it.wakeTime ?: "--"} - sleep ${it.sleepTime ?: "--"}" +
                    if (store.wakeAlarmEnabled || store.sleepReminderEnabled) " - alarms armed" else " - alarms off",
                if (store.wakeAlarmEnabled || store.sleepReminderEnabled) accent else faint,
                onTap = { selectTab("today") },
            ))
        }
    }

    private fun reminderRow(r: ApexReminder): LinearLayout {
        val tint = when {
            r.overdue -> red
            r.kind == "wake" -> amber
            r.kind == "sleep" -> accent
            else -> muted
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(panel2, dp(10), if (r.overdue) red else border2)
            addView(View(this@MainActivity).apply {
                layoutParams = LinearLayout.LayoutParams(dp(9), dp(9)).also { it.marginEnd = dp(12) }
                background = dot(tint)
            })
            val col = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            col.addView(label(r.title, 13.5f, textColor, false))
            if (r.overdue) col.addView(label("overdue", 11f, red, true))
            addView(col)
            when {
                r.kind == "wake" -> addView(baseButton("Log wake", panel, amber) { markRoutine("wake_done") }.apply {
                    minHeight = dp(34)
                })
                r.kind == "sleep" -> addView(baseButton("Wind down", panel, accent) { markRoutine("sleep_done") }.apply {
                    minHeight = dp(34)
                })
                r.kind == "focus_session" -> addView(baseButton("Ready", panel, green) { checkFocusState() }.apply {
                    minHeight = dp(34)
                })
                r.kind == "objective" -> addView(baseButton("Goal done", panel, accent) { markObjectiveDone() }.apply {
                    minHeight = dp(34)
                })
                r.task != null -> addView(baseButton("Done", panel, green) { completeReminderTask(r.task) }.apply {
                    minHeight = dp(34)
                })
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Tasks - interactive list synced both ways with the desktop
    // ═══════════════════════════════════════════════════════════════════════
    private fun buildTasksTab(): LinearLayout = tabColumn {
        addView(card {
            addView(sectionTitle("Todo capture"))
            addView(label(
                "Quick add is for low-friction capture. Details opens the desktop-style fields: priority, category, and deadline.",
                12.2f, muted, false,
            ))
            addView(space(10))
            addView(label("Written todo", 11f, faint, true).apply {
                letterSpacing = 0.08f
                text = text.toString().uppercase()
            })
            addView(space(6))
            taskAddInput = input("e.g. Submit DBMS assignment").apply {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
                setOnEditorActionListener { _, actionId, _ ->
                    if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_DONE) { addTask(); true } else false
                }
            }
            val row = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            taskAddInput.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            row.addView(taskAddInput)
            row.addView(View(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
            row.addView(actionButton("Add") { addTask() })
            addView(row)
            addView(space(4))
            addView(label("Enter = quick add. Details opens priority + deadline + category.", 11.5f, faint, false))
            addView(space(8))
            addView(buttonRow(
                quietButton("Details") { showTaskComposer() },
                quietButton("Speak todo") { launchVoiceTodo() },
            ))
        })
        addView(card {
            val head = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            head.addView(sectionTitle("Task list").apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            head.addView(baseButton("Sync", panel2, textColor) { refreshFromServer() }.apply { minHeight = dp(38) })
            addView(head)
            taskSummaryText = label("", 12.2f, muted, false)
            addView(taskSummaryText)
            addView(space(8))
            taskListBox = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(taskListBox)
        })
    }

    private fun nextWeekendDate(): java.time.LocalDate {
        var d = java.time.LocalDate.now()
        while (d.dayOfWeek != java.time.DayOfWeek.SATURDAY) d = d.plusDays(1)
        return d
    }

    // Full task composer: mirrors the desktop's task editor with priority,
    // category, and deadline.
    private fun showTaskComposer() {
        if (store.token.isNullOrBlank()) { statusText.text = "Pair first (Settings tab)."; return }
        var priority = 3
        var category = "Personal"
        var dueAt: String? = null

        val pad = dp(20)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, dp(12), pad, dp(4))
        }
        val titleInput = input("Task title").apply {
            setText(taskAddInput.text.toString().trim())
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        }
        root.addView(field("Title", titleInput))

        fun chipBar(options: List<String>, initial: String, onPick: (String) -> Unit): LinearLayout {
            lateinit var refresh: () -> Unit
            var current = initial
            val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            val chips = options.map { opt ->
                baseButton(opt, panel2, textColor) {
                    current = opt
                    onPick(opt)
                    refresh()
                }.apply {
                    minHeight = dp(36)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                        .also { it.marginEnd = dp(6) }
                }
            }
            refresh = {
                chips.forEachIndexed { i, c ->
                    val active = options[i] == current
                    c.background = rippleRounded(if (active) accent else panel2, dp(10), Color.TRANSPARENT)
                    c.setTextColor(if (active) bg else textColor)
                }
            }
            chips.forEach { bar.addView(it) }
            refresh()
            return bar
        }

        root.addView(label("PRIORITY", 10.5f, faint, true))
        root.addView(space(6))
        root.addView(chipBar(listOf("P1", "P2", "P3", "P4", "P5"), "P3") { priority = it.removePrefix("P").toInt() })
        root.addView(space(4))
        root.addView(label("P1 = urgent - P5 = someday", 10.5f, faint, false))
        root.addView(space(12))
        root.addView(label("CATEGORY", 10.5f, faint, true))
        root.addView(space(6))
        root.addView(chipBar(listOf("Academics", "DSA", "Project", "Personal"), "Personal") { category = it })
        root.addView(space(12))
        root.addView(label("DEADLINE", 10.5f, faint, true))
        root.addView(space(6))
        val dueLabel = label("No deadline", 12.5f, muted, false)
        root.addView(chipBar(listOf("None", "Tonight", "Tmw", "Sat", "Pick..."), "None") { opt ->
            val today = java.time.LocalDate.now()
            when (opt) {
                "None" -> { dueAt = null; dueLabel.text = "No deadline" }
                "Tonight" -> { dueAt = "${today}T18:00:00"; dueLabel.text = "Today 18:00" }
                "Tmw" -> { dueAt = "${today.plusDays(1)}T09:00:00"; dueLabel.text = "Tomorrow 09:00" }
                "Sat" -> { dueAt = "${nextWeekendDate()}T10:00:00"; dueLabel.text = "${nextWeekendDate()} 10:00" }
                "Pick..." -> android.app.DatePickerDialog(this, { _, y, mo, d ->
                    android.app.TimePickerDialog(this, { _, h, min ->
                        dueAt = String.format("%04d-%02d-%02dT%02d:%02d:00", y, mo + 1, d, h, min)
                        dueLabel.text = dueAt!!.replace('T', ' ').dropLast(3)
                    }, 9, 0, true).show()
                }, today.year, today.monthValue - 1, today.dayOfMonth).show()
            }
        })
        root.addView(space(6))
        root.addView(dueLabel)

        android.app.AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("New task")
            .setView(root)
            .setPositiveButton("Add") { _, _ ->
                val title = titleInput.text.toString().trim()
                if (title.isBlank()) { statusText.text = "Task needs a title."; return@setPositiveButton }
                runTask("Adding task...") {
                    val created = client().saveTask(ApexTask(
                        id = null, title = title.take(220), status = "open",
                        dueAt = dueAt, source = "mobile",
                        priority = priority, category = category,
                    ))
                    taskAddInput.setText("")
                    tasks = listOf(created) + tasks
                    renderTasks()
                    statusText.text = "P$priority $category task added."
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun renderTasks() {
        // Badges + the Today plan depend on task data, not on the Tasks tab
        // having been opened — update them even when the list view isn't built.
        if (!::taskListBox.isInitialized) {
            updateNavBadges()
            renderTodayPlan()
            return
        }
        taskListBox.removeAllViews()
        val visibleTasks = tasks.filter { it.status != "archived" }
        val doneAll = visibleTasks.filter { it.status == "done" }
        if (::taskSummaryText.isInitialized) {
            val openCount = visibleTasks.count { it.status != "done" }
            val archivedCount = tasks.count { it.status == "archived" }
            taskSummaryText.text = "$openCount open - ${doneAll.size} completed - $archivedCount archived"
        }
        if (visibleTasks.isEmpty()) {
            val why = if (store.token.isNullOrBlank()) {
                "Not paired yet. Pair in Settings, then tasks flow in."
            } else {
                "Empty list = the desktop hasn't pushed yet (it syncs every ~15 min while open and paired). Add one above or tap Sync."
            }
            taskListBox.addView(label(why, 12.5f, muted, false))
            return
        }
        val today = java.time.LocalDate.now().toString()
        val open = visibleTasks.filter { it.status != "done" }
        val done = doneAll.take(8)
        val overdue = open.filter { (it.dueAt?.take(10) ?: "9999") < today }
        val dueToday = open.filter { it.dueAt?.take(10) == today }
        val upcoming = open.filter { (it.dueAt?.take(10) ?: "") > today }.sortedBy { it.dueAt }
        val someday = open.filter { it.dueAt == null }

        var first = true
        fun section(title: String, color: Int, items: List<ApexTask>) {
            if (items.isEmpty()) return
            if (!first) taskListBox.addView(space(14))
            first = false
            val sectionHead = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(label(title.uppercase(), 10.8f, color, true).apply {
                    letterSpacing = 0.08f
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                addView(statusPill(items.size.toString(), color))
            }
            taskListBox.addView(sectionHead)
            taskListBox.addView(space(6))
            items.forEachIndexed { i, t ->
                if (i > 0) taskListBox.addView(space(8))
                taskListBox.addView(taskRow(t))
            }
        }
        section("Overdue", red, overdue)
        section("Today", amber, dueToday)
        section("Upcoming", accent, upcoming)
        section("Someday", muted, someday)
        section("Done", faint, done)
        if (doneAll.isNotEmpty()) {
            if (doneAll.size > done.size) {
                taskListBox.addView(space(6))
                taskListBox.addView(label("Showing latest ${done.size} completed tasks.", 11.2f, faint, false))
            }
            taskListBox.addView(space(6))
            taskListBox.addView(quietButton("Archive completed (${doneAll.size})") {
                runTask("Archiving completed tasks...") {
                    doneAll.forEach { client().saveTask(it.copy(status = "archived")) }
                    refreshFromServer()
                    statusText.text = "Completed tasks archived."
                }
            }.fullWidth())
            taskListBox.addView(space(4))
            taskListBox.addView(label("Archived tasks stay in sync; they are just hidden from the active mobile list.", 11.2f, faint, false))
        }
        if (open.isEmpty()) {
            taskListBox.addView(space(10))
            taskListBox.addView(label("All caught up.", 13f, green, true))
        }
        updateNavBadges()
        renderTodayPlan()
    }

    // Open-task count on the Tasks nav item so the backlog is visible from
    // any tab. Base label lives in the view's tag.
    private fun updateNavBadges() {
        val btn = navButtons["tasks"] ?: return
        val base = btn.tag as? String ?: return
        val openCount = tasks.count { it.status != "done" && it.status != "archived" }
        btn.text = when {
            openCount <= 0 -> base
            openCount > 9 -> "$base 9+"
            else -> "$base $openCount"
        }
    }

    private fun prettyRecurrence(rule: String): String = when {
        rule == "daily" -> "repeats daily"
        rule.startsWith("day:") -> "repeats - day order ${rule.substringAfter(':')}"
        rule.startsWith("weekly:") -> "repeats weekly - ${rule.substringAfter(':').replaceFirstChar { it.uppercase() }}"
        else -> "repeats"
    }

    private fun taskRow(t: ApexTask): LinearLayout {
        val isDone = t.status == "done"
        val today = java.time.LocalDate.now().toString()
        val isOverdue = !isDone && (t.dueAt?.take(10) ?: "9999") < today
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(11), dp(12), dp(11))
            background = rippleRounded(panel2, dp(10), if (isOverdue) red else border2)

            val tick = TextView(this@MainActivity).apply {
                text = if (isDone) "✓" else "○"
                setTextColor(if (isDone) green else if (isOverdue) red else muted)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
                setPadding(0, 0, dp(12), 0)
            }
            addView(tick)

            val col = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            col.addView(label(t.title, 14f, if (isDone) faint else textColor, false).apply {
                if (isDone) paintFlags = paintFlags or Paint.STRIKE_THRU_TEXT_FLAG
            })
            val meta = listOfNotNull(
                t.recurrence?.let { prettyRecurrence(it) },
                t.dueAt?.let { due ->
                    val day = due.take(10)
                    when {
                        day == today -> "due today" + hhmmOf(due)
                        day < today -> "was due ${day.substring(5)}"
                        else -> "due ${day.substring(5)}" + hhmmOf(due)
                    }
                },
                t.priority?.takeIf { it <= 2 }?.let { "P$it" },
                t.courseCode,
                t.source?.takeIf { it == "mobile" }?.let { "added on phone" },
            ).joinToString("  -  ")
            if (meta.isNotBlank()) col.addView(label(meta, 11.5f, if (isOverdue) red else faint, false))
            addView(col)

            if (!isDone) {
                setOnClickListener { completeTask(t, tick) }
                setOnLongClickListener { showTaskMenu(t, it); true }
            } else {
                addView(View(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
                addView(baseButton("Archive", panel, red) {
                    runTask("Archiving...") {
                        client().saveTask(t.copy(status = "archived"))
                        refreshFromServer()
                        statusText.text = "Task archived."
                    }
                }.apply {
                    minHeight = dp(34)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                })
            }
        }
    }

    // "2026-06-10T18:00:00" → " 18:00"; date-only strings add nothing.
    private fun hhmmOf(due: String): String =
        if (due.length >= 16 && due[10] == 'T') " ${due.substring(11, 16)}" else ""

    private fun showTaskMenu(t: ApexTask, anchor: View) {
        PopupMenu(this, anchor).apply {
            menu.add(0, 1, 0, "Mark done")
            menu.add(0, 2, 1, "Due today 18:00")
            menu.add(0, 3, 2, "Due tomorrow 09:00")
            if (t.dueAt != null) menu.add(0, 4, 3, "Clear due date")
            menu.add(0, 5, 4, "Delete")
            setOnMenuItemClickListener { item ->
                val today = java.time.LocalDate.now()
                when (item.itemId) {
                    1 -> rescheduleTask(t.copy(status = "done"), "Done")
                    2 -> rescheduleTask(t.copy(dueAt = "${today}T18:00:00"), "Due today 18:00")
                    3 -> rescheduleTask(t.copy(dueAt = "${today.plusDays(1)}T09:00:00"), "Due tomorrow 09:00")
                    4 -> rescheduleTask(t.copy(dueAt = null), "Due date cleared")
                    5 -> deleteTask(t)
                }
                true
            }
            show()
        }
    }

    private fun deleteTask(t: ApexTask) {
        if (store.token.isNullOrBlank() || t.id == null) return
        runTask("Deleting todo...") {
            client().deleteTask(t.id)
            tasks = tasks.filter { it.id != t.id }
            renderTasks()
            statusText.text = "Todo deleted."
        }
    }

    private fun rescheduleTask(updated: ApexTask, doneMsg: String) {
        if (store.token.isNullOrBlank() || updated.id == null) return
        runTask("Updating...") {
            client().saveTask(updated)
            tasks = tasks.map { if (it.id == updated.id) updated else it }
            renderTasks()
            statusText.text = "${updated.title.take(36)} - $doneMsg"
        }
    }

    private fun completeTask(t: ApexTask, tick: TextView) {
        if (store.token.isNullOrBlank() || t.id == null) return
        hapticConfirm(tick)
        tick.text = "✓"; tick.setTextColor(green)
        runTask("Completing...") {
            client().saveTask(t.copy(status = "done"))
            tasks = tasks.map { if (it.id == t.id) it.copy(status = "done") else it }
            renderTasks()
            statusText.text = "${t.title.take(40)} marked done."
        }
    }

    private fun addTask(dueAt: String? = null) {
        val title = taskAddInput.text.toString().trim()
        if (addTaskFromText(title, if (dueAt == null) "Todo added" else "Todo scheduled", dueAt)) {
            taskAddInput.setText("")
        }
    }

    private fun addQuickTodo() {
        if (!::quickCaptureInput.isInitialized) return
        val title = quickCaptureInput.text.toString().trim()
        if (addTaskFromText(title.lineSequence().firstOrNull().orEmpty().take(180), "Todo added")) {
            quickCaptureInput.setText("")
        }
    }

    private fun addTaskFromText(rawTitle: String, doneMsg: String = "Todo added", dueAt: String? = null): Boolean {
        val title = rawTitle.trim()
        if (title.isBlank()) return false
        if (store.token.isNullOrBlank()) { statusText.text = "Pair first (Settings tab)."; return false }
        runTask("Adding todo...") {
            val created = client().saveTask(ApexTask(id = null, title = title.take(220), status = "open", dueAt = dueAt, source = "mobile"))
            tasks = listOf(created) + tasks
            renderTasks()
            statusText.text = "$doneMsg."
        }
        return true
    }

    private fun addQuickNote() {
        if (!::quickCaptureInput.isInitialized) return
        val body = quickCaptureInput.text.toString().trim()
        if (body.isBlank()) return
        if (store.token.isNullOrBlank()) { statusText.text = "Pair first (Settings tab)."; return }
        val firstLine = body.lineSequence().firstOrNull()?.trim().orEmpty()
        val title = firstLine.take(80).ifBlank { "Phone note" }
        runTask("Saving note...") {
            val created = client().saveNote(ApexNote(
                id = null,
                date = java.time.LocalDate.now().toString(),
                title = title,
                body = body,
                kind = "day_note",
                source = "mobile",
            ))
            quickCaptureInput.setText("")
            notes = listOf(created) + notes.filter { it.id != created.id }
            renderTodayNotes()
            renderNotesList()
            statusText.text = "Note saved - desktop Day Notes will import it."
        }
    }

    private fun completeReminderTask(task: ApexTask) {
        if (store.token.isNullOrBlank() || task.id == null) return
        runTask("Completing reminder...") {
            val done = task.copy(status = "done")
            client().saveTask(done)
            tasks = tasks.map { if (it.id == task.id) done else it }
            reminders = client().dueReminders()
            renderTasks()
            renderReminders()
            statusText.text = "Reminder task done."
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Activity
    // ═══════════════════════════════════════════════════════════════════════
    private fun buildActivityTab(): LinearLayout = tabColumn {
        addView(card {
            addView(sectionTitle("Screen time"))
            usageTotalText = label("Loading phone activity...", 28f, textColor, true)
            addView(usageTotalText)
            usageInsightText = label("", 12.5f, muted, false)
            addView(usageInsightText)
            addView(space(12))
            usageBarsBox = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(usageBarsBox)
            addView(space(12))
            syncText = label(lastUploadLabel(), 12.5f, muted, false)
            addView(syncText)
            addView(space(12))
            bgSyncButton = quietButton(if (store.autoSync) "Auto sync on" else "Auto sync off") { toggleAutoSync() }
            addView(buttonRow(
                actionButton("Sync now") { syncUsage() },
                bgSyncButton,
            ))
        })
    }

    private fun categoryColor(category: String?): Int = when (category) {
        "productive" -> green
        "distraction" -> red
        "leisure" -> amber
        else -> accent
    }

    private fun fmtMins(total: Int): String {
        val h = total / 60; val m = total % 60
        return if (h > 0) "${h}h ${m}m" else "${m}m"
    }

    private fun metricStrip(productive: Int, distraction: Int, leisure: Int): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(metricChip("Focus", fmtMins(productive), green, 1f))
            addView(View(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
            addView(metricChip("Watch", fmtMins(distraction), red, 1f))
            addView(View(this@MainActivity).apply { layoutParams = LinearLayout.LayoutParams(dp(8), 1) })
            addView(metricChip("Leisure", fmtMins(leisure), amber, 1f))
        }
    }

    private fun metricChip(title: String, value: String, color: Int, weight: Float): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(panel2, dp(12), color)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, weight)
            addView(label(value, 16f, textColor, true))
            addView(label(title, 10.5f, color, true).apply {
                letterSpacing = 0.08f
                text = text.toString().uppercase()
            })
        }
    }

    private fun usageBarRow(name: String, minutes: Int, maxMinutes: Int, category: String?, launches: Int = 0, pkg: String? = null): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rippleRounded(panel2, dp(12), border2)
            if (pkg != null) {
                setOnLongClickListener {
                    android.app.AlertDialog.Builder(this@MainActivity)
                        .setTitle("Hide $name?")
                        .setMessage("Removes it from screen time on this phone and from desktop sync. Undo anytime with Unhide all.")
                        .setPositiveButton("Hide") { _, _ ->
                            store.ignoredPkgs = store.ignoredPkgs + pkg
                            renderLocalUsage()
                            statusText.text = "$name hidden from screen time."
                        }
                        .setNegativeButton("Cancel", null)
                        .show()
                    true
                }
            }
            val head = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            head.addView(label(name, 12.5f, textColor, false).apply {
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                maxLines = 1
            })
            head.addView(label(fmtMins(minutes) + if (launches > 0) " - ${launches}x" else "", 12f, muted, false))
            addView(head)
            addView(space(4))
            // Proportional bar: filled segment weighted by share of the top app.
            val frac = (minutes.toFloat() / maxMinutes.coerceAtLeast(1)).coerceIn(0.03f, 1f)
            val bar = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                weightSum = 1f
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(6))
            }
            bar.addView(View(this@MainActivity).apply {
                background = rounded(categoryColor(category), dp(3), Color.TRANSPARENT)
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, frac)
            })
            bar.addView(View(this@MainActivity).apply {
                layoutParams = LinearLayout.LayoutParams(0, 1, 1f - frac)
            })
            addView(bar)
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Settings - pairing front and center
    // ═══════════════════════════════════════════════════════════════════════
    private fun buildSettingsTab(): LinearLayout = tabColumn {
        addView(card {
            addView(sectionTitle("Connect to desktop"))
            pairBadge = label("", 14f, textColor, true).apply {
                setPadding(dp(12), dp(8), dp(12), dp(8))
                background = rounded(panel2, dp(10), border2)
            }
            addView(pairBadge)
            addView(space(8))
            pairDetailText = label("", 12.5f, muted, false)
            addView(pairDetailText)
            addView(space(12))
            usageAccessText = label("", 12.5f, muted, false)
            addView(wideButton("Scan desktop QR") { launchScan() })
            addView(space(10))

            val manualBody = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                visibility = View.GONE
            }
            var manualOpen = false
            lateinit var manualToggle: Button
            fun setManualOpen(open: Boolean) {
                manualOpen = open
                manualBody.visibility = if (open) View.VISIBLE else View.GONE
                manualToggle.text = if (open) "Hide manual pairing" else "Manual pairing code"
            }
            manualToggle = quietButton("Manual pairing code") {
                setManualOpen(!manualOpen)
            }.fullWidth()
            addView(manualToggle)
            addView(space(8))

            manualBody.addView(label(
                "Use this only if QR scan is unavailable. Generate a fresh 6 digit code on desktop.",
                11.5f, faint, false,
            ))
            manualBody.addView(space(8))
            apiBaseInput = input("https://apex.yashasviallen.is-a.dev").apply {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
                setText(store.apiBase)
            }
            manualBody.addView(field("Server", apiBaseInput))
            deviceInput = input("Android phone").apply { setText(store.deviceName) }
            manualBody.addView(field("Device name", deviceInput))
            codeInput = input("000000").apply { inputType = InputType.TYPE_CLASS_NUMBER }
            manualBody.addView(field("6 digit code", codeInput))
            pairButton = actionButton("Pair with code") { pairDevice() }.fullWidth()
            manualBody.addView(pairButton)
            addView(manualBody)
            addView(space(8))
            addView(quietButton("Check connection") { pingHealth(verbose = true) }.fullWidth())
            addView(space(8))
            addView(quietButton("Unpair this device") { forgetDevice() }.fullWidth())
        })
        addView(card {
            addView(sectionTitle("Web app"))
            addView(label(
                "Apex in any browser - tasks, notes, phone screen time and live Zen status, " +
                    "served straight from the sync API.",
                12.5f, muted, false,
            ))
            addView(space(10))
            addView(wideButton("Open web app") {
                val base = store.apiBase.trim().trimEnd('/').ifBlank { ApexStore.DEFAULT_API_BASE }
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("$base/web"))) }
                    .onFailure { statusText.text = "No browser available to open the web app." }
            })
            addView(space(6))
            addView(label(
                "First time in that browser? Mint a code on desktop (Settings > Mobile > Pair a phone) and type it there.",
                11f, faint, false,
            ))
        })
        addView(card {
            addView(sectionTitle("Sync readiness"))
            readinessBox = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(readinessBox)
            addView(space(10))
            addView(quietButton("Refresh server") { refreshFromServer() }.fullWidth())
            addView(space(8))
            addView(actionButton("Sync usage") { syncUsage() }.fullWidth())
            addView(space(8))
            addView(usageAccessText)
        })
        addView(card {
            addView(sectionTitle("Paired devices"))
            deviceCountText = label("Loading linked devices...", 12.5f, muted, false)
            addView(deviceCountText)
            addView(label(
                "Everything paired with the sync API - phones and desktops, no device limit. " +
                "If the desktop is missing here, it was unlinked: re-pair it from desktop " +
                "Settings > Mobile, or syncing to it stays off.",
                11.5f, faint, false,
            ))
            addView(space(10))
            devicesBox = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }
            addView(devicesBox)
            addView(space(10))
            addView(quietButton("Refresh device list") { loadDevices() }.fullWidth())
        })
        addView(card {
            addView(sectionTitle("Sharing"))
            addView(toggleRow(
                "Share app usage",
                "On by default - your phone's screen time feeds desktop Apex.",
                store.shareUsage,
            ) { on ->
                store.shareUsage = on
                renderReadiness()
                statusText.text = if (on) "Usage sharing on." else "Usage sharing off - nothing leaves this phone."
            })
            addView(space(10))
            addView(toggleRow(
                "Share app names",
                "Off sends package ids only (no readable app labels).",
                store.shareAppNames,
            ) { on ->
                store.shareAppNames = on
                renderReadiness()
            })
        })
        addView(card {
            addView(sectionTitle("Focus blocker"))
            addView(label(
                "When desktop Zen mode is running, block distraction apps on this phone too.",
                12.5f, muted, false,
            ))
            addView(space(8))
            addView(toggleRow(
                "Mirror desktop Zen mode",
                "Bounces distraction apps to home (needs ‘display over apps’) or nudges loudly.",
                store.blockerEnabled,
            ) { on ->
                store.blockerEnabled = on
                if (!on) {
                    ZenWatchService.stop(this@MainActivity)
                } else {
                    ZenWatchService.start(this@MainActivity)
                    // Background safety-net so the guard survives the app being
                    // closed even when background sync is off.
                    if (!store.token.isNullOrBlank()) WellbeingSyncWorker.enqueue(this@MainActivity)
                    checkFocusState()
                }
                renderReadiness()
                statusText.text = if (on) "Focus blocker armed." else "Focus blocker off."
            })
            addView(space(10))
            addView(quietButton("Allow display over other apps") {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:$packageName")))
            }.fullWidth())
        })
        addView(card {
            addView(sectionTitle("System"))
            val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            val exempt = pm.isIgnoringBatteryOptimizations(packageName)
            addView(label(
                if (exempt) "Battery optimization exempt. Background sync and alarms are reliable."
                else "Not exempt. The OS may delay background sync and kill the blocker. Fix below.",
                12.5f, if (exempt) green else amber, false,
            ))
            addView(space(10))
            addView(quietButton("Exempt from battery optimization") {
                try {
                    val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
                    if (pm.isIgnoringBatteryOptimizations(packageName)) {
                        statusText.text = "Already exempt from battery optimization."
                    } else {
                        @Suppress("BatteryLife")
                        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            android.net.Uri.parse("package:$packageName")))
                    }
                } catch (_: Exception) {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }.fullWidth())
            addView(space(8))
            addView(quietButton("Notification settings") {
                startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            }.fullWidth())
            addView(space(8))
            addView(quietButton(
                if (store.alarmPinHash == null) "Set alarm PIN (for hard alarms)" else "Change alarm PIN",
            ) { showSetPinDialog() }.fullWidth())
        })
        addView(card {
            addView(sectionTitle("About"))
            addView(label(
                "Apex Mobile pairs with your Apex desktop through the sync API. " +
                "Tasks, routine nudges, focus blocks, and phone usage flow both ways every sync cycle.",
                12.5f, muted, false,
            ))
            addView(space(8))
            val version = try {
                packageManager.getPackageInfo(packageName, 0).versionName
            } catch (_: Exception) { "?" }
            addView(label("Apex Mobile v$version", 11.5f, faint, false))
        })
    }

    // Palette tint shared by every Switch — the stock green clashes.
    private fun tintSwitch(sw: android.widget.Switch) {
        sw.thumbTintList = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
            intArrayOf(accent, muted),
        )
        sw.trackTintList = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
            intArrayOf(Color.argb(90, 56, 216, 196), border2),
        )
    }

    private fun toggleRow(title: String, sub: String, initial: Boolean, onChange: (Boolean) -> Unit): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            val col = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            col.addView(label(title, 14f, textColor, false))
            col.addView(label(sub, 11.5f, faint, false))
            addView(col)
            addView(android.widget.Switch(this@MainActivity).apply {
                isChecked = initial
                tintSwitch(this)
                setOnCheckedChangeListener { buttonView, on ->
                    if (buttonView.isPressed) hapticTap(buttonView)
                    onChange(on)
                }
            })
        }
    }

    private fun loadDevices() {
        if (!::devicesBox.isInitialized) return
        if (store.token.isNullOrBlank()) {
            devicesBox.removeAllViews()
            if (::deviceCountText.isInitialized) deviceCountText.text = "Pair first to see linked devices."
            devicesBox.addView(label("Pair first to see linked devices.", 12.5f, muted, false))
            return
        }
        scope.launch {
            val (selfId, list) = try { client().devices() } catch (e: Throwable) {
                devicesBox.removeAllViews()
                if (::deviceCountText.isInitialized) deviceCountText.text = "Device list unavailable."
                devicesBox.addView(label("Couldn't load devices: ${e.message}", 12.5f, red, false))
                return@launch
            }
            devicesBox.removeAllViews()
            if (::deviceCountText.isInitialized) {
                val phones = list.count { it.type != "desktop" }
                val desktops = list.count { it.type == "desktop" }
                deviceCountText.text = "${list.size} linked - ${phones} phone${if (phones == 1) "" else "s"} - ${desktops} desktop${if (desktops == 1) "" else "s"}"
            }
            list.forEachIndexed { i, d ->
                if (i > 0) devicesBox.addView(space(8))
                devicesBox.addView(deviceRow(d, d.id == selfId))
            }
        }
    }

    private fun deviceRow(d: DeviceInfo, isSelf: Boolean): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(panel2, dp(10), border2)
            addView(label(when (d.type) { "desktop" -> "PC"; "web" -> "WEB"; else -> "PHONE" }, 10.5f, textColor, true).apply {
                setPadding(0, 0, dp(12), 0)
                letterSpacing = 0.08f
            })
            val col = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            col.addView(label(d.name + if (isSelf) "  (this phone)" else "", 13.5f, if (isSelf) accent else textColor, isSelf))
            val since = d.createdAt?.take(10) ?: "?"
            val seen = d.lastSeenAt?.let { "seen ${shortTime(it)}" } ?: ""
            col.addView(label("paired since $since${if (seen.isNotBlank()) " - $seen" else ""}", 11f, faint, false))
            addView(col)
            addView(baseButton("Unlink", panel, red) { unlinkDevice(d, isSelf) }.apply {
                minHeight = dp(36)
            })
        }
    }

    private fun unlinkDevice(d: DeviceInfo, isSelf: Boolean) {
        runTask(if (isSelf) "Unpairing this phone..." else "Unlinking ${d.name}...") {
            client().revokeDevice(d.id)
            if (isSelf) {
                forgetDevice()
                statusText.text = "This phone unpaired."
            } else {
                statusText.text = "Unlinked ${d.name}."
            }
            loadDevices()
        }
    }

    // Emergency stop from the phone — POST /focus/stop; the desktop watcher
    // force-ends the block (even a locked Zen) and the banner clears.
    private fun confirmEmergencyStop() {
        if (store.token.isNullOrBlank()) { statusText.text = "Pair first to stop a desktop block."; return }
        hapticPress()
        android.app.AlertDialog.Builder(this)
            .setTitle("Stop focus everywhere?")
            .setMessage("This ends the active timer or Zen block on desktop and clears the phone blocker.")
            .setPositiveButton("Stop now") { _, _ ->
                hapticConfirm()
                runTask("Stopping focus...") {
                    client().stopFocus()
                    if (::focusBanner.isInitialized) focusBanner.visibility = View.GONE
                    statusText.text = "Focus block stopped."
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun checkFocusState() {
        if (store.token.isNullOrBlank()) return
        scope.launch {
            val focus = try { client().focus() } catch (_: Throwable) { return@launch }
            if (::focusBanner.isInitialized) {
                if (focus.active) {
                    val until = focus.endsAt?.let { "Until ${shortTime(it)}" } ?: "No end time set"
                    // mode-derived so a plain timer reads "FOCUS TIMER" and a
                    // Zen block reads "ZEN - STRICT" etc. (was always strict).
                    val eff = focus.effectiveIntensity
                    val heading = if (eff == "notify") "⏱ Focus timer active" else "🛡 Zen ${eff.uppercase()} active"
                    focusBannerTitle.text = heading
                    focusBannerTitle.setTextColor(if (eff == "notify") accent else amber)
                    focusBannerDetail.text = "${focus.title ?: "Focus"} - $until. Stop ends it on desktop and phone."
                    focusBanner.background = rippleRounded(panel2, dp(16), if (eff == "notify") accent else amber)
                    focusBanner.visibility = View.VISIBLE
                } else {
                    focusBanner.visibility = View.GONE
                }
            }
            // The guard is persistent: run it whenever the blocker is on (it
            // polls /focus itself and enforces only while a block is live), so a
            // desktop Zen that starts later is caught within seconds instead of
            // waiting for the app to be reopened.
            if (store.blockerEnabled) {
                ZenWatchService.start(this@MainActivity)
            } else {
                ZenWatchService.stop(this@MainActivity)
            }
        }
    }

    private fun showMenu(anchor: View) {
        PopupMenu(this, anchor).apply {
            menu.add(0, 1, 0, "Refresh from server")
            menu.add(0, 2, 1, "Sync usage now")
            menu.add(0, 3, 2, if (store.autoSync) "Turn background sync off" else "Turn background sync on")
            menu.add(0, 4, 3, "Check connection")
            setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    1 -> refreshFromServer()
                    2 -> syncUsage()
                    3 -> toggleAutoSync()
                    4 -> pingHealth(verbose = true)
                }
                true
            }
            show()
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Pairing (QR + manual)
    // ═══════════════════════════════════════════════════════════════════════
    private fun launchScan() {
        val opts = ScanOptions()
            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
            .setPrompt("Scan the Apex pairing QR shown on your desktop")
            .setBeepEnabled(false)
            .setOrientationLocked(false)
        scanLauncher.launch(opts)
    }

    private fun handleScan(raw: String) {
        selectTab("settings")
        var apiBase: String? = null
        var code: String? = null
        try {
            val j = JSONObject(raw)
            if (j.optString("type") == "apex_pair") {
                apiBase = j.optString("api_base").ifBlank { null }
                code = j.optString("code").ifBlank { null }
            }
        } catch (_: Exception) { /* not JSON - fall through */ }
        if (code == null) {
            val m = Regex("/pairing-codes/(\\d{6})").find(raw)
            code = m?.groupValues?.getOrNull(1) ?: raw.trim().takeIf { it.matches(Regex("\\d{6}")) }
        }
        if (apiBase != null) { apiBaseInput.setText(apiBase); store.apiBase = apiBase }
        if (code != null) {
            codeInput.setText(code)
            statusText.text = "Scanned code $code - pairing..."
            pairDevice()
        } else {
            statusText.text = "That QR didn't contain an Apex pairing code."
        }
    }

    private fun pairDevice() {
        val code = codeInput.text.toString().trim()
        if (code.length != 6) { statusText.text = "Enter the 6 digit pairing code."; return }
        if (::pairButton.isInitialized) { pairButton.isEnabled = false; pairButton.text = "Pairing..." }
        if (::pairBadge.isInitialized) {
            pairBadge.text = "PAIRING"
            pairBadge.setTextColor(amber)
            pairBadge.background = rounded(panel2, dp(10), amber)
        }
        runTask("Contacting server...") {
            try {
                val result = client().pair(code, deviceInput.text.toString().trim().ifBlank { store.deviceName })
                store.apiBase = result.apiBase
                store.token = result.token
                store.deviceId = result.deviceId
                store.deviceName = result.deviceName
                codeInput.setText("")
                renderStoredState()
                renderReadiness()
                hapticConfirm(pairBadge)
                statusText.text = "Paired. This phone is now linked."
                pingHealth()
                loadDevices()      // device list updates live, right where you are
                refreshFromServer()
            } finally {
                if (::pairButton.isInitialized) { pairButton.isEnabled = true; pairButton.text = "Pair with code" }
                renderStoredState() // resets the badge to PAIRED / NOT PAIRED even on failure
            }
        }
    }

    private fun forgetDevice() {
        store.clearToken()
        if (store.autoSync) { store.autoSync = false; WellbeingSyncWorker.cancel(this) }
        if (::bgSyncButton.isInitialized) bgSyncButton.text = bgSyncLabel()
        renderStoredState()
        renderReadiness()
        statusDot.background = dot(amber)
        statusText.text = "Device unpaired."
    }

    // ═══════════════════════════════════════════════════════════════════════
    // State rendering + server I/O
    // ═══════════════════════════════════════════════════════════════════════
    private fun renderStoredState() {
        if (!::pairBadge.isInitialized) return
        apiBaseInput.setText(store.apiBase)
        deviceInput.setText(store.deviceName)
        val paired = !store.token.isNullOrBlank()
        pairBadge.text = if (paired) "PAIRED - ${store.deviceName}" else "NOT PAIRED"
        pairBadge.setTextColor(if (paired) green else amber)
        pairBadge.background = rounded(panel2, dp(10), if (paired) green else amber)
        pairDetailText.text = if (paired) {
            buildString {
                append("API: ${store.apiBase}")
                store.deviceId?.let { append("\nDevice id: ${it.take(18)}...") }
                store.lastSyncAt?.let { append("\nLast usage upload: ${shortTime(it)}") }
            }
        } else {
            "Open desktop Apex, generate a phone pairing code, then scan the QR or enter the code here."
        }
        renderReadiness()
    }

    private fun renderUsageAccess() {
        if (!::usageAccessText.isInitialized) return
        if (WellbeingReader.hasUsageAccess(this)) {
            usageAccessText.visibility = View.GONE
        } else {
            usageAccessText.visibility = View.VISIBLE
            usageAccessText.text = "Usage Access off - tap here to enable"
            usageAccessText.setTextColor(amber)
            usageAccessText.setOnClickListener {
                startActivity(android.content.Intent(android.provider.Settings.ACTION_USAGE_ACCESS_SETTINGS))
            }
        }
        renderReadiness()
    }

    private fun renderLocalUsage() {
        if (!::usageTotalText.isInitialized) return
        if (!WellbeingReader.hasUsageAccess(this)) {
            usageTotalText.text = "Usage access off"
            if (::usageInsightText.isInitialized) usageInsightText.text = "Enable it once to turn this into a live mobile dashboard."
            usageBarsBox.removeAllViews()
            return
        }
        scope.launch {
            val sessions = try {
                withContext(Dispatchers.IO) { WellbeingReader.readToday(this@MainActivity) }
            } catch (_: Throwable) { emptyList() }
            usageBarsBox.removeAllViews()
            if (sessions.isEmpty()) {
                usageTotalText.text = "No activity yet"
                if (::usageInsightText.isInitialized) usageInsightText.text = "Open a few apps, then pull to refresh."
                return@launch
            }
            val total = sessions.sumOf { it.minutes }.roundToInt()
            val distraction = sessions.filter { it.category == "distraction" }.sumOf { it.minutes }.roundToInt()
            val productive = sessions.filter { it.category == "productive" }.sumOf { it.minutes }.roundToInt()
            val leisure = sessions.filter { it.category == "leisure" }.sumOf { it.minutes }.roundToInt()
            val top = sessions.take(7)
            val topDistraction = sessions.filter { it.category == "distraction" }.maxByOrNull { it.minutes }
            val topProductive = sessions.filter { it.category == "productive" }.maxByOrNull { it.minutes }
            usageTotalText.text = fmtMins(total)
            val unlocks = sessions.sumOf { it.launches }
            val blocked = store.blockedToday(java.time.LocalDate.now().toString())
            if (::usageInsightText.isInitialized) {
                usageInsightText.text = buildString {
                    topProductive?.let { append("Focus: ${it.appName ?: it.packageName.substringAfterLast('.')}") }
                    topDistraction?.let {
                        if (isNotBlank()) append(" - ")
                        append("Watch: ${it.appName ?: it.packageName.substringAfterLast('.')}")
                    }
                    if (unlocks > 0) { if (isNotBlank()) append(" - "); append("$unlocks app opens") }
                    if (blocked > 0) { if (isNotBlank()) append(" - "); append("$blocked blocked by Zen") }
                    if (isBlank()) append("Ready to sync to desktop Apex.")
                }
            }
            val maxMin = top.maxOf { it.minutes }.roundToInt()
            usageBarsBox.addView(metricStrip(productive, distraction, leisure))
            usageBarsBox.addView(space(14))
            top.forEachIndexed { i, s ->
                if (i > 0) usageBarsBox.addView(space(10))
                usageBarsBox.addView(usageBarRow(
                    s.appName ?: s.packageName.substringAfterLast('.'),
                    s.minutes.roundToInt(),
                    maxMin,
                    s.category,
                    s.launches,
                    s.packageName,
                ))
            }
            usageBarsBox.addView(space(8))
            usageBarsBox.addView(label("Long-press an app to hide it from screen time.", 10.5f, faint, false))
            val hidden = store.ignoredPkgs.size
            if (hidden > 0) {
                usageBarsBox.addView(space(6))
                usageBarsBox.addView(quietButton("$hidden hidden app${if (hidden == 1) "" else "s"} - Unhide all") {
                    store.ignoredPkgs = emptySet()
                    renderLocalUsage()
                    statusText.text = "All hidden apps restored."
                }.fullWidth())
            }
        }
    }

    private fun pingHealth(verbose: Boolean = false) {
        scope.launch {
            val ok = try { client().health().optBoolean("ok", false) } catch (_: Throwable) { false }
            setStatusDot(ok)
            if (verbose) statusText.text = if (ok) "Connected to the sync API." else "Can't reach the sync API."
            if (ok && !store.token.isNullOrBlank()) {
                try {
                    val me = client().me()
                    val name = me.optString("name").ifBlank { store.deviceName }
                    val seen = me.optString("last_seen_at")
                    if (::pairBadge.isInitialized) {
                        pairBadge.text = "PAIRED - $name"
                        pairBadge.setTextColor(green)
                        pairBadge.background = rounded(panel2, dp(10), green)
                        if (seen.isNotBlank()) {
                            pairDetailText.text = pairDetailText.text.toString() + "\nServer confirms token - seen ${shortTime(seen)}"
                        }
                    }
                } catch (_: Throwable) {
                    if (::pairBadge.isInitialized) {
                        pairBadge.text = "TOKEN INVALID - re-pair"
                        pairBadge.setTextColor(red)
                        pairBadge.background = rounded(panel2, dp(10), red)
                    }
                    if (verbose) statusText.text = "Pairing token rejected - scan a fresh QR."
                }
            }
        }
    }

    private fun client(): ApexApiClient {
        val base = (if (::apiBaseInput.isInitialized) apiBaseInput.text.toString() else store.apiBase)
            .trim().trimEnd('/').ifBlank { ApexStore.DEFAULT_API_BASE }
        store.apiBase = base
        if (::deviceInput.isInitialized) store.deviceName = deviceInput.text.toString()
        return ApexApiClient(base, tokenProvider = { store.token })
    }

    private fun refreshFromServer() {
        if (store.token.isNullOrBlank()) { return }
        runTask("Refreshing...") {
            val api = client()
            val routine = api.todayRoutine()
            currentRoutine = routine
            tasks = api.tasks()
            notes = api.notes()
            reminders = api.dueReminders()

            val routineLine = buildString {
                append("Morning ${routine.wakeTime ?: "--"}   -   Night ${routine.sleepTime ?: "--"}")
                routine.objective?.takeIf { it.isNotBlank() }?.let { append("\nMain goal: $it") }
            }
            store.lastRoutineSummary = routineLine
            if (::routineText.isInitialized) routineText.text = routineLine
            renderScheduleControls()
            renderReminders()
            renderTodayNotes()
            renderNotesList()
            renderTasks()
            checkFocusState()
            RoutineAlarmScheduler.scheduleConfigured(this, routine)
            val openCount = tasks.count { it.status != "done" }
            statusText.text = "Synced - $openCount open task${if (openCount == 1) "" else "s"}."
        }
    }

    private fun markRoutine(kind: String) {
        if (store.token.isNullOrBlank()) { statusText.text = "Pair first (Settings tab)."; return }
        runTask("Logging...") {
            client().markEvent(kind)
            reminders = client().dueReminders()
            renderReminders()
            statusText.text = "Logged."
        }
    }

    private fun markObjectiveDone() {
        if (store.token.isNullOrBlank()) { statusText.text = "Pair first (Settings tab)."; return }
        runTask("Marking goal...") {
            client().markEvent("objective_done")
            statusText.text = "Goal marked done."
            refreshFromServer()
        }
    }

    private fun syncUsage() {
        if (store.token.isNullOrBlank()) { statusText.text = "Pair first (Settings tab)."; return }
        if (!WellbeingReader.hasUsageAccess(this)) {
            statusText.text = "Enable Usage Access for Apex Mobile first."
            startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
            return
        }
        if (!store.shareUsage) {
            statusText.text = "Usage sharing is off (Settings > Sharing)."
            return
        }
        runTask("Reading phone usage...") {
            var sessions = WellbeingReader.readToday(this)
            if (!store.shareAppNames) sessions = sessions.map { it.copy(appName = null) }
            if (sessions.isEmpty()) { statusText.text = "No usage data found for today."; return@runTask }
            client().pushWellbeing(sessions, store.deviceId)
            val total = sessions.sumOf { it.minutes }.roundToInt()
            store.lastSyncAt = Instant.now().toString()
            if (::syncText.isInitialized) syncText.text = "Last upload: just now - ${sessions.size} apps, ${total}m"
            statusText.text = "Sync done."
            renderLocalUsage()
            renderReadiness()
        }
    }

    private fun bgSyncLabel(): String = if (store.autoSync) "Auto sync on" else "Auto sync off"
    private fun lastUploadLabel(): String = store.lastSyncAt?.let { "Last upload: ${shortTime(it)}" } ?: "Not synced yet."

    private fun toggleAutoSync() {
        val next = !store.autoSync
        if (next) {
            if (store.token.isNullOrBlank()) { statusText.text = "Pair first to enable background sync."; return }
            if (!WellbeingReader.hasUsageAccess(this)) {
                statusText.text = "Enable Usage Access first, then turn on background sync."
                startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
                return
            }
            store.autoSync = true
            WellbeingSyncWorker.enqueue(this)
            statusText.text = "Background sync on - uploads every couple of hours."
        } else {
            store.autoSync = false
            WellbeingSyncWorker.cancel(this)
            statusText.text = "Background sync off."
        }
        if (::bgSyncButton.isInitialized) bgSyncButton.text = bgSyncLabel()
        renderReadiness()
    }


    private fun renderReadiness() {
        if (!::readinessBox.isInitialized) return
        readinessBox.removeAllViews()
        val paired = !store.token.isNullOrBlank()
        readinessBox.addView(readinessRow(
            "Pairing",
            if (paired) "Token saved for ${store.deviceName}" else "Scan QR or enter code first",
            if (paired) green else amber,
        ))
        readinessBox.addView(space(8))
        val usage = WellbeingReader.hasUsageAccess(this)
        readinessBox.addView(readinessRow(
            "Usage Access",
            if (usage) "Can read app foreground time" else "Needs Android permission",
            if (usage) green else amber,
        ))
        readinessBox.addView(space(8))
        readinessBox.addView(readinessRow(
            "Sharing",
            if (store.shareUsage) "Usage upload enabled${if (store.shareAppNames) " with app names" else " with package ids only"}" else "Usage stays on this phone",
            if (store.shareUsage) green else faint,
        ))
        readinessBox.addView(space(8))
        readinessBox.addView(readinessRow(
            "Background sync",
            if (store.autoSync) "WorkManager scheduled when online" else "Manual sync only",
            if (store.autoSync) green else faint,
        ))
        readinessBox.addView(space(8))
        // Alarm visibility: ringing without a visible notification (or the
        // full-screen wake screen) is exactly the "unstoppable alarm" bug —
        // surface both switches here with tap-to-fix.
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        val notifOk = nm.areNotificationsEnabled()
        val fsiOk = Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent()
        readinessBox.addView(readinessRow(
            "Alarm display",
            when {
                !notifOk -> "Notifications blocked - the alarm would ring with no Dismiss button. Tap to fix."
                !fsiOk -> "Full-screen alarms not allowed - lock-screen wake-ups may hide. Tap to fix."
                else -> "Notification + full-screen wake screen allowed"
            },
            if (notifOk && fsiOk) green else red,
        ) {
            if (!notifOk) {
                startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            } else if (!fsiOk && Build.VERSION.SDK_INT >= 34) {
                startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT,
                    Uri.parse("package:$packageName")))
            }
        })
        readinessBox.addView(space(8))
        readinessBox.addView(readinessRow(
            "Zen blocker",
            if (store.blockerEnabled) "Mirrors desktop focus blocks" else "Desktop focus blocks only",
            if (store.blockerEnabled) green else faint,
        ))
        if (store.blockerEnabled) {
            val overlay = Settings.canDrawOverlays(this)
            readinessBox.addView(space(8))
            readinessBox.addView(readinessRow(
                "Overlay permission",
                if (overlay) "Can bounce distraction apps to home" else "Missing - blocker can only nudge",
                if (overlay) green else amber,
            ))
        }
    }

    private fun readinessRow(title: String, detail: String, tone: Int, onTap: (() -> Unit)? = null): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(10), dp(9), dp(10), dp(9))
            background = if (onTap != null) rippleRounded(panel2, dp(10), border2) else rounded(panel2, dp(10), border2)
            if (onTap != null) setOnClickListener {
                hapticTap(this)
                onTap()
            }
            addView(View(this@MainActivity).apply {
                layoutParams = LinearLayout.LayoutParams(dp(9), dp(9)).also { it.marginEnd = dp(10) }
                background = dot(tone)
            })
            val col = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            col.addView(label(title, 13.5f, textColor, true))
            col.addView(label(detail, 11.5f, muted, false))
            addView(col)
        }
    }

    private fun statusPill(textValue: String, tone: Int): TextView {
        return label(textValue, 11f, tone, true).apply {
            setPadding(dp(10), dp(5), dp(10), dp(5))
            background = rounded(Color.argb(34, Color.red(tone), Color.green(tone), Color.blue(tone)), dp(999), tone)
            letterSpacing = 0.05f
        }
    }

    private fun runTask(label: String, block: suspend () -> Unit) {
        statusText.text = label
        scope.launch {
            try { block() }
            catch (error: Throwable) { statusText.text = error.message ?: "Something failed." }
            finally { stopSpinners() }
        }
    }

    private fun hapticTap(view: View? = null) {
        val target = view ?: if (::contentFrame.isInitialized) contentFrame else null
        target?.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    }

    private fun hapticPress(view: View? = null) {
        val target = view ?: if (::contentFrame.isInitialized) contentFrame else null
        target?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    }

    private fun hapticConfirm(view: View? = null) {
        val target = view ?: if (::contentFrame.isInitialized) contentFrame else null
        target?.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // View builders
    // ═══════════════════════════════════════════════════════════════════════
    private fun card(content: LinearLayout.() -> Unit): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            // Soft vertical gradient + faint shadow so cards float instead of
            // sitting flat on the background.
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(Color.parseColor("#171D28"), Color.parseColor("#121722")),
            ).apply {
                cornerRadius = dp(18).toFloat()
                setStroke(dp(1), Color.parseColor("#2A3342"))
            }
            elevation = dp(3).toFloat()
            val params = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            params.setMargins(0, 0, 0, dp(14))
            layoutParams = params
            content()
        }
    }

    private fun field(title: String, input: EditText): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(label(title, 11f, muted, true))
            addView(space(4))
            addView(input)
            val params = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            )
            params.setMargins(0, 0, 0, dp(12))
            layoutParams = params
        }
    }

    private fun divider(): View {
        return View(this).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1))
            setBackgroundColor(border)
        }
    }

    private fun buttonRow(vararg buttons: Button): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            buttons.forEachIndexed { index, button ->
                if (index > 0) addView(View(this@MainActivity).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(8), 1)
                })
                button.layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                addView(button)
            }
        }
    }

    private fun Button.fullWidth(): Button = apply {
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    // Two-line capture tile: bold destination on top, muted explanation under
    // it, border tinted by destination so note vs todo reads at a glance.
    private fun captureChoice(title: String, sub: String, color: Int, onClick: () -> Unit): Button {
        val span = android.text.SpannableString("$title\n$sub")
        val split = title.length
        span.setSpan(android.text.style.RelativeSizeSpan(0.78f), split + 1, span.length, 0)
        span.setSpan(android.text.style.ForegroundColorSpan(muted), split + 1, span.length, 0)
        span.setSpan(android.text.style.StyleSpan(Typeface.BOLD), 0, split, 0)
        return Button(this).apply {
            text = span
            isAllCaps = false
            setTextColor(textColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            background = rippleRounded(panel2, dp(12), color)
            stateListAnimator = null
            minHeight = dp(62)
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setOnClickListener {
                hapticTap(this)
                onClick()
            }
        }
    }

    private fun actionButton(textValue: String, onClick: () -> Unit): Button =
        baseButton(textValue, accent, bg, onClick).apply { background = gradientRipple(dp(10)) }

    private fun quietButton(textValue: String, onClick: () -> Unit): Button =
        baseButton(textValue, panel2, textColor, onClick).apply {
            background = rippleRounded(panel2, dp(10), border2)
        }

    private fun wideButton(textValue: String, onClick: () -> Unit): Button =
        baseButton(textValue, accent, bg, onClick).apply {
            background = gradientRipple(dp(12))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            minHeight = dp(48)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            setTypeface(typeface, Typeface.BOLD)
        }

    private fun baseButton(textValue: String, color: Int, txtColor: Int, onClick: () -> Unit): Button {
        return Button(this).apply {
            text = textValue
            isAllCaps = false
            setTextColor(txtColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
            background = rippleRounded(color, dp(10), Color.TRANSPARENT)
            setPadding(dp(14), 0, dp(14), 0)
            minHeight = dp(42)
            stateListAnimator = null
            setOnClickListener {
                hapticTap(this)
                onClick()
            }
        }
    }

    private fun iconButton(glyph: String, onClick: (View) -> Unit): TextView {
        return TextView(this).apply {
            text = glyph
            setTextColor(textColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            gravity = Gravity.CENTER
            background = rippleRounded(panel2, dp(10), border2)
            val size = dp(40)
            layoutParams = LinearLayout.LayoutParams(size, size)
            setOnClickListener {
                hapticTap(this)
                onClick(this)
            }
        }
    }

    private fun input(hintText: String): EditText {
        return EditText(this).apply {
            hint = hintText
            setHintTextColor(faint)
            setTextColor(textColor)
            setSingleLine(true)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            background = rounded(panel2, dp(10), border2)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            // Teal border while focused so the active field is unmistakable.
            setOnFocusChangeListener { v, has ->
                v.background = rounded(panel2, dp(10), if (has) accent else border2)
            }
        }
    }

    // Section heading with a small teal tick bar — gives every card an anchor
    // point so the eye doesn't read each one as an undifferentiated blob.
    private fun sectionTitle(title: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, dp(10))
            addView(View(this@MainActivity).apply {
                layoutParams = LinearLayout.LayoutParams(dp(3), dp(15)).also { it.marginEnd = dp(8) }
                background = rounded(accent, dp(2), Color.TRANSPARENT)
            })
            addView(label(title, 16.5f, textColor, true))
        }
    }

    private fun label(value: String, sp: Float, color: Int, bold: Boolean): TextView {
        return TextView(this).apply {
            text = value
            setTextColor(color)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
            // Real medium weight — faux-bold smears on dark backgrounds.
            if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setLineSpacing(dp(3).toFloat(), 1.0f)
        }
    }

    private fun space(height: Int): View =
        View(this).apply { layoutParams = LinearLayout.LayoutParams(1, dp(height)) }

    private fun dot(color: Int): GradientDrawable =
        GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }

    // Connected = soft breathing pulse; offline = solid red, no motion.
    private var dotAnimator: android.animation.ObjectAnimator? = null
    private fun setStatusDot(ok: Boolean) {
        statusDot.background = dot(if (ok) green else red)
        dotAnimator?.cancel()
        if (ok) {
            dotAnimator = android.animation.ObjectAnimator.ofFloat(statusDot, "alpha", 1f, 0.4f, 1f).apply {
                duration = 2400
                repeatCount = android.animation.ValueAnimator.INFINITE
                start()
            }
        } else {
            statusDot.alpha = 1f
        }
    }

    private fun rounded(fill: Int, radius: Int, stroke: Int): GradientDrawable {
        return GradientDrawable().apply {
            setColor(fill)
            cornerRadius = radius.toFloat()
            if (stroke != Color.TRANSPARENT) setStroke(dp(1), stroke)
        }
    }

    private fun rippleRounded(fill: Int, radius: Int, stroke: Int): Drawable {
        val content = rounded(fill, radius, stroke)
        val mask = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = radius.toFloat() }
        return RippleDrawable(ColorStateList.valueOf(Color.parseColor("#33FFFFFF")), content, mask)
    }

    // Teal→blue ramp for primary actions, matching the web app's buttons.
    private fun gradientRipple(radius: Int): Drawable {
        val content = GradientDrawable(
            GradientDrawable.Orientation.LEFT_RIGHT,
            intArrayOf(accent, accent2),
        ).apply { cornerRadius = radius.toFloat() }
        val mask = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = radius.toFloat() }
        return RippleDrawable(ColorStateList.valueOf(Color.parseColor("#33FFFFFF")), content, mask)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()

    // ends_at / timestamps from the API are UTC ISO. Render them in the
    // phone's LOCAL zone — the old string-slice showed raw UTC (a 10:08 IST
    // block read as "04:08"), which looked like a broken/expired timer.
    private fun shortTime(iso: String): String = try {
        val instant = runCatching { java.time.Instant.parse(iso) }
            .getOrElse { java.time.OffsetDateTime.parse(iso).toInstant() }
        java.time.format.DateTimeFormatter.ofPattern("HH:mm")
            .withZone(java.time.ZoneId.systemDefault())
            .format(instant)
    } catch (_: Exception) { iso.substringAfter('T').take(5) }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7301)
        }
    }
}
