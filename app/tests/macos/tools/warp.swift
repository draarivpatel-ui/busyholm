// WP-02 test tool, copied from spike/tools/warp.swift.
// warp --get : print current position. No permission needed. Used only for scripted click-through tests.
import AppKit
let H = NSScreen.screens[0].frame.height
let m = NSEvent.mouseLocation
if CommandLine.arguments.count >= 3, let x = Double(CommandLine.arguments[1]), let y = Double(CommandLine.arguments[2]) {
  CGWarpMouseCursorPosition(CGPoint(x: x, y: y)); usleep(50_000)
}
print(String(format: "%.1f %.1f", m.x, H - m.y))
