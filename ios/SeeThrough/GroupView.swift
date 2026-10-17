import SwiftUI

/// Who's where: everyone in the group, each Still or Move (settable from any
/// phone), with invite and start live.
struct GroupView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient

    private var members: [Member] {
        relay.members.sorted { a, b in
            if a.id == relay.selfId { return true }
            if b.id == relay.selfId { return false }
            return a.name < b.name
        }
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.78).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Button { model.leaveGroup() } label: { Text("Leave").label(10, bold: true).foregroundStyle(Theme.muted) }
                    Spacer()
                    IconButton(glyph: .gear, label: "Settings") { model.sheet = .settings }
                }
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(String(format: "%02d", members.count)).font(Theme.display(72))
                    Text(members.count == 1 ? "phone in\nthe group" : "phones in\nthe group").label(11, bold: true)
                }

                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(members) { row($0) }
                    }
                }
                .frame(maxHeight: 320)

                Text("Still phones stay where they're put and stream their view. They also keep everyone lined up. Move phones walk around and look through walls.")
                    .font(.system(size: 13)).foregroundStyle(Theme.muted)

                Spacer(minLength: 0)
                if members.count < 2 {
                    Text("Nobody else yet. Tap Invite and let them scan your code.").font(.footnote).foregroundStyle(Theme.muted)
                }
                PillButton(title: "Invite (show code)", filled: members.count < 2) { model.sheet = .showCode }
                    .disabled(!model.isLocated).opacity(model.isLocated ? 1 : 0.4)
                PillButton(title: "Start live", filled: members.count >= 2) { model.mode = .live }
                    .disabled(!model.isLocated).opacity(model.isLocated ? 1 : 0.4)
            }
            .padding(20)
        }
    }

    private func row(_ m: Member) -> some View {
        let isMe = m.id == relay.selfId
        return HStack(spacing: 12) {
            Circle().fill(isMe ? Theme.red : (m.online ? Color.white : Theme.muted)).frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 3) {
                Text(m.name.uppercased()).font(Theme.display(20)).lineLimit(1)
                Text(status(m, isMe: isMe)).label(8).foregroundStyle(m.located ? Theme.muted : Theme.red)
            }
            Spacer()
            roleSwitch(m)
        }
        .padding(.vertical, 12)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.line), alignment: .bottom)
        .opacity(m.online ? 1 : 0.45)
    }

    private func status(_ m: Member, isMe: Bool) -> String {
        if !m.online { return "Offline" }
        if !m.located { return isMe ? "You · not placed yet" : "Not placed yet" }
        return isMe ? "You · placed" : (m.live ? "Placed · live" : "Placed")
    }

    private func roleSwitch(_ m: Member) -> some View {
        HStack(spacing: 2) {
            ForEach(["move", "still"], id: \.self) { role in
                Button { model.setRole(role, for: m.id) } label: {
                    Text(role == "move" ? "Move" : "Still").label(9, bold: true)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .foregroundStyle(m.role == role ? .black : Theme.muted)
                        .background(Capsule().fill(m.role == role ? Color.white : Color.clear))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(m.name): \(role == "move" ? "Move" : "Still")")
                .accessibilityAddTraits(m.role == role ? .isSelected : [])
            }
        }
        .padding(3)
        .overlay(Capsule().stroke(Theme.line))
    }
}
