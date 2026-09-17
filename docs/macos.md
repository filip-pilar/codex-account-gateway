# macOS menu-bar app

**Stay signed into one account. Use usage from multiple ChatGPT accounts.**

A native SwiftUI menu-bar app for account selection, usage visibility, and gateway controls. Requires macOS 15 or newer, Node >=22.15, the official `codex` CLI on PATH, and Xcode Command Line Tools to build. It uses the existing local gateway; it does not change your primary Codex login or configuration.

## Build and open

```sh
npm run build:macos
open "dist/Codex Gateway.app"
```

The app is locally ad-hoc signed, not notarized or published. It bundles the gateway JavaScript, not Node or Codex. Rebuild after backend changes. The build records the current Node executable and also supports the standard Homebrew Node locations. A nonstandard Codex install must be on the launching environment's PATH.

The panel fits its content and scrolls only when the account list or expanded controls exceed the available height. A welcome window opens on first launch. After closing it, click the stack icon in the menu bar. The app can also be moved to Applications; keep Node and Codex installed. Quitting the app leaves a running gateway alone; use **Connection… → Stop gateway** to stop it. Stopping cancels active requests and asks for confirmation in the UI. The app does not install a login item or restart supervisor.

## First account

1. Click **Sign in** on Default. Terminal opens the official Codex login. Complete it yourself; the app does not read login output.
2. Click **Check sign-in**. Available usage windows and reset times appear after the official CLI reports them.
3. Click **Start** in the header to start the gateway.
4. Click **Connection…**, choose **Set up Codex CLI…**, enter a supported model ID, and choose a new client folder. The app generates a separate client configuration and opens that client in Terminal.

The default backing state is `~/.local/share/codex-gateway`; `CODEX_GATEWAY_HOME` can select an alternative root when launching the app. Client configuration must stay separate from backing state. Existing client folders are never overwritten.

## Additional accounts

Click **Add account…**, enter a label, and complete that account's official login in Terminal. Choose the intended account in the browser; profiles isolate credentials, but do not force your browser to choose a different login automatically. Click **Check sign-in**, then click the desired account row. A checkmark identifies the selected account.

Each added account has its own `accounts/<random-id>/codex` directory. No authentication files or plugins are copied. The selected account persists across gateway restarts. The existing Default profile remains supported.

Switching preserves the gateway's address and process. It is refused while a request is in flight; wait for completion and click the account row again. No inference is retried or automatically routed to another account. Start a **new conversation** after switching: cross-account conversation state and cache reuse are not verified.

## Usage

The app launches the official CLI's stdio app-server and calls only `initialize` and `account/rateLimits/read`. It never creates a thread, sends model input, purchases credits, or consumes reset credits. This integration follows the installed 0.149.1 protocol and remains subject to CLI changes.

- Remaining percentage is `100 - usedPercent`, clamped to 0–100.
- The main list shows **Weekly left**, matched by a reported seven-day window rather than plan price or primary/secondary position. A missing weekly window displays an em dash. With multiple buckets, only the explicitly named `codex` bucket supplies the summary.
- **Usage details** shows the selected account’s reset times, last check, sign-in renewal, refresh, and all other reported windows. Short windows are not featured in the main list, but are not discarded or assumed absent based on subscription tier.
- Distinct limit buckets stay separate; they are not summed into a fictional quota.
- Window names reflect reported durations rather than assuming every account has identical limits.
- Missing data is unavailable, never zero or unlimited.
- Usage stays in app memory with its last-check time. A failed refresh retains an explicitly out-of-date snapshot.
- Expand **Usage details** and click **Refresh** for a fresh check. Opening the view requests usage when its last check is more than five minutes old; there is no continuous background polling.
- Presence of a local credential file does not prove that the login is valid; usage errors offer sign-in again.

## Desktop compatibility

This app manages the gateway. It **does not configure the Codex desktop app**, whose custom-provider routing and model-picker behavior remain unverified. The guided client setup targets the Codex CLI. The gateway forwards the model supplied by a client unchanged, subject to the backing account's access.

## Development

```sh
npm run check
npm run build:macos
swift test --package-path macos
open "dist/Codex Gateway.app" --args --preview --demo
```

`--preview` opens a normal window for visual inspection. `--demo` uses clearly labeled, in-memory sample accounts and disables account/gateway mutations; it does not read real usage. Quit before relaunching without these flags. `CODEX_GATEWAY_CLI` can select a fixture backend for UI testing.

Tests use disposable profiles and fake Codex executables. They cover isolation, selection persistence, busy switching, control authentication, usage normalization, redaction, and RPC timeouts. Live validation requires a user-completed isolated login. No primary credentials are borrowed for testing.

## Icons

The blue app icon and panel header use the original account artwork in `macos/Sources/GatewayBar/AccountGlyph.swift`. The menu bar uses a separate, static stack of layers in `macos/Sources/GatewayBar/StackGlyph.swift`, representing multiple accounts in one place. The build uses `macos/Tools/GenerateIcon.swift` and macOS `iconutil` to generate a complete `.icns` set; no image generation service or external asset download is required. Generated images stay in `macos/.build/` and `dist/`. The menu-bar image is a template, so macOS adapts it to the current appearance.
