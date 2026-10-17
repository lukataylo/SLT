import Foundation
import simd

/// Choosing the 4 wall reference photos while a room is scanned: one facing
/// each of the room's wall directions (its dominant wall angle + k·90°),
/// taken square-on and from as far back as the phone gets, so it shows as
/// much of the wall as possible. Map frame throughout.
enum WallReferences {
    static let slots = 4
    /// How square-on the camera must face a wall direction, and how level.
    static let facingTolerance: Float = 10 * .pi / 180
    static let pitchTolerance: Float = 15 * .pi / 180
    static let minDistance: Float = 1.0
    /// A slot is retaken only from at least this much further back.
    static let improvement: Float = 0.5

    struct Targets {
        var alignment: FloorTransform
        var walls: [WallSegment]
        /// Distance to the wall of the photo each slot already has.
        var best: [Float?] = Array(repeating: nil, count: WallReferences.slots)

        /// The slot this camera pose should fill, and how far it is from the
        /// wall it faces; nil if it isn't a better photo than the one there.
        func candidate(_ camera: simd_float4x4) -> (slot: Int, distance: Float)? {
            guard walls.count >= 3, let view = WallReferences.view(camera, alignment) else { return nil }
            guard abs(view.pitch) <= pitchTolerance, let slot = WallReferences.slot(facing: view.angle, walls: walls),
                  let d = WallReferences.distanceToWall(from: view.position, angle: view.angle, walls: walls), d >= minDistance else { return nil }
            if let have = best[slot], d < have + improvement { return nil }
            return (slot, d)
        }
    }

    /// Where a camera stands and looks on the map: position, the angle of
    /// its forward direction (atan2(z, x), like wall segments) and pitch.
    static func view(_ camera: simd_float4x4, _ alignment: FloorTransform) -> (position: SIMD2<Float>, angle: Float, pitch: Float)? {
        let f = -SIMD3(camera.columns.2.x, camera.columns.2.y, camera.columns.2.z)
        let flat = SIMD2(f.x, f.z)
        guard simd_length(flat) > 1e-3 else { return nil }
        let (x, z) = alignment.apply(camera.columns.3.x, camera.columns.3.z)
        let (fx, fz) = alignment.apply(flat.x, flat.y)
        let (ox, oz) = alignment.apply(0, 0)
        return (SIMD2(x, z), atan2(fz - oz, fx - ox), asin(min(1, max(-1, f.y))))
    }

    /// The room's wall direction, from its walls weighted by length.
    static func dominantAngle(_ walls: [WallSegment]) -> Float {
        var sx: Float = 0, sy: Float = 0
        for w in walls {
            let d = w.b - w.a
            let a = atan2(d.y, d.x), l = simd_length(d)
            sx += l * cos(4 * a)
            sy += l * sin(4 * a)
        }
        return atan2(sy, sx) / 4
    }

    /// Which of the 4 directions an angle faces, if within tolerance.
    static func slot(facing angle: Float, walls: [WallSegment]) -> Int? {
        let quarter = Float.pi / 2
        let rel = angle - dominantAngle(walls)
        let k = (rel / quarter).rounded()
        guard abs(rel - k * quarter) <= facingTolerance else { return nil }
        return ((Int(k) % slots) + slots) % slots
    }

    /// Distance along a ray to the nearest wall it hits.
    static func distanceToWall(from p: SIMD2<Float>, angle: Float, walls: [WallSegment]) -> Float? {
        let d = SIMD2(cos(angle), sin(angle))
        var best: Float?
        for w in walls {
            let e = w.b - w.a
            let denom = d.x * e.y - d.y * e.x
            guard abs(denom) > 1e-6 else { continue }
            let q = w.a - p
            let t = (q.x * e.y - q.y * e.x) / denom
            let u = (q.x * d.y - q.y * d.x) / denom
            guard t > 0, u >= -0.05, u <= 1.05 else { continue }
            if best == nil || t < best! { best = t }
        }
        return best
    }
}
