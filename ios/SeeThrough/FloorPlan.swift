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
        var forward = orientation.act(SIMD3<Float>(0, 0, -1))
        // Held flat (looking at the floor or ceiling), the camera's forward has
        // no useful heading; use the direction the top of the phone points.
        if hypot(forward.x, forward.z) < 0.35 { forward = orientation.act(SIMD3<Float>(-1, 0, 0)) }
        self.init(x: position.x, z: position.z, yaw: atan2(-forward.x, -forward.z))
    }
}

/// Rotation about +Y then translation on the floor: the server's alignment
/// of this phone's ARKit frame onto the shared map.
struct FloorTransform: Equatable {
    var yaw: Float = 0
    var tx: Float = 0
    var tz: Float = 0
    /// Vertical shift that puts the floor at y = 0.
    var ty: Float = 0

    /// As a 4x4 matrix taking this phone's ARKit frame into the map frame.
    var matrix: simd_float4x4 {
        var m = simd_float4x4(simd_quatf(angle: yaw, axis: SIMD3(0, 1, 0)))
        m.columns.3 = SIMD4(tx, ty, tz, 1)
        return m
    }

    /// The alignment whose matrix is `m` (a gravity-aligned rigid transform).
    init(matrix m: simd_float4x4) {
        yaw = atan2(-m.columns.0.z, m.columns.0.x)
        tx = m.columns.3.x
        ty = m.columns.3.y
        tz = m.columns.3.z
    }

    init(yaw: Float = 0, tx: Float = 0, tz: Float = 0, ty: Float = 0) {
        self.yaw = yaw
        self.tx = tx
        self.tz = tz
        self.ty = ty
    }

    func apply(_ x: Float, _ z: Float) -> (Float, Float) {
        let c = cos(yaw), s = sin(yaw)
        return (c * x + s * z + tx, -s * x + c * z + tz)
    }

    func apply(_ mark: Mark) -> Mark {
        let (x, z) = apply(mark.x, mark.z)
        return Mark(x: x, z: z, yaw: mark.yaw + yaw)
    }
}

/// The live floor-plan card: a 3D preview of the walls as LiDAR vectorises them.
struct FloorPlanView: View {
    var walls: [[Float]]
    var seen: [Int] = []
    var openings: [Opening] = []
    var floor: [SIMD2<Float>] = []
    var target: [WallSegment] = []
    var me: Mark?
    var peers: [Mark]
    var origin: FloorPlanScene.Origin?
    var cloud: LocalCloud?
    var cloudVersion = 0
    var cloudTransform = matrix_identity_float4x4
    var title: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).label(8).foregroundStyle(Theme.muted).lineLimit(1)
                Spacer()
                Text("\(walls.count) walls · \(openings.filter { $0.kind == "door" }.count) doors · \(openings.filter { $0.kind == "window" }.count) win").label(8).foregroundStyle(Theme.muted)
            }
            ZStack {
                FloorPlanScene(walls: walls, seen: seen, openings: openings, floor: floor, target: target, me: me, peers: peers, origin: origin,
                               cloud: cloud, cloudVersion: cloudVersion, cloudTransform: cloudTransform)
                if walls.isEmpty {
                    Text("SWEEP ACROSS A WALL").font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundStyle(.gray)
                }
            }
            .background(Color(white: 0.02))
            .clipShape(RoundedRectangle(cornerRadius: 14))
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 22).fill(.black.opacity(0.78)))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.14)))
    }
}
