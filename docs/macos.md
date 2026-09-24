# macOS menu-bar app

**Switch ChatGPT accounts for Codex CLI from your menu bar.**

A native SwiftUI menu-bar app for automatic account routing, usage visibility, and gateway controls. Requires macOS 15 or newer, Node >=22.15, the official `codex` CLI on PATH, and Xcode Command Line Tools to build. It manages the local gateway and separate backing accounts. Settings offers one reversible connection switch for new and existing OpenAI tasks.

## Build and open

```sh
npm run build:macos
open "dist/Codex Gateway.app"
```

The app is locally ad-hoc signed, not notarized or published. It bundles the gateway JavaScript, not Node or Codex. Rebuild after backend changes. The build records the current Node executable and also supports the standard Homebrew Node locations. A nonstandard Codex install must be on the launching environment's PATH.

The overview fits the account list and shows gateway status in its header. Account details, Settings, and forms open as separate pages. Long content scrolls within the page; the header and primary action stay visible. A welcome window opens on first launch. After closing it, click the stack icon in the menu bar. Move the app to Applications for automatic startup; keep Node and Codex installed. Quitting the app leaves a running gateway alone; use **Settings → Stop Gateway…** to stop it. Stopping cancels active requests and asks for confirmation in the UI.

## First account

1. Open Default and click **Sign In…**. Terminal opens the official Codex login. Complete it yourself; the app does not read login output.
2. Click **Check Sign-in**. Available usage windows and reset times appear after the official CLI reports them.
3. Click **Start** in the overview to start the gateway.
4. Open **Settings**, choose **Set Up Codex CLI…**, enter a supported model ID, and choose a new client folder. The app generates a separate client configuration and opens that client in Terminal.
5. Enable **Keep gateway running** in Settings. Allow login startup in System Settings if macOS requests it, and allow notifications to receive attention alerts.

The default backing state is `~/.local/share/codex-gateway`; `CODEX_GATEWAY_HOME` can select an alternative root when launching the app. Client configuration must stay separate from backing state. Existing client folders are never overwritten.

## Additional accounts

Click **Add Account…**, enter a label, and complete that account's official login in Terminal. Choose the intended account in the browser; profiles isolate credentials, but do not force your browser to choose a different login automatically. Click **Check Sign-in**. Signed-in accounts join the pool automatically. A checkmark and blue highlight identify the selected account; routine status stays in the header, and notices appear only when attention is needed. Clicking a row opens its details; **Use This Account** explicitly changes selection. Accounts with unknown usage can be manually selected. Accounts at a confirmed weekly reserve cannot be selected until a valid reading clears it. Use **Rename…** in details to change any account label.

Each added account has its own `accounts/<random-id>/codex` directory. No authentication files or plugins are copied. The selected account persists across gateway restarts. The existing Default profile remains supported.

Automatic switching preserves the gateway's address and process. When weekly remaining reaches 5%, new requests prefer the next signed-in account with fresh usage above 5%, falling back to an account with unknown usage. Existing requests finish on their original account. No model request is replayed. Manual selection is refused while a request is running and cannot bypass the reserve. One existing Desktop task completed a turn through an alternate backing profile; broader conversation compatibility remains unverified.

## Automatic operation

The backend checks reported usage on startup and every minute, even with the menu closed. It keeps the current usable account and follows list order when switching, wrapping around. All accounts confirmed at or below 5% pauses new requests; routing resumes once a fresh check confirms available quota. Missing or stale weekly data alone does not pause requests, including immediately after a restart. The app shows “Usage unavailable; requests continuing.” Short-window limits do not trigger switching. When usage checks fail for every account, retries back off up to five minutes. Usage outages, polling, and in-flight requests mean 5% is a switching threshold, not an exact spending cap.

**Keep gateway running** registers this app as a login item and checks the backend every ten seconds while the app is open. It restarts a verified stopped/dead instance, at most once a minute, after an account has been signed in. A deliberate **Stop Gateway** persists across app launches; **Start** or enabling automatic operation clears that pause. Turning off Keep gateway running removes login startup and restart monitoring; it does not stop an already-running backend. Quitting the app stops monitoring until its next launch.

