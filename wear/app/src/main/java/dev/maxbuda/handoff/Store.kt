package dev.maxbuda.handoff

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.text.SimpleDateFormat
import java.time.Instant
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

// Jot ideas on your wrist; Claude Code does them while you're away.
// By design there is no response view: you get a buzz and a checkmark, nothing to read.
// What comes back is Claude's suggested next prompt, which you can accept with a tap, and
// permission prompts from `handoff start` chats, which you can allow or deny.

data class Note(val id: String, val text: String, val ts: Long, val to: String? = null, val sent: Boolean = false) {
    fun json(): JSONObject = JSONObject().put("id", id).put("text", text).put("ts", ts).put("to", to).put("sent", sent)
    companion object {
        fun from(o: JSONObject) = Note(o.getString("id"), o.getString("text"), o.getLong("ts"), o.optStringOrNull("to"), o.optBoolean("sent"))
    }
}

/** A next prompt Claude suggested when it finished a note (watch_note_done's `suggestion`). */
data class Suggestion(val id: String, val text: String, val chat: String? = null)

/** A permission prompt from a `handoff start` chat, answered here or in the terminal (whichever comes first). */
data class Approval(val id: String, val tool: String, val what: String, val input: String, val chat: String? = null)

/** A note Claude gets on a schedule, run by the Mac (runDueSchedules in server/relay.mjs). */
data class Recurring(
    val id: String = UUID.randomUUID().toString().uppercase(),
    val text: String,
    val every: Every,
    val hour: Int = 9,
    val minute: Int = 0,
    val to: String? = null,
    val since: Long = System.currentTimeMillis(), // never runs for a time before it was made
) {
    enum class Every(val raw: String) { Hour("hour"), Day("day"), Weekday("weekday") }

    fun json(): JSONObject = JSONObject().put("id", id).put("text", text).put("every", every.raw).put("hour", hour)
        .put("minute", minute).put("to", to).put("since", since)

    companion object {
        fun from(o: JSONObject) = Recurring(o.getString("id"), o.getString("text"),
            Every.entries.first { it.raw == o.getString("every") }, o.getInt("hour"), o.getInt("minute"),
            o.optStringOrNull("to"), o.getLong("since"))
    }
}

/** What an open chat is up to, for the Projects screen. */
data class ChatStatus(val working: String? = null, val branch: String? = null, val changes: Int = 0, val ahead: Int = 0)

fun JSONObject.optStringOrNull(k: String): String? = if (has(k) && !isNull(k)) optString(k) else null

/** The app's state. One per process, shared by the app, the tile and the send worker. */
@SuppressLint("StaticFieldLeak") // the application context
object Store {
    private lateinit var context: Context
    private lateinit var prefs: SharedPreferences
    private val scope = MainScope()

    var draft by mutableStateOf(listOf<String>()); private set
    var notes by mutableStateOf(listOf<Note>()); private set
    var suggestion by mutableStateOf<Suggestion?>(null); private set
    var suggestionsOn by mutableStateOf(true); private set
    /** Open Claude Code chats (`handoff start` sessions), by name. */
    var chats by mutableStateOf(listOf<String>()); private set
    /** Projects `handoff host` can start a new chat in (empty when it isn't running). */
    var projects by mutableStateOf(listOf<String>()); private set
    /** Chats `handoff host` runs, which it can open on the Mac (Open on computer). */
    var hostedChats by mutableStateOf(setOf<String>()); private set
    /** The name of the host's folder (shown as the top of the folder browser). */
    var hostRoot by mutableStateOf<String?>(null); private set
    /** Chats we asked the host to start that haven't announced themselves yet. */
    var starting by mutableStateOf(setOf<String>()); private set
    /** What each open chat is doing, by name. */
    var status by mutableStateOf(mapOf<String, ChatStatus>()); private set
    var schedules by mutableStateOf(listOf<Recurring>()); private set
    /** Permission prompts waiting for an answer, oldest first. */
    var approvals by mutableStateOf(listOf<Approval>()); private set
    /** The chat new notes go to; null sends to any open chat. */
    var target by mutableStateOf<String?>(null); private set
    var pairing by mutableStateOf<Pairing?>(null); private set
    var theme by mutableStateOf(Theme.Clay); private set
    var themedBackground by mutableStateOf(true); private set

