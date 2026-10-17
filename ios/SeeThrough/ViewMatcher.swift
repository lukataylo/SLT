import CoreGraphics
import Foundation
import simd

/// Which way is this phone facing on the map? Found by matching the camera
/// against the room's wall reference photos (one per wall direction, taken
/// while the room was scanned, each with its heading on the map).
///
/// Each image is resampled onto a gravity-aligned angular grid (a
/// "viewprint"): columns step in yaw away from the camera's own heading, rows
/// are absolute pitch. ARKit knows which way is up, so two views of the same
/// wall then line up by a pure sideways shift, whatever the phones' roll or
/// lenses. The shift that matches best gives the heading.
///
/// Conventions as ARKit: camera looks down -Z, Y up; yaw 0 looks down -Z and
/// positive yaw turns left.
enum ViewMatcher {
    static let cell: Float = 1.5 * .pi / 180
    static let halfCols = Int((40 / 1.5).rounded())
    static let halfRows = Int((36 / 1.5).rounded())
    static let cols = 2 * halfCols + 1
    static let rows = 2 * halfRows + 1
    /// Looking much further up or down leaves the heading ill-defined.
    static let maxPitch: Float = 60 * .pi / 180
    /// Of the camera view's cells, how much must overlap a reference: a thin
    /// sliver of overlap correlates well by chance.
    static let minOverlapFraction: Float = 0.4

    struct Print {
        /// The camera's heading in the frame its orientation was given in.
        var yaw: Float
        /// rows × cols, NaN outside the image; high-passed and normalised.
        var cells: [Float]
        var valid: Int { cells.reduce(0) { $1.isNaN ? $0 : $0 + 1 } }
    }

    struct Reference {
        var id: String
        var roomId: String
        var print: Print
    }

    struct Match {
        var reference: Reference
        var score: Float
        /// Add to the query's own heading to get its heading on the map.
        var offset: Float
        var queryYaw: Float
    }

    static func yaw(of q: simd_quatf) -> Float {
        let f = q.act(SIMD3<Float>(0, 0, -1))
        return atan2(-f.x, -f.z)
    }

    static func pitch(of q: simd_quatf) -> Float {
        asin(min(1, max(-1, q.act(SIMD3<Float>(0, 0, -1)).y)))
    }

    static func wrap(_ a: Float) -> Float { atan2(sin(a), cos(a)) }

    // MARK: viewprints

    /// Resamples a grayscale image (row-major `width` × `height`) seen with
    /// orientation `q` (camera to world), vertical field of view `vfov`
    /// (radians). Nil when the camera points too steeply up or down.
    static func print(gray: [Float], width w: Int, height h: Int, orientation q: simd_quatf, vfov: Float, aspect: Float? = nil) -> Print? {
        guard abs(pitch(of: q)) <= maxPitch, w > 1, h > 1 else { return nil }
        let yaw = yaw(of: q)
        let inv = q.inverse
        let tanV = tan(vfov / 2)
        let tanH = tanV * (aspect ?? Float(w) / Float(h))
        var raw = [Float](repeating: .nan, count: rows * cols)
        for r in 0 ..< rows {
            let p = Float(halfRows - r) * cell
            for c in 0 ..< cols {
                let a = yaw + Float(c - halfCols) * cell
                let d = inv.act(SIMD3(-sin(a) * cos(p), sin(p), -cos(a) * cos(p)))
                guard d.z < -1e-3 else { continue }
                let xn = d.x / -d.z / tanH, yn = d.y / -d.z / tanV
                guard abs(xn) <= 1, abs(yn) <= 1 else { continue }
                raw[r * cols + c] = bilinear(gray, w, h, (xn + 1) / 2 * Float(w) - 0.5, (1 - yn) / 2 * Float(h) - 0.5)
            }
        }
        return Print(yaw: yaw, cells: normalise(highPass(raw)))
    }

    private static func bilinear(_ img: [Float], _ w: Int, _ h: Int, _ u: Float, _ v: Float) -> Float {
        let x0 = max(0, min(w - 1, Int(u.rounded(.down)))), y0 = max(0, min(h - 1, Int(v.rounded(.down))))
        let x1 = min(w - 1, x0 + 1), y1 = min(h - 1, y0 + 1)
        let fx = max(0, min(1, u - Float(x0))), fy = max(0, min(1, v - Float(y0)))
        let top = img[y0 * w + x0] * (1 - fx) + img[y0 * w + x1] * fx
        let bottom = img[y1 * w + x0] * (1 - fx) + img[y1 * w + x1] * fx
        return top * (1 - fy) + bottom * fy
    }

    /// Subtracts a local mean (5×5 cells), leaving edges and texture, so
    /// lighting and exposure matter less than structure.
    private static func highPass(_ raw: [Float]) -> [Float] {
        var out = [Float](repeating: .nan, count: raw.count)
        for r in 0 ..< rows {
            for c in 0 ..< cols where !raw[r * cols + c].isNaN {
                var sum: Float = 0, n: Float = 0
                for rr in max(0, r - 2) ... min(rows - 1, r + 2) {
                    for cc in max(0, c - 2) ... min(cols - 1, c + 2) where !raw[rr * cols + cc].isNaN {
                        sum += raw[rr * cols + cc]
                        n += 1
                    }
                }
                out[r * cols + c] = raw[r * cols + c] - sum / n
            }
        }
        return out
    }

