# Codex Account Gateway

**Automatically switch ChatGPT accounts for Codex CLI without changing your local endpoint.**

Keep separate account profiles behind one loopback gateway, with usage visibility in the CLI or native Mac menu-bar app. The gateway switches accounts when weekly remaining reaches **5%** or an included-usage window is exhausted. Active requests finish on their original account.

Optional reserve and per-account credit permissions allow continuing after other included usage is unavailable. Both default off. Delayed or missing usage reports and active requests mean they are not strict spending caps. See [routing and credits](docs/cli.md#automatic-weekly-routing).

Use an isolated Codex CLI client or connect your existing Codex configuration through **Use gateway in Codex**. See [connection setup](docs/cli.md#codex-connection); compatibility depends on the client version.

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

   Expected code: `configuration_created`. Launch the client using the returned `launch` fields or `launch_command` when requested. Existing directories are rejected. Omit `--client-dir` to return TOML without writing files. Reasoning, retries, timeouts, and update checks use the client's defaults.

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
node src/cli.mjs usage-status --json
node src/cli.mjs usage-status --refresh --json
node src/cli.mjs account-add --label Work --json
```

Use the returned account ID with `login --account ID` and complete the official login. Signed-in profiles join the pool automatically. `account-select --account ID` changes the selection when idle, subject to the routing policy. See [account commands](docs/cli.md#account-selection-and-usage) for usage fields and refresh behavior.

## Operation

```sh
node src/cli.mjs stop --json
```

| Condition | Action |
|---|---|
| `login_required` or upstream authentication failure | Repeat official isolated `login` |
| `port_in_use` | Select another port; use it in both start and setup |
| `stale` | Run `start` to recover or `stop` to remove stale runtime state |
| `runtime_unavailable`, `unsafe_runtime`, `lifecycle_busy` | Follow [recovery instructions](docs/cli.md#conservative-recovery); do not signal unverified PIDs or delete backing credentials |

Enable **Settings → Keep gateway running** in the Mac app to launch at login and keep the gateway running while the app is open. CLI background mode alone has no restart supervisor. Shutdown cancels active requests. Authentication and renewal are owned by the official CLI; occasional sign-in is still required.

## Gateway boundaries

- Chat HTTP routes: `/v1/responses`, `/v1/responses/compact`, `/v1/alpha/search`, `/v1/images/generations`, and `/v1/images/edits`. Responses WebSocket clients receive an HTTP fallback response.
- Opt-in [WebRTC v3 voice](docs/realtime.md) forwards call creation and a control WebSocket with account binding across reconnects. Audio travels directly over WebRTC; separate client overrides are required.
- Bodies stream unchanged, including compression and multipart data. Model selection, schema validation, and turn-state lifetime belong to the client and upstream.
- The gateway binds only to `127.0.0.1`, checks Host, and rejects browser Origin requests. Local inference routes trust local processes; control routes require a private token. Keep the port private.
- Caller credentials are replaced with the isolated backing login. The gateway never logs bodies, follows upstream redirects, or retries inference.
- [Transport limits](docs/cli.md#transport-limits) default to 256 MiB per request, 1 MiB headers, and a 15-minute idle timeout. Profile overrides need no source changes.

## Development and verification

```sh
npm run check         # Local fixtures; no credentials or upstream services
npm run build:macos   # Build the native app and icons on macOS
swift test --package-path macos  # Native usage and automatic-run fixtures
```

The CLI and account logic live in `src/`, SwiftUI in `macos/`, and fixtures in `test/`. Rebuild the app after backend changes because it bundles a copy of `src/`. Quit and reopen it to load a rebuilt executable.

See [verification](docs/verification.md) for local and explicitly authorized live checks, and [AGENTS.md](AGENTS.md) for development rules.

Licensed under [MIT](LICENSE). Not an official OpenAI product.
