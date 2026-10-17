import PDFKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import simd

/// A floor plan drawing you can pinch, pan and tap. Marks are drawn in image
/// pixels by `marks`, which gets a function from image pixels to the view, so
/// they stay pinned to the drawing while zooming.
struct PlanCanvas: View {
    let image: UIImage
    var interactive = true
    var onTap: (CGPoint) -> Void = { _ in }
    var marks: (inout GraphicsContext, @escaping (CGPoint) -> CGPoint) -> Void = { _, _ in }

    @State private var zoom: CGFloat = 1
    @State private var zoomBase: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var panBase: CGSize = .zero

    private var pixels: CGSize { CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale) }

    var body: some View {
        GeometryReader { g in
            let size = g.size
            let fit = min(size.width / pixels.width, size.height / pixels.height)
            let centre = CGPoint(x: size.width / 2 + pan.width, y: size.height / 2 + pan.height)
            let toView = { (p: CGPoint) in
                CGPoint(x: centre.x + (p.x - pixels.width / 2) * fit * zoom, y: centre.y + (p.y - pixels.height / 2) * fit * zoom)
            }
            ZStack {
                Image(uiImage: image)
                    .resizable()
                    .frame(width: pixels.width * fit * zoom, height: pixels.height * fit * zoom)
                    .position(centre)
                Canvas { ctx, _ in marks(&ctx, toView) }
                    .allowsHitTesting(false)
            }
            .frame(width: size.width, height: size.height)
            .contentShape(Rectangle())
            .clipped()
            .allowsHitTesting(interactive)
            .onTapGesture(coordinateSpace: .local) { v in
                guard interactive else { return }
                let p = CGPoint(x: (v.x - centre.x) / (fit * zoom) + pixels.width / 2, y: (v.y - centre.y) / (fit * zoom) + pixels.height / 2)
                guard p.x >= 0, p.y >= 0, p.x <= pixels.width, p.y <= pixels.height else { return }
                Haptics.tap()
                onTap(p)
            }
            .gesture(interactive ? SimultaneousGesture(
                MagnifyGesture()
                    .onChanged { zoom = min(8, max(1, zoomBase * $0.magnification)) }
                    .onEnded { _ in zoomBase = zoom },
                DragGesture(minimumDistance: 8)
                    .onChanged { pan = CGSize(width: panBase.width + $0.translation.width, height: panBase.height + $0.translation.height) }
                    .onEnded { _ in panBase = pan }
            ) : nil)
        }
    }
}

/// Drawing helpers shared by the plan screens.
enum PlanMarks {
    /// A phone: a dot with a short heading tick (yaw as in `Mark`, in plan
    /// axes: yaw 0 looks up the page, toward -z).
    static func phone(_ ctx: inout GraphicsContext, at v: CGPoint, yaw: Float?, colour: Color, hollow: Bool = false) {
        if let yaw {
            let d = CGPoint(x: -CGFloat(sin(yaw)), y: -CGFloat(cos(yaw)))
            var tick = Path()
            tick.move(to: v)
            tick.addLine(to: CGPoint(x: v.x + d.x * 26, y: v.y + d.y * 26))
            ctx.stroke(tick, with: .color(colour), style: StrokeStyle(lineWidth: 3, lineCap: .round))
        }
        let r: CGFloat = 8
        let dot = Path(ellipseIn: CGRect(x: v.x - r, y: v.y - r, width: 2 * r, height: 2 * r))
        if hollow { ctx.stroke(dot, with: .color(colour), lineWidth: 3) } else { ctx.fill(dot, with: .color(colour)) }
        ctx.stroke(Path(ellipseIn: CGRect(x: v.x - r - 2, y: v.y - r - 2, width: 2 * r + 4, height: 2 * r + 4)), with: .color(.black.opacity(0.6)), lineWidth: 1.5)
    }

    /// Plan metres ↔ image pixels for the drawing as displayed.
    static func metresPerPixel(_ plan: PlanInfo, image: UIImage) -> Float {
        let w = Float(image.size.width * image.scale)
        return w > 0 && plan.widthPx > 0 ? plan.metresPerPx * plan.widthPx / w : plan.metresPerPx
    }

    /// Map frame onto the plan: the inverse of the plan's placement.
    static func mapToPlan(_ m: Mark, placement P: FloorTransform) -> Mark {
        let c = cos(-P.yaw), s = sin(-P.yaw)
        let x = m.x - P.tx, z = m.z - P.tz
        return Mark(x: c * x + s * z, z: -s * x + c * z, yaw: m.yaw - P.yaw)
    }
}


/// Floor plan sheet: upload a drawing from the phone (photo or PDF), set its
/// scale from one known length, then tap where you stand and what you face.
struct PlanSheet: View {
    @ObservedObject var model: AppModel
    @ObservedObject var relay: RelayClient
    @ObservedObject var capture: ARCapture
    @ObservedObject var settings: Settings
    /// Open on choosing a new drawing even when a plan exists.
    var upload = false
    @Environment(\.dismiss) private var dismiss

