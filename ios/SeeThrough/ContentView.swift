import SwiftUI

private let red = Color(red: 0.843, green: 0.098, blue: 0.129)

struct ContentView: View {
    @StateObject private var capture = ARCapture()
    @StateObject private var relay = RelayClient()
    @AppStorage("server") private var server = "https://web-production-94bf8.up.railway.app"
    @AppStorage("name") private var name = UIDevice.current.name
    @State private var showSettings = false
    @State private var showRooms = false
    @State private var mapExpanded = false

    var body: some View {
        ZStack {
            ARPreview(session: capture.session).ignoresSafeArea()
            LinearGradient(colors: [.black.opacity(0.75), .clear, .clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
                .allowsHitTesting(false)
            VStack(spacing: 12) {
                header
                Spacer()
                roomBar
                floorPlan
                    .frame(height: mapExpanded ? 420 : 200)
                    .onTapGesture { withAnimation(.snappy) { mapExpanded.toggle() } }
                statusCard
            }
            .padding(16)
        }
        .onAppear(perform: start)
        .onDisappear {
            capture.pause()
            relay.disconnect()
        }
        .sheet(isPresented: $showSettings, onDismiss: reconnect) { settings }
        .sheet(isPresented: $showRooms) { RoomSheet(relay: relay) }
    }

    private var header: some View {
        HStack(alignment: .center) {
            HStack(spacing: 8) {
                Circle().fill(relay.connected ? red : Color.gray).frame(width: 8, height: 8)
                Text(relay.connected ? "LIVE" : "OFFLINE").mono(11, weight: .bold)
            }
            Spacer()
            counter(relay.peers, "PEERS")
            counter(relay.rooms.count, "ROOMS").padding(.leading, 18)
            Spacer()
            Button { showSettings = true } label: { pill("SETUP") }
                .foregroundStyle(.white)
        }
    }

    /// Current room, and the way into creating, switching and resetting rooms.
    private var roomBar: some View {
        Button { showRooms = true } label: {
            HStack(spacing: 10) {
                Circle().fill(relay.currentRoom == nil ? Color.white.opacity(0.3) : red).frame(width: 8, height: 8)
                Text("ROOM").mono(9).foregroundStyle(.gray)
                Text((relay.currentRoom?.name ?? "NONE YET").uppercased()).mono(12, weight: .bold).lineLimit(1)
                if let planRoom = relay.currentRoom?.planRoomId, let name = relay.plan?.rooms.first(where: { $0.id == planRoom })?.name {
                    Text("↔ \(name.uppercased())").mono(9).foregroundStyle(.gray).lineLimit(1)
                }
                Spacer()
                Text("ROOMS ▸").mono(10, weight: .bold)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(Capsule().fill(.black.opacity(0.78)))
            .overlay(Capsule().stroke(Color.white.opacity(0.14)))
        }
        .foregroundStyle(.white)
        .disabled(!relay.connected)
    }

    private func counter(_ value: Int, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(String(format: "%02d", value)).font(.system(size: 24, weight: .heavy, design: .monospaced))
            Text(label).mono(9).foregroundStyle(.gray)
        }
    }

    private func pill(_ text: String) -> some View {
        Text(text).mono(11, weight: .bold).padding(.horizontal, 14).padding(.vertical, 9)
            .background(Capsule().fill(.black.opacity(0.7)))
            .overlay(Capsule().stroke(Color.white.opacity(0.18)))
    }

    /// Once aligned, the shared map (every room's LiDAR walls) with this phone
    /// placed on it; before that, this phone's own scan.
    @ViewBuilder private var floorPlan: some View {
        if relay.alignment.aligned {
            FloorPlanView(
                walls: relay.allWalls.map(\.array),
                seen: relay.allSeen,
                openings: relay.rooms.flatMap(\.openings),
                floor: relay.currentRoom?.floor ?? [],
                target: relay.targetOutline,
                me: capture.localMark.map { relay.alignment.transform.apply($0) },
                peers: Array(relay.peerMarks.values),
                origin: relay.originFoundedBy == nil ? nil : .fixed,
                title: relay.originFoundedBy.map { "SHARED MAP · ORIGIN BY \($0.uppercased())" } ?? "SHARED MAP · LIVE"
            )
        } else {
            FloorPlanView(
                walls: capture.scan.walls.map(\.array),
                seen: capture.scan.walls.map(\.support),
                openings: capture.scan.openings,
                floor: capture.scan.floor,
                me: capture.localMark,
                peers: [],
                origin: .session,
                title: "LOCAL SCAN · SESSION START"
            )
        }
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(alignTitle).font(.system(size: 22, weight: .heavy, design: .monospaced))
                Spacer()
                Circle().fill(relay.alignment.aligned ? red : Color.white.opacity(0.25)).frame(width: 12, height: 12)
            }
            Text(alignDetail).font(.system(size: 14)).foregroundStyle(.gray)
            HStack(spacing: 8) {
                chip(capture.hasLiDAR ? "LIDAR" : "NO LIDAR", on: capture.hasLiDAR)
                chip(capture.tracking, on: capture.tracking == "TRACKING")
                chip("FLOOR", on: capture.scan.floorY != nil)
                chip("\(capture.scan.walls.count) WALLS", on: capture.scan.walls.count >= 2)
            }
        }
        .padding(20)
        .background(RoundedRectangle(cornerRadius: 24).fill(.black.opacity(0.78)))
        .overlay(RoundedRectangle(cornerRadius: 24).stroke(Color.white.opacity(0.14)))
    }

