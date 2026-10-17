import Foundation
import simd

// Mirrors shared/protocol.js: JSON text messages, and binary video frames as
// [u16 metaLen big-endian][meta JSON][JPEG bytes].
enum Wire {
    static func frame(meta: [String: Any], jpeg: Data) -> Data? {
        guard let metaData = try? JSONSerialization.data(withJSONObject: meta), metaData.count <= 0xFFFF else { return nil }
        var out = Data([UInt8(metaData.count >> 8), UInt8(metaData.count & 0xFF)])
        out.append(metaData)
        out.append(jpeg)
        return out
    }

    static func text(_ message: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// Camera pose in this phone's ARKit frame. ARKit and three.js agree on axes
/// (right-handed, Y up, camera looks down -Z), so no conversion is needed;
/// the server maps it into the shared floor plan.
struct Pose {
    var position: SIMD3<Float>
    var orientation: simd_quatf
    var vfov: Float
    var aspect: Float

    init(transform: simd_float4x4, vfov: Float, aspect: Float) {
        position = SIMD3(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
        orientation = simd_quatf(transform)
        self.vfov = vfov
        self.aspect = aspect
    }

    var json: [String: Any] {
        let q = orientation.vector
        return [
            "p": [position.x, position.y, position.z].map(Double.init),
            "q": [q.x, q.y, q.z, q.w].map(Double.init),
            "fov": Double(vfov),
            "aspect": Double(aspect),
        ]
    }
}
