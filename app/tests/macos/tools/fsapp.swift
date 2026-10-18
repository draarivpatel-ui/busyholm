// WP-02 test tool, copied from spike/tools/fsapp.swift.
// Used to test whether the strip stays visible over full-screen apps.
import AppKit
let secs = Double(CommandLine.arguments.dropFirst().first ?? "15") ?? 15
let app = NSApplication.shared
app.setActivationPolicy(.regular)
class D: NSObject, NSApplicationDelegate {
  var w: NSWindow!
  func applicationDidFinishLaunching(_ n: Notification) {
    w = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 800, height: 500), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    w.title = "Full-screen test app"; w.collectionBehavior = [.fullScreenPrimary]
    w.contentView?.wantsLayer = true; w.contentView?.layer?.backgroundColor = NSColor(calibratedRed: 0.12, green: 0.32, blue: 0.55, alpha: 1).cgColor
    w.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.w.toggleFullScreen(nil) }
    DispatchQueue.main.asyncAfter(deadline: .now() + secs) { self.w.toggleFullScreen(nil) }
    DispatchQueue.main.asyncAfter(deadline: .now() + secs + 1.5) { NSApp.terminate(nil) }
  }
}
let d = D(); app.delegate = d; app.run()
