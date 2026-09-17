import AppKit

// A compact stack of layers, drawn directly at menu-bar size.
enum StackGlyph {
    static var menuImage: NSImage {
        let image = NSImage(size: NSSize(width: 20, height: 18), flipped: true) { _ in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.saveGState()
            context.setStrokeColor(NSColor.black.cgColor)
            context.setLineWidth(1.4)
            context.setLineJoin(.round)
            context.setLineCap(.round)
            context.move(to: CGPoint(x: 10, y: 1.5))
            context.addLines(between: [
                CGPoint(x: 18, y: 5.5), CGPoint(x: 10, y: 9.5),
                CGPoint(x: 2, y: 5.5), CGPoint(x: 10, y: 1.5)
            ])
            context.closePath()
            for y in [9.0, 12.5] {
                context.move(to: CGPoint(x: 2, y: y))
                context.addLine(to: CGPoint(x: 10, y: y + 4))
                context.addLine(to: CGPoint(x: 18, y: y))
            }
            context.strokePath()
            context.restoreGState()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Codex Gateway accounts"
        return image
    }
}
