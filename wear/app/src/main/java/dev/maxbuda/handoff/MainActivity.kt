package dev.maxbuda.handoff

import android.app.Activity
import android.app.RemoteInput
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AddComment
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Circle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.KeyboardReturn
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.navArgument
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.itemsIndexed
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material3.AlertDialog
import androidx.wear.compose.material3.AlertDialogDefaults
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.CircularProgressIndicator
import androidx.wear.compose.material3.ColorScheme
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.EdgeButtonSize
import androidx.wear.compose.material3.FilledTonalButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SwitchButton
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimePicker
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.LocalTime
import org.json.JSONArray
import java.util.UUID
import kotlin.time.Duration.Companion.seconds

class MainActivity : ComponentActivity() {
    /** Set when the tile or complication opened the app to jot an idea straight away. */
    private var jot by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Store.init(this)
        if (BuildConfig.DEBUG) debugExtras(intent)
        jot = wantsJot(intent)
        setContent { HandOffApp(jot) { jot = false } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (wantsJot(intent)) jot = true
    }

    private fun wantsJot(i: Intent?) = i?.action == ACTION_JOT || i?.getBooleanExtra(EXTRA_JOT, false) == true

    override fun onResume() {
        super.onResume()
        lifecycleScope.launch { Store.flush() }
    }

    /**
     * Debug builds only, for tests and screenshots, like the Apple Watch app's launch arguments:
     * `-e relay URL`, `-e pairCode CODE`, `--ez resetPairing true`, `-e theme Blue`, `-e target CHAT`,
     * `--ez suggestionsOn false`, `-e draft '["line", …]'` and `-e notes '[{"text", "to", "mins"}, …]'` (sent, minutes ago).
     */
    private fun debugExtras(i: Intent?) {
        i ?: return
        i.getStringExtra("relay")?.let { Relay.base = it }
        if (i.getBooleanExtra("resetPairing", false)) Store.updatePairing(null)
        i.getStringExtra("theme")?.let { t -> Theme.entries.firstOrNull { it.name.equals(t, true) }?.let(Store::updateTheme) }
        i.getStringExtra("target")?.let(Store::updateTarget)
        if (i.hasExtra("suggestionsOn")) Store.updateSuggestionsOn(i.getBooleanExtra("suggestionsOn", true))
        val draft = i.getStringExtra("draft")?.let { JSONArray(it).strings() }
        val notes = i.getStringExtra("notes")?.let { a ->
            JSONArray(a).objects().map { o ->
                Note(UUID.randomUUID().toString().uppercase(), o.getString("text"),
                    System.currentTimeMillis() - o.optLong("mins") * 60_000, o.optStringOrNull("to"), sent = true)
            }
        }
        if (draft != null || notes != null) Store.seed(draft, notes)
        launchCode = i.getStringExtra("pairCode")?.let(Pairer::normalize)
    }

    companion object {
        const val ACTION_JOT = "dev.maxbuda.handoff.JOT"
        const val EXTRA_JOT = "jot" // from the tile, which can't set an action
        /** `-e pairCode` in debug builds: the code the first pair screen shows. Used once. */
        var launchCode: String? = null
    }
}

@Composable
fun HandOffApp(jot: Boolean, jotHandled: () -> Unit) {
    val theme = Store.theme
    MaterialTheme(colorScheme = schemeFor(theme.color)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            if (Store.themedBackground) {
                // The chosen color as a soft glow behind the screen, unless Settings → Background is off.
                Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(theme.color.copy(alpha = 0.45f), Color.Black))))
            }
            AppScaffold {
                if (Store.pairing == null) PairScreen() else Navigation(jot, jotHandled)
            }
        }
    }
}

private fun schemeFor(c: Color) = ColorScheme(
    primary = c,
    primaryDim = c,
    primaryContainer = c.copy(alpha = 0.35f).compositeOver(Color(0xFF1C1B1F)),
    onPrimary = Color.Black,
    onPrimaryContainer = Color.White,
    background = Color.Transparent,
)

