import SwiftUI
import WidgetKit

// Two widgets. The watch-face complication: one tap opens Hand-Off, ready to jot an idea; it shows
// nothing from Claude, so it never needs updating. And the Smart Stack widget: Claude's suggestion
// and what each chat is working on, as the app last saw them (WidgetState, in the App Group).

@main
struct HandOffWidgets: WidgetBundle {
    var body: some Widget {
        HandOffWidget()
        StatusWidget()
    }
}

struct HandOffWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "HandOff", provider: Provider()) { _ in
            ComplicationView()
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Hand-Off")
        .description("Jot an idea for Claude.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryRectangular, .accessoryInline])
    }
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> SimpleEntry { SimpleEntry() }
    func getSnapshot(in context: Context, completion: @escaping (SimpleEntry) -> Void) { completion(SimpleEntry()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SimpleEntry>) -> Void) {
        completion(Timeline(entries: [SimpleEntry()], policy: .never))
    }
}

struct SimpleEntry: TimelineEntry {
    let date = Date.now
}

struct ComplicationView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCorner:
            Image(systemName: "square.and.pencil")
                .font(.title2)
                .widgetLabel("Hand-Off")
        case .accessoryRectangular:
            JotView()
        case .accessoryInline:
            Label("Jot an idea", systemImage: "square.and.pencil")
        default:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "square.and.pencil").font(.title2)
            }
        }
    }
}

struct JotView: View {
    var body: some View {
        HStack {
            Image(systemName: "square.and.pencil").font(.title2)
            VStack(alignment: .leading) {
                Text("Hand-Off").font(.headline)
                Text("Jot an idea").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Smart Stack

struct StatusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "Status", provider: StatusProvider()) { entry in
            StatusView(state: entry.state)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Claude's status")
        .description("Claude's suggestion and what your chats are working on.")
        .supportedFamilies([.accessoryRectangular])
    }
}

struct StatusEntry: TimelineEntry {
    var date = Date.now
    var state: WidgetState? // nil: nothing recent to show
    var relevance: TimelineEntryRelevance? {
        guard let state else { return TimelineEntryRelevance(score: 0) }
        // A suggestion waiting for a tap matters most; a chat at work, a bit.
        return TimelineEntryRelevance(score: state.suggestion != nil ? 60 : state.working.isEmpty ? 5 : 30)
    }
}

struct StatusProvider: TimelineProvider {
    func placeholder(in context: Context) -> StatusEntry {
        StatusEntry(state: WidgetState(working: [.init(chat: "website", note: "Add a dark mode button")], chats: 1))
    }
    func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) {
        completion(context.isPreview ? placeholder(in: context) : StatusEntry(state: WidgetState.load()))
    }
    /// What the app saved, until it's an hour old; then the plain "Jot an idea". The app asks for
    /// a new timeline whenever it saves.
    func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
        guard let state = WidgetState.load(), state.updated.addingTimeInterval(WidgetState.fresh) > .now else {
            return completion(Timeline(entries: [StatusEntry()], policy: .never))
        }
        completion(Timeline(entries: [StatusEntry(state: state), StatusEntry(date: state.updated.addingTimeInterval(WidgetState.fresh))],
                            policy: .never))
    }
}

struct StatusView: View {
    let state: WidgetState?

    var body: some View {
        if let state, let s = state.suggestion {
            VStack(alignment: .leading, spacing: 1) {
                Label(state.suggestionChat.map { String(localized: "Suggestion · \($0)") } ?? String(localized: "Suggestion"),
                      systemImage: "arrow.turn.down.left")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                Text(s).font(.footnote).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if let state, let first = state.working.first {
            VStack(alignment: .leading, spacing: 1) {
                Text(first.chat).font(.headline).lineLimit(1)
                Text(first.note).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                if state.working.count > 1 {
                    Text("+\(state.working.count - 1) more").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            JotView()
        }
    }
}
