// WP-02 test tool, copied from spike/tools/hittest.swift.
// window would receive a mouse-down there (NSWindow.windowNumber(at:)). Prints owner + layer of that window.
// Restores the cursor afterwards. No permissions needed. Used to test click-through of other processes' windows.
import AppKit
let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
let H = NSScreen.screens[0].frame.height
let orig = NSEvent.mouseLocation
var a = Array(CommandLine.arguments.dropFirst()); let wait = 1.5
func owner(_ n: Int) -> String {
  let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(n)) as? [[String: Any]] ?? []
  guard let w = info.first else { return "?" }
  return "\(w[kCGWindowOwnerName as String] ?? "?") pid=\(w[kCGWindowOwnerPID as String] ?? "?") layer=\(w[kCGWindowLayer as String] ?? "?")"
}
while a.count >= 2, let x = Double(a[0]), let y = Double(a[1]) {
  a.removeFirst(2)
  CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
  RunLoop.current.run(until: Date().addingTimeInterval(wait))
  let n = NSWindow.windowNumber(at: NSPoint(x: x, y: H - y), belowWindowWithWindowNumber: 0)
  print(String(format: "point %.0f,%.0f -> window %d (%@)", x, y, n, owner(n)))
}
CGWarpMouseCursorPosition(CGPoint(x: orig.x, y: H - orig.y))
