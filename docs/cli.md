# CLI contract

Invoke `node src/cli.mjs COMMAND`. No global installation is required. `CODEX_GATEWAY_HOME` selects private backing state; default `~/.local/share/codex-gateway`. Use the same selection for every command. State contains the official CLI's `codex/` directory, private `runtime.json`, and a transient `lifecycle.lock/` directory.

| Command | Options | Behavior |
|---|---|---|
| `login` | `--account ID` | Interactive official CLI login; no JSON or inference |
| `start` | `--port NUMBER`, `--background`, `--json` | Start, wait for readiness, or report matching running instance |
| `status` | `--json` | Authenticate and verify selected runtime instance; no upstream call |
| `stop` | `--json` | Stop verified instance and wait for cleanup, or succeed if already stopped |
| `doctor` | `--port NUMBER`, `--json` | Aggregate local checks; no writes, inference, or expiry validation |
| `setup` | required `--model MODEL`; `--port NUMBER`, `--client-dir NEW_ABSOLUTE_DIRECTORY`, `--json` | Return TOML or explicitly create a new private client directory |
| `accounts` | none | List labels, selected profile, and local credential presence; no upstream call |
| `account-add` | required `--label NAME` | Create a private unsigned-in account with a random ID |
| `account-rename` | required `--account ID`, `--label NAME` | Rename a profile without changing credentials or selection |
| `global-status` | none | Inspect the Codex gateway connection |
| `global-enable` | optional `--port NUMBER` | Connect new and existing OpenAI tasks to the gateway |
| `global-disable` | none | Restore both connection settings |
| `account-select` | required `--account ID` | Select an authenticated profile; refuse switching during active requests |
| `openai-route-status` | none | Compatibility alias for `global-status` |
| `openai-route-enable` | optional `--port NUMBER` | Compatibility alias for `global-enable` |
| `openai-route-disable` | none | Compatibility alias for `global-disable` |
| `usage` | `--account ID` | Read usage through official CLI app-server; no inference |
| `help` | `--json` | Usage |

Ports default to 8787 and must be 1024–65535. Unknown/duplicate options are errors. `start` without an explicit port accepts an existing instance's port; an explicit conflicting port returns `already_running_other_port`. `setup` defaults to 8787 independently: use the running instance's port when it differs. `doctor` checks the recorded port unless overridden.

## JSON and exits

With `--json`, stdout contains one JSON object followed by a newline. Foreground start emits its readiness object once and continues running. Errors also use JSON stdout; diagnostic stderr is separate. No credentials, control tokens, routing tokens, or upstream bodies are included. `login` rejects `--json`; official CLI interaction is inherited directly.

Every object has `schema_version: 1`, `command`, `ok`, and `code`. Fields such as `next_action`, `message`, and command-specific data are additive; ignore unknown fields. Branch on `code`, never `message`. Schema version changes are required for incompatible contracts.

Exit 0: requested operation succeeded. Exit 1: operational failure or unmet readiness condition (`status` includes stopped/stale). Exit 2: invalid arguments. A foreground process remains alive after readiness until stopped. Readiness is not a promise of future availability.

| Codes | Agent action |
|---|---|
| `started`, `already_running`, `running` | Use returned `url`, `port`, and `pid`; `pid` is diagnostic, not permission to signal it |
| `stopped`, `already_stopped`, `stale_state_removed` | Stop complete; safe to repeat |
| `stale` | Run `start` to recover or `stop` to remove dead-instance state |
| `unavailable`, `runtime_unavailable` | Recorded PID exists but instance cannot be verified; do not kill or reclaim it |
| `login_required` | Complete isolated official `login` |
| `cli_unavailable`, `login_failed` | Resolve official CLI availability/login; do not upgrade implicitly |
| `port_in_use` | Choose another port and use it in both start/setup |
| `already_running_other_port` | Use existing port or explicitly stop first |
| `local_ready`, `local_not_ready` | Inspect doctor checks; upstream is always `not_checked` |
| `configuration`, `configuration_created` | Use `config` or created `config_path` and structured `launch` |
| `client_directory_exists`, `unsafe_client_directory` | Choose a new isolated directory; never overwrite |
| `unsafe_runtime`, `lifecycle_busy` | Follow conservative recovery below |
| `start_timeout`, `start_failed`, `stop_timeout` | Inspect status/doctor before retrying |
| `invalid_arguments` | Correct invocation using this reference |
| `permission_denied`, `path_missing`, `operation_failed` | Inspect local paths/permissions; do not dump private files |
| `openai_route_conflict` | Inspect the user-level config; an existing override or changed managed block was left untouched |

`doctor` includes `profile`, Node support/version, parsed CLI version and historical-baseline match, credential presence, runtime state, lifecycle lock presence, selected port availability, and `next_action`. A different CLI version is reported, not blocked: it is unverified rather than necessarily incompatible. A present or unsafe lifecycle lock makes local readiness fail and requests private-state inspection; the diagnostic never removes it. A free port check is advisory; `start` is the authoritative bind check. `doctor` does not establish that gateway/client configuration match.

`setup` validates a simple model identifier and requires an explicitly named model. Creation requires a new directory with an existing parent, rejects symlink parents and overlap with gateway state, this repository, or the current client home, and writes private configuration exclusively. It does not modify existing files. `launch` contains executable, args, env, and unset_env fields; `launch_command` is a POSIX shell equivalent. Remove inherited provider API key/base URL overrides when launching.

## Codex connection

