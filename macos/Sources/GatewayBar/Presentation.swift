import Foundation

enum FeedbackScope: Equatable {
    case overview, routing, priority, settings, add, clientSetup
    case account(String), rename(String)
}

func accountNameError(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "Enter an account name." }
    // Account labels use the backend's UTF-16 limit, including emoji sequences.
    if trimmed.utf16.count > 60 { return trimmed.utf16.count == trimmed.count ? "Use no more than 60 characters." : "Name is too long (maximum 60; emoji may count as more than one)." }
    if trimmed.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) {
        return "Use a single line without control characters."
    }
    return nil
}

enum StatusTone { case positive, caution, neutral }

struct GatewayStatus {
    let title: String
    let notice: String?
    let tone: StatusTone

    init(state: String, routing: Routing?) {
        if state == "running" {
            switch routing?.state {
            case "weekly_reserve_reached":
                title = "Paused"; notice = "No account has more than 5% weekly usage left."; tone = .caution
            case "usage_limit_reached":
                title = "Paused"; notice = routing?.mode == "fixed" ? "This account cannot continue with its available usage." : "No account has eligible usage for the current routing settings."; tone = .caution
            case "credit_fallback":
                title = "Running"; notice = nil; tone = .positive
            case "usage_unavailable":
                title = "Paused"; notice = "Weekly usage unavailable. Retrying automatically."; tone = .caution
            case "usage_degraded":
                title = "Running"; notice = nil; tone = .positive
            case "login_required":
                title = "Paused"; notice = "Sign in to resume routing."; tone = .caution
            case "ready":
                title = "Running"; notice = nil; tone = .positive
            default:
                title = "Checking"; notice = nil; tone = .neutral
            }
        } else if ["stopped", "stale"].contains(state) {
            title = "Stopped"; notice = nil; tone = .neutral
        } else if state.lowercased() == "checking" {
            title = "Checking"; notice = nil; tone = .neutral
        } else {
            title = "Attention"; notice = "Unable to verify the gateway. Refresh to check again."; tone = .caution
        }
    }
}
