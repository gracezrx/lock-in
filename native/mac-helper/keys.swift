// lockin-keys: "hold the space bar to talk" for Lock In.
//
// A quick tap of space still types a space (it is sent when you let go, or right away if you
// keep typing). Holding space for a moment (default 450 ms) tells Lock In instead, and that
// space is never typed. Space with Command, Control, Option, Shift or Fn is left alone, so
// Spotlight and other shortcuts work as usual.
//
// Only the space bar is looked at; nothing is recorded or sent anywhere. Needs the
// Accessibility permission (the one Lock In already uses for window titles).
//
// stdin:  "on" / "off"        intercept holds or not (Lock In turns it off in Figma and the like)
//         "threshold 450"     milliseconds before a press counts as a hold
// stdout: {"event":"ready"}   listening
//         {"event":"hold"}    space held past the threshold
//         {"event":"release"} let go after a hold
//         {"event":"error","reason":"permission"}  no Accessibility yet (retries every 5 s)

import Cocoa
import ApplicationServices

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}


enum HoldState { case idle, pending, held, swallowUp }

/// Everything the key callback needs, as plain globals (a C callback can't capture anything).
enum K {
    static let spaceKey: Int64 = 49
    /// Marks the spaces Lock In re-sends, so it doesn't catch them again.
    static let mark: Int64 = 0x4C4B494E
    static let modifiers: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn]
    static var enabled = false
    static var thresholdMs: Double = 450
    static var state = HoldState.idle
    static var token = 0
    static var tap: CFMachPort? = nil
}

func sendSpace(_ down: Bool) {
    guard let e = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(K.spaceKey), keyDown: down) else { return }
    e.setIntegerValueField(.eventSourceUserData, value: K.mark)
    e.post(tap: .cgSessionEventTap)
}

/// Another key came while deciding: type the space now, then that key, in order.
func flush(then event: CGEvent?) {
    K.token += 1
    K.state = .swallowUp
    sendSpace(true)
    sendSpace(false)
    if let e = event, let copy = e.copy() {
        copy.setIntegerValueField(.eventSourceUserData, value: K.mark)
        copy.post(tap: .cgSessionEventTap)
    }
}

func keyCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = K.tap { CGEvent.tapEnable(tap: t, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    if event.getIntegerValueField(.eventSourceUserData) == K.mark {
        return Unmanaged.passUnretained(event)
    }
    if !K.enabled && K.state == .idle {
        return Unmanaged.passUnretained(event)
    }
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    let withModifier = !event.flags.intersection(K.modifiers).isEmpty

    if type == .keyDown {
        if code == K.spaceKey {
            let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            if K.state == .idle {
                if withModifier || isRepeat { return Unmanaged.passUnretained(event) }
                K.state = .pending
                K.token += 1
                let mine = K.token
                DispatchQueue.main.asyncAfter(deadline: .now() + K.thresholdMs / 1000) {
                    if K.state == .pending && K.token == mine {
                        K.state = .held
                        emit(["event": "hold"])
                    }
                }
                return nil
            }
            // Key repeat while deciding or holding: swallow it.
            return nil
        }
        if K.state == .pending {
            flush(then: event)
            return nil
        }
        return Unmanaged.passUnretained(event)
    }

    if type == .keyUp && code == K.spaceKey {
        switch K.state {
        case .pending:
            K.token += 1
            K.state = .idle
            sendSpace(true)
            sendSpace(false)
            return nil
        case .held:
            K.state = .idle
            emit(["event": "release"])
            return nil
        case .swallowUp:
            K.state = .idle
            return nil
        case .idle:
            return Unmanaged.passUnretained(event)
        }
    }

    if type == .flagsChanged && K.state == .pending {
        flush(then: nil)
    }
    return Unmanaged.passUnretained(event)
}

func startTap() -> Bool {
    let mask = (CGEventMask(1) << CGEventMask(CGEventType.keyDown.rawValue))
        | (CGEventMask(1) << CGEventMask(CGEventType.keyUp.rawValue))
        | (CGEventMask(1) << CGEventMask(CGEventType.flagsChanged.rawValue))
    guard let t = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: mask,
        callback: keyCallback,
        userInfo: nil
    ) else { return false }
    K.tap = t
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: t, enable: true)
    emit(["event": "ready"])
    return true
}

if !startTap() {
    emit(["event": "error", "reason": "permission"])
    // Try again until Accessibility is allowed for Lock In.
    Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { timer in
        if startTap() { timer.invalidate() }
    }
}

DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
        let parts = line.trimmingCharacters(in: .whitespaces).split(separator: " ")
        DispatchQueue.main.async {
            guard let cmd = parts.first else { return }
            switch cmd {
            case "on":
                K.enabled = true
            case "off":
                K.enabled = false
            case "threshold":
                if parts.count > 1, let ms = Double(parts[1]) { K.thresholdMs = max(200, min(1500, ms)) }
            default:
                break
            }
        }
    }
    exit(0)
}

RunLoop.main.run()
