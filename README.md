# codex-gateway

Loopback HTTP gateway for Codex, authenticated through an isolated official Codex CLI profile. One backing ChatGPT account per profile.

## Requirements

- macOS or Linux; Node >=22.15; official `codex` on PATH.
- Backing account with access to the selected model and tools.
- No dependencies or build step. Run commands from the repository directory.

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

Background mode has no restart supervisor. Shutdown cancels active requests. Authentication refresh remains manual and owned by the official CLI.

## Boundary

- Routes: streaming `/v1/responses`, `/v1/alpha/search`, `/v1/images/generations`, `/v1/images/edits`.
- Original request bytes, gzip/zstd encoding, allowlisted routing headers, and returned turn state are preserved. Turn-state lifetime belongs to the client.
- Bind: `127.0.0.1` only. Host is checked; browser Origin requests are rejected. Inference routes trust local processes; control routes require a private token. Do not expose the port.
- Caller credentials and the actor eligibility marker are stripped. Only the isolated backing login authenticates upstream; the marker grants no entitlements.
- Request body/decompression cap: 16 MiB. Total request deadline: four minutes. No inference retries.
- No automatic refresh, model discovery, account rotation, OS service installation, Chat Completions, WebSockets, or remote compaction endpoint.

## Verification record

Local fixtures cover this package. Historical live tests used Codex CLI 0.149.1 and an experimental proxy: [compatibility](docs/compatibility.md), [sanitized evidence](docs/evidence.md). Other CLI versions and desktop parity are unverified. This package has not repeated the live suite.

Development rules: [AGENTS.md](AGENTS.md). Checks are local; no CI. npm publication is disabled via `private: true`. No license selected. No third-party implementation vendored. Not an official OpenAI product.
