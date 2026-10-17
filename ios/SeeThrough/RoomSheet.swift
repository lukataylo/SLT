import SwiftUI

private let red = Color(red: 0.843, green: 0.098, blue: 0.129)

/// Rooms: switch between them, start a new one here (optionally linked to a
/// room drawn on the uploaded floor plan), reset the current room, or reset
/// the whole map.
struct RoomSheet: View {
    @ObservedObject var relay: RelayClient
    @Environment(\.dismiss) private var dismiss
    @State private var newName = ""
    @State private var planRoomId: String?
    @State private var confirmRoomReset = false
    @State private var confirmMapReset = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(relay.rooms) { room in
                        Button {
                            relay.switchRoom(room.id)
                            dismiss()
                        } label: {
                            HStack {
                                Circle().fill(room.id == relay.roomId ? red : Color.white.opacity(0.2)).frame(width: 8, height: 8)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(room.name.uppercased()).mono(13, weight: .bold)
                                    Text("\(room.walls.count) WALLS · \(room.openings.filter { $0.kind == "door" }.count) DOORS · \(room.openings.filter { $0.kind == "window" }.count) WIN")
                                        .mono(9).foregroundStyle(.gray)
                                }
                                Spacer()
                                if room.id == relay.roomId { Text("HERE").mono(9, weight: .bold).foregroundStyle(red) }
                            }
                        }
                        .foregroundStyle(.white)
                    }
                    if relay.rooms.isEmpty {
                        Text("The first room is created when your scan founds the map.").font(.footnote).foregroundStyle(.gray)
                    }
                } header: { Text("ROOMS").mono(10) }

                Section {
                    TextField("Room name", text: $newName).textInputAutocapitalization(.words)
                    if let plan = relay.plan, !plan.rooms.isEmpty {
                        Picker(selection: $planRoomId) {
                            Text("Not linked").tag(String?.none)
                            ForEach(plan.rooms) { Text($0.name).tag(Optional($0.id)) }
                        } label: {
                            Text("FLOOR PLAN ROOM").mono(10)
                        }
                        .onChange(of: planRoomId) { _, id in
                            if newName.isEmpty, let name = plan.rooms.first(where: { $0.id == id })?.name { newName = name }
                        }
                        if plan.placement == nil {
                            Text("The plan isn't placed on the map yet; it snaps into place once enough walls are scanned.")
                                .font(.footnote).foregroundStyle(.gray)
                        }
                    }
                    Button {
                        relay.newRoom(name: newName.trimmingCharacters(in: .whitespaces), planRoomId: planRoomId)
                        dismiss()
                    } label: {
                        Text("START NEW ROOM HERE").mono(12, weight: .bold).frame(maxWidth: .infinity)
                    }
                    .disabled(!relay.alignment.aligned)
                } header: {
                    Text("NEW ROOM").mono(10)
                } footer: {
                    Text("Its origin is where you're standing. Walls scanned from now on belong to it.").font(.footnote)
                }

                Section {
                    Button("RESET THIS ROOM", role: .destructive) { confirmRoomReset = true }
                        .disabled(relay.currentRoom == nil)
                    Button("RESET ENTIRE MAP", role: .destructive) { confirmMapReset = true }
                } header: { Text("RESET").mono(10) }
            }
            .navigationTitle("Rooms")
            .toolbar { Button("Done") { dismiss() } }
            .confirmationDialog("Clear every wall, door, window and point scanned in \(relay.currentRoom?.name ?? "this room")? The room and the map origin stay.",
                                isPresented: $confirmRoomReset, titleVisibility: .visible) {
                Button("Reset room", role: .destructive) {
                    relay.resetRoom()
                    dismiss()
                }
            }
            .confirmationDialog("Delete all rooms and the fixed origin for everyone? The next scan founds a new map.",
                                isPresented: $confirmMapReset, titleVisibility: .visible) {
                Button("Reset entire map", role: .destructive) {
                    relay.resetMap()
                    dismiss()
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}
