import Foundation
import simd

/// A wall on the floor plan: a 2D segment (x, z) plus how many ARKit plane
/// fragments support it.
struct WallSegment: Equatable {
    var a: SIMD2<Float>
    var b: SIMD2<Float>
    var support: Int = 1

    var length: Float { simd_distance(a, b) }
    var angle: Float { atan2(b.y - a.y, b.x - a.x) }
    var array: [Float] { [a.x, a.y, b.x, b.y] }
}

/// A door or window on a wall: its span on the floor plan plus its height range.
struct Opening: Equatable {
    var kind: String // "door" | "window"
    var a: SIMD2<Float>
    var b: SIMD2<Float>
    var y0: Float
    var y1: Float

    var json: [String: Any] {
        ["kind": kind, "s": [a.x, a.y, b.x, b.y].map(Double.init), "y0": Double(y0), "y1": Double(y1)]
    }
}

/// Swift port of the merging in shared/planes.js, so the phone reinforces the
/// many plane fragments ARKit reports for one wall into a single wall locally.
enum FloorGeometry {
    static let angleTol: Float = 10 * .pi / 180
    static let distTol: Float = 0.25
    static let gapTol: Float = 0.5

    private static func angleDiff(_ a: Float, _ b: Float) -> Float {
        var d = fmodf(a - b, .pi)
        if d < 0 { d += .pi }
        return min(d, .pi - d)
    }

    static func canMerge(_ a: WallSegment, _ b: WallSegment) -> Bool {
        guard angleDiff(a.angle, b.angle) <= angleTol else { return false }
        let (ref, other) = a.length >= b.length ? (a, b) : (b, a)
        let u = simd_normalize(ref.b - ref.a)
        let n = SIMD2(-u.y, u.x)
        let across = { (p: SIMD2<Float>) in abs(simd_dot(p - ref.a, n)) }
        guard across(other.a) <= distTol, across(other.b) <= distTol else { return false }
        let along = { (p: SIMD2<Float>) in simd_dot(p - ref.a, u) }
        let r = [along(ref.a), along(ref.b)].sorted()
        let s = [along(other.a), along(other.b)].sorted()
        return max(s[0] - r[1], r[0] - s[1]) < gapTol
    }

    /// Length-weighted best-fit line through both, spanning their union.
    static func fuse(_ a: WallSegment, _ b: WallSegment) -> WallSegment {
        let wa = a.length * Float(a.support), wb = b.length * Float(b.support)
        // Average on the doubled angle so opposite-facing segments agree.
        let ang = atan2(wa * sin(2 * a.angle) + wb * sin(2 * b.angle), wa * cos(2 * a.angle) + wb * cos(2 * b.angle)) / 2
        let u = SIMD2(cos(ang), sin(ang))
        let c = ((a.a + a.b) / 2 * wa + (b.a + b.b) / 2 * wb) / (wa + wb)
        let ts = [a.a, a.b, b.a, b.b].map { simd_dot($0 - c, u) }
        return WallSegment(a: c + u * ts.min()!, b: c + u * ts.max()!, support: a.support + b.support)
    }

    static func merge(_ input: [WallSegment], minLength: Float = 0.3) -> [WallSegment] {
        var out = input.filter { $0.length >= minLength }
        var changed = true
        while changed {
            changed = false
            outer: for i in out.indices {
                for j in out.indices where j > i && canMerge(out[i], out[j]) {
                    out[i] = fuse(out[i], out[j])
                    out.remove(at: j)
                    changed = true
                    break outer
                }
            }
        }
        return out
    }

    /// Andrew's monotone chain on (x, z) points.
    static func hull(_ points: [SIMD2<Float>]) -> [SIMD2<Float>] {
        let pts = points.sorted { $0.x == $1.x ? $0.y < $1.y : $0.x < $1.x }
        guard pts.count >= 3 else { return pts }
        func cross(_ o: SIMD2<Float>, _ a: SIMD2<Float>, _ b: SIMD2<Float>) -> Float {
            (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
        }
        var lower: [SIMD2<Float>] = []
        for p in pts {
            while lower.count >= 2 && cross(lower[lower.count - 2], lower[lower.count - 1], p) <= 0 { lower.removeLast() }
            lower.append(p)
        }
        var upper: [SIMD2<Float>] = []
        for p in pts.reversed() {
            while upper.count >= 2 && cross(upper[upper.count - 2], upper[upper.count - 1], p) <= 0 { upper.removeLast() }
            upper.append(p)
        }
        return Array(lower.dropLast() + upper.dropLast())
    }

    /// Nearest wall within `maxDist` of a floor point, with the point's
    /// position along it.
    static func nearestWall(_ p: SIMD2<Float>, in walls: [WallSegment], maxDist: Float = 0.35) -> (index: Int, t: Float)? {
        var best: (Int, Float)?
        var bestD = maxDist
        for (i, w) in walls.enumerated() {
            let d = w.b - w.a
            let len2 = simd_length_squared(d)
            guard len2 > 0 else { continue }
            let k = simd_dot(p - w.a, d) / len2
            guard k > -0.1, k < 1.1 else { continue }
            let dist = simd_distance(p, w.a + d * simd_clamp(k, 0, 1))
            if dist < bestD {
                bestD = dist
                best = (i, k * sqrt(len2))
            }
        }
        return best
    }
}
