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
                .preferredColorScheme(ProcessInfo.processInfo.arguments.contains("--preview-dark") ? .dark : nil)
        }
        .windowResizability(.contentSize)
        .defaultLaunchBehavior((showWelcome || ProcessInfo.processInfo.arguments.contains("--preview")) ? .presented : .suppressed)
    }
}

private enum GatewayPage: Hashable {
    case accounts, account(String), routing, settings, add, clientSetup
    var title: String {
        switch self {
        case .accounts: "Gateway"
        case .account: "Account"
        case .routing: "Routing"
        case .settings: "Settings"
        case .add: "Add Account"
        case .clientSetup: "Set Up Codex CLI"
        }
    }
    var parent: GatewayPage { self == .clientSetup ? .settings : .accounts }
    var scope: FeedbackScope {
        switch self {
        case .accounts: .overview
        case .account(let id): .account(id)
        case .routing: .routing
        case .settings: .settings
        case .add: .add
        case .clientSetup: .clientSetup
        }
    }
}

private enum PendingNavigation { case page(GatewayPage), mode(String) }

struct GatewayView: View {
    @ObservedObject var model: GatewayModel
    @State private var page: GatewayPage = .accounts
    @State private var navigationID = UUID()
    @State private var draft = ""
    @State private var copied = false
    @State private var contentHeight: CGFloat = 0
    @State private var noticeHeight: CGFloat = 0
    @State private var panelHeight: CGFloat = 600
    @State private var editingOrder: [String]?
    @State private var originalOrder: [String] = []
    @State private var prioritySaving = false
    @State private var pendingNavigation: PendingNavigation?
    @State private var showDiscard = false
    @State private var confirmStop = false
    @State private var renaming: Account?
    @State private var submittingPage: GatewayPage?
    @State private var fallbackInfo = false
    @State private var weeklyInfo = false
    @State private var detailsExpanded = false
    @State private var connectionExpanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var fieldFocused: Bool
    private var status: GatewayStatus { GatewayStatus(state: model.state, routing: model.routing) }
    private var hasFooter: Bool { [.accounts, .settings, .add, .clientSetup].contains(page) || page == .routing && editingOrder != nil }
    private var scrollHeight: CGFloat { min(max(1, contentHeight), max(1, panelHeight - 55 - noticeHeight - (hasFooter ? 53 : 0))) }
    private var priorityDirty: Bool { editingOrder.map { $0 != originalOrder } ?? false }
    private var formSaving: Bool { submittingPage == page }
    private var visibleMessage: String? {
        let scope = model.messageScope
        let matches = scope == page.scope || page == .routing && scope == .priority
            || page == .accounts && model.currentAccount.map { scope == .account($0.id) } == true
        return matches ? model.message : nil
    }
    private var visibleErrors: [String] {
        model.componentErrors.keys.sorted().filter { component in
            switch component {
            case "Gateway", "Accounts": return true
            case "Usage": if case .account = page { return true }; return page == .accounts
            case "Routing": if case .account = page { return true }; return page == .accounts || page == .routing
            case "Codex connection", "Activation setting": return page == .settings
            default: return page == .accounts || page == .settings
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if !visibleErrors.isEmpty || visibleMessage != nil {
                notices
                    .onGeometryChange(for: CGFloat.self) { ceil($0.size.height) } action: { noticeHeight = $0 }
                    .onDisappear { noticeHeight = 0 }
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let login = model.pendingLogin,
                       page == .account(login.accountID) || page == .accounts && !model.loginNoticeHidden {
                        loginNotice(login)
                    }
                    content
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { ceil($0.size.height) } action: { height in
                    guard height != contentHeight else { return }
                    withAnimation(contentHeight == 0 || reduceMotion ? nil : .easeInOut(duration: 0.15)) { contentHeight = height }
                }
            }
            .frame(height: scrollHeight, alignment: .top)
            .scrollBounceBehavior(.basedOnSize)
            .defaultScrollAnchor(.top)
            .id(page)
            if hasFooter { Divider(); footer }
        }
        .frame(width: 380)
        .background(.regularMaterial)
        .background(WindowSpaceReader(availableHeight: $panelHeight).frame(width: 0, height: 0))
        .disclosureGroupStyle(FullRowDisclosureStyle())
        .task {
            if !model.isDemo { UserDefaults.standard.set(true, forKey: "didShowWelcome") }
            await model.refresh(showFeedback: false)
        }
        .task(id: page) { fieldFocused = page == .add || page == .clientSetup }
        .task(id: copied) {
            guard copied else { return }
            do { try await Task.sleep(for: .seconds(2)); copied = false } catch { }
        }
        .onChange(of: model.endpoint) { copied = false }
        .sheet(item: $renaming) { account in RenameAccountView(model: model, account: account) }
        .alert("Discard priority changes?", isPresented: $showDiscard) {
            Button("Keep Editing", role: .cancel) { pendingNavigation = nil }.keyboardShortcut(.defaultAction)
            Button("Discard Changes", role: .destructive) {
                editingOrder = nil
                if let pendingNavigation { performNavigation(pendingNavigation) }
                pendingNavigation = nil
            }
        } message: { Text("The account order has not been saved.") }
        .alert("Stop Gateway?", isPresented: $confirmStop) {
            Button("Keep Running", role: .cancel) { }.keyboardShortcut(.defaultAction)
            Button("Stop Gateway", role: .destructive) { Task { await model.action(["stop"], scope: .settings) } }
        } message: { Text("Active requests will be cancelled. Automatic restarts stay paused until you start the gateway again.") }
    }

    private var notices: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(visibleErrors, id: \.self) { component in
                Label(component + ": " + (model.componentErrors[component] ?? ""), systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            if let message = visibleMessage { feedback(message) }
        }.padding(.horizontal, 20).padding(.vertical, 12)
    }
    private var header: some View {
        HStack(spacing: 10) {
            if page != .accounts {
                Button { navigate(.page(page.parent)) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "chevron.left").font(.body.weight(.medium)).frame(width: 20, height: 26)
                        Text(page.title).font(.headline)
                    }.frame(height: 36).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(prioritySaving)
                .help("Back to \(page.parent.title)").accessibilityLabel("Back to \(page.parent.title)")
                .keyboardShortcut(.cancelAction)
            } else { Text(page.title).font(.headline) }
            Spacer(minLength: 4)
            if model.busy { ProgressView().controlSize(.mini).accessibilityLabel("Working") }
            if page == .accounts {
                HStack(spacing: 5) {
                    Circle().fill(status.tone.color).frame(width: 6, height: 6).accessibilityHidden(true)
                    Text(status.title).font(.caption).foregroundStyle(.secondary)
                }.accessibilityElement(children: .combine)
                Button { refreshUsage() } label: {
                    if model.checkingUsage { ProgressView().controlSize(.mini).frame(width: 24, height: 26) }
                    else { Image(systemName: "arrow.clockwise").frame(width: 24, height: 26) }
                }.buttonStyle(.borderless).disabled(model.checkingUsage || model.busy)
                    .help("Refresh usage").accessibilityLabel("Refresh usage")
                Button { go(.settings) } label: { Image(systemName: "gearshape").frame(width: 24, height: 26) }
                    .buttonStyle(.borderless).help("Settings").accessibilityLabel("Settings")
            }
            if case .account(let id) = page, let account = model.accounts.first(where: { $0.id == id }) {
                Menu {
                    Button("Rename…") { model.clearFeedback(.rename(id)); renaming = account }
                    Button(model.pendingLogin?.accountID == id ? "Return to Sign-in…" : account.authenticated ? "Sign In Again…" : "Sign In…") {
                        model.login(account)
                    }.disabled(model.loginPending && model.pendingLogin?.accountID != id)
                    Divider()
                    Button("Refresh Usage") { refreshUsage() }.disabled(model.checkingUsage)
                } label: { Image(systemName: "ellipsis.circle").font(.title3).frame(width: 28, height: 32) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .disabled(model.busy).accessibilityLabel("Account actions")
            }
        }.padding(.horizontal, 20).frame(height: 54)
    }
    @ViewBuilder private var content: some View {
        switch page {
        case .accounts: overview
        case .routing: routingSettings
        case .settings: settings
        case .account(let id):
            if let account = model.accounts.first(where: { $0.id == id }) { accountDetails(account) }
            else { Text("This account is no longer available.").foregroundStyle(.secondary) }
        case .add:
            entryForm(field: "Account name", hint: "Sign-in opens in Terminal.")
            if let login = model.pendingLogin { Text("Finish signing in to \(login.label) before adding another account.").font(.caption).foregroundStyle(.secondary) }
        case .clientSetup:
            entryForm(field: "Model ID", hint: "Enter a model ID available to your account. This creates a separate Codex CLI profile and opens it in Terminal.")
            if !model.running { Text("Start the gateway first.").foregroundStyle(.secondary) }
        }
    }
    private func go(_ destination: GatewayPage) {
        navigationID = UUID(); page = destination; detailsExpanded = false; connectionExpanded = false
    }
    private func navigate(_ action: PendingNavigation) {
        guard !prioritySaving else { return }
        if page == .routing && priorityDirty { pendingNavigation = action; showDiscard = true }
        else { editingOrder = nil; performNavigation(action) }
    }
    private func performNavigation(_ action: PendingNavigation) {
        switch action {
        case .page(let destination): go(destination)
        case .mode(let mode):
            Task { await model.setRouting(mode: mode, account: mode == "fixed" ? model.currentAccount?.id ?? model.accounts.first?.id : nil) }
        }
    }
    private func refreshUsage() {
        let scope = page.scope
        Task { await model.refresh(includeUsage: true, scope: scope) }
    }
    private func needsSignIn(_ account: Account) -> Bool {
        !account.authenticated || model.usageSnapshots[account.id]?.diagnostics.last_error == "login_required"
    }
    private func signInButton(_ account: Account) -> some View {
        Button(model.pendingLogin?.accountID == account.id ? "Return to Sign-in…" : "Sign In…") { model.login(account) }
            .disabled(model.busy || model.isDemo || model.loginPending && model.pendingLogin?.accountID != account.id)
    }
    private func loginNotice(_ login: LoginAttempt) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Signing in to \(login.label)").font(.callout.weight(.medium))
            HStack {
                Button("Open Terminal") { model.returnToSignIn() }
                Button(model.checkingLogin ? "Checking…" : "Check Sign-in") { Task { await model.checkLogin() } }
                    .disabled(model.busy || model.checkingLogin)
                if page == .accounts { Button("Hide Notice") { model.loginNoticeHidden = true } }
            }.buttonStyle(.borderless).font(.caption)
        }
    }
    private func navigation(_ title: String, value: String? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                Spacer(minLength: 8)
                if let value { Text(value).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle) }
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary).accessibilityHidden(true)
            }.frame(minHeight: 24).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
    private func name(_ account: Account) -> some View {
        Text(account.label).lineLimit(1).truncationMode(.middle).help(account.label).accessibilityLabel(account.label)
    }
    private func metric(_ label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label)
            Spacer(minLength: 8)
            Text(value).monospacedDigit().multilineTextAlignment(.trailing)
        }.accessibilityElement(children: .combine)
    }
    @ViewBuilder private func usageSummary(_ account: Account) -> some View {
        if let usage = model.usages[account.id], let bucket = usage.coreBucket, !bucket.windows.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                if usage.stale == true {
                    Text("Last known usage").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(Array(bucket.windows.enumerated()), id: \.offset) { _, window in
                    VStack(alignment: .leading, spacing: 7) {
                        metric(window.title, value: window.remainingText + " left").font(.callout)
                        if window.remaining_percent.isFinite {
                            UsageMeter(remaining: window.remaining_percent, stale: usage.stale == true)
                        }
                    }
                }
            }.padding(.top, 8)
        } else {
            Text(account.authenticated ? "Usage unavailable" : "Sign in required")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let account = model.currentAccount {
                Button { go(.account(account.id)) } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(status.title == "Paused" || !model.running ? "Selected account" : "Current account").font(.caption).foregroundStyle(.secondary)
                        name(account).font(.system(size: 17, weight: .semibold))
                        usageSummary(account)
                    }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityHint("View account details")
                if status.title == "Paused" { pausedAccount(account) }
                else if needsSignIn(account) {
                    signInButton(account).buttonStyle(.borderedProminent)
                }
                else if account.allowsCreditFallback && (model.routingPolicy.mode == "fixed" || model.routingPolicy.allowsCredits) {
                    Label(model.running && model.routing?.state == "credit_fallback" ? "Credit fallback active" : "Credits allowed", systemImage: "creditcard").font(.callout).foregroundStyle(.secondary)
                }
            } else {
                Text(model.state == "Checking" ? "Loading accounts…" : "Add an account to get started.").foregroundStyle(.secondary)
            }
            Divider()
            navigation("Routing", value: model.routingKnown ? model.routingPolicy.title : "Unavailable") { navigate(.page(.routing)) }
            let others = model.orderedAccounts.filter { $0.id != model.currentAccount?.id }
            if !others.isEmpty {
                Divider()
                VStack(spacing: 0) {
                    HStack {
                        Text("Other accounts"); Spacer(); Text("Weekly left")
                    }.font(.caption).foregroundStyle(.secondary).padding(.bottom, 10)
                    ForEach(Array(others.enumerated()), id: \.element.id) { index, account in
                        if index > 0 { Divider() }
                        accountRow(account)
                    }
                }
            }
        }
    }
    private func pausedAccount(_ account: Account) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            let usage = model.usages[account.id]
            let exhausted = usage?.coreBucket?.windows.first { $0.remaining_percent <= 0 }
            if needsSignIn(account) {
                Text("Sign in to this account to continue.")
                signInButton(account).buttonStyle(.borderedProminent)
            } else if usage == nil || usage?.stale == true {
                Text("Refresh usage to check availability.").foregroundStyle(.secondary)
                Button("Refresh Usage") { refreshUsage() }.disabled(model.busy || model.checkingUsage)
            } else if model.routingPolicy.mode == "fixed", let exhausted {
                Text("\(exhausted.title) allowance exhausted.")
                if !account.allowsCreditFallback {
                    Text("Credits are not allowed for this account.").font(.callout).foregroundStyle(.secondary)
                    Button("Review Credit Permission") { go(.account(account.id)) }
                } else {
                    Text("This account cannot continue with its reported usage.").font(.callout).foregroundStyle(.secondary)
                }
                if let reset = exhausted.resetText { Text(reset).font(.caption).foregroundStyle(.secondary) }
            } else { Text(status.notice ?? "Routing is paused.").fixedSize(horizontal: false, vertical: true) }
            if !needsSignIn(account) {
                Button("Change Routing…") { navigate(.page(.routing)) }.buttonStyle(.borderless)
            }
        }
    }
    private func accountRow(_ account: Account) -> some View {
        Button { go(.account(account.id)) } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    name(account)
                    if model.pendingLogin?.accountID == account.id { Text("Signing in…").font(.caption).foregroundStyle(.secondary) }
                    else if model.loginFailures[account.id] != nil { Text("Sign-in did not complete").font(.caption).foregroundStyle(.secondary) }
                    else if needsSignIn(account) { Text("Sign in required").font(.caption).foregroundStyle(.secondary) }
                    else if model.usages[account.id]?.stale == true { Text("Usage out of date").font(.caption).foregroundStyle(.secondary) }
                    else if let short = model.usages[account.id]?.coreBucket?.windows.first(where: { $0.window_minutes != 10080 && $0.remaining_percent <= 0 }) {
                        Text("\(short.title) allowance exhausted").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                HStack(spacing: 10) {
                    if let weekly = model.usages[account.id]?.weeklyWindow, weekly.remaining_percent.isFinite {
                        UsageMeter(remaining: weekly.remaining_percent, stale: model.usages[account.id]?.stale == true)
                            .frame(width: 88)
                    }
                    Text(model.usages[account.id]?.weeklyWindow?.remainingText ?? "—")
                        .monospacedDigit().fixedSize().frame(width: 34, alignment: .trailing)
                        .foregroundStyle(account.authenticated ? Color.primary : .secondary)
                }
            }.padding(.vertical, 12).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityHint("View account details")
    }

    private var routingSettings: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Text("Mode"); Spacer()
                Picker("Mode", selection: Binding(get: { model.routingPolicy.mode }, set: { navigate(.mode($0)) })) {
                    Text("Automatic").tag("automatic")
                    Text("Stay on one account").tag("fixed").disabled(model.accounts.isEmpty)
                }.labelsHidden().frame(width: 214)
            }.disabled(model.busy || !model.routingKnown || prioritySaving)
            if model.routingPolicy.mode == "fixed" {
                HStack {
                    Text("Account"); Spacer()
                    Picker("Account", selection: Binding(get: { model.routingPolicy.fixed_account ?? "" }, set: { id in
                        Task { await model.setRouting(account: id) }
                    })) {
                        ForEach(model.orderedAccounts) { account in Text(account.label).tag(account.id) }
                    }.labelsHidden().frame(width: 214)
                }.disabled(model.busy || !model.routingKnown)
                Text("Pauses if this account cannot continue.").font(.caption).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 8) {
                    Text("Fallback")
                    Button { fallbackInfo.toggle() } label: { Image(systemName: "info.circle").foregroundStyle(.secondary).frame(width: 24, height: 24) }
                        .buttonStyle(.borderless).accessibilityLabel("About fallback")
                        .popover(isPresented: $fallbackInfo) {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Included usage comes first").font(.headline)
                                Text("Automatic prefers accounts above the 5% weekly reserve. Fallback controls what happens when none remain.")
                                Text("Reserve uses the last 5%. Credit fallback requires permission for each account and may also use that account’s remaining included allowance.")
                                Text("OpenAI determines when credits are charged. Usage reports can be delayed; this is not a spending cap.").foregroundStyle(.secondary)
                            }.font(.callout).padding(20).frame(width: 320)
                        }
                    Spacer(minLength: 0)
                    Picker("Fallback", selection: Binding(get: { model.routingPolicy.fallback }, set: { value in
                        Task { await model.setRouting(fallback: value) }
                    })) {
                        ForEach(RoutingPolicy.fallbacks, id: \.0) { value, label in Text(label).tag(value) }
                    }.labelsHidden().frame(width: 214).disabled(model.busy || !model.routingKnown)
                }

                if model.routingPolicy.allowsCredits && !model.accounts.contains(where: \.allowsCreditFallback) {
                    Text("No accounts allow credits. Set permission in an account’s details.").font(.caption).foregroundStyle(.secondary)
                }
                Divider()
                priority
            }
        }
    }
    private var priorityAccounts: [Account] {
        (editingOrder ?? model.orderedAccounts.map(\.id)).compactMap { id in model.accounts.first { $0.id == id } }
    }
    private var priority: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Account priority").foregroundStyle(.secondary)
                Spacer()
                if editingOrder != nil {
                    Text("Drag to reorder").foregroundStyle(.secondary)
                } else {
                    Button("Edit") {
                        originalOrder = model.orderedAccounts.map(\.id); editingOrder = originalOrder
                        model.clearFeedback(.priority)
                    }.disabled(model.busy || !model.routingKnown || model.accounts.count < 2)
                }
            }.font(.caption).buttonStyle(.borderless).padding(.bottom, 10)
            if priorityAccounts.isEmpty { Text("Add an account first.").foregroundStyle(.secondary).padding(.vertical, 10) }
            ForEach(Array(priorityAccounts.enumerated()), id: \.element.id) { index, account in
                Divider()
                if editingOrder != nil {
                    priorityRow(account, index: index)
                        .draggable(account.id)
                        .dropDestination(for: String.self) { ids, _ in
                            guard !prioritySaving, !model.busy, let id = ids.first, var order = editingOrder,
                                  let from = order.firstIndex(of: id), let to = order.firstIndex(of: account.id) else { return false }
                            order.remove(at: from); order.insert(id, at: to); editingOrder = order; return true
                        }
                } else { priorityRow(account, index: index) }
            }
            Divider()
            Text("Used when switching accounts.").font(.caption).foregroundStyle(.secondary).padding(.top, 8)
        }
    }
    private func priorityRow(_ account: Account, index: Int) -> some View {
        HStack(spacing: 12) {
            Text(String(index + 1)).foregroundStyle(.secondary).monospacedDigit().frame(width: 18, alignment: .leading)
            name(account)
            Spacer(minLength: 0)
            if editingOrder != nil {
                Image(systemName: "line.3.horizontal").foregroundStyle(.tertiary).accessibilityHidden(true)
                Button { movePriority(index, by: -1) } label: { Image(systemName: "chevron.up").frame(width: 24, height: 24) }
                    .disabled(index == 0 || model.busy).accessibilityLabel("Move \(account.label) up")
                Button { movePriority(index, by: 1) } label: { Image(systemName: "chevron.down").frame(width: 24, height: 24) }
                    .disabled(index == priorityAccounts.count - 1 || model.busy).accessibilityLabel("Move \(account.label) down")
            }
        }.buttonStyle(.borderless).padding(.vertical, 10).contentShape(Rectangle())
    }
    private func movePriority(_ index: Int, by offset: Int) {
        guard !prioritySaving, !model.busy, var order = editingOrder, order.indices.contains(index + offset) else { return }
        order.swapAt(index, index + offset); editingOrder = order
    }
    private func creditToggle(_ account: Account) -> some View {
        Toggle(isOn: Binding(get: { account.allowsCreditFallback }, set: { enabled in
            Task { await model.setCreditFallback(account, enabled: enabled) }
        })) {
            HStack {
                Text("Allow credits")
                if model.savingCredits.contains(account.id) { ProgressView().controlSize(.mini).accessibilityLabel("Saving credit permission") }
                Spacer(minLength: 0)
            }
        }.toggleStyle(.switch).controlSize(.small)
            .disabled(model.busy || model.savingCredits.contains(account.id) || !model.routingKnown)
            .accessibilityLabel("Allow credits for \(account.label)")
    }
    private var weeklyActivation: some View {
        HStack(spacing: 8) {
            Text("Start unused weekly windows").font(.callout)
            Button { weeklyInfo.toggle() } label: { Image(systemName: "info.circle").foregroundStyle(.secondary).frame(width: 24, height: 24) }
                .buttonStyle(.borderless).accessibilityLabel("About weekly activation")
                .popover(isPresented: $weeklyInfo) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Start weekly timers").font(.headline)
                        Text("When repeated usage reports suggest a weekly timer has not started, send one small request to start it.")
                        Text("Uses quota and may use credits on eligible accounts, including other accounts when routing stays on one account. Failed attempts are not retried automatically.").foregroundStyle(.secondary)
                    }.font(.callout).padding(20).frame(width: 320)
                }
            Spacer(minLength: 0)
            Toggle("Start unused weekly windows", isOn: Binding(get: { model.autoActivateWeeklyWindows }, set: { value in
                Task { await model.setWeeklyActivation(value) }
            })).labelsHidden().toggleStyle(.switch).controlSize(.small)
                .disabled(model.busy || model.isDemo || model.componentErrors["Activation setting"] != nil)
        }
    }

    private func accountDetails(_ account: Account) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            name(account).font(.system(size: 17, weight: .semibold)).textSelection(.enabled)
            if needsSignIn(account) {
                Text("Sign in to check usage.").foregroundStyle(.secondary)
                signInButton(account)
                if let pending = model.pendingLogin, pending.accountID != account.id {
                    Text("Finish signing in to \(pending.label) first.").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let failure = model.loginFailures[account.id], model.messageScope != .account(account.id) || model.message == nil {
                Text(failure).font(.caption).foregroundStyle(.orange)
            }
            if let usage = model.usages[account.id], usage.buckets.contains(where: { !$0.windows.isEmpty || $0.credits != nil }) {
                if usage.buckets.allSatisfy({ $0.windows.isEmpty }) {
                    Text("Allowance unavailable").font(.callout).foregroundStyle(.secondary)
                    Button("Refresh Usage") { refreshUsage() }.disabled(model.busy || model.checkingUsage)
                }
                ForEach(usage.buckets) { bucket in
                    VStack(alignment: .leading, spacing: 16) {
                        if usage.buckets.count > 1 { Text(bucket.id).font(.caption).foregroundStyle(.secondary) }
                        ForEach(Array(bucket.windows.enumerated()), id: \.offset) { _, window in
                            VStack(alignment: .leading, spacing: 6) {
                                metric(window.title, value: window.remainingText + " left")
                                if let reset = window.resetText { Text(reset).font(.caption).foregroundStyle(.secondary) }
                            }
                            Divider()
                        }
                        metric("Credits", value: bucket.credits?.compactBalanceText ?? "Balance unavailable")
                            .help(bucket.credits?.fullBalanceText ?? "Balance unavailable")
                    }
                }
                Text(usage.updatedText + (usage.stale == true ? " · Out of date" : "")).font(.caption).foregroundStyle(.secondary)
                if usage.stale == true && !needsSignIn(account) { Button("Refresh Usage") { refreshUsage() }.disabled(model.busy || model.checkingUsage) }
            } else if !needsSignIn(account) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.checkingUsage ? "Checking usage…" : "Usage unavailable").foregroundStyle(.secondary)
                    Button("Refresh Usage") { refreshUsage() }.disabled(model.busy || model.checkingUsage)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                creditToggle(account)
                Text("Permits credit fallback in either routing mode. OpenAI determines when credits are charged.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            if model.routingPolicy.mode == "fixed" && model.routingPolicy.fixed_account == account.id {
                Label("Using only this account", systemImage: "checkmark.circle").foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Button("Use This Account") { Task { await model.setRouting(mode: "fixed", account: account.id, scope: .account(account.id)) } }
                        .disabled(model.busy || !model.routingKnown || needsSignIn(account))
                    Text("Stay on this account; pause if it cannot continue.").font(.caption).foregroundStyle(.secondary)
                }
            }
            Divider()
            DisclosureGroup("Details", isExpanded: $detailsExpanded) { accountDiagnostics(account) }
        }
    }
    private func accountDiagnostics(_ account: Account) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(account.label).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            if let error = model.usageErrors[account.id] { Text(error).foregroundStyle(.orange) }
            if let usage = model.usages[account.id] {
                Text(usage.windowStateText).foregroundStyle(.secondary)
                ForEach(usage.buckets) { bucket in
                    if let credits = bucket.credits {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(usage.buckets.count > 1 ? "\(bucket.id) reported credit balance" : "Reported credit balance").foregroundStyle(.secondary)
                            Text(credits.fullBalanceText).monospacedDigit().textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                            Button("Copy Balance") {
                                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(credits.fullBalanceText, forType: .string)
                            }.buttonStyle(.borderless)
                        }
                    }
                }
            }
            if let snapshot = model.usageSnapshots[account.id] {
                if let attempted = snapshot.diagnostics.last_attempt_at, let date = Usage.date(attempted) {
                    Text("Latest check \(date.formatted(.dateTime.month(.abbreviated).day().hour().minute()))").foregroundStyle(.secondary)
                }
                if let activation = snapshot.activation {
                    Text("Last activation: " + activation.text)
                    if let attempted = activation.last_attempt_at, let date = Usage.date(attempted) {
                        Text(date.formatted(.dateTime.month(.abbreviated).day().hour().minute())).foregroundStyle(.secondary)
                    }
                    if let reason = activation.failureReason { Text(reason).foregroundStyle(.orange) }
                }
            }
        }.font(.caption).frame(maxWidth: .infinity, alignment: .leading)
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 20) {
            Toggle(isOn: Binding(get: { model.runAutomatically }, set: { value in Task { await model.setAutomaticRun(value) } })) {
                Text("Keep gateway running").frame(maxWidth: .infinity, alignment: .leading)
            }
                .toggleStyle(.switch).controlSize(.small).disabled(model.busy || model.isDemo)
            Text("Launch at login and restart the gateway if interrupted.").font(.caption).foregroundStyle(.secondary).padding(.top, -12)
            if model.startupNeedsApproval { Button("Allow in Login Items…") { model.openLoginSettings() } }
            weeklyActivation
            Text("Uses quota, including on other accounts.").font(.caption).foregroundStyle(.secondary).padding(.top, -12)
            Divider()
            if model.connectionKnown {
                Toggle(isOn: Binding(get: { model.globalEnabled }, set: { value in Task { await model.setGlobalProvider(value) } })) {
                    Text("Use gateway in Codex").frame(maxWidth: .infinity, alignment: .leading)
                }
                    .toggleStyle(.switch).controlSize(.small).disabled(model.busy || model.isDemo || (!model.globalEnabled && !model.running))
                    .help("Restart Codex to apply connection changes")
                if model.connectionNeedsUpdate {
                    Button("Update Connection") { Task { await model.setGlobalProvider(true) } }.disabled(model.busy || !model.running || model.isDemo)
                }
            } else {
                LabeledContent("Use gateway in Codex", value: model.connectionTitle)
                if model.componentErrors["Codex connection"] != nil { Button("Inspect Codex Config…") { model.inspectGlobalConfig() } }
            }
            Divider()
            DisclosureGroup("Connection", isExpanded: $connectionExpanded) {
                VStack(alignment: .leading, spacing: 14) {
                    LabeledContent("Codex configuration", value: model.connectionTitle).foregroundStyle(.secondary)
                    HStack {
                        Text(model.endpoint).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        Spacer(minLength: 0)
                        Button { model.copyEndpoint(); copied = true } label: { Image(systemName: copied ? "checkmark" : "doc.on.doc") }
                            .buttonStyle(.borderless).accessibilityLabel(copied ? "Address copied" : "Copy gateway address")
                    }
                    navigation("Set Up Codex CLI…") { draft = ""; go(.clientSetup) }
                }
            }
            Divider()
            if model.running {
                Button("Stop Gateway…", role: .destructive) { confirmStop = true }.disabled(model.busy || model.isDemo)
            } else {
                Button("Start Gateway") { Task { await model.action(["start", "--background"], scope: .settings) } }.disabled(model.busy || !model.selectedReady || model.isDemo)
            }
        }
    }
    private func entryForm(field: String, hint: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(field).font(.callout.weight(.medium))
            TextField("", text: $draft).textFieldStyle(.roundedBorder).accessibilityLabel(field).focused($fieldFocused).disabled(formSaving).onSubmit { submit() }
            if page == .add, !draft.isEmpty, let error = accountNameError(draft) { Text(error).font(.caption).foregroundStyle(.orange) }
            if let hint { Text(hint).font(.caption).foregroundStyle(.secondary) }
        }
    }
    private func feedback(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: model.isError ? "exclamationmark.circle" : "info.circle").foregroundStyle(model.isError ? Color.orange : .secondary)
            Text(message).font(.callout).frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            Button { model.message = nil } label: { Image(systemName: "xmark").font(.caption2).frame(width: 18, height: 18) }
                .buttonStyle(.borderless).accessibilityLabel("Dismiss message")
        }
    }
    private var footer: some View {
        HStack {
            switch page {
            case .accounts:
                Button { draft = ""; go(.add) } label: { Label("Add Account…", systemImage: "plus") }
                    .buttonStyle(.plain).disabled(model.busy || model.isDemo || model.loginPending)
                Spacer()
                if model.isDemo { Text("PREVIEW").font(.caption2).foregroundStyle(.tertiary) }
                if !model.running && model.selectedReady {
                    Button("Start") { Task { await model.action(["start", "--background"]) } }.buttonStyle(.borderedProminent).disabled(model.busy || model.isDemo)
                }
            case .settings:
                Text(model.running ? "Gateway stays running" : status.title == "Stopped" ? "Gateway is stopped" : "Monitoring stops").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button("Quit Menu App") { NSApp.terminate(nil) }.help("Automatic monitoring stops")
            case .routing:
                Button("Cancel") { editingOrder = nil; model.clearFeedback(.priority) }.disabled(prioritySaving)
                Spacer()
                Button(prioritySaving ? "Saving…" : "Done") { savePriority() }
                    .buttonStyle(.borderedProminent).disabled(model.busy || prioritySaving || !priorityDirty).keyboardShortcut(.defaultAction)
            case .add, .clientSetup:
                Button("Cancel") { go(page.parent) }.disabled(formSaving)
                Spacer()
                Button(formSaving ? "Saving…" : page == .add ? "Add & Sign In…" : "Choose Folder…") { submit() }
                    .buttonStyle(.borderedProminent).disabled(!canSubmit).keyboardShortcut(.defaultAction)
            default: EmptyView()
            }
        }.padding(.horizontal, 20).frame(height: 52)
    }
    private var canSubmit: Bool {
        !model.busy && !model.isDemo && submittingPage == nil &&
        (page == .clientSetup ? !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.running : accountNameError(draft) == nil && !model.loginPending)
    }
    private func savePriority() {
        guard !prioritySaving, !model.busy, let order = editingOrder, priorityDirty else { return }
        prioritySaving = true
        Task {
            if await model.setRouting(order: order, scope: .priority) { editingOrder = nil }
            prioritySaving = false
        }
    }
    private func submit() {
        guard canSubmit else { return }
        let source = page, revision = navigationID, value = draft
        submittingPage = source; model.clearFeedback(source.scope)
        Task {
            let completed: Bool
            switch source {
            case .add: completed = await model.add(label: value)
            case .clientSetup: completed = await model.createClient(modelID: value)
            default: completed = false
            }
            submittingPage = nil
            if completed && page == source && navigationID == revision { go(source.parent) }
        }
    }
}

