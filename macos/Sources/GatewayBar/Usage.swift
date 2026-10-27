import Foundation

struct UsageStatus: Decodable {
    let checking: Bool
    let next_check_at: String?
    let accounts: [UsageSnapshot]
    var auto_activate_weekly_windows: Bool? = nil
}

struct UsageSnapshot: Decodable {
    let account: String
    let checked_at: String?
    let buckets: [UsageBucket]
    var stale: Bool
    let diagnostics: UsageDiagnostics
    var included_usage_exhausted: Bool? = nil
    var checking: Bool? = nil
    var weekly_window_state: String? = nil
    var activation: WeeklyActivation? = nil
    var usage: Usage? { checked_at.map { Usage(checked_at: $0, buckets: buckets, included_usage_exhausted: included_usage_exhausted, stale: stale, weekly_window_state: weekly_window_state) } }
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

struct WeeklyActivation: Decodable {
    let state: String
    let last_attempt_at: String?
    let last_error: String?
    var failureReason: String? {
        switch last_error {
        case "timeout": return "The activation request timed out."
        case "cancelled": return "The activation request was cancelled."
        case "login_required": return "Sign in to this account again."
        case "upstream_rejected": return "OpenAI rejected the activation request."
        case "activation_state_unavailable": return "Activation history could not be read or saved."
        case .some: return "The activation request or verification did not complete."
        case .none: return nil
        }
    }
    var text: String {
        switch state {
        case "pending": return "Starting weekly window…"
        case "verifying": return "Request completed · verifying reset"
        case "confirmed": return "Weekly window confirmed"
        case "failed": return "Activation failed · no automatic retry"
        default: return "Activation not confirmed · no automatic retry"
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
    var remainingText: String {
        guard remaining_percent.isFinite else { return "—" }
        let value = min(100, max(0, remaining_percent))
        return value > 0 && value < 1 ? "<1%" : value.formatted(.number.precision(.fractionLength(0))) + "%"
    }
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
        return "Resets \(date.formatted(.dateTime.month(.abbreviated).day().hour().minute())) \(TimeZone.current.abbreviation(for: date) ?? "")"
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
        if let balance, balance.isFinite {
            if balance > 0 && balance < 0.01 { return "<0.01" }
            return balance.formatted(.number.precision(.fractionLength(0...2)))
        }
        return has_credits ? "Available · balance unavailable" : "Balance unavailable"
    }
    var compactBalanceText: String {
        guard !unlimited, let balance, balance.isFinite, abs(balance) >= 1_000_000 else { return balanceText }
        if balance >= 1e15 { return "≥" + Double(1e15).formatted(.number.notation(.compactName).precision(.fractionLength(0))) }
        return "≈" + balance.formatted(.number.notation(.compactName).precision(.significantDigits(3)))
    }
    var fullBalanceText: String {
        guard !unlimited, let balance, balance.isFinite else { return balanceText }
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.usesSignificantDigits = true
        formatter.maximumSignificantDigits = 17
        return formatter.string(from: NSNumber(value: balance)) ?? String(balance)
    }
}
struct Usage: Decodable {
    let checked_at: String
    let buckets: [UsageBucket]
    var included_usage_exhausted: Bool? = nil
    var stale: Bool? = nil
    var weekly_window_state: String? = nil
    var windowStateText: String {
        if stale == true { return "Usage out of date" }
        switch weekly_window_state {
        case "appears_unstarted": return "Weekly timer appears unstarted"
        case "fixed": return weeklyWindow?.resetText ?? "Reset time unavailable"
        default: return "Weekly reset not confirmed"
        }
    }
    static func date(_ timestamp: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: timestamp) ?? ISO8601DateFormatter().date(from: timestamp)
    }
    static func observedWindowState(previous: Usage?, current: Usage) -> String {
        guard let weekly = current.weeklyWindow, let reset = weekly.resets_at, let checked = date(current.checked_at), reset > checked.timeIntervalSince1970 else { return "unknown" }
        if weekly.remaining_percent < 100 { return "fixed" }
        guard let previous, previous.stale != true, let before = previous.weeklyWindow, before.remaining_percent == 100,
              let earlierReset = before.resets_at, let earlier = date(previous.checked_at) else { return "unknown" }
        let elapsed = checked.timeIntervalSince(earlier), shift = reset - earlierReset
        guard elapsed >= 30 && elapsed <= 300 else { return "unknown" }
        if abs(shift) <= 2 { return "fixed" }
        if abs(reset - checked.timeIntervalSince1970 - 604800) <= 10 && abs(earlierReset - earlier.timeIntervalSince1970 - 604800) <= 10 && abs(shift - elapsed) <= 10 { return "appears_unstarted" }
        return "unknown"
    }
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
        guard let date = Self.date(checked_at) else { return "Last successful check unknown" }
        return "Last successful check \(date.formatted(.dateTime.month(.abbreviated).day().hour().minute()))"
    }
    var updatedText: String {
        guard let date = Self.date(checked_at) else { return "Update time unavailable" }
        let time = Calendar.current.isDateInToday(date) ? date.formatted(.dateTime.hour().minute())
            : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
        return (stale == true ? "Last updated " : "Updated ") + time
    }
}
