import ARKit
import CoreImage
import Foundation

/// Runs ARKit world tracking with LiDAR plane detection and turns each frame
/// into the three things the relay wants: poses, JPEG frames and walls.
final class ARCapture: NSObject, ObservableObject, ARSessionDelegate {
    @Published private(set) var tracking = "STARTING"
    @Published private(set) var wallCount = 0
    @Published private(set) var floorFound = false
    @Published private(set) var hasLiDAR = false
    /// This phone's walls and position in its own ARKit frame, for the map
    /// card before (or without) a server alignment.
    @Published private(set) var localWalls: [[Float]] = []
    @Published private(set) var localMark: Mark?

    let session = ARSession()
    var onPose: ((Pose) -> Void)?
    var onFrame: ((Pose, Data) -> Void)?
    var onPlanes: (([[Float]], Float?) -> Void)?

    private static let poseInterval: TimeInterval = 1.0 / 15
    private static let frameInterval: TimeInterval = 1.0 / 8
    private static let planesInterval: TimeInterval = 1.0
    private static let captureWidth: CGFloat = 480

    private var lastPose: TimeInterval = 0
    private var lastFrame: TimeInterval = 0
    private var lastPlanes: TimeInterval = 0
    private var encoding = false
    private let encodeQueue = DispatchQueue(label: "slt.jpeg", qos: .userInitiated)
    private let ciContext = CIContext()

    func start() {
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity
        config.planeDetection = [.horizontal, .vertical]
        // The reconstructed mesh is only drawn as scanning feedback; walls come
        // from plane anchors, which LiDAR makes fast and accurate.
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
            config.sceneReconstruction = .meshWithClassification
            hasLiDAR = true
        }
        session.delegate = self
        session.run(config)
    }

    func pause() {
        session.pause()
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard case .normal = frame.camera.trackingState else { return }
        let now = frame.timestamp
        let pose = Self.pose(of: frame)

        if now - lastPose >= Self.poseInterval {
            lastPose = now
            localMark = Mark(position: pose.position, orientation: pose.orientation)
            onPose?(pose)
        }
        if now - lastPlanes >= Self.planesInterval {
            lastPlanes = now
            let (walls, floorY) = WallExtractor.extract(from: frame.anchors)
            wallCount = walls.count
            localWalls = walls
            floorFound = floorY != nil
            onPlanes?(walls, floorY)
        }
        // Encode off the main thread, at most one frame at a time, so ARKit
        // never has to hold back more than one camera buffer for us.
        if now - lastFrame >= Self.frameInterval && !encoding {
            lastFrame = now
            encoding = true
            let image = CIImage(cvPixelBuffer: frame.capturedImage)
            encodeQueue.async { [weak self] in
                guard let self else { return }
                let jpeg = self.jpeg(image)
                DispatchQueue.main.async {
                    self.encoding = false
                    if let jpeg { self.onFrame?(pose, jpeg) }
                }
            }
        }
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        switch camera.trackingState {
        case .normal: tracking = "TRACKING"
        case .notAvailable: tracking = "NO TRACKING"
        case .limited(let reason):
            switch reason {
            case .initializing, .relocalizing: tracking = "INITIALISING"
            case .excessiveMotion: tracking = "SLOW DOWN"
            case .insufficientFeatures: tracking = "MORE LIGHT"
            @unknown default: tracking = "LIMITED"
            }
        }
    }

    /// The captured image is in sensor (landscape) orientation, and so is
    /// `camera.transform`, so the pair describes the same view.
    private static func pose(of frame: ARFrame) -> Pose {
        let camera = frame.camera
        let fy = camera.intrinsics[1][1]
        let size = camera.imageResolution
        let vfov = 2 * atan(Float(size.height) / (2 * fy)) * 180 / .pi
        return Pose(transform: camera.transform, vfov: vfov, aspect: Float(size.width / size.height))
    }

    private func jpeg(_ image: CIImage) -> Data? {
        let scale = Self.captureWidth / image.extent.width
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let options = [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.6]
        return ciContext.jpegRepresentation(of: scaled, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, options: options)
    }
}
