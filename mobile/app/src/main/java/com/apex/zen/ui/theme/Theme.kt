package com.apex.zen.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Palette mirrors the desktop Apex CSS custom properties so the two apps feel
// like siblings. Accent is the pale indigo used on the web dashboard.
private val Bg = Color(0xFF0B0D12)
private val BgElev = Color(0xFF12151C)
private val BgElev2 = Color(0xFF181C25)
private val Text = Color(0xFFE6E8EE)
private val TextMuted = Color(0xFF8A93A6)
private val Border = Color(0xFF262A34)

private val Accent = Color(0xFFA9B4FF)          // indigo-ish
private val ProductiveColor = Color(0xFF7FD99E) // green
private val DistractionColor = Color(0xFFE8806B)// warm red
private val LeisureColor = Color(0xFFE8C57A)    // amber
private val NeutralColor = Color(0xFF9EAAC2)    // slate

object ZenColors {
    val accent = Accent
    val productive = ProductiveColor
    val distraction = DistractionColor
    val leisure = LeisureColor
    val neutral = NeutralColor
    val border = Border
    val bgElev = BgElev
    val bgElev2 = BgElev2
    val textMuted = TextMuted
}

private val DarkScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF0B0D12),
    background = Bg,
    onBackground = Text,
    surface = BgElev,
    onSurface = Text,
    surfaceVariant = BgElev2,
    onSurfaceVariant = TextMuted,
    outline = Border,
    error = DistractionColor,
)

private val LightScheme = lightColorScheme(
    primary = Color(0xFF4A55C7),
    background = Color(0xFFF7F8FB),
    surface = Color.White,
)

@Composable
fun ApexZenTheme(
    useDark: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (useDark) DarkScheme else LightScheme,
        typography = ZenTypography,
        content = content,
    )
}
