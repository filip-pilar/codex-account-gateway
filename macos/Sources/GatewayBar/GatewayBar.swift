import SwiftUI
import AppKit

@main struct GatewayBarApp: App {
    @StateObject private var model = GatewayModel()
    private let showWelcome = !UserDefaults.standard.bool(forKey: "didShowWelcome")
    var body: some Scene {
        MenuBarExtra {
            GatewayView(model: model)
        } label: {
            Image(nsImage: StackGlyph.menuImage)
                .accessibilityLabel("Codex Gateway")
        }
        .menuBarExtraStyle(.window)
        Window("Codex Gateway", id: "preview") {
            GatewayView(model: model)
        }
        .windowResizability(.contentSize)
        .defaultLaunchBehavior((showWelcome || ProcessInfo.processInfo.arguments.contains("--preview")) ? .presented : .suppressed)
    }
}

private enum GatewayPage: Hashable {
    case accounts, account(String), settings, add, rename(String), clientSetup, confirmStop
    var title: String {
        switch self {
        case .accounts: "Gateway"
        case .account: "Account"
        case .settings: "Settings"
        case .add: "Add Account"
        case .rename: "Rename Account"
        case .clientSetup: "Set Up Codex CLI"
        case .confirmStop: "Stop Gateway"
        }
    }
    var parent: GatewayPage {
        switch self {
        case .rename(let id): .account(id)
        case .clientSetup, .confirmStop: .settings
        default: .accounts
        }
    }
}