When all accounts reach the reserve or routing needs login attention, the app shows the reason and posts one notification per condition until routing recovers, if macOS notifications are allowed. Successful account switches are silent. Notification delivery still needs validation on the user's installed app.

## Usage

While the gateway runs, the app reads its shared usage cache and requests background refreshes through authenticated local control. When stopped, the app performs standalone usage reads. The backend launches the official CLI's stdio app-server and calls only `initialize` and `account/rateLimits/read`. It never creates a thread, sends model input, purchases credits, or consumes reset credits. This integration remains subject to CLI changes.

- Remaining percentage is `100 - usedPercent`, clamped to 0–100.
- The overview shows **Weekly left**, matched by a reported seven-day window rather than plan price or primary/secondary position. A missing weekly window displays an em dash. With multiple buckets, only the explicitly named `codex` bucket supplies the summary.
- Opening an account shows its reset times, last check, sign-in renewal, refresh, and all other reported windows. Short windows are not featured in the main list, but are not discarded or assumed absent based on subscription tier.
- Distinct limit buckets stay separate; they are not summed into a fictional quota.
- Window names reflect reported durations rather than assuming every account has identical limits.
- Missing data is unavailable, never zero or unlimited.
- The display and routing use the same backend snapshots while running. Failed, incomplete, or expired reports preserve the last valid reading, marked out of date. Positive readings become stale after five minutes or their reset time; unknown usage permits requests, while a confirmed reserve requires a valid new reading to clear. Snapshots are memory-only.
- Click the refresh icon in Accounts or account details to refresh the shared backend readings. The request returns immediately while checks run in the background; the app polls the shared result every ten seconds. Opening the view requests usage when its last refresh is more than five minutes old. Usage refresh leaves the other controls available.
- Presence of a local credential file does not prove that the login is valid. Fetch failures report usage as unavailable without assuming an authentication problem. Only confirmed missing-login errors recommend signing in. `usage-status --json` exposes safe error categories, attempt/success times, consecutive failures, and the next retry time.

## Desktop compatibility

This app manages the gateway. Its guided client setup targets the Codex CLI. **Use gateway in Codex** connects new and existing OpenAI tasks together; disabling it restores both managed settings. Restart Codex after changing the connection. An incomplete older setup shows **Update Connection**. See the [connection contract](cli.md#codex-connection). Tasks saved with unrelated custom providers are unaffected. Model-picker behavior remains unverified. The gateway forwards the model supplied by a client unchanged, subject to the backing account's access.

## Development

```sh
npm run check
npm run build:macos
swift test --package-path macos
open "dist/Codex Gateway.app" --args --preview --demo
```

`--preview` opens a normal window for visual inspection. A separate preview bundle can set `GatewayDemoMode` in its Info.plist to launch directly in demo mode; give it a distinct bundle identifier to keep the live app separate. `--demo` uses clearly labeled, in-memory sample accounts and disables account/gateway mutations; it does not read real usage. Quit before relaunching without these flags. `CODEX_GATEWAY_CLI` can select a fixture backend for UI testing.

Tests use disposable profiles and fake Codex executables. They cover automatic switching and exhaustion, recovery, concurrent requests, isolation, selection persistence, control authentication, usage normalization, redaction, child cancellation, startup policy, and notification deduplication. Live validation requires a user-completed isolated login. No primary credentials are borrowed for testing.

## Icons

The blue app icon uses the original account artwork in `macos/Sources/GatewayBar/AccountGlyph.swift`. The menu bar and panel header use a separate, static stack of layers in `macos/Sources/GatewayBar/StackGlyph.swift`, representing multiple accounts in one place. The build uses `macos/Tools/GenerateIcon.swift` and macOS `iconutil` to generate a complete `.icns` set; no image generation service or external asset download is required. Generated images stay in `macos/.build/` and `dist/`. The menu-bar image is a template, so macOS adapts it to the current appearance.
