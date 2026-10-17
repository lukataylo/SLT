import ARKit
import simd

/// Works on copies of the LiDAR mesh off the main thread:
/// - finds doors and windows from ARKit's per-face mesh classification and
///   snaps them onto the phone's merged walls;
/// - samples the mesh into a 5 cm voxel splat cloud, coloured from the camera
///   image and carrying surface normals, returning only voxels not sent before.
final class MeshProcessor {
    /// The camera image and LiDAR depth for one frame, used to colour points.
    struct FrameSample {
        var image: CVPixelBuffer // 420f YCbCr, sensor orientation
        var depth: CVPixelBuffer? // Float32 metres, lower resolution
        var cameraTransform: simd_float4x4
        var intrinsics: simd_float3x3
        var resolution: CGSize
    }

    struct ColouredPoints {
        var points: [Float] = []
        var colors: [UInt8] = []
        var normals: [Int8] = []
        var isEmpty: Bool { points.isEmpty }
    }

    struct Snapshot {
        var transform: simd_float4x4
        var vertices: Data
        var vertexCount: Int
        var vertexStride: Int
        var vertexOffset: Int
        var faces: Data
        var faceCount: Int
        var bytesPerIndex: Int
        var classes: Data?
        var classStride: Int
        var classOffset: Int
        var normals: Data
        var normalStride: Int
        var normalOffset: Int
    }

    private let queue = DispatchQueue(label: "slt.mesh", qos: .utility)
    private var sentVoxels = Set<SIMD3<Int32>>()
    private var busy = false
    private static let voxel: Float = 0.05
    private static let maxNewPoints = 6000
    private static let maxRange: Float = 4.5 // metres; colour gets unreliable beyond

    /// ARKit reuses mesh buffers, so copy them while still on the delegate queue.
    static func snapshot(_ anchors: [ARAnchor]) -> [Snapshot] {
        anchors.compactMap { $0 as? ARMeshAnchor }.map { anchor in
            let g = anchor.geometry
            let v = g.vertices, f = g.faces, c = g.classification, n = g.normals
            return Snapshot(
                transform: anchor.transform,
                vertices: Data(bytes: v.buffer.contents(), count: v.buffer.length),
                vertexCount: v.count, vertexStride: v.stride, vertexOffset: v.offset,
                faces: Data(bytes: f.buffer.contents(), count: f.count * f.indexCountPerPrimitive * f.bytesPerIndex),
                faceCount: f.count, bytesPerIndex: f.bytesPerIndex,
                classes: c.map { Data(bytes: $0.buffer.contents(), count: $0.buffer.length) },
                classStride: c?.stride ?? 1, classOffset: c?.offset ?? 0,
                normals: Data(bytes: n.buffer.contents(), count: n.buffer.length),
                normalStride: n.stride, normalOffset: n.offset
            )
        }
    }

    func reset() {
        queue.async { self.sentVoxels.removeAll() }
    }

    /// Calls back on the main queue. Skips if the previous pass is still running.
    func process(_ meshes: [Snapshot], walls: [WallSegment], frame: FrameSample?,
                 completion: @escaping (_ openings: [Opening], _ newPoints: ColouredPoints) -> Void) {
        guard !busy else { return }
        busy = true
        queue.async {
            let openings = Self.openings(meshes, walls: walls)
            let points = frame.map { self.newCloudPoints(meshes, frame: $0) } ?? ColouredPoints()
            DispatchQueue.main.async {
                self.busy = false
                completion(openings, points)
            }
        }
    }

    private static func vertex(_ m: Snapshot, _ i: Int) -> SIMD3<Float> {
        m.vertices.withUnsafeBytes { raw in
            let base = m.vertexOffset + i * m.vertexStride
            let p = SIMD3(raw.load(fromByteOffset: base, as: Float.self),
                          raw.load(fromByteOffset: base + 4, as: Float.self),
                          raw.load(fromByteOffset: base + 8, as: Float.self))
            let w = m.transform * SIMD4(p, 1)
            return SIMD3(w.x, w.y, w.z)
        }
    }

