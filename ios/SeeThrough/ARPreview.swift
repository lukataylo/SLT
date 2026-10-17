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
    var xray = true

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.session = session
        view.delegate = context.coordinator
        view.automaticallyUpdatesLighting = false
        view.rendersCameraGrain = false
        return view
    }

    func updateUIView(_ view: ARSCNView, context: Context) {
        context.coordinator.updateWindows(in: view.scene.rootNode, feeds: feeds, alignment: alignment, visible: xray)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, ARSCNViewDelegate {
        private var windows: [String: SCNNode] = [:]
        private static let windowDistance: Float = 2.5
        private static let red = UIColor(red: 0.843, green: 0.098, blue: 0.129, alpha: 1)

        func updateWindows(in root: SCNNode, feeds: [String: RemoteFeed], alignment: FloorTransform?, visible: Bool) {
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
                return SCNNode(geometry: Self.wireframe(mesh.geometry))
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
            return SCNNode(geometry: geometry)
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
