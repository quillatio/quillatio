import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import TOML from '@iarna/toml';
import { CodexTranscript, describeCodexRow, type AuditEvent } from '../src/codex.js';
import { adapterArgs } from '../src/agents.js';
import { readBody, startRelay } from '../src/capture.js';
import { loadConfig, recording, updateConfig } from '../src/config.js';

let dir: string;
let servers: Server[] = [];
let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
beforeEach(async () => {
  await mkdir(resolve('.test-home'), { recursive: true }); dir = await mkdtemp(resolve('.test-home/codex-'));
  process.env.QUILLATIO_HOME = join(dir, 'quillatio'); process.env.CODEX_HOME = join(dir, 'codex');
  await mkdir(process.env.CODEX_HOME, { recursive: true });
});
afterEach(async () => {
  await relay?.close(); relay = undefined;
  for (const s of servers) await new Promise<void>(r => { s.close(() => r()); s.closeAllConnections(); }); servers = [];
  await rm(dir, { recursive: true, force: true }); delete process.env.QUILLATIO_HOME; delete process.env.CODEX_HOME;
});
const row = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-10-28T00:00:00Z', type, payload }) + '\n';
it('captures only appended bytes for resumed sessions, partial JSON and UTF-8 without rescans', async () => {
  const path = join(process.env.CODEX_HOME!, 'rollout.jsonl'); const events: AuditEvent[] = [];
  await writeFile(path, row('response_item', { type: 'message', content: 'PRIVATE OLD HISTORY' }));
  const reader = new CodexTranscript(process.env.CODEX_HOME!, async e => { events.push(e); });
  await reader.attach({ hook_event_name: 'SessionStart', session_id: 'resumed', transcript_path: path });
  const line = row('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: 'new 🐈' });
  const bytes = Buffer.from(line); const cut = bytes.indexOf(Buffer.from('🐈')) + 2;
  await appendFile(path, bytes.subarray(0, cut)); await reader.drain();
  await appendFile(path, bytes.subarray(cut)); await reader.drain(); await reader.drain();
  const text = events.map(e => e.transcript_text).join(''); expect(text).toBe(line); expect(text).not.toContain('PRIVATE');
  expect(events[0].byte_offset).toBe(Buffer.byteLength(row('response_item', { type: 'message', content: 'PRIVATE OLD HISTORY' })));
});
it('refuses unrelated paths and fails closed on truncation instead of exporting history', async () => {
  const path = join(process.env.CODEX_HOME!, 'rollout.jsonl'); await writeFile(path, 'history\n');
  const reader = new CodexTranscript(process.env.CODEX_HOME!, async () => {});
  await writeFile(join(dir, 'outside'), 'secret');
  await expect(reader.attach({ hook_event_name: 'SessionStart', session_id: 's', transcript_path: join(dir, 'outside') })).rejects.toThrow('outside');
  await reader.attach({ hook_event_name: 'SessionStart', session_id: 's', transcript_path: path });
  await writeFile(path, 'x'); await expect(reader.drain()).rejects.toThrow('truncated');
  await appendFile(path, 'new old history\n'); await reader.drain();
});
it('normalizes official plugin function/custom/shell/web calls, results and reasoning shapes', () => {
  expect(describeCodexRow({ payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"pytest"}' } })).toEqual({ name: 'exec_command', type: 'TOOL', input: { cmd: 'pytest' } });
  for (const type of ['custom_tool_call', 'local_shell_call', 'web_search_call']) expect(describeCodexRow({ payload: { type, input: 'patch', action: { command: 'ls' } } }).type).toBe('TOOL');
  expect(describeCodexRow({ payload: { type: 'function_call_output', call_id: 'c', output: 'test passed' } }).output).toBe('test passed');
  expect(describeCodexRow({ payload: { type: 'reasoning', summary: ['analysis'] } }).type).toBe('LLM');
});
it('adds native session hooks without duplicating user hooks or overriding notify and allows resume', async () => {
  const config = join(process.env.CODEX_HOME!, 'config.toml');
  const original = 'notify = ["existing-notifier"]\n[[hooks.PostToolUse]]\n[[hooks.PostToolUse.hooks]]\ntype = "command"\ncommand = "existing-hook"\n';
  await writeFile(config, original);
  const adapted = await adapterArgs('codex', ['exec', 'resume', '--last'], dir, resolve('dist/hook.js'));
  const raw = adapted.args.find(a => a.startsWith('hooks.PostToolUse='))!;
  const parsed = TOML.parse(raw) as any;
  expect(parsed.hooks.PostToolUse).toHaveLength(1);
  expect(parsed.hooks.PostToolUse[0].hooks[0].command).toContain('codex-native');
  expect(adapted.args.some(a => a.startsWith('notify='))).toBe(false);
  expect(await readFile(config, 'utf8')).toBe(original);
});
it('exports tool/model/full appended rollout audit through built native hooks; off prevents all later uploads', async () => {
  const uploads: any[] = [];
  const server = createServer(async (req, res) => { expect(req.headers.authorization).toBe('Bearer project-key'); uploads.push(JSON.parse(await readBody(req, 4 * 1024 * 1024))); res.end('{}'); }); servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address() as { port: number };
  const config = await updateConfig(() => ({ enabled: true, epoch: 'active' }));
  relay = await startRelay('codex', 'launch', config, { projectId: 'p', projectName: 'Project', laminarProjectId: 'l', laminarApiKey: 'project-key', laminarBaseUrl: `http://127.0.0.1:${address.port}` }, process.env.CODEX_HOME);
  const path = join(process.env.CODEX_HOME!, 'resumed.jsonl'); await writeFile(path, row('response_item', { type: 'message', content: 'OLD SECRET HISTORY' }));
  async function hook(event: AuditEvent) {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, ['dist/hook.js', 'codex-native'], { env: { ...process.env, QUILLATIO_RELAY_URL: relay!.url, QUILLATIO_RELAY_TOKEN: relay!.secret } });
      p.once('error', reject); p.once('exit', code => { expect(code).toBe(0); resolve(); }); p.stdin.end(JSON.stringify(event));
    });
  }
  await hook({ hook_event_name: 'SessionStart', session_id: 'resumed', transcript_path: path });
  await appendFile(path, row('response_item', { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"pytest"}' }) + row('response_item', { type: 'function_call_output', call_id: 'call-1', output: '17 tests passed' }) + row('response_item', { type: 'reasoning', summary: [{ text: 'Inspect test results' }] }) + row('event_msg', { type: 'unknown_future_event', detail: 'preserve this too' }));
  await hook({ hook_event_name: 'PostToolUse', session_id: 'resumed', turn_id: 'turn-1', tool_name: 'exec_command', tool_use_id: 'call-1', tool_input: { cmd: 'pytest' }, tool_response: '17 tests passed' });
  await hook({ hook_event_name: 'PostModelRequest', session_id: 'resumed', model: 'gpt-test', token_usage: { input_tokens: 100, output_tokens: 20 }, status: 'completed' });
  const all = JSON.stringify(uploads);
  expect(all).toContain('pytest'); expect(all).toContain('17 tests passed'); expect(all).toContain('Inspect test results'); expect(all).toContain('preserve this too'); expect(all).toContain('gen_ai.usage.input_tokens'); expect(all).not.toContain('OLD SECRET HISTORY');
  const spans = uploads.flatMap(u => u.resourceSpans[0].scopeSpans[0].spans);
  expect(spans.some(s => s.name === 'codex exec_command')).toBe(true);
  expect(new Set(spans.map(s => s.traceId)).size).toBe(1);
  await recording(false); const count = uploads.length;
  await appendFile(path, row('response_item', { type: 'function_call_output', output: 'AFTER OFF SECRET' }));
  await hook({ hook_event_name: 'PostToolUse', tool_response: 'AFTER OFF SECRET' });
  await new Promise(r => setTimeout(r, 650)); expect(uploads).toHaveLength(count);
  await recording(true); await hook({ hook_event_name: 'Stop' }); expect(uploads).toHaveLength(count);
  expect((await loadConfig()).enabled).toBe(true);
});
