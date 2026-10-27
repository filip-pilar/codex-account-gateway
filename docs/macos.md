# macOS menu-bar app

Manage backing accounts, usage, and the local gateway from a SwiftUI menu-bar app. Requires macOS 15+, Node >=22.15, the official `codex` CLI on PATH, and Xcode Command Line Tools with Swift 6+ to build.

## Build and open

```sh
npm run build:macos
open "dist/Codex Gateway.app"
```

The locally ad-hoc signed app bundles the gateway JavaScript. Node and Codex must remain installed. The build records the current Node executable and supports standard Homebrew Node locations; a nonstandard Codex install must be on the launching environment's PATH. Rebuild after backend changes, then quit and reopen the app.

A welcome window opens on first launch. After closing it, use the stack icon in the menu bar. Move the app to Applications before enabling login startup. **Settings → Quit Menu App** leaves the backend running; **Stop Gateway…** asks for confirmation before stopping it and cancelling active requests.

## First account

1. Open **Default → Sign In…** and complete the official Codex login in Terminal. Login output stays in Terminal.
2. The sign-in notice clears when that Terminal login completes. **Check Sign-in** checks immediately; **Hide Notice** hides the banner while completion tracking continues. **Open Terminal** returns to the existing sign-in. Another sign-in cannot start while one is pending. Then click **Start** in the overview.
3. Connect a client using either **Settings → Use gateway in Codex** for your existing Codex configuration, or **Connection → Set Up Codex CLI…** to create a separate client folder with a supported model ID. Restart Codex after changing its connection.
4. Optionally enable **Keep gateway running** in Settings and allow login startup and notifications when macOS requests them.

Backing state defaults to `~/.local/share/codex-gateway`. Set `CODEX_GATEWAY_HOME` when launching the app to use another private directory. Keep client folders separate; setup never overwrites an existing folder.

