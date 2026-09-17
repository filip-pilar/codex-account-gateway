# Verification without repeating the investigation

## Local default

Run `npm run check`. Tests use disposable private directories, a fixture `codex` executable, fake credentials, and loopback transports. They do not call the installed CLI, authenticate, or reach model services. Fixtures cover lifecycle, configuration isolation, machine output, forwarding, cancellation/deadlines, private state, account selection, and usage RPC normalization/redaction/timeouts. Checks are local only.

For an installed profile, `doctor --json` and `status --json` are local readiness checks. Credential presence is not token validity. An authenticated control response is not proof of upstream access. `doctor` does not create missing state directories.

## macOS app

Run `npm run build:macos`, then quit and reopen the built app. Verify the actual menu-bar popover, including its unsigned-in account card; a successful build or standalone preview does not establish popover layout. Use `--preview --demo` for sample usage cards without reading real accounts (see [Mac development](macos.md#development)). Authentication and usage retrieval require a separate user-completed login; fixture success is not evidence of upstream access.

## Optional authorized live smoke

Real inference requires explicit session authorization. The following is a quota-consuming experiment, not a prerequisite for installation. Choose a model available to the backing account and first establish `status --json` reports `running`.

```sh
npm run smoke:live -- --allow-inference --model MODEL
```

The script sends at most **one** streaming Responses request to the selected profile, with low reasoning, no tools, no retries, a 30-second client deadline, and a 1 MiB response read cap. It requires both text and a completion event. It outputs only success/status metadata; no response text, private reasoning, credentials, or session files are saved. The npm wrapper prints its ordinary banner; invoke `node scripts/smoke-live.mjs ...` directly if a single JSON result is required.

A rejection, timeout, or incomplete stream is a failed check. Missing completion is not zero usage. Do not automatically retry, fall back to a different model, invoke images, or expand into the historic suite. A 401 means run official isolated login again before a separately authorized retry. Other failures need diagnosis; response details are intentionally not printed. Opening an ordinary client session is not an enforced request-budget substitute for this check.

The script is locally fixture-tested; **no live smoke of this extracted package has been performed**. A successful future smoke would establish basic package connectivity only, not re-certify every historical capability.

## Existing live evidence

Use [compatibility](compatibility.md) and [evidence](evidence.md) as the baseline. The research already exercised tools, agents, compaction, search, and images. Preserve those results and their corrections; do not rerun them merely because the package moved to a new repository.
