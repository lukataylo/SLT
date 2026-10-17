import Foundation
import simd
import UIKit

/// A room in the shared map (map coordinates, floor at y = 0).
struct MapRoom: Identifiable, Equatable {
    var id: String
    var name: String
    var origin: SIMD2<Float>
    var planRoomId: String?
    var walls: [WallSegment]
    var seen: [Int]
    var openings: [Opening]
    var floor: [SIMD2<Float>]
}

/// The uploaded floor plan: room outlines in plan metres, and where the plan
/// sits on the map once placed.
struct PlanInfo: Equatable {
    struct Room: Identifiable, Equatable {
        var id: String
        var name: String
        var polygon: [SIMD2<Float>]
    }
    var name: String
    var rooms: [Room]
    var placement: FloorTransform?
}

/// Another phone's latest camera frame and where it was taken (map frame).
struct RemoteFeed {
    var name: String
    var position: SIMD3<Float>
    var orientation: simd_quatf
    var vfov: Float
    var aspect: Float
    var image: UIImage
    var receivedAt: Date
}

/// WebSocket link to the relay. Connects with `frame=local`, so the server
/// treats this phone's poses as ARKit-frame and aligns them using its walls.
@MainActor
final class RelayClient: ObservableObject {
    struct Alignment {
        var aligned: Bool
        var method: String?
        var match: Double?
        var ambiguous: Bool
        var needsFloor: Bool
        var transform = FloorTransform()
    }

    @Published private(set) var connected = false
    @Published private(set) var peers = 0
    @Published private(set) var rooms: [MapRoom] = []
    @Published private(set) var roomId: String?
    @Published private(set) var plan: PlanInfo?
    /// Who founded the map's fixed origin, once there is one.
    @Published private(set) var originFoundedBy: String?
    /// Other phones on the floor plan, by peer id.
    @Published private(set) var peerMarks: [String: Mark] = [:]
    @Published private(set) var alignment = Alignment(aligned: false, method: nil, match: nil, ambiguous: false, needsFloor: true)

    /// The server asks the phone to drop its local scan: on entering or
    /// resetting a room (keep tracking), or on a map reset (restart tracking).
    var onReset: ((_ restartTracking: Bool) -> Void)?
    /// ARKit collaboration data from another phone, to feed our session.
    var onCollaboration: ((Data) -> Void)?
    /// QR pairing replies: the shown code's pose on the map; the code being
    /// unknown or expired; and (to the showing phone) that someone paired.
    var onPairingPose: ((_ codeOnMap: simd_float4x4, _ by: String) -> Void)?
    var onPairingUnknown: (() -> Void)?
    var onPairingDone: ((_ by: String) -> Void)?
    private(set) var server: URL?

    /// Other phones' live video, by peer id, for the x-ray view.
    private(set) var feeds: [String: RemoteFeed] = [:]
    @Published private(set) var feedsVersion = 0
    private var names: [String: String] = [:]
    private let decodeQueue = DispatchQueue(label: "slt.feeds", qos: .userInitiated)

    private var task: URLSessionWebSocketTask?
    private var target: (server: URL, name: String)?
    private var framesInFlight = 0
    private static let maxFramesInFlight = 2

    var currentRoom: MapRoom? { rooms.first { $0.id == roomId } }
    var allWalls: [WallSegment] { rooms.flatMap(\.walls) }
    var allSeen: [Int] { rooms.flatMap(\.seen) }

    /// The outline of the plan room linked to the current room, in map
    /// coordinates: the target to scan, once the plan is placed.
    var targetOutline: [WallSegment] {
        guard let planRoomId = currentRoom?.planRoomId, let plan, let placement = plan.placement,
              let room = plan.rooms.first(where: { $0.id == planRoomId }) else { return [] }
        let pts = room.polygon.map { p -> SIMD2<Float> in
            let (x, z) = placement.apply(p.x, p.y)
            return SIMD2(x, z)
        }
        return pts.indices.map { WallSegment(a: pts[$0], b: pts[($0 + 1) % pts.count]) }
    }

    func connect(server: URL, name: String) {
        self.server = server
        target = (server, name)
        open()
    }

    func disconnect() {
        target = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connected = false
    }

    func send(pose: Pose) {
        var message = pose.json
        message["t"] = "pose"
        sendText(message)
    }

    func send(scan: LocalScan) {
        var message: [String: Any] = [
            "t": "planes",
            "walls": scan.walls.map { $0.array.map(Double.init) },
            "openings": scan.openings.map(\.json),
            "floor": scan.floor.map { [Double($0.x), Double($0.y)] },
        ]
        if let y = scan.floorY { message["floorY"] = Double(y) }
        sendText(message)
    }

