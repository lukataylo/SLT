import SwiftUI
import simd

/// Builds the floor plan live from LiDAR: walk the building and the plan
/// draws itself. The shared map is white; walls this phone is scanning right
/// now are red. "Use as floor plan" renders it to a drawing and makes it the
/// building's floor plan, already lined up with the map.
struct LiveFloorPlanView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @ObservedObject var capture: ARCapture
    @ObservedObject var settings: Settings
    @State private var saving = false
    @State private var message: String?

    /// Map-frame geometry: the shared map, plus what this phone sees now.
    private var walls: [WallSegment] { relay.allWalls }
    private var liveWalls: [WallSegment] {
        let t = relay.alignment.transform
        return capture.scan.walls.map { w in
            let (ax, az) = model.isLocated ? t.apply(w.a.x, w.a.y) : (w.a.x, w.a.y)
            let (bx, bz) = model.isLocated ? t.apply(w.b.x, w.b.y) : (w.b.x, w.b.y)
            return WallSegment(a: SIMD2(ax, az), b: SIMD2(bx, bz))
        }
    }
    private var me: Mark? {
        capture.localMark.map { model.isLocated ? relay.alignment.transform.apply($0) : $0 }
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                plan
                HStack {
                    IconButton(glyph: .back, label: "Close") { model.mode = model.beforeFloorPlan }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("Live floor plan").label(10, bold: true)
                        Text(model.isLocated ? "Shared map · LiDAR" : "This phone only · not placed").label(8).foregroundStyle(Theme.muted)
                    }
                }
                .padding(16)
            }
            .frame(maxHeight: .infinity)
            .background(Color.black)

            Panel {
                VStack(alignment: .leading, spacing: 10) {
                    Text(capture.scan.floorY == nil ? "POINT AT THE FLOOR" : "WALK EVERY ROOM").font(Theme.display(22))
                    Text(capture.scan.floorY == nil
                         ? "Find the floor first, then walk slowly with the camera on the walls."
                         : "Walls appear as LiDAR finds them: red is what this phone sees now, white is saved. Get doorways and corners.")
                        .font(.system(size: 14)).foregroundStyle(Theme.muted)
                    HStack(spacing: 0) {
                        stat("\(walls.count)", "Walls")
                        stat("\(openingCount("door") + relay.doorways.count)", "Doors")
                        stat("\(openingCount("window"))", "Windows")
                        stat(String(format: "%.0f", area), "m² floor")
                    }
                    if let message { Text(message).font(.footnote).foregroundStyle(message.hasPrefix("Saved") ? .white : Theme.red) }
                    PillButton(title: saving ? "Saving…" : "Use as floor plan") { Task { await save() } }
                        .disabled(saving || walls.count < 3 || !model.isLocated)
                        .opacity(saving || walls.count < 3 || !model.isLocated ? 0.4 : 1)
                    if !model.isLocated {
                        Text("Create or join a group first, so the plan lines up with everyone.").font(.footnote).foregroundStyle(Theme.muted)
                    }
                }
            }
            .padding(12)
        }
    }

    private func openingCount(_ kind: String) -> Int { relay.rooms.flatMap(\.openings).filter { $0.kind == kind }.count }

    private var area: Float {
        relay.rooms.reduce(0) { sum, room in
            let f = room.floor
            guard f.count >= 3 else { return sum }
            var a: Float = 0
            for i in f.indices { let p = f[i], q = f[(i + 1) % f.count]; a += p.x * q.y - q.x * p.y }
            return sum + abs(a) / 2
        }
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 3) {
            Text(value).font(Theme.display(20))
            Text(label).label(7).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
    }

    /// North-up top-down drawing, fitted to everything known, following you.
    private var plan: some View {
        let shared = walls, live = liveWalls, me = me
        let openings = relay.rooms.flatMap(\.openings)
        let floors = relay.rooms.map(\.floor)
        let doorways = relay.doorways
        let others = relay.peerMarks
        return Canvas { ctx, size in
            var xs: [Float] = shared.flatMap { [$0.a.x, $0.b.x] } + live.flatMap { [$0.a.x, $0.b.x] }
            var zs: [Float] = shared.flatMap { [$0.a.y, $0.b.y] } + live.flatMap { [$0.a.y, $0.b.y] }
            if let me { xs.append(me.x); zs.append(me.z) }
            guard let minX = xs.min(), let maxX = xs.max(), let minZ = zs.min(), let maxZ = zs.max() else { return }
            let w = max(maxX - minX, 4) + 2, h = max(maxZ - minZ, 4) + 2
            let s = CGFloat(min(Float(size.width - 32) / w, Float(size.height - 120) / h))
            let cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
            func pt(_ x: Float, _ z: Float) -> CGPoint {
                CGPoint(x: size.width / 2 + CGFloat(x - cx) * s, y: size.height / 2 + 30 + CGFloat(z - cz) * s)
            }
            // Dot grid, one dot per metre.
            var gx = (minX - 1).rounded(.down)
            while gx <= maxX + 1 {
                var gz = (minZ - 1).rounded(.down)
                while gz <= maxZ + 1 {
                    let p = pt(gx, gz)
                    ctx.fill(Path(ellipseIn: CGRect(x: p.x - 1, y: p.y - 1, width: 2, height: 2)), with: .color(.white.opacity(0.18)))
                    gz += 1
                }
                gx += 1
            }
            for f in floors where f.count >= 3 {
                var p = Path(); p.move(to: pt(f[0].x, f[0].y))
                for v in f.dropFirst() { p.addLine(to: pt(v.x, v.y)) }
                p.closeSubpath()
                ctx.fill(p, with: .color(.white.opacity(0.06)))
            }
            var savedPath = Path()
            for w in shared { savedPath.move(to: pt(w.a.x, w.a.y)); savedPath.addLine(to: pt(w.b.x, w.b.y)) }
            ctx.stroke(savedPath, with: .color(.white), style: StrokeStyle(lineWidth: 4, lineCap: .round))
            var livePath = Path()
            for w in live { livePath.move(to: pt(w.a.x, w.a.y)); livePath.addLine(to: pt(w.b.x, w.b.y)) }
            ctx.stroke(livePath, with: .color(Theme.red), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            for o in openings {
                var p = Path(); p.move(to: pt(o.a.x, o.a.y)); p.addLine(to: pt(o.b.x, o.b.y))
                ctx.stroke(p, with: .color(o.kind == "door" ? Theme.red : .white.opacity(0.45)), style: StrokeStyle(lineWidth: 6, lineCap: .butt))
            }
            // Doorways: open doors as leaf + swing, closed ones as a solid bar.
            for d in doorways {
                if d.open {
                    let sym = d.symbol(floors: floors)
                    var leaf = Path(); leaf.move(to: pt(sym.leaf[0].x, sym.leaf[0].y)); leaf.addLine(to: pt(sym.leaf[1].x, sym.leaf[1].y))
                    var arc = Path(); arc.move(to: pt(sym.arc[0].x, sym.arc[0].y))
                    sym.arc.dropFirst().forEach { arc.addLine(to: pt($0.x, $0.y)) }
                    ctx.stroke(leaf, with: .color(Theme.red), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    ctx.stroke(arc, with: .color(Theme.red.opacity(0.8)), style: StrokeStyle(lineWidth: 1.2, dash: [3, 3]))
                } else {
                    var bar = Path(); bar.move(to: pt(d.a.x, d.a.y)); bar.addLine(to: pt(d.b.x, d.b.y))
                    ctx.stroke(bar, with: .color(Theme.red), style: StrokeStyle(lineWidth: 6))
                }
            }
            func phone(_ m: Mark, _ colour: Color) {
                let p = pt(m.x, m.z), d = CGPoint(x: -CGFloat(sin(m.yaw)), y: -CGFloat(cos(m.yaw)))
                var cone = Path(); cone.move(to: p)
                let a = atan2(d.y, d.x)
                cone.addLine(to: CGPoint(x: p.x + cos(a - 0.5) * 34, y: p.y + sin(a - 0.5) * 34))
                cone.addLine(to: CGPoint(x: p.x + cos(a + 0.5) * 34, y: p.y + sin(a + 0.5) * 34))
                cone.closeSubpath()
                ctx.fill(cone, with: .color(colour.opacity(0.3)))
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - 6, y: p.y - 6, width: 12, height: 12)), with: .color(colour))
            }
            if model.isLocated { for m in others.values { phone(m, .white) } }
            if let me { phone(me, Theme.red) }
        }
    }

    // MARK: saving

    /// Renders the map at 50 px/m and uploads it as the floor plan, with the
    /// scanned rooms outlined, then places it exactly where it came from.
    private func save() async {
        saving = true
        message = nil
        defer { saving = false }
        let ppm: CGFloat = 50
        let xs = walls.flatMap { [$0.a.x, $0.b.x] }, zs = walls.flatMap { [$0.a.y, $0.b.y] }
        guard let minX = xs.min(), let maxX = xs.max(), let minZ = zs.min(), let maxZ = zs.max() else { return }
        let ox = minX - 1, oz = minZ - 1 // plan origin (top-left), 1 m margin
        let size = CGSize(width: CGFloat(maxX - minX + 2) * ppm, height: CGFloat(maxZ - minZ + 2) * ppm)
        func px(_ x: Float, _ z: Float) -> CGPoint { CGPoint(x: CGFloat(x - ox) * ppm, y: CGFloat(z - oz) * ppm) }
        let openings = relay.rooms.flatMap(\.openings)
        let image = UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).image { r in
            let c = r.cgContext
            UIColor.white.setFill(); c.fill(CGRect(origin: .zero, size: size))
            c.setLineCap(.square)
            UIColor.black.setStroke(); c.setLineWidth(6)
            for w in walls { c.move(to: px(w.a.x, w.a.y)); c.addLine(to: px(w.b.x, w.b.y)) }
            c.strokePath()
            for o in openings {
                (o.kind == "door" ? UIColor(red: 0.84, green: 0.1, blue: 0.13, alpha: 1) : UIColor(white: 0.6, alpha: 1)).setStroke()
                c.setLineWidth(8)
                c.move(to: px(o.a.x, o.a.y)); c.addLine(to: px(o.b.x, o.b.y)); c.strokePath()
            }
            let floors = relay.rooms.map(\.floor)
            for d in relay.doorways {
                UIColor(red: 0.84, green: 0.1, blue: 0.13, alpha: 1).setStroke()
                if d.open {
                    let sym = d.symbol(floors: floors)
                    c.setLineWidth(4)
                    c.move(to: px(sym.leaf[0].x, sym.leaf[0].y)); c.addLine(to: px(sym.leaf[1].x, sym.leaf[1].y)); c.strokePath()
                    c.setLineWidth(2)
                    c.move(to: px(sym.arc[0].x, sym.arc[0].y))
                    for p in sym.arc.dropFirst() { c.addLine(to: px(p.x, p.y)) }
                    c.strokePath()
                } else {
                    c.setLineWidth(8)
                    c.move(to: px(d.a.x, d.a.y)); c.addLine(to: px(d.b.x, d.b.y)); c.strokePath()
                }
            }
            for room in relay.rooms where room.floor.count >= 3 {
                let centre = room.floor.reduce(SIMD2<Float>.zero, +) / Float(room.floor.count)
                let p = px(centre.x, centre.y)
                (room.name.uppercased() as NSString).draw(at: CGPoint(x: p.x - 30, y: p.y - 10),
                    withAttributes: [.font: UIFont.monospacedSystemFont(ofSize: 18, weight: .bold), .foregroundColor: UIColor.darkGray])
            }
        }
        guard let jpeg = image.jpegData(compressionQuality: 0.9) else { return }
        // Rooms in plan metres: x right, z down from the drawing's top-left.
        let rooms: [[String: Any]] = relay.rooms.filter { $0.floor.count >= 3 }.map { room in
            ["id": room.id, "name": room.name,
             "polygon": room.floor.map { [Double($0.x - ox), Double($0.y - oz)] }]
        }
        do {
            try await relay.uploadPlan(name: "LiDAR floor plan", jpeg: jpeg, widthPx: Int(size.width), heightPx: Int(size.height),
                                       metresPerPx: Double(1 / ppm), token: settings.adminToken, rooms: rooms)
            // Plan frame → map frame is a pure shift: no rotation, origin at (ox, oz).
            try await relay.setPlanPlacement(FloorTransform(yaw: 0, tx: ox, tz: oz), token: settings.adminToken)
            Haptics.success()
            message = "Saved. It's the floor plan for everyone now, including the operator."
        } catch {
            message = error.localizedDescription
        }
    }
}
