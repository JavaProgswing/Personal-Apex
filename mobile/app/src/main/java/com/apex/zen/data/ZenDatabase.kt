package com.apex.zen.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [FocusSession::class, BlockedApp::class, UsageHourly::class],
    version = 1,
    exportSchema = false,
)
abstract class ZenDatabase : RoomDatabase() {
    abstract fun focusSessions(): FocusSessionDao
    abstract fun blockedApps(): BlockedAppDao
    abstract fun usage(): UsageDao

    companion object {
        @Volatile private var instance: ZenDatabase? = null

        fun get(ctx: Context): ZenDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(
                    ctx.applicationContext,
                    ZenDatabase::class.java,
                    "apex_zen.db",
                ).build().also { instance = it }
            }
    }
}
