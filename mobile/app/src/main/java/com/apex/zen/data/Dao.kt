package com.apex.zen.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface FocusSessionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(session: FocusSession): Long

    @Update
    suspend fun update(session: FocusSession)

    @Query("SELECT * FROM focus_sessions ORDER BY startedAt DESC LIMIT :limit")
    fun recent(limit: Int = 50): Flow<List<FocusSession>>

    @Query("SELECT * FROM focus_sessions WHERE syncedAt IS NULL ORDER BY startedAt")
    suspend fun unsynced(): List<FocusSession>

    @Query("UPDATE focus_sessions SET syncedAt = :ts WHERE id IN (:ids)")
    suspend fun markSynced(ids: List<Long>, ts: Long)

    @Query("SELECT * FROM focus_sessions WHERE endedAt IS NULL ORDER BY startedAt DESC LIMIT 1")
    suspend fun active(): FocusSession?
}

@Dao
interface BlockedAppDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(app: BlockedApp)

    @Query("DELETE FROM blocklist WHERE packageName = :pkg")
    suspend fun remove(pkg: String)

    @Query("SELECT * FROM blocklist ORDER BY displayName COLLATE NOCASE")
    fun all(): Flow<List<BlockedApp>>

    @Query("SELECT packageName FROM blocklist")
    suspend fun packages(): List<String>
}

@Dao
interface UsageDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(rows: List<UsageHourly>)

    @Query("SELECT * FROM usage_hourly WHERE date = :date ORDER BY minutes DESC")
    fun forDate(date: String): Flow<List<UsageHourly>>

    @Query("SELECT * FROM usage_hourly WHERE syncedAt IS NULL ORDER BY date, hour LIMIT 500")
    suspend fun unsynced(): List<UsageHourly>

    @Query("UPDATE usage_hourly SET syncedAt = :ts WHERE date = :date AND hour = :hour AND pkg = :pkg")
    suspend fun markSynced(date: String, hour: Int, pkg: String, ts: Long)
}
