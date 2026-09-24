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
    var usage: Usage? { checked_at.map { Usage(checked_at: $0, buckets: buckets) } }
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
    var windows: [UsageWindow] {
        [primary, secondary].compactMap { $0 }.sorted {
            ($0.window_minutes == 10_080 ? 0 : 1) < ($1.window_minutes == 10_080 ? 0 : 1)
        }
    }
}
struct Usage: Decodable {
    let checked_at: String
    let buckets: [UsageBucket]
    // Match the reported duration, not primary/secondary order or plan price.
    // With multiple buckets, only the explicitly identified core bucket may
    // supply the summary. Other buckets stay visible in usage details.
    var weeklyWindow: UsageWindow? {
        let bucket = buckets.first(where: { $0.id == "codex" }) ?? (buckets.count == 1 ? buckets.first : nil)
        return [bucket?.primary, bucket?.secondary].compactMap { $0 }.first { $0.window_minutes == 10_080 }
    }
    var checkedText: String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: checked_at) ?? ISO8601DateFormatter().date(from: checked_at) else { return "Last check unknown" }
        return "Checked \(date.formatted(date: .omitted, time: .shortened))"
    }
}
