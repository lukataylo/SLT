import SwiftUI
import simd

/// Live. Still phones show a calm "streaming" screen. Move phones get the
/// radar: everyone around you, their views docked at the screen edge on
/// their side, and the one you face locked on in the middle.
struct LiveView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @ObservedObject var capture: ARCapture
    @ObservedObject var figures: FigureStore
    /// Whose view is open (tapped figure or edge arrow).
    @State private var opened: String?

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

    // MARK: Move: radar

    /// Other people behind walls appear as stick figures where they stand.
    /// People in plain sight get just a name tag. Tap either to open their view.
    private var radar: some View {
        let all = others
        let byId = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
        let walls = relay.allWalls
        let me = capture.localMark.map { relay.alignment.transform.apply($0) }
        let marks = relay.peerMarks
        func behindWall(_ id: String) -> Bool {
            guard let me, let m = marks[id] else { return false }
            return Self.wallBetween(SIMD2(me.x, me.z), SIMD2(m.x, m.z), walls)
        }
        return ZStack {
            GeometryReader { geo in
                ZStack {
                    ForEach(figures.figures.filter(\.visible)) { f in
                        let h = max(f.feet.y - f.head.y, 24)
                        let wall = behindWall(f.id)
                        // The figure is the x-ray: only drawn when a wall hides them.
                        // In plain sight you see the person; just their tag shows.
                        if wall {
                            StickFigure(head: f.head, feet: f.feet, behindWall: true, selected: opened == f.id)
                        }
                        // Name and distance over the head.
                        HStack(spacing: 5) {
                            Circle().fill(byId[f.id]?.feed == nil ? Color.white.opacity(0.4) : Theme.red).frame(width: 6, height: 6)
                            Text(f.name).label(9, bold: true)
                            Text(String(format: "%.0f m%@", f.distance, wall ? " · behind wall" : "")).label(8).foregroundStyle(.white.opacity(0.75))
                        }
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Capsule().fill(Theme.panel))
                        .position(x: f.head.x, y: f.head.y - 18)
                        .allowsHitTesting(false)
                        // Tap target over the whole figure.
                        Color.clear.contentShape(Rectangle())
                            .frame(width: max(h * 0.5, 64), height: h + 40)
                            .position(x: (f.head.x + f.feet.x) / 2, y: (f.head.y + f.feet.y) / 2 - 10)
                            .onTapGesture { open(f.id) }
                            .accessibilityElement()
                            .accessibilityLabel("\(f.name), \(String(format: "%.0f", f.distance)) metres\(wall ? ", behind a wall" : ""). Open their view.")
                            .accessibilityAddTraits(.isButton)
                    }
                    // People out of view: an arrow at the screen edge on their side.
                    ForEach(figures.figures.filter { !$0.visible }) { f in
                        edgeChip(f, in: geo.size)
                    }
                }
            }
            .ignoresSafeArea()

            VStack(spacing: 12) {
                topBar(count: all.filter { $0.feed != nil }.count)
                Spacer()
                if all.isEmpty {
                    Panel {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("NOBODY TO SEE YET").font(Theme.display(22))
                            Text("When others in the group are placed, they appear here as figures, through the walls.").font(.system(size: 14)).foregroundStyle(Theme.muted)
                        }
                    }
                } else if opened == nil {
                    Text("Tap a person to open their view").label(9, bold: true)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(Capsule().fill(Theme.panel))
                }
                radarDisc(all)
            }
            .padding(16)

            if let id = opened, let o = byId[id] {
                Color.black.opacity(0.55).ignoresSafeArea().onTapGesture { opened = nil }
                viewCard(o, behindWall: behindWall(id))
                    .padding(16)
                    .transition(.scale(scale: 0.9).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.22), value: opened)
    }

    private func open(_ id: String) {
        Haptics.tap()
        opened = id
    }

    /// Whether any scanned wall crosses the straight line between two people.
    static func wallBetween(_ a: SIMD2<Float>, _ b: SIMD2<Float>, _ walls: [WallSegment]) -> Bool {
        func cross(_ p: SIMD2<Float>, _ q: SIMD2<Float>) -> Float { p.x * q.y - p.y * q.x }
        let d = b - a
        for w in walls {
            let e = w.b - w.a, denom = cross(d, e)
            guard abs(denom) > 1e-6 else { continue }
            let t = cross(w.a - a, e) / denom, u = cross(w.a - a, d) / denom
            // Ignore walls right at either person (they may be leaning on one).
            if t > 0.05 && t < 0.95 && u >= 0 && u <= 1 { return true }
        }
        return false
    }

    private func edgeChip(_ f: FigureStore.Figure, in size: CGSize) -> some View {
        let inset = CGRect(origin: .zero, size: size).insetBy(dx: 70, dy: 150)
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        let dx = cos(f.angle), dy = sin(f.angle)
        let r = min(dx == 0 ? .infinity : inset.width / 2 / abs(dx), dy == 0 ? .infinity : inset.height / 2 / abs(dy))
        return Button { open(f.id) } label: {
            HStack(spacing: 7) {
                Image(systemName: "arrowtriangle.right.fill").font(.system(size: 10)).rotationEffect(.radians(f.angle)).foregroundStyle(Theme.red)
                Text(f.name).label(9, bold: true)
                Text(String(format: "%.0f m", f.distance)).label(8).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(Capsule().fill(Theme.panel))
            .overlay(Capsule().stroke(Theme.line))
        }
        .foregroundStyle(.white)
        .position(x: c.x + dx * r, y: c.y + dy * r)
        .accessibilityLabel("\(f.name), \(String(format: "%.0f", f.distance)) metres, out of view. Open their view.")
    }

    /// Someone's live view, opened from their figure.
    private func viewCard(_ o: Other, behindWall: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Circle().fill(o.feed == nil ? Color.white.opacity(0.4) : Theme.red).frame(width: 8, height: 8)
                Text(o.name.uppercased()).font(Theme.display(24))
                Spacer()
                IconButton(glyph: .close, label: "Close their view") { opened = nil }
            }
            Text("\(String(format: "%.0f", o.distance)) m away\(behindWall ? " · behind a wall" : "")\(o.still ? " · still" : "")")
                .label(9).foregroundStyle(Theme.muted)
            if let feed = o.feed {
                Image(uiImage: feed.image).resizable().aspectRatio(contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: 460)
                    .overlay(Rectangle().stroke(Theme.red, lineWidth: 2))
                Text("What \(o.name) sees, live.").font(.footnote).foregroundStyle(Theme.muted)
            } else {
                Text("No video from \(o.name) yet. Their view appears once they're live.")
                    .font(.system(size: 15)).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, minHeight: 160)
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 24).fill(Color.black.opacity(0.92)))
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(Theme.line))
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

    /// Top-down, you in the middle facing up: the scanned floor plan turns
    /// around you as you turn, with everyone's position and view cone.
    private func radarDisc(_ all: [Other], size: CGFloat = 210) -> some View {
        let walls = relay.allWalls
        let uploadedPlan = relay.plan
        let doorways = relay.doorways
        let floors = relay.rooms.map(\.floor)
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
            for d in doorways {
                if d.open {
                    let sym = d.symbol(floors: floors)
                    var arc = Path(); arc.move(to: pt(sym.leaf[1].x, sym.leaf[1].y)); arc.addLine(to: pt(sym.leaf[0].x, sym.leaf[0].y))
                    arc.move(to: pt(sym.arc[0].x, sym.arc[0].y)); sym.arc.dropFirst().forEach { arc.addLine(to: pt($0.x, $0.y)) }
                    ctx.stroke(arc, with: .color(Theme.red.opacity(0.85)), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
                } else {
                    var bar = Path(); bar.move(to: pt(d.a.x, d.a.y)); bar.addLine(to: pt(d.b.x, d.b.y))
                    ctx.stroke(bar, with: .color(Theme.red), style: StrokeStyle(lineWidth: 3.5))
                }
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
