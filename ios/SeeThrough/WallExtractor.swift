import ARKit
import simd

/// Vectorises ARKit's LiDAR-backed plane anchors into floor-plan segments:
/// every vertical plane becomes a 2D line [x1, z1, x2, z2] where it meets the
/// floor, spanning the plane's horizontal extent.
enum WallExtractor {
    static let minWallLength: Float = 0.4

    static func extract(from anchors: [ARAnchor]) -> (walls: [[Float]], floorY: Float?) {
        var walls: [[Float]] = []
        var floorY: Float?
        let up = SIMD3<Float>(0, 1, 0)

        for case let plane as ARPlaneAnchor in anchors {
            let transform = plane.transform
            let origin = SIMD3(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)

            if plane.alignment == .horizontal {
                // Lowest horizontal surface is the floor; tables and seats sit higher.
                let isFloor = ARPlaneAnchor.isClassificationSupported ? plane.classification == .floor : true
                if isFloor { floorY = min(floorY ?? origin.y, origin.y) }
                continue
            }

            switch plane.classification {
            case .wall, .door, .window, .none: break
            default: continue
            }

            // A plane anchor's local Y axis is its normal; the wall runs along
            // the horizontal direction perpendicular to it.
            let normal = simd_normalize(SIMD3(transform.columns.1.x, transform.columns.1.y, transform.columns.1.z))
            let across = simd_cross(up, normal)
            guard simd_length(across) > 0.5 else { continue }
            let dir = simd_normalize(across)

            let extents = plane.geometry.boundaryVertices.map { v -> Float in
                let world = transform * SIMD4(v, 1)
                return simd_dot(SIMD3(world.x, world.y, world.z) - origin, dir)
            }
            guard let lo = extents.min(), let hi = extents.max(), hi - lo >= minWallLength else { continue }
            let a = origin + dir * lo
            let b = origin + dir * hi
            walls.append([a.x, a.z, b.x, b.z])
        }
        return (walls, floorY)
    }
}
