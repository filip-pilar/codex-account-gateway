# WebRTC v3 voice

The gateway supports engine-created Codex WebRTC v3 calls. It forwards call setup to ChatGPT and joins the resulting call through OpenAI's control WebSocket. Audio travels directly between the client and upstream over WebRTC. Chat continues to use its existing HTTP routes and Responses WebSocket fallback.

## Client configuration

Both overrides must be **root TOML keys**, before any table headings. Keep any existing managed built-in OpenAI route block at the very start of the file and put the voice keys immediately after it. For a gateway listening on port 18887:

```toml
experimental_realtime_webrtc_call_base_url = "http://127.0.0.1:18887/backend-api/codex"
experimental_realtime_ws_base_url = "ws://127.0.0.1:18887/v1"
```

The `/backend-api/codex` suffix makes Codex generate the ChatGPT JSON call request. Its ordinary `/v1` provider URL generates a public API multipart request to `/v1/live`, which this gateway deliberately does not translate. The WebSocket override is separate: Codex otherwise joins directly through OpenAI with the client's original credentials.

`setup --model MODEL --port 18887 --realtime --json` returns a complete configuration with both keys without writing files. Adding `--client-dir NEW_ABSOLUTE_DIRECTORY` creates only a new isolated client directory. Without `--realtime`, setup output is unchanged. `global-enable` and the Mac app's connection setting do not add voice overrides.

These overrides route an already enabled engine-created v3 WebRTC feature; they do not enable voice, select its protocol, or change the chat model. The compatibility target is Codex 0.160.0's engine-created v3 path, with `gpt-live-1-codex` and `openai-alpha: quicksilver=v2`. Availability still depends on the Desktop/engine version, feature rollout, backing account and upstream.

## Forwarding and lifetime

- `POST /backend-api/codex/realtime/calls` forwards unchanged bytes and query parameters to `https://chatgpt.com/backend-api/codex/realtime/calls`. Codex supplies `intent=quicksilver&architecture=avas`. The gateway requires the v3 alpha header, preserves SDP bytes, and forwards a successful `Location` only after validating its call ID. Missing, malformed or duplicate IDs fail with `502 / invalid_realtime_location`; error/redirect Locations and cookies are never forwarded.
- `GET /v1/live/CALL_ID` upgrades to a control tunnel at `wss://api.openai.com/v1/live/CALL_ID`, preserving query parameters. Only locally created call IDs can join; arbitrary upstream calls cannot be attached. IDs support bounded ASCII `rtc_` identifiers and UUIDs.
- Both paths forward `openai-alpha`, `x-session-id`, `session-id`, `thread-id`, `originator`, `user-agent`, `x-codex-turn-metadata`, `x-oai-attestation` and the OpenAI safety/organization/project headers when provided. Caller authorization/account headers are replaced with the backing identity; cookies are excluded. The gateway cannot generate attestation or grant entitlement.
- Each successful call retains its original token/account pair **in memory only**. Reconnects reuse it without invoking routing or reading another profile. Chat and later calls may use a different account. One control connection or pending handshake per call is allowed (`409 / realtime_call_busy`). Active setup/control operations count toward `active_requests` and block manual selection.
- Control frames, fragments, masking, ping/pong and close frames relay unchanged with backpressure. No messages are parsed, logged, saved or replayed. Handshake acceptance and selected subprotocol are validated. WebSocket extensions/compression are rejected; the target client does not request them.
- Normal disconnects release sockets and permit client-owned reconnects. Canceled uploads or incomplete SDP delivery remove their pending binding. Upstream control `401`, `403`, `404` or `410` removes the binding; transient failures remain available for a client retry. The gateway never retries or follows redirects.
- The registry allows 64 pending/retained calls and expires each binding one hour after creation, including an active control connection. Capacity rejection is `429 / realtime_capacity`. Shutdown cancels all setup/handshake/control operations, removes bindings and clears expiry timers. Ended calls remain in memory until expiry so reconnects are possible; there is no persisted call state.

The existing profile limits apply to setup and upgrade headers. The request byte cap applies to call uploads and separately to cumulative client-to-upstream control wire bytes per connection. Early control bytes staged while the upstream handshake is pending have an additional 64 KiB cap. Idle progress in either direction refreshes the control deadline; expiry of an established tunnel closes both sockets. These limits cover signaling/control, not WebRTC media.

