import AppKit
import SwiftUI

struct Account: Decodable, Identifiable {
    let id: String
    let label: String
    let selected: Bool
    let authenticated: Bool
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
    struct AddedAccount: Decodable { let id: String }
    enum CodingKeys: String, CodingKey { case ok, code, accounts, account, config, launch_command, client_dir, url }
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
    }
}
struct GatewayFailure: Error { let code: String }

// No shell evaluation: backend arguments are passed directly to Node. Login alone
// opens an interactive Terminal owned by the user; its output is never captured.
struct Backend {
    let script: String
    let node: String
    let environment: [String: String]
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
    func run(_ arguments: [String]) async throws -> Data {
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
    @Published var state = "Checking"
    @Published var endpoint = "http://127.0.0.1:8787/v1"
    @Published var busy = false
    @Published var message: String?
    @Published var isError = false
    @Published var adding = false
    @Published var connecting = false
    @Published var label = ""
    @Published var modelID = ""
    @Published var loginPending = false
    private let backend = Backend()
    private var lastUsageRefresh = Date.distantPast
    private let demo = ProcessInfo.processInfo.arguments.contains("--demo")
    var running: Bool { state == "running" }
    var activeName: String { accounts.first(where: \.selected)?.label ?? "No account" }
    var selectedReady: Bool { accounts.contains { $0.selected && $0.authenticated } }

    func refresh(includeUsage: Bool = false) async {
        guard !busy else { return }
        if demo { loadDemo(); return }
        busy = true; defer { busy = false }
        do {
            let status = try await backend.reply(["status"])
            state = status.code
            if let url = status.url { endpoint = url }
            let listing = try await backend.reply(["accounts"])
            guard listing.ok else { throw GatewayFailure(code: listing.code) }
            accounts = listing.accounts ?? []
            if includeUsage || Date().timeIntervalSince(lastUsageRefresh) > 300 {
                for account in accounts where account.authenticated {
                    do {
                        let data = try await backend.run(["usage", "--account", account.id])
                        let reply = try JSONDecoder().decode(Reply.self, from: data)
                        guard reply.ok else { throw GatewayFailure(code: reply.code) }
                        usages[account.id] = try JSONDecoder().decode(Usage.self, from: data)
                        usageErrors[account.id] = nil
                    } catch { usageErrors[account.id] = readable(error) }
                }
                lastUsageRefresh = Date()
            }
        } catch { report(error) }
    }
    func action(_ args: [String], success: String) async {
        guard !busy, !demo else { return }
        busy = true
        do {
            let reply = try await backend.reply(args)
            guard reply.ok else { throw GatewayFailure(code: reply.code) }
            message = success; isError = false
        } catch { report(error) }
        busy = false
        await refresh()
    }
    func add() async {
        guard !busy, !demo else { return }
        busy = true
        do {
            let reply = try await backend.reply(["account-add", "--label", label.trimmingCharacters(in: .whitespacesAndNewlines)])
            guard reply.ok, let account = reply.account else { throw GatewayFailure(code: reply.code) }
            label = ""; adding = false
            try openTerminal(backend.loginCommand(id: account.id))
            loginPending = true; message = "Finish signing in in Terminal, then click Check sign-in."; isError = false
        } catch { report(error) }
        busy = false; await refresh()
    }
    func login(_ account: Account) {
        guard !demo else { return }
        do {
            try openTerminal(backend.loginCommand(id: account.id))
            loginPending = true; message = "Finish signing in in Terminal, then click Check sign-in."; isError = false
        } catch { report(error) }
    }
    func checkLogin() async {
        await refresh(includeUsage: true)
        loginPending = accounts.contains { !$0.authenticated }
    }
    func createClient() async {
        guard !busy, !demo else { return }
        let panel = NSSavePanel()
        panel.title = "Create a Codex client profile"
        panel.message = "Choose a new folder name. Existing configuration is never overwritten."
        panel.nameFieldStringValue = "Codex Gateway Client"
        panel.canCreateDirectories = true
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        busy = true; defer { busy = false }
        do {
            let port = URLComponents(string: endpoint)?.port ?? 8787
            let reply = try await backend.reply(["setup", "--model", modelID.trimmingCharacters(in: .whitespacesAndNewlines), "--port", String(port), "--client-dir", url.path])
            guard reply.ok, let command = reply.launch_command else { throw GatewayFailure(code: reply.code) }
            let launch = "export PATH=" + shellQuote(backend.environment["PATH"] ?? "") + "\n" + command
            try openTerminal(launch)
            connecting = false; message = "Client profile created. Codex is opening in Terminal."; isError = false
        } catch { report(error) }
    }
    func copyEndpoint() {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(endpoint, forType: .string)
        message = "Gateway address copied."; isError = false
    }
    private func openTerminal(_ command: String) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("codex-gateway-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent("Codex Gateway.command")
        // The script contains paths and arguments only, never authentication data.
        let text = "#!/bin/zsh\n" + command + "\nresult=$?\n/bin/rm -f -- " + shellQuote(file.path) + "\n/bin/rmdir -- " + shellQuote(directory.path) + "\nexit $result\n"
        try text.write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
        let config = NSWorkspace.OpenConfiguration()
        guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else { throw GatewayFailure(code: "terminal_unavailable") }
        NSWorkspace.shared.open([file], withApplicationAt: terminal, configuration: config) { _, error in
            if error != nil { Task { @MainActor in self.message = "Could not open Terminal. Try signing in again."; self.isError = true } }
        }
    }
    private func report(_ error: Error) { message = readable(error); isError = true }
    private func readable(_ error: Error) -> String {
        switch (error as? GatewayFailure)?.code {
        case "login_required": return "Sign in to this account first."
        case "gateway_busy": return "A request is running. Wait for it to finish, then switch."
        case "cli_unavailable": return "Install the official Codex CLI, then try again."
        case "node_unavailable": return "Node.js 22.15 or newer is required."
        case "usage_timeout": return "Usage check timed out. Try refreshing later."
        case "usage_unavailable": return "Usage unavailable. Try signing in again."
        case "port_in_use": return "Port 8787 is occupied. Stop the other service before starting."
        case "client_directory_exists": return "Choose a new folder name; that folder already exists."
        case "unsafe_client_directory": return "Choose a new folder outside gateway and existing Codex state."
        case "invalid_arguments": return "Check the account label or model ID and try again."
        case "runtime_unavailable", "unsafe_runtime", "lifecycle_busy", "unavailable": return "Gateway needs attention. Run doctor --json in Terminal."
        case "backend_missing": return "Backend is missing. Rebuild the app using scripts/build-macos.sh."
        default: return "Could not complete this action. Check the gateway with doctor --json."
        }
    }
    private func loadDemo() {
        state = "running"
        accounts = [Account(id: "default", label: "Personal", selected: true, authenticated: true), Account(id: "second", label: "Work", selected: false, authenticated: true), Account(id: "third", label: "Extra", selected: false, authenticated: false)]
        usages = ["default": Usage(checked_at: ISO8601DateFormatter().string(from: Date()), buckets: [UsageBucket(id: "codex", primary: UsageWindow(remaining_percent: 36, window_minutes: 300, resets_at: Date().addingTimeInterval(7200).timeIntervalSince1970), secondary: UsageWindow(remaining_percent: 72, window_minutes: 10080, resets_at: Date().addingTimeInterval(172800).timeIntervalSince1970))]), "second": Usage(checked_at: ISO8601DateFormatter().string(from: Date()), buckets: [UsageBucket(id: "codex", primary: UsageWindow(remaining_percent: 100, window_minutes: 300, resets_at: Date().addingTimeInterval(12000).timeIntervalSince1970), secondary: UsageWindow(remaining_percent: 85, window_minutes: 10080, resets_at: Date().addingTimeInterval(300000).timeIntervalSince1970))])]
        message = "Design preview · sample accounts and usage"; isError = false
    }
}
