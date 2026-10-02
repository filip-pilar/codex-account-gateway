# macOS menu-bar app

Manage backing accounts, usage, and the local gateway from a SwiftUI menu-bar app. Requires macOS 15+, Node >=22.15, the official `codex` CLI on PATH, and Xcode Command Line Tools with Swift 6+ to build.

## Build and open

```sh
npm run build:macos
open "dist/Codex Gateway.app"
```

The locally ad-hoc signed app bundles the gateway JavaScript. Node and Codex must remain installed. The build records the current Node executable and supports standard Homebrew Node locations; a nonstandard Codex install must be on the launching environment's PATH. Rebuild after backend changes, then quit and reopen the app.

A welcome window opens on first launch. After closing it, use the stack icon in the menu bar. Move the app to Applications before enabling login startup. Quitting leaves the backend running; **Settings → Stop Gateway…** stops it and cancels active requests.

## First account

1. Open **Default → Sign In…** and complete the official Codex login in Terminal. Login output stays in Terminal.
2. Click **Check Sign-in**, then **Start** in the overview.
3. Connect a client using either **Settings → Use gateway in Codex** for your existing Codex configuration, or **Set Up Codex CLI…** to create a separate client folder with a supported model ID. Restart Codex after changing its connection.
4. Optionally enable **Keep gateway running** in Settings and allow login startup and notifications when macOS requests them.

Backing state defaults to `~/.local/share/codex-gateway`. Set `CODEX_GATEWAY_HOME` when launching the app to use another private directory. Keep client folders separate; setup never overwrites an existing folder.

**Update Connection** repairs incomplete managed connection settings. Unmanaged overrides require inspection. See the [connection contract](cli.md#codex-connection). Transport limits are configured in the profile's private [`limits.json`](cli.md#transport-limits) and take effect after restarting the gateway.

## Accounts and usage

Use **Add Account…** and complete each account's login in Terminal. Choose the intended account in the browser; separate profiles do not change the browser's selected login. Signed-in accounts join the routing pool automatically.

Click an account to see its usage windows, reset times, credit balance, and last check, or to rename it. **Use This Account** changes the selected account when the gateway is idle, subject to the routing policy. Selection persists across restarts; credentials stay in each account's private profile.

The overview's **Weekly left** uses a reported seven-day window from the core usage bucket. Missing data displays as unavailable. Other windows and credit balances remain separate in account details. Failed or expired reports retain the last valid reading, marked out of date. Missing credentials prompt sign-in; usage-fetch failures alone do not imply invalid credentials.

The refresh button checks usage through the official CLI without inference. While running, the display uses the gateway's shared cache. When stopped, the app performs standalone reads. See [usage fields and diagnostics](cli.md#account-selection-and-usage).

## Automatic operation

The gateway checks usage on startup and every minute. It keeps the selected usable account, switching in list order when weekly remaining reaches 5% or an included-usage window is exhausted. New requests prefer accounts above reserve, then accounts with unknown usage. Active requests finish with their original account; the gateway never replays them.

If all accounts have confirmed reserve or exhaustion and no permitted fallback is available, new requests pause until a fresh report confirms eligible usage. Missing usage alone permits requests. Polling delays, activity outside the gateway, and active requests mean these controls cannot enforce a strict spending cap.

- **Allow reserve usage**, in Settings, permits remaining included allowance below 5% when other accounts are unavailable. Reported exhaustion still requires credit permission.
- **Allow credit fallback**, in each account's details, permits using its reserve and available credits after other included usage is unavailable. It requires a fresh successful credit report. **Credit fallback** indicates the routing choice, not a confirmed charge. OpenAI controls billing; this toggle does not purchase credits or change billing settings.

Both permissions default off, persist, and apply to new requests immediately. Turning them off leaves active requests alone. Unknown usage can still allow credit consumption under the availability policy. See the [routing and credit rules](cli.md#automatic-weekly-routing).

**Keep gateway running** registers the app as a login item and monitors the backend while the app is open. It restarts a verified stopped instance with a signed-in account, at most once a minute. **Stop Gateway** pauses this behavior across app launches; **Start** or enabling automatic operation clears the pause. Disabling monitoring does not stop a running backend.

When routing needs attention, the app shows the reason and sends one notification per condition until recovery, if macOS allows notifications. Successful account switches are silent.

## Development

See [verification](verification.md) for checks. For visual inspection:

```sh
open "dist/Codex Gateway.app" --args --preview --demo
```

`--preview` opens a normal window. `--demo` uses in-memory sample accounts and disables account and gateway changes. Quit before relaunching normally. `CODEX_GATEWAY_CLI` can select a fixture backend for UI testing.

Icon sources are `AccountGlyph.swift` and `StackGlyph.swift`. The build generates the app icon with `macos/Tools/GenerateIcon.swift` and `iconutil`; generated assets stay in `macos/.build/` and `dist/`.
