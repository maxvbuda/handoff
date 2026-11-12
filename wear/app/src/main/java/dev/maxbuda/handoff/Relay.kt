package dev.maxbuda.handoff

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.coroutines.coroutineContext
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

// The same relay, sealing and pairing as the Apple Watch app (watch/ClaudeNotes/App.swift) and the
// Mac (server/relay.mjs), so `handoff` on the Mac can't tell which watch it's talking to.

/** Relay that carries ciphertext between watch and Mac. Must match RELAY in server/handoff.mjs. */
object Relay {
    /** Debug builds can point at a local mock relay: `adb shell am start ... -e relay http://10.0.2.2:PORT`. */
    @Volatile var base = "https://ntfy.sh"

    /** A request that gets no bytes for 15s fails, so one bad connection doesn't hold up the next check. */
    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    /** For streams: ntfy sends a keepalive every 45s or so, and the stream is restarted every 30s. */
    private val streaming: OkHttpClient = http.newBuilder().readTimeout(60, TimeUnit.SECONDS).callTimeout(30, TimeUnit.SECONDS).build()

    /** One relay message: its id, its body if it was sealed with our key, or its attachment (bodies of 4 KB or more). */
    class Event(val id: String, val body: JSONObject?, val attachment: Attachment? = null)
    class Attachment(val url: String, val size: Long)

    /** For screenshots and GIFs, which can be a few megabytes: more time to download. */
    private val downloads: OkHttpClient = http.newBuilder().readTimeout(20, TimeUnit.SECONDS).callTimeout(120, TimeUnit.SECONDS).build()

    /** Downloads an attachment as text (a sealed message), or null if it failed or expired. */
    suspend fun download(url: String): String? = run(downloads.newCall(Request.Builder().url(url).build())) { call ->
        call.execute().use { res -> if (res.isSuccessful) res.body.string() else null }
    }

    /** GETs a poll (`?poll=1`) and returns its messages, oldest first, or null if the relay didn't answer. */
    suspend fun poll(url: String, key: ByteArray): List<Event>? = run(http.newCall(Request.Builder().url(url).build())) { call ->
        call.execute().use { res ->
            if (!res.isSuccessful) null
            else res.body.string().lineSequence().mapNotNull { event(it, key) }.toList()
        }
    }

    /**
     * Streams `url` (ntfy's JSON stream) until [found] returns a value; reconnects when the stream ends,
     * waiting longer if refused (ntfy.sh limits requests per IP address, which the watch shares with the Mac).
     */
    suspend fun <T : Any> stream(url: String, key: ByteArray, found: (Event) -> T?): T? {
        while (coroutineContext.isActive) {
            var pause = 1.seconds
            val result = run(streaming.newCall(Request.Builder().url(url).build())) { call ->
                call.execute().use { res ->
                    if (!res.isSuccessful) { pause = 15.seconds; return@use null }
                    val source = res.body.source()
                    while (true) {
                        val line = source.readUtf8Line() ?: break
                        val ev = event(line, key) ?: continue
                        found(ev)?.let { return@use it }
                    }
                    null
                }
            }
            if (result != null) return result
            delay(pause)
        }
        return null
    }

    /** Seals and posts to the topic. Returns the relay's message id, or null if the relay didn't accept it. */
    suspend fun publish(plain: JSONObject, key: ByteArray, url: String): String? {
        val body = Crypto.seal(plain.toString().toByteArray(), key).toRequestBody("text/plain".toMediaType())
        return run(http.newCall(Request.Builder().url(url).post(body).build())) { call ->
            call.execute().use { res ->
                if (!res.isSuccessful) null
                else runCatching { JSONObject(res.body.string()).optString("id") }.getOrDefault("")
            }
        }
    }

    /**
     * Runs a blocking call off the main thread, returning null if it fails. OkHttp's blocking reads
     * don't notice coroutine cancellation, so cancelling cancels the call itself.
     */
    private suspend fun <T> run(call: Call, block: (Call) -> T?): T? = coroutineScope {
        val watcher = launch { try { awaitCancellation() } finally { call.cancel() } }
        try {
            withContext(Dispatchers.IO) { runCatching { block(call) }.getOrNull() }
        } finally {
            watcher.cancel()
        }
    }

    private fun event(line: String, key: ByteArray): Event? {
        if (line.isBlank()) return null
        val ev = runCatching { JSONObject(line) }.getOrNull() ?: return null
        if (ev.optString("event", "message") != "message") return null
        val id = ev.optString("id").ifEmpty { return null }
        val body = ev.optString("message").takeIf { it.isNotEmpty() }
            ?.let { m -> runCatching { JSONObject(String(Crypto.open(m, key))) }.getOrNull() }
        val attachment = ev.optJSONObject("attachment")?.let { a -> a.optString("url").takeIf { it.isNotEmpty() }?.let { Attachment(it, a.optLong("size")) } }
        return Event(id, body, attachment)
    }
}

