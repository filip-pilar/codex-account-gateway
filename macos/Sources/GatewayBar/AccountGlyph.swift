import AppKit
import SwiftUI

// Original vector artwork shared by the app icon, header, and template status icon.
struct AccountGlyph: Shape {
    static var outline: CGPath {
        let p = CGMutablePath()
        p.addEllipse(in: CGRect(x: 11, y: 5, width: 15, height: 15))
        p.move(to: CGPoint(x: 5, y: 44))
        p.addQuadCurve(to: CGPoint(x: 2, y: 41), control: CGPoint(x: 2, y: 44))
        p.addLine(to: CGPoint(x: 2, y: 34))
        p.addCurve(to: CGPoint(x: 19, y: 24), control1: CGPoint(x: 2, y: 27), control2: CGPoint(x: 9, y: 24))
        p.addQuadCurve(to: CGPoint(x: 31, y: 28), control: CGPoint(x: 27, y: 24))
        p.addCurve(to: CGPoint(x: 23, y: 44), control1: CGPoint(x: 24, y: 31), control2: CGPoint(x: 23, y: 38))
        p.closeSubpath()
        p.addEllipse(in: CGRect(x: 35, y: 10, width: 18, height: 18))
        p.move(to: CGPoint(x: 29, y: 54))
        p.addQuadCurve(to: CGPoint(x: 27, y: 51), control: CGPoint(x: 27, y: 54))
        p.addLine(to: CGPoint(x: 27, y: 44))
        p.addCurve(to: CGPoint(x: 44, y: 33), control1: CGPoint(x: 27, y: 36), control2: CGPoint(x: 34, y: 33))
        p.addCurve(to: CGPoint(x: 62, y: 44), control1: CGPoint(x: 54, y: 33), control2: CGPoint(x: 62, y: 36))
        p.addLine(to: CGPoint(x: 62, y: 51))
        p.addQuadCurve(to: CGPoint(x: 59, y: 54), control: CGPoint(x: 62, y: 54))
        p.closeSubpath()
        return p
    }
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / 64, rect.height / 60)
        var transform = CGAffineTransform(translationX: rect.midX - 32 * scale, y: rect.midY - 30 * scale).scaledBy(x: scale, y: scale)
        return Path(Self.outline.copy(using: &transform)!)
    }
    static var menuImage: NSImage {
        let image = NSImage(size: NSSize(width: 20, height: 18), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.saveGState()
            context.translateBy(x: 0.4, y: 0)
            context.scaleBy(x: 0.3, y: 0.3)
            context.addPath(outline)
            context.setFillColor(NSColor.black.cgColor)
            context.fillPath()
            context.restoreGState()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Codex Gateway accounts"
        return image
    }
}