    const val CHAT_WINDOW = "3m" // chats announce themselves every minute
    const val APPROVAL_WINDOW = "10m" // older prompts have likely been answered at the Mac
    private const val KEEP = 12
    private val retryDelay = 15.seconds

    private var sending: Job? = null
    private var refreshing: Job? = null
    private var retry: Job? = null

    fun init(c: Context) {
        if (::context.isInitialized) return
        context = c.applicationContext
        prefs = context.getSharedPreferences("handoff", Context.MODE_PRIVATE)
        draft = prefs.getString("draft", null)?.let { JSONArray(it).strings() } ?: emptyList()
        notes = prefs.getString("notes", null)?.let { a -> JSONArray(a).objects().map(Note::from) } ?: emptyList()
        suggestionsOn = prefs.getBoolean("suggestionsOn", true)
        suggestion = prefs.getString("suggestion", null)?.let { JSONObject(it) }
            ?.let { Suggestion(it.getString("id"), it.getString("text"), it.optStringOrNull("chat")) }
        target = prefs.getString("target", null)
        schedules = prefs.getString("schedules", null)?.let { a -> JSONArray(a).objects().map(Recurring::from) } ?: emptyList()
        theme = Theme.entries.firstOrNull { it.name == prefs.getString("theme", null) } ?: Theme.Clay
        themedBackground = prefs.getBoolean("themedBackground", true)
        pairing = PairingVault.load(prefs)
    }

    // ----- settings -----

    fun updateTheme(t: Theme) { theme = t; prefs.edit().putString("theme", t.name).apply() }
    fun updateThemedBackground(on: Boolean) { themedBackground = on; prefs.edit().putBoolean("themedBackground", on).apply() }

    /** Settings → Suggestions. Off: no polling, nothing shown; back on: only suggestions from then on. */
    fun updateSuggestionsOn(on: Boolean) {
        suggestionsOn = on
        prefs.edit().putBoolean("suggestionsOn", on).apply()
        if (on) prefs.edit().putString("suggestionSince", (System.currentTimeMillis() / 1000).toString()).apply()
        else updateSuggestion(null)
    }

    fun updateTarget(t: String?) { target = t; prefs.edit().putString("target", t).apply() }

    private fun updateSuggestion(s: Suggestion?) {
        suggestion = s
        prefs.edit().putString("suggestion", s?.let { JSONObject().put("id", it.id).put("text", it.text).put("chat", it.chat).toString() }).apply()
    }

    // ----- writing and sending -----

    fun addLine(text: String) {
        val t = text.trim()
        if (t.isNotEmpty()) { draft = draft + t; save() }
    }

    fun removeLine(i: Int) { draft = draft.filterIndexed { j, _ -> j != i }; save() }

    fun send() {
        val text = draft.joinToString("\n")
        if (text.isEmpty()) return
        draft = emptyList()
        enqueue(text, target)
    }

    /** Sends a quick reply as a note, to the chosen chat. */
    fun sendQuick(text: String) = enqueue(text, target)

    /** Tell Claude (the tile, or a voice note straight from the launcher): queues it for the chosen chat. */
    fun sendNow(text: String) { if (text.isNotBlank()) enqueue(text.trim(), target) }

    /** Sends Claude's suggestion back to it as a new note. */
    fun acceptSuggestion() {
        val s = suggestion ?: return
        updateSuggestion(null)
        enqueue(s.text, s.chat ?: target)
    }

    fun dismissSuggestion() = updateSuggestion(null)

    private fun enqueue(text: String, chat: String?) {
        val n = notes.toMutableList()
        n.add(0, Note(UUID.randomUUID().toString().uppercase(), text, System.currentTimeMillis(), chat))
        // Trim history, but never drop a note that hasn't been delivered yet.
        while (n.size > KEEP) { val i = n.indexOfLast { it.sent }; if (i < 0) break; n.removeAt(i) }
        notes = n
        save()
        Haptic.success(context)
        scope.launch { flush() }
    }

    /** Debug builds only (MainActivity's extras): sample state for screenshots. */
    fun seed(draft: List<String>?, notes: List<Note>?) {
        draft?.let { this.draft = it }
        notes?.let { this.notes = it }
        save()
    }

    /** Settings → Delete All History. Notes still waiting to send are kept, so no idea is lost. */
    fun clearHistory() { notes = notes.filter { !it.sent }; save() }

