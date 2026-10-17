import Foundation
import simd

/// WebSocket link to the relay. Connects with `frame=local`, so the server
/// treats this phone's poses as ARKit-frame and aligns them using its walls.
@MainActor
final class RelayClient: ObservableObject {
    struct Alignment {
        var aligned: Bool
        var method: String?
        var match: Double?
        var ambiguous: Bool
        var transform = FloorTransform()
    }

    @Published private(set) var connected = false
    @Published private(set) var peers = 0
    /// The shared, vectorised floor plan in map coordinates.
    @Published private(set) var mapWalls: [[Float]] = []
    /// Other phones on the floor plan, by peer id.
    @Published private(set) var peerMarks: [String: Mark] = [:]
    @Published private(set) var alignment = Alignment(aligned: false, method: nil, match: nil, ambiguous: false)

    private var task: URLSessionWebSocketTask?
    private var target: (server: URL, name: String)?
    private var framesInFlight = 0
    private static let maxFramesInFlight = 2

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

    func send(walls: [[Float]], floorY: Float?) {
        var message: [String: Any] = ["t": "planes", "walls": walls.map { $0.map(Double.init) }]
        if let floorY { message["floorY"] = Double(floorY) }
        sendText(message)
    }

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
            mapWalls = Self.walls((msg["map"] as? [String: Any])?["walls"])
        case "join": peers += 1
        case "leave":
            peers = max(0, peers - 1)
            if let id = msg["id"] as? String { peerMarks[id] = nil }
        case "pose":
            if let id = msg["id"] as? String, let mark = Self.mark(msg) { peerMarks[id] = mark }
        case "map": mapWalls = Self.walls(msg["walls"])
        case "align":
            let a = msg["alignment"] as? [String: Any]
            let t = (a?["t"] as? [Double]) ?? [0, 0, 0]
            alignment = Alignment(
                aligned: msg["aligned"] as? Bool ?? false,
                method: msg["method"] as? String,
                match: msg["inlierFraction"] as? Double,
                ambiguous: msg["ambiguous"] as? Bool ?? false,
                transform: FloorTransform(yaw: Float(a?["yaw"] as? Double ?? 0), tx: Float(t.first ?? 0), tz: Float(t.count > 2 ? t[2] : 0))
            )
        default: break
        }
    }

    private static func walls(_ any: Any?) -> [[Float]] {
        (any as? [[Double]] ?? []).filter { $0.count == 4 }.map { $0.map(Float.init) }
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
