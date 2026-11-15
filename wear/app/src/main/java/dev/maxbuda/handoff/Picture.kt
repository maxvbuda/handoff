package dev.maxbuda.handoff

import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.widget.ImageView
import android.widget.VideoView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Screenshots, and GIF or MP4 clips, from Claude, as the Apple Watch app shows them. */
object Picture {
    /** A PNG, JPEG or GIF, by its first bytes (what the Mac checks before sending one). */
    fun isImage(b: ByteArray): Boolean {
        val png = b.size > 8 && b.copyOf(8).contentEquals(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
        val jpeg = b.size > 3 && b[0] == 0xff.toByte() && b[1] == 0xd8.toByte() && b[2] == 0xff.toByte()
        val gif = b.size > 6 && String(b.copyOf(6), Charsets.ISO_8859_1).let { it == "GIF87a" || it == "GIF89a" }
        return png || jpeg || gif
    }

    /** An MP4 (or QuickTime) clip: "ftyp" at byte 4. */
    fun isVideo(b: ByteArray) = b.size > 8 && String(b.copyOfRange(4, 8), Charsets.ISO_8859_1) == "ftyp"

    /**
     * Decodes a picture file. A GIF comes back as an AnimatedImageDrawable, which decodes its frames
     * as it plays rather than all at once, so a full-quality clip doesn't fill the watch's memory.
     */
    suspend fun load(file: File): Drawable? = withContext(Dispatchers.IO) {
        runCatching { ImageDecoder.decodeDrawable(ImageDecoder.createSource(file)) }.getOrNull()
    }
}

/** Shows a screenshot, playing it if it's a clip: a GIF, or an MP4 (silent, looping, no controls). */
@Composable
fun PictureView(id: String, modifier: Modifier = Modifier) {
    val file = Store.shotFile(id)
    var video by remember(id) { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(id) { video = withContext(Dispatchers.IO) { runCatching { file.inputStream().use { Picture.isVideo(it.readNBytes(12)) } }.getOrDefault(false) } }
    when (video) {
        null -> return
        true -> AndroidView(
            factory = { ctx ->
                VideoView(ctx).apply {
                    setOnPreparedListener { mp -> mp.isLooping = true; mp.setVolume(0f, 0f); start() }
                    setVideoPath(file.path)
                }
            },
            onRelease = { it.stopPlayback() },
            modifier = modifier,
        )
        false -> ImageOrGif(id, modifier)
    }
}

@Composable
private fun ImageOrGif(id: String, modifier: Modifier) {
    var drawable by remember(id) { mutableStateOf<Drawable?>(null) }
    LaunchedEffect(id) { drawable = Picture.load(Store.shotFile(id)) }
    val d = drawable ?: return
    AndroidView(
        factory = { ImageView(it).apply { adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER } },
        update = { v ->
            if (v.drawable !== d) {
                v.setImageDrawable(d)
                (d as? AnimatedImageDrawable)?.apply { repeatCount = AnimatedImageDrawable.REPEAT_INFINITE; start() }
            }
        },
        modifier = modifier,
    )
}
