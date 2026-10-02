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

}
