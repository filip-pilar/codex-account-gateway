import XCTest
@testable import GatewayBar

final class PresentationTests: XCTestCase {
    func testConnectionStatusSupportsPartialAndOlderInstallations() throws {
        let decoder = JSONDecoder()
        for update in [",\"needs_update\":true", ",\"needs_update\":false", ""] {
            let json = "{\"ok\":true,\"code\":\"global_status\",\"global\":{\"enabled\":true,\"port\":8787\(update)}}"
            let reply = try decoder.decode(Reply.self, from: Data(json.utf8))
            XCTAssertEqual(reply.global?.enabled, true)
            XCTAssertEqual(reply.global?.needs_update ?? false, update.contains("true"))
        }
    }

    func testRunningProcessDoesNotImplyReadyRouting() {
        func status(_ state: String) -> GatewayStatus {
            GatewayStatus(state: "running", routing: Routing(mode: "automatic", weekly_reserve_percent: 5, state: state, account: "default"))
        }
        XCTAssertEqual(status("ready").tone, .positive)
        XCTAssertNil(status("ready").notice)
        XCTAssertNil(status("checking_usage").notice)
        XCTAssertEqual(status("checking_usage").tone, .neutral)
        XCTAssertEqual(status("usage_degraded").title, "Ready")
        XCTAssertEqual(status("usage_degraded").notice, "Usage unavailable; requests continuing.")
        for state in ["weekly_reserve_reached", "usage_unavailable", "login_required"] {
            XCTAssertEqual(status(state).title, "Paused")
            XCTAssertEqual(status(state).tone, .caution)
            XCTAssertNotNil(status(state).notice)
        }
        XCTAssertEqual(GatewayStatus(state: "running", routing: nil).tone, .neutral)
        XCTAssertEqual(GatewayStatus(state: "stale", routing: nil).title, "Stopped")
    }

    func testUnknownUsageAllowsSelectionButConfirmedReserveAndMissingLoginStillBlock() {
        let account = Account(id: "second", label: "Work", selected: false, authenticated: true)
        func status(_ remaining: Double?, error: Bool = false) -> AccountStatus {
            AccountStatus(account: account, weekly: remaining.map { UsageWindow(remaining_percent: $0, window_minutes: 10080, resets_at: nil) }, usageError: error)
        }
        XCTAssertTrue(status(nil).canSelect)
        XCTAssertFalse(status(0).canSelect)
        XCTAssertFalse(status(5).canSelect)
        XCTAssertTrue(status(91, error: true).canSelect)
        XCTAssertFalse(status(5, error: true).canSelect)
        XCTAssertTrue(status(5.1).canSelect)
        XCTAssertEqual(status(0).title, "Weekly reserve reached")
        let signedOut = Account(id: "third", label: "Extra", selected: false, authenticated: false)
        XCTAssertEqual(AccountStatus(account: signedOut, weekly: nil, usageError: false).title, "Sign in required")
        XCTAssertFalse(AccountStatus(account: signedOut, weekly: nil, usageError: true).canSelect)
    }

    @MainActor func testDemoActionsCannotChangeTheLiveGatewayOrStartupPreferences() async {
        let defaults = UserDefaults.standard
        let enabled = defaults.bool(forKey: "runAutomatically")
        let paused = defaults.bool(forKey: "gatewayPaused")
        let model = GatewayModel(demo: true)
        await model.action(["stop"], success: "Stopped")
        await model.setAutomaticRun(true)
        await model.setGlobalProvider(false)
        let added = await model.add(label: "Test")
        let renamed = await model.rename(model.accounts[0], to: "Changed")
        let created = await model.createClient(modelID: "fixture")
        model.login(model.accounts[0])
        XCTAssertFalse(added)
        XCTAssertFalse(renamed)
        XCTAssertFalse(created)
        XCTAssertTrue(model.running)
        XCTAssertTrue(model.globalEnabled)
        XCTAssertFalse(model.loginPending)
        XCTAssertEqual(model.accounts.count, 3)
        XCTAssertEqual(defaults.bool(forKey: "runAutomatically"), enabled)
        XCTAssertEqual(defaults.bool(forKey: "gatewayPaused"), paused)
    }
}