    private enum Step { case pick, scale, locate }
    @State private var step: Step?
    // Upload
    @State private var photo: PhotosPickerItem?
    @State private var importing = false
    @State private var picked: UIImage?
    @State private var scaleA: CGPoint?
    @State private var scaleB: CGPoint?
    @State private var lengthText = ""
    @State private var uploading = false
    // Locate
    @State private var stand: CGPoint?
    @State private var facing: CGPoint?
    @State private var waiting = false
    @State private var message: String?

    private var current: Step { step ?? (upload || relay.plan == nil ? .pick : .locate) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text(title).font(Theme.display(34))
                Spacer()
                IconButton(glyph: .close, label: "Close") { dismiss() }
            }
            switch current {
            case .pick: pickStep
            case .scale: scaleStep
            case .locate: locateStep
            }
        }
        .padding(24)
        .background(Color.black.ignoresSafeArea())
        .presentationBackground(.black)
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task {
                if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) { use(image) }
                photo = nil
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf, .image]) { result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let image = PlanImport.image(from: url) { use(image) } else { message = "That file couldn't be opened as a plan." }
        }
        .onAppear {
            relay.onLocate = { placed, error in
                waiting = false
                if let error { message = error; return }
                Haptics.success()
                message = placed == "plan" ? "The plan is now on the map, lined up with you." : "You're on the map."
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { dismiss() }
            }
        }
        .onDisappear { relay.onLocate = nil }
    }

    private var title: String {
        switch current {
        case .pick: return "FLOOR PLAN"
        case .scale: return "SET SCALE"
        case .locate: return "LOCATE"
        }
    }

    // MARK: pick

    private var pickStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Start with the building's floor plan. A clear photo of a printed plan works, or a PDF or image file.")
                .font(.system(size: 15)).foregroundStyle(Theme.muted)
            Spacer()
            PhotosPicker(selection: $photo, matching: .images) {
                pill("Choose a photo", filled: true)
            }
            Button { importing = true } label: { pill("Choose a file (PDF or image)", filled: false) }
            if relay.plan != nil {
                Button { step = .locate } label: { pill("Keep the current plan", filled: false) }
            }
            if let message { Text(message).font(.footnote).foregroundStyle(Theme.red) }
            Text("Uploading replaces the plan for everyone on this map.").font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    private func use(_ image: UIImage) {
        picked = PlanImport.prepare(image)
        scaleA = nil
        scaleB = nil
        lengthText = ""
        message = nil
        step = .scale
    }

    // MARK: scale

    private var scaleLength: Double? {
        Double(lengthText.replacingOccurrences(of: ",", with: ".")).flatMap { $0 > 0 ? $0 : nil }
    }

    private var scaleStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(scaleA == nil ? "Tap one end of a wall whose length you know." : scaleB == nil ? "Now tap the other end." : "How long is that wall?")
                .font(.system(size: 15)).foregroundStyle(Theme.muted)
            if let picked {
                PlanCanvas(image: picked, onTap: { p in
                    if scaleA == nil || scaleB != nil { scaleA = p; scaleB = nil } else { scaleB = p }
                }) { ctx, toView in
                    guard let a = scaleA else { return }
                    let va = toView(a)
                    if let b = scaleB {
                        var line = Path()
                        line.move(to: va)
                        line.addLine(to: toView(b))
                        ctx.stroke(line, with: .color(Theme.red), lineWidth: 3)
                        ctx.fill(Path(ellipseIn: CGRect(x: toView(b).x - 6, y: toView(b).y - 6, width: 12, height: 12)), with: .color(Theme.red))
                    }
                    ctx.fill(Path(ellipseIn: CGRect(x: va.x - 6, y: va.y - 6, width: 12, height: 12)), with: .color(Theme.red))
                }
                .background(Color.white)
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            HStack(spacing: 10) {
                TextField("Length", text: $lengthText)
                    .keyboardType(.decimalPad)
                    .font(Theme.mono(20))
                    .padding(14).background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.06)))
                    .disabled(scaleB == nil)
                Text("metres").label(10).foregroundStyle(Theme.muted)
            }
            if let message { Text(message).font(.footnote).foregroundStyle(Theme.red) }
            PillButton(title: uploading ? "Uploading…" : "Save plan") { Task { await upload() } }
                .disabled(scaleB == nil || scaleLength == nil || uploading)
                .opacity(scaleB == nil || scaleLength == nil ? 0.45 : 1)
            Button("Choose a different plan") { step = .pick }.font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    private func upload() async {
        guard let picked, let a = scaleA, let b = scaleB, let metres = scaleLength,
              let jpeg = picked.jpegData(compressionQuality: 0.85), let cg = picked.cgImage else { return }
        let px = hypot(b.x - a.x, b.y - a.y)
        guard px > 4 else { message = "Tap two points further apart."; return }
        uploading = true
        message = nil
        defer { uploading = false }
        do {
            try await relay.uploadPlan(name: "Floor plan", jpeg: jpeg, widthPx: cg.width, heightPx: cg.height,
                                       metresPerPx: metres / Double(px), token: settings.adminToken)
            Haptics.success()
            stand = nil
            facing = nil
            step = .locate
        } catch {
            message = error.localizedDescription
        }
    }

    // MARK: locate

    private var locateImage: UIImage? { relay.planImage ?? picked }

    private var locateStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(stand == nil ? "Tap where you're standing on the plan." : facing == nil ? "Now tap something you're facing." : "Hold the phone pointing that way, then place yourself.")
                .font(.system(size: 15)).foregroundStyle(Theme.muted)
            if let plan = relay.plan, let image = locateImage {
                let mpp = CGFloat(PlanMarks.metresPerPixel(plan, image: image))
                PlanCanvas(image: image, onTap: { p in
                    if stand == nil || facing != nil { stand = p; facing = nil } else { facing = p }
                    message = nil
                }) { ctx, toView in
                    if let placement = plan.placement {
                        let px = { (m: Mark) in toView(CGPoint(x: CGFloat(m.x) / mpp, y: CGFloat(m.z) / mpp)) }
                        for peer in relay.peerMarks.values {
                            let m = PlanMarks.mapToPlan(peer, placement: placement)
                            PlanMarks.phone(&ctx, at: px(m), yaw: m.yaw, colour: .gray)
                        }
                        if model.isLocated, let local = capture.localMark, stand == nil {
                            let m = PlanMarks.mapToPlan(relay.alignment.transform.apply(local), placement: placement)
                            PlanMarks.phone(&ctx, at: px(m), yaw: m.yaw, colour: Theme.red, hollow: true)
                        }
                    }
                    if let stand {
                        if let facing {
                            var line = Path()
                            line.move(to: toView(stand))
                            line.addLine(to: toView(facing))
                            ctx.stroke(line, with: .color(Theme.red.opacity(0.7)), style: StrokeStyle(lineWidth: 2, dash: [4, 6]))
                        }
                        PlanMarks.phone(&ctx, at: toView(stand), yaw: facing.map { heading(from: stand, to: $0) }, colour: Theme.red)
                    }
                }
                .background(Color.white)
                .clipShape(RoundedRectangle(cornerRadius: 18))
            } else {
                ProgressView().tint(.white).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let message { Text(message).font(.footnote).foregroundStyle(message.hasPrefix("You") || message.hasPrefix("The plan is") ? .white : Theme.red) }
            if capture.scan.floorY == nil {
                Text("Point the phone at the floor for a moment so it can measure your height.").font(.footnote).foregroundStyle(Theme.muted)
            }
            PillButton(title: waiting ? "Placing…" : "Place me here") { locate() }
                .disabled(!canLocate)
                .opacity(canLocate ? 1 : 0.45)
            Button("Upload a different plan") { step = .pick }.font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    private var canLocate: Bool {
        stand != nil && facing != nil && capture.localMark != nil && capture.scan.floorY != nil && relay.connected && !waiting
    }

    /// Plan yaw (as in `Mark`) looking from one image point to another.
    private func heading(from a: CGPoint, to b: CGPoint) -> Float {
        Float(atan2(-(b.x - a.x), -(b.y - a.y)))
    }

    private func locate() {
        guard let plan = relay.plan, let image = locateImage, let stand, let facing, let local = capture.localMark else { return }
        let mpp = PlanMarks.metresPerPixel(plan, image: image)
        waiting = true
        message = nil
        relay.locate(planPoint: SIMD2(Float(stand.x) * mpp, Float(stand.y) * mpp), heading: heading(from: stand, to: facing), local: local)
    }

    private func pill(_ title: String, filled: Bool) -> some View {
        HStack {
            Text(title).label(12, bold: true)
            Spacer()
            Circle().fill(filled ? Theme.red : .white.opacity(0.4)).frame(width: 8, height: 8)
        }
        .padding(.horizontal, 22).padding(.vertical, 17)
        .foregroundStyle(filled ? .black : .white)
        .background(Capsule().fill(filled ? Color.white : Theme.panel))
        .overlay(Capsule().stroke(Theme.line))
    }
}

/// Turning a photo or file into a plan image the server stores.
enum PlanImport {
    static let maxSide: CGFloat = 3000

    static func image(from url: URL) -> UIImage? {
        if url.pathExtension.lowercased() == "pdf" {
            guard let page = PDFDocument(url: url)?.page(at: 0) else { return nil }
            let bounds = page.bounds(for: .mediaBox)
            let scale = min(4, maxSide / max(bounds.width, bounds.height))
            return page.thumbnail(of: CGSize(width: bounds.width * scale, height: bounds.height * scale), for: .mediaBox)
        }
        return (try? Data(contentsOf: url)).flatMap(UIImage.init(data:))
    }

    /// Upright, at most `maxSide` pixels, flattened onto white (plans are paper).
    static func prepare(_ image: UIImage) -> UIImage {
        let size = image.size
        let k = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: (size.width * k).rounded(), height: (size.height * k).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: target, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: target))
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}
