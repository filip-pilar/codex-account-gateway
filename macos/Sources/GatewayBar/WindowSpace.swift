import AppKit
import SwiftUI

// Measure the hosting display, since the menu panel and a preview window may
// be on a different screen from NSScreen.main.
struct WindowSpaceReader: NSViewRepresentable {
    @Binding var availableHeight: CGFloat
    func makeNSView(context: Context) -> WindowSpaceView { WindowSpaceView() }
    func updateNSView(_ view: WindowSpaceView, context: Context) {
        view.onSpaceChange = { height in
            if abs(availableHeight - height) > 1 { availableHeight = height }
        }
    }
}

final class WindowSpaceView: NSView {
    var onSpaceChange: ((CGFloat) -> Void)?
    private var observations: [NSObjectProtocol] = []

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observations.forEach(NotificationCenter.default.removeObserver)
        observations = []
        guard let window else { return }
        for name in [NSWindow.didResizeNotification, NSWindow.didMoveNotification, NSWindow.didChangeScreenNotification] {
            observations.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in self?.updateSpace() })
        }
        observations.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in self?.updateSpace() })
        updateSpace()
    }

    private func updateSpace() {
        guard let window, let screen = window.screen else { return }
        let visible = screen.visibleFrame.insetBy(dx: 8, dy: 8)
        let chrome = max(0, window.frame.height - window.contentLayoutRect.height)
        let height = max(180, min(600, visible.height - chrome - 16))
        DispatchQueue.main.async { [weak self] in self?.onSpaceChange?(height) }
        // AppKit positions menu panels. Keep growing standalone windows within
        // their display without changing the menu bar's anchor.
        if window.styleMask.contains(.titled), window.isVisible, window.frame.height <= visible.height {
            let origin = NSPoint(x: max(visible.minX, min(window.frame.minX, visible.maxX - window.frame.width)),
                                 y: max(visible.minY, min(window.frame.minY, visible.maxY - window.frame.height)))
            if origin != window.frame.origin { window.setFrameOrigin(origin) }
        }
    }

    deinit { observations.forEach(NotificationCenter.default.removeObserver) }
}
