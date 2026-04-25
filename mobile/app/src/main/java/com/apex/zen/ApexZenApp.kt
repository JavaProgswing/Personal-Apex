package com.apex.zen

import android.app.Application
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore

/**
 * App-wide singletons. DataStore lives here so settings (sync host + token)
 * can be read without touching Room.
 */
class ApexZenApp : Application() {
    companion object {
        val SYNC_HOST = stringPreferencesKey("sync_host")
        val SYNC_TOKEN = stringPreferencesKey("sync_token")
    }
}

val android.content.Context.settingsStore by preferencesDataStore(name = "apex_zen_settings")
