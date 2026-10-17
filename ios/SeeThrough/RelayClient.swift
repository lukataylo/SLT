import Foundation

/// WebSocket link to the relay. Connects with `frame=local`, so the server
/// treats this phone's poses as ARKit-frame and aligns them using its walls.
@MainActor
final class RelayClient: ObservableObject {
    struct Alignment {
        var aligned: Bool
        var method: String?
        var match: Double?
        var ambiguous: Bool
    }

    @Published private(set) var connected = false
    @Published private(set) var peers = 0
    @Published private(set) var mapWalls = 0
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
            peers = (msg["peers"] as? [Any])?.count ?? 0
            mapWalls = ((msg["map"] as? [String: Any])?["walls"] as? [Any])?.count ?? 0
        case "join": peers += 1
        case "leave": peers = max(0, peers - 1)
        case "map": mapWalls = (msg["walls"] as? [Any])?.count ?? 0
        case "align":
            alignment = Alignment(
                aligned: msg["aligned"] as? Bool ?? false,
                method: msg["method"] as? String,
                match: msg["inlierFraction"] as? Double,
                ambiguous: msg["ambiguous"] as? Bool ?? false
            )
        default: break
        }
    }

    private func sendText(_ message: [String: Any]) {
        guard let task, connected, let text = Wire.text(message) else { return }
        task.send(.string(text)) { _ in }
    }
}
