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
        Haptics.enabled = haptics
    }
}

/// App flow: a home screen; SCAN (one-off setup of rooms, building the
/// splat map); SEE THROUGH (live x-ray of other phones); pairing by QR.
@MainActor
final class AppModel: ObservableObject {
    enum Mode: Equatable { case home, scan, seeThrough, pairScan }
    enum Sheet: String, Identifiable { case rooms, showCode, settings; var id: String { rawValue } }

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

    @Published var mode: Mode = .home { didSet { applyMode() } }
    @Published var sheet: Sheet?
    @Published var roomIntent: RoomIntent?
    @Published var scanState: ScanState = .looking
    /// Mode to return to after scanning a pairing code.
    private var afterPairing: Mode = .home
    private var claimedCode: PairingPayload?
    private var lastClaim = Date.distantPast
    private var codePoseInOurFrame: simd_float4x4?
    private var lastOriginPair = Date.distantPast
    private var pairSent = false
    /// A code that points at a different server waits for the user's OK.
    @Published var pendingServerSwitch: PairingPayload?
    private var bag = Set<AnyCancellable>()

    var isLocated: Bool { relay.alignment.aligned }
    var mapExists: Bool { relay.originFoundedBy != nil }

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
        capture.onCollaboration = { [relay] data in relay.send(collaboration: data) }
        relay.onCollaboration = { [capture] data in capture.receiveCollaboration(data) }
        relay.onReset = { [capture] restart in capture.reset(restartTracking: restart) }
        capture.onPeerMapOrigin = { [weak self] alignment in
            guard let self, !self.isLocated, Date().timeIntervalSince(self.lastOriginPair) > 1 else { return }
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
                if case .measuring(let by) = self.scanState { self.finishPairing(by: by) }
            }
        }.store(in: &bag)
        relay.$alignment.sink { [weak self] a in
            if a.aligned { self?.capture.publishMapOrigin(a.transform) }
        }.store(in: &bag)
        relay.$rooms.sink { [weak self] _ in DispatchQueue.main.async { self?.applyRoomIntent() } }.store(in: &bag)
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
        capture.sendFrames = mode == .seeThrough && settings.shareCamera
        capture.sendCloud = mode == .scan && settings.captureColour
        capture.detectQR = mode == .pairScan
        if mode != .pairScan { capture.stopTrackingCodes() }
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

    // MARK: pairing by QR

    func scanCode(returnTo: Mode) {
        afterPairing = returnTo
        claimedCode = nil
        codePoseInOurFrame = nil
        pairSent = false
        scanState = .looking
        sheet = nil
        mode = .pairScan
    }

    func cancelPairing() {
        mode = afterPairing
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
        case "rooms": sheet = .rooms
        case "settings": sheet = .settings
        case "code": sheet = .showCode
        case "scan", "locate": roomIntent = RoomIntent(existingId: "r1", name: "Living", planRoomId: "pr1"); mode = .scan
        case "see": mode = .seeThrough
        case "pairscan": mode = .pairScan; scanState = .reading("abc")
        default: break
        }
    }
    #endif

    func resetMap() {
        relay.resetMap()
        roomIntent = nil
        mode = .home
    }
}