private struct RenameAccountView: View {
    @ObservedObject var model: GatewayModel
    let account: Account
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var saving = false
    @FocusState private var focused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Rename Account").font(.headline)
            TextField("Account name", text: $draft).textFieldStyle(.roundedBorder).focused($focused)
                .accessibilityLabel("Account name").disabled(saving).onSubmit { save() }
            if let error = accountNameError(draft) { Text(error).font(.caption).foregroundStyle(.orange) }
            if model.messageScope == .rename(account.id), let message = model.message {
                Text(message).font(.callout).foregroundStyle(model.isError ? Color.orange : .secondary)
            }
            HStack {
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving)
                Spacer()
                Button(saving ? "Saving…" : "Save") { save() }.keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent).disabled(saving || model.busy || accountNameError(draft) != nil || draft == account.label)
            }
        }.padding(20).frame(width: 340).interactiveDismissDisabled(saving)
            .task { draft = account.label; focused = true }
    }
    private func save() {
        guard !saving, !model.busy, accountNameError(draft) == nil, draft != account.label else { return }
        let value = draft; saving = true
        Task { let saved = await model.rename(account, to: value); saving = false; if saved { dismiss() } }
    }
}

private struct FullRowDisclosureStyle: DisclosureGroupStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.15)) { configuration.isExpanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                        .rotationEffect(.degrees(configuration.isExpanded ? 90 : 0)).accessibilityHidden(true)
                    configuration.label
                    Spacer(minLength: 0)
                }.frame(minHeight: 28).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
            if configuration.isExpanded { configuration.content }
        }
    }
}

private struct UsageMeter: View {
    let remaining: Double
    let stale: Bool
    @Environment(\.colorSchemeContrast) private var colorContrast

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(colorContrast == .increased ? 0.22 : 0.08))
                // Preserve the actual proportion, including an entirely empty zero.
                if remaining.isFinite && remaining > 0 {
                    Capsule().fill(stale ? Color.secondary : Color.blue)
                        .frame(width: geometry.size.width * min(100, remaining) / 100)
                }
            }
        }.frame(height: 3).accessibilityHidden(true)
    }
}

private extension StatusTone {
    var color: Color {
        switch self { case .positive: .green; case .caution: .orange; case .neutral: .secondary }
    }
}
