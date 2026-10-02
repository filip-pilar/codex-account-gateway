# Verification

## Local checks

```sh
npm run check
swift test --package-path macos
npm run build:macos
```

Tests use disposable profiles, a fake `codex` executable, and loopback HTTP servers. They require no credentials, installed Codex, or upstream services. Rebuild the Mac app after backend changes; quit and reopen it to load the new bundle.

For an installed profile, `doctor --json` and `status --json` check local readiness. Local checks do not establish upstream access, model availability, or compatibility with every Codex CLI or Desktop version.

## Optional live smoke

Real inference consumes quota and requires explicit authorization for each bounded check. It is not needed for installation. After `status --json` reports `running`, choose a model available to the backing account:

```sh
npm run smoke:live -- --allow-inference --model MODEL
```

The script sends at most one streaming Responses request with low reasoning, no tools or retries, a 30-second deadline, and a 1 MiB read cap. It prints status metadata without response text, private reasoning, or credentials. A rejection, timeout, or incomplete stream fails the check; do not automatically retry or expand it.