struct GatewayView: View {
    @ObservedObject var model: GatewayModel
    @State private var page: GatewayPage = .accounts
    @State private var draft = ""
    @State private var hoveredAccount: String?
    @State private var copied = false
    @FocusState private var fieldFocused: Bool
    private var status: GatewayStatus {
        GatewayStatus(state: model.state, routing: model.routing)
    }
    private var panelHeight: CGFloat {
        let height: CGFloat
        switch page {
        case .accounts: height = 166 + CGFloat(max(1, model.accounts.count)) * 58 + (status.notice == nil ? 0 : 70)
        case .settings: height = model.connectionNeedsUpdate ? 450 : 420
        case .account: height = 460
        case .rename: height = 190
        case .clientSetup: height = model.running ? 190 : 220
        case .add, .confirmStop: height = 220
        }
        let notices: CGFloat = (model.message == nil ? 0 : 70) + (model.loginPending ? 60 : 0)
        return min(height + notices, (NSScreen.main?.visibleFrame.height ?? 800) - 80)
    }
    private var validName: Bool {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !text.isEmpty && text.count <= 60 && text.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let message = model.message { notice(message) }
                    if model.loginPending {
                        HStack(alignment: .top, spacing: 12) {
                            Text("Complete sign-in in Terminal.")
                                .font(.callout).foregroundStyle(.secondary)
                            Spacer(minLength: 0)
                            Button("Check Sign-in") { Task { await model.checkLogin() } }
                                .disabled(model.busy || model.checkingUsage)
                        }.card()
                    }
                    content
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .defaultScrollAnchor(.top)
            .id(page)
            Divider()
            footer
        }
        .frame(width: 380, height: panelHeight)
        .background(.regularMaterial)
        .task {
            if !model.isDemo { UserDefaults.standard.set(true, forKey: "didShowWelcome") }
            await model.refresh()
        }
        .task(id: page) {
            fieldFocused = false
            if page == .add || page == .clientSetup || isRenaming {
                fieldFocused = true
            }
        }
    }

    private var isRenaming: Bool { if case .rename = page { true } else { false } }
    private var header: some View {
        HStack(spacing: 10) {
            if page == .accounts {
                Image(nsImage: StackGlyph.menuImage)
                    .resizable().scaledToFit().frame(width: 21, height: 21)
                    .foregroundStyle(.secondary).accessibilityHidden(true)
            } else {
                Button { page = page.parent } label: {
                    Image(systemName: "chevron.left").font(.body.weight(.semibold)).frame(width: 24, height: 26)
                }
                .buttonStyle(.borderless).help("Back")
                .accessibilityLabel("Back")
                .keyboardShortcut(.cancelAction)
            }
            Text(page.title).font(.headline)
            if model.isDemo && page != .accounts {
                Text("PREVIEW").font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, 5).padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
            }
            Spacer(minLength: 4)
            if page == .accounts {
                HStack(spacing: 5) {
                    Circle().fill(status.tone.color).frame(width: 6, height: 6).accessibilityHidden(true)
                    Text(status.title).font(.caption).foregroundStyle(.secondary)
                }.accessibilityElement(children: .combine)
            }
            if model.busy { ProgressView().controlSize(.small).accessibilityLabel("Updating gateway") }
            if page == .accounts || isAccountPage {
                Button { Task { await model.refresh(includeUsage: true) } } label: {
                    if model.checkingUsage {
                        ProgressView().controlSize(.mini).frame(width: 26, height: 26)
                    } else { Image(systemName: "arrow.clockwise").frame(width: 26, height: 26) }
                }
                .buttonStyle(.borderless).disabled(model.checkingUsage || model.busy)
                .help("Refresh usage").accessibilityLabel("Refresh usage")
            }
            if page == .accounts {
                Button { page = .settings } label: {
                    Image(systemName: "gearshape").frame(width: 26, height: 26)
                }.buttonStyle(.borderless).help("Settings").accessibilityLabel("Settings")
            }
        }
        .padding(.horizontal, 16).frame(height: 54)
    }
    private var isAccountPage: Bool { if case .account = page { true } else { false } }

    @ViewBuilder private var content: some View {
        switch page {
        case .accounts: overview
        case .settings: settings
        case .account(let id):
            if let account = model.accounts.first(where: { $0.id == id }) { accountDetails(account) }
        case .add:
            entryForm(field: "Account name", hint: "Sign-in opens in Terminal.")
        case .rename:
            entryForm(field: "Account name")
        case .clientSetup:
            entryForm(field: "Model ID")
            if !model.running { Text("Start the gateway first.").font(.callout).foregroundStyle(.secondary) }
        case .confirmStop:
            Text("Active requests will be cancelled. Automatic restarts stay paused until you start the gateway again.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let warning = status.notice {
                Label(warning, systemImage: "exclamationmark.circle.fill")
                    .font(.callout).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true).card()
            }
            VStack(spacing: 6) {
                HStack {
                    Text("ACCOUNTS")
                    Spacer()
                    Text("WEEKLY LEFT")
                }.font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                if model.accounts.isEmpty {
                    Text(model.state == "Checking" ? "Loading accounts…" : "No accounts")
                        .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 60)
                }
                VStack(spacing: 1) {
                    ForEach(model.accounts) { account in accountRow(account) }
                }
            }
        }
    }

    private func accountRow(_ account: Account) -> some View {
        let weekly = model.usages[account.id]?.weeklyWindow
        let state = AccountStatus(account: account, weekly: weekly, usageError: model.usageErrors[account.id] != nil)
        return Button { page = .account(account.id) } label: {
            HStack(spacing: 10) {
                Image(systemName: account.selected ? "checkmark.circle.fill" : "person.crop.circle")
                    .font(.system(size: 25, weight: .light))
                    .foregroundStyle(account.selected ? Color.accentColor : .secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(account.label).font(.body.weight(account.selected ? .semibold : .regular))
                        .lineLimit(1).truncationMode(.middle)
                    if let note = state.rowNote {
                        Text(note).font(.caption).foregroundStyle(state.tone.color)
                    }
                }
                Spacer(minLength: 4)
                if account.authenticated {
                    VStack(alignment: .trailing, spacing: 5) {
                        Text(weekly.map { "\(Int($0.remaining_percent.rounded()))%" } ?? "—")
                            .font(.body.weight(.medium)).monospacedDigit()
                            .foregroundStyle(weekly.map { $0.remaining_percent <= 5 } == true ? Color.orange : .primary)
                        if let weekly {
                            ProgressView(value: min(100, max(0, weekly.remaining_percent)), total: 100)
                                .tint(weekly.remaining_percent <= 5 ? .orange : .accentColor)
                                .frame(width: 48).controlSize(.mini).accessibilityHidden(true)
                        }
                    }
                }
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary).padding(.leading, 2).accessibilityHidden(true)
            }
            .padding(.horizontal, 10).frame(minHeight: 58)
            .contentShape(RoundedRectangle(cornerRadius: 9))
            .background(account.selected ? Color.accentColor.opacity(0.08) : hoveredAccount == account.id ? Color.primary.opacity(0.04) : .clear, in: RoundedRectangle(cornerRadius: 9))
        }
        .buttonStyle(.plain)
        .onHover { hovering in hoveredAccount = hovering ? account.id : nil }
        .help("View \(account.label)")
        .accessibilityLabel("\(account.label), \(state.title), weekly remaining \(weekly.map { "\(Int($0.remaining_percent.rounded())) percent" } ?? "unavailable")")
        .accessibilityHint("View account details")
    }

    private func accountDetails(_ account: Account) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: "person.crop.circle.fill").font(.system(size: 36, weight: .light))
                    .foregroundStyle(Color.accentColor).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(account.label).font(.headline).textSelection(.enabled)
                    if !account.authenticated {
                        Text("Not signed in").font(.callout).foregroundStyle(.secondary)
                    }
                }
            }.padding(.vertical, 4)
            if let error = model.usageErrors[account.id] {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.callout).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            if let usage = model.usages[account.id] {
                ForEach(usage.buckets) { bucket in
                    VStack(alignment: .leading, spacing: 14) {
                        if usage.buckets.count > 1 { Text(bucket.id).font(.headline) }
                        ForEach(Array(bucket.windows.enumerated()), id: \.offset) { index, window in
                            if index > 0 { Divider() }
                            usageWindow(window)
                        }
                    }.card()
                }
                Text(usage.checkedText + (model.usageErrors[account.id] == nil ? "" : " · Out of date")).font(.caption).foregroundStyle(.secondary)
            } else if account.authenticated {
                Text(model.checkingUsage ? "Checking usage…" : "Usage unavailable.")
                    .font(.callout).foregroundStyle(.secondary).card()
            }
            HStack {
                Button("Rename…") { draft = account.label; page = .rename(account.id) }
                Spacer()
                if account.authenticated { Button("Sign In Again…") { model.login(account) } }
            }.disabled(model.busy)
        }
    }
    private func usageWindow(_ window: UsageWindow) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.title).font(.body.weight(.medium))
                Spacer()
                Text("\(Int(window.remaining_percent.rounded()))%").font(.title3.weight(.semibold)).monospacedDigit()
                Text("left").font(.caption).foregroundStyle(.secondary)
            }
            ProgressView(value: min(100, max(0, window.remaining_percent)), total: 100)
                .tint(window.remaining_percent <= 5 ? .orange : .accentColor)
                .accessibilityLabel("\(window.title) remaining")
                .accessibilityValue("\(Int(window.remaining_percent.rounded())) percent")
            if let reset = window.resetText { Text(reset).font(.caption).foregroundStyle(.secondary) }
        }
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 14) {
                Toggle(isOn: Binding(get: { model.runAutomatically }, set: { enabled in
                    Task { await model.setAutomaticRun(enabled) }
                })) {
                    Text("Keep gateway running").frame(maxWidth: .infinity, alignment: .leading)
                }.toggleStyle(.switch).controlSize(.small).disabled(model.busy)
                    .accessibilityLabel("Keep gateway running")
                    .accessibilityHint("Launch at login and restart if interrupted")
                    .help("Launch at login and restart if interrupted")
                if model.startupNeedsApproval {
                    Button("Allow in Login Items…") { model.openLoginSettings() }
                }
                Divider()
                Toggle(isOn: Binding(get: { model.globalEnabled }, set: { enabled in
                    Task { await model.setGlobalProvider(enabled) }
                })) {
                    Text("Use gateway in Codex").frame(maxWidth: .infinity, alignment: .leading)
                }.toggleStyle(.switch).controlSize(.small)
                    .disabled(model.busy || (!model.globalEnabled && !model.running))
                    .accessibilityLabel("Use gateway in Codex")
                    .accessibilityHint("Route new and existing OpenAI tasks through Gateway")
                    .help("New and existing OpenAI tasks. Restart Codex to apply changes.")
                if model.connectionNeedsUpdate {
                    Button("Update Connection") { Task { await model.setGlobalProvider(true) } }
                        .disabled(model.busy || !model.running)
                        .help("Apply the connection setting to new and existing OpenAI tasks")
                }
            }.card()
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Connection").font(.body.weight(.semibold))
                    Spacer()
                    Label(model.running ? "Running" : "Stopped", systemImage: model.running ? "checkmark.circle.fill" : "stop.circle")
                        .font(.caption).foregroundStyle(model.running ? Color.green : .secondary)
                }
                HStack {
                    Text(model.endpoint).font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary).textSelection(.enabled)
                    Spacer(minLength: 0)
                    Button {
                        model.copyEndpoint(); copied = true
                    } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc") }
                        .buttonStyle(.borderless).help(copied ? "Copied" : "Copy address")
                        .accessibilityLabel(copied ? "Address copied" : "Copy gateway address")
                }
                Divider()
                Button { draft = ""; page = .clientSetup } label: {
                    HStack {
                        Label("Set Up Codex CLI…", systemImage: "terminal")
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                    }.contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(model.busy)
            }.card()
            if model.running {
                Button("Stop Gateway…", role: .destructive) { page = .confirmStop }
                    .disabled(model.busy)
            } else {
                Button("Start Gateway") { Task { await model.action(["start", "--background"]) } }
                    .disabled(model.busy || !model.selectedReady)
            }
        }
    }
    private func entryForm(field: String, hint: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(field).font(.callout.weight(.medium))
            TextField("", text: $draft).textFieldStyle(.roundedBorder)
                .accessibilityLabel(field).focused($fieldFocused).onSubmit { submit() }
            if let hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
        }
    }
    private func notice(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: model.isError ? "exclamationmark.circle.fill" : "checkmark.circle")
                .foregroundStyle(model.isError ? Color.orange : .secondary)
            Text(message).font(.callout).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button { model.message = nil } label: { Image(systemName: "xmark").font(.caption2).frame(width: 18, height: 18) }
                .buttonStyle(.borderless).accessibilityLabel("Dismiss message")
        }.card()
    }

    private var footer: some View {
        HStack {
            switch page {
            case .accounts:
                Button { draft = ""; page = .add } label: { Label("Add Account…", systemImage: "plus") }
                    .disabled(model.busy)
                Spacer()
                if model.isDemo { Text("PREVIEW").font(.caption2).foregroundStyle(.tertiary) }
                if !model.running && model.selectedReady {
                    Button("Start") { Task { await model.action(["start", "--background"]) } }
                        .buttonStyle(.borderedProminent).disabled(model.busy)
                }
            case .settings:
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .help("Quits the menu app. The gateway stays running; automatic monitoring stops.")
            case .account(let id):
                if let account = model.accounts.first(where: { $0.id == id }) {
                    let state = AccountStatus(account: account, weekly: model.usages[id]?.weeklyWindow, usageError: model.usageErrors[id] != nil)
                    if account.selected && account.authenticated {
                        Label("Selected account", systemImage: "checkmark.circle.fill").foregroundStyle(.secondary)
                        Spacer()
                    } else {
                        if account.authenticated && !state.canSelect {
                            Text(state.title).font(.caption).foregroundStyle(state.tone.color)
                        }
                        Spacer()
                        if account.authenticated {
                            Button("Use This Account") { Task { await model.action(["account-select", "--account", id]) } }
                                .buttonStyle(.borderedProminent).disabled(model.busy || !state.canSelect)
                                .help(state.canSelect ? "Use this account for future requests" : "This account has reached the weekly reserve")
                        } else {
                            Button("Sign In…") { model.login(account) }
                                .buttonStyle(.borderedProminent).disabled(model.busy)
                        }
                    }
                }
            case .add, .rename, .clientSetup:
                Button("Cancel") { page = page.parent }
                Spacer()
                Button(page == .add ? "Add & Sign In…" : page == .clientSetup ? "Choose Folder…" : "Save") { submit() }
                    .buttonStyle(.borderedProminent).disabled(!canSubmit)
                    .keyboardShortcut(.defaultAction)
            case .confirmStop:
                Button("Keep Running") { page = .settings }.keyboardShortcut(.defaultAction)
                Spacer()
                Button("Stop Gateway", role: .destructive) {
                    Task { await model.action(["stop"]); page = .settings }
                }.buttonStyle(.borderedProminent).tint(.red).disabled(model.busy)
            }
        }.controlSize(.regular).padding(.horizontal, 16).frame(height: 52)
    }
    private var canSubmit: Bool {
        !model.busy && (page == .clientSetup ? !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.running : validName)
    }
    private func submit() {
        guard canSubmit else { return }
        Task {
            switch page {
            case .add: if await model.add(label: draft) { page = .accounts }
            case .rename(let id):
                if let account = model.accounts.first(where: { $0.id == id }), await model.rename(account, to: draft) { page = .account(id) }
            case .clientSetup: if await model.createClient(modelID: draft) { page = .settings }
            default: break
            }
        }
    }
}

private extension StatusTone {
    var color: Color {
        switch self { case .positive: .green; case .caution: .orange; case .neutral: .secondary }
    }
}
private extension View {
    func card() -> some View {
        padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor).opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.04)))
    }
}
