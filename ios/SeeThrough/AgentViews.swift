import SwiftUI

/// The firefighter agent's avatar: top-right on the team screens. A red dot
/// means there are alerts you haven't seen.
struct AgentAvatar: View {
    @ObservedObject var relay: RelayClient
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                DotIcon(glyph: .helmet, size: 22)
                    .frame(width: 46, height: 46)
                    .background(Circle().fill(Theme.panel))
                    .overlay(Circle().stroke(relay.agentUnread > 0 ? Theme.red : Theme.line, lineWidth: relay.agentUnread > 0 ? 1.5 : 1))
                if relay.agentUnread > 0 {
                    Circle().fill(Theme.red).frame(width: 11, height: 11).offset(x: 1, y: -1)
                }
            }
        }
        .accessibilityLabel(relay.agentUnread > 0 ? "Field agent, \(relay.agentUnread) new alerts" : "Field agent")
    }
}

/// Talk to the field agent: alerts as they happen, a briefing on demand,
/// and questions about the team and the building.
struct AgentSheet: View {
    @ObservedObject var relay: RelayClient
    @Environment(\.dismiss) private var dismiss
    @State private var question = ""
    private let quick = ["Where's my team?", "Nearest exit?", "Who's behind a wall?"]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                DotIcon(glyph: .helmet, size: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("FIELD AGENT").font(Theme.display(26))
                    Text("Knows the map and where your team is").label(8).foregroundStyle(Theme.muted)
                }
                Spacer()
                IconButton(glyph: .close, label: "Close") { dismiss() }
            }

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        if relay.agentFeed.isEmpty {
                            Text("Alerts about your team appear here. Tap Brief me for where everyone is right now.")
                                .font(.system(size: 14)).foregroundStyle(Theme.muted)
                        }
                        ForEach(relay.agentFeed) { m in row(m).id(m.id) }
                        if relay.agentBusy {
                            HStack(spacing: 8) { ProgressView().tint(.white); Text("Thinking…").label(9).foregroundStyle(Theme.muted) }
                                .id("busy")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .onChange(of: relay.agentFeed.count) { _, _ in
                    withAnimation { proxy.scrollTo(relay.agentFeed.last?.id, anchor: .bottom) }
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(quick, id: \.self) { q in
                        Button { send(q) } label: {
                            Text(q).label(9, bold: true).padding(.horizontal, 12).padding(.vertical, 9)
                                .overlay(Capsule().stroke(Theme.line))
                        }
                        .foregroundStyle(.white)
                        .disabled(relay.agentBusy)
                    }
                }
            }
            HStack(spacing: 10) {
                TextField("", text: $question, prompt: Text("Ask the agent").foregroundStyle(Theme.muted))
                    .submitLabel(.send)
                    .onSubmit { send(question) }
                    .padding(.horizontal, 16).padding(.vertical, 13)
                    .background(Capsule().fill(Color.white.opacity(0.07)))
                PillButton(title: "Brief me") { send("") }
                    .frame(width: 150)
                    .disabled(relay.agentBusy)
            }
        }
        .padding(20)
        .background(Color.black.ignoresSafeArea())
        .presentationBackground(.black)
        .presentationDetents([.medium, .large])
        .onAppear { relay.agentUnread = 0 }
        .onChange(of: relay.agentFeed.count) { _, _ in relay.agentUnread = 0 }
    }

    private func send(_ text: String) {
        let q = text.trimmingCharacters(in: .whitespaces)
        question = ""
        Task { await relay.askAgent(q) }
    }

    private func row(_ m: RelayClient.AgentMessage) -> some View {
        let time = m.at.formatted(date: .omitted, time: .shortened)
        return Group {
            switch m.kind {
            case .event(let warn):
                HStack(alignment: .top, spacing: 8) {
                    Circle().fill(warn ? Theme.red : Color.white.opacity(0.35)).frame(width: 7, height: 7).padding(.top, 5)
                    Text(m.text).font(.system(size: 14)).foregroundStyle(warn ? .white : Theme.muted)
                    Spacer()
                    Text(time).label(8).foregroundStyle(Theme.muted)
                }
            case .question:
                HStack { Spacer(); Text(m.text).font(.system(size: 14)).padding(10)
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.1))) }
            case .answer(let source):
                VStack(alignment: .leading, spacing: 6) {
                    Text(m.text).font(.system(size: 15))
                    Text(source == "claude" ? "Agent · Claude" : source == "error" ? "Agent · offline" : "Agent · live data").label(7).foregroundStyle(Theme.muted)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14).fill(Theme.panel))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.red.opacity(0.4)))
            }
        }
    }
}