private fun Color.compositeOver(bg: Color) = Color(
    red * alpha + bg.red * (1 - alpha), green * alpha + bg.green * (1 - alpha), blue * alpha + bg.blue * (1 - alpha), 1f)

/** Opens the watch's keyboard / voice input and hands back what was typed or said. */
@Composable
fun rememberTextInput(label: String, onText: (String) -> Unit): () -> Unit {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        if (res.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        val text = res.data?.let { RemoteInput.getResultsFromIntent(it) }?.getCharSequence("text")?.toString()
        if (!text.isNullOrBlank()) onText(text)
    }
    return {
        val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
        RemoteInputIntentHelper.putRemoteInputsExtra(intent, listOf(RemoteInput.Builder("text").setLabel(label).build()))
        launcher.launch(intent)
    }
}

/** A scrolling screen: header, then items, with an optional button hugging the bottom edge. */
@Composable
fun ListScreen(
    title: String?,
    edgeButton: (@Composable () -> Unit)? = null,
    content: ScalingLazyListScope.() -> Unit,
) {
    val state = rememberScalingLazyListState()
    val list: @Composable (PaddingValues) -> Unit = { padding ->
        ScalingLazyColumn(state = state, contentPadding = padding, modifier = Modifier.fillMaxSize()) {
            if (title != null) item { ListHeader { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) } }
            content()
        }
    }
    if (edgeButton != null) ScreenScaffold(scrollState = state, edgeButton = { edgeButton() }) { list(it) }
    else ScreenScaffold(scrollState = state) { list(it) }
}

@Composable
fun Item(label: String, icon: ImageVector? = null, secondary: String? = null, tonal: Boolean = true, enabled: Boolean = true,
        danger: Boolean = false, onClick: () -> Unit) {
    val colors = when {
        danger -> ButtonDefaults.filledTonalButtonColors(contentColor = Color(0xFFFF6B6B), iconColor = Color(0xFFFF6B6B))
        tonal -> ButtonDefaults.filledTonalButtonColors()
        else -> ButtonDefaults.buttonColors()
    }
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        enabled = enabled,
        colors = colors,
        icon = icon?.let { { Icon(it, contentDescription = null) } },
        secondaryLabel = secondary?.let { { Text(it, maxLines = 2, overflow = TextOverflow.Ellipsis) } },
        label = { Text(label, maxLines = 3, overflow = TextOverflow.Ellipsis) },
    )
}

@Composable
fun Caption(text: String, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = color, textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp))
}

// ---------- pairing ----------