    private static func index(_ m: Snapshot, _ i: Int) -> Int {
        m.faces.withUnsafeBytes { raw in
            m.bytesPerIndex == 4 ? Int(raw.load(fromByteOffset: i * 4, as: UInt32.self)) : Int(raw.load(fromByteOffset: i * 2, as: UInt16.self))
        }
    }

    private static func openings(_ meshes: [Snapshot], walls: [WallSegment]) -> [Opening] {
        guard !walls.isEmpty else { return [] }
        // (kind, wall) -> samples of (position along wall, height)
        var groups: [String: [(t: Float, y: Float)]] = [:]
        for m in meshes {
            guard let classes = m.classes else { continue }
            classes.withUnsafeBytes { raw in
                for face in 0..<m.faceCount {
                    let cls = raw.load(fromByteOffset: m.classOffset + face * m.classStride, as: UInt8.self)
                    let kind: String
                    switch ARMeshClassification(rawValue: Int(cls)) {
                    case .door: kind = "door"
                    case .window: kind = "window"
                    default: continue
                    }
                    let c = (vertex(m, index(m, face * 3)) + vertex(m, index(m, face * 3 + 1)) + vertex(m, index(m, face * 3 + 2))) / 3
                    guard let hit = FloorGeometry.nearestWall(SIMD2(c.x, c.z), in: walls) else { continue }
                    groups["\(kind)|\(hit.index)", default: []].append((hit.t, c.y))
                }
            }
        }
        var out: [Opening] = []
        for (key, samples) in groups {
            let parts = key.split(separator: "|")
            let kind = String(parts[0]), w = walls[Int(parts[1])!]
            let u = simd_normalize(w.b - w.a)
            // Split along the wall wherever classified faces leave a gap.
            var cluster: [(t: Float, y: Float)] = []
            func flush() {
                defer { cluster.removeAll() }
                guard cluster.count >= 12, let t0 = cluster.first?.t, let t1 = cluster.last?.t, t1 - t0 >= 0.4 else { return }
                let ys = cluster.map(\.y)
                out.append(Opening(kind: kind, a: w.a + u * t0, b: w.a + u * t1, y0: ys.min()!, y1: ys.max()!))
            }
            for s in samples.sorted(by: { $0.t < $1.t }) {
                if let last = cluster.last, s.t - last.t > 0.4 { flush() }
                cluster.append(s)
            }
            flush()
        }
        return out
    }

