import ARKit
import SceneKit
import SwiftUI

/// Camera view with the LiDAR scan drawn over it: the reconstructed mesh as a
/// faint wireframe, and detected planes filled (walls brighter than floors),
/// so you can watch the room being captured and the walls being vectorised.
struct ARPreview: UIViewRepresentable {
    let session: ARSession
    /// Other phones' live video (map frame) and our alignment into the map:
    /// with x-ray on, each feed is drawn where that phone is looking, over
    /// whatever walls are in between.
    var feeds: [String: RemoteFeed] = [:]
    var feedsVersion = 0
    var alignment: FloorTransform?
    /// 0 = plain camera; towards 1 the real world darkens and other phones'
    /// views come forward.
    var xray: Double = 0
    var showMesh = true
    var showPlanes = true
    /// Map walls (map frame) drawn as faint outlines while seeing through.
    var ghostWalls: [WallSegment] = []
    /// Other people to place on screen as figures (Live), and where to put them.
    var people: [PersonMark] = []
    var figures: FigureStore?

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.session = session
        view.delegate = context.coordinator
        view.automaticallyUpdatesLighting = false
        view.rendersCameraGrain = false
        return view
    }

    func updateUIView(_ view: ARSCNView, context: Context) {
        let c = context.coordinator
        c.updateWindows(in: view.scene.rootNode, feeds: feeds, alignment: alignment, amount: xray)
        c.updateVeil(on: view.pointOfView, amount: xray)
        c.updateGhosts(in: view.scene.rootNode, walls: ghostWalls, alignment: alignment)
        for node in view.scene.rootNode.childNodes {
            if node.name == "mesh" { node.isHidden = !showMesh }
            if node.name == "plane" { node.isHidden = !showPlanes }
        }
        c.showMesh = showMesh
        c.showPlanes = showPlanes
        c.setPeople(people, alignment: alignment, bounds: view.bounds, store: figures)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, ARSCNViewDelegate {
        // People to project, set on main and read on SceneKit's render thread.
        private let peopleLock = NSLock()
        private var people: [PersonMark] = []
        private var peopleAlignment: FloorTransform?
        private var viewBounds = CGRect.zero
        private weak var figureStore: FigureStore?
        private var lastFigures: TimeInterval = 0

        func setPeople(_ people: [PersonMark], alignment: FloorTransform?, bounds: CGRect, store: FigureStore?) {
            peopleLock.lock(); defer { peopleLock.unlock() }
            self.people = people
            peopleAlignment = alignment
            viewBounds = bounds
            figureStore = store
        }

        /// Each frame (at most 30 a second): project everyone's feet (on the
        /// floor) and head (1.75 m up) into the view, for the stick figures.
        func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
            guard time - lastFigures > 1.0 / 30 else { return }
            lastFigures = time
            peopleLock.lock()
            let people = self.people, alignment = peopleAlignment, bounds = viewBounds, store = figureStore
            peopleLock.unlock()
            guard let store else { return }
            guard let alignment, let camera = renderer.pointOfView, !people.isEmpty else {
                DispatchQueue.main.async { if !store.figures.isEmpty { store.figures = [] } }
                return
            }
            let toLocal = alignment.matrix.inverse
            let centre = CGPoint(x: bounds.midX, y: bounds.midY)
            var out: [FigureStore.Figure] = []
            for p in people {
                let feet4 = toLocal * SIMD4(p.x, 0, p.z, 1), head4 = toLocal * SIMD4(p.x, 1.75, p.z, 1)
                let feet = SIMD3(feet4.x, feet4.y, feet4.z), head = SIMD3(head4.x, head4.y, head4.z)
                let pf = renderer.projectPoint(SCNVector3(feet)), ph = renderer.projectPoint(SCNVector3(head))
                let behind = simd_dot((feet + head) / 2 - camera.simdWorldPosition, camera.simdWorldFront) < 0
                var f = CGPoint(x: CGFloat(pf.x), y: CGFloat(pf.y)), h = CGPoint(x: CGFloat(ph.x), y: CGFloat(ph.y))
                if behind { // the projection mirrors behind the camera
                    f = CGPoint(x: 2 * centre.x - f.x, y: 2 * centre.y - f.y)
                    h = CGPoint(x: 2 * centre.x - h.x, y: 2 * centre.y - h.y)
                }
                let mid = CGPoint(x: (f.x + h.x) / 2, y: (f.y + h.y) / 2)
                let visible = !behind && bounds.contains(mid)
                out.append(.init(id: p.id, name: p.name, head: h, feet: f, visible: visible,
                                 angle: atan2(mid.y - centre.y, mid.x - centre.x),
                                 distance: simd_distance(camera.simdWorldPosition * SIMD3(1, 0, 1), feet * SIMD3(1, 0, 1))))
            }
            DispatchQueue.main.async { store.figures = out }
        }

        private var windows: [String: SCNNode] = [:]
        private static let windowDistance: Float = 2.5
        private static let red = UIColor(red: 0.843, green: 0.098, blue: 0.129, alpha: 1)

        var showMesh = true
        var showPlanes = true
        private var veil: SCNNode?
        private let ghosts = SCNNode()
        private var lastGhosts: ([WallSegment], FloorTransform?)?

        /// A dark sheet just in front of the camera, drawn after the world but
        /// before the windows: the x-ray "dimming" of what's in front of you.
        func updateVeil(on camera: SCNNode?, amount: Double) {
            guard let camera else { return }
            if veil == nil {
                let plane = SCNPlane(width: 4, height: 4)
                let m = SCNMaterial()
                m.lightingModel = .constant
                m.diffuse.contents = UIColor.black
                m.readsFromDepthBuffer = false
                m.writesToDepthBuffer = false
                plane.materials = [m]
                let node = SCNNode(geometry: plane)
                node.position = SCNVector3(0, 0, -0.3)
                node.renderingOrder = 90
                camera.addChildNode(node)
                veil = node
            }
            veil?.opacity = CGFloat(amount * 0.6)
            veil?.isHidden = amount < 0.01
        }

        /// The walls you're looking through, as white outlines over the veil.
        func updateGhosts(in root: SCNNode, walls: [WallSegment], alignment: FloorTransform?) {
            if ghosts.parent == nil { root.addChildNode(ghosts) }
            if let last = lastGhosts, last.0 == walls, last.1 == alignment { return }
            lastGhosts = (walls, alignment)
            ghosts.childNodes.forEach { $0.removeFromParentNode() }
            guard let alignment, !walls.isEmpty else { return }
            let toLocal = alignment.matrix.inverse
            let h: Float = 2.6
            var pts: [SCNVector3] = []
            func local(_ x: Float, _ y: Float, _ z: Float) -> SCNVector3 {
                let p = toLocal * SIMD4(x, y, z, 1)
                return SCNVector3(p.x, p.y, p.z)
            }
            for w in walls {
                let a0 = local(w.a.x, 0, w.a.y), b0 = local(w.b.x, 0, w.b.y)
                let a1 = local(w.a.x, h, w.a.y), b1 = local(w.b.x, h, w.b.y)
                pts += [a0, b0, a1, b1, a0, a1, b0, b1]
            }
            let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: pts)],
                                       elements: [SCNGeometryElement(indices: (0..<Int32(pts.count)).map { $0 }, primitiveType: .line)])
            let m = SCNMaterial()
            m.lightingModel = .constant
            m.diffuse.contents = UIColor.white.withAlphaComponent(0.55)
            m.readsFromDepthBuffer = false
            m.writesToDepthBuffer = false
            geometry.materials = [m]
            let node = SCNNode(geometry: geometry)
            node.renderingOrder = 95
            ghosts.addChildNode(node)
        }

        func updateWindows(in root: SCNNode, feeds: [String: RemoteFeed], alignment: FloorTransform?, amount: Double) {
            let visible = amount > 0.01
            let fresh = feeds.filter { Date().timeIntervalSince($0.value.receivedAt) < 5 }
            for (id, node) in windows where fresh[id] == nil || alignment == nil {
                node.removeFromParentNode()
                windows[id] = nil
            }
            guard let alignment else { return }
            // Map frame -> our ARKit frame.
            let toLocal = alignment.matrix.inverse
            let toLocalRotation = simd_quatf(angle: -alignment.yaw, axis: SIMD3(0, 1, 0))
            for (id, feed) in fresh {
                let node = windows[id] ?? makeWindow(root: root, id: id)
                node.isHidden = !visible
                node.childNode(withName: "video", recursively: false)?.opacity = CGFloat(0.35 + 0.65 * amount)
                let position = toLocal * SIMD4(feed.position, 1)
                let orientation = toLocalRotation * feed.orientation
                let height = 2 * Self.windowDistance * tan(feed.vfov * .pi / 360)
                let plane = node.childNode(withName: "video", recursively: false)!
                (plane.geometry as! SCNPlane).width = CGFloat(height * feed.aspect)
                (plane.geometry as! SCNPlane).height = CGFloat(height)
                plane.geometry?.firstMaterial?.diffuse.contents = feed.image
                plane.simdPosition = orientation.act(SIMD3(0, 0, -Self.windowDistance)) + SIMD3(position.x, position.y, position.z)
                plane.simdOrientation = orientation
                let border = node.childNode(withName: "border", recursively: false)!
                border.simdTransform = plane.simdTransform
                border.simdScale = SIMD3(height * feed.aspect, height, 1)
                let marker = node.childNode(withName: "marker", recursively: false)!
                marker.simdPosition = SIMD3(position.x, position.y, position.z)
            }
        }

        /// A video plane, a red frame round it and a dot at the phone, all
        /// drawn after everything else and ignoring depth: seen through walls.
        private func makeWindow(root: SCNNode, id: String) -> SCNNode {
            let node = SCNNode()
            let video = SCNNode(geometry: SCNPlane(width: 1, height: 1))
            video.name = "video"
            let material = SCNMaterial()
            material.lightingModel = .constant
            material.isDoubleSided = true
            material.readsFromDepthBuffer = false
            material.writesToDepthBuffer = false
            material.transparency = 0.92
            video.geometry?.materials = [material]
            video.renderingOrder = 100

            let corners: [SCNVector3] = [SCNVector3(-0.5, -0.5, 0), SCNVector3(0.5, -0.5, 0), SCNVector3(0.5, 0.5, 0), SCNVector3(-0.5, 0.5, 0)]
            let segments = (0..<4).flatMap { [corners[$0], corners[($0 + 1) % 4]] }
            let border = SCNNode(geometry: SCNGeometry(
                sources: [SCNGeometrySource(vertices: segments)],
                elements: [SCNGeometryElement(indices: (0..<Int32(segments.count)).map { $0 }, primitiveType: .line)]
            ))
            border.name = "border"
            border.renderingOrder = 101

            let marker = SCNNode(geometry: SCNSphere(radius: 0.06))
            marker.name = "marker"
            marker.renderingOrder = 101
            for n in [border, marker] {
                let m = SCNMaterial()
                m.lightingModel = .constant
                m.diffuse.contents = Self.red
                m.readsFromDepthBuffer = false
                m.writesToDepthBuffer = false
                n.geometry?.materials = [m]
            }
            node.addChildNode(video)
            node.addChildNode(border)
            node.addChildNode(marker)
            root.addChildNode(node)
            windows[id] = node
            return node
        }

        func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
            if let mesh = anchor as? ARMeshAnchor {
                let node = SCNNode(geometry: Self.wireframe(mesh.geometry))
                node.name = "mesh"
                node.isHidden = !showMesh
                return node
            }
            guard let plane = anchor as? ARPlaneAnchor,
                  let device = renderer.device,
                  let geometry = ARSCNPlaneGeometry(device: device) else { return nil }
            geometry.update(from: plane.geometry)
            let material = SCNMaterial()
            material.lightingModel = .constant
            material.isDoubleSided = true
            material.diffuse.contents = UIColor.white.withAlphaComponent(plane.alignment == .vertical ? 0.28 : 0.08)
            geometry.materials = [material]
            let node = SCNNode(geometry: geometry)
            node.name = "plane"
            node.isHidden = !showPlanes
            return node
        }

        func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
            if let mesh = anchor as? ARMeshAnchor {
                node.geometry = Self.wireframe(mesh.geometry)
                return
            }
            guard let plane = anchor as? ARPlaneAnchor, let geometry = node.geometry as? ARSCNPlaneGeometry else { return }
            geometry.update(from: plane.geometry)
        }

        private static let meshMaterial: SCNMaterial = {
            let material = SCNMaterial()
            material.lightingModel = .constant
            material.fillMode = .lines
            material.isDoubleSided = true
            material.diffuse.contents = UIColor.white.withAlphaComponent(0.22)
            return material
        }()

        /// ARKit reuses mesh buffers between updates, so copy them out.
        static func wireframe(_ g: ARMeshGeometry) -> SCNGeometry {
            let v = g.vertices
            let vertexData = Data(bytes: v.buffer.contents(), count: v.buffer.length)
            let vertices = SCNGeometrySource(
                data: vertexData, semantic: .vertex, vectorCount: v.count, usesFloatComponents: true,
                componentsPerVector: 3, bytesPerComponent: MemoryLayout<Float>.size, dataOffset: v.offset, dataStride: v.stride
            )
            let f = g.faces
            let indexData = Data(bytes: f.buffer.contents(), count: f.count * f.indexCountPerPrimitive * f.bytesPerIndex)
            let faces = SCNGeometryElement(data: indexData, primitiveType: .triangles, primitiveCount: f.count, bytesPerIndex: f.bytesPerIndex)
            let geometry = SCNGeometry(sources: [vertices], elements: [faces])
            geometry.materials = [meshMaterial]
            return geometry
        }
    }
}
