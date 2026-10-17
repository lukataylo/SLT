import SwiftUI
import simd

/// Setup: scanning one room. One instruction at a time, the capture tally,
/// and the room building up in 3D.
struct ScanView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @ObservedObject var capture: ARCapture
    @State private var expanded = false
    @State private var confirmNewMap = false

    var body: some View {
        VStack(spacing: 12) {
            HStack(alignment: .center) {
                IconButton(glyph: .back, label: "Back") { model.mode = model.isLocated ? .group : .start }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Scanning").label(9).foregroundStyle(Theme.muted)
                    Text((relay.currentRoom?.name ?? model.roomIntent?.name ?? "Room").uppercased()).font(Theme.display(24)).lineLimit(1)
                }
                .padding(.leading, 6)
                Spacer()
                Button { model.mode = model.isLocated ? .group : .start } label: {
                    Text("Done").label(11, bold: true)
                        .padding(.horizontal, 18).padding(.vertical, 13)
                        .foregroundStyle(.black)
                        .background(Capsule().fill(.white))
                }
            }
            Spacer()
            floorPlan
                .frame(height: expanded ? 400 : 190)
                .onTapGesture { withAnimation(.snappy) { expanded.toggle() } }
            Panel {
                VStack(alignment: .leading, spacing: 12) {
                    Text(step.title).font(Theme.display(26))
                    Text(step.detail).font(.system(size: 15)).foregroundStyle(Theme.muted)
                    if step.offersPairing {
                        PillButton(title: "Scan a pairing code", filled: true) { model.scanCode(returnTo: .scan) }
                        // Never a dead end: the saved map may be somewhere else, or stale.
                        PillButton(title: "Start a new map here", filled: false) { confirmNewMap = true }
                    }
                    tally
                }
            }
        }
        .padding(16)
        .confirmationDialog(newMapWarning, isPresented: $confirmNewMap, titleVisibility: .visible) {
            Button("Delete it and start here", role: .destructive) {
                let intent = model.roomIntent
                model.startNewMapHere()
                // Keep going with the room the user picked: it becomes the first room.
                model.scan(intent.map { .init(existingId: nil, name: $0.name, planRoomId: $0.planRoomId) }
                           ?? .init(existingId: nil, name: "Room 1", planRoomId: nil))
            }
        }
    }

    private var newMapWarning: String {
        let rooms = relay.rooms.count
        let by = relay.originFoundedBy.map { " started by \($0)" } ?? ""
        return "This deletes the saved map\(by) (\(rooms) room\(rooms == 1 ? "" : "s")) for everyone, and starts a new one where you're standing."
    }

    private struct Step { var title: String; var detail: String; var offersPairing = false }

    /// The single next thing to do.
    private var step: Step {
        let a = relay.alignment
        if !relay.connected { return Step(title: "CONNECTING", detail: "Reaching the map server…") }
        if capture.scan.floorY == nil || a.needsFloor {
            return Step(title: "FIND THE FLOOR", detail: "Point down at the floor and move slowly. Everything is measured from it.")
        }
        if !a.aligned {
            if a.ambiguous { return Step(title: "LOCATING", detail: "These walls fit more than one place. Include a doorway or corner that makes this spot unique.", offersPairing: true) }
            return Step(title: "LOCATE THIS PHONE", detail: "Point at walls the map already has, or scan the pairing code on a phone that's located.", offersPairing: true)
        }
        if !relay.targetOutline.isEmpty { return Step(title: "FILL THE OUTLINE", detail: "Walk the room until its walls cover the dashed outline from the floor plan.") }
        if capture.scan.walls.count < 3 { return Step(title: "SWEEP THE WALLS", detail: "Move slowly along every wall, corner to corner, floor to ceiling.") }
        return Step(title: "ADD THE DETAIL", detail: "Get close to doors, windows and furniture. Tap Done when the room looks complete.")
    }

    private var tally: some View {
        let room = relay.currentRoom
        let doors = room?.openings.filter { $0.kind == "door" }.count ?? 0
        let windows = room?.openings.filter { $0.kind == "window" }.count ?? 0
        return HStack(spacing: 0) {
            check("Floor", capture.scan.floorY != nil)
            check("Located", model.isLocated)
            stat("\(room?.walls.count ?? capture.scan.walls.count)", "Walls", lit: (room?.walls.count ?? 0) >= 3)
            stat("\(doors + windows)", "Openings", lit: doors + windows > 0)
            stat(points, "Points", lit: capture.cloud.count > 0)
        }
    }

    private var points: String {
        let n = capture.cloud.count
        return n >= 1000 ? "\(n / 1000)K" : "\(n)"
    }

    private func check(_ label: String, _ done: Bool) -> some View {
        VStack(spacing: 5) {
            DotIcon(glyph: done ? .check : .close, size: 20, color: done ? .white : Theme.muted.opacity(0.6))
            Text(label).label(7).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
    }

    private func stat(_ value: String, _ label: String, lit: Bool) -> some View {
        VStack(spacing: 3) {
            Text(value).font(Theme.display(20)).foregroundStyle(lit ? .white : Theme.muted)
            Text(label).label(7).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var floorPlan: some View {
        if model.isLocated {
            let room = relay.currentRoom
            FloorPlanView(
                walls: relay.allWalls.map(\.array), seen: relay.allSeen,
                openings: relay.rooms.flatMap(\.openings), floor: room?.floor ?? [], target: relay.targetOutline,
                me: capture.localMark.map { relay.alignment.transform.apply($0) },
                peers: Array(relay.peerMarks.values), origin: .fixed,
                cloud: capture.cloud, cloudVersion: capture.cloudVersion, cloudTransform: cloudTransform(aligned: true),
                title: "\(room?.name ?? "Map") · tap to expand"
            )
        } else {
            FloorPlanView(
                walls: capture.scan.walls.map(\.array), seen: capture.scan.walls.map(\.support),
                openings: capture.scan.openings, floor: capture.scan.floor,
                me: capture.localMark, peers: [], origin: .session,
                cloud: capture.cloud, cloudVersion: capture.cloudVersion, cloudTransform: cloudTransform(aligned: false),
                title: "This phone's scan · not located"
            )
        }
    }

    /// Own-frame points onto the card: grounded on the floor, and onto the
    /// shared map once located.
    private func cloudTransform(aligned: Bool) -> simd_float4x4 {
        var ground = matrix_identity_float4x4
        ground.columns.3.y = -(capture.scan.floorY ?? 0)
        return aligned ? relay.alignment.transform.matrix : ground
    }
}
