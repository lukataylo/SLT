import ARKit
import Combine
import SwiftUI
import simd

/// Persisted preferences. Toggles that change what the phone does.
final class Settings: ObservableObject {
    private let defaults = UserDefaults.standard
    @Published var name: String { didSet { defaults.set(name, forKey: "name") } }
    @Published var server: String { didSet { defaults.set(server, forKey: "server") } }
    @Published var shareCamera: Bool { didSet { defaults.set(shareCamera, forKey: "shareCamera") } }
    @Published var captureColour: Bool { didSet { defaults.set(captureColour, forKey: "captureColour") } }
    @Published var showMesh: Bool { didSet { defaults.set(showMesh, forKey: "showMesh") } }
    @Published var showPlanes: Bool { didSet { defaults.set(showPlanes, forKey: "showPlanes") } }
    @Published var wallGhosts: Bool { didSet { defaults.set(wallGhosts, forKey: "wallGhosts") } }
    @Published var haptics: Bool { didSet { defaults.set(haptics, forKey: "haptics"); Haptics.enabled = haptics } }
    @Published var xray: Double { didSet { defaults.set(xray, forKey: "xray") } }
    /// Needed to upload a floor plan when the server sets ADMIN_TOKEN.
    @Published var adminToken: String { didSet { defaults.set(adminToken, forKey: "adminToken") } }

    static let defaultServer = "https://web-production-94bf8.up.railway.app"

    init() {
        let d = UserDefaults.standard
        d.register(defaults: ["shareCamera": true, "captureColour": true, "showMesh": true, "showPlanes": true,
                              "wallGhosts": true, "haptics": true, "xray": 0.75])
        name = d.string(forKey: "name") ?? UIDevice.current.name
        server = d.string(forKey: "server") ?? Self.defaultServer
        shareCamera = d.bool(forKey: "shareCamera")
        captureColour = d.bool(forKey: "captureColour")
        showMesh = d.bool(forKey: "showMesh")
        showPlanes = d.bool(forKey: "showPlanes")
        wallGhosts = d.bool(forKey: "wallGhosts")
        haptics = d.bool(forKey: "haptics")
        xray = d.double(forKey: "xray")
        adminToken = d.string(forKey: "adminToken") ?? ""
        Haptics.enabled = haptics
    }
}

/// App flow (version C, "Radar"): Start (name, create or join a group) →
/// create: find the floor; join: scan any member's code → the group list
/// (who's where, Still or Move) → Live: a radar of everyone, their views
/// docked at the screen edge, locking on when you face them. SCAN (building
/// the 3D map) stays available from Settings.
@MainActor
final class AppModel: ObservableObject {
    enum Mode: Equatable { case start, creating, group, live, scan, pairScan, floorplan }
    enum Sheet: String, Identifiable { case rooms, showCode, settings, plan; var id: String { rawValue } }

    /// The room the user chose to scan: an existing one, or a new one.
    struct RoomIntent: Equatable {
        var existingId: String?
        var name: String
        var planRoomId: String?
    }

    enum ScanState: Equatable {
        case looking, reading(String), measuring(String), paired(String), failed(String)
    }

    let capture = ARCapture()
    let relay = RelayClient()
    let settings = Settings()

