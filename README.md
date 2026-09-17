# codex-gateway

**Stay signed into one account. Use usage from multiple ChatGPT accounts.**

The intended experience is one desktop login with a choice of accounts supplying usage. The current implementation is a loopback gateway with isolated account profiles and a native Mac menu-bar interface.

Use one account at a time, inspect its remaining usage, and manually switch accounts without changing the local gateway address. Clients currently use the **Codex CLI**; Codex desktop routing and cross-account conversation continuation are unverified. Start a new conversation after switching accounts.

## Get started

```sh
git clone https://github.com/filip-pilar/codex-gateway.git
cd codex-gateway
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

Use the returned account ID with `login --account ID` and `account-select --account ID`. Login is interactive; the user completes it. Selection is refused during active requests. Usage reads reported limits through the official CLI without sending inference requests. See [account commands](docs/cli.md#account-selection-and-usage) for the full contract.

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

Background mode has no restart supervisor. Shutdown cancels active requests. Authentication and renewal are owned by the official CLI; the gateway does not refresh credentials itself.

## Boundary

- Routes: streaming `/v1/responses`, `/v1/alpha/search`, `/v1/images/generations`, `/v1/images/edits`.
- Original request bytes, gzip/zstd encoding, allowlisted routing headers, and returned turn state are preserved. Turn-state lifetime belongs to the client.
- Bind: `127.0.0.1` only. Host is checked; browser Origin requests are rejected. Inference routes trust local processes; control routes require a private token. Do not expose the port.
- Caller credentials and the actor eligibility marker are stripped. Only the isolated backing login authenticates upstream; the marker grants no entitlements.
- Request body/decompression cap: 16 MiB. Total request deadline: four minutes. No inference retries.
- No gateway-managed credential refresh, model discovery, automatic account rotation, OS service installation, Chat Completions, WebSockets, or remote compaction endpoint.

## Development and verification

```sh
npm run check         # Local fixtures; no credentials or upstream services
npm run build:macos   # Build the native app on macOS
```

The CLI and account logic live in `src/`, SwiftUI in `macos/`, and fixtures in `test/`. Rebuild the app after backend changes because it bundles a copy of `src/`. Quit and reopen it to load a rebuilt executable.

Local fixtures cover this package. Historical live tests used Codex CLI 0.149.1 and an experimental proxy: [compatibility](docs/compatibility.md), [sanitized evidence](docs/evidence.md). The usage adapter follows that CLI version’s generated protocol; authenticated usage retrieval remains unverified. Other CLI versions and desktop parity are unverified. This package has not repeated the live suite.

Development rules: [AGENTS.md](AGENTS.md). Checks are local; no CI. npm publication is disabled via `private: true`. No license selected. No third-party implementation vendored. Not an official OpenAI product.
