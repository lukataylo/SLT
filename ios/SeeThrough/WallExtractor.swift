import ARKit
import simd

/// What the phone has scanned so far, in its own ARKit frame.
struct LocalScan: Equatable {
    var walls: [WallSegment] = []
    var openings: [Opening] = []
    var floor: [SIMD2<Float>] = []
    var floorY: Float?
}

/// Vectorises ARKit's LiDAR-backed plane anchors into floor-plan geometry:
/// vertical planes become wall segments (fragments of one wall merged into a
/// single wall), door/window planes become openings, and floor planes give the
/// floor height and outline.
enum WallExtractor {
    static let minPlaneLength: Float = 0.3

    static func extract(from anchors: [ARAnchor]) -> LocalScan {
        var fragments: [WallSegment] = []
        var planeOpenings: [(kind: String, a: SIMD2<Float>, b: SIMD2<Float>, y0: Float, y1: Float)] = []
        var floorY: Float?
        var floorPoints: [SIMD2<Float>] = []
        var horizontals: [(y: Float, points: [SIMD2<Float>])] = []
        let up = SIMD3<Float>(0, 1, 0)

        for case let plane as ARPlaneAnchor in anchors {
            let transform = plane.transform
            let origin = SIMD3(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
            let world = plane.geometry.boundaryVertices.map { v -> SIMD3<Float> in
                let w = transform * SIMD4(v, 1)
                return SIMD3(w.x, w.y, w.z)
            }

            if plane.alignment == .horizontal {
                let pts = world.map { SIMD2($0.x, $0.z) }
                if plane.classification == .floor {
                    floorY = min(floorY ?? origin.y, origin.y)
                    floorPoints += pts
                } else {
                    horizontals.append((origin.y, pts))
                }
                continue
            }

            // A vertical plane's local Y axis is its normal; the wall runs along
            // the horizontal direction perpendicular to it.
            let normal = simd_normalize(SIMD3(transform.columns.1.x, transform.columns.1.y, transform.columns.1.z))
            let across = simd_cross(up, normal)
            guard simd_length(across) > 0.5 else { continue }
            let dir = simd_normalize(across)
            let ts = world.map { simd_dot($0 - origin, dir) }
            guard let lo = ts.min(), let hi = ts.max(), hi - lo >= minPlaneLength else { continue }
            let a3 = origin + dir * lo, b3 = origin + dir * hi
            let a = SIMD2(a3.x, a3.z), b = SIMD2(b3.x, b3.z)

            switch plane.classification {
            case .door, .window:
                let ys = world.map(\.y)
                planeOpenings.append((plane.classification == .door ? "door" : "window", a, b, ys.min() ?? origin.y, ys.max() ?? origin.y))
            case .wall, .none:
                fragments.append(WallSegment(a: a, b: b))
            default:
                continue
            }
        }

        // Without classification (or before the floor is labelled), the lowest
        // large horizontal surface is the floor.
        if floorY == nil, let lowest = horizontals.min(by: { $0.y < $1.y }), lowest.points.count >= 3 {
            floorY = lowest.y
            floorPoints = lowest.points
        }

        let walls = FloorGeometry.merge(fragments)
        var scan = LocalScan(walls: walls, floor: FloorGeometry.hull(floorPoints), floorY: floorY)
        scan.openings = planeOpenings.compactMap { o in
            // Snap the opening onto the wall it sits in.
            let mid = (o.a + o.b) / 2
            guard let hit = FloorGeometry.nearestWall(mid, in: walls) else {
                return Opening(kind: o.kind, a: o.a, b: o.b, y0: o.y0, y1: o.y1)
            }
            let w = walls[hit.index]
            let u = simd_normalize(w.b - w.a)
            let t0 = simd_dot(o.a - w.a, u), t1 = simd_dot(o.b - w.a, u)
            return Opening(kind: o.kind, a: w.a + u * min(t0, t1), b: w.a + u * max(t0, t1), y0: o.y0, y1: o.y1)
        }
        return scan
    }
}
