import Foundation
import simd

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

    func send(cloud points: [Float]) {
        sendText(["t": "cloud", "points": points.map { (Double($0) * 100).rounded() / 100 }])
    }

    func newRoom(name: String, planRoomId: String?) {
        var message: [String: Any] = ["t": "room", "action": "new", "name": name]
        if let planRoomId { message["planRoomId"] = planRoomId }
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
                    if case .string(let text) = message { self.handle(text) }
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
                if let id = peer["id"] as? String, let pose = peer["pose"] as? [String: Any], let mark = Self.mark(pose) {
                    peerMarks[id] = mark
                }
            }
            applyMap(msg["map"] as? [String: Any] ?? [:])
        case "join": peers += 1
        case "leave":
            peers = max(0, peers - 1)
            if let id = msg["id"] as? String { peerMarks[id] = nil }
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
                transform: FloorTransform(yaw: Float(a?["yaw"] as? Double ?? 0), tx: Float(t.first ?? 0), tz: Float(t.count > 2 ? t[2] : 0))
            )
        default: break
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