    /// Mesh vertices the camera can see right now, coloured from its image.
    /// Points hidden behind something nearer (per the LiDAR depth map) or out
    /// of view stay unsent until a later frame sees them.
    private func newCloudPoints(_ meshes: [Snapshot], frame: FrameSample) -> ColouredPoints {
        var out = ColouredPoints()
        let image = frame.image
        CVPixelBufferLockBaseAddress(image, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
        if let depth = frame.depth { CVPixelBufferLockBaseAddress(depth, .readOnly) }
        defer { if let depth = frame.depth { CVPixelBufferUnlockBaseAddress(depth, .readOnly) } }
        guard CVPixelBufferGetPlaneCount(image) >= 2,
              let yBase = CVPixelBufferGetBaseAddressOfPlane(image, 0),
              let cBase = CVPixelBufferGetBaseAddressOfPlane(image, 1) else { return out }
        let width = CVPixelBufferGetWidthOfPlane(image, 0), height = CVPixelBufferGetHeightOfPlane(image, 0)
        let yRow = CVPixelBufferGetBytesPerRowOfPlane(image, 0), cRow = CVPixelBufferGetBytesPerRowOfPlane(image, 1)
        let sx = Float(width) / Float(frame.resolution.width), sy = Float(height) / Float(frame.resolution.height)
        let fx = frame.intrinsics[0][0], fy = frame.intrinsics[1][1]
        let cx = frame.intrinsics[2][0], cy = frame.intrinsics[2][1]
        let toCamera = frame.cameraTransform.inverse
        let cameraPos = SIMD3(frame.cameraTransform.columns.3.x, frame.cameraTransform.columns.3.y, frame.cameraTransform.columns.3.z)

        let depthInfo = frame.depth.flatMap { d -> (UnsafeRawPointer, Int, Int, Int)? in
            guard let base = CVPixelBufferGetBaseAddress(d) else { return nil }
            return (UnsafeRawPointer(base), CVPixelBufferGetWidth(d), CVPixelBufferGetHeight(d), CVPixelBufferGetBytesPerRow(d))
        }

        for m in meshes {
            let anchorPos = SIMD3(m.transform.columns.3.x, m.transform.columns.3.y, m.transform.columns.3.z)
            guard simd_distance(anchorPos, cameraPos) < Self.maxRange + 3 else { continue }
            let rotation = simd_float3x3(SIMD3(m.transform.columns.0.x, m.transform.columns.0.y, m.transform.columns.0.z),
                                         SIMD3(m.transform.columns.1.x, m.transform.columns.1.y, m.transform.columns.1.z),
                                         SIMD3(m.transform.columns.2.x, m.transform.columns.2.y, m.transform.columns.2.z))
            for i in 0..<m.vertexCount {
                let p = Self.vertex(m, i)
                let key = SIMD3<Int32>(Int32((p.x / Self.voxel).rounded()), Int32((p.y / Self.voxel).rounded()), Int32((p.z / Self.voxel).rounded()))
                guard !sentVoxels.contains(key) else { continue }

                // ARKit camera space: x right, y up, looking down -z.
                let c = toCamera * SIMD4(p, 1)
                let dist = -c.z
                guard dist > 0.15, dist < Self.maxRange else { continue }
                let u = fx * c.x / dist + cx, v = fy * -c.y / dist + cy
                guard u >= 0, v >= 0, u < Float(frame.resolution.width) - 1, v < Float(frame.resolution.height) - 1 else { continue }

                if let (base, dw, dh, row) = depthInfo {
                    let du = min(dw - 1, Int(u / Float(frame.resolution.width) * Float(dw)))
                    let dv = min(dh - 1, Int(v / Float(frame.resolution.height) * Float(dh)))
                    let measured = base.load(fromByteOffset: dv * row + du * 4, as: Float32.self)
                    guard measured.isFinite, abs(measured - dist) < 0.08 + 0.03 * dist else { continue }
                }

                let px = min(width - 1, Int(u * sx)), py = min(height - 1, Int(v * sy))
                let Y = Float(yBase.load(fromByteOffset: py * yRow + px, as: UInt8.self))
                let chroma = (py / 2) * cRow + (px / 2) * 2
                let cb = Float(cBase.load(fromByteOffset: chroma, as: UInt8.self)) - 128
                let cr = Float(cBase.load(fromByteOffset: chroma + 1, as: UInt8.self)) - 128
                let rgb = [Y + 1.402 * cr, Y - 0.344136 * cb - 0.714136 * cr, Y + 1.772 * cb]
                    .map { UInt8(max(0, min(255, $0.rounded()))) }

                let nLocal = m.normals.withUnsafeBytes { raw -> SIMD3<Float> in
                    let o = m.normalOffset + i * m.normalStride
                    return SIMD3(raw.load(fromByteOffset: o, as: Float.self), raw.load(fromByteOffset: o + 4, as: Float.self), raw.load(fromByteOffset: o + 8, as: Float.self))
                }
                let len = simd_length(nLocal)
                let n = len > 0 ? simd_normalize(rotation * nLocal) : .zero

                sentVoxels.insert(key)
                out.points += [p.x, p.y, p.z]
                out.colors += rgb
                out.normals += [n.x, n.y, n.z].map { Int8(max(-127, min(127, ($0 * 127).rounded()))) }
                if out.points.count >= Self.maxNewPoints * 3 { return out }
            }
        }
        return out
    }
}
