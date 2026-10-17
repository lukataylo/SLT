import SwiftUI
import simd

/// Live. Still phones show a calm "streaming" screen. Move phones get the
/// radar: everyone around you, their views docked at the screen edge on
/// their side, and the one you face locked on in the middle.
struct LiveView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @ObservedObject var capture: ARCapture

    var body: some View {
        Group {
            if !model.isLocated {
                lost
            } else if model.isStill {
                still
            } else {
                radar
            }
        }
    }

    // MARK: geometry

    struct Other: Identifiable {
        var id: String
        var name: String
        /// Bearing from where you face, radians, positive = to your left.
        var bearing: Float
        var distance: Float
        var feed: RemoteFeed?
        var still: Bool
    }

    /// Everyone else who's placed, relative to this phone.
    private var others: [Other] {
        guard let local = capture.localMark else { return [] }
        let me = relay.alignment.transform.apply(local)
        return relay.members.compactMap { m -> Other? in
            guard m.id != relay.selfId, m.located, let mark = relay.peerMarks[m.id] else { return nil }
            let dx = mark.x - me.x, dz = mark.z - me.z
            let toward = atan2(-dx, -dz) // same yaw convention as Mark
            let bearing = atan2(sin(toward - me.yaw), cos(toward - me.yaw))
            let feed = relay.feeds[m.id].flatMap { Date().timeIntervalSince($0.receivedAt) < 5 ? $0 : nil }
            return Other(id: m.id, name: m.name, bearing: bearing, distance: hypot(dx, dz), feed: feed, still: m.role == "still")
        }
    }

    /// Within this angle of where you face, a phone's view locks on.
    private static let lockAngle: Float = 15 * .pi / 180

    // MARK: Move: radar

    private var radar: some View {
        let all = others
        let locked = all.filter { $0.feed != nil && abs($0.bearing) < Self.lockAngle }.min { abs($0.bearing) < abs($1.bearing) }
        let docked = all.filter { $0.feed != nil && $0.id != locked?.id }
        return ZStack {
            Color.black.opacity(locked == nil ? 0.15 : 0.45).ignoresSafeArea().allowsHitTesting(false)
            VStack(spacing: 12) {
                topBar(count: all.filter { $0.feed != nil }.count)
                if let locked, let feed = locked.feed {
                    lockedCard(locked, feed)
                        .transition(.scale(scale: 0.85).combined(with: .opacity))
                }
                Spacer()
                if all.isEmpty {
                    Panel {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("NOBODY TO SEE YET").font(Theme.display(22))
                            Text("When others in the group go live, they appear on the radar.").font(.system(size: 14)).foregroundStyle(Theme.muted)
                        }
                    }
                } else if locked == nil, let nearest = all.filter({ $0.feed != nil }).min(by: { abs($0.bearing) < abs($1.bearing) }) {
                    Text("Turn \(nearest.bearing > 0 ? "left" : "right") to see \(nearest.name)").label(10, bold: true)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(Capsule().fill(Theme.panel))
                }
                radarDisc(all)
            }
            .padding(16)
            .animation(.snappy(duration: 0.25), value: locked?.id)

            // Docked views on the edge, on each phone's side.
            HStack {
                VStack(spacing: 10) { ForEach(docked.filter { $0.bearing > 0 }) { dockCard($0, left: true) } }
                Spacer()
                VStack(spacing: 10) { ForEach(docked.filter { $0.bearing <= 0 }) { dockCard($0, left: false) } }
            }
            .padding(.top, 140)
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }

    private func topBar(count: Int) -> some View {
        HStack {
            IconButton(glyph: .back, label: "Back to the group") { model.mode = .group }
            Spacer()
            VStack(spacing: 2) {
                Text(String(format: "%02d", count)).font(Theme.display(30))
                Text("Live").label(8).foregroundStyle(Theme.muted)
            }
            Spacer()
            Color.clear.frame(width: 46, height: 46)
        }
    }

    private func lockedCard(_ o: Other, _ feed: RemoteFeed) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle().fill(Theme.red).frame(width: 7, height: 7)
                Text("\(o.name) · \(String(format: "%.0f", o.distance)) m").label(10, bold: true)
                Spacer()
                Text("Locked on").label(8).foregroundStyle(Theme.muted)
            }
            Image(uiImage: feed.image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity, maxHeight: 340)
                .overlay(Rectangle().stroke(Theme.red, lineWidth: 2))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 20).fill(Theme.panel))
    }

    private func dockCard(_ o: Other, left: Bool) -> some View {
        VStack(alignment: left ? .leading : .trailing, spacing: 4) {
            if let feed = o.feed {
                Image(uiImage: feed.image).resizable().aspectRatio(contentMode: .fill)
                    .frame(width: 92, height: 92).clipped()
                    .overlay(Rectangle().stroke(Color.white.opacity(0.8), lineWidth: 1.5))
            }
            Text(left ? "◀ \(o.name)" : "\(o.name) ▶").label(8, bold: true)
            Text(String(format: "%.0f m", o.distance)).label(8).foregroundStyle(Theme.muted)
        }
        .padding(8)
        .background(Theme.panel)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(o.name), \(String(format: "%.0f", o.distance)) metres to your \(left ? "left" : "right")")
    }

    /// Top-down, you in the middle facing up, everyone else around you.
    private func radarDisc(_ all: [Other]) -> some View {
        let size: CGFloat = 170
        let range: Float = 8 // metres to the rim
        return ZStack {
            Circle().fill(Theme.panel)
            Circle().stroke(Theme.line)
            Circle().inset(by: size / 4).stroke(style: StrokeStyle(lineWidth: 1, dash: [3, 4])).foregroundStyle(Theme.line)
            // Your view cone.
            Path { p in
                p.move(to: CGPoint(x: size / 2, y: size / 2))
                p.addLine(to: CGPoint(x: size / 2 - 30, y: 8))
                p.addLine(to: CGPoint(x: size / 2 + 30, y: 8))
                p.closeSubpath()
            }
            .fill(Theme.red.opacity(0.18))
            Circle().fill(Theme.red).frame(width: 12, height: 12)
            ForEach(all) { o in
                let r = CGFloat(min(o.distance, range) / range) * (size / 2 - 10)
                let x = -sin(CGFloat(o.bearing)) * r, y = -cos(CGFloat(o.bearing)) * r
                VStack(spacing: 2) {
                    Circle().fill(Color.white).frame(width: 10, height: 10)
                    Text(o.name).label(7, bold: true)
                }
                .offset(x: x, y: y + 6)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Radar: \(all.map(\.name).joined(separator: ", "))")
    }

    // MARK: Still

    private var still: some View {
        ZStack {
            Color.black.opacity(0.88).ignoresSafeArea()
            VStack(spacing: 14) {
                HStack {
                    IconButton(glyph: .back, label: "Back to the group") { model.mode = .group }
                    Spacer()
                }
                Spacer()
                Circle().fill(Theme.red).frame(width: 14, height: 14)
                Text("LIVE").font(Theme.display(64))
                Text("Streaming to the group. Keep this phone where it is, pointing into the room.")
                    .font(.system(size: 15)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                Spacer()
                if let me = relay.selfId {
                    PillButton(title: "Switch to Move", filled: false) { model.setRole("move", for: me) }
                }
            }
            .padding(20)
        }
    }

    // MARK: Lost

    private var lost: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
            VStack {
                Spacer()
                Panel {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("LOST YOUR PLACE").font(Theme.display(26))
                        Text("This phone doesn't know where it is in the group, so other views are hidden. Scan someone's code to get placed again.")
                            .font(.system(size: 15)).foregroundStyle(Theme.muted)
                        PillButton(title: "Scan someone's code") { model.scanCode(returnTo: .live, cancelTo: .group) }
                        PillButton(title: "Back to the group", filled: false) { model.mode = .group }
                    }
                }
            }
            .padding(16)
        }
    }
}
