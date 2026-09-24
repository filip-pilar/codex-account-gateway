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

    init(account: Account, weekly: UsageWindow?, usageError: Bool) {
        if !account.authenticated {
            title = "Sign in required"; tone = .neutral; canSelect = false
        } else if let weekly, weekly.remaining_percent <= 5 {
            title = "Weekly reserve reached"; tone = .caution; canSelect = false
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