    func send(cloud: MeshProcessor.ColouredPoints) {
        sendText([
            "t": "cloud",
            "points": cloud.points.map { (Double($0) * 1000).rounded() / 1000 },
            "colors": cloud.colors.map(Int.init),
            "normals": cloud.normals.map(Int.init),
        ])
    }

    func newRoom(name: String, planRoomId: String?) {
        var message: [String: Any] = ["t": "room", "action": "new", "name": name]
        if let planRoomId { message["planRoomId"] = planRoomId }
        sendText(message)
    }

    func send(collaboration data: Data) {
        sendText(["t": "collab", "data": data.base64EncodedString()])
    }

    /// Our alignment as worked out from a paired phone's map-origin anchor.
    func pair(_ alignment: FloorTransform) {
        sendText(["t": "pair", "alignment": ["yaw": Double(alignment.yaw), "t": [Double(alignment.tx), Double(alignment.ty), Double(alignment.tz)]]])
    }

    func showPairing(code: String, codeOnMap: simd_float4x4) {
        sendText(["t": "pairing", "action": "show", "code": code, "m": QRPairing.columnMajor(codeOnMap)])
    }

    func hidePairing(code: String) { sendText(["t": "pairing", "action": "hide", "code": code]) }
    func claimPairing(code: String) { sendText(["t": "pairing", "action": "claim", "code": code]) }

    func renameRoom(_ id: String, name: String, planRoomId: String?) {
        var message: [String: Any] = ["t": "room", "action": "rename", "roomId": id, "name": name]
        message["planRoomId"] = planRoomId ?? NSNull()
        sendText(message)
    }

    func switchRoom(_ id: String) { sendText(["t": "room", "action": "switch", "roomId": id]) }
    func resetRoom() { sendText(["t": "room", "action": "reset-room"]) }
    func resetMap() { sendText(["t": "room", "action": "reset-map"]) }

    /// Drops the frame rather than queueing when the uplink is slow.
    func send(pose: Pose, jpeg: Data) {
        guard let task, connected, framesInFlight < Self.maxFramesInFlight,
              let data = Wire.frame(meta: pose.json, jpeg: jpeg) else { return }
        framesInFlight += 1
        task.send(.data(data)) { [weak self] _ in
            Task { @MainActor in self?.framesInFlight -= 1 }
        }
    }