@Composable
fun PairScreen() {
    var code by rememberSaveable { mutableStateOf(MainActivity.launchCode?.also { MainActivity.launchCode = null } ?: Pairer.newCode()) }
    var failure by rememberSaveable { mutableStateOf<String?>(null) }
    val expired = stringResource(R.string.code_expired)
    val busy = stringResource(R.string.relay_busy)
    val offline = stringResource(R.string.relay_unreachable)
    // Offers the pairing as soon as the code is on screen, then waits up to 10 minutes for the Mac.
    LaunchedEffect(code) {
        if (failure != null) return@LaunchedEffect
        try {
            Store.updatePairing(Pairer.pair(code, waitFor = 600.seconds))
        } catch (e: PairException) {
            failure = when (e.reason) {
                PairException.Reason.NoAnswer -> expired
                PairException.Reason.Relay -> busy
                PairException.Reason.BadCode -> offline
            }
        }
    }
    ListScreen(stringResource(R.string.pair)) {
        item { Caption(stringResource(R.string.pair_instructions)) }
        item {
            Text("${code.take(4)}-${code.takeLast(4)}", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold,
                fontSize = 22.sp, maxLines = 1, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                color = if (failure == null) Color.White else Color.Gray)
        }
        val f = failure
        if (f != null) {
            item { Caption(f, Color(0xFFFF6B6B)) }
            item { Item(stringResource(R.string.new_code), tonal = false) { code = Pairer.newCode(); failure = null } }
        } else {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(stringResource(R.string.waiting_for_mac), style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

// ---------- navigation ----------

@Composable
fun Navigation(jot: Boolean, jotHandled: () -> Unit) {
    val nav = rememberSwipeDismissableNavController()
    SwipeDismissableNavHost(navController = nav, startDestination = "ideas") {
        composable("ideas") { IdeasScreen(nav, jot, jotHandled) }
        composable("approval/{id}", listOf(navArgument("id") { type = NavType.StringType })) { e ->
            ApprovalDetails(e.arguments?.getString("id") ?: "")
        }
        composable("to") { ChatPicker(Store.target) { Store.updateTarget(it); nav.popBackStack() } }
        composable("quick") { QuickReplyScreen { nav.popBackStack() } }
        composable("projects") { ProjectsScreen() }
        composable("recurring") { RecurringScreen(nav) }
        composable("recurring/new") { NewRecurringScreen(nav) }
        composable("settings") { SettingsScreen(nav) }
        composable("settings/color") { ColorScreen { nav.popBackStack() } }
        composable("folder?path={path}", listOf(navArgument("path") { type = NavType.StringType; defaultValue = "" })) { e ->
            FolderScreen(nav, e.arguments?.getString("path") ?: "")
        }
        composable("name?path={path}&new={new}", listOf(
            navArgument("path") { type = NavType.StringType; defaultValue = "" },
            navArgument("new") { type = NavType.StringType; nullable = true; defaultValue = null },
        )) { e -> NameChatScreen(nav, e.arguments?.getString("path") ?: "", e.arguments?.getString("new")) }
    }
}

private fun NavHostController.toFolder(path: String) = navigate("folder?path=${Uri.encode(path)}")

// ---------- the main screen ----------

@Composable
fun IdeasScreen(nav: NavHostController, jot: Boolean, jotHandled: () -> Unit) {
    val scope = rememberCoroutineScope()
    val accent = MaterialTheme.colorScheme.primary
    val input = rememberTextInput(stringResource(R.string.jot_an_idea)) { Store.addLine(it) }
    val addLine = rememberTextInput(stringResource(R.string.add_a_line)) { Store.addLine(it) }
    var opened by remember { mutableStateOf<String?>(null) }
    val openedText = stringResource(R.string.opened_on_mac)
    val failedText = stringResource(R.string.couldnt_reach_mac)

    // Watch for chats, suggestions and prompts while the list is on screen.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) { Store.refresh(); delay(20.seconds) }
        }
    }
    LaunchedEffect(jot) { if (jot) { jotHandled(); input() } }

    ListScreen(
        stringResource(R.string.ideas),
        edgeButton = if (Store.draft.isNotEmpty()) {
            {
                EdgeButton(onClick = Store::send, buttonSize = EdgeButtonSize.Medium) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.send_to_claude))
                }
            }
        } else null,
    ) {
        Store.approvals.forEach { approvalItems(it, nav) }

        Store.suggestion?.let { s ->
            item { ListHeader { Text(s.chat?.let { stringResource(R.string.suggestion_from, it) } ?: stringResource(R.string.suggestion)) } }
            item { Caption(s.text, Color.White) }
            item { Item(stringResource(R.string.accept_suggestion), Icons.Default.KeyboardReturn, tonal = false, onClick = Store::acceptSuggestion) }
            item { Item(stringResource(R.string.dismiss), Icons.Default.Close, onClick = Store::dismissSuggestion) }
        }

        // Which Claude Code chat to talk to, once any are open.
        if (Store.chatChoices.isNotEmpty()) {
            item {
                Item(stringResource(R.string.to), secondary = Store.target?.let { chatLabel(it) } ?: stringResource(R.string.any_chat)) { nav.navigate("to") }
            }
        }
        // A chat `handoff host` runs can be opened on the Mac, as a normal Claude Code window.
        Store.target?.takeIf { it in Store.hostedChats }?.let { chat ->
            item {
                Item(opened ?: stringResource(R.string.open_on_computer), Icons.Default.Computer, enabled = opened == null) {
                    scope.launch {
                        opened = if (Store.openOnComputer(chat)) openedText else failedText
                        delay(4.seconds)
                        opened = null
                    }
                }
            }
        }

        itemsIndexed(Store.draft) { i, line ->
            Button(onClick = { Store.removeLine(i) }, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.filledTonalButtonColors(),
                label = { Text(line, style = MaterialTheme.typography.bodySmall) },
                icon = { Icon(Icons.Default.Close, contentDescription = null, modifier = Modifier.size(16.dp)) })
        }
        item {
            if (Store.draft.isEmpty()) Item(stringResource(R.string.jot_an_idea), Icons.Default.Edit, tonal = false, onClick = input)
            else Item(stringResource(R.string.add_a_line), Icons.Default.Add, onClick = addLine)
        }

        // The usual follow-ups, two taps away; only while nothing is being written.
        if (Store.draft.isEmpty()) item { Item(stringResource(R.string.quick_reply), Icons.Default.Bolt) { nav.navigate("quick") } }

        if (Store.projects.isNotEmpty()) item { Item(stringResource(R.string.new_chat), Icons.Default.AddComment) { nav.toFolder("") } }

        if (Store.notes.isNotEmpty()) {
            item { ListHeader { Text(stringResource(R.string.handed_off)) } }
            items(Store.notes, key = { "n" + it.id }) { note ->
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f)) {
                        Text(note.text, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        note.to?.let { Text(stringResource(R.string.to_chat, it), style = MaterialTheme.typography.bodySmall, color = accent) }
                    }
                    Icon(if (note.sent) Icons.Default.Check else Icons.Default.Schedule,
                        contentDescription = stringResource(if (note.sent) R.string.delivered else R.string.waiting_to_send),
                        tint = if (note.sent) accent else Color.Gray, modifier = Modifier.size(14.dp))
                }
            }
        }

        if (Store.chats.isNotEmpty()) item { Item(stringResource(R.string.projects), Icons.Default.Folder) { nav.navigate("projects") } }
        item {
            val n = Store.schedules.size
            Item(if (n == 0) stringResource(R.string.recurring) else stringResource(R.string.recurring_count, n), Icons.Default.Repeat) { nav.navigate("recurring") }
        }
        item { Item(stringResource(R.string.settings), Icons.Default.Settings) { nav.navigate("settings") } }
    }
}

