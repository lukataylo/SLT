import SwiftUI
import simd

/// A phone on the floor plan: position on the floor and heading (yaw 0 looks
/// down -Z, positive turns left, as in shared/planes.js).
struct Mark: Equatable {
    var x: Float
    var z: Float
    var yaw: Float

    init(x: Float, z: Float, yaw: Float) {
        self.x = x
        self.z = z
        self.yaw = yaw
    }

    init(position: SIMD3<Float>, orientation: simd_quatf) {
        let forward = orientation.act(SIMD3<Float>(0, 0, -1))
        self.init(x: position.x, z: position.z, yaw: atan2(-forward.x, -forward.z))
    }
}

/// Rotation about +Y then translation on the floor: the server's alignment
/// of this phone's ARKit frame onto the shared map.
struct FloorTransform: Equatable {
    var yaw: Float = 0
    var tx: Float = 0
    var tz: Float = 0

    func apply(_ x: Float, _ z: Float) -> (Float, Float) {
        let c = cos(yaw), s = sin(yaw)
        return (c * x + s * z + tx, -s * x + c * z + tz)
    }

    func apply(_ mark: Mark) -> Mark {
        let (x, z) = apply(mark.x, mark.z)
        return Mark(x: x, z: z, yaw: mark.yaw + yaw)
    }
}

private let red = Color(red: 0.843, green: 0.098, blue: 0.129)

/// Top-down live floor plan, redrawn as LiDAR walls are vectorised.
struct FloorPlanView: View {
    var walls: [[Float]]
    var me: Mark?
    var peers: [Mark]
    var title: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.system(size: 9, design: .monospaced)).tracking(1.3).foregroundStyle(.gray)
                Spacer()
                Text("\(walls.count) WALLS").font(.system(size: 9, design: .monospaced)).tracking(1.3).foregroundStyle(.gray)
            }
            Canvas { ctx, size in draw(in: &ctx, size: size) }
                .background(Color(white: 0.02))
                .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 22).fill(.black.opacity(0.78)))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.14)))
    }

    private func draw(in ctx: inout GraphicsContext, size: CGSize) {
        // Dot-grid backdrop.
        let pitch: CGFloat = 12
        var y = pitch / 2
        while y < size.height {
            var x = pitch / 2
            while x < size.width {
                ctx.fill(Path(ellipseIn: CGRect(x: x - 0.7, y: y - 0.7, width: 1.4, height: 1.4)), with: .color(.white.opacity(0.13)))
                x += pitch
            }
            y += pitch
        }

        // Fit everything seen so far, at least 4 m across, with a 1 m margin.
        var xs = walls.flatMap { [$0[0], $0[2]] }
        var zs = walls.flatMap { [$0[1], $0[3]] }
        for m in peers + (me.map { [$0] } ?? []) {
            xs.append(m.x)
            zs.append(m.z)
        }
        guard let minX = xs.min(), let maxX = xs.max(), let minZ = zs.min(), let maxZ = zs.max() else {
            ctx.draw(Text("SWEEP ACROSS A WALL").font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundColor(.gray),
                     at: CGPoint(x: size.width / 2, y: size.height / 2))
            return
        }
        let spanX = max(maxX - minX, 4) + 2
        let spanZ = max(maxZ - minZ, 4) + 2
        let scale = CGFloat(min(Float(size.width) / spanX, Float(size.height) / spanZ))
        let cx = (minX + maxX) / 2
        let cz = (minZ + maxZ) / 2
        func pt(_ x: Float, _ z: Float) -> CGPoint {
            CGPoint(x: size.width / 2 + CGFloat(x - cx) * scale, y: size.height / 2 + CGFloat(z - cz) * scale)
        }

        var wallPath = Path()
        for w in walls {
            wallPath.move(to: pt(w[0], w[1]))
            wallPath.addLine(to: pt(w[2], w[3]))
        }
        ctx.stroke(wallPath, with: .color(.white), style: StrokeStyle(lineWidth: 2.6, lineCap: .round, dash: [0.1, 5]))

        func phone(_ m: Mark, color: Color) {
            let p = pt(m.x, m.z)
            // Forward on screen is (-sin yaw, -cos yaw): x right, z down.
            let heading = CGFloat(atan2(-cos(m.yaw), -sin(m.yaw)))
            var cone = Path()
            cone.move(to: p)
            for i in 0...8 {
                let a = heading - 0.45 + 0.9 * CGFloat(i) / 8
                cone.addLine(to: CGPoint(x: p.x + 26 * cos(a), y: p.y + 26 * sin(a)))
            }
            cone.closeSubpath()
            ctx.fill(cone, with: .color(color.opacity(0.3)))
            ctx.fill(Path(ellipseIn: CGRect(x: p.x - 4.5, y: p.y - 4.5, width: 9, height: 9)), with: .color(color))
        }
        for m in peers { phone(m, color: .white) }
        if let me { phone(me, color: red) }
    }
}
