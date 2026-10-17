import SwiftUI

/// Everything adjustable, abstracted into a few clear choices.
struct SettingsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @ObservedObject var settings: Settings
    @Environment(\.dismiss) private var dismiss
    @State private var showAdvanced = false
    @State private var confirmReset = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                HStack {
                    Text("SETTINGS").font(Theme.display(34))
                    Spacer()
                    IconButton(glyph: .close, label: "Close") { dismiss() }
                }

                section("You") {
                    TextField("Your name", text: $settings.name, onCommit: model.connect)
                        .font(.system(size: 20, weight: .medium))
                        .padding(.vertical, 10)
                        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.line), alignment: .bottom)
                    Text("Others see this next to your view.").font(.footnote).foregroundStyle(Theme.muted)
                }

                section("See through") {
                    grid {
                        tile(.camera, "Share my view", $settings.shareCamera)
                        tile(.ghost, "Wall outlines", $settings.wallGhosts)
                    }
                }
                section("Scanning") {
                    grid {
                        tile(.palette, "Capture colour", $settings.captureColour)
                        tile(.mesh, "Show LiDAR mesh", $settings.showMesh)
                        tile(.planes, "Show surfaces", $settings.showPlanes)
                        tile(.haptic, "Haptics", $settings.haptics)
                    }
                }

                section("Map") {
                    Panel {
                        VStack(alignment: .leading, spacing: 8) {
                            row("Server", relay.connected ? "Connected" : "Offline")
                            row("Rooms", "\(relay.rooms.count)")
                            row("Origin", relay.originFoundedBy.map { "Set by \($0)" } ?? "Not set")
                            row("This phone", relay.alignment.aligned ? "Located" : "Not located")
                        }
                    }
                    Button { withAnimation { showAdvanced.toggle() } } label: {
                        HStack {
                            DotIcon(glyph: .server, size: 16)
                            Text("Advanced").label(10, bold: true)
                            Spacer()
                            Text(showAdvanced ? "Hide" : "Show").label(9).foregroundStyle(Theme.muted)
                        }
                    }
                    .foregroundStyle(.white)
                    if showAdvanced {
                        TextField("https://…", text: $settings.server, onCommit: model.connect)
                            .font(Theme.mono(13)).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .padding(14).background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.06)))
                        Text("Phones that pair by code join that phone's server automatically.").font(.footnote).foregroundStyle(Theme.muted)
                    }
                }

                section("Danger zone") {
                    PillButton(title: "Reset entire map", filled: false, destructive: true) { confirmReset = true }
                    Text("Deletes every room and the map's origin, for everyone.").font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            .padding(24)
        }
        .background(Color.black.ignoresSafeArea())
        .presentationBackground(.black)
        .confirmationDialog("Reset the entire map for everyone? Every room and the origin are deleted; the next scan starts a new map.",
                            isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset entire map", role: .destructive) {
                model.resetMap()
                dismiss()
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).label(10).foregroundStyle(Theme.muted)
            content()
        }
    }

    private func grid<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12, content: content)
    }

    /// A toggle as a dot-matrix icon tile: the icon lights up and a red dot
    /// shows when it's on; off, the whole tile dims.
    private func tile(_ glyph: DotGlyph, _ title: String, _ value: Binding<Bool>) -> some View {
        let on = value.wrappedValue
        return Button {
            value.wrappedValue.toggle()
            Haptics.tap()
        } label: {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top) {
                    DotIcon(glyph: glyph, size: 30, color: on ? .white : Theme.muted.opacity(0.55), dim: .white.opacity(on ? 0.12 : 0.06))
                    Spacer()
                    Text(on ? "On" : "Off").label(8, bold: true).foregroundStyle(on ? Theme.red : Theme.muted)
                }
                Text(title).label(10, bold: true).foregroundStyle(on ? .white : Theme.muted)
            }
            .padding(16)
            .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
            .background(RoundedRectangle(cornerRadius: 22).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(on ? Color.white.opacity(0.35) : Theme.line))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(on ? "On" : "Off")
    }

    private func row(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).label(9).foregroundStyle(Theme.muted)
            Spacer()
            Text(v).font(.system(size: 14))
        }
    }
}
