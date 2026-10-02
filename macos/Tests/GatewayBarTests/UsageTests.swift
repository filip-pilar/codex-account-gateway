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
        let accountWithoutPermission = #"{"id":"default","label":"Default","selected":false,"authenticated":true}"#
        XCTAssertFalse(try JSONDecoder().decode(Account.self, from: Data(accountWithoutPermission.utf8)).allowsCreditFallback)
    }
}
