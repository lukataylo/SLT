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
    @StateObject private var indicators = IndicatorStore()

    var body: some View {
        ZStack {
            ARPreview(
                session: capture.session,
                feeds: model.mode == .seeThrough ? relay.feeds : [:],
                feedsVersion: relay.feedsVersion,
                alignment: relay.alignment.aligned ? relay.alignment.transform : nil,
                xray: model.mode == .seeThrough ? settings.xray : 0,
                showMesh: model.mode == .scan && settings.showMesh,
                showPlanes: model.mode == .scan && settings.showPlanes,
                ghostWalls: model.mode == .seeThrough && settings.wallGhosts ? relay.allWalls : [],
                indicators: model.mode == .seeThrough ? indicators : nil
            )
            .ignoresSafeArea()

            if model.mode == .seeThrough { IndicatorOverlay(store: indicators).ignoresSafeArea() }

            switch model.mode {
            case .home: HomeView(model: model, relay: relay)
            case .scan: ScanView(model: model, relay: relay, capture: capture)
            case .seeThrough: SeeThroughView(model: model, relay: relay, settings: settings)
            case .pairScan: PairScanView(model: model)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: model.mode)
        .sheet(item: $model.sheet) { sheet in
            switch sheet {
            case .rooms: RoomPickerView(model: model, relay: relay)
            case .showCode: ShowCodeView(model: model, relay: relay, capture: capture)
            case .settings: SettingsView(model: model, relay: relay, settings: settings)
            }
        }
    }
}
