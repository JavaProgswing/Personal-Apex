package com.apex.zen.ui.screens

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.os.Process
import android.provider.Settings
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.datastore.preferences.core.edit
import com.apex.zen.ApexZenApp
import com.apex.zen.settingsStore
import com.apex.zen.sync.ApexClient
import com.apex.zen.ui.theme.ZenColors
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Permission wizard + sync configuration.
 *
 * Permissions we walk the user through:
 *   1. Usage Access — needed to build the stats page
 *   2. Accessibility Service — needed for the blocker
 *   3. Notifications (Android 13+) — for the focus session countdown
 *   4. Ignore battery optimization — so the foreground service isn't killed
 */
@Composable
fun SettingsScreen() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    val hostFlow = remember { ctx.settingsStore.data.map { it[ApexZenApp.SYNC_HOST] ?: "" } }
    val tokenFlow = remember { ctx.settingsStore.data.map { it[ApexZenApp.SYNC_TOKEN] ?: "" } }
    val host by hostFlow.collectAsState(initial = "")
    val token by tokenFlow.collectAsState(initial = "")

    var hostDraft by remember(host) { mutableStateOf(host) }
    var tokenDraft by remember(token) { mutableStateOf(token) }
    var syncStatus by remember { mutableStateOf<String?>(null) }

    // Permission status — recomputed cheaply when the screen is shown.
    val usageAccessOk = remember { mutableStateOf(hasUsageAccess(ctx)) }
    val accessibilityOk = remember { mutableStateOf(isAccessibilityEnabled(ctx)) }
    LaunchedEffect(Unit) {
        usageAccessOk.value = hasUsageAccess(ctx)
        accessibilityOk.value = isAccessibilityEnabled(ctx)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            "Settings",
            style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = Color.White),
        )

        SectionHeading("Permissions")
        PermissionRow(
            title = "Usage access",
            sub = "Reads per-app foreground time for stats and sync.",
            granted = usageAccessOk.value,
            onFix = {
                ctx.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            },
        )
        PermissionRow(
            title = "Accessibility service",
            sub = "Lets Apex Zen detect when a blocked app is opened.",
            granted = accessibilityOk.value,
            onFix = {
                ctx.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            },
        )

        Spacer(Modifier.height(4.dp))
        SectionHeading("Sync with desktop Apex")
        Text(
            "Only pushes to your desktop over the same Wi-Fi. No cloud.",
            color = ZenColors.textMuted,
            fontSize = 12.sp,
        )

        TextFieldRow(
            label = "Desktop address",
            value = hostDraft,
            placeholder = "http://192.168.1.7:8427",
            onChange = { hostDraft = it },
        )
        TextFieldRow(
            label = "Pair token",
            value = tokenDraft,
            placeholder = "paste from desktop Settings",
            onChange = { tokenDraft = it },
        )

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(
                onClick = {
                    scope.launch {
                        ctx.settingsStore.edit {
                            it[ApexZenApp.SYNC_HOST] = hostDraft.trim()
                            it[ApexZenApp.SYNC_TOKEN] = tokenDraft.trim()
                        }
                        syncStatus = "Saved"
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = ZenColors.accent, contentColor = Color(0xFF0B0D12)),
            ) { Text("Save") }

            Button(
                onClick = {
                    scope.launch {
                        val h = ctx.settingsStore.data.first()[ApexZenApp.SYNC_HOST].orEmpty()
                        val t = ctx.settingsStore.data.first()[ApexZenApp.SYNC_TOKEN].orEmpty()
                        if (h.isBlank() || t.isBlank()) {
                            syncStatus = "Set address + token first"
                            return@launch
                        }
                        syncStatus = "Syncing…"
                        val result = ApexClient(h, t).sync(ctx)
                        syncStatus = result.fold(
                            onSuccess = { r -> "Uploaded ${r.focusCount} sessions, ${r.usageCount} rows" },
                            onFailure = { e -> "Sync failed: ${e.message}" },
                        )
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = ZenColors.bgElev2, contentColor = Color.White),
            ) { Text("Sync now") }
        }
        syncStatus?.let {
            Text(it, color = ZenColors.textMuted, fontSize = 12.sp)
        }
    }
}

@Composable
private fun SectionHeading(label: String) {
    Text(
        label.uppercase(),
        color = ZenColors.textMuted,
        fontSize = 11.sp,
        letterSpacing = 0.8.sp,
        modifier = Modifier.padding(top = 8.dp),
    )
}

@Composable
private fun PermissionRow(title: String, sub: String, granted: Boolean, onFix: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(ZenColors.bgElev, RoundedCornerShape(12.dp))
            .border(1.dp, ZenColors.border, RoundedCornerShape(12.dp))
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = Color.White, fontWeight = FontWeight.Medium)
            Text(sub, color = ZenColors.textMuted, fontSize = 12.sp)
        }
        if (granted) {
            Text("Granted", color = ZenColors.productive, fontSize = 12.sp)
        } else {
            Box(
                modifier = Modifier
                    .background(ZenColors.accent, RoundedCornerShape(8.dp))
                    .clickable { onFix() }
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            ) {
                Text("Fix", color = Color(0xFF0B0D12), fontWeight = FontWeight.Medium, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun TextFieldRow(label: String, value: String, placeholder: String, onChange: (String) -> Unit) {
    Column {
        Text(label, color = ZenColors.textMuted, fontSize = 12.sp)
        Spacer(Modifier.height(6.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .background(ZenColors.bgElev, RoundedCornerShape(10.dp))
                .border(1.dp, ZenColors.border, RoundedCornerShape(10.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = onChange,
                singleLine = true,
                textStyle = TextStyle(color = Color.White, fontSize = 14.sp),
                decorationBox = { inner ->
                    if (value.isEmpty()) Text(placeholder, color = ZenColors.textMuted)
                    inner()
                },
            )
        }
    }
}

private fun hasUsageAccess(ctx: Context): Boolean {
    val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
    val mode = appOps.unsafeCheckOpNoThrow(
        AppOpsManager.OPSTR_GET_USAGE_STATS,
        Process.myUid(),
        ctx.packageName,
    )
    return mode == AppOpsManager.MODE_ALLOWED
}

private fun isAccessibilityEnabled(ctx: Context): Boolean {
    val enabled = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
    return enabled.split(':').any { it.startsWith(ctx.packageName + "/") }
}
