import Foundation

struct ListDTO: Codable {
    let id: String
    let name: String
    let color: String?
    let source: String
    let allowsModifications: Bool
}

struct ReminderDTO: Codable {
    let id: String
    let list_id: String
    let list_name: String
    let title: String
    let notes: String?
    let priority: String          // "none" | "high" | "medium" | "low"
    let due: String?              // ISO 8601 (timed) or YYYY-MM-DD (all-day) or nil
    let due_all_day: Bool
    let completed: Bool
    let completion_date: String?  // ISO 8601
    let creation_date: String?    // ISO 8601
    let modification_date: String?// ISO 8601
    let flagged: Bool
    let url: String?
    let parent_id: String?
    let subtask_ids: [String]
}

struct AuthDTO: Codable {
    let granted: Bool
    let status: String  // "authorized" | "denied" | "restricted" | "notDetermined" | "writeOnly" | "fullAccess" | "unknown"
}

struct ErrorDTO: Codable {
    let error: String
    let hint: String?
}
