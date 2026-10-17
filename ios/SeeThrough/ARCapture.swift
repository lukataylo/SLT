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
    /// Coloured points captured so far (own frame), for the 3D card.
    let cloud = LocalCloud()
    @Published private(set) var cloudVersion = 0

    let session = ARSession()
    var onPose: ((Pose) -> Void)?
    var onFrame: ((Pose, Data) -> Void)?
    var onScan: ((LocalScan) -> Void)?
    var onCloud: ((MeshProcessor.ColouredPoints) -> Void)?
    /// ARKit collaboration data to send to the other phones.
    var onCollaboration: ((Data) -> Void)?
    /// Another phone's map-origin anchor arrived through collaboration: this
    /// is where the shared map sits in our frame.
    var onPeerMapOrigin: ((FloorTransform) -> Void)?
    /// How many other phones ARKit has merged with.
    @Published private(set) var participants = 0

    /// What to send: video only while seeing through, colour points only
    /// while scanning (set by the app's mode and settings).
    var sendFrames = false
    var sendCloud = false
    /// Latest camera pose in our frame, for placing a displayed pairing code.
    private(set) var cameraTransform = matrix_identity_float4x4

    /// While pairing by QR: read codes from frames, then track the matching
    /// image so ARKit measures its pose.
    var detectQR = false
    var onQRPayload: ((PairingPayload) -> Void)?
    var onCodePose: ((simd_float4x4) -> Void)?
    private var lastQRCheck: TimeInterval = 0
    private var detecting = false
    private let visionQueue = DispatchQueue(label: "slt.qr", qos: .userInitiated)
    private var mapAnchor: ARAnchor?
    private static let mapAnchorName = "slt-map"


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
        // Phones that see the same place merge their maps (relayed via our
        // server), which is how they pair into one coordinate space.
        config.isCollaborationEnabled = true
        config.planeDetection = [.horizontal, .vertical]
        // The classified mesh finds doors and windows and feeds the point cloud.
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.meshWithClassification) {
            config.sceneReconstruction = .meshWithClassification
        }
        // LiDAR depth tells which mesh points the camera really sees, so wall
        // colours don't bleed onto whatever is behind them.
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
            config.frameSemantics.insert(.sceneDepth)
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
        mapAnchor = nil
        mesh.reset()
        cloud.clear()
        cloudVersion += 1
        meshOpenings = []
        scan = LocalScan()
        lastScan = 0
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        cameraTransform = frame.camera.transform
        let now = frame.timestamp
        if detectQR && !detecting && now - lastQRCheck > 0.3 {
            lastQRCheck = now
            detecting = true
            let buffer = frame.capturedImage
            visionQueue.async { [weak self] in
                let payload = QRPairing.detect(in: buffer)
                DispatchQueue.main.async {
                    self?.detecting = false
                    if let payload, self?.detectQR == true { self?.onQRPayload?(payload) }
                }
            }
        }
        guard case .normal = frame.camera.trackingState else { return }
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
            let sample = MeshProcessor.FrameSample(
                image: frame.capturedImage,
                depth: frame.sceneDepth?.depthMap,
                cameraTransform: frame.camera.transform,
                intrinsics: frame.camera.intrinsics,
                resolution: frame.camera.imageResolution
            )
            mesh.process(MeshProcessor.snapshot(frame.anchors), walls: scan.walls, frame: sample) { [weak self] openings, points in
                guard let self else { return }
                self.meshOpenings = openings
                guard !points.isEmpty else { return }
                self.cloud.append(points)
                self.cloudVersion += 1
                if self.sendCloud { self.onCloud?(points) }
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
                    if let jpeg, self.sendFrames { self.onFrame?(pose, jpeg) }
                }
            }
        }
    }

    // MARK: pairing

    func session(_ session: ARSession, didOutputCollaborationData data: ARSession.CollaborationData) {
        guard let encoded = try? NSKeyedArchiver.archivedData(withRootObject: data, requiringSecureCoding: true) else { return }
        onCollaboration?(encoded)
    }

    func receiveCollaboration(_ data: Data) {
        guard let collab = try? NSKeyedUnarchiver.unarchivedObject(ofClass: ARSession.CollaborationData.self, from: data) else { return }
        session.update(with: collab)
    }

    /// Shares where the map origin is in our frame, as an anchor that ARKit
    /// syncs to merged phones. `alignment` takes our frame into the map.
    func publishMapOrigin(_ alignment: FloorTransform) {
        let transform = alignment.matrix.inverse
        if let old = mapAnchor {
            let moved = simd_distance(old.transform.columns.3, transform.columns.3)
            if moved < 0.05 && abs(FloorTransform(matrix: old.transform).yaw - FloorTransform(matrix: transform).yaw) < 0.02 { return }
            session.remove(anchor: old)
        }
        let anchor = ARAnchor(name: Self.mapAnchorName, transform: transform)
        session.add(anchor: anchor)
        mapAnchor = anchor
    }

    /// Start measuring a pairing code we've read: ARKit tracks it as an image.
    func track(_ reference: ARReferenceImage) {
        configuration.detectionImages = [reference]
        configuration.maximumNumberOfTrackedImages = 1
        session.run(configuration)
    }

    func stopTrackingCodes() {
        guard !(configuration.detectionImages ?? []).isEmpty else { return }
        configuration.detectionImages = []
        session.run(configuration)
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { handlePeerAnchors(anchors) }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { handlePeerAnchors(anchors) }

    private func handlePeerAnchors(_ anchors: [ARAnchor]) {
        for case let image as ARImageAnchor in anchors where image.isTracked { onCodePose?(image.transform) }
        participants = session.currentFrame?.anchors.filter { $0 is ARParticipantAnchor }.count ?? participants
        for anchor in anchors where anchor.name == Self.mapAnchorName && anchor.sessionIdentifier != session.identifier {
            // The anchor is the map origin expressed in our frame, so its
            // inverse takes our frame into the map.
            onPeerMapOrigin?(FloorTransform(matrix: anchor.transform.inverse))
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

#if DEBUG
extension ARCapture {
    /// Sample scan for rendering screens in the simulator.
    func loadDemo(floor: Bool) {
        tracking = "TRACKING"
        hasLiDAR = true
        guard floor else { return }
        scan = LocalScan(walls: [WallSegment(a: SIMD2(0, 0), b: SIMD2(5, 0)), WallSegment(a: SIMD2(5, 0), b: SIMD2(5, 4.5))],
                         openings: [], floor: [SIMD2(0, 0), SIMD2(5, 0), SIMD2(5, 4.5), SIMD2(0, 4.5)], floorY: -1.4)
        localMark = Mark(x: 2.5, z: 2.5, yaw: 0.3)
        var batch = MeshProcessor.ColouredPoints()
        for i in 0..<6000 {
            let wall = i % 3
            let t = Float.random(in: 0...1), y = Float.random(in: -1.4...1.2)
            let (x, z): (Float, Float) = wall == 0 ? (t * 5, 0) : wall == 1 ? (5, t * 4.5) : (Float.random(in: 0...5), Float.random(in: 0...4.5))
            batch.points += [x, wall == 2 ? -1.4 : y, z]
            batch.colors += wall == 2 ? [150, 105, 70] : (wall == 0 ? [214, 206, 190] : [120, 150, 170])
            batch.normals += [0, 127, 0]
        }
        cloud.append(batch)
        cloudVersion += 1
    }
}
#endif
