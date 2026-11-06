// lockin-helper: prints one JSON line per second describing what is in front.
//   {"t":…, "app":"Keynote", "bundleId":"com.apple.iWork.Keynote", "pid":123,
//    "title":"Q3 deck", "doc":"file:///Users/…/deck.key", "mic":false, "ax":true}
// Needs the Accessibility permission for "title" and "doc". Never reads screen
// contents or keystrokes. Exits when its stdin closes (the app quit).
// Commands on stdin: "prompt-ax" shows the Accessibility permission prompt.

import Cocoa
import ApplicationServices
import CoreAudio

setvbuf(stdout, nil, _IOLBF, 0)

func axTrusted(prompt: Bool) -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let opts = [key: prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(opts)
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let v = value else {
        return nil
    }
    if CFGetTypeID(v) == CFStringGetTypeID() {
        return (v as! CFString) as String
    }
    if CFGetTypeID(v) == CFURLGetTypeID() {
        return ((v as! CFURL) as URL).absoluteString
    }
    return nil
}

func micInUse() -> Bool {
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
    guard status == noErr, deviceID != 0 else { return false }
    var running: UInt32 = 0
    size = UInt32(MemoryLayout<UInt32>.size)
    address.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
    guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &running) == noErr else { return false }
    return running != 0
}

final class Sampler {
    func sample() {
        var out: [String: Any] = ["t": Int(Date().timeIntervalSince1970 * 1000)]
        let trusted = AXIsProcessTrusted()
        out["ax"] = trusted
        if let app = NSWorkspace.shared.frontmostApplication {
            out["app"] = app.localizedName ?? ""
            out["bundleId"] = app.bundleIdentifier ?? ""
            out["pid"] = Int(app.processIdentifier)
            if trusted {
                let axApp = AXUIElementCreateApplication(app.processIdentifier)
                AXUIElementSetMessagingTimeout(axApp, 0.25)
                var windowRef: CFTypeRef?
                if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
                   let w = windowRef, CFGetTypeID(w) == AXUIElementGetTypeID() {
                    let window = w as! AXUIElement
                    if let title = axString(window, kAXTitleAttribute) { out["title"] = title }
                    if let doc = axString(window, "AXDocument") { out["doc"] = doc }
                }
            }
        }
        out["mic"] = micInUse()
        if let data = try? JSONSerialization.data(withJSONObject: out, options: []),
           let line = String(data: data, encoding: .utf8) {
            print(line)
        }
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)

if CommandLine.arguments.contains("--prompt") {
    _ = axTrusted(prompt: true)
}

let sampler = Sampler()
let timer = Timer(timeInterval: 1.0, repeats: true) { _ in sampler.sample() }
RunLoop.main.add(timer, forMode: .common)
sampler.sample()

DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
        if line.trimmingCharacters(in: .whitespaces) == "prompt-ax" {
            DispatchQueue.main.async { _ = axTrusted(prompt: true) }
        }
    }
    exit(0)
}

application.run()
