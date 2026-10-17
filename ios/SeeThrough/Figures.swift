import SwiftUI
import simd

/// Another phone, for drawing its person: where they stand on the map.
struct PersonMark: Equatable {
    var id: String
    var name: String
    var x: Float
    var z: Float
}

/// Where each person is on screen this frame, from ARKit's camera.
final class FigureStore: ObservableObject {
    struct Figure: Identifiable, Equatable {
        var id: String
        var name: String
        var head: CGPoint
        var feet: CGPoint
        /// On screen (and in front of the camera).
        var visible: Bool
        /// Direction from the screen centre, radians (0 = right, π/2 = down).
        var angle: CGFloat
        var distance: Float
    }

    @Published var figures: [Figure] = []
}

/// A person drawn between head and feet points: x-ray style when there's a
/// wall between you (dashed and glowing), solid when you can see them.
struct StickFigure: View {
    var head: CGPoint
    var feet: CGPoint
    var behindWall: Bool
    var selected: Bool

    var body: some View {
        Canvas { ctx, _ in
            let h = max(feet.y - head.y, 24)
            let x = (head.x + feet.x) / 2
            func p(_ dx: CGFloat, _ fy: CGFloat) -> CGPoint { CGPoint(x: x + dx * h, y: head.y + fy * h) }
            let r = h * 0.085
            var body = Path()
            body.addEllipse(in: CGRect(x: x - r, y: head.y, width: 2 * r, height: 2 * r))
            body.move(to: p(0, 0.19)); body.addLine(to: p(0, 0.56))            // spine
            body.move(to: p(-0.17, 0.48)); body.addLine(to: p(0, 0.27))        // arms
            body.addLine(to: p(0.17, 0.48))
            body.move(to: p(-0.12, 1)); body.addLine(to: p(0, 0.56))           // legs
            body.addLine(to: p(0.12, 1))
            let colour: Color = selected ? Theme.red : .white
            let style = StrokeStyle(lineWidth: max(2, h * 0.025), lineCap: .round, lineJoin: .round,
                                    dash: behindWall ? [h * 0.04, h * 0.03] : [])
            ctx.addFilter(.shadow(color: colour.opacity(0.8), radius: behindWall ? 8 : 3))
            ctx.stroke(body, with: .color(colour), style: style)
            // Floor spot.
            ctx.stroke(Path(ellipseIn: CGRect(x: x - h * 0.14, y: feet.y - h * 0.035, width: h * 0.28, height: h * 0.07)),
                       with: .color(colour.opacity(0.6)), lineWidth: 1.5)
        }
        .allowsHitTesting(false)
    }
}
