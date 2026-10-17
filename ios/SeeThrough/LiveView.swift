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
            // On a dark backing: the camera behind can be bright.
            VStack(spacing: 2) {
                Text(String(format: "%02d", count)).font(Theme.display(30))
                Text("Live").label(8).foregroundStyle(.white.opacity(0.75))
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 16).fill(Theme.panel))
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

    /// Top-down, you in the middle facing up: the scanned floor plan turns
    /// around you as you turn, with everyone's position and view cone.
    private func radarDisc(_ all: [Other], size: CGFloat = 210) -> some View {
        let walls = relay.allWalls
        let uploadedPlan = relay.plan
        let openings = relay.rooms.flatMap(\.openings)
        let me = capture.localMark.map { relay.alignment.transform.apply($0) }
        let marks = relay.peerMarks
        let names = Dictionary(uniqueKeysWithValues: relay.members.map { ($0.id, $0.name) })
        let range: Float = 7 // metres from you to the rim
        return Canvas { ctx, canvas in
            let c = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
            let radius = canvas.width / 2
            let scale = CGFloat(Float(radius - 8) / range)
            ctx.fill(Path(ellipseIn: CGRect(origin: .zero, size: canvas)), with: .color(Color(white: 0.06, opacity: 0.92)))
            ctx.clip(to: Path(ellipseIn: CGRect(origin: .zero, size: canvas).insetBy(dx: 1, dy: 1)))
            guard let me else { return }
            // Map point -> screen: you at the centre, your facing up.
            let f = SIMD2<Float>(-sin(me.yaw), -cos(me.yaw)), r = SIMD2<Float>(cos(me.yaw), -sin(me.yaw))
            func pt(_ x: Float, _ z: Float) -> CGPoint {
                let d = SIMD2(x - me.x, z - me.z)
                return CGPoint(x: c.x + CGFloat(simd_dot(d, r)) * scale, y: c.y - CGFloat(simd_dot(d, f)) * scale)
            }
            func dir(_ yaw: Float) -> CGVector {
                let g = SIMD2<Float>(-sin(yaw), -cos(yaw))
                return CGVector(dx: CGFloat(simd_dot(g, r)), dy: -CGFloat(simd_dot(g, f)))
            }
            // Distance ring.
            let ring = CGFloat(Float(range) / 2) * scale
            ctx.stroke(Path(ellipseIn: CGRect(x: c.x - ring, y: c.y - ring, width: 2 * ring, height: 2 * ring)),
                       with: .color(.white.opacity(0.12)), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
            // The uploaded floor plan's rooms, once it's placed on the map.
            if let placement = uploadedPlan?.placement {
                var outline = Path()
                for room in uploadedPlan?.rooms ?? [] where room.polygon.count >= 3 {
                    let pts = room.polygon.map { v -> CGPoint in let (x, z) = placement.apply(v.x, v.y); return pt(x, z) }
                    outline.move(to: pts[0]); pts.dropFirst().forEach { outline.addLine(to: $0) }; outline.closeSubpath()
                }
                ctx.stroke(outline, with: .color(.white.opacity(0.3)), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
            }
            // Floor plan from the LiDAR map.
            var plan = Path()
            for w in walls { plan.move(to: pt(w.a.x, w.a.y)); plan.addLine(to: pt(w.b.x, w.b.y)) }
            ctx.stroke(plan, with: .color(.white.opacity(0.75)), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            for o in openings {
                var p = Path(); p.move(to: pt(o.a.x, o.a.y)); p.addLine(to: pt(o.b.x, o.b.y))
                ctx.stroke(p, with: .color(o.kind == "door" ? Theme.red : .white.opacity(0.4)), style: StrokeStyle(lineWidth: 3.5, lineCap: .round))
            }
            func cone(at p: CGPoint, yaw: Float, colour: Color, length: CGFloat) {
                let d = dir(yaw), a = atan2(d.dy, d.dx), half = 0.5
                var w = Path()
                w.move(to: p)
                w.addLine(to: CGPoint(x: p.x + cos(a - half) * length, y: p.y + sin(a - half) * length))
                w.addLine(to: CGPoint(x: p.x + cos(a + half) * length, y: p.y + sin(a + half) * length))
                w.closeSubpath()
                ctx.fill(w, with: .color(colour.opacity(0.28)))
            }
            // Everyone else: where they are and which way they're looking.
            for o in all {
                guard let m = marks[o.id] else { continue }
                let p = pt(m.x, m.z)
                cone(at: p, yaw: m.yaw, colour: .white, length: 30)
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - 5, y: p.y - 5, width: 10, height: 10)), with: .color(o.feed == nil ? .white.opacity(0.5) : .white))
                ctx.draw(Text(names[o.id] ?? o.name).font(Theme.mono(8, bold: true)).foregroundColor(.white), at: CGPoint(x: p.x, y: p.y + 12))
            }
            // You.
            cone(at: c, yaw: me.yaw, colour: Theme.red, length: 40)
            ctx.fill(Path(ellipseIn: CGRect(x: c.x - 6, y: c.y - 6, width: 12, height: 12)), with: .color(Theme.red))
        }
        .frame(width: size, height: size)
        .overlay(Circle().stroke(Theme.line))
        .accessibilityLabel("Radar with the floor plan: \(all.map(\.name).joined(separator: ", "))")
    }

    /// Everyone's current view, side by side.
    private func viewGrid(_ all: [Other]) -> some View {
        let live = all.filter { $0.feed != nil }
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            ForEach(live) { o in
                VStack(alignment: .leading, spacing: 5) {
                    Image(uiImage: o.feed!.image).resizable().aspectRatio(contentMode: .fill)
                        .frame(height: 150).frame(maxWidth: .infinity).clipped()
                        .overlay(Rectangle().stroke(Color.white.opacity(0.7), lineWidth: 1))
                    HStack(spacing: 5) {
                        Circle().fill(Theme.red).frame(width: 6, height: 6)
                        Text(o.name).label(8, bold: true)
                        Spacer()
                        Text(String(format: "%.0f m", o.distance)).label(8).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
    }

    // MARK: Still

    private var still: some View {
        let all = others
        return ZStack {
            Color.black.opacity(0.85).ignoresSafeArea()
            VStack(spacing: 14) {
                HStack {
                    IconButton(glyph: .back, label: "Back to the group") { model.mode = .group }
                    Spacer()
                    HStack(spacing: 6) {
                        Circle().fill(Theme.red).frame(width: 8, height: 8)
                        Text("Live · still").label(10, bold: true)
                    }
                    Spacer()
                    Color.clear.frame(width: 46, height: 46)
                }
                Text("Streaming to the group. Keep this phone where it is, pointing into the room.")
                    .font(.system(size: 14)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
                ScrollView { viewGrid(all) }
                if all.allSatisfy({ $0.feed == nil }) {
                    Text("Other phones' views appear here when they go live.").font(.footnote).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 0)
                radarDisc(all, size: 190)
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
