# codex-gateway

A small, dependency-free CLI that gives Codex an isolated ChatGPT backing account through a loopback gateway. Give your agent this repository and ask it to follow the setup recipe below.

The underlying compatibility approach has extensive live CLI evidence, including tools, subagents, compaction, web search, and native image generation/editing. This extracted package is verified with local fixtures; it has not yet had its own live smoke test. See [compatibility](docs/compatibility.md). This is not an official OpenAI product or a general OpenAI API replacement.

## Agent setup recipe

Run commands from the cloned repository. No `npm install`, build, global executable link, or source edits are needed. macOS and Linux are the intended platforms.

1. **Check prerequisites and select a profile.** Node >=22.15 is required for native zstd. The official `codex` CLI must be on PATH. Historical live evidence used **0.149.1**; other CLI versions are not verified. Do not install or upgrade a global CLI implicitly.

   ```sh
   node --version
   node src/cli.mjs doctor --json
   ```

   The default private profile is `~/.local/share/codex-gateway`. For a different backing account, set `CODEX_GATEWAY_HOME` to a separate absolute private directory on every gateway command. Keep it outside this repository and separate from all client profiles. One backing account per profile; no account rotation.

   `doctor` returns all local checks and a `next_action`. Missing credentials on first setup are expected. No upstream request occurs. The default port is 8787; if occupied, select a free port >=1024 and pass the same `--port` to `start` and `setup`. A bind conflict is reported safely; choose another port and retry.

2. **Authenticate the backing account through the official CLI.** This is the user interaction step: ask the user to complete the official login and select the intended backing account.

   ```sh
   node src/cli.mjs login
   ```

   Login uses the gateway's private `CODEX_HOME` and file credential store. Never copy another profile's authentication files. Do not capture login output as diagnostics. On `login_required` or upstream `upstream_login_expired`, run this command again; automatic refresh is not implemented.

3. **Start and confirm local readiness.** Background mode waits for the child to bind and publish its instance state before reporting success.

   ```sh
   node src/cli.mjs start --background --json
   node src/cli.mjs status --json
   ```

   Expect `started` or `already_running`, then `running`. Without `--background`, the process runs in the foreground until Ctrl-C or `stop`. Background mode survives the launching shell but is not an OS service: it does not restart after reboot or failure.

4. **Create a separate client profile.** Choose a model available to the backing account and a **new absolute directory** whose parent exists. Replace the placeholders below; do not use the gateway state directory or an existing client profile.

   ```sh
   node src/cli.mjs setup --model MODEL --client-dir /absolute/path/to/new-client --json
   ```

   Expect `configuration_created`. The result includes the configuration path and a shell-quoted `launch_command`, plus structured executable/environment fields. Run that command to open the isolated client when requested. Existing plugins/settings are not copied. Configuration selects low reasoning, disables client retries, and disables startup update checks. Without `--client-dir`, `setup` only returns the TOML for review.

5. **Verify locally and report the boundary.**

   ```sh
   node src/cli.mjs doctor --json
   node src/cli.mjs status --json
   npm run check
   ```

   `local_ready` means prerequisites, credential presence, runtime condition, and port checks passed. `running` means this profile's authenticated control endpoint answered. Neither proves token validity, account entitlement, or successful upstream inference. Report “locally ready; upstream not checked.”

6. **Only with explicit authorization, perform one live smoke request.** See [verification](docs/verification.md). Setup does not require spending quota, and the historical suite should not be rerun by default.

To stop the selected profile:

```sh
node src/cli.mjs stop --json
```

## CLI contract and recovery

See [CLI reference](docs/cli.md) for options, JSON fields, exit codes, and safe recovery. Agents should use `--json`, stable `code` fields, and structured launch data rather than parse prose or read private runtime files. `login` is intentionally interactive.

Ordinary process crashes leave state that `start` safely reclaims once the recorded PID is absent; `stop` can also remove that stale state. An unverifiable live PID, corrupt/legacy state, or interrupted lifecycle mutation fails closed with a recovery action. Never kill an arbitrary PID or delete the backing `codex` directory to repair runtime state.

## Protocol and privacy

Supported routes: streaming `POST /v1/responses`, `POST /v1/alpha/search`, and native `POST /v1/images/generations` and `/v1/images/edits`. Original request bytes (including gzip/zstd), allowlisted routing headers, and upstream turn state are preserved. The CLI owns turn-state lifetime. The gateway does not retry inference.

The server binds only to `127.0.0.1`, validates Host, and rejects browser Origin requests. Caller credentials and the actor-authorization eligibility marker are stripped; upstream authentication comes only from the isolated official CLI login. The marker exposes native tooling in the tested CLI; it grants no account entitlements.

Inference routes trust local processes; they have no client API key. Do not tunnel or expose the port. Control routes separately require a private random token. Credentials, model bodies, responses, and private reasoning are never logged. Private files use restrictive permissions and reject symlink paths. Requests have a 16 MiB compressed/decompressed body cap and a four-minute total deadline. Shutdown aborts active upstream work; it is not a graceful inference drain.

Chat Completions, WebSockets, remote compaction endpoints, desktop parity, automatic token refresh, model discovery, account switching, and OS service installation are outside scope. Historical **local** CLI compaction is verified.

## Development and release

Read [AGENTS.md](AGENTS.md), use local fixtures, and run `npm run check`. Checks run locally; there are no GitHub Actions workflows. See [sanitized investigation evidence](docs/evidence.md) for methods, corrections, and limitations.

`package.json` remains private to prevent accidental npm publication. No license has been selected; no third-party implementation is vendored.
