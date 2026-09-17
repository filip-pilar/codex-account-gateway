# Repository instructions

## Execution

- Setup: follow [README.md#setup](README.md#setup); for the Mac app, use [docs/macos.md](docs/macos.md). Do not edit source to configure a profile.
- CLI: use [docs/cli.md](docs/cli.md); parse JSON codes, not prose. Start diagnosis with `doctor --json` and `status --json`.
- Treat review, audit, diagnosis, and planning requests as read-only unless implementation is requested.
- Real inference requires explicit session authorization. Follow [docs/verification.md](docs/verification.md); do not retry or expand live checks automatically. Preserve historical evidence rather than rerunning the investigation.

## Invariants

- Keep backing state, client state, and repository separate. Do not overwrite existing client configuration, copy authentication/plugins, or implicitly install or upgrade the global Codex CLI.
- Official Codex CLI owns authentication and renewal. The user completes login. Do not capture login output as diagnostics.
- Preserve loopback binding, credential isolation, exact protocol forwarding, client-owned turn-state lifetime, cancellation, and request limits.
- Never log or commit credentials, control tokens, model request/response bodies, private reasoning, or session histories.
- Follow documented recovery; never signal an unverified PID or delete backing credentials to repair runtime state.
- Keep this project independent of llm-local-gateway and temporary harnesses.

## Changes

- Keep the implementation small and the machine contract stable. Runtime code is in `src/`, SwiftUI in `macos/`, and fixtures in `test/`.
- Add focused local fixtures for behavior changes. Run `npm run check` for runtime changes. Tests must not require real credentials, installed Codex, or upstream services.
- For Mac app changes, run `npm run build:macos`; for native behavior changes, also run `swift test --package-path macos`. The app bundles the backend: rebuild after `src/` changes, and quit/reopen before checking the UI. Keep generated `dist/` and `macos/.build/` out of git.
- Do not add CI or GitHub Actions unless explicitly requested.
- Use Conventional Commits and `codex/` branches. Publish, select a license, or change package privacy only when requested.
