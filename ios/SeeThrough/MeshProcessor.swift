import ARKit
import simd

/// Works on copies of the LiDAR mesh off the main thread:
/// - finds doors and windows from ARKit's per-face mesh classification and
///   snaps them onto the phone's merged walls;
/// - samples the mesh into a 10 cm voxel point cloud, returning only voxels
///   not sent before.
final class MeshProcessor {
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
    }

    private let queue = DispatchQueue(label: "slt.mesh", qos: .utility)
    private var sentVoxels = Set<SIMD3<Int32>>()
    private var busy = false
    private static let voxel: Float = 0.1
    private static let maxNewPoints = 6000

    /// ARKit reuses mesh buffers, so copy them while still on the delegate queue.
    static func snapshot(_ anchors: [ARAnchor]) -> [Snapshot] {
        anchors.compactMap { $0 as? ARMeshAnchor }.map { anchor in
            let g = anchor.geometry
            let v = g.vertices, f = g.faces, c = g.classification
            return Snapshot(
                transform: anchor.transform,
                vertices: Data(bytes: v.buffer.contents(), count: v.buffer.length),
                vertexCount: v.count, vertexStride: v.stride, vertexOffset: v.offset,
                faces: Data(bytes: f.buffer.contents(), count: f.count * f.indexCountPerPrimitive * f.bytesPerIndex),
                faceCount: f.count, bytesPerIndex: f.bytesPerIndex,
                classes: c.map { Data(bytes: $0.buffer.contents(), count: $0.buffer.length) },
                classStride: c?.stride ?? 1, classOffset: c?.offset ?? 0
            )
        }
    }

    func reset() {
        queue.async { self.sentVoxels.removeAll() }
    }

    /// Calls back on the main queue. Skips if the previous pass is still running.
    func process(_ meshes: [Snapshot], walls: [WallSegment], completion: @escaping (_ openings: [Opening], _ newPoints: [Float]) -> Void) {
        guard !busy else { return }
        busy = true
        queue.async {
            let openings = Self.openings(meshes, walls: walls)
            let points = self.newCloudPoints(meshes)
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

    private func newCloudPoints(_ meshes: [Snapshot]) -> [Float] {
        var out: [Float] = []
        for m in meshes {
            for i in 0..<m.vertexCount {
                let p = Self.vertex(m, i)
                let key = SIMD3<Int32>(Int32((p.x / Self.voxel).rounded()), Int32((p.y / Self.voxel).rounded()), Int32((p.z / Self.voxel).rounded()))
                guard !sentVoxels.contains(key) else { continue }
                sentVoxels.insert(key)
                out += [p.x, p.y, p.z]
                if out.count >= Self.maxNewPoints * 3 { return out }
            }
        }
        return out
    }
}
