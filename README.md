# Quillatio

Opt-in TypeScript CLI for forwarding coding-agent events to your project's managed Laminar instance. Requires Node.js 22+ and macOS/Linux for recording. Install Codex and/or Claude Code separately and authenticate them normally.

## Install and use

From this checkout (not yet published):

```sh
npm ci
npm run typecheck
npm test
npm pack
npm install -g ./quillatio-0.1.0.tgz
quillatio --help
```

Once published, installation is `npm install -g quillatio`.

```sh
quillatio login --server https://your-quillatio-server.example
# Paste the CLI token copied from website settings at the hidden prompt.
quillatio projects
quillatio use my-project
quillatio install codex
quillatio install claude-code
quillatio on
quillatio status
quillatio run codex -- "Explain this repository"
quillatio run claude-code -- --print "Explain this repository"
quillatio off
```

`install` enables Quillatio's bundled adapter, **not** the upstream agent executable. No upstream plugins are downloaded and no global agent configuration is written. `configure --server URL` clears login and project selection and disables active capture. `login` also starts with recording off. `use` accepts a slug or exact project ID.

For automation, provide a token through stdin, never through an argument:

```sh
quillatio login --server https://your-quillatio-server.example --token-stdin < /private/path/cli-token
```

With no `--server`, interactive login asks for the URL. Configuration is in `~/.quillatio/config.json` (directory 0700, file 0600). The CLI token is stored there; Laminar API keys are fetched at launch and held only in the parent process's memory. `QUILLATIO_HOME` overrides the private configuration location (also defines the scope of the recording switch). Do not put it in a public/shared directory.

## Capture and privacy behavior

- Only `quillatio run` launches are instrumented. Plain `codex` and `claude` launches are untouched.
- Recording defaults off. Off launches run normally without fetching credentials or adding capture hooks.
- Each recording launch pins its project, Laminar endpoint, and key. `use` affects future launches only.
- `off` applies to active Quillatio hooks too. It waits for any already-started HTTP upload to finish/timeout before reporting success; data already transmitted cannot be recalled. A generation change permanently disarms existing launches, even after `on`. Start a new launch to record again.
- No directory scans or historical backfill. Codex resume is supported: SessionStart supplies the exact rollout path; capture starts at its existing EOF. Only subsequent appends are uploaded. Claude resume/fork remains unsupported.
- Codex uses launch-only native hooks for session/prompt/tool/model/stop/subagent/compact events. Full hook payloads go to Laminar, including tool inputs/results. Existing root TOML hooks stay in their original config layer and are not duplicated; existing `notify` is left untouched. Trust hashes approve only Quillatio's added session hooks, not unrelated hooks. No global files are modified. Tested native activation on Codex 0.162.1; use a current Codex with hooks enabled.
- Codex also reads only new bytes from the exact main-session transcript given by SessionStart. UTF-8 append chunks and offsets are exported as audit spans, including unknown event types. Recognized rollout rows become additional tool/model spans, informed by the official Laminar parser (function/custom/shell/web calls, results, messages, reasoning). No old bytes are uploaded on resume. Truncation/replacement disables transcript capture rather than restarting at zero. Separate subagent transcripts are not scanned; native subagent hooks remain captured.
- Claude Code uses an ephemeral `--settings` file with `UserPromptSubmit`, `PostToolUse`, and `Stop` hooks. Captures prompts, tool inputs/results, and final responses from hook payloads, not transcript paths. Settings are additional launch settings; existing files are not rewritten. Existing agent hook policy may disable or override hooks.
- Events become OTLP/HTTP JSON spans at the server-provided Laminar base URL plus `/v1/traces`, authenticated with its project key. Spans share a Quillatio launch session ID. Events and rollout rows share one launch trace ID and are independent instantaneous spans, not a reconstructed model/tool trace tree. `quillatio.audit.event` retains the full Codex payload; native session/turn/tool IDs and launch session grouping support audit correlation. Raw transcript chunks are ordered by byte offsets.
- Prompt/tool text can contain secrets. Capture is not automatic redaction. Enable only for sessions you intend to upload. The relay secret is scoped to localhost and inherited by agent processes; this is not a sandbox against a malicious same-user agent.
- Existing third-party telemetry/plugins/notifiers are not controlled by Quillatio. `off` guarantees no new Quillatio forwarding, not that independent integrations stop sending. Remove/disable those separately if needed.
- Export is best-effort, bounded to 1 MiB per native hook event, 128 KiB per transcript polling pass, and 5 seconds per upstream request. Large transcript rows remain available in raw chunks even when structured row decoding is skipped. Failures are dropped with a generic warning, never retried. Hook failure does not intentionally block the agent. The parent launcher must stay running.
- URLs require HTTPS except loopback HTTP for local development. Auth redirects are refused. Status/error output never intentionally prints tokens, API keys, server response bodies, or captured content.

If a process is forcibly killed while holding the switch lock, recording fails closed. Stop Quillatio launchers before removing the stale `~/.quillatio/switch.lock` directory, then run `quillatio off`. Do not remove a live lock.

## Server contract

All CLI requests use `Authorization: Bearer <website CLI token>`:

- `GET /api/cli/projects` → `{projects:[{id,name,slug}]}`
- `GET /api/cli/projects/:id/credentials` → `{projectId,projectName,laminarProjectId,laminarApiKey,laminarBaseUrl}`

The credential response must match the selected project ID. Content is uploaded directly to that project's Laminar, not to the Quillatio server.

## Verified integration references

- [Codex notifications](https://developers.openai.com/codex/config-advanced/): `notify` receives a JSON argument on turn completion.
- [Claude hook reference](https://code.claude.com/docs/en/hooks) and [CLI settings flag](https://code.claude.com/docs/en/cli-reference).
- Reviewed official [Laminar Codex plugin](https://github.com/lmnr-ai/lmnr-codex-plugin) (`hooks.json`, `src/tracer.ts`, `src/emit.ts`) and [Claude plugin](https://github.com/lmnr-ai/lmnr-claude-code-plugin) (`hooks/hooks.json`, `src/tracer.ts`). These confirm `/v1/traces`, Bearer project-key auth, and Laminar span attributes. Quillatio does not run those plugins: its append-only reader uses the hook-provided path and an EOF baseline, rather than transcript discovery. Native schemas and trust hashing were also checked against [Codex hook discovery](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/hooks/src/engine/discovery.rs).

## Development and validation

```sh
npm ci
npm run typecheck
npm test
npm audit
npm pack --dry-run
```

Vitest uses private temporary homes under this checkout's ignored `.test-home/`, real local HTTP servers, real file permissions, and the built CLI/hook subprocesses. A tiny executable fixture checks subprocess argument/status propagation; it does not simulate a model or stand in for end-to-end vendor validation. No production credentials are needed. Live agent inference and acceptance/rendering by managed Laminar require your authenticated environment and have not been asserted by these local tests.
