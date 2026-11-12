package dev.maxbuda.handoff

import android.content.Context
import android.os.VibrationEffect
import android.os.VibratorManager
import androidx.annotation.StringRes
import androidx.compose.ui.graphics.Color
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The app's accent color, chosen in Settings → Color. The same colors as the Apple Watch app. */
enum class Theme(@StringRes val label: Int, val color: Color) {
    Clay(R.string.clay, Color(0.85f, 0.47f, 0.34f)),
    Yellow(R.string.yellow, Color(0.98f, 0.80f, 0.20f)),
    Blue(R.string.blue, Color(0.25f, 0.56f, 0.98f)),
    Green(R.string.green, Color(0.30f, 0.78f, 0.45f)),
    Purple(R.string.purple, Color(0.66f, 0.45f, 0.95f)),
    Pink(R.string.pink, Color(0.98f, 0.42f, 0.62f)),
    Graphite(R.string.graphite, Color(0.62f, 0.62f, 0.62f)),
}

object Haptic {
    private fun play(c: Context, effect: VibrationEffect) {
        runCatching { c.getSystemService(VibratorManager::class.java)?.defaultVibrator?.vibrate(effect) }
    }

    fun success(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK))
    fun notification(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK))
    fun down(c: Context) = play(c, VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK))
}

/**
 * Keeps trying to deliver notes that couldn't be sent, even after the app is closed: Android runs it
 * once the watch is online again, and again with backoff until everything has gone.
 */
class SendWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.Main) {
        Store.init(applicationContext)
        Store.flush()
        if (Store.pending == 0) Result.success() else Result.retry()
    }

    companion object {
        fun schedule(c: Context) {
            val req = OneTimeWorkRequestBuilder<SendWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(c).enqueueUniqueWork("send", ExistingWorkPolicy.KEEP, req)
        }
    }
}
