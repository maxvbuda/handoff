import SwiftUI
import WidgetKit

// The watch-face complication: one tap opens Hand-Off, ready to jot an idea.
// It shows nothing from Claude, so it never needs updating.

@main
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
            HStack {
                Image(systemName: "square.and.pencil").font(.title2)
                VStack(alignment: .leading) {
                    Text("Hand-Off").font(.headline)
                    Text("Jot an idea").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
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
