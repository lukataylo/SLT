import Foundation
import simd

/// The coloured LiDAR points this phone has captured, kept in batches (its
/// own ARKit frame) so the 3D card can append them without rebuilding.
final class LocalCloud {
    private(set) var batches: [MeshProcessor.ColouredPoints] = []
    private(set) var count = 0
    static let maxPoints = 200_000

    func append(_ batch: MeshProcessor.ColouredPoints) {
        let n = batch.points.count / 3
        guard n > 0, count + n <= Self.maxPoints else { return }
        batches.append(batch)
        count += n
    }

    func clear() {
        batches = []
        count = 0
    }
}
