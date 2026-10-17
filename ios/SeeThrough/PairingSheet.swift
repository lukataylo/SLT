import SwiftUI

private let red = Color(red: 0.843, green: 0.098, blue: 0.129)

/// How to pair: ARKit merges two phones' sessions once they've seen the same
/// place, and the phone already on the map shares where the map is.
struct PairingSheet: View {
    @ObservedObject var capture: ARCapture
    @ObservedObject var relay: RelayClient
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Text("PAIR").font(.system(size: 30, weight: .heavy, design: .monospaced))
                Spacer()
                Button("DONE") { dismiss() }.font(.system(size: 12, weight: .bold, design: .monospaced))
            }
            step("01", "Stand next to a phone that's already on the map (it shows ALIGNED).")
            step("02", "Point both phones at the same spot, a corner, door or shelf, and move them slowly for a few seconds.")
            step("03", "When ARKit merges the two sessions, this phone snaps onto the shared map. Then walk to your own room.")
            Spacer()
            HStack(spacing: 12) {
                Circle().fill(capture.participants > 0 ? red : Color.white.opacity(0.25)).frame(width: 12, height: 12)
                Text(status).font(.system(size: 13, weight: .bold, design: .monospaced))
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 20).fill(Color.white.opacity(0.06)))
        }
        .padding(24)
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onChange(of: relay.alignment.aligned) { _, aligned in if aligned { dismiss() } }
    }

    private var status: String {
        if relay.alignment.aligned { return "PAIRED · ON THE SHARED MAP" }
        if capture.participants > 0 { return "SESSIONS MERGED · WAITING FOR THE MAP ORIGIN" }
        return relay.peers > 0 ? "LOOKING FOR THE OTHER PHONE…" : "NO OTHER PHONES CONNECTED"
    }

    private func step(_ n: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Text(n).font(.system(size: 22, weight: .heavy, design: .monospaced)).foregroundStyle(red)
            Text(text).font(.system(size: 16)).foregroundStyle(.white.opacity(0.85))
        }
    }
}
