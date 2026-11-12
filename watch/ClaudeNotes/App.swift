import CryptoKit
import AppIntents
import ImageIO
import SwiftUI
import WatchKit
import WidgetKit

// Jot ideas on your wrist; Claude Code does them while you're away.
// By design there is no response view: you get a haptic and a checkmark, nothing to read.
// What comes back is Claude's suggested next prompt, which you can accept with a tap,
// screenshots (or GIFs) when Claude changed something you can look at, permission prompts from
// `handoff start` chats, which you can allow or deny, a question when Claude needs you to choose,
// and each evening a recap: the notes each chat finished that day, in your own words.

@main
struct ClaudeNotesApp: App {
    @State private var store = Store.shared
    @Environment(\.scenePhase) private var phase
    @AppStorage("theme") private var theme = Theme.clay

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                if store.pairing == nil { PairView() } else { EditorView() }
            }
            .tint(theme.color)
            .environment(store)
        }
            .onChange(of: phase) {
                // At the same time: each is a network round trip, so don't queue them up.
                if phase == .active { Task { async let f: Void = store.flush(); async let r: Void = store.refresh(); _ = await (f, r) } }
                else if phase == .background { store.finishSendingInBackground() }
            }
    }
}

/// The app's accent color, chosen in Settings → Color.
enum Theme: String, CaseIterable, Identifiable {
    case clay, yellow, blue, green, purple, pink, graphite
    var id: Self { self }
    var name: String {
        switch self {
        case .clay: String(localized: "Clay")
        case .yellow: String(localized: "Yellow")
        case .blue: String(localized: "Blue")
        case .green: String(localized: "Green")
        case .purple: String(localized: "Purple")
        case .pink: String(localized: "Pink")
        case .graphite: String(localized: "Graphite")
        }
    }
    var color: Color {
        switch self {
        case .clay: Color(red: 0.85, green: 0.47, blue: 0.34)
        case .yellow: Color(red: 0.98, green: 0.80, blue: 0.20)
        case .blue: Color(red: 0.25, green: 0.56, blue: 0.98)
        case .green: Color(red: 0.30, green: 0.78, blue: 0.45)
        case .purple: Color(red: 0.66, green: 0.45, blue: 0.95)
        case .pink: Color(red: 0.98, green: 0.42, blue: 0.62)
        case .graphite: Color(white: 0.62)
        }
    }
    /// For an icon on a button filled with `color`: black on the light ones, white on the rest.
    var onColor: Color { self == .yellow || self == .graphite ? .black : .white }
}

extension View {
    /// The chosen color as a soft glow behind the screen, unless Settings → Background is off.
    func themedBackground() -> some View { modifier(ThemedBackground()) }
}

struct ThemedBackground: ViewModifier {
    @AppStorage("theme") private var theme = Theme.clay
    @AppStorage("themedBackground") private var on = true

    func body(content: Content) -> some View {
        content.containerBackground(on ? theme.color.opacity(0.45).gradient : Color.black.gradient, for: .navigation)
    }
}

/// Haptics, except during tests: the simulator plays each one as a sound, and the tests send dozens.
enum Haptic {
    #if targetEnvironment(simulator)
    static let quiet = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        || UserDefaults.standard.bool(forKey: "quiet") // UI tests launch the app with `-quiet YES`
    #else
    static let quiet = false
    #endif

    static func play(_ type: WKHapticType) {
        if !quiet { WKInterfaceDevice.current().play(type) }
    }
}

/// Relay that carries ciphertext between watch and Mac. Must match RELAY in server/handoff.mjs.
enum Relay {
    #if targetEnvironment(simulator)
    // Tests point the simulator at a local mock relay with `-relay http://127.0.0.1:PORT`.
    nonisolated(unsafe) static var base = UserDefaults.standard.string(forKey: "relay") ?? "https://ntfy.sh"
    #else
    static let base = "https://ntfy.sh"
    #endif

    /// Every relay request goes through this. A request that gets no bytes for 15s fails (the
    /// default waits 60s), so one bad connection doesn't hold up the next check for a minute.
    /// Without its phone nearby, the watch goes online over its own Wi-Fi or cellular, which can
    /// take a few seconds to wake up: requests wait for that (up to 30s in all) instead of failing.
    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        config.waitsForConnectivity = true
        return URLSession(configuration: config)
    }()

    /// For screenshots and GIFs, which can be a few megabytes: more time to download.
    static let downloads: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 120
        config.waitsForConnectivity = true
        return URLSession(configuration: config)
    }()
}

struct Pairing: Codable {
    let topicURL: URL
    let key: Data
}

struct Note: Codable, Identifiable {
    let id: UUID
    let text: String
    let ts: Date
    var to: String? = nil // chat name; nil means any chat
    var sent = false
}

/// A next prompt Claude suggested when it finished a note (watch_note_done's `suggestion`).
struct Suggestion: Codable, Equatable {
    let id: String // relay message id
    let text: String
    var chat: String? = nil // the chat that suggested it; accepting sends it back there
}

/// A screenshot (or GIF) Claude sent when it finished a note (watch_note_done's `image`). The
/// picture itself is kept in a file (Store.shotFile), since it's too big for UserDefaults. The
/// newest few are kept; saved ones stay until deleted.
struct Shot: Codable, Identifiable, Equatable, Hashable {
    let id: String // relay message id
    var chat: String? = nil
    var saved = false
    var at = Date.now
}

/// The evening recap: the notes each chat finished today, in the user's words.
struct Recap: Codable, Equatable {
    struct Line: Codable, Equatable, Hashable {
        let chat: String
        let done: [String]
        let count: Int
    }
    let day: String
    let lines: [Line]
}

/// A permission prompt from a `handoff start` chat: Claude wants to use a tool and is waiting for
/// a yes or no, here or in the terminal (whichever comes first counts). Or, with `options`, a
/// question Claude asked (watch_ask): `what` is the question, and it waits for one of the options.
struct Approval: Codable, Identifiable, Equatable {
    let id: String // Claude Code's request id, or the question's
    let tool: String
    let what: String // Claude's description of the call
    let input: String // the call's arguments, as text
    var chat: String? = nil
    var options: [String]? = nil
}

/// A note Claude gets on a schedule, set up here and run by the Mac (see runDueSchedules in
/// server/relay.mjs): every hour at :m, or every day or every weekday at h:m, Mac time.
struct Recurring: Codable, Identifiable, Equatable {
    enum Every: String, Codable, CaseIterable { case hour, day, weekday }
    var id = UUID().uuidString
    var text: String
    var every: Every
    var hour = 9
    var minute = 0
    var to: String? = nil // chat name; nil means any chat
    var since = Date.now // never runs for a time before it was made

    var when: String {
        switch every {
        case .hour: return String(localized: "Every hour at :\(String(format: "%02d", minute))")
        case .day: return String(localized: "Every day at \(time)")
        case .weekday: return String(localized: "Weekdays at \(time)")
        }
    }
    private var time: String {
        Calendar.current.date(from: DateComponents(hour: hour, minute: minute))?.formatted(date: .omitted, time: .shortened) ?? ""
    }
}

/// What an open chat is up to, for the Projects screen.
struct ChatStatus: Equatable {
    var working: String? // the note it's on; nil when idle
    var branch: String? // nil when the folder isn't a git repository
    var changes = 0
    var ahead = 0
}

/// What the Mac posts back, sealed: suggestions on "<topic>-s", screenshots on "<topic>-i"; on "<topic>-c", chat heartbeats
/// and `handoff host`'s list of projects new chats can start in, plus each chat's status
/// (`working`, and `repo` messages with git status); permission prompts on "<topic>-p".
private struct BackMessage: Decodable {
    var s: String?
    var i: String? // screenshot, base64 PNG, JPEG or GIF
    var recap: String? // the evening recap's day, with its lines (on "<topic>-s")
    var lines: [Recap.Line]?
    var q: String? // a question from Claude (on "<topic>-p"), with its answers
    var question: String?
    var options: [String]?
    var chat: String?
    var host: String?
    var root: String?
    var projects: [String]?
    var chats: [String]? // chats the host runs headless
    var gone: Bool?
    var id: String? // folder listing replies on "<topic>-l"
    var dirs: [String]?
    var p: String? // permission prompt: request id, tool, description, arguments
    var tool: String?
    var what: String?
    var input: String?
    var working: String?
    var repo: String?
    var branch: String?
    var changes: Int?
    var ahead: Int?
}

