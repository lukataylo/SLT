import SceneKit
import SwiftUI

/// SceneKit three-quarter view of the floor plan: walls extruded to room
/// height (outlines brighter the more scans confirmed them), the origin cross,
/// and phones as markers with view cones. Mirrors client/src/minimap3d.js.
struct FloorPlanScene: UIViewRepresentable {
    enum Origin { case fixed, session }

    var walls: [[Float]]
    var seen: [Int]
    var openings: [Opening] = []
    var floor: [SIMD2<Float>] = []
    /// Outline of the linked floor-plan room: what this room should become.
    var target: [WallSegment] = []
    var me: Mark?
    var peers: [Mark]
    var origin: Origin?

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView(frame: .zero)
        view.scene = context.coordinator.scene
        view.pointOfView = context.coordinator.camera
        view.backgroundColor = .clear
        view.antialiasingMode = .multisampling4X
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: SCNView, context: Context) {
        context.coordinator.update(self)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        let scene = SCNScene()
        let camera = SCNNode()
        private let wallsNode = SCNNode()
        private let originNode = SCNNode()
        private let meNode = Coordinator.marker(color: Coordinator.red)
        private var peerNodes: [SCNNode] = []
        private var lastWalls: [[Float]]?
        private var lastSeen: [Int] = []
        private var lastExtras: ([Opening], [SIMD2<Float>], [WallSegment])?
        private let extrasNode = SCNNode()
        private var lastOrigin: Origin??

        static let red = UIColor(red: 0.843, green: 0.098, blue: 0.129, alpha: 1)
        private static let wallHeight: Float = 2.6

        init() {
            camera.camera = SCNCamera()
            camera.camera?.fieldOfView = 32
            camera.camera?.zNear = 0.1
            camera.camera?.zFar = 500
            scene.rootNode.addChildNode(camera)
            scene.rootNode.addChildNode(wallsNode)
            scene.rootNode.addChildNode(originNode)
            scene.rootNode.addChildNode(extrasNode)
            scene.rootNode.addChildNode(meNode)
            frame(minX: -3, maxX: 3, minZ: -3, maxZ: 3)
        }

        func update(_ plan: FloorPlanScene) {
            if plan.walls != lastWalls || plan.seen != lastSeen {
                lastWalls = plan.walls
                lastSeen = plan.seen
                rebuildWalls(plan.walls, seen: plan.seen, include: plan.origin != nil)
            }
            if lastExtras.map({ $0.0 != plan.openings || $0.1 != plan.floor || $0.2 != plan.target }) ?? true {
                lastExtras = (plan.openings, plan.floor, plan.target)
                rebuildExtras(plan.openings, floor: plan.floor, target: plan.target)
            }
            if plan.origin != lastOrigin {
                lastOrigin = plan.origin
                rebuildOrigin(plan.origin)
            }
            meNode.isHidden = plan.me == nil
            if let me = plan.me { place(meNode, me) }
            while peerNodes.count < plan.peers.count {
                let node = Coordinator.marker(color: .white)
                scene.rootNode.addChildNode(node)
                peerNodes.append(node)
            }
            for (i, node) in peerNodes.enumerated() {
                node.isHidden = i >= plan.peers.count
                if i < plan.peers.count { place(node, plan.peers[i]) }
            }
        }

        private func place(_ node: SCNNode, _ mark: Mark) {
            node.position = SCNVector3(mark.x, 0, mark.z)
            node.eulerAngles.y = mark.yaw
        }

        private func rebuildWalls(_ walls: [[Float]], seen: [Int], include origin: Bool) {
            wallsNode.childNodes.forEach { $0.removeFromParentNode() }
            var minX: Float = origin ? 0 : .infinity, maxX: Float = origin ? 0 : -.infinity
            var minZ: Float = origin ? 0 : .infinity, maxZ: Float = origin ? 0 : -.infinity
            // Outline segments grouped by confirmation level: 1, 2, 3+ scans.
            var outlines: [[SCNVector3]] = [[], [], []]
            let h = Coordinator.wallHeight
            for (i, w) in walls.enumerated() {
                let (x1, z1, x2, z2) = (w[0], w[1], w[2], w[3])
                minX = min(minX, x1, x2); maxX = max(maxX, x1, x2)
                minZ = min(minZ, z1, z2); maxZ = max(maxZ, z1, z2)
                let level = min(max(i < seen.count ? seen[i] : 1, 1), 3) - 1
                let a0 = SCNVector3(x1, 0, z1), b0 = SCNVector3(x2, 0, z2)
                let a1 = SCNVector3(x1, h, z1), b1 = SCNVector3(x2, h, z2)
                outlines[level] += [a0, b0, a1, b1, a0, a1, b0, b1]

                let length = CGFloat(hypot(x2 - x1, z2 - z1))
                let box = SCNBox(width: length, height: CGFloat(h), length: 0.06, chamferRadius: 0)
                box.materials = [Coordinator.material(UIColor.white.withAlphaComponent(0.07))]
                let node = SCNNode(geometry: box)
                node.position = SCNVector3((x1 + x2) / 2, h / 2, (z1 + z2) / 2)
                node.eulerAngles.y = -atan2(z2 - z1, x2 - x1)
                wallsNode.addChildNode(node)
            }
            for (level, alpha) in [0.45, 0.75, 1.0].enumerated() where !outlines[level].isEmpty {
                wallsNode.addChildNode(Coordinator.lines(outlines[level], color: UIColor.white.withAlphaComponent(alpha)))
            }
            guard minX.isFinite else { return }
            wallsNode.addChildNode(Coordinator.dots(minX: minX - 1, maxX: maxX + 1, minZ: minZ - 1, maxZ: maxZ + 1))
            frame(minX: minX - 1, maxX: maxX + 1, minZ: minZ - 1, maxZ: maxZ + 1)
        }

        /// Floor outline as a faint slab, doors (red) and windows (white) as
        /// frames in their walls, and the linked plan room as a dashed target.
        private func rebuildExtras(_ openings: [Opening], floor: [SIMD2<Float>], target: [WallSegment]) {
            extrasNode.childNodes.forEach { $0.removeFromParentNode() }
            if floor.count >= 3 {
                let pts = floor.map { SCNVector3($0.x, 0.005, $0.y) }
                let indices: [Int32] = (1..<Int32(pts.count - 1)).flatMap { i -> [Int32] in [0, i, i + 1] }
                let slab = SCNGeometry(sources: [SCNGeometrySource(vertices: pts)], elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)])
                slab.materials = [Coordinator.material(UIColor.white.withAlphaComponent(0.07))]
                extrasNode.addChildNode(SCNNode(geometry: slab))
                extrasNode.addChildNode(Coordinator.lines(pts.indices.flatMap { [pts[$0], pts[($0 + 1) % pts.count]] }, color: UIColor.white.withAlphaComponent(0.35)))
            }
            for kind in ["door", "window"] {
                let frames = openings.filter { $0.kind == kind }.flatMap { o -> [SCNVector3] in
                    let a0 = SCNVector3(o.a.x, o.y0, o.a.y), b0 = SCNVector3(o.b.x, o.y0, o.b.y)
                    let a1 = SCNVector3(o.a.x, o.y1, o.a.y), b1 = SCNVector3(o.b.x, o.y1, o.b.y)
                    return [a0, b0, a1, b1, a0, a1, b0, b1]
                }
                if !frames.isEmpty { extrasNode.addChildNode(Coordinator.lines(frames, color: kind == "door" ? Coordinator.red : .white)) }
            }
            // Dashed target outline: short pieces every 0.4 m.
            var dashes: [SCNVector3] = []
            for w in target {
                let n = max(1, Int(w.length / 0.4))
                for i in 0..<n where i % 2 == 0 {
                    let p0 = w.a + (w.b - w.a) * Float(i) / Float(n), p1 = w.a + (w.b - w.a) * Float(i + 1) / Float(n)
                    dashes += [SCNVector3(p0.x, 0.02, p0.y), SCNVector3(p1.x, 0.02, p1.y)]
                }
            }
            if !dashes.isEmpty { extrasNode.addChildNode(Coordinator.lines(dashes, color: Coordinator.red.withAlphaComponent(0.8))) }
        }

        /// Fixed map origin in red; before alignment, this session's own
        /// start point in grey.
        private func rebuildOrigin(_ origin: Origin?) {
            originNode.childNodes.forEach { $0.removeFromParentNode() }
            guard let origin else { return }
            let color = origin == .fixed ? Coordinator.red : UIColor(white: 0.55, alpha: 1)
            originNode.addChildNode(Coordinator.lines([
                SCNVector3(-0.8, 0, 0), SCNVector3(0.8, 0, 0),
                SCNVector3(0, 0, -0.8), SCNVector3(0, 0, 0.8),
                SCNVector3(0, 0, 0), SCNVector3(0, 1, 0),
            ], color: color))
            let ring = SCNTorus(ringRadius: 0.4, pipeRadius: 0.04)
            ring.materials = [Coordinator.material(color)]
            originNode.addChildNode(SCNNode(geometry: ring))
        }

        private func frame(minX: Float, maxX: Float, minZ: Float, maxZ: Float) {
            let cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2
            let span = max(maxX - minX, maxZ - minZ, 4)
            let dist = span / (2 * tan(16 * .pi / 180)) * 1.05
            camera.position = SCNVector3(cx, dist * 0.68, cz + dist * 0.78)
            camera.look(at: SCNVector3(cx, 0, cz + span * 0.04))
        }

        // MARK: geometry helpers

        static func material(_ color: UIColor) -> SCNMaterial {
            let m = SCNMaterial()
            m.lightingModel = .constant
            m.diffuse.contents = color
            m.isDoubleSided = true
            m.writesToDepthBuffer = color.cgColor.alpha >= 1
            return m
        }

        static func lines(_ points: [SCNVector3], color: UIColor) -> SCNNode {
            let element = SCNGeometryElement(indices: (0..<Int32(points.count)).map { $0 }, primitiveType: .line)
            let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: points)], elements: [element])
            geometry.materials = [material(color)]
            return SCNNode(geometry: geometry)
        }

        static func dots(minX: Float, maxX: Float, minZ: Float, maxZ: Float) -> SCNNode {
            var points: [SCNVector3] = []
            var x = minX.rounded(.up)
            while x <= maxX {
                var z = minZ.rounded(.up)
                while z <= maxZ {
                    points.append(SCNVector3(x, 0, z))
                    z += 1
                }
                x += 1
            }
            let element = SCNGeometryElement(indices: (0..<Int32(points.count)).map { $0 }, primitiveType: .point)
            element.pointSize = 2
            element.minimumPointScreenSpaceRadius = 1
            element.maximumPointScreenSpaceRadius = 1.5
            let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: points)], elements: [element])
            geometry.materials = [material(UIColor.white.withAlphaComponent(0.3))]
            return SCNNode(geometry: geometry)
        }

        /// A phone: post with a dot at floor and head height, and a flat view
        /// cone pointing down -Z (forward at yaw 0).
        static func marker(color: UIColor) -> SCNNode {
            let node = SCNNode()
            for y: Float in [0.22, 1.4] {
                let dot = SCNNode(geometry: SCNSphere(radius: 0.22))
                dot.geometry?.materials = [material(color)]
                dot.position.y = y
                node.addChildNode(dot)
            }
            node.addChildNode(lines([SCNVector3(0, 0.22, 0), SCNVector3(0, 1.4, 0)], color: color))
            var fan = [SCNVector3(0, 0.01, 0)]
            for i in 0...10 {
                let a = -0.45 + 0.9 * Float(i) / 10
                fan.append(SCNVector3(-sin(a) * 1.4, 0.01, -cos(a) * 1.4))
            }
            let indices: [Int32] = (1..<Int32(fan.count - 1)).flatMap { i -> [Int32] in [0, i, i + 1] }
            let cone = SCNGeometry(sources: [SCNGeometrySource(vertices: fan)], elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)])
            cone.materials = [material(color.withAlphaComponent(0.3))]
            node.addChildNode(SCNNode(geometry: cone))
            return node
        }
    }
}
