import SwiftUI

/// Fresh open: what the map looks like, and the two things you can do.
struct HomeView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient

    var body: some View {
        ZStack {
            Color.black.opacity(0.62).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Circle().fill(relay.connected ? Theme.red : Theme.muted).frame(width: 8, height: 8)
                    Text(relay.connected ? "Live" : "Connecting").label(10, bold: true)
                    Spacer()
                    IconButton(glyph: .qr, label: "Pairing code") { model.sheet = .showCode }
                    IconButton(glyph: .gear, label: "Settings") { model.sheet = .settings }
                }
                Spacer()
                hero
                tile(glyph: .cube, title: "Scan", detail: relay.rooms.isEmpty ? "Map your first room. One-off setup." : "Add or improve a room.",
                     badge: relay.rooms.isEmpty ? nil : "\(relay.rooms.count) ROOMS") {
                    model.sheet = .rooms
                }
                tile(glyph: .eye, title: "See through", detail: seeThroughDetail,
                     badge: relay.feeds.isEmpty ? nil : "\(relay.feeds.count) LIVE", dimmed: !model.mapExists) {
                    model.mode = .seeThrough
                }
                .disabled(!model.mapExists)
            }
            .padding(20)
        }
    }

    private var seeThroughDetail: String {
        if !model.mapExists { return "Scan a room first." }
        return relay.peers == 0 ? "Look through walls when others join." : "Look through walls at \(relay.peers) other phone\(relay.peers == 1 ? "" : "s")."
    }

    /// The state of the map, at a glance: how much is mapped, and whether
    /// this phone knows where it is on it.
    private var hero: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                Text(model.mapExists ? String(format: "%02d", relay.rooms.count) : "00").font(Theme.display(96))
                Text(model.mapExists ? (relay.rooms.count == 1 ? "room\nmapped" : "rooms\nmapped") : "no map\nyet").label(12, bold: true)
            }
            HStack(spacing: 8) {
                Circle().fill(model.isLocated ? Theme.red : Color.white.opacity(0.3)).frame(width: 8, height: 8)
                Text(model.isLocated ? "This phone is located on the map"
                     : (model.mapExists ? "This phone isn't located yet" : "Your first scan starts the map"))
                    .label(10, bold: true)
            }
        }
    }

    private func tile(glyph: DotGlyph, title: String, detail: String, badge: String?, dimmed: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 18) {
                DotIcon(glyph: glyph, size: 44)
                VStack(alignment: .leading, spacing: 6) {
                    Text(title.uppercased()).font(Theme.display(28))
                    Text(detail).font(.system(size: 14)).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                if let badge { Text(badge).label(9, bold: true).foregroundStyle(Theme.red) }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 28).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 28).stroke(Theme.line))
            .opacity(dimmed ? 0.45 : 1)
        }
        .foregroundStyle(.white)
    }
}
