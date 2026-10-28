# Repository guidance

- Node.js 22+, ESM TypeScript. `npm ci`; `npm run typecheck`; `npm test` (builds first); `npm audit`.
- `npm pack` builds installable bin and shared chunks. Keep dist/node_modules/test homes untracked.
- All development/test filesystem writes stay in this repository. Tests inject QUILLATIO_HOME and CODEX_HOME under ignored .test-home; never touch real user agent settings.
- Capture is launch-scoped. Never add transcript directory discovery/history backfill. Only hook-provided exact session paths may be read, starting at SessionStart EOF. Project credentials are pinned in parent memory; hook children receive only local relay capabilities.
- The shared switch lock serializes upstream sends and config changes. Epoch changes on off/login/configure prevent active hooks from reviving after on. Project selection intentionally leaves epoch unchanged.
- Official integration references are linked in README. Codex native hooks plus EOF-scoped rollout appends capture full experiment audit; preserve session-flags trust map as inline TOML (dotted keys do not activate correctly). Claude hooks consume direct payload fields only.
