import XCTest
@testable import GatewayBar

private actor FixtureBackend {
    var connectionFailure = false
    var gatewayFailure = false
    var stopped = false
    var usageChecking = false
    var requestedRefresh = false
    var commands: [String] = []
    func configure(connectionFailure: Bool = false, gatewayFailure: Bool = false, stopped: Bool = false, usageChecking: Bool = false) {
        self.connectionFailure = connectionFailure; self.gatewayFailure = gatewayFailure
        self.stopped = stopped; self.usageChecking = usageChecking
    }
    func run(_ args: [String]) throws -> Data {
        let command = args[0]; commands.append(command)
        var result: [String: Any] = ["ok": true, "code": command]
        switch command {
        case "status":
            if gatewayFailure { throw GatewayFailure(code: "node_unavailable") }
            result["ok"] = !stopped; result["code"] = stopped ? "stopped" : "running"
            result["routing"] = ["mode": "automatic", "weekly_reserve_percent": 5, "state": "ready", "account": "default"]
        case "accounts":
            result["accounts"] = [["id": "default", "label": "Default", "selected": true, "authenticated": true],
                                  ["id": "unsigned", "label": "Unsigned", "selected": false, "authenticated": false]]
        case "usage-status":
            if args.contains("--refresh") { requestedRefresh = true }
            else if requestedRefresh { usageChecking = false }
            result["usage_status"] = ["checking": usageChecking, "accounts": [["account": "default", "checked_at": "2026-10-11T17:00:00Z", "buckets": [], "stale": false,
                "diagnostics": ["last_attempt_at": "2026-10-11T17:00:00Z", "last_success_at": "2026-10-11T17:00:00Z", "consecutive_failures": 0]]]]
        case "reserve-usage": result["allow_reserve_usage"] = false
        case "weekly-activation": result["auto_activate_weekly_windows"] = false
        case "global-status":
            if connectionFailure { throw GatewayFailure(code: "global_config_conflict") }
            result["global"] = ["enabled": true, "port": 8787, "needs_update": false]
        case "start": stopped = false; result["code"] = "started"
        default: break
        }
        return try JSONSerialization.data(withJSONObject: result)
    }
}

final class StateTests: XCTestCase {
    @MainActor func testConnectionFailureDoesNotPreventRestartAndResolvedErrorsClear() async {
        let fixture = FixtureBackend()
        await fixture.configure(connectionFailure: true, stopped: true)
        let model = GatewayModel(demo: false, backend: Backend(run: { try await fixture.run($0) }), monitor: false, automaticRun: AutomaticRun(enabled: true, paused: false))
        model.accounts = [Account(id: "default", label: "Default", selected: true, authenticated: true)]
        await model.refresh()
        XCTAssertTrue(model.running)
        XCTAssertFalse(model.connectionKnown)
        XCTAssertNotNil(model.componentErrors["Codex connection"])
        let commands = await fixture.commands
        XCTAssertTrue(commands.contains("start"))
        await fixture.configure()
        await model.refresh()
        XCTAssertTrue(model.connectionKnown)
        XCTAssertTrue(model.globalEnabled)
        XCTAssertNil(model.componentErrors["Codex connection"])
        XCTAssertNil(model.message)
    }

    @MainActor func testUnverifiableGatewayDoesNotKeepRunningStateOrPreventOtherChecks() async {
        let fixture = FixtureBackend()
        await fixture.configure(gatewayFailure: true)
        let model = GatewayModel(demo: false, backend: Backend(run: { try await fixture.run($0) }), monitor: false)
        model.state = "running"
        model.checkingUsage = true
        model.usageSnapshots["default"] = UsageSnapshot(account: "default", checked_at: nil, buckets: [], stale: false,
            diagnostics: UsageDiagnostics(last_attempt_at: nil, last_success_at: nil, last_error: nil, consecutive_failures: 0), checking: true)
        await model.refresh()
        XCTAssertEqual(model.state, "unavailable")
        XCTAssertNotNil(model.componentErrors["Gateway"])
        XCTAssertTrue(model.connectionKnown)
        XCTAssertEqual(model.accounts.count, 2)
        XCTAssertFalse(model.checkingUsage)
        XCTAssertFalse(model.usageSnapshots["default"]?.checking == true)
        XCTAssertEqual(model.usageSnapshots["default"]?.stale, true)
        let commands = await fixture.commands
        XCTAssertFalse(commands.contains("start"))
    }

    @MainActor func testExistingCredentialsDoNotCompleteLoginButItsExitStatusDoes() async throws {
        let fixture = FixtureBackend()
        let model = GatewayModel(demo: false, backend: Backend(run: { try await fixture.run($0) }), monitor: false)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let completion = directory.appendingPathComponent("login-exit-code")
        model.pendingLogin = LoginAttempt(accountID: "default", label: "Default", completionURL: completion)
        await model.refresh()
        XCTAssertTrue(model.loginPending)
        try "0\n".write(to: completion, atomically: true, encoding: .utf8)
        await model.refresh()
        XCTAssertFalse(model.loginPending)
        XCTAssertEqual(model.message, "Signed in to Default.")
        XCTAssertTrue(model.accounts.contains { !$0.authenticated })
    }

    @MainActor func testManualRefreshJoinsAnExistingCheckAndWaitsForCompletion() async {
        let fixture = FixtureBackend(); await fixture.configure(usageChecking: true)
        let model = GatewayModel(demo: false, backend: Backend(run: { try await fixture.run($0) }), monitor: false)
        await model.refresh(includeUsage: true)
        XCTAssertFalse(model.checkingUsage)
        XCTAssertEqual(model.message, "Usage check completed.")
        let refreshed = await fixture.requestedRefresh
        XCTAssertTrue(refreshed)
    }

}
