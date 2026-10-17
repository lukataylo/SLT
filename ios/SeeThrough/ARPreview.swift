import ARKit
import SceneKit
import SwiftUI

/// Camera view with the LiDAR scan drawn over it: the reconstructed mesh as a
/// faint wireframe, and detected planes filled (walls brighter than floors),
/// so you can watch the room being captured and the walls being vectorised.
struct ARPreview: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.session = session
        view.delegate = context.coordinator
        view.automaticallyUpdatesLighting = false
        view.rendersCameraGrain = false
        return view
    }

    func updateUIView(_ view: ARSCNView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, ARSCNViewDelegate {
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
