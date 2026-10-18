// WP-02 test tool: posts one real left click at a top-left-origin point using CGEvent.
// Usage: clicker X Y      (posts a click)
//        clicker --check  (posts nothing: prints PERMISSION or NO_PERMISSION, exits 0 or 3)
// Posts only if CGPreflightPostEventAccess() is true. Otherwise prints NO_PERMISSION and exits 3 without
// posting anything. It never calls CGRequestPostEventAccess, so it cannot trigger a permission prompt.
import CoreGraphics
import Foundation

let args = CommandLine.arguments
if args.count == 2 && args[1] == "--check" {
    if CGPreflightPostEventAccess() { print("PERMISSION"); exit(0) }
    print("NO_PERMISSION")
    exit(3)
}
guard args.count == 3, let x = Double(args[1]), let y = Double(args[2]) else {
    FileHandle.standardError.write("usage: clicker X Y\n".data(using: .utf8)!)
    exit(2)
}

guard CGPreflightPostEventAccess() else {
    print("NO_PERMISSION")
    exit(3)
}

let point = CGPoint(x: x, y: y)
guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
      let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
    print("EVENT_CREATE_FAILED")
    exit(4)
}

down.post(tap: .cghidEventTap)
usleep(50_000)
up.post(tap: .cghidEventTap)
print("clicked \(args[1]) \(args[2])")
