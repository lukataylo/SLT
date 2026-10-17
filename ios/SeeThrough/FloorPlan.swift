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
    var title: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.system(size: 9, design: .monospaced)).tracking(1.3).foregroundStyle(.gray)
                Spacer()
                Text("\(walls.count) WALLS · \(openings.filter { $0.kind == "door" }.count) DOORS · \(openings.filter { $0.kind == "window" }.count) WIN").font(.system(size: 9, design: .monospaced)).tracking(1.3).foregroundStyle(.gray)
            }
            ZStack {
                FloorPlanScene(walls: walls, seen: seen, openings: openings, floor: floor, target: target, me: me, peers: peers, origin: origin)
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