**Settings → Use gateway in Codex** and `global-enable` control the same connection. Enabling updates both the default provider for new tasks and the built-in `openai` endpoint used by existing OpenAI tasks. Disabling removes both managed routes and restores the prior default provider. Restart Codex to load either change. Tasks saved with unrelated custom providers are unaffected; tasks saved with `codex-gateway` require its provider definition while using the gateway.

Both settings are validated and written atomically in `~/.codex/config.toml`. Edited markers and unmanaged overrides are refused; authentication, `chatgpt_base_url`, models, and task histories are untouched. Use the running gateway's port from `status --json`; the default is 8787. `global-status` returns `enabled: true` when either managed route exists and `needs_update: true` when they are incomplete or inconsistent. Enable again to repair them, or disable to remove both. The Mac app shows **Update Connection** when needed.

The older `openai-route-*` commands are aliases for these same operations, retaining their JSON response codes and `route` field. They no longer toggle a separate setting.

The gateway serves HTTP streaming. WebSocket handshakes receive HTTP 426 so compatible Codex engines switch to HTTP immediately. See [verification](verification.md) for tested scope.

## Conservative recovery

Normal crash recovery is automatic, serialized, and never signals an unverified PID. A reused PID can conservatively block recovery. Legacy runtime files without identity/PID metadata and invalid files are not guessed at.

A lifecycle lock exists only during brief state mutations. Concurrent commands wait up to three seconds. If a process dies during that critical section, the lock deliberately remains. Retry status/doctor first. If the lock persists, establish that all gateway processes for this profile have stopped before removing **only the empty `lifecycle.lock` directory**. Likewise, remove corrupt/legacy `runtime.json` only after establishing no instance remains. These exceptional cases need operator/agent investigation; never remove `codex/` or read credentials into diagnostics. Do not use PID existence alone as proof that a process is a gateway.

Background mode is a detached Node process with no body/error log file and no restart supervisor. `stop` waits up to five seconds for owned state cleanup. Shutdown cancels in-flight work. Use foreground mode under an existing process supervisor if one is already available; installing a service is outside this CLI.

## Account selection and usage

`default` refers to the existing root profile. Added accounts use random IDs returned by `account-add` and `accounts`. `login` and `usage` default to the selected account. `start` and `doctor` accept any signed-in account in the pool. An expired login must be renewed through official login.

```sh
node src/cli.mjs account-add --label Work --json
node src/cli.mjs login --account RETURNED_ID
node src/cli.mjs account-select --account RETURNED_ID --json
node src/cli.mjs usage --account RETURNED_ID --json
```

New success codes: `accounts`, `account_added`, `account_selected`, `usage`. New failure codes: `invalid_account`, `gateway_busy`, `account_switch_failed`, `usage_unavailable`, `usage_timeout`. `login_required` and `cli_unavailable` retain their meaning. Switching a running gateway uses its authenticated control endpoint and preserves the address. It returns `gateway_busy` while a request or selection is in progress; there is no queued switch or automatic retry. New inference requests during the brief selection mutation receive HTTP 503 / `account_switch_in_progress`.

`usage` returns `account`, `checked_at` (ISO timestamp), and `buckets`. Each bucket has `id`, `primary`, and `secondary`; each available window has `remaining_percent`, nullable `window_minutes`, and nullable `resets_at` (Unix seconds). Missing windows are null. Upstream messages, credentials, credits, and unrelated protocol notifications are never printed. Each read has a 15-second deadline and 1 MiB output cap. The official CLI owns authentication and renewal.

Selection is stored privately in `selected-account.json`. Added profile metadata and official CLI state live under `accounts/<id>/`. Selection writes are atomic and serialized through the gateway lifecycle lock. No existing authentication is moved or copied. See [macOS UI](macos.md).

## Automatic weekly routing

Every running gateway checks all signed-in accounts at startup and every 60 seconds after the preceding check finishes, with at most three usage CLI children at once. The selected account stays selected while its reported weekly remaining is greater than 5%. At or below 5%, the next usable account in `accounts` list order is selected, wrapping around. Selection persists across restarts. Other limit windows are not switching triggers.

Only a reported seven-day window from the `codex` bucket (or the sole reported bucket) qualifies. Missing/ambiguous data is unavailable. A transient read failure may use the last successful snapshot for less than five minutes, but never after its reported reset time. A new check must confirm replenished quota; wall-clock time alone does not create quota. Requests already in progress retain their captured credentials and finish normally. No bodies, encrypted reasoning, or client turn-state headers are rewritten; there is no turn tracking or inference replay. The 5% threshold is approximate because reads are periodic and active requests can continue consuming usage.

`status --json` retains its existing runtime codes and adds `routing`:

```json
{"mode":"automatic","weekly_reserve_percent":5,"state":"ready","account":"default"}
```

Routing states are `checking_usage`, `ready`, `weekly_reserve_reached`, `usage_unavailable`, and `login_required`. A runtime can be `running` while routing is paused. Exhausted accounts return HTTP 503 / `weekly_reserve_reached` without contacting upstream. Missing fresh usage returns HTTP 503 / `usage_unavailable`; missing credentials retains HTTP 401 / `isolated_login_required`. Background checks resume routing when an account becomes usable. Manual selection does not bypass the reserve.

Shutdown aborts usage reads and terminates their owned CLI children. Usage snapshots are memory-only. The Mac app's opt-in login item and restart monitoring are described in [automatic operation](macos.md#automatic-operation); the CLI does not install a service.
