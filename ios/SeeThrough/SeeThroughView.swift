import SwiftUI

/// The everyday mode: the camera with other phones' live views placed in it,
/// over the walls between you. One control: how far to see through.
struct SeeThroughView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @ObservedObject var settings: Settings

    private var live: [RemoteFeed] {
        relay.feeds.values.filter { Date().timeIntervalSince($0.receivedAt) < 5 }.sorted { $0.name < $1.name }
    }

    var body: some View {
        VStack(spacing: 12) {
            HStack(alignment: .top) {
                IconButton(glyph: .back, label: "Back") { model.mode = .home }
                Spacer()
                VStack(spacing: 2) {
                    Text(String(format: "%02d", live.count)).font(Theme.display(34))
                    Text("Live").label(8).foregroundStyle(Theme.muted)
                }
                Spacer()
                VStack(spacing: 4) {
                    IconButton(glyph: .ghost, label: "Wall outlines", active: settings.wallGhosts) { settings.wallGhosts.toggle() }
                    Text("Walls").label(7).foregroundStyle(Theme.muted)
                }
            }
            if !live.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(live, id: \.name) { feed in
                            HStack(spacing: 6) {
                                Circle().fill(Theme.red).frame(width: 6, height: 6)
                                Text(feed.name).label(9, bold: true)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(Capsule().fill(Theme.panel))
                        }
                    }
                }
            }
            Spacer()
            if !model.isLocated {
                Panel {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("LOCATE FIRST").font(Theme.display(26))
                        Text("To place other phones' views, this phone needs to know where it is on the map.").font(.system(size: 15)).foregroundStyle(Theme.muted)
                        PillButton(title: "Scan a pairing code") { model.scanCode(returnTo: .seeThrough) }
                    }
                }
            } else if live.isEmpty {
                Panel {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("NOBODY SHARING").font(Theme.display(26))
                        Text("When someone opens See Through on their phone, their view appears where they are, through the walls.").font(.system(size: 15)).foregroundStyle(Theme.muted)
                    }
                }
            }
            xraySlider
        }
        .padding(16)
    }

    private var xraySlider: some View {
        HStack(spacing: 14) {
            DotIcon(glyph: .eye, size: 18)
            Slider(value: $settings.xray, in: 0...1).tint(.white)
            Text(String(format: "%02d", Int(settings.xray * 99))).font(Theme.display(20)).frame(width: 34)
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .background(Capsule().fill(Theme.panel))
        .overlay(Capsule().stroke(Theme.line))
        .accessibilityLabel("See-through amount")
    }
}
