// screenctl: the mouse and keyboard for Handoff's screen-control extra (extras/screen/server.mjs).
// Compiled on this Mac by `handoff lab screen-control on`. Coordinates are in points on the main display.
//
//   screenctl check                      accessibility:yes|no, screen:yes|no, locked:yes|no
//   screenctl locked                     exits 0 when the screen is locked (or no one is logged in at it)
//   screenctl wake                       wakes a sleeping display; prints display:awake|asleep and screen:locked|unlocked
//   screenctl size                       the main display's size in points
//   screenctl move X Y
//   screenctl click X Y [left|right] [N] N clicks (2 = double click)
//   screenctl drag X1 Y1 X2 Y2
//   screenctl scroll DY [DX]             in lines; negative DY scrolls down
//   screenctl type TEXT
//   screenctl key COMBO                  like cmd+shift+t, return, escape, down

import ApplicationServices
import CoreGraphics
import Foundation
import IOKit.pwr_mgt

let args = CommandLine.arguments
func fail(_ s: String) -> Never { FileHandle.standardError.write(Data((s + "\n").utf8)); exit(1) }
func num(_ i: Int) -> Double { guard i < args.count, let d = Double(args[i]) else { fail("expected a number at \(i)") }; return d }
func point(_ i: Int) -> CGPoint { CGPoint(x: num(i), y: num(i + 1)) }

// Locked: the lock screen is up, or this login isn't the one on the display (fast user switching).
func locked() -> Bool {
    guard let d = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    return (d["CGSSessionScreenIsLocked"] as? Bool ?? false) || !(d[kCGSessionOnConsoleKey as String] as? Bool ?? true)
}

let source = CGEventSource(stateID: .hidSystemState)
func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left, clicks: Int = 1) {
    let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button)
    e?.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
    e?.post(tap: .cghidEventTap)
}

// US layout key codes.
let keys: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
let modifiers: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand, "shift": .maskShift, "ctrl": .maskControl, "control": .maskControl,
    "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate, "fn": .maskSecondaryFn,
]

switch args.count > 1 ? args[1] : "" {
case "check":
    print(AXIsProcessTrusted() ? "accessibility:yes" : "accessibility:no")
    print(CGPreflightScreenCaptureAccess() ? "screen:yes" : "screen:no")
    print(locked() ? "locked:yes" : "locked:no")
case "locked":
    exit(locked() ? 0 : 1)
case "wake":
    // A dark display (screen saver, display sleep, lid closed) captures as black: say the user is active.
    var id = IOPMAssertionID(0)
    IOPMAssertionDeclareUserActivity("Handoff screen control" as CFString, kIOPMUserActiveLocal, &id)
    for _ in 0..<20 where CGDisplayIsAsleep(CGMainDisplayID()) != 0 { usleep(100_000) }
    print(CGDisplayIsAsleep(CGMainDisplayID()) != 0 ? "display:asleep" : "display:awake")
    // A locked Mac captures as black too, and we never type the password.
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    print((session?["CGSSessionScreenIsLocked"] as? Bool) == true ? "screen:locked" : "screen:unlocked")
case "size":
    let b = CGDisplayBounds(CGMainDisplayID())
    print(Int(b.width), Int(b.height))
case "move":
    mouse(.mouseMoved, point(2))
case "click":
    let p = point(2)
    let right = args.count > 4 && args[4] == "right"
    let n = args.count > 5 ? max(1, min(3, Int(args[5]) ?? 1)) : 1
    mouse(.mouseMoved, p)
    usleep(60_000)
    for i in 1...n {
        mouse(right ? .rightMouseDown : .leftMouseDown, p, right ? .right : .left, clicks: i)
        mouse(right ? .rightMouseUp : .leftMouseUp, p, right ? .right : .left, clicks: i)
        usleep(60_000)
    }
case "drag":
    let p = point(2), q = point(4)
    mouse(.mouseMoved, p)
    mouse(.leftMouseDown, p)
    for s in 1...20 {
        let t = Double(s) / 20
        mouse(.leftMouseDragged, CGPoint(x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t))
        usleep(15_000)
    }
    mouse(.leftMouseUp, q)
case "scroll":
    let dy = Int32(num(2)), dx = args.count > 3 ? Int32(num(3)) : 0
    CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
case "type":
    guard args.count > 2 else { fail("nothing to type") }
    for ch in args[2] {
        let u = Array(String(ch).utf16)
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
            e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
            e?.post(tap: .cghidEventTap)
        }
        usleep(8_000)
    }
case "key":
    guard args.count > 2 else { fail("no key") }
    var flags: CGEventFlags = []
    var code: CGKeyCode?
    for part in args[2].lowercased().split(separator: "+").map(String.init) {
        if let m = modifiers[part] { flags.insert(m) } else if let k = keys[part] { code = k } else { fail("unknown key: \(part)") }
    }
    guard let k = code else { fail("no key in \(args[2])") }
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: k, keyDown: down)
        e?.flags = flags
        e?.post(tap: .cghidEventTap)
    }
default:
    fail("usage: screenctl check|wake|size|move|click|drag|scroll|type|key …")
}
