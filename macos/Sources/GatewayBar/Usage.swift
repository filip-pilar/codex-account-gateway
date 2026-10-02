import Foundation

struct UsageStatus: Decodable {
    let checking: Bool
    let next_check_at: String?
    let accounts: [UsageSnapshot]
}

struct UsageSnapshot: Decodable {
    let account: String
    let checked_at: String?
    let buckets: [UsageBucket]
    let stale: Bool
    let diagnostics: UsageDiagnostics
    var included_usage_exhausted: Bool? = nil
    var usage: Usage? { checked_at.map { Usage(checked_at: $0, buckets: buckets, included_usage_exhausted: included_usage_exhausted) } }
    var notice: String? {
        switch diagnostics.last_error {
        case "login_required": return "Sign in to this account first."
        case "cli_unavailable": return "The official Codex CLI is unavailable."
        case "timeout": return "Usage check timed out. Retrying automatically."
        case "missing_weekly_window": return "Weekly usage was not reported. Retrying automatically."
        case "stale_response": return "Usage report is out of date. Retrying automatically."
        case .some: return "Usage check failed. Retrying automatically."
        case .none: return stale ? "Usage is out of date or unavailable. Retrying automatically." : nil
        }
    }
}

struct UsageDiagnostics: Decodable {
    let last_attempt_at: String?
    let last_success_at: String?
    let last_error: String?
    let consecutive_failures: Int
}

struct UsageWindow: Decodable {
    let remaining_percent: Double
    let window_minutes: Double?
    let resets_at: Double?
    var title: String {
        guard let minutes = window_minutes else { return "Usage window" }
        if minutes == 10_080 { return "Weekly" }
        if minutes.truncatingRemainder(dividingBy: 1_440) == 0 { return "\(Int(minutes / 1_440))-day" }
        if minutes.truncatingRemainder(dividingBy: 60) == 0 { return "\(Int(minutes / 60))-hour" }
        return "\(Int(minutes))-minute"
    }
    var resetText: String? {
        guard let timestamp = resets_at else { return nil }
        let date = Date(timeIntervalSince1970: timestamp)
        if date <= Date() { return "Reset time passed · refresh usage" }
        return "Resets \(date.formatted(.dateTime.weekday(.abbreviated).hour().minute()))"
    }
}
struct UsageBucket: Decodable, Identifiable {
    let id: String
    let primary: UsageWindow?
    let secondary: UsageWindow?
    var credits: UsageCredits? = nil
    var windows: [UsageWindow] {
        [primary, secondary].compactMap { $0 }.sorted {
            ($0.window_minutes == 10_080 ? 0 : 1) < ($1.window_minutes == 10_080 ? 0 : 1)
        }
    }
}
struct UsageCredits: Decodable {
    let has_credits: Bool
    let unlimited: Bool
    let balance: Double?
    var available: Bool { unlimited || has_credits && balance != 0 }
    var balanceText: String {
        if unlimited { return "Unlimited" }
        if let balance { return balance.formatted() }
        return has_credits ? "Available · balance unavailable" : "None available"
    }
}
struct Usage: Decodable {
    let checked_at: String
    let buckets: [UsageBucket]
    var included_usage_exhausted: Bool? = nil
    // Only a seven-day window in the core bucket supplies the weekly summary.
    var coreBucket: UsageBucket? {
        buckets.first(where: { $0.id == "codex" }) ?? (buckets.count == 1 ? buckets.first : nil)
    }
    var weeklyWindow: UsageWindow? {
        let bucket = coreBucket
        return [bucket?.primary, bucket?.secondary].compactMap { $0 }.first { $0.window_minutes == 10_080 }
    }
    var exhausted: Bool { included_usage_exhausted ?? (coreBucket?.windows.contains { $0.remaining_percent <= 0 } == true) }
    var checkedText: String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: checked_at) ?? ISO8601DateFormatter().date(from: checked_at) else { return "Last check unknown" }
        return "Checked \(date.formatted(date: .omitted, time: .shortened))"
    }
}
