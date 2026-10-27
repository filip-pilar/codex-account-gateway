import Foundation

struct RoutingPolicy: Decodable {
    var mode = "automatic"
    var fixed_account: String? = nil
    var account_order: [String] = []
    var fallback = "credits"
    var title: String { mode == "fixed" ? "Stay on one account" : "Automatic" }
    var allowsReserve: Bool { ["reserve", "reserve_then_credits", "credits_then_reserve"].contains(fallback) }
    var allowsCredits: Bool { ["credits", "reserve_then_credits", "credits_then_reserve"].contains(fallback) }
    static let fallbacks = [
        ("pause", "Pause"), ("reserve", "Reserve"), ("credits", "Credit fallback"),
        ("reserve_then_credits", "Reserve then credits"), ("credits_then_reserve", "Credits then reserve")
    ]
}
