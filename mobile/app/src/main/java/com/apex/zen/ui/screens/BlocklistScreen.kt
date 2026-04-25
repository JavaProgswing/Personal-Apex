package com.apex.zen.ui.screens

import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.apex.zen.data.BlockedApp
import com.apex.zen.data.ZenDatabase
import com.apex.zen.ui.theme.ZenColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Shows the current blocklist + a picker for adding installed apps.
 *
 * Apps are loaded with `queryIntentActivities` over ACTION_MAIN + CATEGORY_LAUNCHER
 * so we only see user-visible apps, not every service + provider on the phone.
 */
@Composable
fun BlocklistScreen() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val db = remember { ZenDatabase.get(ctx) }
    val blocked by db.blockedApps().all().collectAsState(initial = emptyList())

    var query by remember { mutableStateOf("") }
    var allApps by remember { mutableStateOf<List<InstalledApp>>(emptyList()) }
    var showPicker by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        allApps = withContext(Dispatchers.IO) { loadInstalledApps(ctx.packageManager) }
    }

    Column(modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 24.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "Blocklist",
                    style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = Color.White),
                )
                Text(
                    "${blocked.size} app${if (blocked.size == 1) "" else "s"} blocked during focus",
                    color = ZenColors.textMuted,
                    fontSize = 13.sp,
                )
            }
            Box(
                modifier = Modifier
                    .background(ZenColors.accent, RoundedCornerShape(10.dp))
                    .clickable { showPicker = !showPicker }
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Icon(Icons.Outlined.Add, contentDescription = "Add", tint = Color(0xFF0B0D12))
            }
        }

        Spacer(Modifier.height(16.dp))

        if (showPicker) {
            PickerBlock(
                query = query,
                onQueryChange = { query = it },
                candidates = allApps.filter {
                    val q = query.trim().lowercase()
                    q.isEmpty() || it.label.lowercase().contains(q) || it.pkg.lowercase().contains(q)
                }.take(50),
                alreadyBlocked = blocked.map { it.packageName }.toSet(),
                onPick = { app ->
                    scope.launch {
                        db.blockedApps().upsert(
                            BlockedApp(packageName = app.pkg, displayName = app.label)
                        )
                    }
                },
            )
            Spacer(Modifier.height(20.dp))
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(blocked) { app ->
                BlockedRow(
                    app = app,
                    onToggleSoft = {
                        scope.launch { db.blockedApps().upsert(app.copy(soft = it)) }
                    },
                    onRemove = {
                        scope.launch { db.blockedApps().remove(app.packageName) }
                    },
                )
            }
            if (blocked.isEmpty()) {
                item {
                    Text(
                        "Tap + to add an app. Instagram, YouTube and TikTok are the usual suspects.",
                        color = ZenColors.textMuted,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun PickerBlock(
    query: String,
    onQueryChange: (String) -> Unit,
    candidates: List<InstalledApp>,
    alreadyBlocked: Set<String>,
    onPick: (InstalledApp) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(ZenColors.bgElev, RoundedCornerShape(14.dp))
            .border(1.dp, ZenColors.border, RoundedCornerShape(14.dp))
            .padding(14.dp),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(ZenColors.bgElev2, RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                textStyle = TextStyle(color = Color.White, fontSize = 14.sp),
                singleLine = true,
                decorationBox = { inner ->
                    if (query.isEmpty()) Text("Search installed apps", color = ZenColors.textMuted)
                    inner()
                },
            )
        }
        Spacer(Modifier.height(12.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (app in candidates) {
                val blocked = app.pkg in alreadyBlocked
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(enabled = !blocked) { onPick(app) }
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .background(
                                if (blocked) ZenColors.textMuted else ZenColors.accent,
                                CircleShape,
                            ),
                    )
                    Spacer(Modifier.size(10.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(app.label, color = if (blocked) ZenColors.textMuted else Color.White)
                        Text(app.pkg, color = ZenColors.textMuted, fontSize = 11.sp)
                    }
                    if (blocked) Text("Added", color = ZenColors.textMuted, fontSize = 12.sp)
                }
            }
        }
    }
}

@Composable
private fun BlockedRow(
    app: BlockedApp,
    onToggleSoft: (Boolean) -> Unit,
    onRemove: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(ZenColors.bgElev, RoundedCornerShape(12.dp))
            .border(1.dp, ZenColors.border, RoundedCornerShape(12.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(app.displayName, color = Color.White, fontWeight = FontWeight.Medium)
            Text(app.packageName, color = ZenColors.textMuted, fontSize = 11.sp)
        }
        Text(
            if (app.soft) "Soft" else "Hard",
            color = ZenColors.textMuted,
            fontSize = 12.sp,
        )
        Spacer(Modifier.size(8.dp))
        Switch(
            checked = !app.soft,
            onCheckedChange = { onToggleSoft(!it) },
            colors = SwitchDefaults.colors(
                checkedThumbColor = ZenColors.distraction,
                checkedTrackColor = ZenColors.distraction.copy(alpha = 0.35f),
            ),
        )
        Spacer(Modifier.size(8.dp))
        Icon(
            Icons.Outlined.Close,
            contentDescription = "Remove",
            tint = ZenColors.textMuted,
            modifier = Modifier
                .clickable { onRemove() }
                .padding(4.dp),
        )
    }
}

private data class InstalledApp(val pkg: String, val label: String)

private fun loadInstalledApps(pm: PackageManager): List<InstalledApp> {
    val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    val resolved: List<ResolveInfo> = pm.queryIntentActivities(intent, 0)
    return resolved.asSequence()
        .map { ri ->
            InstalledApp(
                pkg = ri.activityInfo.packageName,
                label = ri.loadLabel(pm).toString(),
            )
        }
        .distinctBy { it.pkg }
        .sortedBy { it.label.lowercase() }
        .toList()
}
