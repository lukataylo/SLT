import SwiftUI

/// The AR camera runs underneath everything, so tracking (and with it the
/// phone's place on the map) carries across screens. Each mode puts its own
/// minimal UI on top.
struct RootView: View {
    @StateObject private var model = AppModel()

    var body: some View {
        RootContent(model: model, relay: model.relay, capture: model.capture, settings: model.settings)
            .onAppear { model.start() }
    }
}

/// Observes the one persistent model's parts directly, so each redraws the
/// screen when it changes.
private struct RootContent: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @ObservedObject var capture: ARCapture
    @ObservedObject var settings: Settings
    @StateObject private var figures = FigureStore()

    /// Other placed phones, as people to draw (Move phones in Live only).
    private var people: [PersonMark] {
        guard model.mode == .live, !model.isStill else { return [] }
        return relay.members.compactMap { m in
            guard m.id != relay.selfId, m.located, let mark = relay.peerMarks[m.id] else { return nil }
            return PersonMark(id: m.id, name: m.name, x: mark.x, z: mark.z)
        }
    }

    var body: some View {
        ZStack {
            ARPreview(
                session: capture.session,
                // Views are shown on screen (LiveView), not placed in 3D.
                alignment: relay.alignment.aligned ? relay.alignment.transform : nil,
                showMesh: (model.mode == .scan || model.mode == .floorplan) && settings.showMesh,
                showPlanes: (model.mode == .scan || model.mode == .floorplan) && settings.showPlanes,
                people: people,
                figures: figures
            )
            .ignoresSafeArea()

            switch model.mode {
            case .start: StartView(model: model, relay: relay, settings: settings)
            case .creating: CreatingView(model: model, capture: capture)
            case .group: GroupView(model: model, relay: relay)
            case .live: LiveView(model: model, relay: relay, capture: capture, figures: figures)
            case .scan: ScanView(model: model, relay: relay, capture: capture)
            case .pairScan: PairScanView(model: model)
            case .floorplan: LiveFloorPlanView(model: model, relay: relay, capture: capture, settings: settings)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: model.mode)
        .sheet(item: $model.sheet) { sheet in
            switch sheet {
            case .rooms: RoomPickerView(model: model, relay: relay)
            case .showCode: ShowCodeView(model: model, relay: relay, capture: capture)
            case .settings: SettingsView(model: model, relay: relay, settings: settings)
            case .agent: AgentSheet(relay: relay)
            case .plan: PlanSheet(model: model, relay: relay, capture: capture, settings: settings, upload: model.planUpload)
            }
        }
    }
}
