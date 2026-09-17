import SwiftUI
import AppKit

@main struct GatewayBarApp: App {
    @StateObject private var model = GatewayModel()
    private let showWelcome = !UserDefaults.standard.bool(forKey: "didShowWelcome")
    var body: some Scene {
        MenuBarExtra {
            GatewayView(model: model)
        } label: {
            Image(systemName: "arrow.triangle.branch")
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
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let message = model.message {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: model.isError ? "exclamationmark.circle" : "info.circle")
                            Text(message).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Button { model.message = nil } label: { Image(systemName: "xmark").font(.caption2) }
                                .buttonStyle(.plain).accessibilityLabel("Dismiss message")
                        }
                        .font(.caption).foregroundStyle(model.isError ? Color.orange : Color.secondary)
                    }
                    if model.loginPending {
                        Button("Check sign-in", systemImage: "arrow.clockwise") { Task { await model.checkLogin() } }
                            .disabled(model.busy)
                    }
                    if model.accounts.count == 1 && !model.accounts[0].authenticated {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Your accounts. One gateway.").font(.title3.weight(.semibold))
                            Text("Sign in to see your remaining usage. Choose which account powers your next requests.")
                                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("ACCOUNTS").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Spacer()
                            Button { model.adding.toggle(); model.connecting = false } label: { Label("Add", systemImage: "plus") }
                                .buttonStyle(.plain).font(.caption.weight(.medium)).disabled(model.busy)
                        }
                        if model.adding { addForm }
                        ForEach(model.accounts) { account in accountCard(account) }
                    }
                    if model.accounts.contains(where: \.authenticated) {
                        Text("Switching applies to the next request. For now, start a new conversation after switching accounts.")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    connection
                }.padding(20)
            }.frame(height: 520)
            Divider()
            footer
        }
        // MenuBarExtra sizes its panel from the root ideal size. A width-only
        // root can let the scroll area collapse during its first sizing pass.
        .frame(width: 368, height: 650)
        .fixedSize()
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
        HStack(spacing: 12) {
            Image(systemName: "arrow.triangle.branch").font(.system(size: 20, weight: .medium))
                .frame(width: 38, height: 38).background(.quaternary, in: RoundedRectangle(cornerRadius: 11))
            VStack(alignment: .leading, spacing: 3) {
                Text("Codex Gateway").font(.headline)
                HStack(spacing: 5) {
                    Circle().fill(model.running ? Color.green : Color.secondary.opacity(0.5)).frame(width: 6, height: 6)
                    Text(model.running ? "Running · \(model.activeName)" : model.state == "stopped" ? "Gateway stopped" : model.state.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            if model.busy { ProgressView().controlSize(.small).accessibilityLabel("Updating gateway") }
            else {
                Button { Task { await model.refresh(includeUsage: true) } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Refresh accounts and usage").accessibilityLabel("Refresh accounts and usage")
            }
        }.padding(20)
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
    private func accountCard(_ account: Account) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: account.selected ? "checkmark.circle.fill" : "person.crop.circle")
                    .foregroundStyle(account.selected ? Color.accentColor : Color.secondary).font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.label).font(.system(.body, weight: .semibold)).lineLimit(1)
                    Text(!account.authenticated ? "Sign-in needed" : account.selected ? "Selected account" : "Available")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if !account.authenticated {
                    Button("Sign in") { model.login(account) }.controlSize(.small).disabled(model.busy)
                } else if !account.selected {
                    Button("Use") { Task { await model.action(["account-select", "--account", account.id], success: "Using \(account.label). Start a new conversation for this account.") } }
                        .controlSize(.small).disabled(model.busy).accessibilityLabel("Use \(account.label)")
                }
                if account.authenticated {
                    Menu { Button("Sign in again…") { model.login(account) } } label: { Image(systemName: "ellipsis") }
                        .menuStyle(.borderlessButton).frame(width: 20).disabled(model.busy).accessibilityLabel("Options for \(account.label)")
                }
            }
            if let usage = model.usages[account.id], account.authenticated {
                ForEach(usage.buckets) { bucket in
                    VStack(alignment: .leading, spacing: 12) {
                        if bucket.id != "codex" { Text(bucket.id).font(.caption.weight(.medium)).foregroundStyle(.secondary) }
                        if let primary = bucket.primary { meter(primary) }
                        if let secondary = bucket.secondary { meter(secondary) }
                        if bucket.primary == nil && bucket.secondary == nil { Text("No usage windows reported").font(.caption).foregroundStyle(.secondary) }
                    }
                }
                if usage.buckets.isEmpty { Text("Usage unavailable").font(.caption).foregroundStyle(.secondary) }
                Text(usage.checkedText + (model.usageErrors[account.id] == nil ? "" : " · out of date"))
                    .font(.caption2).foregroundStyle(.tertiary)
            } else if account.authenticated && model.usageErrors[account.id] == nil {
                Text(model.busy ? "Checking usage…" : "Usage not checked yet").font(.caption).foregroundStyle(.secondary)
            }
            if let error = model.usageErrors[account.id], account.authenticated {
                Text(error).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(account.selected ? Color.accentColor.opacity(0.045) : Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(account.selected ? Color.accentColor.opacity(0.22) : Color.primary.opacity(0.08), lineWidth: 1))
    }
    private func meter(_ window: UsageWindow) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(window.title).foregroundStyle(.secondary)
                Spacer()
                Text("\(Int(window.remaining_percent.rounded()))% left").monospacedDigit().fontWeight(.medium)
            }.font(.caption)
            ProgressView(value: window.remaining_percent, total: 100)
                .tint(window.remaining_percent <= 10 ? .orange : .accentColor)
                .accessibilityLabel("\(window.title) usage remaining").accessibilityValue("\(Int(window.remaining_percent)) percent")
            if let reset = window.resetText { Text(reset).font(.caption2).foregroundStyle(.tertiary) }
        }
    }
    private var connection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("CONNECTION").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Button { model.copyEndpoint() } label: { Image(systemName: "doc.on.doc") }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Copy gateway address").accessibilityLabel("Copy gateway address")
            }
            Text(model.endpoint).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
            Button("Set up Codex CLI…", systemImage: "terminal") { model.connecting.toggle(); model.adding = false }
                .disabled(model.busy)
            if model.connecting {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Enter a model your account supports. A new isolated client profile will open in Terminal.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    TextField("Model ID", text: $model.modelID).textFieldStyle(.roundedBorder)
                    Button("Create profile & open") { Task { await model.createClient() } }
                        .disabled(model.busy || model.modelID.trimmingCharacters(in: .whitespaces).isEmpty || !model.running)
                    if !model.running { Text("Start the gateway first.").font(.caption).foregroundStyle(.secondary) }
                }
            }
            Text("Codex desktop connection is not yet verified.")
                .font(.caption2).foregroundStyle(.tertiary)
        }
    }
    private var footer: some View {
        HStack {
            if model.running {
                Button("Stop gateway") { confirmStop = true }.disabled(model.busy)
            } else {
                Button("Start gateway") { Task { await model.action(["start", "--background"], success: "Gateway running.") } }
                    .disabled(model.busy || !model.selectedReady)
            }
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }.help("Quit menu-bar app; the gateway keeps running")
        }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary).padding(.horizontal, 20).padding(.vertical, 13)
    }
}