    private func open() {
        guard let (server, name) = target,
              var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path = "/ws"
        components.queryItems = [URLQueryItem(name: "name", value: name), URLQueryItem(name: "frame", value: "local")]
        guard let url = components.url else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        task.maximumMessageSize = 16 * 1024 * 1024
        self.task = task
        framesInFlight = 0
        task.resume()
        receive(on: task)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === task else { return }
                switch result {
                case .success(let message):
                    self.connected = true
                    switch message {
                    case .string(let text): self.handle(text)
                    case .data(let data): self.handleFrame(data)
                    @unknown default: break
                    }
                    self.receive(on: task)
                case .failure:
                    self.connected = false
                    self.peers = 0
                    self.peerMarks = [:]
                    try? await Task.sleep(for: .seconds(2))
                    if self.task === task { self.open() }
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = msg["t"] as? String else { return }
        switch type {
        case "welcome":
            let list = msg["peers"] as? [[String: Any]] ?? []
            peers = list.count
            peerMarks = [:]
            for peer in list {
                if let id = peer["id"] as? String { names[id] = peer["name"] as? String }
                if let id = peer["id"] as? String, let pose = peer["pose"] as? [String: Any], let mark = Self.mark(pose) {
                    peerMarks[id] = mark
                }
            }
            applyMap(msg["map"] as? [String: Any] ?? [:])
        case "join":
            peers += 1
            if let id = msg["id"] as? String { names[id] = msg["name"] as? String }
        case "leave":
            peers = max(0, peers - 1)
            if let id = msg["id"] as? String {
                peerMarks[id] = nil
                feeds[id] = nil
                feedsVersion += 1
            }
        case "pairing":
            switch msg["action"] as? String {
            case "pose":
                if let m = (msg["m"] as? [Double]).flatMap(QRPairing.matrix(columnMajor:)) { onPairingPose?(m, msg["by"] as? String ?? "") }
            case "unknown": onPairingUnknown?()
            case "done": onPairingDone?(msg["by"] as? String ?? "")
            default: break
            }
        case "collab":
            if let b64 = msg["data"] as? String, let data = Data(base64Encoded: b64) { onCollaboration?(data) }
        case "pose":
            if let id = msg["id"] as? String, let mark = Self.mark(msg) { peerMarks[id] = mark }
        case "map": applyMap(msg)
        case "reset":
            onReset?(msg["scope"] as? String == "map")
        case "align":
            if let origin = msg["origin"] as? [String: Any] { originFoundedBy = origin["by"] as? String }
            roomId = msg["roomId"] as? String
            let a = msg["alignment"] as? [String: Any]
            let t = (a?["t"] as? [Double]) ?? [0, 0, 0]
            alignment = Alignment(
                aligned: msg["aligned"] as? Bool ?? false,
                method: msg["method"] as? String,
                match: msg["inlierFraction"] as? Double,
                ambiguous: msg["ambiguous"] as? Bool ?? false,
                needsFloor: msg["needsFloor"] as? Bool ?? false,
                transform: FloorTransform(yaw: Float(a?["yaw"] as? Double ?? 0), tx: Float(t.first ?? 0), tz: Float(t.count > 2 ? t[2] : 0),
                                          ty: Float(t.count > 1 ? t[1] : 0))
            )
        default: break
        }
    }

    /// Binary video frame: [u16 metaLen][meta JSON][JPEG]. Decoded off the main
    /// thread; a frame arriving while the previous one decodes replaces it.
    private func handleFrame(_ data: Data) {
        guard data.count > 2 else { return }
        let metaLen = Int(data[data.startIndex]) << 8 | Int(data[data.startIndex + 1])
        guard data.count > 2 + metaLen,
              let meta = try? JSONSerialization.jsonObject(with: data.subdata(in: data.startIndex + 2 ..< data.startIndex + 2 + metaLen)) as? [String: Any],
              let id = meta["id"] as? String,
              let p = meta["p"] as? [Double], p.count == 3,
              let q = meta["q"] as? [Double], q.count == 4 else { return }
        let jpeg = data.subdata(in: data.startIndex + 2 + metaLen ..< data.endIndex)
        let name = names[id] ?? id
        decodeQueue.async {
            guard let image = UIImage(data: jpeg)?.preparingForDisplay() else { return }
            let feed = RemoteFeed(
                name: name,
                position: SIMD3(Float(p[0]), Float(p[1]), Float(p[2])),
                orientation: simd_quatf(ix: Float(q[0]), iy: Float(q[1]), iz: Float(q[2]), r: Float(q[3])),
                vfov: Float(meta["fov"] as? Double ?? 50),
                aspect: Float(meta["aspect"] as? Double ?? 4.0 / 3),
                image: image,
                receivedAt: Date()
            )
            Task { @MainActor in
                self.feeds[id] = feed
                self.feedsVersion += 1
            }
        }
    }

    private func applyMap(_ map: [String: Any]) {
        originFoundedBy = (map["origin"] as? [String: Any])?["by"] as? String
        rooms = (map["rooms"] as? [[String: Any]] ?? []).compactMap(Self.room)
        plan = (map["plan"] as? [String: Any]).flatMap(Self.plan)
    }

    // MARK: parsing

    private static func point(_ any: Any?) -> SIMD2<Float>? {
        guard let p = any as? [Double], p.count == 2 else { return nil }
        return SIMD2(Float(p[0]), Float(p[1]))
    }

    private static func segment(_ any: Any?) -> (SIMD2<Float>, SIMD2<Float>)? {
        guard let s = any as? [Double], s.count == 4 else { return nil }
        return (SIMD2(Float(s[0]), Float(s[1])), SIMD2(Float(s[2]), Float(s[3])))
    }

    private static func room(_ r: [String: Any]) -> MapRoom? {
        guard let id = r["id"] as? String else { return nil }
        let walls = (r["walls"] as? [Any] ?? []).compactMap(segment).map { WallSegment(a: $0.0, b: $0.1) }
        let openings = (r["openings"] as? [[String: Any]] ?? []).compactMap { o -> Opening? in
            guard let kind = o["kind"] as? String, let s = segment(o["s"]),
                  let y0 = o["y0"] as? Double, let y1 = o["y1"] as? Double else { return nil }
            return Opening(kind: kind, a: s.0, b: s.1, y0: Float(y0), y1: Float(y1))
        }
        return MapRoom(
            id: id,
            name: r["name"] as? String ?? id,
            origin: point(r["origin"]) ?? .zero,
            planRoomId: r["planRoomId"] as? String,
            walls: walls,
            seen: r["seen"] as? [Int] ?? [],
            openings: openings,
            floor: (r["floor"] as? [Any] ?? []).compactMap(point)
        )
    }

    private static func plan(_ p: [String: Any]) -> PlanInfo? {
        let rooms = (p["rooms"] as? [[String: Any]] ?? []).compactMap { r -> PlanInfo.Room? in
            guard let id = r["id"] as? String else { return nil }
            return PlanInfo.Room(id: id, name: r["name"] as? String ?? id, polygon: (r["polygon"] as? [Any] ?? []).compactMap(point))
        }
        var placement: FloorTransform?
        if let pl = p["placement"] as? [String: Any], let yaw = pl["yaw"] as? Double, let t = pl["t"] as? [Double], t.count == 3 {
            placement = FloorTransform(yaw: Float(yaw), tx: Float(t[0]), tz: Float(t[2]))
        }
        return PlanInfo(name: p["name"] as? String ?? "Floor plan", rooms: rooms, placement: placement)
    }

    private static func mark(_ pose: [String: Any]) -> Mark? {
        guard let p = pose["p"] as? [Double], p.count == 3, let q = pose["q"] as? [Double], q.count == 4 else { return nil }
        let orientation = simd_quatf(ix: Float(q[0]), iy: Float(q[1]), iz: Float(q[2]), r: Float(q[3]))
        return Mark(position: SIMD3(Float(p[0]), Float(p[1]), Float(p[2])), orientation: orientation)
    }

    private func sendText(_ message: [String: Any]) {
        guard let task, connected, let text = Wire.text(message) else { return }
        task.send(.string(text)) { _ in }
    }
}

#if DEBUG
extension RelayClient {
    /// Sample state for rendering screens in the simulator (no ARKit there).
    func loadDemo(located: Bool, withMap: Bool) {
        connected = true
        server = URL(string: Settings.defaultServer)
        guard withMap else { return }
        peers = 2
        originFoundedBy = "Ana"
        func w(_ a: (Float, Float), _ b: (Float, Float)) -> WallSegment { WallSegment(a: SIMD2(a.0, a.1), b: SIMD2(b.0, b.1)) }
        rooms = [
            MapRoom(id: "r1", name: "Living", origin: .zero, planRoomId: "pr1",
                    walls: [w((0, 0), (5, 0)), w((5, 0), (5, 4.5)), w((5, 4.5), (0, 4.5)), w((0, 4.5), (0, 0))], seen: [3, 2, 3, 1],
                    openings: [Opening(kind: "door", a: SIMD2(3, 4.5), b: SIMD2(4, 4.5), y0: 0, y1: 2.05),
                               Opening(kind: "window", a: SIMD2(0, 1.2), b: SIMD2(0, 2.8), y0: 0.9, y1: 2.1)],
                    floor: [SIMD2(0, 0), SIMD2(5, 0), SIMD2(5, 4.5), SIMD2(0, 4.5)]),
            MapRoom(id: "r2", name: "Kitchen", origin: SIMD2(6, 1), planRoomId: nil,
                    walls: [w((5, 0), (9, 0)), w((9, 0), (9, 3)), w((5, 3), (9, 3))], seen: [1, 1, 2],
                    openings: [], floor: []),
        ]
        plan = PlanInfo(name: "Flat", rooms: [.init(id: "pr1", name: "Living", polygon: [SIMD2(0, 0), SIMD2(5, 0), SIMD2(5, 4.5), SIMD2(0, 4.5)]),
                                               .init(id: "pr2", name: "Bedroom", polygon: [SIMD2(0, 4.5), SIMD2(5, 4.5), SIMD2(5, 7), SIMD2(0, 7)])],
                        placement: FloorTransform())
        roomId = located ? "r1" : nil
        alignment = Alignment(aligned: located, method: located ? "walls" : nil, match: 0.92, ambiguous: false, needsFloor: false,
                              transform: FloorTransform(ty: 1.4))
        peerMarks = ["p2": Mark(x: 7, z: 1.5, yaw: 1.2), "p3": Mark(x: 2, z: 6, yaw: -0.4)]
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 480, height: 360))
        for (id, name, hue, x) in [("p2", "Ben", 0.08, Float(7)), ("p3", "Cy", 0.55, Float(2))] {
            let image = renderer.image { ctx in
                UIColor(hue: hue, saturation: 0.35, brightness: 0.75, alpha: 1).setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: 480, height: 360))
                UIColor(white: 0.25, alpha: 1).setFill()
                ctx.fill(CGRect(x: 0, y: 250, width: 480, height: 110))
                UIColor(white: 0.95, alpha: 1).setFill()
                ctx.fill(CGRect(x: 300, y: 70, width: 110, height: 150))
            }
            feeds[id] = RemoteFeed(name: name, position: SIMD3(x, 1.4, 1.5), orientation: simd_quatf(angle: 0.6, axis: SIMD3(0, 1, 0)),
                                   vfov: 50, aspect: 4 / 3, image: image, receivedAt: .distantFuture)
        }
        feedsVersion += 1
    }
}
#endif