    private static func normalise(_ cells: [Float]) -> [Float] {
        let valid = cells.filter { !$0.isNaN }
        guard !valid.isEmpty else { return cells }
        let n = Float(valid.count)
        let mean = valid.reduce(0, +) / n
        var squares: Float = 0
        for v in valid { squares += (v - mean) * (v - mean) }
        let sd = sqrt(max(squares / n, 1e-12))
        return cells.map { $0.isNaN ? $0 : ($0 - mean) / sd }
    }

    // MARK: matching

    /// Best sideways shift of `query` against `key`: the score (correlation,
    /// discounted where little of the view overlaps) and the shift in cells.
    /// Every other shift first, then the best one's neighbours.
    static func match(_ query: Print, _ key: Print, maxShift: Int = 24) -> (score: Float, shift: Int)? {
        let queryCells = Float(max(query.valid, 1))
        var best: (score: Float, shift: Int)?
        func consider(_ s: Int) {
            guard abs(s) <= maxShift, let c = correlation(query, key, shift: s) else { return }
            let overlap = Float(c.overlap) / queryCells
            guard overlap >= minOverlapFraction else { return }
            let score = c.score * min(1, (overlap / 0.7).squareRoot())
            if best == nil || score > best!.score { best = (score, s) }
        }
        for s in stride(from: -maxShift, through: maxShift, by: 2) { consider(s) }
        if let b = best { consider(b.shift - 1); consider(b.shift + 1) }
        return best
    }

    private static func correlation(_ query: Print, _ key: Print, shift s: Int) -> (score: Float, overlap: Int)? {
        var n: Float = 0, sa: Float = 0, sb: Float = 0, saa: Float = 0, sbb: Float = 0, sab: Float = 0
        for r in 0 ..< rows {
            let row = r * cols
            for c in max(0, -s) ..< min(cols, cols - s) {
                let a = query.cells[row + c], b = key.cells[row + c + s]
                if a.isNaN || b.isNaN { continue }
                n += 1; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b
            }
        }
        guard n >= 50 else { return nil }
        let cov = sab / n - (sa / n) * (sb / n)
        let va = saa / n - (sa / n) * (sa / n), vb = sbb / n - (sb / n) * (sb / n)
        return (cov / sqrt(max(va * vb, 1e-12)), Int(n))
    }

    /// Matches one camera view against every reference; best first.
    static func locate(_ query: Print, in references: [Reference], top: Int = 5) -> [Match] {
        references.compactMap { ref -> Match? in
            guard let m = match(query, ref.print) else { return nil }
            let mapYaw = ref.print.yaw + Float(m.shift) * cell
            return Match(reference: ref, score: m.score, offset: wrap(mapYaw - query.yaw), queryYaw: query.yaw)
        }
        .sorted { $0.score > $1.score }
        .prefix(top)
        .map { $0 }
    }

    // MARK: voting

    /// Commits to a heading only once several views agree. ARKit's own
    /// heading is steady, so each vote is directly comparable: "own heading
    /// + offset = map heading". Votes must come from two different reference
    /// photos, or (if the phone only sees one wall) from five views spread
    /// over at least 10° of the phone's own turning.
    struct Vote {
        var minScore: Float = 0.45
        var margin: Float = 0.05
        var agree: Float = 8 * .pi / 180
        var keep = 10
        private(set) var votes: [Match] = []

        init() {}

        mutating func add(_ matches: [Match]) -> (offset: Float, roomId: String)? {
            guard let best = matches.first, best.score >= minScore else { return nil }
            // A repetitive room fits several headings: skip views that can't tell.
            if let rival = matches.dropFirst().first(where: { abs(wrap($0.offset - best.offset)) > 3 * agree }),
               best.score - rival.score < margin { return nil }
            votes.append(best)
            if votes.count > keep { votes.removeFirst() }
            return result()
        }

        func result() -> (offset: Float, roomId: String)? {
            var group: [Match] = []
            for v in votes {
                let g = votes.filter { abs(wrap($0.offset - v.offset)) <= agree }
                if g.count > group.count { group = g }
            }
            guard group.count >= 3 else { return nil }
            if Set(group.map(\.reference.id)).count < 2 {
                let yaws = group.map(\.queryYaw)
                let spread = yaws.map { y in yaws.map { abs(ViewMatcher.wrap($0 - y)) }.max() ?? 0 }.max() ?? 0
                guard group.count >= 5, spread >= 10 * .pi / 180 else { return nil }
            }
            let offset = atan2(group.reduce(0) { $0 + sin($1.offset) }, group.reduce(0) { $0 + cos($1.offset) })
            return (offset, group[0].reference.roomId)
        }

        mutating func reset() { votes = [] }
    }

    // MARK: images

    /// A grayscale copy of an image, `width` pixels wide.
    static func gray(_ image: CGImage, width: Int = 96) -> (gray: [Float], width: Int, height: Int)? {
        let h = max(1, Int((Float(width) * Float(image.height) / Float(image.width)).rounded()))
        var pixels = [UInt8](repeating: 0, count: width * h)
        let ok = pixels.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: width, height: h, bitsPerComponent: 8, bytesPerRow: width,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: h))
            return true
        }
        return ok ? (pixels.map(Float.init), width, h) : nil
    }
}
