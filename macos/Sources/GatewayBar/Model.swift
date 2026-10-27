import AppKit
import SwiftUI
import ServiceManagement
import UserNotifications

struct Account: Decodable, Identifiable {
    let id: String
    let label: String
    let selected: Bool
    let authenticated: Bool
    var allow_credit_fallback: Bool? = nil
    var allowsCreditFallback: Bool { allow_credit_fallback == true }
}
struct Reply: Decodable {
    let ok: Bool
    let code: String
    let accounts: [Account]?
    let account: AddedAccount?
    let config: String?
    let launch_command: String?
    let client_dir: String?
    let url: String?
    let auto_activate_weekly_windows: Bool?
    let routing: Routing?
    let routing_policy: RoutingPolicy?
    let usage_status: UsageStatus?
    let global: GlobalProvider?
    struct AddedAccount: Decodable { let id: String }
    struct GlobalProvider: Decodable { let enabled: Bool; let port: Int?; let needs_update: Bool? }
    enum CodingKeys: String, CodingKey { case auto_activate_weekly_windows, ok, code, accounts, account, config, launch_command, client_dir, url, routing, routing_policy, usage_status, global }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok)
        code = try c.decode(String.self, forKey: .code)
        accounts = try c.decodeIfPresent([Account].self, forKey: .accounts)
        account = try? c.decode(AddedAccount.self, forKey: .account)
        config = try c.decodeIfPresent(String.self, forKey: .config)
        launch_command = try c.decodeIfPresent(String.self, forKey: .launch_command)
        client_dir = try c.decodeIfPresent(String.self, forKey: .client_dir)
        url = try c.decodeIfPresent(String.self, forKey: .url)
        auto_activate_weekly_windows = try c.decodeIfPresent(Bool.self, forKey: .auto_activate_weekly_windows)
        routing = try c.decodeIfPresent(Routing.self, forKey: .routing)
        routing_policy = try c.decodeIfPresent(RoutingPolicy.self, forKey: .routing_policy)
        usage_status = try c.decodeIfPresent(UsageStatus.self, forKey: .usage_status)
        global = try c.decodeIfPresent(GlobalProvider.self, forKey: .global)
    }
}
struct GatewayFailure: Error { let code: String }

// No shell evaluation: backend arguments are passed directly to Node. Login alone
// opens an interactive Terminal owned by the user; its output is never captured.
struct Backend {
    let script: String
    let node: String
    let environment: [String: String]
    private var runOverride: (([String]) async throws -> Data)?
    init() {
        let env = ProcessInfo.processInfo.environment
        let resource = Bundle.main.resourceURL?.appendingPathComponent("backend/src/cli.mjs").path
        script = env["CODEX_GATEWAY_CLI"] ?? resource ?? ""
        let candidates = [Bundle.main.object(forInfoDictionaryKey: "GatewayNodePath") as? String,
                          "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].compactMap { $0 }
        node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) ?? "/usr/bin/env"
        var environment = env
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
        for key in ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"] { environment.removeValue(forKey: key) }
        self.environment = environment
    }
    init(run: @escaping ([String]) async throws -> Data) { self.init(); runOverride = run }
    func run(_ arguments: [String]) async throws -> Data {
        if let runOverride { return try await runOverride(arguments) }
        let executable = node, path = script, env = environment
        return try await Task.detached(priority: .userInitiated) {
            guard FileManager.default.fileExists(atPath: path) else { throw GatewayFailure(code: "backend_missing") }
            let process = Process(), pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = (executable == "/usr/bin/env" ? ["node"] : []) + [path] + arguments + ["--json"]
            process.environment = env
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            process.standardInput = FileHandle.nullDevice
            do { try process.run() } catch { throw GatewayFailure(code: "node_unavailable") }
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 25, execute: timeout)
            var data = Data()
            while let chunk = try pipe.fileHandleForReading.read(upToCount: 8192), !chunk.isEmpty {
                data.append(chunk)
                if data.count > 1_048_576 { process.terminate(); throw GatewayFailure(code: "invalid_response") }
            }
            process.waitUntilExit(); timeout.cancel()
            guard !data.isEmpty else { throw GatewayFailure(code: "backend_unavailable") }
            return data
        }.value
    }
    func reply(_ arguments: [String]) async throws -> Reply {
        do { return try JSONDecoder().decode(Reply.self, from: await run(arguments)) }
        catch let error as GatewayFailure { throw error }
        catch { throw GatewayFailure(code: "invalid_response") }
    }
    func loginCommand(id: String) -> String {
        var parts = ["env", "-u", "OPENAI_API_KEY", "-u", "CODEX_API_KEY", "-u", "OPENAI_BASE_URL",
                     "PATH=" + (environment["PATH"] ?? "")]
        if let root = environment["CODEX_GATEWAY_HOME"] { parts.append("CODEX_GATEWAY_HOME=" + root) }
        parts += [node]
        if node == "/usr/bin/env" { parts.append("node") }
        parts += [script, "login", "--account", id]
        return parts.map(shellQuote).joined(separator: " ")
    }
}
func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }

