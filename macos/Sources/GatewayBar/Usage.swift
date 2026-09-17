import Foundation

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
        guard let date = ISO8601DateFormatter().date(from: checked_at) else { return "Last check unknown" }
        return "Checked \(date.formatted(date: .omitted, time: .shortened))"
    }
}
