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
    /// Filled with where other phones are on screen (See Through only).
    var indicators: IndicatorStore?

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
        if let indicators { c.publishIndicators(view: view, feeds: feeds, into: indicators) }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, ARSCNViewDelegate {
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

        /// Projects each phone's marker to the screen; phones outside the view
        /// are pinned to the edge in their direction.
        func publishIndicators(view: ARSCNView, feeds: [String: RemoteFeed], into store: IndicatorStore) {
            guard let camera = view.pointOfView else { return }
            let bounds = view.bounds.insetBy(dx: 70, dy: 120)
            let centre = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
            var items: [IndicatorStore.Item] = []
            for (id, node) in windows where !node.isHidden {
                guard let marker = node.childNode(withName: "marker", recursively: false), let feed = feeds[id] else { continue }
                let world = marker.simdWorldPosition
                let p = view.projectPoint(SCNVector3(world))
                var point = CGPoint(x: CGFloat(p.x), y: CGFloat(p.y))
                // Behind the camera the projection mirrors; flip it back.
                let behind = simd_dot(world - camera.simdWorldPosition, camera.simdWorldFront) < 0
                if behind { point = CGPoint(x: 2 * centre.x - point.x, y: 2 * centre.y - point.y) }
                let onScreen = !behind && bounds.contains(point)
                let angle = atan2(point.y - centre.y, point.x - centre.x)
                if !onScreen {
                    // Walk out from the centre to the inset edge along that direction.
                    let dx = cos(angle), dy = sin(angle)
                    let sx = dx == 0 ? .infinity : (bounds.width / 2) / abs(dx)
                    let sy = dy == 0 ? .infinity : (bounds.height / 2) / abs(dy)
                    let r = min(sx, sy)
                    point = CGPoint(x: centre.x + dx * r, y: centre.y + dy * r)
                }
                items.append(.init(id: id, name: feed.name, point: point, onScreen: onScreen, angle: angle,
                                   distance: simd_distance(world, camera.simdWorldPosition)))
            }
            items.sort { $0.name < $1.name }
            DispatchQueue.main.async { if store.items != items { store.items = items } }
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
