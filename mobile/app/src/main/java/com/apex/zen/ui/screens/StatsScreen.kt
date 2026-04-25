package com.apex.zen.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.apex.zen.data.ZenDatabase
import com.apex.zen.sync.UsageSync
import com.apex.zen.ui.theme.ZenColors
import java.time.LocalDate
import java.time.format.DateTimeFormatter

@Composable
fun StatsScreen() {
    val ctx = LocalContext.current
    val db = remember { ZenDatabase.get(ctx) }
    val today = LocalDate.now().format(DateTimeFormatter.ISO_DATE)
    val usage by db.usage().forDate(today).collectAsState(initial = emptyList())
    val sessions by db.focusSessions().recent(7).collectAsState(initial = emptyList())

    // Ingest on screen enter. This is the cheap path — WorkManager covers the
    // background case but opening the stats page is the user saying "show me
    // the latest", so we refresh synchronously here too.
    LaunchedEffect(Unit) {
        try {
            UsageSync.ingest(ctx, since = System.currentTimeMillis() - 24L * 3600 * 1000)
        } catch (t: Throwable) {
            // Likely missing usage-access permission — the Settings screen has the fix.
        }
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Text(
                "Today",
                style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = Color.White),
            )
        }

        // Group hourly rows into per-app totals for a top-apps view.
        val byApp = usage.groupBy { it.pkg }
            .mapValues { (_, rows) -> rows.sumOf { it.minutes } }
            .entries
            .sortedByDescending { it.value }
            .take(12)
        val totalMins = byApp.sumOf { it.value }

        item {
            StatCard(
                headline = fmtMinutes(totalMins),
                sub = "on phone today",
            )
        }

        item { Text("Top apps", color = ZenColors.textMuted, fontSize = 13.sp) }
        items(byApp) { (pkg, mins) ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(ZenColors.bgElev, RoundedCornerShape(10.dp))
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(humanize(pkg), color = Color.White)
                    Text(pkg, color = ZenColors.textMuted, fontSize = 11.sp)
                }
                Text(fmtMinutes(mins), color = ZenColors.accent, fontWeight = FontWeight.Medium)
            }
        }

        item {
            Spacer(Modifier.height(12.dp))
            Text("Recent focus sessions", color = ZenColors.textMuted, fontSize = 13.sp)
        }
        items(sessions) { s ->
            val start = java.text.SimpleDateFormat("MMM d  HH:mm", java.util.Locale.getDefault()).format(java.util.Date(s.startedAt))
            val durMs = (s.endedAt ?: s.plannedEndAt) - s.startedAt
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .border(1.dp, ZenColors.border, RoundedCornerShape(10.dp))
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .background(
                            if (s.completed) ZenColors.productive.copy(alpha = 0.2f)
                            else ZenColors.distraction.copy(alpha = 0.18f),
                            RoundedCornerShape(6.dp),
                        )
                        .padding(horizontal = 8.dp, vertical = 3.dp),
                ) {
                    Text(
                        if (s.completed) "Completed" else "Ended early",
                        color = if (s.completed) ZenColors.productive else ZenColors.distraction,
                        fontSize = 11.sp,
                    )
                }
                Spacer(Modifier.padding(horizontal = 6.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(s.label ?: "Focus session", color = Color.White)
                    Text(start, color = ZenColors.textMuted, fontSize = 11.sp)
                }
                Text(fmtMinutes((durMs / 60_000).toInt()), color = ZenColors.textMuted)
            }
        }
    }
}

@Composable
private fun StatCard(headline: String, sub: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(ZenColors.bgElev, RoundedCornerShape(14.dp))
            .padding(18.dp),
    ) {
        Text(headline, color = Color.White, fontSize = 34.sp, fontWeight = FontWeight.Medium)
        Text(sub, color = ZenColors.textMuted, fontSize = 13.sp)
    }
}

private fun fmtMinutes(m: Int): String {
    if (m < 60) return "${m}m"
    val h = m / 60; val rem = m % 60
    return if (rem == 0) "${h}h" else "${h}h ${rem}m"
}

/** Small subset of the desktop app's humanization map — good enough for stats page. */
private fun humanize(pkg: String): String {
    val map = mapOf(
        "com.whatsapp" to "WhatsApp",
        "com.instagram.android" to "Instagram",
        "com.twitter.android" to "Twitter",
        "com.reddit.frontpage" to "Reddit",
        "com.google.android.youtube" to "YouTube",
        "com.spotify.music" to "Spotify",
        "com.netflix.mediaclient" to "Netflix",
        "com.discord" to "Discord",
        "org.telegram.messenger" to "Telegram",
        "in.startv.hotstar" to "Hotstar",
        "com.supercell.brawlstars" to "Brawl Stars",
    )
    return map[pkg] ?: pkg.substringAfterLast('.').replaceFirstChar { it.uppercase() }
}