@MainActor final class GatewayModel: ObservableObject {
    @Published var accounts: [Account] = []
    @Published var usages: [String: Usage] = [:]
    @Published var usageErrors: [String: String] = [:]
    @Published var usageSnapshots: [String: UsageSnapshot] = [:]
    @Published var componentErrors: [String: String] = [:]
    @Published var state = "Checking"
    @Published var endpoint = "http://127.0.0.1:8787/v1"
    @Published var busy = false
    @Published var savingCredits: Set<String> = []
    @Published var checkingUsage = false
    @Published var refreshingAccount: String?
    @Published var runAutomatically: Bool
    @Published var autoActivateWeeklyWindows = false
    @Published var routing: Routing?
    @Published var routingPolicy = RoutingPolicy()
    @Published var routingKnown = false
    @Published var globalEnabled = false
    @Published var connectionNeedsUpdate = false
    @Published var connectionKnown = false
    @Published var startupNeedsApproval = false
    @Published var message: String?
    @Published var isError = false
    @Published var messageScope: FeedbackScope = .overview
    @Published var loginNoticeHidden = false
    @Published var checkingLogin = false
    @Published var loginFailures: [String: String] = [:]
    @Published var pendingLogin: LoginAttempt?
    var loginPending: Bool { pendingLogin != nil }
    var connectionTitle: String {
        if !connectionKnown { return componentErrors["Codex connection"] == nil ? "Checking…" : "Needs inspection" }
        if connectionNeedsUpdate { return "Update needed" }
        return globalEnabled ? "Configured" : "Not configured"
    }
    private let backend: Backend
    private var automatic: AutomaticRun
    private var monitoring: Task<Void, Never>?
    private var polling = false
    private var refreshing = false
    private var lastUsageRefresh = Date.distantPast
    let isDemo: Bool
    var running: Bool { state == "running" }
    var selectedReady: Bool { accounts.contains { $0.authenticated } }
    var currentAccount: Account? {
        if routingPolicy.mode == "fixed" { return accounts.first { $0.id == routingPolicy.fixed_account } }
        let id = routing?.account
        return accounts.first { $0.id == id } ?? accounts.first { $0.selected }
    }
    var orderedAccounts: [Account] {
        routingPolicy.account_order.compactMap { id in accounts.first { $0.id == id } }
            + accounts.filter { !routingPolicy.account_order.contains($0.id) }
    }

