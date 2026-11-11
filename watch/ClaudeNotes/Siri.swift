import AppIntents

// "Hey Siri, tell Hand-Off": Siri asks what Claude should do and sends it, without opening the app.
// It's also in the Shortcuts app, so the Action button on an Apple Watch Ultra can run it.

struct TellClaude: AppIntent {
    static let title: LocalizedStringResource = "Tell Claude"
    static let description = IntentDescription("Hands a note to Claude Code.")

    @Parameter(title: "Note", requestValueDialog: "What should Claude do?")
    var text: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let store = Store.shared
        guard store.pairing != nil else { return .result(dialog: "Open Hand-Off and pair it with your Mac first.") }
        let sent = await store.sendFromSiri(text)
        return .result(dialog: sent ? "Sent to Claude." : "Saved. It'll send when your watch is online.")
    }
}

struct HandOffShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: TellClaude(), phrases: [
            "Tell \(.applicationName)",
            "Send a note with \(.applicationName)",
            "New note in \(.applicationName)",
        ], shortTitle: "Tell Claude", systemImageName: "square.and.pencil")
    }
}
