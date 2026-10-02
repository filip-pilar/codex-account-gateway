import XCTest
@testable import GatewayBar

final class UsageTests: XCTestCase {
    func testCreditsDecodeAndAccountSelectionRequiresFreshOptInAfterExhaustion() throws {
        let json = #"{"checked_at":"2026-10-02T10:00:00Z","buckets":[{"id":"codex","primary":{"remaining_percent":0,"window_minutes":300},"secondary":{"remaining_percent":80,"window_minutes":10080},"credits":{"has_credits":true,"unlimited":false,"balance":62706.25}}]}"#
        let usage = try JSONDecoder().decode(Usage.self, from: Data(json.utf8))
        XCTAssertEqual(usage.coreBucket?.credits?.balance, 62706.25)
        XCTAssertTrue(usage.exhausted)
        var account = Account(id: "default", label: "Default", selected: false, authenticated: true)
        func state(_ error: Bool = false) -> AccountStatus {
            AccountStatus(account: account, weekly: usage.weeklyWindow, usageError: error, allowReserveUsage: true, usage: usage)
        }
        XCTAssertFalse(state().canSelect)
        account.allow_credit_fallback = true
        XCTAssertTrue(state().canSelect)
        XCTAssertFalse(state(true).canSelect)
        XCTAssertTrue(UsageCredits(has_credits: false, unlimited: true, balance: nil).available)
        XCTAssertFalse(UsageCredits(has_credits: true, unlimited: false, balance: 0).available)
        XCTAssertTrue(UsageCredits(has_credits: true, unlimited: false, balance: nil).available)
        let older = #"{"id":"default","label":"Default","selected":false,"authenticated":true}"#
        XCTAssertFalse(try JSONDecoder().decode(Account.self, from: Data(older.utf8)).allowsCreditFallback)
    }
    func testSharedUsageDecodesRetainedReadingsAndDoesNotMisdiagnoseFetchFailuresAsLoginFailures() throws {
        let json = #"{"ok":true,"code":"usage_status","usage_status":{"checking":false,"next_check_at":null,"accounts":[{"account":"default","checked_at":"2026-09-24T10:30:00Z","buckets":[{"id":"codex","primary":{"remaining_percent":80,"window_minutes":10080,"resets_at":null}}],"stale":true,"included_usage_exhausted":true,"diagnostics":{"last_attempt_at":"2026-09-24T10:31:00Z","last_success_at":"2026-09-24T10:30:00Z","last_error":"rpc_error","consecutive_failures":1}}]}}"#
        let reply = try JSONDecoder().decode(Reply.self, from: Data(json.utf8))
        let snapshot = try XCTUnwrap(reply.usage_status?.accounts.first)
        XCTAssertEqual(snapshot.usage?.weeklyWindow?.remaining_percent, 80)
        XCTAssertEqual(snapshot.usage?.exhausted, true)
        XCTAssertNotNil(snapshot.notice)
        XCTAssertTrue(snapshot.stale)
    }
    func testWeeklySummaryRequiresAnUnambiguousSevenDayWindow() {
        func bucket(_ id: String = "codex", _ primary: Double?, _ secondary: Double? = nil) -> UsageBucket {
            func window(_ minutes: Double) -> UsageWindow {
                UsageWindow(remaining_percent: 72, window_minutes: minutes, resets_at: nil)
            }
            return UsageBucket(id: id, primary: primary.map(window), secondary: secondary.map(window))
        }
        let cases: [([UsageBucket], Bool)] = [
            ([bucket("codex", 10080, 300)], true),
            ([bucket("codex", 300, 10080)], true),
            ([bucket("codex", 300)], false),
            ([], false),
            ([bucket("images", 10080), bucket("codex", 300)], false),
            ([bucket("a", 10080), bucket("b", 10080)], false),
        ]
        for (buckets, hasWeekly) in cases {
            let usage = Usage(checked_at: "", buckets: buckets)
            XCTAssertEqual(usage.weeklyWindow?.window_minutes, hasWeekly ? 10080 : nil)
        }
    }
}
