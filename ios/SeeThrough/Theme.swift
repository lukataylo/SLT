import SwiftUI
import UIKit

/// The app's visual language: black, white, one red; Doto dot-matrix display
/// type, Space Mono labels, and icons drawn from the same dots.
enum Theme {
    static let red = Color(red: 0.843, green: 0.098, blue: 0.129)
    static let uiRed = UIColor(red: 0.843, green: 0.098, blue: 0.129, alpha: 1)
    static let panel = Color.black.opacity(0.82)
    static let line = Color.white.opacity(0.14)
    static let muted = Color(white: 0.55)

    /// Doto is a variable font; ask for a weight on its `wght` axis.
    static func display(_ size: CGFloat, weight: CGFloat = 800) -> Font {
        let wght = 2_003_265_652 // 'wght'
        let descriptor = UIFontDescriptor(fontAttributes: [
            .family: "Doto",
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [wght: weight],
        ])
        return Font(UIFont(descriptor: descriptor, size: size) as CTFont)
    }

    static func mono(_ size: CGFloat, bold: Bool = false) -> Font {
        .custom(bold ? "SpaceMono-Bold" : "SpaceMono-Regular", size: size)
    }
}

extension Text {
    /// Uppercase monospace label with Nothing-style tracking.
    func label(_ size: CGFloat = 10, bold: Bool = false) -> some View {
        font(Theme.mono(size, bold: bold)).tracking(size * 0.16).textCase(.uppercase)
    }

    /// Kept for older views: monospace with tracking.
    func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Text {
        font(Theme.mono(size, bold: weight == .bold || weight == .heavy)).tracking(size * 0.14)
    }
}

/// 9×9 dot-matrix icons. `#` is a lit dot, `.` an unlit one.
enum DotGlyph: String, CaseIterable {
    case eye, cube, qr, gear, camera, mesh, planes, palette, ghost, haptic, plus, close, check, reset, scan, people, server, back

    var rows: [String] {
        switch self {
        case .eye: return [".........", "...###...", ".##...##.", "#...#...#", "#..###..#", "#...#...#", ".##...##.", "...###...", "........."]
        case .cube: return ["....#....", "..##.##..", "##.....##", "#.##.##.#", "#...#...#", "#...#...#", "#...#...#", ".##.#.##.", "...###..."]
        case .qr: return ["###.#.###", "#.#...#.#", "###.#.###", "....#....", "#.###.#.#", ".........", "###.#.#.#", "#.#..#.#.", "###.#.###"]
        case .gear: return ["....#....", ".#.###.#.", "..#...#..", ".#.....#.", "##..#..##", ".#.....#.", "..#...#..", ".#.###.#.", "....#...."]
        case .camera: return [".........", "...###...", "#########", "#...#...#", "#..#.#..#", "#...#...#", "#.......#", "#########", "........."]
        case .mesh: return ["#.#.#.#.#", ".#.#.#.#.", "#.#.#.#.#", ".#.#.#.#.", "#.#.#.#.#", ".#.#.#.#.", "#.#.#.#.#", ".#.#.#.#.", "#.#.#.#.#"]
        case .planes: return ["#########", "#.......#", "#.......#", "#########", ".........", "#########", "#.......#", "#.......#", "#########"]
        case .palette: return ["..#####..", ".#.....#.", "#..#.#..#", "#.......#", "#.#...#.#", "#.......#", "#...##..#", ".#..#..#.", "..###...."]
        case .ghost: return ["#.......#", "#.......#", "#..#.#..#", "#.......#", "#..###..#", "#.......#", "#.......#", "#.......#", "#########"]
        case .haptic: return ["..#...#..", ".#.....#.", "#..###..#", "#..#.#..#", "#..#.#..#", "#..#.#..#", "#..###..#", ".#.....#.", "..#...#.."]
        case .plus: return [".........", "....#....", "....#....", "....#....", ".#######.", "....#....", "....#....", "....#....", "........."]
        case .close: return [".........", ".#.....#.", "..#...#..", "...#.#...", "....#....", "...#.#...", "..#...#..", ".#.....#.", "........."]
        case .check: return [".........", ".......#.", "......#..", ".....#...", "#...#....", ".#.#.....", "..#......", ".........", "........."]
        case .reset: return ["..####...", ".#....#.#", "#......##", "#....###.", "#........", "#.......#", ".#.....#.", "..#####..", "........."]
        case .scan: return ["##.....##", "#.......#", ".........", "...###...", "...###...", "...###...", ".........", "#.......#", "##.....##"]
        case .people: return ["..#...#..", ".###.###.", "..#...#..", ".........", ".###.###.", "#####.###", "#####.###", ".........", "........."]
        case .server: return ["#########", "#.#.....#", "#########", ".........", "#########", "#.#.....#", "#########", "....#....", "..#####.."]
        case .back: return [".........", "...#.....", "..#......", ".#.......", "#########", ".#.......", "..#......", "...#.....", "........."]
        }
    }
}

struct DotIcon: View {
    let glyph: DotGlyph
    var size: CGFloat = 22
    var color: Color = .white
    var dim: Color = .white.opacity(0.12)

    var body: some View {
        Canvas { ctx, canvas in
            let rows = glyph.rows
            let step = canvas.width / CGFloat(rows.count)
            let r = step * 0.36
            for (y, row) in rows.enumerated() {
                for (x, ch) in row.enumerated() {
                    let c = CGPoint(x: (CGFloat(x) + 0.5) * step, y: (CGFloat(y) + 0.5) * step)
                    ctx.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)),
                             with: .color(ch == "#" ? color : dim))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Round black button holding a dot icon.
struct IconButton: View {
    let glyph: DotGlyph
    var label: String
    var active = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            DotIcon(glyph: glyph, size: 20, color: active ? .black : .white, dim: (active ? Color.black : .white).opacity(0.12))
                .frame(width: 46, height: 46)
                .background(Circle().fill(active ? Color.white : Theme.panel))
                .overlay(Circle().stroke(Theme.line))
        }
        .accessibilityLabel(label)
    }
}

/// Full-width pill call to action.
struct PillButton: View {
    let title: String
    var filled = true
    var destructive = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title).label(12, bold: true)
                Spacer()
                Circle().fill(destructive ? Theme.red : (filled ? Theme.red : .white.opacity(0.4))).frame(width: 8, height: 8)
            }
            .padding(.horizontal, 22).padding(.vertical, 17)
            .foregroundStyle(filled ? .black : (destructive ? Theme.red : .white))
            .background(Capsule().fill(filled ? Color.white : Theme.panel))
            .overlay(Capsule().stroke(destructive ? Theme.red.opacity(0.6) : Theme.line))
        }
    }
}

/// A rounded black panel.
struct Panel<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 24).fill(Theme.panel))
            .overlay(RoundedRectangle(cornerRadius: 24).stroke(Theme.line))
    }
}

/// Heavy feedback on the moments that matter (pairing, alignment).
enum Haptics {
    static var enabled = true
    static func success() { if enabled { UINotificationFeedbackGenerator().notificationOccurred(.success) } }
    static func tap() { if enabled { UIImpactFeedbackGenerator(style: .light).impactOccurred() } }
}
