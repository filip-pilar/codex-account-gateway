import AppKit
import SwiftUI

@main enum GenerateIcon {
    static func main() throws {
        let destination = URL(fileURLWithPath: CommandLine.arguments[1])
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        for size in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let pixels = size * scale
                let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
                let context = NSGraphicsContext.current!.cgContext
                context.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
                let tile = NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824), xRadius: 184, yRadius: 184)
                NSGradient(starting: NSColor(srgbRed: 0.16, green: 0.53, blue: 0.98, alpha: 1),
                           ending: NSColor(srgbRed: 0.03, green: 0.32, blue: 0.82, alpha: 1))!.draw(in: tile, angle: -90)
                context.translateBy(x: 244, y: 768)
                context.scaleBy(x: 8.4, y: -8.4)
                context.addPath(AccountGlyph.outline)
                context.setFillColor(NSColor.white.cgColor)
                context.fillPath()
                NSGraphicsContext.restoreGraphicsState()
                let suffix = scale == 2 ? "@2x" : ""
                let filename = "icon_\(size)x\(size)\(suffix).png"
                try bitmap.representation(using: .png, properties: [:])!.write(to: destination.appendingPathComponent(filename))
            }
        }
    }
}
