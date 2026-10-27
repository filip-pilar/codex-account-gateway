import Foundation

struct Routing: Decodable {
    let mode: String
    let weekly_reserve_percent: Double
    let state: String
    let account: String?

    var notice: String? {
        switch state {
        case "weekly_reserve_reached": return "All signed-in accounts have reached the 5% weekly reserve. New requests are paused until usage resets."
        case "usage_limit_reached": return mode == "fixed" ? "The selected account cannot continue. New requests are paused; other accounts will not be used." : "No account has eligible usage for the current routing settings. New requests are paused."
        case "usage_unavailable": return "Weekly usage is unavailable. New requests are paused while the gateway checks again."
        case "login_required": return mode == "fixed" ? "Sign in to the selected account to resume routing." : "Sign in to an account to resume automatic routing."
        default: return nil
        }
    }
}

// A deliberate Stop persists across app launches. Only Start or enabling
// automatic operation clears it. Unverified processes are never restarted.
struct AutomaticRun {
    var enabled: Bool
    var paused: Bool
    private var nextAttempt = Date.distantPast
    private var lastNotice: String?

    init(enabled: Bool, paused: Bool) {
        self.enabled = enabled
        self.paused = paused
    }

    mutating func shouldStart(state: String, hasAccount: Bool, now: Date = Date()) -> Bool {
        guard enabled, !paused, hasAccount, ["stopped", "stale"].contains(state), now >= nextAttempt else { return false }
        nextAttempt = now.addingTimeInterval(60)
        return true
    }

    mutating func attention(for routing: Routing?) -> String? {
        guard let routing else { return nil }
        guard let notice = routing.notice else {
            if ["ready", "usage_degraded", "credit_fallback"].contains(routing.state) { lastNotice = nil }
            return nil
        }
        guard routing.state != lastNotice else { return nil }
        lastNotice = routing.state
        return notice
    }
}
