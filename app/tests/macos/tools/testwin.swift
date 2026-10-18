// WP-02 test tool: a plain grey window ("window beneath") for click-through tests.
// Usage: testwin X Y W H SECONDS
//   X, Y = top-left origin in points of the main screen (same convention as warp and hittest).
// Never activates the app (accessory policy, orderFrontRegardless). Every 250 ms prints one JSON line with the
// cursor position, which window the window server would hit there, and whether that is this window.
// Prints a mouse_down JSON line whenever this window receives a mouse down. Exits after SECONDS.
import AppKit

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    var line = data
    line.append(0x0A)
    FileHandle.standardOutput.write(line)
}

let args = CommandLine.arguments
guard args.count == 6,
      let originX = Double(args[1]), let originY = Double(args[2]),
      let width = Double(args[3]), let height = Double(args[4]),
      let seconds = Double(args[5]) else {
    FileHandle.standardError.write("usage: testwin X Y W H SECONDS\n".data(using: .utf8)!)
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

// Same screen convention as warp and hittest: screens[0] is the main display, origin at its top-left.
let screenHeight = NSScreen.screens[0].frame.height

final class TestView: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let win = window else { return }
        let p = win.convertPoint(toScreen: event.locationInWindow)
        emit(["event": "mouse_down", "t": Date().timeIntervalSince1970, "point": [p.x, screenHeight - p.y]])
    }
}

let window = NSWindow(contentRect: NSRect(x: originX, y: screenHeight - originY - height, width: width, height: height),
                      styleMask: .borderless, backing: .buffered, defer: false)
window.level = NSWindow.Level(rawValue: 2) // above normal windows (0), below the strip (floating, 3)
window.isOpaque = true
window.hasShadow = false
window.isReleasedWhenClosed = false
window.backgroundColor = NSColor(calibratedWhite: 0.85, alpha: 1.0)
window.contentView = TestView(frame: NSRect(x: 0, y: 0, width: width, height: height))
window.orderFrontRegardless()

let myNumber = window.windowNumber

Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
    let m = NSEvent.mouseLocation
    let hit = NSWindow.windowNumber(at: m, belowWindowWithWindowNumber: 0)
    let f = window.frame
    emit([
        "t": Date().timeIntervalSince1970,
        "cursor": [m.x, screenHeight - m.y],
        "hit_window": hit,
        "my_window": myNumber,
        "lands_on_me": hit == myNumber,
        "frame": [f.origin.x, screenHeight - f.maxY, f.width, f.height],
    ])
}

DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
app.run()