@Composable
private fun chatLabel(name: String) = when {
    name in Store.chats -> name
    name in Store.starting -> "$name (${stringResource(R.string.starting)})"
    else -> "$name (offline)"
}

/** A permission prompt: what Claude wants to do, and Allow / Deny. Tap the text to read all of it. */
private fun ScalingLazyListScope.approvalItems(a: Approval, nav: NavHostController) {
    item(key = "h" + a.id) { ListHeader { Text(a.chat?.let { stringResource(R.string.claude_asks_from, it) } ?: stringResource(R.string.claude_asks)) } }
    item(key = "d" + a.id) {
        Item(a.what.ifEmpty { stringResource(R.string.use_tool, a.tool) }, secondary = a.input) { nav.navigate("approval/${Uri.encode(a.id)}") }
    }
    item(key = "b" + a.id) { ApprovalButtons(a) }
}

@Composable
private fun ApprovalButtons(a: Approval) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    fun answer(allow: Boolean) {
        busy = true; failed = false
        scope.launch { failed = !Store.answer(a, allow); busy = false }
    }
    Column {
        Row(Modifier.fillMaxWidth()) {
            Button(onClick = { answer(true) }, enabled = !busy, modifier = Modifier.weight(1f),
                icon = { Icon(Icons.Default.Check, contentDescription = null) }, label = { Text(stringResource(R.string.allow), maxLines = 1) })
            Spacer(Modifier.width(4.dp))
            FilledTonalButton(onClick = { answer(false) }, enabled = !busy, modifier = Modifier.weight(1f),
                colors = ButtonDefaults.filledTonalButtonColors(contentColor = Color(0xFFFF6B6B), iconColor = Color(0xFFFF6B6B)),
                icon = { Icon(Icons.Default.Close, contentDescription = null) }, label = { Text(stringResource(R.string.deny), maxLines = 1) })
        }
        if (failed) Caption(stringResource(R.string.couldnt_reach_mac_retry), Color(0xFFFF6B6B))
    }
}

