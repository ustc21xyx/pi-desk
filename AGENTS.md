# Pi Desk

Desktop client for the user's existing local Pi installation. Read `../docs/pi-gui-research.md` and `../docs/pi.md` for background.

- Electron + React + TypeScript. Pi runs as a separate process over the official JSONL RPC protocol. Do not bundle another Pi kernel or copy authentication/configuration into the application.
- Discover the installation on each Mac; never hardcode the author's home directory, model/provider, credentials, or project paths.
- Keep renderer privileges behind typed, validated IPC. Do not render untrusted HTML or load remote scripts.
- Pi owns session persistence. Historical browsing must not spawn Pi or rewrite sessions. Keep application metadata separate.
- Session ownership and project trust are explicit. Never silently trust all projects or auto-replay a prompt after a disconnect.
- Preserve local extensions. App-specific compatibility lives in `resources/desk-bridge.mjs`, loaded only by Pi Desk. Do not edit globally installed packages as a workaround.
- Do not perform browser interaction, manual functional, or acceptance testing unless the user explicitly requests it. Build/compilation and packaging checks are allowed; the user performs acceptance.
- No automatic model requests on application launch. A user action starts an agent; sending a prompt is explicit. Once explicitly enabled, the separate naming model may summarize user excerpts after a newly completed turn. Historical batch naming requires a user action. Store names in app metadata; do not rewrite Pi JSONL.

Commands: `npm run dev`, `npm run build`, `npm run pack:mac`, `npm run dist:mac`.

- Source control: maintain changes in this repository, commit completed work, and push to `origin/main` when the user requests publishing. Do not force-push. The user can install pushed changes with `npm run update` or `更新 Pi Desk.command`.
- This repository is public. Never commit credentials, real provider configuration, local Pi data, session excerpts, or sensitive logs. Enable `.githooks` with `git config core.hooksPath .githooks` before pushing; Gitleaks must pass for all Git history. Never bypass the hook. A clean scanner result does not replace reviewing the files being published.

- Desktop releases: bump package and lock versions, update CHANGELOG, commit/push main, then run `npm run release:mac` when publication is authorized. It builds both Mac architectures and validates GitHub asset digests before making the release public. Do not overwrite a published tag. Normal users update in Settings; Git update remains a developer fallback.