    @Published var mode: Mode = .start { didSet { applyMode() } }
    @Published var sheet: Sheet?
    @Published var roomIntent: RoomIntent?
    @Published var scanState: ScanState = .looking
    /// The plan sheet opens on uploading a new drawing (else on locating).
    @Published var planUpload = false
    /// Where to go back to from the live floor plan.
    var beforeFloorPlan: Mode = .start
    /// Where to go after scanning a pairing code, and on cancelling it.
    private var afterPairing: Mode = .group
    private var onCancelPairing: Mode = .start
    private var claimedCode: PairingPayload?
    private var lastClaim = Date.distantPast
    private var codePoseInOurFrame: simd_float4x4?
    private var lastOriginPair = Date.distantPast
    private var pairSent = false
    /// A code that points at a different server waits for the user's OK.
    @Published var pendingServerSwitch: PairingPayload?
    private var bag = Set<AnyCancellable>()
    // Recognising a room from its wall photos (see "wall photos" below).
    private var wallPrints: [String: ViewMatcher.Reference] = [:]
    private var loadingPrints: Set<String> = []
    private var headingVote = ViewMatcher.Vote()
    private var matching = false
    private var lastHeadingSent: (yaw: Float, at: Date)?
    private let matchQueue = DispatchQueue(label: "slt.match", qos: .userInitiated)

    var isLocated: Bool { relay.alignment.aligned }
    var mapExists: Bool { relay.originFoundedBy != nil }
    var me: Member? { relay.members.first { $0.id == relay.selfId } }
    var isStill: Bool { me?.role == "still" }

    private var started = false

    func start() {
        guard !started else { return }
        started = true
        #if DEBUG
        if let screen = UserDefaults.standard.string(forKey: "demo") {
            // Camera only (no scanning delegate), so sample data stays put.
            capture.session.run(ARWorldTrackingConfiguration())
            loadDemo(screen)
            return
        }
        #endif
        capture.onPose = { [relay] pose in relay.send(pose: pose) }
        capture.onFrame = { [relay] pose, jpeg in relay.send(pose: pose, jpeg: jpeg) }
        capture.onScan = { [relay] scan in relay.send(scan: scan) }
        capture.onCloud = { [relay] cloud in relay.send(cloud: cloud) }
        capture.onReference = { [relay] slot, pose, jpeg in relay.send(reference: slot, pose: pose, jpeg: jpeg) }
        capture.onLookFrame = { [weak self] frame in self?.match(frame) }
        capture.onCollaboration = { [relay] data in relay.send(collaboration: data) }
        relay.onCollaboration = { [capture] data in capture.receiveCollaboration(data) }
        relay.onReset = { [capture] restart in capture.reset(restartTracking: restart) }
        capture.onPeerMapOrigin = { [weak self] alignment in
            guard let self, !self.isLocated, ![.start, .creating].contains(self.mode),
                  Date().timeIntervalSince(self.lastOriginPair) > 1 else { return }
            self.lastOriginPair = Date()
            self.relay.pair(alignment)
        }
        wirePairing()

        // Being placed on the map is the moment rooms and pairing unlock.
        // @Published emits before the value is stored: defer so isLocated is current.
        relay.$alignment.map(\.aligned).removeDuplicates().sink { [weak self] aligned in
            guard aligned else { return }
            DispatchQueue.main.async {
                guard let self else { return }
                Haptics.success()
                self.applyRoomIntent()
            }
        }.store(in: &bag)
        // Every placement message, not just the first: a phone that was
        // already placed must still move on when it founds or pairs.
        relay.$alignment.sink { [weak self] a in
            DispatchQueue.main.async {
                guard let self, a.aligned else { return }
                if self.mode == .creating && a.method == "origin" { self.mode = .group }
                if case .measuring(let by) = self.scanState, a.method == "paired" { self.finishPairing(by: by) }
            }
        }.store(in: &bag)
        // Someone else's group is running: back to Start, which says so.
        relay.$groupBlockedBy.sink { [weak self] blocked in
            DispatchQueue.main.async {
                if blocked != nil, self?.mode == .creating { self?.mode = .start }
            }
        }.store(in: &bag)
        relay.$alignment.sink { [weak self] a in
            if a.aligned { self?.capture.publishMapOrigin(a.transform) }
        }.store(in: &bag)
        relay.$rooms.sink { [weak self] _ in DispatchQueue.main.async { self?.applyRoomIntent() } }.store(in: &bag)
        // Wall photos: keep the targets current, and start afresh once placed.
        relay.$rooms.sink { [weak self] _ in DispatchQueue.main.async { self?.updateWallPhotos() } }.store(in: &bag)
        relay.$alignment.sink { [weak self] a in
            DispatchQueue.main.async {
                guard let self else { return }
                if a.aligned {
                    self.headingVote.reset()
                    self.lastHeadingSent = nil
                }
                self.updateWallPhotos()
            }
        }.store(in: &bag)
        Timer.publish(every: 0.5, on: .main, in: .common).autoconnect().sink { [weak self] _ in self?.lookForWalls() }.store(in: &bag)
        settings.$shareCamera.sink { [weak self] _ in DispatchQueue.main.async { self?.applyMode() } }.store(in: &bag)
        settings.$captureColour.sink { [weak self] _ in DispatchQueue.main.async { self?.applyMode() } }.store(in: &bag)

        capture.start()
        connect()
        applyMode()
    }