    val pending get() = notes.count { !it.sent }

    /**
     * Delivers queued notes oldest first. On failure, retries every 15s while the app runs, and
     * the send worker keeps trying in the background until it gets through (see SendWorker).
     * A call made while a delivery is running waits for that one to finish.
     */
    suspend fun flush() {
        sending?.let { return it.join() }
        if (pairing == null) return
        val job = scope.launch { if (deliver()) syncSchedules() }
        sending = job
        job.join()
        if (sending == job) sending = null // not if updatePairing replaced it meanwhile
    }

    /** Returns false if a note couldn't be sent (a retry is scheduled). */
    private suspend fun deliver(): Boolean {
        val p = pairing ?: return false
        for (note in notes.reversed().filter { !it.sent }) {
            if (!post(note, p)) {
                scheduleRetry()
                return false
            }
            notes = notes.map { if (it.id == note.id) it.copy(sent = true) else it }
            save()
        }
        return true
    }

    private fun scheduleRetry() {
        retry?.cancel()
        retry = scope.launch { delay(retryDelay); flush() }
        SendWorker.schedule(context)
    }

    private suspend fun post(note: Note, p: Pairing): Boolean {
        val fields = JSONObject().put("id", note.id).put("t", note.text).put("ts", iso(note.ts))
        note.to?.let { fields.put("to", it) }
        return Relay.publish(fields, p.key, p.topicURL) != null
    }

    private fun save() {
        prefs.edit()
            .putString("draft", JSONArray(draft).toString())
            .putString("notes", JSONArray(notes.map { it.json() }).toString())
            .apply()
    }

    // ----- what comes back -----

    /** Checks chats, suggestions and permission prompts at the same time; overlapping calls share one. */
    suspend fun refresh() {
        refreshing?.let { return it.join() }
        val job = scope.launch {
            coroutineScope {
                launch { checkChats() }
                launch { checkSuggestion() }
                launch { checkApprovals() }
            }
        }
        refreshing = job
        job.join()
        refreshing = null
    }

    /** The chat picker's choices: open chats, plus the chosen one even while it's offline. */
    val chatChoices: List<String> get() = target?.takeIf { it !in chats }?.let { chats + it } ?: chats

    /** Rebuilds the list of open chats from the last few minutes of heartbeats on "<topic>-c". */
    suspend fun checkChats() {
        val p = pairing ?: return
        val events = Relay.poll("${p.topicURL}-c/json?poll=1&since=$CHAT_WINDOW", p.key) ?: return
        if (pairing?.topicURL != p.topicURL) return
        val open = mutableSetOf<String>()
        var hostProjects = listOf<String>()
        var hostChats = listOf<String>()
        val git = mutableMapOf<String, ChatStatus>()
        val beatWorking = mutableMapOf<String, String?>()
        val hostWorking = mutableMapOf<String, String?>()
        for (b in events.mapNotNull { it.body }) {
            b.optStringOrNull("repo")?.let { repo ->
                // From `handoff start` (git only) or `handoff host` (git, and the note it's running).
                git[repo] = ChatStatus(branch = b.optStringOrNull("branch"), changes = b.optInt("changes"), ahead = b.optInt("ahead"))
                hostWorking[repo] = b.optStringOrNull("working")
                continue
            }
            if (b.has("host")) {
                val gone = b.optBoolean("gone")
                hostProjects = if (gone) emptyList() else b.optJSONArray("projects")?.strings() ?: emptyList()
                hostChats = if (gone) emptyList() else b.optJSONArray("chats")?.strings() ?: emptyList()
                b.optStringOrNull("root")?.let { hostRoot = it }
            }
            val name = b.optStringOrNull("chat")?.takeIf { it.isNotEmpty() } ?: continue
            if (b.optBoolean("gone")) open.remove(name) else { open.add(name); beatWorking[name] = b.optStringOrNull("working") }
        }
        open.addAll(hostChats)
        val s = open.associateWith { name ->
            (git[name] ?: ChatStatus()).copy(working = if (name in hostChats) hostWorking[name] else beatWorking[name])
        }
        if (s != status) status = s
        val sorted = open.sortedWith(String.CASE_INSENSITIVE_ORDER)
        if (sorted != chats) chats = sorted
        if (hostProjects != projects) projects = hostProjects
        if (hostChats.toSet() != hostedChats) hostedChats = hostChats.toSet()
        starting = starting - open
    }

