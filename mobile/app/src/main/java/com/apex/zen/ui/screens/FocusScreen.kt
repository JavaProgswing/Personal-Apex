package com.apex.zen.ui.screens

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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.apex.zen.services.FocusSessionService
import com.apex.zen.session.SessionState
import com.apex.zen.ui.theme.ZenColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow

/**
 * The primary screen. Two states:
 *  - Idle: duration picker chips + optional label + Start button
 *  - Running: big countdown, intercept counter, End button
 */
@Composable
fun FocusScreen() {
    val ctx = LocalContext.current
    val active by SessionState.activeSession.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 20.dp, vertical = 24.dp),
    ) {
        Text(
            "Apex Zen",
            style = TextStyle(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
        )
        Spacer(Modifier.height(4.dp))
        Text(
            if (active != null) "Focus session in progress" else "Ready when you are",
            color = ZenColors.textMuted,
        )

        Spacer(Modifier.height(32.dp))

        if (active == null) {
            IdleBody(onStart = { mins, label ->
                val intent = Intent(ctx, FocusSessionService::class.java)
                    .setAction(FocusSessionService.ACTION_START)
                    .putExtra(FocusSessionService.EXTRA_DURATION_MIN, mins)
                    .putExtra(FocusSessionService.EXTRA_LABEL, label)
                ctx.startForegroundService(intent)
            })
        } else {
            RunningBody(
                session = active!!,
                onEnd = {
                    val intent = Intent(ctx, FocusSessionService::class.java)
                        .setAction(FocusSessionService.ACTION_STOP)
                    ctx.startService(intent)
                },
            )
        }
    }
}

@Composable
private fun IdleBody(onStart: (mins: Int, label: String?) -> Unit) {
    val presets = listOf(15, 25, 45, 60, 90)
    var chosen by remember { mutableStateOf(25) }
    var label by remember { mutableStateOf("") }

    Text("Duration", color = ZenColors.textMuted, style = TextStyle(fontSize = 13.sp))
    Spacer(Modifier.height(10.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (p in presets) {
            DurationChip(
                minutes = p,
                selected = p == chosen,
                onClick = { chosen = p },
            )
        }
    }

    Spacer(Modifier.height(24.dp))
    Text("Label (optional)", color = ZenColors.textMuted, style = TextStyle(fontSize = 13.sp))
    Spacer(Modifier.height(8.dp))
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(ZenColors.bgElev, RoundedCornerShape(12.dp))
            .border(1.dp, ZenColors.border, RoundedCornerShape(12.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        BasicTextField(
            value = label,
            onValueChange = { label = it.take(40) },
            singleLine = true,
            textStyle = TextStyle(color = Color.White, fontSize = 15.sp),
            decorationBox = { inner ->
                if (label.isEmpty()) Text("e.g. DSA revision", color = ZenColors.textMuted)
                inner()
            },
        )
    }

    Spacer(Modifier.height(36.dp))
    Button(
        onClick = { onStart(chosen, label.trim().ifEmpty { null }) },
        modifier = Modifier.fillMaxWidth().height(54.dp),
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(containerColor = ZenColors.accent, contentColor = Color(0xFF0B0D12)),
    ) {
        Text("Start session", fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
    }
}

@Composable
private fun RunningBody(session: SessionState.Active, onEnd: () -> Unit) {
    // Tick once a second so the countdown animates without going through the DB.
    val now by remember { flow { while (true) { emit(System.currentTimeMillis()); delay(1_000) } } }
        .collectAsState(initial = System.currentTimeMillis())
    val remainingMs = (session.endsAt - now).coerceAtLeast(0)
    val mins = (remainingMs / 60_000).toInt()
    val secs = ((remainingMs % 60_000) / 1000).toInt()
    val totalMs = (session.endsAt - session.startedAt).coerceAtLeast(1)
    val progress = 1f - remainingMs.toFloat() / totalMs

    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = "%02d:%02d".format(mins, secs),
                style = TextStyle(fontSize = 72.sp, fontWeight = FontWeight.Light, color = Color.White),
                textAlign = TextAlign.Center,
            )
            session.label?.let {
                Spacer(Modifier.height(6.dp))
                Text(it, color = ZenColors.textMuted, fontSize = 15.sp)
            }
        }
    }

    Spacer(Modifier.height(36.dp))
    // Progress bar
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(6.dp)
            .background(ZenColors.bgElev, RoundedCornerShape(3.dp)),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(progress.coerceIn(0f, 1f))
                .height(6.dp)
                .background(ZenColors.accent, RoundedCornerShape(3.dp)),
        )
    }

    Spacer(Modifier.height(24.dp))
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        StatPill("Intercepted", "${session.interceptions}")
        StatPill("Planned", "${(totalMs / 60_000).toInt()} min")
    }

    Spacer(Modifier.height(36.dp))
    OutlinedButton(
        onClick = onEnd,
        modifier = Modifier.fillMaxWidth().height(50.dp),
        shape = RoundedCornerShape(14.dp),
    ) {
        Text("End session", color = ZenColors.distraction)
    }
}

@Composable
private fun DurationChip(minutes: Int, selected: Boolean, onClick: () -> Unit) {
    val bg = if (selected) ZenColors.accent else ZenColors.bgElev
    val fg = if (selected) Color(0xFF0B0D12) else Color.White
    Box(
        modifier = Modifier
            .background(bg, RoundedCornerShape(10.dp))
            .border(1.dp, ZenColors.border, RoundedCornerShape(10.dp))
            .clickable { onClick() }
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Text("$minutes m", color = fg, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun StatPill(label: String, value: String) {
    Column(horizontalAlignment = Alignment.Start) {
        Text(
            label.uppercase(),
            color = ZenColors.textMuted,
            fontSize = 11.sp,
            letterSpacing = 0.8.sp,
        )
        Spacer(Modifier.height(2.dp))
        Text(value, color = Color.White, fontWeight = FontWeight.Medium, fontSize = 17.sp)
    }
}