@Composable
fun ApprovalDetails(id: String) {
    val a = Store.approvals.firstOrNull { it.id == id }
    ListScreen(stringResource(R.string.details)) {
        if (a == null) return@ListScreen
        item { Text(a.tool, style = MaterialTheme.typography.titleMedium, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center) }
        if (a.what.isNotEmpty()) item { Caption(a.what, Color.White) }
        item { Text(a.input, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Color.LightGray, modifier = Modifier.padding(horizontal = 8.dp)) }
        item { ApprovalButtons(a) }
    }
}

@Composable
fun ChatPicker(selected: String?, pick: (String?) -> Unit) {
    ListScreen(stringResource(R.string.to)) {
        item { Item(stringResource(R.string.any_chat), if (selected == null) Icons.Default.Check else null, tonal = selected != null) { pick(null) } }
        items(Store.chatChoices) { name ->
            Item(chatLabel(name), if (selected == name) Icons.Default.Check else null, tonal = selected != name) { pick(name) }
        }
    }
}

// ---------- other screens ----------

/** Ready-made notes ("Commit it", "Run the tests"…): one tap sends it and goes back. */
@Composable
fun QuickReplyScreen(done: () -> Unit) {
    ListScreen(Store.target ?: stringResource(R.string.quick_reply)) {
        items(QUICK_REPLIES) { text -> Item(text) { Store.sendQuick(text); done() } }
    }
}

/** In English, as on the Apple Watch: they're notes for Claude. */
private val QUICK_REPLIES = listOf("Keep going", "Commit it", "Run the tests", "Undo that")

/** Each open chat: what it's working on, and its folder's git status. */
@Composable
fun ProjectsScreen() {
    LaunchedEffect(Unit) { while (true) { Store.checkChats(); delay(10.seconds) } }
    val accent = MaterialTheme.colorScheme.primary
    ListScreen(stringResource(R.string.projects)) {
        if (Store.chats.isEmpty()) item { Caption(stringResource(R.string.no_chats)) }
        items(Store.chats) { name ->
            val s = Store.status[name] ?: ChatStatus()
            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp)) {
                Text(name, style = MaterialTheme.typography.titleSmall)
                if (s.working != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Build, null, tint = accent, modifier = Modifier.size(12.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(s.working, style = MaterialTheme.typography.bodySmall, color = accent, maxLines = 2)
                    }
                } else Text(stringResource(R.string.idle), style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                s.branch?.let { b ->
                    Text(listOfNotNull(b, if (s.changes > 0) "${s.changes} changed" else "clean", if (s.ahead > 0) "${s.ahead} to push" else null)
                        .joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = Color.Gray)
                }
            }
        }
    }
}

/** Notes Claude gets on a schedule: run the tests every morning, check something every hour. Tap one to delete it. */
@Composable
fun RecurringScreen(nav: NavHostController) {
    var deleting by remember { mutableStateOf<Recurring?>(null) }
    ListScreen(stringResource(R.string.recurring)) {
        item { Item(stringResource(R.string.new_), Icons.Default.Add, tonal = false) { nav.navigate("recurring/new") } }
        items(Store.schedules, key = { it.id }) { r ->
            Item(r.text, secondary = whenText(r) + (r.to?.let { "\n→ $it" } ?: "")) { deleting = r }
        }
        if (Store.schedules.isNotEmpty()) item { Caption(stringResource(R.string.recurring_footer)) }
    }
    val d = deleting
    AlertDialog(
        visible = d != null,
        onDismissRequest = { deleting = null },
        title = { Text(stringResource(R.string.delete)) },
        text = { Text(d?.text ?: "", maxLines = 3) },
        confirmButton = { AlertDialogDefaults.ConfirmButton(onClick = { d?.let { Store.removeSchedule(it.id) }; deleting = null }) },
        dismissButton = { AlertDialogDefaults.DismissButton(onClick = { deleting = null }) },
    )
}

