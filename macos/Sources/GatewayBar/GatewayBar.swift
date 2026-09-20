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

struct GatewayView: View {
    @ObservedObject var model: GatewayModel
    @State private var confirmStop = false
    @State private var contentHeight: CGFloat = 180
    @State private var connectionExpanded = false
    @State private var usageExpanded = false
    private var selected: Account? { model.accounts.first(where: \.selected) }
    private var bodyHeight: CGFloat {
        let available = (NSScreen.main?.visibleFrame.height ?? 800) - 130
        return min(contentHeight, max(180, min(520, available)))
    }
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let notice = model.routing?.notice {
                        Label(notice, systemImage: "exclamationmark.circle")
                            .font(.caption).foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 14)
                    }
                    if let message = model.message {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: model.isError ? "exclamationmark.circle" : "info.circle")
                            Text(message).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Button { model.message = nil } label: { Image(systemName: "xmark").font(.caption2) }
                                .buttonStyle(.plain).accessibilityLabel("Dismiss message")
                        }
                        .font(.caption).foregroundStyle(model.isError ? Color.orange : Color.secondary)
                        .padding(.horizontal, 14)
                    }
                    if model.loginPending {
                        Button("Check sign-in", systemImage: "arrow.clockwise") { Task { await model.checkLogin() } }
                            .disabled(model.busy).padding(.horizontal, 14)
                    }
                    if model.accounts.count == 1 && !model.accounts[0].authenticated {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Stay signed into one account.").font(.system(size: 14, weight: .semibold))
                            Text("Use usage from multiple ChatGPT accounts.")
                                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }.padding(.horizontal, 14)
                    }
                    if model.adding { addForm.padding(.horizontal, 14) }
                    VStack(spacing: 2) {
                        if model.accounts.contains(where: \.authenticated) {
                            HStack {
                                Text("Account")
                                Spacer()
                                Text("Weekly left")
                            }.font(.caption).foregroundStyle(.secondary).padding(.leading, 37).padding(.trailing, 16).padding(.bottom, 3)
                        }
                        ForEach(model.accounts) { account in accountRow(account) }
                    }
                    if model.accounts.contains(where: \.authenticated) {
                        usageDetails.padding(.horizontal, 14)
                    }
                    if connectionExpanded { connection.padding(.horizontal, 14) }
                }
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                .background(GeometryReader { geometry in
                    Color.clear.preference(key: ContentHeightKey.self, value: geometry.size.height)
                })
            }
            .frame(height: bodyHeight)
            .onPreferenceChange(ContentHeightKey.self) { height in
                if height > 0 { contentHeight = ceil(height) }
            }
            Divider()
            footer
        }
        .frame(width: 340)
        .fixedSize(horizontal: false, vertical: true)
        .background(.regularMaterial)
        .task {
            if !ProcessInfo.processInfo.arguments.contains("--demo") { UserDefaults.standard.set(true, forKey: "didShowWelcome") }
            await model.refresh()
        }
        .confirmationDialog("Stop the gateway?", isPresented: $confirmStop) {
            Button("Stop gateway", role: .destructive) { Task { await model.action(["stop"], success: "Gateway stopped.") } }
        } message: { Text("Active requests will be cancelled. Your accounts stay signed in.") }
    }
    private var header: some View {
        HStack(spacing: 8) {
            AccountGlyph().fill(.secondary).frame(width: 20, height: 19).accessibilityHidden(true)
            Text("Gateway").font(.system(size: 13, weight: .semibold))
            Spacer()
            if model.busy { ProgressView().controlSize(.mini).accessibilityLabel("Updating gateway") }
            if !model.running && model.selectedReady {
                Button("Start") { Task { await model.action(["start", "--background"], success: "Gateway running.") } }
                    .controlSize(.small).disabled(model.busy).accessibilityLabel("Start gateway")
            } else {
                HStack(spacing: 5) {
                    Circle().fill(model.running ? Color.green : Color.secondary.opacity(0.5)).frame(width: 5, height: 5)
                    Text(model.running ? (model.routing?.notice == nil ? "Automatic" : "Paused") : model.state.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }.padding(.horizontal, 14).padding(.vertical, 12)
    }
    @ViewBuilder private func accountRow(_ account: Account) -> some View {
        if account.authenticated {
            Button {
                guard !account.selected else { return }
                Task { await model.action(["account-select", "--account", account.id], success: "Selected \(account.label). Automatic routing keeps a 5% weekly reserve.") }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color.accentColor).opacity(account.selected ? 1 : 0).frame(width: 14)
                    Text(account.label).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 8)
                    if model.usageErrors[account.id] != nil {
                        Image(systemName: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
                            .help("Usage may be out of date. Open Usage details.")
                    }
                    if let weekly = model.usages[account.id]?.weeklyWindow {
                        Text("\(Int(weekly.remaining_percent.rounded()))%")
                            .monospacedDigit().foregroundStyle(weekly.remaining_percent <= 10 ? Color.orange : Color.primary)
                    } else {
                        Text("—").foregroundStyle(.secondary).help("Weekly usage has not been reported.")
                    }
                }
                .font(.system(size: 13))
                .padding(.horizontal, 10).padding(.vertical, 9)
                .contentShape(Rectangle())
                .background(account.selected ? Color.accentColor.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 5))
            }
            .buttonStyle(.plain).disabled(model.busy).padding(.horizontal, 6)
            .accessibilityLabel("\(account.label), \(account.selected ? "selected, " : "")weekly remaining \(weeklyDescription(account))")
            .accessibilityHint("Select this account for future requests")
        } else {
            HStack {
                Image(systemName: "person.crop.circle").foregroundStyle(.secondary).frame(width: 14)
                Text(account.label).lineLimit(1)
                Spacer()
                Button("Sign in") { model.login(account) }.buttonStyle(.borderedProminent).controlSize(.small).disabled(model.busy)
            }.font(.system(size: 13)).padding(.horizontal, 16).padding(.vertical, 6)
        }
    }
    private func weeklyDescription(_ account: Account) -> String {
        guard let window = model.usages[account.id]?.weeklyWindow else { return "unavailable" }
        let stale = model.usageErrors[account.id] == nil ? "" : ", out of date"
        return "\(Int(window.remaining_percent.rounded())) percent\(stale)"
    }
    private var usageDetails: some View {
        DisclosureGroup("Usage details", isExpanded: $usageExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(selected?.label ?? "Selected account").fontWeight(.medium)
                    Spacer()
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await model.refresh(includeUsage: true) } }
                        .disabled(model.checkingUsage).controlSize(.small)
                }
                if let account = selected {
                    if let error = model.usageErrors[account.id] {
                        Text(error).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    }
                    if let usage = model.usages[account.id] {
                        ForEach(usage.buckets) { bucket in
                            VStack(alignment: .leading, spacing: 8) {
                                if usage.buckets.count > 1 { Text(bucket.id).fontWeight(.medium) }
                                if let primary = bucket.primary { usageWindow(primary) }
                                if let secondary = bucket.secondary { usageWindow(secondary) }
                            }
                        }
                        if usage.weeklyWindow == nil { Text("Weekly usage not reported.").foregroundStyle(.secondary) }
                        Text(usage.checkedText + (model.usageErrors[account.id] == nil ? "" : " · out of date")).foregroundStyle(.secondary)
                    } else { Text("Usage not available yet.").foregroundStyle(.secondary) }
                    Button("Sign in again…") { model.login(account) }.disabled(model.busy)
                }
                Text("Automatically switches accounts at 5% weekly remaining. Requests already running finish on their original account.")
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.font(.caption).padding(.top, 8)
        }.font(.caption).foregroundStyle(.secondary)
    }
    private func usageWindow(_ window: UsageWindow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(window.title)
                Spacer()
                Text("\(Int(window.remaining_percent.rounded()))% left").monospacedDigit()
            }.foregroundStyle(.primary)
            if let reset = window.resetText { Text(reset).foregroundStyle(.secondary) }
        }
    }
    private var addForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Account name", text: $model.label).textFieldStyle(.roundedBorder)
                .onSubmit { if !model.label.trimmingCharacters(in: .whitespaces).isEmpty { Task { await model.add() } } }
            Text("Each account signs in separately through the official Codex CLI.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Cancel") { model.adding = false }
                Spacer()
                Button("Add & sign in") { Task { await model.add() } }
                    .buttonStyle(.borderedProminent).disabled(model.busy || model.label.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }.padding(12).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
    }
    private var connection: some View {
        DisclosureGroup(isExpanded: $connectionExpanded) {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("Run automatically", isOn: Binding(get: { model.runAutomatically }, set: { enabled in
                    Task { await model.setAutomaticRun(enabled) }
                })).disabled(model.busy)
                Text("Launches at login and keeps the gateway running. Stop gateway pauses automatic restarts until you click Start.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if model.startupNeedsApproval {
                    Button("Allow startup in System Settings…") { model.openLoginSettings() }
                }
                HStack {
                    Text(model.endpoint).font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary).textSelection(.enabled)
                    Spacer(minLength: 4)
                    Button { model.copyEndpoint() } label: { Image(systemName: "doc.on.doc") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .help("Copy gateway address").accessibilityLabel("Copy gateway address")
                }
                Button("Set up Codex CLI…", systemImage: "terminal") { model.connecting.toggle(); model.adding = false }
                    .disabled(model.busy)
                if model.connecting {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Enter a model your account supports. A new client profile will open in Terminal.")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        TextField("Model ID", text: $model.modelID).textFieldStyle(.roundedBorder)
                        Button("Create profile & open") { Task { await model.createClient() } }
                            .disabled(model.busy || model.modelID.trimmingCharacters(in: .whitespaces).isEmpty || !model.running)
                        if !model.running { Text("Start the gateway first.").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                if model.running {
                    Button("Stop gateway", role: .destructive) { confirmStop = true }.disabled(model.busy)
                } else if model.selectedReady {
                    Button("Start gateway") { Task { await model.action(["start", "--background"], success: "Gateway running.") } }.disabled(model.busy)
                }
                Text("Codex desktop connection is not yet verified.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(.top, 10)
        } label: {
            Label("Connection", systemImage: "network")
                .font(.callout).foregroundStyle(.secondary)
        }
    }
    private var footer: some View {
        HStack {
            Button("Add account…") { model.adding.toggle(); model.connecting = false }.disabled(model.busy)
            Spacer()
            Button("Connection…") { connectionExpanded.toggle() }
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }.help("Quit menu-bar app; the gateway keeps running")
        }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 11)
    }
}

private struct ContentHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}
