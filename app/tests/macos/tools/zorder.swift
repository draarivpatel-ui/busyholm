// WP-02 test tool, copied from spike/tools/zorder.swift.
// Needs no Screen Recording permission (window titles are redacted without it; layers/owners/bounds are not).
// Usage: zorder [--pid PID]... [--json]   (with --pid, other apps' rows are summarised by layer)
import CoreGraphics
import Foundation
var pids = Set<Int>(); var json = false
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() { if a == "--pid", let p = it.next(), let v = Int(p) { pids.insert(v) } else if a == "--json" { json = true } }
let keys: [(String, Int32)] = [("kCGDesktopWindowLevel", 2), ("kCGDesktopIconWindowLevel", 18), ("kCGBackstopMenuLevel", 3),
  ("kCGNormalWindowLevel", 4), ("kCGFloatingWindowLevel", 5), ("kCGStatusWindowLevel", 9), ("kCGMainMenuWindowLevel", 8), ("kCGScreenSaverWindowLevel", 13)]
var levelNames: [Int: String] = [:]
for (n, k) in keys { levelNames[Int(CGWindowLevelForKey(CGWindowLevelKey(rawValue: k)!))] = n }
let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
var rows: [[String: Any]] = []
for (i, w) in info.enumerated() {
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? -1
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
  let row: [String: Any] = ["zIndexFromFront": i, "owner": w[kCGWindowOwnerName as String] as? String ?? "?", "pid": pid,
    "layer": layer, "levelName": levelNames[layer] ?? "", "windowNumber": w[kCGWindowNumber as String] as? Int ?? 0,
    "alpha": w[kCGWindowAlpha as String] as? Double ?? 1, "bounds": [b["X"] ?? 0, b["Y"] ?? 0, b["Width"] ?? 0, b["Height"] ?? 0],
    "mine": pids.contains(pid)]
  rows.append(row)
}
if json {
  let lv = levelNames.map { ["level": $0.key, "name": $0.value] }
  let d = try! JSONSerialization.data(withJSONObject: ["levels": lv, "windows": rows], options: [.prettyPrinted, .sortedKeys])
  print(String(data: d, encoding: .utf8)!)
} else {
  print("level constants:", levelNames.sorted { $0.key < $1.key }.map { "\($0.value)=\($0.key)" }.joined(separator: "  "))
  print(String(format: "%-4@ %-5@ %-26@ %-7@ %-12@ %-26@ %@", "z", "mine", "owner", "pid", "layer", "levelName", "bounds x,y,w,h"))
  for r in rows {
    let bb = (r["bounds"] as! [Double]).map { String(Int($0)) }.joined(separator: ",")
    print(String(format: "%-4d %-5@ %-26@ %-7d %-12d %-26@ %@", r["zIndexFromFront"] as! Int, (r["mine"] as! Bool) ? "YES" : "", String((r["owner"] as! String).prefix(26)),
      r["pid"] as! Int, r["layer"] as! Int, r["levelName"] as! String, bb))
  }
}