    /** Sends a sealed request to `handoff host` on "<topic>-n". */
    private suspend fun askHost(fields: Map<String, String?>): Boolean {
        val p = pairing ?: return false
        val o = JSONObject()
        fields.forEach { (k, v) -> if (v != null) o.put(k, v) }
        o.put("ts", iso(System.currentTimeMillis()))
        return Relay.publish(o, p.key, "${p.topicURL}-n") != null
    }

    /** The subfolders of `path` (relative to the host's folder; "" is the top), or null if the Mac didn't answer. */
    suspend fun listFolders(path: String, timeout: Duration = 12.seconds): List<String>? {
        val p = pairing ?: return null
        val id = UUID.randomUUID().toString().uppercase()
        val since = System.currentTimeMillis() / 1000 - 1
        if (!askHost(mapOf("ls" to path, "id" to id))) return null
        // Listen on the reply topic instead of polling it, so the folders show as soon as the Mac
        // answers. `since` covers a reply that arrives before the stream is open.
        return withTimeoutOrNull(timeout) {
            Relay.stream("${p.topicURL}-l/json?since=$since", p.key) { ev ->
                ev.body?.takeIf { it.optString("id") == id }?.let { it.optJSONArray("dirs")?.strings() ?: emptyList() }
            }
        }
    }

    /** The name a new chat in `path` (or in a new folder there) gets unless you change it. */
    fun defaultChatName(path: String, newFolder: String? = null): String =
        newFolder ?: path.split("/").lastOrNull { it.isNotEmpty() } ?: hostRoot ?: "Chat"

    /**
     * Asks `handoff host` to open a new chat in `path`, optionally in a new folder made there first,
     * and points new notes at it. Notes sent before it's up wait for it.
     */
    suspend fun startChat(path: String, newFolder: String? = null, name: String? = null): Boolean {
        val typed = (name ?: "").trim().take(40)
        val base = typed.ifEmpty { defaultChatName(path, newFolder) }
        var chosen = base
        var n = 1
        while (chosen in chats || chosen in starting) { n++; chosen = "$base $n" }
        if (!askHost(mapOf("path" to path, "name" to chosen, "create" to newFolder))) return false
        starting = starting + chosen
        updateTarget(chosen)
        Haptic.success(context)
        return true
    }

    /** Asks `handoff host` to open one of its chats on the Mac, as a Claude Code window in Terminal. */
    suspend fun openOnComputer(name: String): Boolean {
        if (name !in hostedChats || !askHost(mapOf("open" to name))) return false
        Haptic.success(context)
        return true
    }

    /** Rebuilds the permission prompts from the last few minutes on "<topic>-p", leaving out ones answered here. */
    suspend fun checkApprovals() {
        val p = pairing ?: return
        val events = Relay.poll("${p.topicURL}-p/json?poll=1&since=$APPROVAL_WINDOW", p.key) ?: return
        if (pairing?.topicURL != p.topicURL) return
        val answered = answered()
        val open = mutableListOf<Approval>()
        for (b in events.mapNotNull { it.body }) {
            val id = b.optStringOrNull("p") ?: continue
            if (id in answered || open.any { it.id == id }) continue
            open += Approval(id, b.optStringOrNull("tool") ?: "a tool", b.optString("what"), b.optString("input"), b.optStringOrNull("chat"))
        }
        if (open.any { a -> approvals.none { it.id == a.id } }) Haptic.notification(context)
        if (open != approvals) approvals = open
    }

    private fun answered() = prefs.getString("answered", null)?.let { JSONArray(it).strings() } ?: emptyList()

    /** Allows or denies a permission prompt. Returns false if the answer couldn't be sent. */
    suspend fun answer(a: Approval, allow: Boolean): Boolean {
        val p = pairing ?: return false
        val o = JSONObject().put("v", a.id).put("ok", allow).put("ts", iso(System.currentTimeMillis()))
        a.chat?.let { o.put("chat", it) }
        if (Relay.publish(o, p.key, "${p.topicURL}-v") == null) return false
        prefs.edit().putString("answered", JSONArray((answered() + a.id).takeLast(50)).toString()).apply()
        approvals = approvals.filter { it.id != a.id }
        if (allow) Haptic.success(context) else Haptic.down(context)
        return true
    }