    func connect() {
        relay.disconnect()
        if let url = URL(string: settings.server) { relay.connect(server: url, name: settings.name) }
    }

    private func applyMode() {
        // In a group, every phone streams its view so everyone (and the operator)
        // can see it, and keeps scanning with LiDAR the whole time: walls keep
        // it aligned, colour points keep growing the 3D map.
        let inGroup = mode == .group || mode == .live
        capture.sendFrames = inGroup && settings.shareCamera
        capture.sendCloud = (inGroup || mode == .scan || mode == .floorplan) && settings.captureColour
        capture.detectQR = mode == .pairScan
        if mode != .pairScan { capture.stopTrackingCodes() }
        updateWallPhotos()
    }

    // MARK: group

    func createGroup() {
        relay.createGroup()
        mode = .creating
    }

    func openPlan(upload: Bool) {
        planUpload = upload
        sheet = .plan
    }

    func openLiveFloorPlan() {
        if mode != .floorplan { beforeFloorPlan = mode }
        sheet = nil
        mode = .floorplan
    }

    func cancelCreate() {
        relay.cancelCreate()
        mode = .start
    }

    /// "Start a new map here" while scanning: a new group, founded by this phone.
    func startNewMapHere() {
        relay.createGroup()
    }

    func joinGroup() {
        scanCode(returnTo: .group, cancelTo: .start)
    }

    func setRole(_ role: String, for id: String) {
        relay.setRole(role, for: id)
        Haptics.tap()
    }

    /// Leaving drops this phone's place: a new connection is a new member.
    func leaveGroup() {
        sheet = nil
        mode = .start
        connect()
    }

    // MARK: scanning

    /// Chosen in the room picker. Applied as soon as this phone is on the map
    /// (immediately if it already is; on founding if the map is empty).
    func scan(_ intent: RoomIntent) {
        roomIntent = intent
        sheet = nil
        mode = .scan
        applyRoomIntent()
    }

    private func applyRoomIntent() {
        guard let intent = roomIntent, isLocated else { return }
        if let id = intent.existingId {
            if relay.roomId != id { relay.switchRoom(id) }
            roomIntent = nil
        } else if relay.alignment.method == "origin", let first = relay.rooms.first, relay.rooms.count == 1, relay.roomId == first.id,
                  first.name == "Room 1" {
            // This phone just founded the map, which made "Room 1": that is the new room.
            relay.renameRoom(first.id, name: intent.name, planRoomId: intent.planRoomId)
            roomIntent = nil
        } else if !relay.rooms.isEmpty {
            relay.newRoom(name: intent.name, planRoomId: intent.planRoomId)
            roomIntent = nil
        }
    }

    // MARK: wall photos (background)

    // Located phones photograph each room's 4 wall directions as they go,
    // square-on and from well back. A phone that isn't located matches its
    // camera against them; once several views agree it knows its heading on
    // the map and tells the server, which puts it in that room and lets its
    // LiDAR walls place it exactly. Nothing here is shown on screen.