    init(demo: Bool = ProcessInfo.processInfo.arguments.contains("--demo") || Bundle.main.object(forInfoDictionaryKey: "GatewayDemoMode") as? Bool == true, backend: Backend = Backend(), monitor: Bool = true, automaticRun: AutomaticRun? = nil) {
        self.backend = backend
        isDemo = demo
        let enabled = demo ? false : UserDefaults.standard.bool(forKey: "runAutomatically")
        runAutomatically = enabled
        automatic = automaticRun ?? AutomaticRun(enabled: enabled, paused: demo ? false : UserDefaults.standard.bool(forKey: "gatewayPaused"))
        if isDemo { loadDemo(); return }
        guard monitor else { return }
        monitoring = Task { [weak self] in
            while !Task.isCancelled {
                await self?.poll()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    deinit { monitoring?.cancel() }

    func refresh(includeUsage: Bool = false, showFeedback: Bool = true, scope: FeedbackScope = .overview) async {
        if isDemo { loadDemo(); return }
        guard !refreshing else { return }
        refreshing = true; defer { refreshing = false }
        await poll()
        guard includeUsage || Date().timeIntervalSince(lastUsageRefresh) > 300 else { return }
        if running {
            do {
                let reply = try await backend.reply(["usage-status", "--refresh"])
                guard reply.ok, let usage = reply.usage_status else { throw GatewayFailure(code: reply.code) }
                applyUsage(usage)
                routing = reply.routing
                let deadline = Date().addingTimeInterval(90)
                while checkingUsage && running && Date() < deadline && !Task.isCancelled {
                    try await Task.sleep(for: .seconds(1))
                    try await pullUsage()
                }
                if includeUsage && showFeedback { showMessage(checkingUsage ? "Usage is still being checked." : usageRefreshFeedback, scope: scope) }
                lastUsageRefresh = Date()
            } catch { componentErrors["Usage"] = readable(error); markUsageUnavailable() }
            return
        }
        checkingUsage = true; defer { checkingUsage = false }
        for account in accounts where account.authenticated {
            refreshingAccount = account.id
            let previous = usageSnapshots[account.id]
            let attemptedAt = ISO8601DateFormatter().string(from: Date())
            do {
                let data = try await backend.run(["usage", "--account", account.id])
                if running { break }
                let reply = try JSONDecoder().decode(Reply.self, from: data)
                guard reply.ok else { throw GatewayFailure(code: reply.code) }
                let usage = try JSONDecoder().decode(Usage.self, from: data)
                let windowState = Usage.observedWindowState(previous: usages[account.id], current: usage)
                let snapshot = UsageSnapshot(account: account.id, checked_at: usage.checked_at, buckets: usage.buckets, stale: false,
                    diagnostics: UsageDiagnostics(last_attempt_at: attemptedAt, last_success_at: usage.checked_at, last_error: nil, consecutive_failures: 0), weekly_window_state: windowState)
                usageSnapshots[account.id] = snapshot
                usages[account.id] = snapshot.usage
                usageErrors[account.id] = nil
            } catch { if !running {
                usageErrors[account.id] = readable(error)
                usageSnapshots[account.id] = UsageSnapshot(account: account.id, checked_at: previous?.checked_at, buckets: previous?.buckets ?? [], stale: true,
                    diagnostics: UsageDiagnostics(last_attempt_at: attemptedAt, last_success_at: previous?.diagnostics.last_success_at, last_error: "usage_unavailable", consecutive_failures: (previous?.diagnostics.consecutive_failures ?? 0) + 1))
                usages[account.id] = usageSnapshots[account.id]?.usage
            } }
        }
        refreshingAccount = nil
        lastUsageRefresh = Date()
        componentErrors["Usage"] = nil
        if includeUsage && showFeedback { showMessage(usageRefreshFeedback, scope: scope) }
    }
    private var usageRefreshFeedback: String {
        usageErrors.isEmpty ? "Usage check completed." : "Usage check finished. Some accounts could not be checked."
    }

    private func applyUsage(_ status: UsageStatus) {
        checkingUsage = status.checking
        if let enabled = status.auto_activate_weekly_windows { autoActivateWeeklyWindows = enabled }
        usageSnapshots = Dictionary(uniqueKeysWithValues: status.accounts.map { ($0.account, $0) })
        usages = Dictionary(uniqueKeysWithValues: status.accounts.compactMap { snapshot in
            snapshot.usage.map { (snapshot.account, $0) }
        })
        usageErrors = Dictionary(uniqueKeysWithValues: status.accounts.compactMap { snapshot in
            guard accounts.contains(where: { $0.id == snapshot.account && $0.authenticated }) else { return nil }
            return snapshot.notice.map { (snapshot.account, $0) }
        })
    }

    private func pullUsage() async throws {
        let reply = try await backend.reply(["usage-status"])
        guard reply.ok, let snapshot = reply.usage_status else { throw GatewayFailure(code: reply.code) }
        applyUsage(snapshot); routing = reply.routing; componentErrors["Usage"] = nil
    }
    private func markUsageUnavailable() {
        checkingUsage = false
        for id in Set(usages.keys).union(usageSnapshots.keys) {
            usages[id]?.stale = true; usageErrors[id] = "Usage could not be checked."
            usageSnapshots[id]?.stale = true; usageSnapshots[id]?.checking = false
        }
    }

    private func updateStoppedUsage() {
        for id in usageSnapshots.keys {
            usageSnapshots[id]?.checking = false
            guard let checked = usageSnapshots[id]?.checked_at.flatMap(Usage.date), Date().timeIntervalSince(checked) < 300 else {
                usageSnapshots[id]?.stale = true; usages[id]?.stale = true
                if accounts.contains(where: { $0.id == id && $0.authenticated }) { usageErrors[id] = "Usage is out of date. Refresh usage to check again." }
                continue
            }
        }
        checkingUsage = refreshingAccount != nil
    }

    private func poll() async {
        guard !busy, savingCredits.isEmpty, !polling, !isDemo else { return }
        polling = true; defer { polling = false }
        do {
            let status = try await backend.reply(["status"])
            state = status.code
            routing = status.routing
            if let url = status.url { endpoint = url }
            componentErrors["Gateway"] = nil
        } catch { state = "unavailable"; routing = nil; componentErrors["Gateway"] = readable(error) }
        var newAuthentication = false
        do {
            let listing = try await backend.reply(["accounts"])
            guard listing.ok else { throw GatewayFailure(code: listing.code) }
            let previous = Set(accounts.filter(\.authenticated).map(\.id))
            accounts = listing.accounts ?? []
            componentErrors["Accounts"] = nil
            newAuthentication = accounts.contains { $0.authenticated && !previous.contains($0.id) }
            updateLoginCompletion()
        } catch { componentErrors["Accounts"] = readable(error) }
        if running {
            do { try await pullUsage() }
            catch {
                componentErrors["Usage"] = readable(error); markUsageUnavailable()
            }
        } else if componentErrors["Gateway"] != nil { markUsageUnavailable() }
        else { updateStoppedUsage() }
        do {
            let reply = try await backend.reply(["routing"])
            guard reply.ok, let policy = reply.routing_policy else { throw GatewayFailure(code: reply.ok ? "routing_policy_unavailable" : reply.code) }
            routingPolicy = policy; routingKnown = true
            if let routing = reply.routing { self.routing = routing }
            componentErrors["Routing"] = nil
        } catch { routingKnown = false; componentErrors["Routing"] = readable(error) }
        do {
            let activation = try await backend.reply(["weekly-activation"])
            guard activation.ok else { throw GatewayFailure(code: activation.code) }
            autoActivateWeeklyWindows = activation.auto_activate_weekly_windows ?? false
            componentErrors["Activation setting"] = nil
        } catch { componentErrors["Activation setting"] = readable(error) }
        do {
            let global = try await backend.reply(["global-status"])
            guard global.ok else { throw GatewayFailure(code: global.code) }
            globalEnabled = global.global?.enabled ?? false
            connectionNeedsUpdate = global.global?.needs_update ?? false
            connectionKnown = true; componentErrors["Codex connection"] = nil
        } catch { connectionKnown = false; componentErrors["Codex connection"] = readable(error) }
        do {
            if newAuthentication && !checkingUsage && !refreshing {
                Task { await self.refresh(includeUsage: true, showFeedback: false) }
            }
            startupNeedsApproval = runAutomatically && SMAppService.mainApp.status != .enabled
            if let notice = automatic.attention(for: routing) { notifyAttention(notice) }
            if !busy && componentErrors["Accounts"] == nil && automatic.shouldStart(state: state, hasAccount: selectedReady) {
                busy = true; defer { busy = false }
                let started = try await backend.reply(["start", "--background"])
                guard started.ok else { throw GatewayFailure(code: started.code) }
                state = "running"
                routing = started.routing
                if let url = started.url { endpoint = url }
            }
            componentErrors["Automatic operation"] = nil
        } catch { componentErrors["Automatic operation"] = readable(error) }
    }

    private func updateLoginCompletion() {
        guard let attempt = pendingLogin else { return }
        let exitCode = (try? String(contentsOf: attempt.completionURL, encoding: .utf8)).flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        switch attempt.result(exitCode: exitCode, accounts: accounts) {
        case .waiting: break
        case .succeeded:
            dismissLogin(); loginFailures[attempt.accountID] = nil
            showMessage("Signed in to \(attempt.label).", scope: .account(attempt.accountID))
        case .failed:
            dismissLogin()
            let text = "Sign-in to \(attempt.label) did not complete. Try signing in again."
            loginFailures[attempt.accountID] = text
            showMessage(text, scope: .account(attempt.accountID), error: true)
        }
    }
    func dismissLogin() {
        if let completion = pendingLogin?.completionURL, FileManager.default.fileExists(atPath: completion.path) {
            try? FileManager.default.removeItem(at: completion)
            try? FileManager.default.removeItem(at: completion.deletingLastPathComponent())
        }
        pendingLogin = nil; loginNoticeHidden = false
    }
    func inspectGlobalConfig() { NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex/config.toml")) }
    func setWeeklyActivation(_ enabled: Bool) async {
        guard !busy, !isDemo else { return }
        busy = true
        do {
            let reply = try await backend.reply(["weekly-activation", "--enabled", enabled ? "true" : "false"])
            guard reply.ok else { throw GatewayFailure(code: reply.code) }
            autoActivateWeeklyWindows = reply.auto_activate_weekly_windows ?? enabled
            clearFeedback(.settings)
        } catch { report(error, scope: .settings) }
        busy = false; await poll()
    }

    func setAutomaticRun(_ enabled: Bool) async {
        guard !busy, !isDemo else { return }
        busy = true
        do {
            if enabled {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            } else {
                try await SMAppService.mainApp.unregister()
            }
            runAutomatically = enabled
            UserDefaults.standard.set(enabled, forKey: "runAutomatically")
            UserDefaults.standard.set(false, forKey: "gatewayPaused")
            automatic = AutomaticRun(enabled: enabled, paused: false)
            startupNeedsApproval = enabled && SMAppService.mainApp.status != .enabled
        } catch {
            showMessage("Could not change automatic startup. Move the app to Applications and check System Settings → General → Login Items.", scope: .settings, error: true)
        }
        busy = false
        await poll()
    }

    func setCreditFallback(_ account: Account, enabled: Bool) async {
        guard !busy, !savingCredits.contains(account.id) else { return }
        if isDemo {
            if let index = accounts.firstIndex(where: { $0.id == account.id }) { accounts[index].allow_credit_fallback = enabled }
            return
        }
        savingCredits.insert(account.id)
        while polling { try? await Task.sleep(for: .milliseconds(20)) }
        do {
            let reply = try await backend.reply(["credit-fallback", "--account", account.id, "--enabled", enabled ? "true" : "false"])
            guard reply.ok else { throw GatewayFailure(code: reply.code) }
            if let index = accounts.firstIndex(where: { $0.id == account.id }) { accounts[index].allow_credit_fallback = enabled }
            clearFeedback(.account(account.id))
        } catch { report(error, scope: .account(account.id)) }
        savingCredits.remove(account.id)
        await poll()
    }

    @discardableResult func setRouting(mode: String? = nil, account: String? = nil, order: [String]? = nil, fallback: String? = nil, scope: FeedbackScope = .routing) async -> Bool {
        guard !busy else { return false }
        clearFeedback(scope)
        if isDemo {
            if let mode { routingPolicy.mode = mode }
            if let account { routingPolicy.fixed_account = account }
            if let order { routingPolicy.account_order = order }
            if let fallback { routingPolicy.fallback = fallback }
            return true
        }
        var saved = false
        busy = true
        while polling { try? await Task.sleep(for: .milliseconds(20)) }
        do {
            var args = ["routing"]
            if let mode { args += ["--mode", mode] }
            if let account { args += ["--account", account] }
            if let order { args += ["--order", order.joined(separator: ",")] }
            if let fallback { args += ["--fallback", fallback] }
            let reply = try await backend.reply(args)
            guard reply.ok, let policy = reply.routing_policy else { throw GatewayFailure(code: reply.code) }
            routingPolicy = policy; routingKnown = true
            if let routing = reply.routing { self.routing = routing }
            clearFeedback(scope); saved = true
        } catch { report(error, scope: scope) }
        busy = false; await poll()
        return saved
    }

    func setGlobalProvider(_ enabled: Bool) async {
        guard !busy, !isDemo else { return }
        busy = true
        do {
            let port = URLComponents(string: endpoint)?.port ?? 8787
            let args = enabled ? ["global-enable", "--port", String(port)] : ["global-disable"]
            let reply = try await backend.reply(args)
            guard reply.ok else { throw GatewayFailure(code: reply.code) }
            globalEnabled = reply.global?.enabled ?? enabled
            connectionNeedsUpdate = reply.global?.needs_update ?? false
            showMessage(enabled ? "Connection updated. Restart Codex to apply." : "Connection restored. Restart Codex to apply.", scope: .settings)
        } catch { report(error, scope: .settings) }
        busy = false
        await poll()
    }

    func openLoginSettings() { SMAppService.openSystemSettingsLoginItems() }

    private func notifyAttention(_ text: String) {
        let content = UNMutableNotificationContent()
        content.title = "Codex Gateway needs attention"
        content.body = text
        let request = UNNotificationRequest(identifier: "gateway-attention", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }
    @discardableResult func action(_ args: [String], success: String? = nil, scope: FeedbackScope = .overview) async -> Bool {
        guard !busy, !isDemo else { return false }
        clearFeedback(scope)
        var completed = false
        // Persist the user's intent before stopping, so monitoring cannot undo it.
        if args.first == "stop" || args.first == "start" {
            automatic.paused = args.first == "stop"
            UserDefaults.standard.set(automatic.paused, forKey: "gatewayPaused")
        }
        busy = true
        do {
            let reply = try await backend.reply(args)
            guard reply.ok else { throw GatewayFailure(code: reply.code) }
            if let success { showMessage(success, scope: scope) }; completed = true
        } catch { report(error, scope: scope) }
        busy = false
        await poll()
        return completed
    }
    func add(label: String) async -> Bool {
        guard !busy, !isDemo, !loginPending else { return false }
        var completed = false
        busy = true
        do {
            let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
            let reply = try await backend.reply(["account-add", "--label", name])
            guard reply.ok, let account = reply.account else { throw GatewayFailure(code: reply.code) }
            completed = true
            do {
                let completion = try openTerminal(backend.loginCommand(id: account.id), trackCompletion: true, loginAccountID: account.id)!
                pendingLogin = LoginAttempt(accountID: account.id, label: name, completionURL: completion)
                loginNoticeHidden = false; loginFailures[account.id] = nil; clearFeedback(.add)
            } catch {
                loginFailures[account.id] = "Account added. Sign-in could not open; try again from this account."
                report(error, scope: .account(account.id))
            }
        } catch { report(error, scope: .add) }
        busy = false; await refresh()
        return completed
    }
    func login(_ account: Account) {
        guard !isDemo, !busy else { return }
        if loginPending { returnToSignIn(); return }
        do {
            let completion = try openTerminal(backend.loginCommand(id: account.id), trackCompletion: true, loginAccountID: account.id)!
            pendingLogin = LoginAttempt(accountID: account.id, label: account.label, completionURL: completion)
            loginNoticeHidden = false; loginFailures[account.id] = nil; clearFeedback(.account(account.id))
        } catch { report(error, scope: .account(account.id)) }
    }
    func returnToSignIn() {
        guard let attempt = pendingLogin else { return }
        loginNoticeHidden = false
        guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else {
            showMessage("Terminal is unavailable. Complete the existing sign-in before starting another.", scope: .account(attempt.accountID), error: true); return
        }
        NSWorkspace.shared.openApplication(at: terminal, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
    }
    func checkLogin() async {
        guard !checkingLogin, !busy else { return }
        checkingLogin = true; defer { checkingLogin = false }
        await poll()
        if !loginPending { await refresh(includeUsage: true, showFeedback: false) }
    }
    func rename(_ account: Account, to newLabel: String) async -> Bool {
        guard !busy, !isDemo else { return false }
        var completed = false
        busy = true
        do {
            let reply = try await backend.reply(["account-rename", "--account", account.id, "--label", newLabel.trimmingCharacters(in: .whitespacesAndNewlines)])
            guard reply.ok else { throw GatewayFailure(code: reply.code) }
            clearFeedback(.rename(account.id)); completed = true
        } catch { report(error, scope: .rename(account.id)) }
        busy = false
        await poll()
        return completed
    }
    func createClient(modelID: String) async -> Bool {
        guard !busy, !isDemo else { return false }
        let panel = NSSavePanel()
        panel.title = "Create a Codex client profile"
        panel.message = "Create a new profile folder and open Codex in Terminal. Existing configuration is never overwritten."
        panel.prompt = "Create & Open"
        panel.nameFieldLabel = "Folder name:"
        panel.showsTagField = false
        panel.nameFieldStringValue = "Codex Gateway Client"
        panel.canCreateDirectories = true
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        busy = true; defer { busy = false }
        do {
            let port = URLComponents(string: endpoint)?.port ?? 8787
            let reply = try await backend.reply(["setup", "--model", modelID.trimmingCharacters(in: .whitespacesAndNewlines), "--port", String(port), "--client-dir", url.path])
            guard reply.ok, let command = reply.launch_command else { throw GatewayFailure(code: reply.code) }
            let launch = "export PATH=" + shellQuote(backend.environment["PATH"] ?? "") + "\n" + command
            try openTerminal(launch)
            clearFeedback(.clientSetup)
            return true
        } catch { report(error, scope: .clientSetup); return false }
    }
    func copyEndpoint() {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(endpoint, forType: .string)
    }
    @discardableResult private func openTerminal(_ command: String, trackCompletion: Bool = false, loginAccountID: String? = nil) throws -> URL? {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("codex-gateway-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent("Codex Gateway.command")
        let completion = trackCompletion ? directory.appendingPathComponent("login-exit-code") : nil
        // The script contains paths and arguments only, never authentication data.
        let record = completion.map { "umask 077\nprintf '%s\\n' \"$result\" > " + shellQuote($0.path) + "\n" } ?? ""
        let cleanup = completion == nil ? "/bin/rmdir -- " + shellQuote(directory.path) + "\n" : ""
        let finish = "result=$?\n" + record + "/bin/rm -f -- " + shellQuote(file.path) + "\n" + cleanup + "exit $result\n"
        // Closing the login window must also complete its tracked attempt.
        let text = "#!/bin/zsh\ntrap " + shellQuote(finish) + " EXIT\ntrap 'exit 129' HUP\ntrap 'exit 130' INT\ntrap 'exit 143' TERM\n" + command + "\nexit $?\n"
        try text.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        let config = NSWorkspace.OpenConfiguration()
        guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else { throw GatewayFailure(code: "terminal_unavailable") }
        NSWorkspace.shared.open([file], withApplicationAt: terminal, configuration: config) { _, error in
            if error != nil { Task { @MainActor in
                if self.pendingLogin?.completionURL == completion { self.dismissLogin() }
                let scope: FeedbackScope = loginAccountID.map { .account($0) } ?? .clientSetup
                let text = "Could not open Terminal. Try opening it again."
                if let loginAccountID { self.loginFailures[loginAccountID] = text }
                self.showMessage(text, scope: scope, error: true)
            } }
        }
        return completion
    }
    func clearFeedback(_ scope: FeedbackScope) {
        if messageScope == scope { message = nil; isError = false }
    }
    private func showMessage(_ text: String, scope: FeedbackScope, error: Bool = false) {
        messageScope = scope; isError = error; message = text
    }
    private func report(_ error: Error, scope: FeedbackScope) { showMessage(readable(error), scope: scope, error: true) }
    private func readable(_ error: Error) -> String {
        switch (error as? GatewayFailure)?.code {
        case "login_required": return "Sign in to this account first."
        case "gateway_busy": return "A request is running. Wait for it to finish, then switch."
        case "cli_unavailable": return "Install the official Codex CLI, then try again."
        case "node_unavailable": return "Node.js 22.15 or newer is required."
        case "usage_timeout": return "Usage check timed out. Try refreshing later."
        case "usage_unavailable": return "Usage unavailable. Try refreshing later."
        case "routing_policy_unavailable": return "Restart the gateway to load the updated routing controls."
        case "invalid_routing_policy", "invalid_account": return "Routing could not be saved. Review the accounts and try again."
        case "credit_fallback_unavailable": return "Could not update credit fallback. Restart the gateway if its backend has not been updated, then try again."
        case "usage_status_unavailable": return "Gateway usage status is unavailable. Restart the gateway to load the updated backend."
        case "port_in_use": return "Port 8787 is occupied. Stop the other service before starting."
        case "client_directory_exists": return "Choose a new folder name; that folder already exists."
        case "unsafe_client_directory": return "Choose a new folder outside gateway and existing Codex state."
        case "global_config_conflict", "global_config_changed", "global_config_unsafe", "openai_route_conflict": return "Gateway connection settings need inspection. Open the config to review them."
        case "weekly_activation_unavailable": return "Restart the gateway to load weekly activation support."
        case "invalid_arguments": return "Check the account label or model ID and try again."
        case "runtime_unavailable", "unsafe_runtime", "lifecycle_busy", "unavailable": return "Gateway needs attention. Run doctor --json in Terminal."
        case "backend_missing": return "Backend is missing. Rebuild the app using scripts/build-macos.sh."
        default: return "Could not complete this action. Check the gateway with doctor --json."
        }
    }
    private func loadDemo() {
        state = "running"
        routing = Routing(mode: "fixed", weekly_reserve_percent: 5, state: "credit_fallback", account: "second")
        routingPolicy = RoutingPolicy(mode: "fixed", fixed_account: "second", account_order: ["second", "default", "third"], fallback: "credits")
        routingKnown = true
        globalEnabled = true
        connectionKnown = true
        accounts = [Account(id: "default", label: "alex@personal.example", selected: false, authenticated: true, allow_credit_fallback: true), Account(id: "second", label: "alex@studio.example", selected: true, authenticated: true, allow_credit_fallback: true), Account(id: "third", label: "Additional account", selected: false, authenticated: true)]
        let checked = ISO8601DateFormatter().string(from: Date())
        func usage(_ weekly: Double, _ short: Double, credits: UsageCredits? = nil) -> Usage {
            Usage(checked_at: checked, buckets: [UsageBucket(id: "codex",
                primary: UsageWindow(remaining_percent: short, window_minutes: 300, resets_at: Date().addingTimeInterval(7200).timeIntervalSince1970),
                secondary: UsageWindow(remaining_percent: weekly, window_minutes: 10080, resets_at: Date().addingTimeInterval(604800).timeIntervalSince1970), credits: credits)])
        }
        usages = ["default": usage(4, 30, credits: UsageCredits(has_credits: true, unlimited: false, balance: 0.004)),
                  "second": usage(84, 0, credits: UsageCredits(has_credits: true, unlimited: false, balance: 60065.773254)), "third": usage(0, 20)]
        for id in usages.keys { usages[id]?.weekly_window_state = "fixed" }
        message = nil; isError = false
    }
}
