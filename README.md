# Codex Account Gateway

**Automatically switch ChatGPT accounts for Codex CLI without changing your local endpoint.**

Keep separate account profiles behind one loopback gateway, with usage visibility and controls in the CLI or native Mac menu-bar app. Sign in to your backing accounts once. The gateway checks usage automatically and switches to another account when the current account reaches **5% weekly remaining**. Requests already running finish on their original account. If every account reaches the reserve, new requests pause until fresh usage becomes available.

**Current scope: Codex CLI and an opt-in Desktop connection.** A single existing-task turn completed through an alternate backing profile; broader desktop compatibility is unverified.

**Use gateway in Codex** in the Mac app, or `global-enable` in the CLI, connects new and existing OpenAI tasks together. Switching it off restores both settings. The gateway requests immediate HTTP fallback from WebSocket clients. See [connection setup](docs/cli.md#codex-connection) and [verification](docs/verification.md).

## Get started

```sh
git clone https://github.com/filip-pilar/codex-account-gateway.git
cd codex-account-gateway
```

| Interface | Requirements | Entry point |
|---|---|---|
| CLI gateway | macOS or Linux, Node >=22.15, official `codex` on PATH | [Setup below](#setup); no npm install or build needed |
| Mac menu-bar app | macOS 15+, the CLI requirements, Xcode Command Line Tools with Swift 6+ | `npm run build:macos`, then `open "dist/Codex Gateway.app"` |

Each backing account needs access to the chosen model and tools. The Mac app is built and signed locally; it bundles the gateway code, not Node or Codex. See [Mac setup](docs/macos.md) for the sign-in flow.

**For agents:** use this setup flow and the [JSON CLI contract](docs/cli.md). [AGENTS.md](AGENTS.md) covers repository changes and safety boundaries. Configuration lives outside the checkout; no source edits are needed to install or select accounts.

## Setup

Use `--json` and branch on `code` and `next_action`. `login` is interactive. Exit codes: `0` success, `1` unmet condition or operational failure, `2` invalid arguments. Full contract: [docs/cli.md](docs/cli.md).

1. Check prerequisites:

   ```sh
   node --version
   node src/cli.mjs doctor --json
   ```

   Default backing state: `~/.local/share/codex-gateway`. To select another profile, set `CODEX_GATEWAY_HOME` to an absolute private directory for every gateway command. Keep backing state and client state separate and outside the repository. Default port: `8787`.

2. If credentials are missing, have the user complete the official login with the intended backing account:

   ```sh
   node src/cli.mjs login
   ```

3. Start the gateway:

   ```sh
   node src/cli.mjs start --background --json
   node src/cli.mjs status --json
   ```

   Expected codes: `started` or `already_running`, then `running`. Omit `--background` for foreground operation. For another port, pass `--port NUMBER` to both `start` and `setup`; allowed range is 1024–65535.

4. Generate client configuration. Replace `MODEL` with an account-supported model and the path with a new absolute directory whose parent exists:

   ```sh
   node src/cli.mjs setup --model MODEL --client-dir /absolute/path/to/new-client --json
   ```

   Expected code: `configuration_created`. Launch the client using the returned `launch` fields or `launch_command` when requested. Existing directories are rejected. Omit `--client-dir` to return TOML without writing files. Generated settings use low reasoning and disable retries and startup update checks.

5. Verify locally:

   ```sh
   node src/cli.mjs doctor --json
   node src/cli.mjs status --json
   npm run check
   ```

   Expected codes: `local_ready`, `running`; checks exit `0`. Credential presence and local liveness do not establish upstream readiness. Real inference requires explicit authorization; see [verification](docs/verification.md).

## Accounts and usage

```sh
node src/cli.mjs accounts --json
node src/cli.mjs usage --json
node src/cli.mjs account-add --label Work --json
```

Use the returned account ID with `login --account ID`. Login is interactive; the user completes it. All signed-in profiles join the pool automatically. The gateway keeps its current account while weekly usage is above 5%, then tries the next usable account in list order, wrapping around. It does not switch back merely because an earlier account resets.

Usage checks run on startup and every minute, without inference. The threshold applies to reported usage; polling and requests already in progress can take an account below 5%. Short-window limits are not switching triggers. `account-select --account ID` remains available when idle, subject to the same reserve on subsequent requests. See [account commands](docs/cli.md#account-selection-and-usage).

## Operation

```sh
node src/cli.mjs stop --json
```

| Condition | Action |
|---|---|
| `login_required` or `upstream_login_expired` | Repeat official isolated `login` |
| `port_in_use` | Select another port; use it in both start and setup |
| `stale` | Run `start` to recover or `stop` to remove stale runtime state |
| `runtime_unavailable`, `unsafe_runtime`, `lifecycle_busy` | Follow [recovery instructions](docs/cli.md#conservative-recovery); do not signal unverified PIDs or delete backing credentials |

Enable **Settings → Keep gateway running** in the Mac app to launch at login and keep the gateway running while the app is open. CLI background mode alone has no restart supervisor. Shutdown cancels active requests. Authentication and renewal are owned by the official CLI; occasional sign-in is still required.

## Boundary

- Routes: streaming `/v1/responses`, `/v1/alpha/search`, `/v1/images/generations`, `/v1/images/edits`.
- Original request bytes, gzip/zstd encoding, allowlisted routing headers, and returned turn state are preserved. Turn-state lifetime belongs to the client.
- Bind: `127.0.0.1` only. Host is checked; browser Origin requests are rejected. Inference routes trust local processes; control routes require a private token. Do not expose the port.
- Caller credentials and the actor eligibility marker are stripped. Only the isolated backing login authenticates upstream; the marker grants no entitlements.
- Request body/decompression cap: 16 MiB. Total request deadline: four minutes. No inference retries.
- No gateway-managed credential refresh, model discovery, inference retries, Chat Completions, WebSockets, or remote compaction endpoint.

## Development and verification

```sh
npm run check         # Local fixtures; no credentials or upstream services
npm run build:macos   # Build the native app and icons on macOS
swift test --package-path macos  # Native usage and automatic-run fixtures
```

The CLI and account logic live in `src/`, SwiftUI in `macos/`, and fixtures in `test/`. Rebuild the app after backend changes because it bundles a copy of `src/`. Quit and reopen it to load a rebuilt executable.

Local fixtures cover the gateway and Mac app. The bounded desktop check and its limits are recorded in [verification](docs/verification.md). Changes in the official CLI or Desktop engine may affect compatibility.

Development rules: [AGENTS.md](AGENTS.md). Checks are local; no CI. npm publication is disabled via `private: true`. Licensed under [MIT](LICENSE). No third-party implementation vendored. Not an official OpenAI product.
