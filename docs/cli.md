# CLI contract

Invoke `node src/cli.mjs COMMAND`. No global installation is required. `CODEX_GATEWAY_HOME` selects private backing state; default `~/.local/share/codex-gateway`. Use the same selection for every command. State contains the official CLI's `codex/` directory, private `runtime.json`, and a transient `lifecycle.lock/` directory.

| Command | Options | Behavior |
|---|---|---|
| `login` | none | Interactive official CLI login; no JSON or inference |
| `start` | `--port NUMBER`, `--background`, `--json` | Start, wait for readiness, or report matching running instance |
| `status` | `--json` | Authenticate and verify selected runtime instance; no upstream call |
| `stop` | `--json` | Stop verified instance and wait for cleanup, or succeed if already stopped |
| `doctor` | `--port NUMBER`, `--json` | Aggregate local checks; no writes, inference, or expiry validation |
| `setup` | required `--model MODEL`; `--port NUMBER`, `--client-dir NEW_ABSOLUTE_DIRECTORY`, `--json` | Return TOML or explicitly create a new private client directory |
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

`doctor` includes `profile`, Node support/version, parsed CLI version and historical-baseline match, credential presence, runtime state, lifecycle lock presence, selected port availability, and `next_action`. A different CLI version is reported, not blocked: it is unverified rather than necessarily incompatible. A present or unsafe lifecycle lock makes local readiness fail and requests private-state inspection; the diagnostic never removes it. A free port check is advisory; `start` is the authoritative bind check. `doctor` does not establish that gateway/client configuration match.

`setup` validates a simple model identifier and requires an explicitly named model. Creation requires a new directory with an existing parent, rejects symlink parents and overlap with gateway state, this repository, or the current client home, and writes private configuration exclusively. It does not modify existing files. `launch` contains executable, args, env, and unset_env fields; `launch_command` is a POSIX shell equivalent. Remove inherited provider API key/base URL overrides when launching.

## Conservative recovery

Normal crash recovery is automatic, serialized, and never signals an unverified PID. A reused PID can conservatively block recovery. Legacy runtime files without identity/PID metadata and invalid files are not guessed at.

A lifecycle lock exists only during brief state mutations. Concurrent commands wait up to three seconds. If a process dies during that critical section, the lock deliberately remains. Retry status/doctor first. If the lock persists, establish that all gateway processes for this profile have stopped before removing **only the empty `lifecycle.lock` directory**. Likewise, remove corrupt/legacy `runtime.json` only after establishing no instance remains. These exceptional cases need operator/agent investigation; never remove `codex/` or read credentials into diagnostics. Do not use PID existence alone as proof that a process is a gateway.

Background mode is a detached Node process with no body/error log file and no restart supervisor. `stop` waits up to five seconds for owned state cleanup. Shutdown cancels in-flight work. Use foreground mode under an existing process supervisor if one is already available; installing a service is outside this CLI.
