import SwiftUI

private let red = Color(red: 0.843, green: 0.098, blue: 0.129)

struct ContentView: View {
    @StateObject private var capture = ARCapture()
    @StateObject private var relay = RelayClient()
    @AppStorage("server") private var server = "https://web-production-94bf8.up.railway.app"
    @AppStorage("name") private var name = UIDevice.current.name
    @State private var showSettings = false

    var body: some View {
        ZStack {
            ARPreview(session: capture.session).ignoresSafeArea()
            LinearGradient(colors: [.black.opacity(0.75), .clear, .clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
                .allowsHitTesting(false)
            VStack(spacing: 0) {
                header
                Spacer()
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
    }

    private var header: some View {
        HStack(alignment: .center) {
            HStack(spacing: 8) {
                Circle().fill(relay.connected ? red : Color.gray).frame(width: 8, height: 8)
                Text(relay.connected ? "LIVE" : "OFFLINE").mono(11, weight: .bold)
            }
            Spacer()
            counter(relay.peers, "PEERS")
            counter(relay.mapWalls, "MAP WALLS").padding(.leading, 18)
            Spacer()
            Button { showSettings = true } label: {
                Text("SETUP").mono(11, weight: .bold).padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Capsule().fill(.black.opacity(0.7)))
                    .overlay(Capsule().stroke(Color.white.opacity(0.18)))
            }
            .foregroundStyle(.white)
        }
    }

    private func counter(_ value: Int, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(String(format: "%02d", value)).font(.system(size: 24, weight: .heavy, design: .monospaced))
            Text(label).mono(9).foregroundStyle(.gray)
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
                chip("\(capture.wallCount) WALLS", on: capture.wallCount >= 2)
                chip("FLOOR", on: capture.floorFound)
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
        if relay.alignment.aligned { return "ALIGNED" }
        return relay.alignment.ambiguous ? "AMBIGUOUS" : "SCANNING"
    }

    private var alignDetail: String {
        let a = relay.alignment
        if a.aligned {
            if a.method == "origin" { return "You started the map. Others align to the walls you scan." }
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
        capture.onPlanes = { walls, floorY in relay.send(walls: walls, floorY: floorY) }
        capture.start()
        reconnect()
    }

    private func reconnect() {
        relay.disconnect()
        if let url = URL(string: server) { relay.connect(server: url, name: name) }
    }
}

private extension Text {
    func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Text {
        font(.system(size: size, weight: weight, design: .monospaced)).tracking(size * 0.14)
    }
}
