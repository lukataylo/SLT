import ARKit
import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit
import Vision

/// What a pairing QR code carries: where the server is (so a brand-new phone
/// needs no setup), a one-off code, and the code's printed size on screen.
struct PairingPayload: Equatable {
    var server: URL
    var code: String
    /// Physical width of the whole QR image (including its margin), metres.
    var width: Float

    var string: String {
        var c = URLComponents()
        c.scheme = "slt"
        c.host = "pair"
        c.queryItems = [
            URLQueryItem(name: "s", value: server.absoluteString),
            URLQueryItem(name: "c", value: code),
            URLQueryItem(name: "w", value: String(format: "%.4f", width)),
        ]
        return c.string ?? ""
    }

    init(server: URL, code: String, width: Float) {
        self.server = server
        self.code = code
        self.width = width
    }

    init?(string: String) {
        guard let c = URLComponents(string: string), c.scheme == "slt", c.host == "pair",
              let s = c.queryItems?.first(where: { $0.name == "s" })?.value, let server = URL(string: s),
              let code = c.queryItems?.first(where: { $0.name == "c" })?.value,
              let w = c.queryItems?.first(where: { $0.name == "w" })?.value.flatMap(Float.init), w > 0.005, w < 0.5
        else { return nil }
        self.init(server: server, code: code, width: w)
    }
}

/// QR pairing geometry. Phone A shows a code; phone B sees it with its camera.
/// A knows where its own screen (and so the code) is on the map; B measures
/// the same code in its own frame with ARKit image tracking. One physical
/// code, two poses: B's alignment onto the map follows directly.
enum QRPairing {
    static func newCode() -> String {
        String((0..<8).map { _ in "abcdefghjkmnpqrstuvwxyz23456789".randomElement()! })
    }

    /// The QR image, one pixel per module. Both phones generate it from the
    /// same text, so B's reference image matches what A displays exactly.
    static func image(for text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }

    static func referenceImage(for payload: PairingPayload) -> ARReferenceImage? {
        guard let cg = image(for: payload.string) else { return nil }
        let ref = ARReferenceImage(cg, orientation: .up, physicalWidth: CGFloat(payload.width))
        ref.name = payload.code
        return ref
    }

    /// Screen points to metres. Pixel density for the iPhone Pro Max class
    /// (≈460 ppi); a few percent off only shifts the result by centimetres.
    static func metres(points: CGFloat) -> Float {
        let ppi: CGFloat = 460
        return Float(points * UIScreen.main.nativeScale / ppi * 0.0254)
    }

    /// Where the centre of the screen is relative to the rear wide camera, in
    /// ARKit camera space (landscape-right sensor axes: +x toward the phone's
    /// bottom edge, +y toward its right edge seen from the front, +z out of
    /// the screen). The camera sits near the top-right corner seen from the
    /// front; the screen is ~9 mm in front of the lens.
    static let screenCentreFromCamera = SIMD3<Float>(0.064, -0.022, 0.009)

    /// Pose of the displayed code in camera space, given where its centre is
    /// on screen (points from the screen centre, x right, y down).
    /// Image-anchor axes: x = image right, y = out of the image, z = image down.
    static func codeInCamera(offsetFromScreenCentre o: CGPoint) -> simd_float4x4 {
        let centre = screenCentreFromCamera + SIMD3(metres(points: o.y), metres(points: o.x), 0)
        return simd_float4x4(columns: (
            SIMD4(0, 1, 0, 0), // image right = phone's right edge = camera +y
            SIMD4(0, 0, 1, 0), // out of the image = camera +z
            SIMD4(1, 0, 0, 0), // image down = phone's bottom = camera +x
            SIMD4(centre, 1)
        ))
    }

    /// B's alignment: the transform that puts B's view of the code onto A's.
    static func alignment(codeOnMap: simd_float4x4, codeInOurFrame: simd_float4x4) -> FloorTransform {
        FloorTransform(matrix: codeOnMap * codeInOurFrame.inverse)
    }

    static func columnMajor(_ m: simd_float4x4) -> [Double] {
        [m.columns.0, m.columns.1, m.columns.2, m.columns.3].flatMap { [Double($0.x), Double($0.y), Double($0.z), Double($0.w)] }
    }

    static func matrix(columnMajor v: [Double]) -> simd_float4x4? {
        guard v.count == 16 else { return nil }
        let f = v.map(Float.init)
        return simd_float4x4(columns: (SIMD4(f[0], f[1], f[2], f[3]), SIMD4(f[4], f[5], f[6], f[7]),
                                       SIMD4(f[8], f[9], f[10], f[11]), SIMD4(f[12], f[13], f[14], f[15])))
    }

    /// Reads a pairing code from a camera frame, if one is in view.
    static func detect(in pixelBuffer: CVPixelBuffer) -> PairingPayload? {
        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        try? VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .right).perform([request])
        return request.results?.lazy.compactMap { $0.payloadStringValue.flatMap(PairingPayload.init(string:)) }.first
    }
}
