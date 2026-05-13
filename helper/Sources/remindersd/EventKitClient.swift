import Foundation
import EventKit

enum AuthError: Error {
    case denied(String)
    case notDetermined
}

final class EventKitClient {
    let store = EKEventStore()

    /// Request reminders access. Tries the macOS 14+ `fullAccess` API first, falls back to the
    /// legacy API on older OSes. Blocks until the user responds (or the system returns immediately
    /// if already granted/denied).
    func requestAccess() async throws {
        if #available(macOS 14.0, *) {
            let granted = try await store.requestFullAccessToReminders()
            if !granted { throw AuthError.denied("User denied full access to Reminders.") }
        } else {
            let granted: Bool = await withCheckedContinuation { cont in
                store.requestAccess(to: .reminder) { ok, _ in cont.resume(returning: ok) }
            }
            if !granted { throw AuthError.denied("User denied access to Reminders.") }
        }
    }

    func authStatus() -> AuthDTO {
        let raw = EKEventStore.authorizationStatus(for: .reminder)
        let granted: Bool
        let label: String
        switch raw {
        case .notDetermined: granted = false; label = "notDetermined"
        case .restricted:    granted = false; label = "restricted"
        case .denied:        granted = false; label = "denied"
        case .authorized:    granted = true;  label = "authorized"
        case .writeOnly:     granted = false; label = "writeOnly"
        case .fullAccess:    granted = true;  label = "fullAccess"
        @unknown default:    granted = false; label = "unknown"
        }
        return AuthDTO(granted: granted, status: label)
    }

    // MARK: - Lists

    func lists() -> [ListDTO] {
        let cals = store.calendars(for: .reminder)
        return cals.map { c in
            ListDTO(
                id: c.calendarIdentifier,
                name: c.title,
                color: c.cgColor.flatMap { hexFromCGColor($0) },
                source: c.source?.title ?? "Unknown",
                allowsModifications: c.allowsContentModifications
            )
        }
    }

    private func hexFromCGColor(_ cg: CGColor) -> String? {
        guard let comps = cg.components, comps.count >= 3 else { return nil }
        let r = Int((comps[0] * 255).rounded())
        let g = Int((comps[1] * 255).rounded())
        let b = Int((comps[2] * 255).rounded())
        return String(format: "#%02X%02X%02X", r, g, b)
    }

    // MARK: - Reminders

    /// Fetch reminders, optionally filtered by list id, optionally including completed.
    /// Status: "open" (default), "completed", "all".
    func reminders(listId: String?, status: String) async -> [ReminderDTO] {
        let cals = store.calendars(for: .reminder)
        let selectedCals: [EKCalendar]
        if let id = listId {
            selectedCals = cals.filter { $0.calendarIdentifier == id }
        } else {
            selectedCals = cals
        }
        if selectedCals.isEmpty { return [] }

        // We need both incomplete + completed predicates because EventKit doesn't have a single
        // "all" predicate that returns both. The completion predicate is also bounded — pass nil for
        // open-ended.
        var collected: [EKReminder] = []

        if status == "open" || status == "all" {
            let p = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: selectedCals)
            let xs = await fetch(p)
            collected.append(contentsOf: xs)
        }
        if status == "completed" || status == "all" {
            let p = store.predicateForCompletedReminders(withCompletionDateStarting: nil, ending: nil, calendars: selectedCals)
            let xs = await fetch(p)
            collected.append(contentsOf: xs)
        }

        // Build parent → children index so we can populate subtask_ids without a second pass over
        // EventKit. EKReminder exposes .parent via the `parent` property on macOS 14+, but the
        // typed API is unstable across SDKs — we read `value(forKey: "parent")` defensively.
        var childrenByParent: [String: [String]] = [:]
        for r in collected {
            if let parentId = parentIdOf(r) {
                childrenByParent[parentId, default: []].append(r.calendarItemIdentifier)
            }
        }

        return collected.map { r in
            let parentId = parentIdOf(r)
            let myId = r.calendarItemIdentifier
            return ReminderDTO(
                id: myId,
                list_id: r.calendar?.calendarIdentifier ?? "",
                list_name: r.calendar?.title ?? "",
                title: r.title ?? "",
                notes: r.notes,
                priority: priorityLabel(r.priority),
                due: formatDue(r),
                due_all_day: isAllDay(r),
                completed: r.isCompleted,
                completion_date: r.completionDate.map(iso8601),
                creation_date: r.creationDate.map(iso8601),
                modification_date: r.lastModifiedDate.map(iso8601),
                flagged: readFlagged(r),
                url: r.url?.absoluteString,
                parent_id: parentId,
                subtask_ids: childrenByParent[myId] ?? []
            )
        }
    }

    func reminder(id: String) async -> ReminderDTO? {
        guard let item = store.calendarItem(withIdentifier: id) as? EKReminder else { return nil }
        // To populate subtask_ids correctly, search the same calendar for children whose parent is
        // this id. Cheaper than scanning all calendars.
        var childIds: [String] = []
        if let cal = item.calendar {
            let p = store.predicateForReminders(in: [cal])
            let all = await fetch(p)
            for r in all where parentIdOf(r) == id {
                childIds.append(r.calendarItemIdentifier)
            }
        }
        return ReminderDTO(
            id: item.calendarItemIdentifier,
            list_id: item.calendar?.calendarIdentifier ?? "",
            list_name: item.calendar?.title ?? "",
            title: item.title ?? "",
            notes: item.notes,
            priority: priorityLabel(item.priority),
            due: formatDue(item),
            due_all_day: isAllDay(item),
            completed: item.isCompleted,
            completion_date: item.completionDate.map(iso8601),
            creation_date: item.creationDate.map(iso8601),
            modification_date: item.lastModifiedDate.map(iso8601),
            flagged: readFlagged(item),
            url: item.url?.absoluteString,
            parent_id: parentIdOf(item),
            subtask_ids: childIds
        )
    }

    // MARK: - Helpers

    private func fetch(_ predicate: NSPredicate) async -> [EKReminder] {
        await withCheckedContinuation { cont in
            store.fetchReminders(matching: predicate) { results in
                cont.resume(returning: results ?? [])
            }
        }
    }

    private func priorityLabel(_ p: Int) -> String {
        switch p {
        case 1: return "high"
        case 5: return "medium"
        case 9: return "low"
        default: return "none"
        }
    }

    /// EventKit stores both timed and all-day reminders in `dueDateComponents`. If there's no hour
    /// component, it's all-day.
    private func isAllDay(_ r: EKReminder) -> Bool {
        guard let c = r.dueDateComponents else { return false }
        return c.hour == nil
    }

    private func formatDue(_ r: EKReminder) -> String? {
        guard let c = r.dueDateComponents else { return nil }
        if c.hour == nil {
            // All-day: YYYY-MM-DD
            guard let y = c.year, let m = c.month, let d = c.day else { return nil }
            return String(format: "%04d-%02d-%02d", y, m, d)
        } else {
            let cal = Calendar(identifier: .gregorian)
            guard let date = cal.date(from: c) else { return nil }
            return iso8601(date)
        }
    }

    private func iso8601(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    /// EKReminder gained a typed `parent` accessor in macOS 14. Read it defensively via KVC so the
    /// helper still builds against the SDK on older toolchains. Returns the parent's calendar item
    /// identifier, or nil if this reminder is top-level.
    private func parentIdOf(_ r: EKReminder) -> String? {
        // Try modern KVC key first.
        if let parent = r.value(forKey: "parentReminder") as? EKReminder {
            return parent.calendarItemIdentifier
        }
        if let parent = r.value(forKey: "parent") as? EKReminder {
            return parent.calendarItemIdentifier
        }
        return nil
    }

    /// EKReminder doesn't expose `flagged` directly until very recent macOS. Read via KVC.
    private func readFlagged(_ r: EKReminder) -> Bool {
        if let v = r.value(forKey: "flagged") as? Bool { return v }
        if let v = r.value(forKey: "isFlagged") as? Bool { return v }
        return false
    }
}