**Update Connection** repairs incomplete managed connection settings. Unmanaged overrides require inspection. See the [connection contract](cli.md#codex-connection). Transport limits are configured in the profile's private [`limits.json`](cli.md#transport-limits) and take effect after restarting the gateway.

## Accounts and usage

Use **Add Account…** and complete each account's login in Terminal. Choose the intended account in the browser; separate profiles do not change the browser's selected login. Signed-in accounts join the routing pool automatically.

Click an account to see its reported usage windows, reset times, and credit balance. **Allow credits** belongs to the account and applies in both routing modes. **Use This Account** switches to fixed routing for the account being viewed. The account menu contains Rename, which opens an attached dialog, and Sign In Again. **Details** holds check diagnostics, activation history, and the full reported balance with a copy action. Credentials stay in each account’s private profile.

The overview's **Weekly left** uses a reported seven-day window from the core usage bucket. Thin bars show remaining allowance for each reported window on the current account and weekly allowance on other accounts. Zero is an empty track; stale readings use gray fills and a last-known label; unavailable readings have no bar. Positive usage below 1% displays as <1%. Credit balances use locale grouping and at most two decimals; positive balances below 0.01 display as <0.01. Large balances are abbreviated with an approximation marker, while Details retains the full numeric value. Unlimited and unavailable balances remain distinct. Display rounding never controls routing. Reset times and credit balances remain in account details. Failed or expired reports retain the last valid reading, marked out of date on every account. Details distinguish the last successful report from the latest attempt. Missing credentials prompt sign-in; usage-fetch failures alone do not imply invalid credentials.

The refresh button starts or joins a check and waits for its result. While running, the display uses the gateway's shared cache. When stopped, the app performs standalone reads. Reads alone do not consume inference quota; separately enabled weekly activation can send a request during running-gateway checks. See [usage fields and diagnostics](cli.md#account-selection-and-usage).

**Running** describes gateway routing. **Codex connection** separately reports whether the client connection is configured, needs an update, or cannot be inspected. Inspection failures provide **Inspect Codex Config…** and do not stop gateway monitoring. A configured endpoint does not establish that an already-open Codex client has reloaded its settings.

Full usage does not establish that a weekly timer has started. Fixed reported resets display their date and local timezone. A full report whose reset advances with successive checks, remaining about seven days ahead, is labeled **Weekly timer appears unstarted**. Insufficient or inconsistent observations display **Weekly reset not confirmed**.

### Start unused weekly windows

**Settings → Start unused weekly windows** defaults off. Enabling it authorizes one small, tool-free request to an apparently unstarted account during running-gateway checks, including manual refresh. It uses quota and may be billable under the account's plan. Exactly 100% must be reported, with two successful readings 30–300 seconds apart showing a reset moving with the clock, about seven days ahead. Exhausted or expired included-usage windows prevent activation.

The request uses that profile's credentials and the official CLI's reported default text model with its lowest reported supported reasoning effort. It has a 30-second deadline, a 1 MiB response cap, no tools, no storage, and no retries. Account selection stays unchanged. Usage is then rechecked; a fixed reset must be observed before success is confirmed. Account details show the last activation and safe failure reason.

An attempt is saved privately before sending. Failed, cancelled, interrupted, and unconfirmed attempts are not repeated by refreshes, toggling the setting, or restarting. Another attempt is allowed only after a subsequently confirmed weekly window expires and a new unstarted window is observed. Disabling the option cancels an in-flight activation. Stopped-gateway standalone checks never activate accounts.

## Routing

**Routing** owns global mode, account priority, and fallback order. Account details owns credit permission and direct account selection. Settings contains app operation, weekly activation, and the Codex connection.

- **Automatic** keeps an eligible current account within its usage category. When switching, it uses **Account priority**; Edit offers drag handles and keyboard-accessible move buttons. Done and Cancel remain visible while scrolling. Leaving a changed draft or switching mode asks before discarding it; failed saves retain the draft. Normal included usage above the 5% weekly reserve comes first. Fresh candidates precede unknown usage when switching. Recovery of normal included usage can supersede a fallback account.
- **Stay on one account** persists the chosen account, uses its remaining included allowance, and then permits credit fallback only when **Allow credits** is enabled and fresh reports support it. If the account cannot continue, routing pauses instead of switching. Priority and automatic fallback settings remain saved for a later return to Automatic.
- **Fallback** chooses Pause, Reserve, Credit fallback, Reserve then credits, or Credits then reserve. Reserve uses remaining included allowance below 5%; it never bypasses reported exhaustion. Credit fallback may also use that account’s remaining included allowance because OpenAI determines when credits are charged.
- **Allow credits** is edited in account details and can stay enabled even when the balance is zero or unknown. The overview’s **Credits allowed** label describes permission; **Credit fallback active** describes the reported routing state. Neither confirms a charge.

Action feedback remains on the relevant page and visible above scrolling content. Account-name validation uses the backend’s 60 UTF-16-unit limit; emoji can occupy multiple units. Missing usage is labeled explicitly, and credit/reset diagnostics remain available in Details.

Policy changes apply to subsequent requests; active requests finish on their captured credentials. Paused fixed routing continues to display its intended account, with last-known usage clearly marked. Usage failures alone do not block otherwise eligible included usage, and unknown startup usage remains an availability preference. These controls are not a spending cap.

Existing profiles migrate to Automatic with the selected account first and their existing reserve and credit permissions preserved. Weekly activation is never enabled by migration or mode changes. If already enabled, its background checks may activate other eligible accounts even while client traffic stays on one account.

The backend checks usage at startup and every minute, with backoff after failures. See [routing rules and CLI controls](cli.md#routing-policy). An older running backend must be restarted before the updated app can edit routing; the app displays this requirement and disables those controls.

## Automatic operation

**Keep gateway running** registers the app as a login item and monitors the backend while the app is open. It restarts a verified stopped instance with a signed-in account, at most once a minute. **Stop Gateway** pauses this behavior across app launches; **Start** or enabling automatic operation clears the pause. Disabling monitoring does not stop a running backend.

When routing needs attention, the app shows the reason and sends one notification per condition until recovery, if macOS allows notifications. Successful account switches are silent.

## Development

See [verification](verification.md) for checks. For visual inspection:

```sh
open "dist/Codex Gateway.app" --args --preview --demo
```

`--preview` opens a normal window; add `--preview-dark` to inspect that window in dark appearance without changing the system theme. `--demo` uses in-memory sample accounts. Routing and credit controls change only that preview; account, connection, and gateway operations are disabled. Quit before relaunching normally. `CODEX_GATEWAY_CLI` can select a fixture backend for UI testing.

Icon sources are `AccountGlyph.swift` and `StackGlyph.swift`. The build generates the app icon with `macos/Tools/GenerateIcon.swift` and `iconutil`; generated assets stay in `macos/.build/` and `dist/`.
