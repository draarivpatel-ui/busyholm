// WP-12 test tool: warp the cursor (no permission needed) and print the epoch time right after the
// warp, so a test can measure how long the app took to react.  Usage: warpt X Y   (top-left origin)
import AppKit
let a = CommandLine.arguments
guard a.count == 3, let x = Double(a[1]), let y = Double(a[2]) else { exit(2) }
CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
print(String(format: "%.4f", Date().timeIntervalSince1970))
