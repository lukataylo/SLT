import SwiftUI

/// Where each other phone is on screen, so See Through can point at the
/// ones outside the view.
final class IndicatorStore: ObservableObject {
    struct Item: Identifiable, Equatable {
        var id: String
        var name: String
        /// Screen point (view coordinates) of the phone, or for phones out of
        /// view the point on the screen edge in its direction.
        var point: CGPoint
        var onScreen: Bool
        /// Direction from the screen centre, radians (0 = right, π/2 = down).
        var angle: CGFloat
        var distance: Float
    }

    @Published var items: [Item] = []
}

/// Name tags on visible phones and edge arrows towards the rest.
struct IndicatorOverlay: View {
    @ObservedObject var store: IndicatorStore

    var body: some View {
        ZStack {
            ForEach(store.items) { item in
                Group {
                    if item.onScreen {
                        tag(item).position(x: item.point.x, y: item.point.y - 26)
                    } else {
                        HStack(spacing: 8) {
                            Image(systemName: "arrowtriangle.right.fill")
                                .font(.system(size: 11))
                                .rotationEffect(.radians(item.angle))
                                .foregroundStyle(Theme.red)
                            Text(item.name).label(9, bold: true)
                            Text(String(format: "%.0f m", item.distance)).label(9).foregroundStyle(Theme.muted)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Capsule().fill(Theme.panel))
                        .overlay(Capsule().stroke(Theme.line))
                        .position(item.point)
                    }
                }
                .animation(.easeOut(duration: 0.15), value: item.point)
            }
        }
        .allowsHitTesting(false)
    }

    private func tag(_ item: IndicatorStore.Item) -> some View {
        HStack(spacing: 6) {
            Circle().fill(Theme.red).frame(width: 6, height: 6)
            Text(item.name).label(9, bold: true)
            Text(String(format: "%.0f m", item.distance)).label(9).foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Capsule().fill(Theme.panel))
    }
}
