# Agent instructions

## Installing from a repository URL

Follow the authoritative [README setup recipe](README.md#agent-setup-recipe). Do not edit source to configure a profile. No dependency installation or build is needed. Prefer `--json`, stable `code` fields, and `next_action`; the contract is in [docs/cli.md](docs/cli.md).

Keep backing state and the new client profile outside this repository and separate from each other and the user's existing Codex profile. `setup` prints configuration by default; only an explicit `--client-dir` creates a new directory and private config. Never overwrite existing client settings. Do not implicitly install/upgrade a global Codex CLI, change global configuration, or copy existing authentication/plugins.

Official `login` is the user interaction boundary. Ask the user to complete the official flow with the intended backing account. Do not capture login output or inspect credentials for diagnostics. Authentication and renewal stay owned by the official Codex CLI.

## Diagnosing and verifying

Start with `doctor --json` and `status --json`; neither spends inference quota. Use [recovery guidance](docs/cli.md#conservative-recovery) instead of deleting state or signalling unverified processes. Credential presence, local liveness, and successful upstream inference are distinct claims.

Real inference requires explicit session authorization. [docs/verification.md](docs/verification.md) provides an opt-in one-request smoke test. Do not retry or expand it automatically. Preserve the prior live investigation as evidence; this checkout has local verification, not live certification. Do not rerun the historical suite by default.

## Developing

- Keep this project independent of llm-local-gateway and temporary test harnesses.
- Preserve loopback-only binding, credential isolation, original body/header fidelity, client-owned turn-state lifetime, cancellation, deadlines, and bounded body handling.
- Never log credentials, model request/response bodies, private reasoning, or control tokens. Do not copy authentication files or private session histories into the repository.
- Keep checks local; do not add CI or GitHub Actions workflows unless explicitly requested.
- Keep machine output stable and small. Add focused local fixtures for changed behavior and run `npm run check` for runtime changes. Tests must not depend on real credentials, installed Codex, or upstream services.
- Treat review, audit, diagnosis, and planning requests as read-only unless implementation is requested.
- Use Conventional Commits and `codex/` branches when committing. Do not publish, choose a license, or alter package privacy without user direction.
