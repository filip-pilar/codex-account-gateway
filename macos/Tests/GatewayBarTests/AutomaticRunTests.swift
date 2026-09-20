import XCTest
@testable import GatewayBar

final class AutomaticRunTests: XCTestCase {
    func testRestartRequiresOptInCredentialsAndVerifiedStoppedState() {
        let now = Date(timeIntervalSince1970: 1000)
        var policy = AutomaticRun(enabled: false, paused: false)
        XCTAssertFalse(policy.shouldStart(state: "stopped", hasAccount: true, now: now))
        policy.enabled = true
        XCTAssertFalse(policy.shouldStart(state: "stopped", hasAccount: false, now: now))
        for state in ["running", "unavailable", "unsafe_runtime", "lifecycle_busy"] {
            XCTAssertFalse(policy.shouldStart(state: state, hasAccount: true, now: now))
        }
        XCTAssertTrue(policy.shouldStart(state: "stopped", hasAccount: true, now: now))
        XCTAssertFalse(policy.shouldStart(state: "stopped", hasAccount: true, now: now.addingTimeInterval(10)))
        XCTAssertTrue(policy.shouldStart(state: "stale", hasAccount: true, now: now.addingTimeInterval(60)))
    }

    func testManualStopSurvivesStartupAndDoesNotRestartOnTimer() {
        var policy = AutomaticRun(enabled: true, paused: true)
        XCTAssertFalse(policy.shouldStart(state: "stopped", hasAccount: true))
        policy.paused = false
        XCTAssertTrue(policy.shouldStart(state: "stopped", hasAccount: true))
    }

    func testAttentionIsReportedOnceUntilRoutingRecovers() throws {
        func routing(_ state: String) -> Routing {
            Routing(mode: "automatic", weekly_reserve_percent: 5, state: state, account: "default")
        }
        var policy = AutomaticRun(enabled: true, paused: false)
        XCTAssertNotNil(policy.attention(for: routing("weekly_reserve_reached")))
        XCTAssertNil(policy.attention(for: routing("weekly_reserve_reached")))
        XCTAssertNil(policy.attention(for: nil))
        XCTAssertNil(policy.attention(for: routing("weekly_reserve_reached")))
        XCTAssertNil(policy.attention(for: routing("ready")))
        XCTAssertNotNil(policy.attention(for: routing("weekly_reserve_reached")))
    }

    func testStatusAcceptsAdditiveRoutingWithoutConfusingRunningWithAvailableQuota() throws {
        let json = #"{"ok":true,"code":"running","routing":{"mode":"automatic","weekly_reserve_percent":5,"state":"weekly_reserve_reached","account":"default"}}"#
        let reply = try JSONDecoder().decode(Reply.self, from: Data(json.utf8))
        XCTAssertTrue(reply.ok)
        XCTAssertNotNil(reply.routing?.notice)
        let legacy = try JSONDecoder().decode(Reply.self, from: Data(#"{"ok":true,"code":"running"}"#.utf8))
        XCTAssertNil(legacy.routing)
    }
}