## Remaining limitations

- The Desktop path that creates its own call through `/wham/realtime/calls` and then attaches an existing call is outside this scope. Provider overrides cannot reliably route that path. Standalone audio WebSockets, v1/v2, public `gpt-realtime` API sessions, transcription and SIP are also unsupported.
- Session bindings are local to one gateway process and use the captured token. They cannot survive gateway restart, migrate accounts or pick up renewed credentials. If the token expires or a binding is lost/expired, end the client call and start a new one after official authentication renewal if needed.
- The client owns peer-connection teardown and upstream call termination. Closing a control tunnel does not itself hang up WebRTC media. The gateway sends no additional hangup request and cannot clean up a call whose setup was accepted upstream but whose client disconnected before receiving the answer; upstream/client call lifetime rules still apply.
- Local fixtures establish the forwarding and cleanup contract. They do not establish current upstream entitlement, attestation acceptance, Desktop configuration loading, ICE connectivity or successful audio. Live verification requires a separately authorized, bounded attempt.

## Activation and rollback

Use a separate CLI instance for the first activation so the installed Gateway app and current chat service can continue running. Do this only after explicit authorization for deployment, configuration changes and any live verification. Run commands from the reviewed checkout; choose a new backing directory and a free port. Do not copy authentication from another profile.

```sh
VOICE_STATE="$HOME/.local/share/codex-gateway-voice-v3"
VOICE_PORT=18887
test ! -e "$VOICE_STATE" && test ! -L "$VOICE_STATE"
env CODEX_GATEWAY_HOME="$VOICE_STATE" node src/cli.mjs doctor --port "$VOICE_PORT" --json
env CODEX_GATEWAY_HOME="$VOICE_STATE" node src/cli.mjs status --json
```

Stop if the directory already exists. Initial doctor/status may report missing login or a stopped instance; confirm port availability and CLI readiness from their JSON. The user then completes a new official login:

```sh
env CODEX_GATEWAY_HOME="$VOICE_STATE" node src/cli.mjs login
env CODEX_GATEWAY_HOME="$VOICE_STATE" node src/cli.mjs start --port "$VOICE_PORT" --background --json
env CODEX_GATEWAY_HOME="$VOICE_STATE" node src/cli.mjs status --json
env CODEX_GATEWAY_HOME="$VOICE_STATE" node src/cli.mjs setup --model MODEL --port "$VOICE_PORT" --realtime --json
```

Require `started` and `running`. The Mac app does not supervise this separate CLI instance. Record any existing values of the two voice keys and save a private backup of the client's config. Add/update **only those two root keys** in the client configuration actually used by Codex (normally `~/.codex/config.toml`), using the returned URLs. Preserve existing chat providers, routes, authentication and all other settings. Do not copy the complete setup output into an existing config. Restart Codex only during the authorized activation window so it loads the overrides. Do not install or open the separately built app for this trial.

Live verification is a distinct step: authorize one bounded voice attempt with an explicit duration before starting it. Check that call setup and control join use the separate loopback endpoint; end the call through the client. Do not automatically retry on failure or include SDP, tokens, private events or conversation content in diagnostics.

For rollback, end any voice call in the client, restore the two prior voice-key values (or remove only those keys if previously absent), and restart Codex during the authorized window. Then stop **only the separately created instance**, using the same state directory:

```sh
env CODEX_GATEWAY_HOME="$VOICE_STATE" node src/cli.mjs status --json
env CODEX_GATEWAY_HOME="$VOICE_STATE" node src/cli.mjs stop --json
```

Require verified `running` before stopping and `stopped` afterward. If identity cannot be verified, follow [conservative recovery](cli.md#conservative-recovery); do not signal a PID or delete credentials. The original chat gateway and installed app need no rollback for this separate-instance procedure. Leave the new private backing profile intact unless its deletion is separately requested.

## Protocol references

The contract is based on the primary Codex sources pinned to `rust-v0.160.0`: [call creation and Location extraction](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-api/src/endpoint/realtime_call.rs), [control URL and handshake](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs), and [experimental configuration keys](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/config/src/config_toml.rs). No third-party runtime dependency is required.
