import SwiftUI

/// Pick the room to scan, or start a new one (optionally the counterpart of
/// a room on the uploaded floor plan). Long-press a room to reset its scan.
struct RoomPickerView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @Environment(\.dismiss) private var dismiss
    @State private var creating = false
    @State private var name = ""
    @State private var planRoomId: String?
    @State private var resetting: MapRoom?
    @FocusState private var nameFocused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("PICK A ROOM").font(Theme.display(32))
                    Spacer()
                    IconButton(glyph: .close, label: "Close") { dismiss() }
                }
                .padding(.bottom, 6)

                if !model.isLocated && model.mapExists {
                    Text("This phone isn't located on the map yet. You'll be asked to locate it before scanning.")
                        .font(.system(size: 14)).foregroundStyle(Theme.muted)
                }

                ForEach(relay.rooms) { room in
                    Button { model.scan(.init(existingId: room.id, name: room.name, planRoomId: room.planRoomId)) } label: { row(room) }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("Reset \(room.name)", role: .destructive) { resetting = room }
                        }
                }

                if creating || relay.rooms.isEmpty {
                    newRoomForm
                } else {
                    Button {
                        withAnimation(.snappy) { creating = true }
                        nameFocused = true
                    } label: {
                        HStack(spacing: 14) {
                            DotIcon(glyph: .plus, size: 22)
                            Text("New room").label(12, bold: true)
                            Spacer()
                        }
                        .padding(20)
                        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [3, 5])).foregroundStyle(Theme.line))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                }

                if !relay.rooms.isEmpty {
                    Text("Long-press a room to reset its scan.").font(.footnote).foregroundStyle(Theme.muted).padding(.top, 4)
                }
            }
            .padding(24)
        }
        .background(Color.black.ignoresSafeArea())
        .presentationBackground(.black)
        .tint(.white)
        .confirmationDialog("Clear everything scanned in \(resetting?.name ?? "this room")? The room itself stays.",
                            isPresented: Binding(get: { resetting != nil }, set: { if !$0 { resetting = nil } }),
                            titleVisibility: .visible) {
            Button("Reset \(resetting?.name ?? "room")", role: .destructive) {
                if let room = resetting {
                    if relay.roomId != room.id { relay.switchRoom(room.id) }
                    relay.resetRoom()
                }
                resetting = nil
            }
        }
    }

    private var newRoomForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(relay.rooms.isEmpty ? "Your first room" : "New room").label(10).foregroundStyle(Theme.muted)
            TextField("", text: $name, prompt: Text("Name it, e.g. Kitchen").foregroundStyle(Theme.muted))
                .font(Theme.display(26))
                .focused($nameFocused)
                .textInputAutocapitalization(.words)
                .padding(.bottom, 8)
                .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.line), alignment: .bottom)
            if let plan = relay.plan, !plan.rooms.isEmpty {
                Text("On the floor plan").label(9).foregroundStyle(Theme.muted)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(plan.rooms) { room in
                            let linked = relay.rooms.contains { $0.planRoomId == room.id }
                            let selected = planRoomId == room.id
                            Button {
                                planRoomId = selected ? nil : room.id
                                if name.isEmpty || plan.rooms.contains(where: { $0.name == name }) { name = selected ? "" : room.name }
                            } label: {
                                Text(room.name).label(10, bold: true)
                                    .padding(.horizontal, 14).padding(.vertical, 9)
                                    .foregroundStyle(selected ? .black : .white)
                                    .background(Capsule().fill(selected ? Color.white : Color.clear))
                                    .overlay(Capsule().stroke(Theme.line))
                                    .opacity(linked ? 0.35 : 1)
                            }
                            .buttonStyle(.plain)
                            .disabled(linked)
                        }
                    }
                }
            }
            PillButton(title: "Scan \(name.isEmpty ? "this room" : name)") {
                model.scan(.init(existingId: nil, name: name.isEmpty ? "Room \(relay.rooms.count + 1)" : name, planRoomId: planRoomId))
            }
            Text(planRoomId != nil ? "You'll see that room's outline from the plan while you scan." : "Start standing inside the room.")
                .font(.footnote).foregroundStyle(Theme.muted)
        }
        .padding(20)
        .background(RoundedRectangle(cornerRadius: 22).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Theme.line))
    }

    private func row(_ room: MapRoom) -> some View {
        HStack(spacing: 16) {
            Circle().fill(room.id == relay.roomId ? Theme.red : Color.white.opacity(0.2)).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 6) {
                Text(room.name.uppercased()).font(Theme.display(24)).lineLimit(1)
                Text(stats(room)).label(9).foregroundStyle(Theme.muted)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 6) {
                if room.id == relay.roomId { Text("Here").label(8, bold: true).foregroundStyle(Theme.red) }
                if let plan = room.planRoomId.flatMap({ id in relay.plan?.rooms.first { $0.id == id } }) {
                    Text("Plan · \(plan.name)").label(8).foregroundStyle(Theme.muted)
                }
            }
            DotIcon(glyph: .scan, size: 18, color: .white.opacity(0.7))
        }
        .padding(20)
        .background(RoundedRectangle(cornerRadius: 22).fill(Theme.panel))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(room.id == relay.roomId ? Theme.red.opacity(0.5) : Theme.line))
        .foregroundStyle(.white)
        .contentShape(Rectangle())
    }

    private func stats(_ room: MapRoom) -> String {
        let doors = room.openings.filter { $0.kind == "door" }.count
        let windows = room.openings.filter { $0.kind == "window" }.count
        return room.walls.isEmpty ? "Not scanned yet" : "\(room.walls.count) walls · \(doors) doors · \(windows) windows"
    }
}