@Composable
fun whenText(r: Recurring): String {
    val time = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(
        java.util.Calendar.getInstance().apply { set(java.util.Calendar.HOUR_OF_DAY, r.hour); set(java.util.Calendar.MINUTE, r.minute) }.time)
    return when (r.every) {
        Recurring.Every.Hour -> stringResource(R.string.every_hour_at, "%02d".format(r.minute))
        Recurring.Every.Day -> stringResource(R.string.every_day_at, time)
        Recurring.Every.Weekday -> stringResource(R.string.weekdays_at, time)
    }
}

@Composable
fun NewRecurringScreen(nav: NavHostController) {
    var text by rememberSaveable { mutableStateOf("") }
    var every by rememberSaveable { mutableStateOf(Recurring.Every.Day) }
    var time by rememberSaveable { mutableStateOf(LocalTime.of(9, 0)) }
    var to by rememberSaveable { mutableStateOf(Store.target) }
    var picking by rememberSaveable { mutableStateOf<String?>(null) } // "every", "time" or "to"
    val input = rememberTextInput(stringResource(R.string.what_should_claude_do)) { text = it.trim() }
    val everyLabels = mapOf(Recurring.Every.Hour to R.string.every_hour, Recurring.Every.Day to R.string.every_day, Recurring.Every.Weekday to R.string.weekdays)

    when (picking) {
        "time" -> { TimePicker(initialTime = time, onTimePicked = { time = it; picking = null }); return }
        "to" -> { ChatPicker(to) { to = it; picking = null }; return }
        "every" -> {
            ListScreen(stringResource(R.string.repeat)) {
                items(Recurring.Every.entries) { e ->
                    Item(stringResource(everyLabels.getValue(e)), if (e == every) Icons.Default.Check else null, tonal = e != every) { every = e; picking = null }
                }
            }
            return
        }
    }
    ListScreen(stringResource(R.string.new_), edgeButton = if (text.isNotBlank()) {
        {
            EdgeButton(onClick = {
                Store.addSchedule(Recurring(text = text, every = every, hour = time.hour, minute = time.minute, to = to))
                nav.popBackStack()
            }, buttonSize = EdgeButtonSize.Medium) { Icon(Icons.Default.Check, contentDescription = stringResource(R.string.save)) }
        }
    } else null) {
        item { Item(text.ifEmpty { stringResource(R.string.what_should_claude_do) }, Icons.Default.Edit, tonal = text.isNotEmpty(), onClick = input) }
        item { Item(stringResource(R.string.repeat), secondary = stringResource(everyLabels.getValue(every))) { picking = "every" } }
        item {
            Item(stringResource(if (every == Recurring.Every.Hour) R.string.minute_past else R.string.time),
                secondary = if (every == Recurring.Every.Hour) ":%02d".format(time.minute) else time.toString()) { picking = "time" }
        }
        if (Store.chatChoices.isNotEmpty()) item { Item(stringResource(R.string.to), secondary = to ?: stringResource(R.string.any_chat)) { picking = "to" } }
    }
}

@Composable
fun SettingsScreen(nav: NavHostController) {
    var confirmUnpair by remember { mutableStateOf(false) }
    var confirmClear by remember { mutableStateOf(false) }
    ListScreen(stringResource(R.string.settings)) {
        item { Item(stringResource(R.string.color), Icons.Default.Circle, secondary = stringResource(Store.theme.label)) { nav.navigate("settings/color") } }
        item {
            SwitchButton(checked = Store.themedBackground, onCheckedChange = Store::updateThemedBackground, modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.background)) })
        }
        item {
            SwitchButton(checked = Store.suggestionsOn, onCheckedChange = Store::updateSuggestionsOn, modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.suggestions)) })
        }
        item { Caption(stringResource(R.string.suggestions_footer)) }
        item { Item(stringResource(R.string.delete_all_history), danger = true, enabled = Store.notes.any { it.sent }) { confirmClear = true } }
        item { Item(stringResource(R.string.unpair), danger = true) { confirmUnpair = true } }
    }
    AlertDialog(
        visible = confirmClear,
        onDismissRequest = { confirmClear = false },
        title = { Text(stringResource(R.string.delete_all_history_q)) },
        text = { Text(stringResource(R.string.delete_all_history_message)) },
        confirmButton = { AlertDialogDefaults.ConfirmButton(onClick = { Store.clearHistory(); confirmClear = false }) },
        dismissButton = { AlertDialogDefaults.DismissButton(onClick = { confirmClear = false }) },
    )
    AlertDialog(
        visible = confirmUnpair,
        onDismissRequest = { confirmUnpair = false },
        title = { Text(stringResource(R.string.unpair_q)) },
        text = { Text(stringResource(R.string.unpair_message)) },
        confirmButton = { AlertDialogDefaults.ConfirmButton(onClick = { confirmUnpair = false; Store.updatePairing(null) }) },
        dismissButton = { AlertDialogDefaults.DismissButton(onClick = { confirmUnpair = false }) },
    )
}