    /// Modes in which the phone is part of the group and tracking the room.
    private var inRoomMode: Bool { [.group, .live, .scan, .floorplan].contains(mode) }

    /// Keeps the capture's photo targets in step with the room this phone is in.
    private func updateWallPhotos() {
        guard inRoomMode, isLocated, let room = relay.currentRoom, room.walls.count >= 3 else {
            capture.referenceTargets = nil
            return
        }
        var targets = WallReferences.Targets(alignment: relay.alignment.transform, walls: room.walls)
        // The photos the room already has, and any just taken, set the bar.
        for ref in room.references where ref.slot < WallReferences.slots {
            var camera = simd_float4x4(ref.orientation)
            camera.columns.3 = SIMD4(ref.position, 1)
            if let view = WallReferences.view(camera, FloorTransform()),
               let d = WallReferences.distanceToWall(from: view.position, angle: view.angle, walls: room.walls) {
                targets.best[ref.slot] = d
            }
        }
        if let taken = capture.referenceTargets?.best {
            for slot in 0 ..< WallReferences.slots { targets.best[slot] = [targets.best[slot], taken[slot]].compactMap { $0 }.max() }
        }
        capture.referenceTargets = targets
    }

    /// While not located: fetch wall photos not yet loaded, and ask the
    /// camera for a view to match.
    private func lookForWalls() {
        let refs = relay.rooms.flatMap { room in room.references.map { (roomId: room.id, ref: $0) } }
        let wanted = Set(refs.map(\.ref.id))
        wallPrints = wallPrints.filter { wanted.contains($0.key) }
        guard started, !isLocated, inRoomMode, relay.connected, !refs.isEmpty else { return }
        for (roomId, ref) in refs where wallPrints[ref.id] == nil && !loadingPrints.contains(ref.id) {
            loadingPrints.insert(ref.id)
            Task { await loadWallPrint(roomId: roomId, ref: ref) }
        }
        if !wallPrints.isEmpty && !matching { capture.wantsLookFrame = true }
    }

    private func loadWallPrint(roomId: String, ref: RoomReference) async {
        defer { loadingPrints.remove(ref.id) }
        guard let data = try? await relay.downloadReference(roomId: roomId, id: ref.id),
              let image = UIImage(data: data)?.cgImage else { return }
        let print: ViewMatcher.Print? = await withCheckedContinuation { done in
            matchQueue.async {
                guard let gray = ViewMatcher.gray(image) else { return done.resume(returning: nil) }
                done.resume(returning: ViewMatcher.print(gray: gray.gray, width: gray.width, height: gray.height, orientation: ref.orientation,
                                                         vfov: ref.vfov * .pi / 180, aspect: ref.aspect))
            }
        }
        if let print { wallPrints[ref.id] = ViewMatcher.Reference(id: ref.id, roomId: roomId, print: print) }
    }

    private func match(_ frame: ARCapture.LookFrame) {
        guard !isLocated, !matching else { return }
        matching = true
        let references = Array(wallPrints.values)
        matchQueue.async { [weak self] in
            let query = ViewMatcher.print(gray: frame.gray, width: frame.width, height: frame.height,
                                          orientation: frame.orientation, vfov: frame.vfov, aspect: frame.aspect)
            let matches = query.map { ViewMatcher.locate($0, in: references) } ?? []
            DispatchQueue.main.async {
                guard let self else { return }
                self.matching = false
                guard !self.isLocated, let found = self.headingVote.add(matches) else { return }
                // Resend when it changes or now and then, until walls place the phone.
                let changed = self.lastHeadingSent.map { abs(ViewMatcher.wrap($0.yaw - found.offset)) > 3 * .pi / 180 } ?? true
                let stale = self.lastHeadingSent.map { Date().timeIntervalSince($0.at) > 3 } ?? true
                guard changed || stale else { return }
                self.lastHeadingSent = (found.offset, Date())
                self.relay.sendHeading(yaw: found.offset, roomId: found.roomId)
            }
        }
    }

