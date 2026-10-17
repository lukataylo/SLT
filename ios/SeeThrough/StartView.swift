import SwiftUI

/// First screen: your name, then create a group or join one.
struct StartView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @ObservedObject var settings: Settings
    @FocusState private var nameFocused: Bool
    @State private var name = ""

    private var nameOK: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        ZStack {
            Color.black.opacity(0.7).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Circle().fill(relay.connected ? Theme.red : Theme.muted).frame(width: 8, height: 8)
                    Text(relay.connected ? "Connected" : "Connecting").label(10, bold: true)
                    Spacer()
                    IconButton(glyph: .gear, label: "Settings") { model.sheet = .settings }
                }
                Spacer()
                // Smaller while typing, and never truncated: the keyboard takes half the screen.
                Text("HIVE\nVISION").font(Theme.display(nameFocused ? 34 : 58)).lineSpacing(-6)
                    .fixedSize(horizontal: false, vertical: true)
                    .animation(.snappy, value: nameFocused)
                Text("What's your name?").label(10).foregroundStyle(Theme.muted)
                TextField("", text: $name, prompt: Text("Your name").foregroundStyle(Theme.muted))
                    .font(Theme.display(30))
                    .focused($nameFocused)
                    .textInputAutocapitalization(.words)
                    .submitLabel(.done)
                    .padding(.bottom, 8)
                    .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.line), alignment: .bottom)
                Text("Other phones see this name.").font(.footnote).foregroundStyle(Theme.muted)

                if let by = relay.groupBlockedBy {
                    Panel {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("\(by.uppercased())'S GROUP IS RUNNING").font(Theme.display(20))
                            Text("Only one group at a time. Join it by scanning the code on \(by)'s phone.")
                                .font(.system(size: 14)).foregroundStyle(Theme.muted)
                        }
                    }
                }

                PillButton(title: "Create a group") { go { model.createGroup() } }
                    .disabled(!nameOK || !relay.connected).opacity(nameOK && relay.connected ? 1 : 0.4)
                PillButton(title: "Join a group", filled: false) { go { model.joinGroup() } }
                    .disabled(!nameOK).opacity(nameOK ? 1 : 0.4)
                Text("Create on one phone. Join from the others by scanning its code.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
            .padding(20)
        }
        .onAppear {
            // A fresh install's device name ("iPhone") isn't a name.
            name = settings.name.lowercased().hasPrefix("iphone") ? "" : settings.name
            if name.isEmpty { nameFocused = true }
        }
    }

    /// Saves the name (reconnecting so the server shows it), then continues.
    private func go(_ next: @escaping () -> Void) {
        nameFocused = false
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if trimmed != settings.name {
            settings.name = trimmed
            model.connect() // the relay holds a create until the new connection is up
        }
        next()
    }
}

/// Creating a group: find the floor; the group exists once this phone is placed.
struct CreatingView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var capture: ARCapture

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                IconButton(glyph: .back, label: "Cancel") { model.cancelCreate() }
                Spacer()
            }
            Spacer()
            Panel {
                VStack(alignment: .leading, spacing: 10) {
                    Text(capture.scan.floorY == nil ? "POINT AT THE FLOOR" : "CREATING GROUP").font(Theme.display(26))
                    Text(capture.scan.floorY == nil
                         ? "Move the phone slowly over the floor. Everyone in the group is measured from it. About 2 seconds."
                         : "Floor found. Setting up the group…")
                        .font(.system(size: 15)).foregroundStyle(Theme.muted)
                    HStack(spacing: 8) {
                        DotIcon(glyph: capture.scan.floorY == nil ? .close : .check, size: 18,
                                color: capture.scan.floorY == nil ? Theme.muted : .white)
                        Text("Floor").label(9).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
        .padding(16)
    }
}