    /** Picks up the newest suggestion the Mac posted to "<topic>-s" since we last looked. */
    suspend fun checkSuggestion() {
        val p = pairing ?: return
        if (!suggestionsOn) return
        val since = prefs.getString("suggestionSince", null) ?: "12h"
        val events = Relay.poll("${p.topicURL}-s/json?poll=1&since=$since", p.key) ?: return
        if (!suggestionsOn || pairing?.topicURL != p.topicURL) return // changed meanwhile
        // Advance past everything seen, including junk, so it isn't fetched again.
        events.lastOrNull()?.let { prefs.edit().putString("suggestionSince", it.id).apply() }
        events.lastOrNull { it.body?.optString("s")?.isNotEmpty() == true }?.let {
            updateSuggestion(Suggestion(it.id, it.body!!.getString("s"), it.body.optStringOrNull("chat")))
        }
    }

    // ----- recurring -----

    fun addSchedule(r: Recurring) = updateSchedules(schedules + r)
    fun removeSchedule(id: String) = updateSchedules(schedules.filter { it.id != id })

    private fun updateSchedules(list: List<Recurring>) {
        schedules = list
        prefs.edit().putString("schedules", JSONArray(list.map { it.json() }).toString()).putBoolean("schedulesUnsent", true).apply()
        scope.launch { syncSchedules() }
    }

    /**
     * Sends the whole list of recurring tasks to the Mac, sealed, on "<topic>-r", if it changed since
     * it was last sent. The newest list wins there; the relay keeps it 12 hours, the Mac the last one.
     */
    suspend fun syncSchedules() {
        val p = pairing ?: return
        if (!prefs.getBoolean("schedulesUnsent", false)) return
        val sent = schedules
        val list = JSONArray(sent.map { r ->
            JSONObject().put("id", r.id).put("t", r.text).put("every", r.every.raw).put("h", r.hour).put("m", r.minute)
                .put("since", iso(r.since)).also { o -> r.to?.let { o.put("to", it) } }
        })
        val body = JSONObject().put("schedules", list).put("ts", Instant.now().toString()) // to the millisecond
        if (Relay.publish(body, p.key, "${p.topicURL}-r") == null || pairing?.topicURL != p.topicURL) return
        if (schedules != sent) return // edited while sending: that edit's own sync sends the new list
        prefs.edit().putBoolean("schedulesUnsent", false).apply()
    }

    // ----- pairing -----

    fun updatePairing(p: Pairing?) {
        // A send still trying the old pairing would hold up the queue: stop it, start over.
        sending?.cancel(); sending = null
        retry?.cancel()
        pairing = p
        status = emptyMap()
        if (schedules.isNotEmpty()) prefs.edit().putBoolean("schedulesUnsent", true).apply() // the new pairing's Mac needs the list
        updateSuggestion(null)
        chats = emptyList(); projects = emptyList(); hostedChats = emptySet(); starting = emptySet(); approvals = emptyList()
        updateTarget(null)
        prefs.edit().remove("suggestionSince").apply()
        PairingVault.save(prefs, p)
        if (p != null) { Haptic.success(context); scope.launch { flush() } }
    }

    // ----- helpers -----

    /** ISO 8601 to the second, in UTC, like Swift's ISO8601Format(). */
    private fun iso(ms: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))
}

fun JSONArray.strings() = (0 until length()).map { getString(it) }
fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }

/** The pairing (relay topic and key), sealed with a key that never leaves the watch's keystore. */
object PairingVault {
    private const val ALIAS = "handoff-pairing"

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
            generateKey()
        }
    }

    fun load(prefs: SharedPreferences): Pairing? = runCatching {
        val b = java.util.Base64.getDecoder().decode(prefs.getString("pairing", null) ?: return null)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12))
        val o = JSONObject(String(c.doFinal(b, 12, b.size - 12)))
        Pairing(o.getString("topicURL"), java.util.Base64.getDecoder().decode(o.getString("key")))
    }.getOrNull()

    fun save(prefs: SharedPreferences, p: Pairing?) {
        if (p == null) { prefs.edit().remove("pairing").apply(); return }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val plain = JSONObject().put("topicURL", p.topicURL).put("key", p.key.b64()).toString().toByteArray()
        prefs.edit().putString("pairing", (c.iv + c.doFinal(plain)).b64()).commit()
    }
}
