package com.apex.zen

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Analytics
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Timer
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import com.apex.zen.ui.screens.BlocklistScreen
import com.apex.zen.ui.screens.FocusScreen
import com.apex.zen.ui.screens.SettingsScreen
import com.apex.zen.ui.screens.StatsScreen
import com.apex.zen.ui.theme.ApexZenTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ApexZenTheme { ApexZenRoot() }
        }
    }
}

private enum class Tab(val labelRes: Int, val icon: ImageVector) {
    Focus(R.string.tab_focus, Icons.Outlined.Timer),
    Block(R.string.tab_blocklist, Icons.Outlined.Block),
    Stats(R.string.tab_stats, Icons.Outlined.Analytics),
    Settings(R.string.tab_settings, Icons.Outlined.Settings),
}

@Composable
private fun ApexZenRoot() {
    var tab by remember { mutableStateOf(Tab.Focus) }
    Scaffold(
        bottomBar = {
            NavigationBar {
                for (t in Tab.values()) {
                    NavigationBarItem(
                        selected = t == tab,
                        onClick = { tab = t },
                        icon = { androidx.compose.material3.Icon(t.icon, contentDescription = null) },
                        label = { Text(stringResource(t.labelRes)) },
                    )
                }
            }
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                Tab.Focus -> FocusScreen()
                Tab.Block -> BlocklistScreen()
                Tab.Stats -> StatsScreen()
                Tab.Settings -> SettingsScreen()
            }
        }
    }
}
