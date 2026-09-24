# Verification

## Local checks

Run `npm run check` for credential-free gateway fixtures. They use disposable profiles, a fake `codex` executable, and synthetic loopback transports. They cover lifecycle, forwarding, cancellation, account isolation, usage parsing, and automatic switching. For the native app, run `npm run build:macos` and `swift test --package-path macos`; quit and reopen the app after rebuilding.

For an installed profile, `doctor --json` and `status --json` check local readiness. Credential presence and a running gateway do not prove upstream access.

## Desktop route evidence and limits

An authorized turn in an existing Desktop task completed through the gateway using an alternate backing profile. A temporary local trace recorded one upstream `POST /v1/responses` with that profile selected at credential injection and an HTTP 200 response. The account's reported weekly remaining changed after the turn. This verifies the selected backing credentials for that request; coarse usage percentages cannot precisely attribute a single turn's cost.

That live check encountered WebSocket retries before HTTP fallback. The gateway now returns HTTP 426 for Responses WebSocket handshakes. A localhost-only check using the bundled Codex engine (`0.155.0-alpha.16.3`), fake credentials, and a synthetic upstream reached HTTP forwarding in about 200 ms, with the backing credentials correctly substituted. This verifies transport negotiation without real inference; it does not establish compatibility across all models, tasks, or earlier conversation context. The temporary trace server was stopped after the live check; route tracing is not part of the shipped gateway.

## Optional live smoke

Real inference consumes quota and requires explicit authorization for each bounded check. It is not needed for installation. After `status --json` reports `running`, choose a model available to the backing account:

```sh
npm run smoke:live -- --allow-inference --model MODEL
```

The script sends at most one streaming Responses request with low reasoning, no tools, no retries, a 30-second deadline, and a 1 MiB read cap. It prints status metadata without response text, private reasoning, or credentials. A rejection, timeout, or incomplete stream is a failed check; do not automatically retry or expand it into a larger suite. The script is fixture-tested but has not been run against a live upstream from this package.