@MainActor @Observable
final class Store {
    /// The app's store; Siri uses the same one.
    static let shared = Store()
    var draft: [String] { didSet { save() } }
    private(set) var notes: [Note]
    /// Settings → Suggestions. Off: no polling, nothing shown; back on: only suggestions from then on.
    var suggestionsOn: Bool {
        didSet {
            defaults.set(suggestionsOn, forKey: "suggestionsOn")
            if suggestionsOn { defaults.set(String(Int(Date.now.timeIntervalSince1970)), forKey: "suggestionSince") }
            else { suggestion = nil }
        }
    }
    var suggestion: Suggestion? {
        didSet {
            defaults.set(try? JSONEncoder().encode(suggestion), forKey: "suggestion")
            saveWidget()
        }
    }
    /// Screenshots and GIFs from Claude, newest first: the last few, plus any you saved.
    private(set) var shots: [Shot] = [] { didSet { defaults.set(try? JSONEncoder().encode(shots), forKey: "shots") } }
    /// Their pictures, loaded when first shown.
    private var images: [String: Picture] = [:]
    static let keepShots = 5 // unsaved
    /// The biggest screenshot download (sealed): a 4 MB GIF, as the Mac allows, plus base64 twice.
    static let maxDownload = 8_000_000
    static let shotsFolder = URL.applicationSupportDirectory.appending(path: "shots")
    static func shotFile(_ id: String) -> URL { shotsFolder.appending(path: id.filter { $0.isLetter || $0.isNumber }) }
    /// This evening's recap, until dismissed or the next one comes.
    var recap: Recap? { didSet { defaults.set(try? JSONEncoder().encode(recap), forKey: "recap") } }
    /// One-tap notes (Quick reply), editable there.
    var quickReplies: [String] { didSet { defaults.set(quickReplies, forKey: "quickReplies") } }
    static let defaultQuickReplies = [String(localized: "Keep going"), String(localized: "Commit it"),
                                      String(localized: "Run the tests"), String(localized: "Undo that")]
    /// What Ship it sends.
    static let shipIt = "Ship it: commit all the changes with a clear message and push them. If this project is deployed " +
        "somewhere (a website with a deploy script or hosting set up), deploy it too. Don't change anything else."
    /// Open Claude Code chats (`handoff start` sessions), by name.
    private(set) var chats: [String] = [] {
        didSet {
            HandOffShortcuts.updateAppShortcutParameters() // Siri learns the new chat names
            saveWidget()
        }
    }
    /// Projects `handoff host` can start a new chat in (empty when it isn't running).
    private(set) var projects: [String] = []
    /// Chats `handoff host` runs, which it can open on the Mac (Open on computer).
    private(set) var hostedChats: Set<String> = []
    /// The name of the host's folder (shown as the top of the folder browser).
    private(set) var hostRoot: String?
    /// Chats we asked the host to start that haven't announced themselves yet.
    private(set) var starting: Set<String> = []
    /// What each open chat is doing, by name.
    private(set) var status: [String: ChatStatus] = [:] { didSet { saveWidget() } }
    /// Recurring tasks. The Mac gets the whole list whenever it changes.
    var schedules: [Recurring] {
        didSet {
            defaults.set(try? JSONEncoder().encode(schedules), forKey: "schedules")
            defaults.set(true, forKey: "schedulesUnsent")
            Task { await syncSchedules() }
        }
    }
    /// Permission prompts waiting for an answer, oldest first.
    private(set) var approvals: [Approval] = []
    /// The chat new notes go to; nil sends to any open chat.
    var target: String? { didSet { defaults.set(target, forKey: "target") } }
    static let chatWindow = "20m" // chats announce themselves when they change, and every 15 minutes
    static let approvalWindow = "10m" // older prompts have likely been answered at the Mac
    private(set) var pairing = Keychain.load().flatMap { try? JSONDecoder().decode(Pairing.self, from: $0) }
    private var sending: Task<Void, Never>?
    private var refreshing: Task<Void, Never>?
    private var retry: Task<Void, Never>?
    let defaults: UserDefaults
    static let keep = 12
    static let retryDelay = Duration.seconds(15)

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        draft = defaults.stringArray(forKey: "draft") ?? []
        notes = (defaults.data(forKey: "notes")).flatMap { try? JSONDecoder().decode([Note].self, from: $0) } ?? []
        suggestionsOn = defaults.object(forKey: "suggestionsOn") as? Bool ?? true
        suggestion = (defaults.data(forKey: "suggestion")).flatMap { try? JSONDecoder().decode(Suggestion.self, from: $0) }
        target = defaults.string(forKey: "target")
        quickReplies = defaults.stringArray(forKey: "quickReplies") ?? Self.defaultQuickReplies
        recap = (defaults.data(forKey: "recap")).flatMap { try? JSONDecoder().decode(Recap.self, from: $0) }
        shots = (defaults.data(forKey: "shots")).flatMap { try? JSONDecoder().decode([Shot].self, from: $0) } ?? []
        schedules = (defaults.data(forKey: "schedules")).flatMap { try? JSONDecoder().decode([Recurring].self, from: $0) } ?? []
        // Hand-Off 1.2 kept just the latest screenshot, in caches.
        let old = URL.cachesDirectory.appending(path: "screenshot")
        if let saved = defaults.data(forKey: "screenshot"),
           let id = (try? JSONSerialization.jsonObject(with: saved) as? [String: Any])?["id"] as? String,
           let bytes = try? Data(contentsOf: old) {
            try? FileManager.default.createDirectory(at: Self.shotsFolder, withIntermediateDirectories: true)
            if (try? bytes.write(to: Self.shotFile(id))) != nil {
                shots.insert(Shot(id: id), at: 0)
                defaults.set(try? JSONEncoder().encode(shots), forKey: "shots")
            }
        }
        defaults.removeObject(forKey: "screenshot")
        try? FileManager.default.removeItem(at: old)
        #if targetEnvironment(simulator)
        if defaults.bool(forKey: "resetPairing") { setPairing(nil) } // UI tests start unpaired
        #endif
    }

    func send() {
        let text = draft.joined(separator: "\n")
        guard !text.isEmpty else { return }
        draft = []
        enqueue(text, to: target)
    }

    /// Siri's Tell Claude: queues the note for `chat` (default: the chosen chat) and tries to send
    /// it now. Returns whether it reached the relay.
    func sendFromSiri(_ text: String, to chat: String? = nil) async -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return false }
        enqueue(t, to: chat ?? target)
        await flush()
        return pending == 0
    }

    /// Sends a quick reply as a note, to the chosen chat.
    func sendQuick(_ text: String) {
        enqueue(text, to: target)
    }

    /// Ship it: asks `chat` to commit, push and deploy what it did.
    func shipIt(_ chat: String) {
        enqueue(Self.shipIt, to: chat)
    }

    /// Stop: asks `chat` to stop the note it's working on. A `handoff host` chat is stopped by the
    /// host; a `handoff start` chat gets the message from its own server. Returns false if not sent.
    func stop(_ chat: String) async -> Bool {
        guard let pairing else { return false }
        var sent = false
        if hostedChats.contains(chat) {
            sent = await askHost(["stop": chat])
        } else if let body = try? JSONSerialization.data(withJSONObject: ["stop": chat, "ts": Date.now.ISO8601Format()]) {
            sent = (try? await Ntfy.publish(body, key: SymmetricKey(data: pairing.key),
                                            to: URL(string: pairing.topicURL.absoluteString + "-v")!)) != nil
        }
        if sent { Haptic.play(.directionDown) }
        return sent
    }

    /// Sends Claude's suggestion back to it as a new note.
    func acceptSuggestion() {
        guard let s = suggestion else { return }
        suggestion = nil
        enqueue(s.text, to: s.chat ?? target)
    }

    private func enqueue(_ text: String, to chat: String?) {
        notes.insert(Note(id: UUID(), text: text, ts: .now, to: chat), at: 0)
        // Trim history, but never drop a note that hasn't been delivered yet.
        while notes.count > Self.keep, let i = notes.lastIndex(where: \.sent) { notes.remove(at: i) }
        save()
        Haptic.play(.success)
        Task { await flush() }
    }

    /// Settings → Delete All History. Notes still waiting to send are kept, so no idea is lost.
    func clearHistory() {
        notes.removeAll(where: \.sent)
        save()
    }

    /// Checks chats and suggestions at the same time. Calls made while one is running (the app
    /// becoming active and the list appearing both ask) wait for it instead of starting another.
    func refresh() async {
        if let refreshing { return await refreshing.value }
        let task = Task {
            async let c: Void = checkChats()
            async let s: Void = checkSuggestion()
            async let a: Void = checkApprovals()
            async let i: Void = checkScreenshot()
            _ = await (c, s, a, i)
        }
        refreshing = task
        await task.value
        refreshing = nil
    }

    /// The chat picker's choices: open chats, plus the chosen one even while it's offline.
    var chatChoices: [String] {
        guard let target, !chats.contains(target) else { return chats }
        return chats + [target]
    }

    /// Rebuilds the list of open chats from the last few minutes of heartbeats on "<topic>-c".
    func checkChats() async {
        guard let pairing else { return }
        let url = URL(string: "\(pairing.topicURL.absoluteString)-c/json?poll=1&since=\(Self.chatWindow)")!
        guard let (data, _) = try? await Relay.session.data(from: url),
              self.pairing?.topicURL == pairing.topicURL else { return }
        var open = Set<String>()
        var hostProjects: [String] = []
        var hostChats: [String] = []
        var git: [String: ChatStatus] = [:], beatWorking: [String: String] = [:], hostWorking: [String: String] = [:]
        for msg in Self.messages(in: data, key: SymmetricKey(data: pairing.key)) {
            if let repo = msg.body.repo {
                // From `handoff start` (git only) or `handoff host` (git, and the note it's running).
                git[repo] = ChatStatus(branch: msg.body.branch, changes: msg.body.changes ?? 0, ahead: msg.body.ahead ?? 0)
                hostWorking[repo] = msg.body.working
                continue
            }
            if msg.body.host != nil {
                hostProjects = msg.body.gone == true ? [] : msg.body.projects ?? []
                hostChats = msg.body.gone == true ? [] : msg.body.chats ?? []
                if let root = msg.body.root { hostRoot = root }
            }
            guard let name = msg.body.chat, !name.isEmpty else { continue }
            if msg.body.gone == true { open.remove(name) } else { open.insert(name); beatWorking[name] = msg.body.working }
        }
        open.formUnion(hostChats)
        var status: [String: ChatStatus] = [:]
        for name in open {
            var s = git[name] ?? ChatStatus()
            s.working = hostChats.contains(name) ? hostWorking[name] : beatWorking[name]
            status[name] = s
        }
        if status != self.status { self.status = status }
        let sorted = open.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        if sorted != chats { chats = sorted }
        if hostProjects != projects { projects = hostProjects }
        if Set(hostChats) != hostedChats { hostedChats = Set(hostChats) }
        starting.subtract(open)
    }

    /// Sends a sealed request to `handoff host` on "<topic>-n".
    private func askHost(_ fields: [String: String]) async -> Bool {
        guard let pairing else { return false }
        var fields = fields
        fields["ts"] = Date.now.ISO8601Format()
        guard let body = try? JSONSerialization.data(withJSONObject: fields) else { return false }
        return (try? await Ntfy.publish(body, key: SymmetricKey(data: pairing.key), to: URL(string: pairing.topicURL.absoluteString + "-n")!)) != nil
    }

    /// The subfolders of `path` (relative to the host's folder; "" is the top), or nil if the Mac didn't answer.
    func listFolders(_ path: String, timeout: Duration = .seconds(12)) async -> [String]? {
        guard let pairing else { return nil }
        let id = UUID().uuidString
        let key = SymmetricKey(data: pairing.key)
        let since = Int(Date.now.timeIntervalSince1970) - 1
        guard await askHost(["ls": path, "id": id]) else { return nil }
        // Listen on the reply topic instead of polling it, so the folders show as soon as the Mac
        // answers. `since` covers a reply that arrives before the stream is open.
        let url = URL(string: "\(pairing.topicURL.absoluteString)-l/json?since=\(since)")!
        return await withTaskGroup(of: [String]?.self) { group in
            group.addTask { await Self.listing(id: id, at: url, key: key) }
            group.addTask { try? await Task.sleep(for: timeout); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// Streams `url` until the folder listing answering request `id` arrives.
    nonisolated private static func listing(id: String, at url: URL, key: SymmetricKey) async -> [String]? {
        guard let (bytes, _) = try? await Relay.session.bytes(from: url) else { return nil }
        do {
            for try await line in bytes.lines {
                if let reply = messages(in: Data(line.utf8), key: key).first(where: { $0.body.id == id }) {
                    return reply.body.dirs ?? []
                }
            }
        } catch {}
        return nil
    }

    /// The name a new chat in `path` (or in a new folder there) gets unless you change it.
    func defaultChatName(in path: String, newFolder: String? = nil) -> String {
        newFolder ?? path.split(separator: "/").last.map(String.init) ?? hostRoot ?? "Chat"
    }

    /// Asks `handoff host` to open a new chat in `path` (relative to its folder), optionally in a
    /// new folder made there first, and points new notes at it. Notes sent before it's up wait for it.
    /// `name` is the chat's name (default: the folder's). Returns false if the request couldn't be sent.
    func startChat(in path: String, newFolder: String? = nil, name custom: String? = nil) async -> Bool {
        let typed = String((custom ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        let base = typed.isEmpty ? defaultChatName(in: path, newFolder: newFolder) : typed
        var name = base, n = 1
        while chats.contains(name) || starting.contains(name) { n += 1; name = "\(base) \(n)" }
        var fields = ["path": path, "name": name]
        fields["create"] = newFolder
        guard await askHost(fields) else { return false }
        starting.insert(name)
        target = name
        Haptic.play(.success)
        return true
    }

    /// Asks `handoff host` to open one of its chats on the Mac, as a normal Claude Code window in
    /// Terminal that continues the conversation. Returns false if the request couldn't be sent.
    func openOnComputer(_ name: String) async -> Bool {
        guard hostedChats.contains(name), await askHost(["open": name]) else { return false }
        Haptic.play(.success)
        return true
    }

    /// Decrypts a relay poll response, oldest first, skipping anything not sealed with our key.
    nonisolated private static func messages(in data: Data, key: SymmetricKey) -> [(id: String, body: BackMessage)] {
        data.split(separator: UInt8(ascii: "\n")).compactMap { line in
            guard let ev = try? JSONDecoder().decode(Ntfy.Event.self, from: line), let id = ev.id,
                  let box = ev.message.flatMap({ Data(base64Encoded: $0) }),
                  let plain = try? AES.GCM.open(AES.GCM.SealedBox(combined: box), using: key),
                  let body = try? JSONDecoder().decode(BackMessage.self, from: plain) else { return nil }
            return (id, body)
        }
    }

    /// Rebuilds the list of permission prompts from the last few minutes on "<topic>-p", leaving
    /// out ones answered here. A haptic says a new one came in.
    func checkApprovals() async {
        guard let pairing else { return }
        let url = URL(string: "\(pairing.topicURL.absoluteString)-p/json?poll=1&since=\(Self.approvalWindow)")!
        guard let (data, _) = try? await Relay.session.data(from: url),
              self.pairing?.topicURL == pairing.topicURL else { return }
        let answered = Set(defaults.stringArray(forKey: "answered") ?? [])
        var open: [Approval] = []
        for msg in Self.messages(in: data, key: SymmetricKey(data: pairing.key)) {
            guard let id = msg.body.p ?? msg.body.q, !answered.contains(id), !open.contains(where: { $0.id == id }) else { continue }
            if let options = msg.body.options, msg.body.q != nil {
                open.append(Approval(id: id, tool: "", what: msg.body.question ?? "", input: "", chat: msg.body.chat, options: options))
            } else {
                open.append(Approval(id: id, tool: msg.body.tool ?? "a tool", what: msg.body.what ?? "",
                                     input: msg.body.input ?? "", chat: msg.body.chat))
            }
        }
        if open.contains(where: { a in !approvals.contains(where: { $0.id == a.id }) }) {
            Haptic.play(.notification)
        }
        if open != approvals { approvals = open }
    }

    /// Sends the whole list of recurring tasks to the Mac, sealed, on "<topic>-r", if it changed
    /// since it was last sent. The newest list wins there; the relay keeps it 12 hours, and the Mac
    /// keeps the last one it got.
    func syncSchedules() async {
        guard let pairing, defaults.bool(forKey: "schedulesUnsent") else { return }
        let sent = schedules
        let list: [[String: Any]] = sent.map { r in
            var d: [String: Any] = ["id": r.id, "t": r.text, "every": r.every.rawValue, "h": r.hour, "m": r.minute,
                                    "since": r.since.ISO8601Format()]
            d["to"] = r.to
            return d
        }
        guard let body = try? JSONSerialization.data(withJSONObject: ["schedules": list, "ts": Self.preciseTime.string(from: .now)]),
              (try? await Ntfy.publish(body, key: SymmetricKey(data: pairing.key),
                                       to: URL(string: pairing.topicURL.absoluteString + "-r")!)) != nil,
              self.pairing?.topicURL == pairing.topicURL,
              schedules == sent else { return } // edited while sending: that edit's own sync sends the new list
        defaults.set(false, forKey: "schedulesUnsent")
    }

    /// To the millisecond, so two quick edits to the list are told apart.
    nonisolated(unsafe) private static let preciseTime: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Allows or denies a permission prompt. Returns false if the answer couldn't be sent.
    func answer(_ a: Approval, allow: Bool) async -> Bool {
        guard let pairing else { return false }
        var fields: [String: Any] = ["v": a.id, "ok": allow, "ts": Date.now.ISO8601Format()]
        fields["chat"] = a.chat
        guard let body = try? JSONSerialization.data(withJSONObject: fields),
              (try? await Ntfy.publish(body, key: SymmetricKey(data: pairing.key),
                                       to: URL(string: pairing.topicURL.absoluteString + "-v")!)) != nil else { return false }
        markAnswered(a)
        Haptic.play(allow ? .success : .directionDown)
        return true
    }

    /// Answers a question Claude asked with one of its options. Returns false if it couldn't be sent.
    func choose(_ a: Approval, _ option: String) async -> Bool {
        guard let pairing else { return false }
        var fields: [String: Any] = ["a": a.id, "choice": option, "ts": Date.now.ISO8601Format()]
        fields["chat"] = a.chat
        guard let body = try? JSONSerialization.data(withJSONObject: fields),
              (try? await Ntfy.publish(body, key: SymmetricKey(data: pairing.key),
                                       to: URL(string: pairing.topicURL.absoluteString + "-v")!)) != nil else { return false }
        markAnswered(a)
        Haptic.play(.success)
        return true
    }

    private func markAnswered(_ a: Approval) {
        defaults.set(Array(((defaults.stringArray(forKey: "answered") ?? []) + [a.id]).suffix(50)), forKey: "answered")
        approvals.removeAll { $0.id == a.id }
    }

    /// Picks up the newest suggestion the Mac posted to "<topic>-s" since we last looked, and the
    /// evening recap, which comes the same way.
    func checkSuggestion() async {
        guard let pairing else { return }
        let since = defaults.string(forKey: "suggestionSince") ?? "12h"
        let url = URL(string: "\(pairing.topicURL.absoluteString)-s/json?poll=1&since=\(since)")!
        guard let (data, _) = try? await Relay.session.data(from: url),
              self.pairing?.topicURL == pairing.topicURL else { return } // changed meanwhile
        // Advance past everything seen, including junk, so it isn't fetched again.
        for line in data.split(separator: UInt8(ascii: "\n")) {
            if let id = (try? JSONDecoder().decode(Ntfy.Event.self, from: line))?.id { defaults.set(id, forKey: "suggestionSince") }
        }
        let messages = Self.messages(in: data, key: SymmetricKey(data: pairing.key))
        if suggestionsOn, let (id, body) = messages.last(where: { $0.body.s?.isEmpty == false }) {
            suggestion = Suggestion(id: id, text: body.s!, chat: body.chat)
        }
        if let body = messages.last(where: { $0.body.recap != nil && $0.body.lines?.isEmpty == false })?.body {
            recap = Recap(day: body.recap!, lines: body.lines!)
            Haptic.play(.notification)
        }
    }

    /// Picks up the screenshots chats posted to "<topic>-i" since we last looked (the newest few).
    /// They're too big for a relay message, so each is an attachment (kept about 3 hours) that we download.
    func checkScreenshot() async {
        guard let pairing else { return }
        let since = defaults.string(forKey: "screenshotSince") ?? "3h"
        let url = URL(string: "\(pairing.topicURL.absoluteString)-i/json?poll=1&since=\(since)")!
        guard let (data, _) = try? await Relay.session.data(from: url),
              self.pairing?.topicURL == pairing.topicURL else { return }
        let key = SymmetricKey(data: pairing.key)
        let events = data.split(separator: UInt8(ascii: "\n")).compactMap { try? JSONDecoder().decode(Ntfy.Event.self, from: $0) }
        // Newest first: only the latest few are kept, so older ones needn't be downloaded.
        var got: [(Shot, Data, Picture)] = []
        for ev in events.reversed() where got.count < Self.keepShots {
            guard let id = ev.id else { continue }
            var sealed = ev.message
            if let a = ev.attachment, (a.size ?? 0) <= Self.maxDownload, let u = URL(string: a.url) {
                // Not downloaded (offline, or it expired): try again next time, unless it's gone for good.
                guard let (file, res) = try? await Relay.downloads.data(from: u) else { return }
                sealed = (res as? HTTPURLResponse)?.statusCode == 200 ? String(data: file, encoding: .utf8) : nil
            }
            guard self.pairing?.topicURL == pairing.topicURL else { return }
            if let box = sealed.flatMap({ Data(base64Encoded: $0) }),
               let plain = try? AES.GCM.open(AES.GCM.SealedBox(combined: box), using: key),
               let body = try? JSONDecoder().decode(BackMessage.self, from: plain),
               let bytes = body.i.flatMap({ Data(base64Encoded: $0) }), let image = Picture(bytes),
               !shots.contains(where: { $0.id == id }) {
                got.append((Shot(id: id, chat: body.chat), bytes, image))
            }
        }
        try? FileManager.default.createDirectory(at: Self.shotsFolder, withIntermediateDirectories: true)
        for (shot, bytes, image) in got.reversed() where (try? bytes.write(to: Self.shotFile(shot.id))) != nil { // oldest first
            images[shot.id] = image
            shots.insert(shot, at: 0)
        }
        if !got.isEmpty { pruneShots(); Haptic.play(.notification) }
        if let last = events.last?.id { defaults.set(last, forKey: "screenshotSince") }
    }

    /// A shot's picture (playing, if it's a GIF), or nil if its file is gone.
    func image(_ shot: Shot) -> Picture? {
        if let i = images[shot.id] { return i }
        let i = (try? Data(contentsOf: Self.shotFile(shot.id))).flatMap(Picture.init)
        images[shot.id] = i
        return i
    }

    /// Save: keeps a shot until you delete it, however many new ones come.
    func toggleSave(_ shot: Shot) {
        guard let i = shots.firstIndex(where: { $0.id == shot.id }) else { return }
        shots[i].saved.toggle()
        Haptic.play(shots[i].saved ? .success : .click)
        pruneShots()
    }

    func deleteShot(_ shot: Shot) {
        shots.removeAll { $0.id == shot.id }
        images[shot.id] = nil
        try? FileManager.default.removeItem(at: Self.shotFile(shot.id))
    }

    /// Keeps every saved shot and the newest few others.
    private func pruneShots() {
        for s in shots.filter({ !$0.saved }).dropFirst(Self.keepShots) { deleteShot(s) }
    }

    /// Saves what the Smart Stack widget shows and asks it to redraw, when that changed.
    private func saveWidget() {
        let working = chats.compactMap { name in status[name]?.working.map { WidgetState.Work(chat: name, note: $0) } }
        var state = WidgetState(suggestion: suggestion?.text, suggestionChat: suggestion?.chat, working: working, chats: chats.count)
        if let old = WidgetState.load() {
            state.updated = old.updated
            if old == state { return } // `updated` only changes with the contents
        }
        state.updated = .now
        state.save()
        WidgetCenter.shared.reloadTimelines(ofKind: "Status")
    }

    /// What Siri says when asked what's going on: each open chat's note, or that it's free.
    func spokenStatus() -> String {
        guard pairing != nil else { return String(localized: "Open Hand-Off and pair it with your Mac first.") }
        guard !chats.isEmpty else { return String(localized: "No chats are open. Start one on your Mac with handoff start.") }
        var lines = chats.map { name in
            status[name]?.working.map { String(localized: "\(name) is working on: \($0)") } ?? String(localized: "\(name) is free.")
        }
        if let s = suggestion { lines.append(String(localized: "Claude suggests: \(s.text)")) }
        return lines.joined(separator: "\n")
    }

    func setPairing(_ p: Pairing?) {
        // A send still trying the old pairing would hold up the queue: stop it, start over.
        sending?.cancel()
        sending = nil
        retry?.cancel()
        pairing = p
        status = [:]
        if !schedules.isEmpty { defaults.set(true, forKey: "schedulesUnsent") } // the new pairing's Mac needs the list
        suggestion = nil
        recap = nil
        chats = []
        projects = []
        hostedChats = []
        starting = []
        approvals = []
        target = nil
        defaults.removeObject(forKey: "suggestionSince")
        defaults.removeObject(forKey: "screenshotSince")
        Keychain.save(p.flatMap { try? JSONEncoder().encode($0) })
        if p != nil { Haptic.play(.success); Task { await flush() } }
    }

    var pending: Int { notes.count(where: { !$0.sent }) }

    /// Delivers queued notes oldest first. On failure, retries every 15s while the app runs
    /// (watchOS suspends us in the background), and again whenever the app becomes active.
    /// A call made while a delivery is running waits for that one to finish.
    func flush() async {
        if let sending { return await sending.value }
        guard pairing != nil else { return }
        let task = Task { if await deliver() { await syncSchedules() } }
        sending = task
        await task.value
        if sending == task { sending = nil } // not if setPairing replaced it meanwhile
    }

    /// The app is leaving the screen with notes still to send: ask watchOS for a little more time
    /// to finish. On a watch without its phone nearby, sending often takes longer than the moment
    /// between lowering your wrist and the app being suspended.
    func finishSendingInBackground() {
        guard pending > 0 else { return }
        ProcessInfo.processInfo.performExpiringActivity(withReason: "Sending your notes") { expired in
            guard !expired else { return }
            let done = DispatchSemaphore(value: 0)
            Task { @MainActor in await self.flush(); done.signal() }
            _ = done.wait(timeout: .now() + 25) // holds the extra time until sent, or watchOS ends it
        }
    }

    /// Returns false if a note couldn't be sent (a retry is scheduled).
    private func deliver() async -> Bool {
        guard let pairing else { return false }
        for note in notes.reversed() where !note.sent {
            guard await Self.post(note, to: pairing) else {
                if !Task.isCancelled { scheduleRetry() }
                return false
            }
            if let i = notes.firstIndex(where: { $0.id == note.id }) { notes[i].sent = true }
            save()
        }
        return true
    }

    private func scheduleRetry() {
        retry?.cancel()
        retry = Task {
            try? await Task.sleep(for: Self.retryDelay)
            if !Task.isCancelled { await flush() }
        }
    }

    private func save() {
        defaults.set(draft, forKey: "draft")
        defaults.set(try? JSONEncoder().encode(notes), forKey: "notes")
    }

    nonisolated private static func post(_ note: Note, to pairing: Pairing) async -> Bool {
        do {
            var fields = ["id": note.id.uuidString, "t": note.text, "ts": note.ts.ISO8601Format()]
            fields["to"] = note.to
            let payload = try JSONSerialization.data(withJSONObject: fields)
            return try await Ntfy.publish(payload, key: SymmetricKey(data: pairing.key), to: pairing.topicURL) != nil
        } catch {
            return false
        }
    }
}

enum PairError: Error { case badCode, noAnswer, relay, dailyLimit }

/// One-time pairing. The code we show (typed into `handoff pair` on the Mac) derives, via HKDF, a
/// pairing key and topic. We generate our own topic + key, send them sealed with the pairing key,
/// and wait for the Mac's sealed ack. A mistyped code derives a different topic, so nothing answers.
enum Pairer {
    static let alphabet = Set("ABCDEFGHJKMNPQRSTUVWXYZ23456789")

    /// A fresh 8-character code (about 40 bits), shown on the watch for the user to type on the Mac.
    static func newCode() -> String {
        let chars = Array("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
        var rng = SystemRandomNumberGenerator()
        return String((0..<8).map { _ in chars.randomElement(using: &rng)! })
    }

    static func pair(code raw: String, waitFor: Duration = .seconds(30)) async throws -> Pairing {
        let code = String(raw.uppercased().filter(alphabet.contains))
        guard code.count == 8 else { throw PairError.badCode }

        func derive(_ info: String, _ n: Int) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: Data(code.utf8)),
                                   salt: Data("claude-watch-notes-pair".utf8), info: Data(info.utf8), outputByteCount: n)
        }
        let pairKey = derive("key", 32)
        let pairURL = URL(string: "\(Relay.base)/cwp-\(derive("topic", 16).hex)")!

        let topic = "cw-\(SymmetricKey(size: .bits128).hex)"
        let pairing = Pairing(topicURL: URL(string: "\(Relay.base)/\(topic)")!, key: SymmetricKey(size: .bits256).data)
        let nonce = SymmetricKey(size: .bits128).hex

        let offer = try JSONSerialization.data(withJSONObject: [
            "topic": pairing.topicURL.absoluteString, "key": pairing.key.base64EncodedString(), "n": nonce,
            "moves": true, // we follow the Mac to its own relay if its answer names one
        ])
        // Listen for replies after our own offer's message id: no dependence on clocks agreeing.
        let offerID: String?
        do { offerID = try await Ntfy.publish(offer, key: pairKey, to: pairURL) } catch is Ntfy.DailyLimit { throw PairError.dailyLimit }
        guard let offerID else { throw PairError.relay }
        let url = URL(string: "\(pairURL.absoluteString)/json?since=\(offerID)")!
        let ack = await withTaskGroup(of: [String: String]?.self) { group in
            group.addTask { await waitForAck(nonce, at: url, key: pairKey) }
            group.addTask { try? await Task.sleep(for: waitFor); return nil }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        try Task.checkCancellation()
        guard let ack else { throw PairError.noAnswer }
        // The Mac runs its own relay (`handoff relay setup`): the same topic, there instead.
        if let relay = ack["relay"].flatMap(ownRelay) {
            return Pairing(topicURL: relay.appending(path: topic), key: pairing.key)
        }
        return pairing
    }

    /// An https address with nothing but a host (and port), like https://mac.tail1234.ts.net.
    nonisolated static func ownRelay(_ s: String) -> URL? {
        guard let c = URLComponents(string: s), c.scheme == "https", let host = c.host, !host.isEmpty,
              c.path.isEmpty || c.path == "/", c.query == nil, c.user == nil else { return nil }
        var clean = URLComponents()
        clean.scheme = "https"; clean.host = host; clean.port = c.port
        return clean.url
    }

    /// Streams the pairing topic (one open request, not a poll every few seconds: ntfy.sh limits
    /// requests per IP address, which the watch shares with the Mac at home) until the Mac's ack.
    /// A stream ends after Relay.session's 30s limit; then it reconnects, waiting longer if refused.
    nonisolated private static func waitForAck(_ nonce: String, at url: URL, key: SymmetricKey) async -> [String: String]? {
        while !Task.isCancelled {
            var pause = Duration.seconds(1)
            if let (bytes, res) = try? await Relay.session.bytes(from: url) {
                if (res as? HTTPURLResponse)?.statusCode != 200 { pause = .seconds(15) }
                do {
                    for try await line in bytes.lines {
                        guard let ev = try? JSONDecoder().decode(Ntfy.Event.self, from: Data(line.utf8)),
                              let box = ev.message.flatMap({ Data(base64Encoded: $0) }),
                              let plain = try? AES.GCM.open(AES.GCM.SealedBox(combined: box), using: key),
                              let ack = try? JSONDecoder().decode([String: String].self, from: plain),
                              ack["ack"] == nonce
                        else { continue }
                        return ack
                    }
                } catch {}
            } else {
                pause = .seconds(5)
            }
            try? await Task.sleep(for: pause)
        }
        return nil
    }
}

enum Ntfy {
    struct Event: Decodable {
        let id: String?
        let message: String?
        var attachment: Attachment? = nil // bodies of 4 KB or more
    }
    struct Attachment: Decodable {
        let url: String
        let size: Int?
    }

    /// ntfy.sh refused a message because this internet connection sent its daily allowance (error
    /// 42908). Nothing gets through until it resets at midnight UTC.
    struct DailyLimit: Error, Equatable {}

    /// When ntfy.sh's daily limits reset: the next midnight UTC.
    static var limitResets: Date {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        return utc.nextDate(after: .now, matching: DateComponents(hour: 0, minute: 0), matchingPolicy: .nextTime) ?? .now
    }

    /// Seals with AES-GCM (nonce|ciphertext|tag, base64) and posts to the topic.
    /// Returns the relay's message id, or nil if the relay didn't accept it. Throws DailyLimit when
    /// the relay's daily limit is used up.
    static func publish(_ plain: Data, key: SymmetricKey, to url: URL) async throws -> String? {
        guard let sealed = try AES.GCM.seal(plain, using: key).combined else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.httpBody = sealed.base64EncodedData()
        let (data, res) = try await Relay.session.data(for: req)
        if (res as? HTTPURLResponse)?.statusCode == 429, String(decoding: data, as: UTF8.self).contains("42908") { throw DailyLimit() }
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return (try? JSONDecoder().decode(Event.self, from: data))?.id ?? ""
    }
}

enum Keychain {
    private static var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrAccount as String: "pairing",
    ] }

    static func load() -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func save(_ data: Data?) {
        SecItemDelete(query as CFDictionary)
        guard let data else { return }
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}

extension SymmetricKey {
    var data: Data { withUnsafeBytes { Data($0) } }
    var hex: String { data.map { String(format: "%02x", $0) }.joined() }
}

struct PairView: View {
    @Environment(Store.self) private var store
    @State private var code = Self.firstCode()
    @State private var failure: String?

    var body: some View {
        List {
            Text("On your Mac, run handoff pair and type this code:")
                .font(.footnote).foregroundStyle(.secondary)
                .listRowBackground(Color.clear)
            Text("\(code.prefix(4))-\(code.suffix(4))")
                .font(.system(.title3, design: .monospaced)).bold()
                .lineLimit(1).minimumScaleFactor(0.5)
                .foregroundStyle(failure == nil ? .primary : .secondary)
                .accessibilityIdentifier("pairCode")
                .listRowBackground(Color.clear)
            if let failure {
                Text(failure).font(.footnote).foregroundStyle(.red)
                Button("New code") { code = Pairer.newCode(); self.failure = nil }
            } else {
                HStack { ProgressView().frame(width: 24); Text("Waiting for your Mac…").font(.footnote) }
            }
        }
        .navigationTitle("Pair")
        .themedBackground()
        // Offers the pairing as soon as the code is on screen, then waits up to 10 minutes for the Mac.
        .task(id: code) {
            guard failure == nil else { return }
            do {
                store.setPairing(try await Pairer.pair(code: code, waitFor: .seconds(600)))
            } catch is CancellationError {
            } catch PairError.noAnswer {
                failure = String(localized: "This code expired.")
            } catch PairError.relay {
                failure = String(localized: "The relay is busy. Try again in a minute.")
            } catch PairError.dailyLimit {
                failure = String(localized: "The relay's daily message limit for your internet connection is used up. Try another network, like cellular, or try again after \(Ntfy.limitResets.formatted(date: .omitted, time: .shortened)).")
            } catch {
                failure = String(localized: "Couldn't reach the relay. Check your connection.")
            }
        }
    }

    #if targetEnvironment(simulator)
    @MainActor static var usedLaunchCode = false
    #endif

    /// `handoff pair` and the tests launch the simulator app with `-pairCode <code>`, so they know the
    /// code without reading it off the screen. Used once; after Unpair, a fresh code is shown.
    @MainActor private static func firstCode() -> String {
        #if targetEnvironment(simulator)
        if !usedLaunchCode, let c = UserDefaults.standard.string(forKey: "pairCode") {
            usedLaunchCode = true
            return String(c.uppercased().filter(Pairer.alphabet.contains))
        }
        #endif
        return Pairer.newCode()
    }
}

struct EditorView: View {
    @Environment(Store.self) private var store
    @State private var line = ""
    @State private var showSettings = false
    @State private var showNewChat = false
    @State private var opened: String? // what Open on computer did, shown for a moment
    @AppStorage("theme") private var theme = Theme.clay
    private var accent: Color { theme.color }

    var body: some View {
        @Bindable var store = store
        List {
            ForEach(store.approvals) { a in ApprovalSection(approval: a) }

            if let shot = store.shots.first, let image = store.image(shot) {
                Section(shot.chat.map { String(localized: "Screenshot · \($0)") } ?? String(localized: "Screenshot")) {
                    NavigationLink { ShotView(shot: shot) } label: {
                        PictureView(picture: image)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .accessibilityLabel("Screenshot")
                    }
                    .swipeActions { Button("Delete", role: .destructive) { store.deleteShot(shot) } }
                    if store.shots.count > 1 {
                        NavigationLink { GalleryView() } label: {
                            Label("All screenshots (\(store.shots.count))", systemImage: "photo.stack")
                        }
                    }
                }
            }

            if let recap = store.recap {
                Section("Today") {
                    ForEach(recap.lines, id: \.self) { line in
                        NavigationLink { GalleryView(chat: line.chat) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(line.chat) · \(line.count) done").font(.footnote).bold()
                                ForEach(line.done, id: \.self) { Text($0).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                            }
                        }
                    }
                    Button("Dismiss", role: .destructive) { store.recap = nil }.font(.footnote)
                }
            }

            if let s = store.suggestion {
                Section(s.chat.map { String(localized: "Suggestion · \($0)") } ?? String(localized: "Suggestion")) {
                    Text(s.text).font(.footnote)
                        .swipeActions { Button("Dismiss", role: .destructive) { store.suggestion = nil } }
                    Button(action: store.acceptSuggestion) {
                        Label("Accept suggestion", systemImage: "arrow.turn.down.left")
                    }
                    .foregroundStyle(accent)
                }
            }

            // Which Claude Code chat to talk to, once any are open.
            if !store.chatChoices.isEmpty {
                Picker("To", selection: $store.target) {
                    Text("Any chat").tag(String?.none)
                    ForEach(store.chatChoices, id: \.self) { name in
                        Text(store.chats.contains(name) ? name
                             : store.starting.contains(name) ? "\(name) (starting…)" : "\(name) (offline)")
                            .tag(Optional(name))
                    }
                }
                .pickerStyle(.navigationLink)
            }
            // A chat `handoff host` runs can be opened on the Mac, as a normal Claude Code window.
            if let chat = store.target, store.hostedChats.contains(chat) {
                Button {
                    Task {
                        opened = await store.openOnComputer(chat) ? String(localized: "Opened on your Mac") : String(localized: "Couldn't reach your Mac")
                        try? await Task.sleep(for: .seconds(4))
                        opened = nil
                    }
                } label: {
                    Label(opened ?? String(localized: "Open on computer"), systemImage: "desktopcomputer")
                }
                .disabled(opened != nil)
            }
            Section {
                ForEach(Array(store.draft.enumerated()), id: \.offset) { _, text in
                    Text(text).font(.footnote)
                }
                .onDelete { store.draft.remove(atOffsets: $0) }

                TextField(store.draft.isEmpty ? String(localized: "Jot an idea…") : String(localized: "Add a line…"), text: $line)
                    .onSubmit(commitLine)
            }

            // The usual follow-ups, two taps away; only while nothing is being written.
            if store.draft.isEmpty {
                NavigationLink { QuickReplyView() } label: { Label("Quick reply", systemImage: "bolt") }
            }

            // Below the note, so on a small screen (SE 3 40mm) you can start writing without scrolling.
            if !store.projects.isEmpty {
                Button { showNewChat = true } label: { Label("New chat", systemImage: "plus.bubble") }
            }

            if !store.notes.isEmpty {
                Section("Handed off") {
                    ForEach(store.notes) { note in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading) {
                                Text(note.text).font(.caption2).lineLimit(2).foregroundStyle(.secondary)
                                if let to = note.to { Text("→ \(to)").font(.caption2).foregroundStyle(accent) }
                            }
                            Spacer(minLength: 4)
                            Image(systemName: note.sent ? "checkmark" : "clock")
                                .font(.caption2).foregroundStyle(note.sent ? accent : .secondary)
                                .accessibilityLabel(note.sent ? String(localized: "Delivered") : String(localized: "Waiting to send"))
                        }
                    }
                }
            }

            if !store.chats.isEmpty {
                NavigationLink { ProjectsView() } label: { Label("Projects", systemImage: "folder") }
            }
            NavigationLink { RecurringView() } label: {
                Label(store.schedules.isEmpty ? String(localized: "Recurring") : String(localized: "Recurring (\(store.schedules.count))"), systemImage: "repeat")
            }

            Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
                .font(.footnote)
                .listRowBackground(Color.clear)
        }
        .navigationTitle("Ideas")
        .themedBackground()
        // Watch for chats and suggestions while the list is on screen (watchOS suspends us otherwise).
        .task {
            while !Task.isCancelled {
                await store.refresh()
                try? await Task.sleep(for: .seconds(20))
            }
        }
        // In the toolbar so it's always on screen, however long the draft gets.
        .toolbar {
            if !store.draft.isEmpty {
                ToolbarItemGroup(placement: .bottomBar) {
                    Spacer()
                    // The icon gets its own color: watchOS 26 draws it in the tint, the same color as
                    // the button, so it vanished (watchOS 27 makes it white by itself).
                    Button(action: store.send) {
                        Image(systemName: "paperplane.fill").foregroundStyle(theme.onColor)
                    }
                    .accessibilityLabel("Send to Claude")
                    .tint(accent)
                }
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showNewChat) {
            NavigationStack {
                FolderView(path: "", title: store.hostRoot ?? String(localized: "New chat")) { showNewChat = false }
            }
        }
    }

    private func commitLine() {
        let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { store.draft.append(t) }
        line = ""
    }
}

/// A screenshot from Claude, filling the screen. Tap to zoom in, then drag around it.
struct ScreenshotView: View {
    let picture: Picture
    @State private var zoomed = false

    var body: some View {
        GeometryReader { geo in
            ScrollView(zoomed ? [.horizontal, .vertical] : .vertical) {
                PictureView(picture: picture)
                    .frame(width: geo.size.width * (zoomed ? 2.5 : 1))
                    .onTapGesture { withAnimation { zoomed.toggle() } }
            }
        }
        .navigationTitle("Screenshot")
    }
}

/// Every screenshot kept on the watch (or one chat's), newest first.
struct GalleryView: View {
    var chat: String? = nil
    @Environment(Store.self) private var store

    var body: some View {
        let shots = store.shots.filter { chat == nil || $0.chat == chat }
        List {
            ForEach(shots) { shot in
                NavigationLink { ShotView(shot: shot) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        if let image = store.image(shot) {
                            PictureView(picture: image).clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                        HStack {
                            if shot.saved { Image(systemName: "bookmark.fill").accessibilityLabel("Saved") }
                            Text([shot.chat, shot.at.formatted(date: .omitted, time: .shortened)].compactMap { $0 }.joined(separator: " · "))
                        }
                        .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .swipeActions { Button("Delete", role: .destructive) { store.deleteShot(shot) } }
            }
            if shots.isEmpty { Text("No screenshots").font(.footnote).foregroundStyle(.secondary) }
            else {
                Text("The newest \(Store.keepShots) are kept, and any you save.").font(.caption2).foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle(chat ?? String(localized: "Screenshots"))
        .themedBackground()
    }
}

/// One screenshot: tap it to see it full screen. Save keeps it; Ship it asks its chat to commit,
/// push and deploy.
struct ShotView: View {
    let shot: Shot
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var shipped = false
    @AppStorage("theme") private var theme = Theme.clay

    var body: some View {
        let current = store.shots.first { $0.id == shot.id } ?? shot
        List {
            if let image = store.image(current) {
                NavigationLink { ScreenshotView(picture: image) } label: {
                    PictureView(picture: image).clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
            Button { store.toggleSave(current) } label: {
                Label(current.saved ? String(localized: "Saved") : String(localized: "Save"),
                      systemImage: current.saved ? "bookmark.fill" : "bookmark")
            }
            .foregroundStyle(theme.color)
            if let chat = current.chat {
                Button { store.shipIt(chat); shipped = true } label: {
                    Label(shipped ? String(localized: "Sent to \(chat)") : String(localized: "Ship it"), systemImage: "shippingbox")
                }
                .disabled(shipped)
            }
            Button("Delete", role: .destructive) { store.deleteShot(current); dismiss() }
            if !current.saved {
                Text("Save it to keep it after newer screenshots come in.").font(.caption2).foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle(current.chat ?? String(localized: "Screenshot"))
        .themedBackground()
    }
}

/// A permission prompt: what Claude wants to do, and Allow / Deny. Tap the text to read all of it.
/// Or a question Claude asked: tap an answer.

/// A screenshot, or a GIF clip Claude made from a video. A GIF's frames are decoded as they're
/// shown, not all at once: a few seconds of full-size clip would otherwise fill the watch's memory.
/// (UIImage(data:) keeps only a GIF's first frame.)
final class Picture {
    let still: UIImage // the first frame
    private let source: CGImageSource
    private let ends: [Double] // when each frame ends, from the start
    private var shown: (index: Int, image: UIImage)

    init?(_ data: Data) {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let first = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        self.source = source
        still = UIImage(cgImage: first)
        shown = (0, still)
        var t = 0.0
        ends = (0..<CGImageSourceGetCount(source)).map { i in
            let gif = (CGImageSourceCopyPropertiesAtIndex(source, i, nil) as? [CFString: Any])?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let delay = (gif?[kCGImagePropertyGIFUnclampedDelayTime] ?? gif?[kCGImagePropertyGIFDelayTime]) as? Double ?? 0.1
            t += delay < 0.02 ? 0.1 : delay // what browsers do with a 0 delay
            return t
        }
    }

    var animated: Bool { ends.count > 1 }
    var frameCount: Int { ends.count }
    /// The shortest frame, for how often to redraw.
    var step: Double { zip(ends, [0] + ends).map { $0 - $1 }.min() ?? 0.1 }

    /// The frame showing `t` seconds into the loop.
    func frame(at t: TimeInterval) -> UIImage {
        guard animated, let total = ends.last else { return still }
        let at = t.truncatingRemainder(dividingBy: total)
        let i = ends.firstIndex { at < $0 } ?? 0
        if i != shown.index, let cg = CGImageSourceCreateImageAtIndex(source, i, nil) { shown = (i, UIImage(cgImage: cg)) }
        return shown.image
    }
}

/// Shows a picture, playing it if it's a GIF clip.
struct PictureView: View {
    let picture: Picture

    var body: some View {
        if picture.animated {
            TimelineView(.animation(minimumInterval: picture.step)) { t in
                Image(uiImage: picture.frame(at: t.date.timeIntervalSinceReferenceDate)).resizable().scaledToFit()
            }
        } else {
            Image(uiImage: picture.still).resizable().scaledToFit()
        }
    }
}

struct ApprovalSection: View {
    let approval: Approval
    @Environment(Store.self) private var store
    @State private var busy = false
    @State private var failed = false
    @AppStorage("theme") private var theme = Theme.clay
    private var accent: Color { theme.color }

    var body: some View {
        Section(approval.chat.map { String(localized: "Claude asks · \($0)") } ?? String(localized: "Claude asks")) {
            if let options = approval.options {
                Text(approval.what).font(.footnote)
                ForEach(options, id: \.self) { option in
                    Button(option) { choose(option) }.foregroundStyle(accent).disabled(busy)
                }
                if failed { Text("Couldn't reach your Mac. Try again.").font(.footnote).foregroundStyle(.red) }
            } else {
                permission
            }
        }
    }

    @ViewBuilder private var permission: some View {
            NavigationLink {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(approval.tool).font(.headline)
                        if !approval.what.isEmpty { Text(approval.what).font(.footnote) }
                        Text(approval.input).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                    }
                }
                .navigationTitle("Details")
                .themedBackground()
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(approval.what.isEmpty ? String(localized: "Use \(approval.tool)") : approval.what).font(.footnote).lineLimit(3)
                    Text(approval.input).font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Button { answer(true) } label: { Label("Allow", systemImage: "checkmark") }
                .foregroundStyle(accent).disabled(busy)
            Button(role: .destructive) { answer(false) } label: { Label("Deny", systemImage: "xmark") }
                .disabled(busy)
            if failed { Text("Couldn't reach your Mac. Try again.").font(.footnote).foregroundStyle(.red) }
    }

    private func choose(_ option: String) {
        busy = true
        failed = false
        Task {
            failed = !(await store.choose(approval, option))
            busy = false
        }
    }

    private func answer(_ allow: Bool) {
        busy = true
        failed = false
        Task {
            failed = !(await store.answer(approval, allow: allow))
            busy = false
        }
    }
}

/// Ready-made notes ("Commit it", "Run the tests"…): one tap sends it and goes back. Add your own
/// below; swipe one to delete it.
struct QuickReplyView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var new = ""

    var body: some View {
        @Bindable var store = store
        List {
            ForEach(store.quickReplies, id: \.self) { text in
                Button(text) { store.sendQuick(text); dismiss() }
            }
            .onDelete { store.quickReplies.remove(atOffsets: $0) }
            .onMove { store.quickReplies.move(fromOffsets: $0, toOffset: $1) }
            TextField("Add a button…", text: $new)
                .onSubmit {
                    let t = new.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty, !store.quickReplies.contains(t) { store.quickReplies.append(t) }
                    new = ""
                }
            if store.quickReplies != Store.defaultQuickReplies {
                Button("Reset buttons") { store.quickReplies = Store.defaultQuickReplies }.font(.footnote)
            }
        }
        .navigationTitle(store.target ?? String(localized: "Quick reply"))
        .themedBackground()
    }
}

/// Each open chat: what it's working on, and its folder's git status.
struct ProjectsView: View {
    @Environment(Store.self) private var store
    @State private var stopping: String?
    @State private var sent: Set<String> = [] // stopped or shipped from here, until the chat's status changes
    @AppStorage("theme") private var theme = Theme.clay
    private var accent: Color { theme.color }

    var body: some View {
        List {
            ForEach(store.chats, id: \.self) { name in
                let s = store.status[name] ?? ChatStatus()
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.headline)
                    if let w = s.working {
                        Label(w, systemImage: "hammer").font(.caption2).foregroundStyle(accent).lineLimit(2)
                    } else {
                        Text("Idle").font(.caption2).foregroundStyle(.secondary)
                    }
                    if let branch = s.branch {
                        Text([branch, s.changes > 0 ? "\(s.changes) changed" : "clean",
                              s.ahead > 0 ? "\(s.ahead) to push" : nil].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if s.working != nil {
                    Button(role: .destructive) { stopping = name } label: { Label("Stop", systemImage: "stop.fill") }
                        .disabled(sent.contains(name))
                } else if s.changes > 0 || s.ahead > 0 {
                    Button { store.shipIt(name); sent.insert(name) } label: {
                        Label(sent.contains(name) ? String(localized: "Sent") : String(localized: "Ship it"), systemImage: "shippingbox")
                    }
                    .foregroundStyle(accent).disabled(sent.contains(name))
                }
            }
            if store.chats.isEmpty { Text("No chats are open.").font(.footnote).foregroundStyle(.secondary) }
        }
        .navigationTitle("Projects")
        .themedBackground()
        .confirmationDialog("Stop \(stopping ?? "")?", isPresented: Binding { stopping != nil } set: { if !$0 { stopping = nil } }) {
            Button("Stop", role: .destructive) {
                guard let name = stopping else { return }
                Task { if await store.stop(name) { sent.insert(name) } }
            }
        } message: {
            Text("Claude stops the note it's working on and keeps what it did so far.")
        }
        .onChange(of: store.status) { sent.removeAll() } // stopped, or shipped: the buttons come back
        .task {
            while !Task.isCancelled {
                await store.checkChats()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }
}

/// Notes Claude gets on a schedule: run the tests every morning, check something every hour.
struct RecurringView: View {
    @Environment(Store.self) private var store

    var body: some View {
        List {
            NavigationLink { NewRecurringView() } label: { Label("New", systemImage: "plus") }
            ForEach(store.schedules) { r in
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.text).font(.footnote).lineLimit(3)
                    Text(r.when).font(.caption2).foregroundStyle(.secondary)
                    if let to = r.to { Text("→ \(to)").font(.caption2).foregroundStyle(.secondary) }
                }
            }
            .onDelete { store.schedules.remove(atOffsets: $0) }
            if !store.schedules.isEmpty {
                Text("Your Mac runs these while a handoff start or handoff host is open. Swipe to delete.")
                    .font(.caption2).foregroundStyle(.secondary).listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Recurring")
        .themedBackground()
    }
}

struct NewRecurringView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var every = Recurring.Every.day
    @State private var time = Calendar.current.date(from: DateComponents(hour: 9, minute: 0)) ?? .now
    @State private var to: String?

    var body: some View {
        List {
            TextField("What should Claude do?", text: $text)
            Picker("Repeat", selection: $every) {
                Text("Every hour").tag(Recurring.Every.hour)
                Text("Every day").tag(Recurring.Every.day)
                Text("Weekdays").tag(Recurring.Every.weekday)
            }
            DatePicker(every == .hour ? String(localized: "Minute past") : String(localized: "Time"), selection: $time, displayedComponents: .hourAndMinute)
            if !store.chatChoices.isEmpty {
                Picker("To", selection: $to) {
                    Text("Any chat").tag(String?.none)
                    ForEach(store.chatChoices, id: \.self) { Text($0).tag(Optional($0)) }
                }
            }
            Button {
                let c = Calendar.current.dateComponents([.hour, .minute], from: time)
                store.schedules.append(Recurring(text: text.trimmingCharacters(in: .whitespacesAndNewlines), every: every,
                                                 hour: c.hour ?? 9, minute: c.minute ?? 0, to: to))
                Haptic.play(.success)
                dismiss()
            } label: { Label("Save", systemImage: "checkmark") }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .navigationTitle("New")
        .themedBackground()
        .onAppear { if to == nil { to = store.target } }
    }
}

struct SettingsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUnpair = false
    @State private var confirmClear = false
    @AppStorage("theme") private var theme = Theme.clay
    @AppStorage("themedBackground") private var themedBackground = true

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            List {
                Picker("Color", selection: $theme) {
                    ForEach(Theme.allCases) { t in
                        Label { Text(t.name) } icon: { Image(systemName: "circle.fill").foregroundStyle(t.color) }
                            .tag(t)
                    }
                }
                .pickerStyle(.navigationLink)
                Toggle("Background", isOn: $themedBackground)
                Section {
                    Toggle("Suggestions", isOn: $store.suggestionsOn)
                } footer: {
                    Text("Show Claude's suggested next step when it finishes a note.")
                }
                Button("Delete All History", role: .destructive) { confirmClear = true }
                    .disabled(!store.notes.contains(where: \.sent))
                Button("Unpair", role: .destructive) { confirmUnpair = true }
            }
            .navigationTitle("Settings")
            .themedBackground()
            .confirmationDialog("Delete all history?", isPresented: $confirmClear) {
                Button("Delete", role: .destructive) { store.clearHistory() }
            } message: {
                Text("Clears the Handed off list on this watch. Notes still waiting to send are kept.")
            }
            .confirmationDialog("Unpair from your Mac?", isPresented: $confirmUnpair) {
                Button("Unpair", role: .destructive) {
                    dismiss()
                    store.setPairing(nil)
                }
            } message: {
                Text("You'll need to run pair on your Mac again.")
            }
        }
    }
}

/// Browses the folders `handoff host` shares, to pick where a new Claude Code chat starts:
/// here, in a new folder made here, or deeper in.
struct FolderView: View {
    let path: String // relative to the host's folder; "" is the top
    let title: String
    let close: () -> Void
    @Environment(Store.self) private var store
    @State private var dirs: [String]?
    @State private var unreachable = false
    @State private var newFolder = ""
    @State private var namingNewFolder: String?

    var body: some View {
        List {
            NavigationLink {
                NameChatView(path: path, newFolder: nil, close: close)
            } label: { Label("Start chat here", systemImage: "plus.bubble") }
            TextField("New folder…", text: $newFolder)
                .onSubmit {
                    let folder = newFolder.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !folder.isEmpty, !folder.contains("/"), !folder.hasPrefix(".") { namingNewFolder = folder }
                }

            Section("Folders") {
                if let dirs {
                    if dirs.isEmpty { Text("No folders").font(.footnote).foregroundStyle(.secondary) }
                    ForEach(dirs, id: \.self) { dir in
                        NavigationLink {
                            FolderView(path: path.isEmpty ? dir : "\(path)/\(dir)", title: dir, close: close)
                        } label: { Label(dir, systemImage: "folder") }
                    }
                } else if unreachable {
                    Text("Your Mac didn't answer. Is handoff host running?").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle(title)
        .themedBackground()
        .navigationDestination(item: $namingNewFolder) { folder in
            NameChatView(path: path, newFolder: folder, close: close)
        }
        .task {
            if path.isEmpty { dirs = store.projects } // already known: show it at once, then refresh
            if let fresh = await store.listFolders(path) { dirs = fresh } else if dirs == nil { unreachable = true }
        }
    }
}

/// Last step of New chat: name it (prefilled with the folder's name), then start it.
struct NameChatView: View {
    let path: String
    let newFolder: String?
    let close: () -> Void
    @Environment(Store.self) private var store
    @State private var name = ""
    @State private var busy = false
    @State private var failed = false

    var body: some View {
        List {
            TextField("Chat name", text: $name)
                .disabled(busy)
            Button(action: start) {
                if busy { HStack { ProgressView().frame(width: 24); Text("Starting…") } }
                else { Label("Start chat", systemImage: "plus.bubble") }
            }
            .disabled(busy)
            if failed { Text("Couldn't reach your Mac. Try again.").font(.footnote).foregroundStyle(.red) }
            if let newFolder {
                Text("Makes the folder \(newFolder) first.").font(.footnote).foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Name chat")
        .themedBackground()
        .onAppear { if name.isEmpty { name = store.defaultChatName(in: path, newFolder: newFolder) } }
    }

    private func start() {
        busy = true
        failed = false
        Task {
            if await store.startChat(in: path, newFolder: newFolder, name: name) { close() } else { failed = true }
            busy = false
        }
    }
}
