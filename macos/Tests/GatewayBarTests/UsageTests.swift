import XCTest
@testable import GatewayBar

final class UsageTests: XCTestCase {
    func testSharedUsageDecodesRetainedReadingsAndDoesNotMisdiagnoseFetchFailuresAsLoginFailures() throws {
        let json = #"{"ok":true,"code":"usage_status","usage_status":{"checking":false,"next_check_at":null,"accounts":[{"account":"default","checked_at":"2026-09-24T10:30:00Z","buckets":[{"id":"codex","primary":{"remaining_percent":80,"window_minutes":10080,"resets_at":null}}],"stale":true,"diagnostics":{"last_attempt_at":"2026-09-24T10:31:00Z","last_success_at":"2026-09-24T10:30:00Z","last_error":"rpc_error","consecutive_failures":1}}]}}"#
        let reply = try JSONDecoder().decode(Reply.self, from: Data(json.utf8))
        let snapshot = try XCTUnwrap(reply.usage_status?.accounts.first)
        XCTAssertEqual(snapshot.usage?.weeklyWindow?.remaining_percent, 80)
        XCTAssertEqual(snapshot.notice, "Usage check failed. Retrying automatically.")
        XCTAssertEqual(snapshot.diagnostics.consecutive_failures, 1)
        XCTAssertTrue(snapshot.stale)
    }
    func testCheckTimeAcceptsBackendFractionalSeconds() {
        for timestamp in ["2026-09-24T10:30:00.123Z", "2026-09-24T10:30:00Z"] {
            XCTAssertNotEqual(Usage(checked_at: timestamp, buckets: []).checkedText, "Last check unknown")
        }
    }
    private func window(_ minutes: Double?) -> UsageWindow {
        UsageWindow(remaining_percent: 72, window_minutes: minutes, resets_at: nil)
    }
    func testWeeklySummaryUsesDurationRatherThanPosition() {
        for primaryWeekly in [true, false] {
            let usage = Usage(checked_at: "", buckets: [UsageBucket(id: "codex", primary: window(primaryWeekly ? 10080 : 300), secondary: window(primaryWeekly ? 300 : 10080))])
            XCTAssertEqual(usage.weeklyWindow?.window_minutes, 10080)
        }
    }
    func testMissingWeeklyIsUnavailableRatherThanShortWindowOrZero() {
        let usage = Usage(checked_at: "", buckets: [UsageBucket(id: "codex", primary: window(300), secondary: window(nil))])
        XCTAssertNil(usage.weeklyWindow)
        XCTAssertNil(Usage(checked_at: "", buckets: []).weeklyWindow)
    }
    func testSeparateBucketsNeverBecomeACombinedQuota() {
        let usage = Usage(checked_at: "", buckets: [UsageBucket(id: "images", primary: window(10080), secondary: nil), UsageBucket(id: "codex", primary: window(300), secondary: nil)])
        XCTAssertNil(usage.weeklyWindow)
        let ambiguous = Usage(checked_at: "", buckets: [UsageBucket(id: "a", primary: window(10080), secondary: nil), UsageBucket(id: "b", primary: window(10080), secondary: nil)])
        XCTAssertNil(ambiguous.weeklyWindow)
    }
}
