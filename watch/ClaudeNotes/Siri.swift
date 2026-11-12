import AppIntents

// "Hey Siri, tell Hand-Off": Siri asks what Claude should do and sends it, without opening the app.
// "Tell Hand-Off in website" sends it to that chat. "Ask Hand-Off what's going on" reads out what
// each chat is doing. They're also in the Shortcuts app, so the Action button on an Apple Watch
// Ultra can run them.

/// An open Claude Code chat, by name, so Siri can send a note to it.
struct ChatEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Chat"
    static let defaultQuery = ChatQuery()
    let id: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(id)") }
}

struct ChatQuery: EntityStringQuery {
    @MainActor
    private func choices() async -> [ChatEntity] {
        let store = Store.shared
        if store.chats.isEmpty { await store.checkChats() } // Siri can start us cold
        return store.chatChoices.map(ChatEntity.init)
    }

    func entities(for identifiers: [String]) async throws -> [ChatEntity] {
        await choices().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [ChatEntity] { await choices() }

    /// Spoken names lose dashes and capitals ("weather app" for weather-app), so compare without them.
    func entities(matching string: String) async throws -> [ChatEntity] {
        let said = Self.plain(string)
        return await choices().filter { Self.plain($0.id).contains(said) || said.contains(Self.plain($0.id)) }
    }

    static func plain(_ s: String) -> String { s.lowercased().filter { $0.isLetter || $0.isNumber } }
}

struct TellClaude: AppIntent {
    static let title: LocalizedStringResource = "Tell Claude"
    static let description = IntentDescription("Hands a note to Claude Code.")

    @Parameter(title: "Note", requestValueDialog: "What should Claude do?")
    var text: String

    @Parameter(title: "Chat")
    var chat: ChatEntity?

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let store = Store.shared
        guard store.pairing != nil else { return .result(dialog: "Open Hand-Off and pair it with your Mac first.") }
        let sent = await store.sendFromSiri(text, to: chat?.id)
        return .result(dialog: sent ? "Sent to Claude." : "Saved. It'll send when your watch is online.")
    }
}

struct CheckOnClaude: AppIntent {
    static let title: LocalizedStringResource = "Check on Claude"
    static let description = IntentDescription("Says what each chat is working on.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let store = Store.shared
        await store.refresh()
        return .result(dialog: IntentDialog(stringLiteral: store.spokenStatus()))
    }
}

struct HandOffShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: TellClaude(), phrases: [
            "Tell \(.applicationName)",
            "Send a note with \(.applicationName)",
            "New note in \(.applicationName)",
            "Tell \(.applicationName) in \(\.$chat)",
            "Tell \(.applicationName) for \(\.$chat)",
        ], shortTitle: "Tell Claude", systemImageName: "square.and.pencil")
        AppShortcut(intent: CheckOnClaude(), phrases: [
            "Ask \(.applicationName) what's going on",
            "Check \(.applicationName)",
            "What is \(.applicationName) doing",
        ], shortTitle: "Check on Claude", systemImageName: "list.bullet")
    }
}
