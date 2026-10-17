import ARKit
import CoreImage
import Foundation

/// Runs ARKit world tracking with LiDAR plane detection and scene
/// reconstruction, and turns frames into what the relay wants: poses, JPEG
/// frames, the vectorised local scan (walls, doors/windows, floor) and a
/// LiDAR point cloud.
final class ARCapture: NSObject, ObservableObject, ARSessionDelegate {
    @Published private(set) var tracking = "STARTING"
    @Published private(set) var hasLiDAR = false
    /// This phone's scan in its own ARKit frame: shown before alignment, and
    /// sent to the server for alignment and the shared map.
    @Published private(set) var scan = LocalScan()
    @Published private(set) var localMark: Mark?

    let session = ARSession()
    var onPose: ((Pose) -> Void)?
    var onFrame: ((Pose, Data) -> Void)?
    var onScan: ((LocalScan) -> Void)?
    var onCloud: (([Float]) -> Void)?

    private static let poseInterval: TimeInterval = 1.0 / 15
    private static let frameInterval: TimeInterval = 1.0 / 8
    private static let scanInterval: TimeInterval = 1.0
    private static let meshInterval: TimeInterval = 2.5
    private static let captureWidth: CGFloat = 480

    private var lastPose: TimeInterval = 0
    private var lastFrame: TimeInterval = 0
    private var lastScan: TimeInterval = 0
    private var lastMesh: TimeInterval = 0
    private var encoding = false
    private var meshOpenings: [Opening] = []
    private let mesh = MeshProcessor()
    private let encodeQueue = DispatchQueue(label: "slt.jpeg", qos: .userInitiated)
    private let ciContext = CIContext()

    private lazy var configuration: ARWorldTrackingConfiguration = {
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = .gravity
        config.planeDetection = [.horizontal, .vertical]
        // The classified mesh finds doors and windows and feeds the point cloud.
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
            config.sceneReconstruction = .meshWithClassification
        }
        return config
    }()

    func start() {
        hasLiDAR = ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification)
        session.delegate = self
        session.run(configuration)
    }

    func pause() {
        session.pause()
    }

    /// Clears what this phone has scanned. A room reset keeps tracking (and so
    /// the alignment); a map reset restarts tracking too.
    func reset(restartTracking: Bool) {
        var options: ARSession.RunOptions = [.removeExistingAnchors]
        if restartTracking { options.insert(.resetTracking) }
        session.run(configuration, options: options)
        mesh.reset()
        meshOpenings = []
        scan = LocalScan()
        lastScan = 0
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
        if now - lastScan >= Self.scanInterval {
            lastScan = now
            var next = WallExtractor.extract(from: frame.anchors)
            next.openings += meshOpenings.filter { m in !next.openings.contains { $0.kind == m.kind && simd_distance(($0.a + $0.b) / 2, (m.a + m.b) / 2) < 0.5 } }
            scan = next
            onScan?(next)
        }
        if hasLiDAR && now - lastMesh >= Self.meshInterval {
            lastMesh = now
            mesh.process(MeshProcessor.snapshot(frame.anchors), walls: scan.walls) { [weak self] openings, points in
                self?.meshOpenings = openings
                if !points.isEmpty { self?.onCloud?(points) }
            }
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
