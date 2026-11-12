import Foundation

/// What the Smart Stack widget shows: Claude's suggestion and what each chat is working on, as the
/// app last saw them. The app saves it in the shared App Group whenever it changes; the widget
/// can't reach the relay itself.
struct WidgetState: Codable, Equatable {
    struct Work: Codable, Equatable {
        var chat: String
        var note: String
    }
    var suggestion: String?
    var suggestionChat: String?
    var working: [Work] = []
    var chats = 0 // open chats
    var updated = Date.now

    static let group = "group.dev.maxbuda.handoff"
    /// Older than this, the widget stops showing it: the chats have likely moved on.
    static let fresh: TimeInterval = 60 * 60

    static func load() -> WidgetState? {
        UserDefaults(suiteName: group)?.data(forKey: "widget").flatMap { try? JSONDecoder().decode(WidgetState.self, from: $0) }
    }

    func save() {
        UserDefaults(suiteName: Self.group)?.set(try? JSONEncoder().encode(self), forKey: "widget")
    }
}