@Composable
fun ColorScreen(done: () -> Unit) {
    ListScreen(stringResource(R.string.color)) {
        items(Theme.entries) { t ->
            Button(onClick = { Store.updateTheme(t); done() }, modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.filledTonalButtonColors(),
                icon = { Icon(if (t == Store.theme) Icons.Default.Check else Icons.Default.Circle, null, tint = t.color) },
                label = { Text(stringResource(t.label)) })
        }
    }
}

/** Browses the folders `handoff host` shares, to pick where a new Claude Code chat starts. */
@Composable
fun FolderScreen(nav: NavHostController, path: String) {
    var dirs by remember { mutableStateOf(if (path.isEmpty()) Store.projects else null) } // already known: show it at once, then refresh
    var unreachable by remember { mutableStateOf(false) }
    val newFolder = rememberTextInput(stringResource(R.string.new_folder)) { raw ->
        val f = raw.trim()
        if (f.isNotEmpty() && "/" !in f && !f.startsWith(".")) nav.navigate("name?path=${Uri.encode(path)}&new=${Uri.encode(f)}")
    }
    LaunchedEffect(path) {
        val fresh = Store.listFolders(path)
        if (fresh != null) dirs = fresh else if (dirs == null) unreachable = true
    }
    ListScreen(path.split("/").lastOrNull { it.isNotEmpty() } ?: Store.hostRoot ?: stringResource(R.string.new_chat)) {
        item { Item(stringResource(R.string.start_chat_here), Icons.Default.AddComment, tonal = false) { nav.navigate("name?path=${Uri.encode(path)}") } }
        item { Item(stringResource(R.string.new_folder), Icons.Default.Add, onClick = newFolder) }
        item { ListHeader { Text(stringResource(R.string.folders)) } }
        val d = dirs
        when {
            d != null -> {
                if (d.isEmpty()) item { Caption(stringResource(R.string.no_folders)) }
                items(d) { dir -> Item(dir, Icons.Default.Folder) { nav.toFolder(if (path.isEmpty()) dir else "$path/$dir") } }
            }
            unreachable -> item { Caption(stringResource(R.string.mac_didnt_answer)) }
            else -> item { CircularProgressIndicator(Modifier.size(24.dp)) }
        }
    }
}

/** Last step of New chat: name it (prefilled with the folder's name), then start it. */
@Composable
fun NameChatScreen(nav: NavHostController, path: String, newFolder: String?) {
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf(Store.defaultChatName(path, newFolder)) }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val rename = rememberTextInput(stringResource(R.string.chat_name)) { name = it.trim() }
    ListScreen(stringResource(R.string.name_chat)) {
        item { Item(name, Icons.Default.Edit, secondary = stringResource(R.string.chat_name), enabled = !busy, onClick = rename) }
        item {
            Item(stringResource(if (busy) R.string.starting else R.string.start_chat), Icons.Default.AddComment, tonal = false, enabled = !busy) {
                busy = true; failed = false
                scope.launch {
                    if (Store.startChat(path, newFolder, name)) nav.popBackStack("ideas", inclusive = false) else failed = true
                    busy = false
                }
            }
        }
        if (failed) item { Caption(stringResource(R.string.couldnt_reach_mac_retry), Color(0xFFFF6B6B)) }
        if (newFolder != null) item { Caption(stringResource(R.string.makes_folder_first, newFolder)) }
    }
}
