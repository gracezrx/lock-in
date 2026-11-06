// lockin-calendar: reads events from the Calendar app on this Mac (EventKit), for Lock In.
// Whatever shows in Calendar works: Google (school and work accounts too), iCloud, Outlook/Exchange.
// Read-only: it never creates, changes or deletes anything.
//
//   lockin-calendar status             → {"status":"granted"}
//   lockin-calendar request            → asks macOS for access (once), then prints the status
//   lockin-calendar events FROM TO     → {"status":"granted","calendars":[…],"events":[…]}
//                                        FROM and TO are milliseconds since 1970.
// status is one of: notDetermined, restricted, denied, granted, writeOnly, unknown.

import Foundation
import EventKit

setvbuf(stdout, nil, _IOLBF, 0)

let store = EKEventStore()

func statusName() -> String {
    // Raw values, so this builds with old and new macOS SDKs alike
    // (3 was "authorized" before macOS 14 and is "fullAccess" since).
    switch EKEventStore.authorizationStatus(for: .event).rawValue {
    case 0: return "notDetermined"
    case 1: return "restricted"
    case 2: return "denied"
    case 3: return "granted"
    case 4: return "writeOnly"
    default: return "unknown"
    }
}

func printJSON(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let line = String(data: data, encoding: .utf8) {
        print(line)
    }
}

func requestAccess() {
    let done = DispatchSemaphore(value: 0)
    #if compiler(>=5.9)
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { _, _ in done.signal() }
    } else {
        store.requestAccess(to: .event) { _, _ in done.signal() }
    }
    #else
    store.requestAccess(to: .event) { _, _ in done.signal() }
    #endif
    _ = done.wait(timeout: .now() + 180)
}

func millis(_ d: Date) -> Int64 {
    return Int64((d.timeIntervalSince1970 * 1000).rounded())
}

func date(_ arg: String?, _ fallback: Date) -> Date {
    guard let a = arg, let n = Double(a) else { return fallback }
    return Date(timeIntervalSince1970: n / 1000)
}

func listEvents(from: Date, to: Date) {
    let status = statusName()
    if status != "granted" {
        printJSON(["status": status])
        return
    }
    var calendars: [[String: Any]] = []
    for c in store.calendars(for: .event) {
        let source: String = c.source?.title ?? ""
        calendars.append(["id": c.calendarIdentifier, "title": c.title, "source": source])
    }
    var events: [[String: Any]] = []
    let predicate = store.predicateForEvents(withStart: from, end: to, calendars: nil)
    for e in store.events(matching: predicate) {
        guard let start = e.startDate, let end = e.endDate else { continue }
        if e.status == .canceled { continue }
        var declined = false
        if let attendees = e.attendees {
            for a in attendees where a.isCurrentUser && a.participantStatus == .declined {
                declined = true
            }
        }
        if declined { continue }
        let title: String = e.title ?? ""
        var ev: [String: Any] = [
            "id": "\(e.calendarItemIdentifier)@\(millis(start))",
            "title": title,
            "start": millis(start),
            "end": millis(end),
            "allDay": e.isAllDay,
            "free": e.availability == .free,
            "calendar": e.calendar?.title ?? "",
            "calendarId": e.calendar?.calendarIdentifier ?? "",
        ]
        if let location = e.location, !location.isEmpty { ev["location"] = location }
        if let url = e.url { ev["url"] = url.absoluteString }
        if let notes = e.notes, !notes.isEmpty { ev["notes"] = String(notes.prefix(4000)) }
        events.append(ev)
    }
    printJSON(["status": status, "calendars": calendars, "events": events])
}

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : "status"
switch command {
case "request":
    if statusName() == "notDetermined" { requestAccess() }
    printJSON(["status": statusName()])
case "events":
    let now = Date()
    let from = date(args.count > 2 ? args[2] : nil, now.addingTimeInterval(-18 * 3600))
    let to = date(args.count > 3 ? args[3] : nil, now.addingTimeInterval(8 * 86400))
    listEvents(from: from, to: to)
default:
    printJSON(["status": statusName()])
}
exit(0)