    // MARK: pairing by QR

    func scanCode(returnTo: Mode, cancelTo: Mode? = nil) {
        afterPairing = returnTo
        onCancelPairing = cancelTo ?? returnTo
        claimedCode = nil
        codePoseInOurFrame = nil
        pairSent = false
        scanState = .looking
        sheet = nil
        mode = .pairScan
    }

    func cancelPairing() {
        mode = onCancelPairing
        scanState = .looking
    }

    private func wirePairing() {
        capture.onQRPayload = { [weak self] payload in
            guard let self, self.claimedCode?.code != payload.code, self.pendingServerSwitch == nil else { return }
            // A code from another server could send this phone's camera
            // anywhere: ask first, then join it.
            if payload.server.absoluteString != self.settings.server {
                self.pendingServerSwitch = payload
                return
            }
            self.startTracking(payload)
        }
        capture.onCodePose = { [weak self] pose in
            guard let self, let code = self.claimedCode else { return }
            self.codePoseInOurFrame = pose
            if Date().timeIntervalSince(self.lastClaim) > 0.5 {
                self.lastClaim = Date()
                self.relay.claimPairing(code: code.code)
            }
        }
        relay.onPairingPose = { [weak self] codeOnMap, by in
            guard let self, let ours = self.codePoseInOurFrame, self.mode == .pairScan, !self.pairSent else { return }
            self.pairSent = true
            self.scanState = .measuring(by)
            self.relay.pair(QRPairing.alignment(codeOnMap: codeOnMap, codeInOurFrame: ours))
        }
        relay.onPairingUnknown = { [weak self] in
            guard let self, self.mode == .pairScan else { return }
            self.scanState = .failed("That code has expired. Ask them to open their code again.")
        }
    }

    func acceptServerSwitch(_ accept: Bool) {
        guard let payload = pendingServerSwitch else { return }
        pendingServerSwitch = nil
        guard accept else { return cancelPairing() }
        settings.server = payload.server.absoluteString
        connect()
        startTracking(payload)
    }

    private func startTracking(_ payload: PairingPayload) {
        guard let reference = QRPairing.referenceImage(for: payload) else { return }
        reference.validate { [weak self] error in
            DispatchQueue.main.async {
                guard let self else { return }
                if error != nil {
                    self.scanState = .failed("The code couldn't be measured. Make the other screen brighter and try again.")
                    return
                }
                self.claimedCode = payload
                self.scanState = .reading(payload.code)
                self.capture.track(reference)
            }
        }
    }

    private func finishPairing(by: String) {
        scanState = .paired(by)
        capture.stopTrackingCodes()
        Haptics.success()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self, self.mode == .pairScan else { return }
            self.mode = self.afterPairing
        }
    }

    #if DEBUG
    /// `-demo <screen>` launch argument: render a screen with sample data.
    private func loadDemo(_ screen: String) {
        let fresh = screen == "fresh"
        relay.loadDemo(located: screen != "locate", withMap: !fresh)
        capture.loadDemo(floor: !fresh)
        switch screen {
        case "fresh": mode = .start
        case "creating": mode = .creating
        case "group": mode = .group
        case "live": mode = .live
        case "still": relay.loadDemoStill(); mode = .live
        case "rooms": mode = .group; sheet = .rooms
        case "settings": mode = .group; sheet = .settings
        case "code": mode = .group; sheet = .showCode
        case "scan", "locate": roomIntent = RoomIntent(existingId: "r1", name: "Living", planRoomId: "pr1"); mode = .scan
        case "pairscan": mode = .pairScan; scanState = .reading("abc")
        case "floorplan": mode = .floorplan
        default: mode = .group
        }
    }
    #endif

    func resetMap() {
        relay.resetMap()
        roomIntent = nil
        mode = .start
    }
}
