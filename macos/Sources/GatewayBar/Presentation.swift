import Foundation

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
                title = "Paused"; notice = "Included usage is unavailable. No account has eligible credit fallback."; tone = .caution
            case "credit_fallback":
                title = "Credit fallback"; notice = "Continuing on an account allowed to use credits."; tone = .caution
            case "usage_unavailable":
                title = "Paused"; notice = "Weekly usage unavailable. Retrying automatically."; tone = .caution
            case "usage_degraded":
                title = "Ready"; notice = "Usage unavailable; requests continuing."; tone = .caution
            case "login_required":
                title = "Paused"; notice = "Sign in to resume routing."; tone = .caution
            case "ready":
                title = "Ready"; notice = nil; tone = .positive
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

struct AccountStatus {
    let title: String
    let tone: StatusTone
    let canSelect: Bool
    var rowNote: String? { canSelect || tone == .positive ? nil : title }

    init(account: Account, weekly: UsageWindow?, usageError: Bool, allowReserveUsage: Bool = false, usage: Usage? = nil) {
        let expired = usage?.coreBucket?.windows.contains { ($0.resets_at ?? .infinity) <= Date().timeIntervalSince1970 } == true
        let fallback = account.allowsCreditFallback && !usageError && !expired && weekly != nil && usage?.coreBucket?.credits?.available == true
        let exhausted = usage?.exhausted == true || weekly?.remaining_percent == 0
        if !account.authenticated {
            title = "Sign in required"; tone = .neutral; canSelect = false
        } else if exhausted {
            title = fallback ? "Credit fallback available" : "Included usage exhausted"
            tone = .caution; canSelect = fallback && !account.selected
        } else if let weekly, weekly.remaining_percent <= 5 {
            title = allowReserveUsage ? (account.selected ? "Selected · Using reserve" : "Reserve available") : fallback ? "Credit fallback available" : "Weekly reserve reached"
            tone = .caution; canSelect = (allowReserveUsage || fallback) && !account.selected
        } else if usageError {
            title = "Usage out of date"; tone = .caution; canSelect = !account.selected
        } else if weekly == nil {
            title = "Usage unavailable"; tone = .neutral; canSelect = !account.selected
        } else {
            title = account.selected ? "Selected" : "Available"
            tone = account.selected ? .positive : .neutral
            canSelect = !account.selected
        }
    }
}