    private func chip(_ text: String, on: Bool) -> some View {
        Text(text).mono(9, weight: .bold)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .foregroundStyle(on ? .black : .white)
            .background(Capsule().fill(on ? Color.white : Color.clear))
            .overlay(Capsule().stroke(Color.white.opacity(on ? 0 : 0.25)))
            .lineLimit(1)
    }

    private var alignTitle: String {
        if !relay.connected { return "CONNECTING" }
        if capture.scan.floorY == nil || relay.alignment.needsFloor { return "FIND FLOOR" }
        if relay.alignment.aligned { return "ALIGNED" }
        return relay.alignment.ambiguous ? "AMBIGUOUS" : "SCANNING"
    }

    private var alignDetail: String {
        let a = relay.alignment
        if capture.scan.floorY == nil || a.needsFloor {
            return "Point the phone down at the floor. The map is grounded on it before anything else."
        }
        if a.aligned {
            if a.method == "origin" { return "You founded the map. Its origin is fixed here and saved; every scan aligns to it." }
            if !relay.targetOutline.isEmpty { return "Scan this room until its walls fill the dashed outline from the floor plan." }
            if let match = a.match { return "Locked to the shared floor plan · \(Int(match * 100))% wall match." }
            return "Locked to the shared floor plan."
        }
        if a.ambiguous { return "These walls fit more than one spot. Scan a corner or doorway that makes this room unique." }
        return "Sweep the phone across at least two walls that meet at a corner."
    }

    private var settings: some View {
        NavigationStack {
            Form {
                Section("NAME") { TextField("Your name", text: $name).textInputAutocapitalization(.words) }
                Section("SERVER") {
                    TextField("https://…", text: $server)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }
            .navigationTitle("Setup")
            .toolbar { Button("Done") { showSettings = false } }
        }
        .preferredColorScheme(.dark)
    }

    private func start() {
        capture.onPose = { pose in relay.send(pose: pose) }
        capture.onFrame = { pose, jpeg in relay.send(pose: pose, jpeg: jpeg) }
        capture.onScan = { scan in relay.send(scan: scan) }
        capture.onCloud = { points in relay.send(cloud: points) }
        relay.onReset = { restart in capture.reset(restartTracking: restart) }
        capture.start()
        reconnect()
    }

    private func reconnect() {
        relay.disconnect()
        if let url = URL(string: server) { relay.connect(server: url, name: name) }
    }
}

extension Text {
    func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Text {
        font(.system(size: size, weight: weight, design: .monospaced)).tracking(size * 0.14)
    }
}
