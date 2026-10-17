import SwiftUI
import simd

/// Shows this phone's pairing code. The phone that scans it joins this map
/// and is placed exactly, from where it sees the code on this screen.
struct ShowCodeView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @ObservedObject var capture: ARCapture
    @Environment(\.dismiss) private var dismiss
    @State private var code = QRPairing.newCode()
    @State private var pairedWith: String?
    @State private var codeCentre: CGPoint = .zero
    @State private var savedBrightness: CGFloat?
    private let codeSize: CGFloat = 250

    private var payload: PairingPayload? {
        relay.server.map { PairingPayload(server: $0, code: code, width: QRPairing.metres(points: codeSize)) }
    }

    var body: some View {
        VStack(spacing: 24) {
            HStack {
                Text("PAIR").font(Theme.display(34))
                Spacer()
                IconButton(glyph: .close, label: "Close") { dismiss() }
            }
            if !QRPairing.Device.current.known {
                Spacer()
                Text("This phone model can scan codes but can't show one: its screen size isn't known, so the other phone couldn't be placed accurately.")
                    .font(.system(size: 15)).foregroundStyle(Theme.muted)
                Spacer()
            } else if !relay.alignment.aligned {
                Spacer()
                VStack(alignment: .leading, spacing: 14) {
                    Text("THIS PHONE ISN'T PLACED").font(Theme.display(24))
                    Text("Only a phone that's placed in the group can invite others. Scan the code on a phone that is.")
                        .font(.system(size: 15)).foregroundStyle(Theme.muted)
                    PillButton(title: "Scan a code instead") { model.scanCode(returnTo: .group, cancelTo: .group) }
                }
                Spacer()
            } else if let payload, let image = QRPairing.image(for: payload.string) {
                Text("Hold this phone still. Point the other phone's camera at this code from about 30 cm.")
                    .font(.system(size: 15)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
                Spacer()
                Image(decorative: image, scale: 1)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: codeSize, height: codeSize)
                    .background(GeometryReader { g in
                        Color.clear.onAppear { codeCentre = centreOffset(g.frame(in: .global)) }
                            .onChange(of: g.frame(in: .global)) { _, f in codeCentre = centreOffset(f) }
                    })
                    .padding(18)
                    .background(RoundedRectangle(cornerRadius: 22).fill(.white))
                Spacer()
                HStack(spacing: 10) {
                    Circle().fill(pairedWith == nil ? Color.white.opacity(0.3) : Theme.red).frame(width: 10, height: 10)
                    Text(pairedWith.map { "Paired with \($0)" } ?? "Waiting for the other phone").label(11, bold: true)
                }
            }
        }
        .padding(24)
        .background(Color.black.ignoresSafeArea())
        .presentationBackground(.black)
        // A task, not a Timer in the view struct: the view is rebuilt many
        // times a second while AR runs, which would keep restarting a timer.
        .task {
            while !Task.isCancelled {
                publish()
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
        .onAppear {
            savedBrightness = UIScreen.main.brightness
            UIScreen.main.brightness = 1 // easier for the other camera to read
            relay.onPairingDone = { name in
                pairedWith = name
                Haptics.success()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { dismiss() }
            }
        }
        .onDisappear {
            if let savedBrightness { UIScreen.main.brightness = savedBrightness }
            relay.hidePairing(code: code)
            relay.onPairingDone = nil
        }
    }

    /// Code centre relative to the screen centre, in points (x right, y down).
    private func centreOffset(_ frame: CGRect) -> CGPoint {
        let screen = UIScreen.main.bounds
        return CGPoint(x: frame.midX - screen.midX, y: frame.midY - screen.midY)
    }

    /// Where the code on this screen is on the map, five times a second.
    private func publish() {
        guard relay.alignment.aligned else { return }
        let onMap = relay.alignment.transform.matrix * capture.cameraTransform * QRPairing.codeInCamera(offsetFromScreenCentre: codeCentre)
        relay.showPairing(code: code, codeOnMap: onMap)
    }
}

/// Full-screen camera with a viewfinder while reading another phone's code.
struct PairScanView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 20) {
            HStack {
                IconButton(glyph: .back, label: "Cancel") { model.cancelPairing() }
                Spacer()
            }
            Spacer()
            RoundedRectangle(cornerRadius: 28)
                .strokeBorder(style: StrokeStyle(lineWidth: 3, dash: [2, 9]))
                .foregroundStyle(frameColour)
                .frame(width: 250, height: 250)
            Spacer()
            Panel {
                VStack(alignment: .leading, spacing: 8) {
                    Text(title).font(Theme.display(26))
                    Text(detail).font(.system(size: 15)).foregroundStyle(Theme.muted)
                }
            }
        }
        .padding(16)
        .confirmationDialog("This code belongs to a different map server: \(model.pendingServerSwitch?.server.host ?? "")",
                            isPresented: Binding(get: { model.pendingServerSwitch != nil }, set: { if !$0 { model.acceptServerSwitch(false) } }),
                            titleVisibility: .visible) {
            Button("Join that map") { model.acceptServerSwitch(true) }
            Button("Cancel", role: .cancel) { model.acceptServerSwitch(false) }
        } message: {
            Text("Your camera view and scans will be shared there.")
        }
    }

    private var frameColour: Color {
        switch model.scanState {
        case .paired: return Theme.red
        case .reading, .measuring: return .white
        default: return .white.opacity(0.5)
        }
    }

    private var title: String {
        switch model.scanState {
        case .looking: return "SCAN THE CODE"
        case .reading: return "HOLD STEADY"
        case .measuring: return "LOCATING"
        case .paired: return "PAIRED"
        case .failed: return "TRY AGAIN"
        }
    }

    private var detail: String {
        switch model.scanState {
        case .looking: return "On a phone in the group, tap Invite to show its code. Fit the code in the frame."
        case .reading: return "Code read. Keep both phones still while it's measured."
        case .measuring(let by): return "Placing this phone on \(by)'s map…"
        case .paired(let by): return "In the group with \(by)."
        case .failed(let why): return why
        }
    }
}