/** AES-256-GCM in CryptoKit's "combined" layout: nonce(12) | ciphertext | tag(16), base64. */
object Crypto {
    private val random = SecureRandom()

    fun randomBytes(n: Int) = ByteArray(n).also { random.nextBytes(it) }

    fun seal(plain: ByteArray, key: ByteArray): String {
        val iv = randomBytes(12)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return Base64.getEncoder().encodeToString(iv + c.doFinal(plain)) // Java appends the tag
    }

    fun open(b64: String, key: ByteArray): ByteArray {
        val b = Base64.getDecoder().decode(b64.trim())
        require(b.size >= 29)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, b, 0, 12))
        return c.doFinal(b, 12, b.size - 12)
    }

    /** HKDF-SHA256 (RFC 5869), as CryptoKit's HKDF and Node's crypto.hkdfSync. */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, n: Int): ByteArray {
        fun hmac(key: ByteArray, data: ByteArray) = Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(data) }
        val prk = hmac(salt, ikm)
        var t = ByteArray(0)
        val out = java.io.ByteArrayOutputStream()
        var i = 1
        while (out.size() < n) {
            t = hmac(prk, t + info + byteArrayOf(i++.toByte()))
            out.write(t)
        }
        return out.toByteArray().copyOf(n)
    }
}

fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
fun ByteArray.b64(): String = Base64.getEncoder().encodeToString(this)

class Pairing(val topicURL: String, val key: ByteArray)

class PairException(val reason: Reason) : Exception() {
    enum class Reason { BadCode, NoAnswer, Relay }
}

/**
 * One-time pairing. The code we show (typed into `handoff pair` on the Mac) derives, via HKDF, a
 * pairing key and topic. We generate our own topic + key, send them sealed with the pairing key,
 * and wait for the Mac's sealed ack. A mistyped code derives a different topic, so nothing answers.
 */
object Pairer {
    const val ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789" // no 0/O, 1/I/L

    /** A fresh 8-character code (about 40 bits), shown on the watch for the user to type on the Mac. */
    fun newCode(): String {
        val r = SecureRandom()
        return (1..8).map { ALPHABET[r.nextInt(ALPHABET.length)] }.joinToString("")
    }

    fun normalize(raw: String) = raw.uppercase().filter { it in ALPHABET }

    suspend fun pair(raw: String, waitFor: Duration = 30.seconds): Pairing {
        val code = normalize(raw)
        if (code.length != 8) throw PairException(PairException.Reason.BadCode)
        fun derive(info: String, n: Int) = Crypto.hkdf(code.toByteArray(), "claude-watch-notes-pair".toByteArray(), info.toByteArray(), n)
        val pairKey = derive("key", 32)
        val pairURL = "${Relay.base}/cwp-${derive("topic", 16).hex()}"

        val topic = "cw-${Crypto.randomBytes(16).hex()}"
        val pairing = Pairing("${Relay.base}/$topic", Crypto.randomBytes(32))
        val nonce = Crypto.randomBytes(16).hex()
        // "moves": we follow the Mac to its own relay if its answer names one.
        val offer = JSONObject().put("topic", pairing.topicURL).put("key", pairing.key.b64()).put("n", nonce).put("moves", true)
        // Listen for replies after our own offer's message id: no dependence on clocks agreeing.
        val offerID = Relay.publish(offer, pairKey, pairURL) ?: throw PairException(PairException.Reason.Relay)
        val acked = withTimeoutOrNull(waitFor) {
            Relay.stream("$pairURL/json?since=$offerID", pairKey) { ev -> ev.body?.takeIf { it.optString("ack") == nonce } }
        }
            ?: throw PairException(PairException.Reason.NoAnswer)
        // The Mac runs its own relay (`handoff relay setup`): the same topic, there instead.
        val own = ownRelay(acked.optString("relay"))
        return if (own != null) Pairing("$own/$topic", pairing.key) else pairing
    }

    /** An https address with nothing but a host (and port), like https://mac.tail1234.ts.net. */
    fun ownRelay(s: String): String? {
        val u = runCatching { java.net.URI(s) }.getOrNull() ?: return null
        if (u.scheme != "https" || u.host.isNullOrEmpty() || !(u.rawPath.isNullOrEmpty() || u.rawPath == "/") || u.rawQuery != null || u.rawUserInfo != null) return null
        return "https://${u.host}" + if (u.port > 0) ":${u.port}" else ""
    }
}
