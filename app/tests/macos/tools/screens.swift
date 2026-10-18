// screens (WP-02 test tool): print every NSScreen as JSON in top-left-origin points (the same space
// as zorder bounds and warp): frame, visibleFrame (the work area: excludes the menu bar and Dock),
// backing scale factor and name. Needs no permission. Independent of the app under test.
import AppKit
let H = NSScreen.screens.first?.frame.height ?? 0
func tl(_ r: NSRect) -> [Double] { [Double(r.origin.x), Double(H - r.origin.y - r.size.height), Double(r.size.width), Double(r.size.height)] }
var out: [[String: Any]] = []
for (i, s) in NSScreen.screens.enumerated() {
  out.append(["index": i, "name": s.localizedName, "frame": tl(s.frame), "visible": tl(s.visibleFrame), "scale": Double(s.backingScaleFactor), "main": i == 0])
}
let d = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: d, encoding: .utf8)!)
