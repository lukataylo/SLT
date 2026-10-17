import ARKit
import SceneKit
import SwiftUI

/// Camera view with each detected plane drawn over it: walls in white, floor
/// as a faint dot field, so you can watch the walls being vectorised.
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
            guard let plane = anchor as? ARPlaneAnchor, let geometry = node.geometry as? ARSCNPlaneGeometry else { return }
            geometry.update(from: plane.geometry)
        }
    }
}
