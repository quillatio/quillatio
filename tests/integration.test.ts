import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, updateConfig, recording, safeUrl } from '../src/config.js';
import { projects, credentials, type Credentials } from '../src/api.js';
import { readBody, startRelay } from '../src/capture.js';
import { adapterArgs, installAgent } from '../src/agents.js';

const root = resolve('.test-home');
let dir: string;
const servers: Server[] = [];
const relays: Awaited<ReturnType<typeof startRelay>>[] = [];
async function http(handler: RequestListener) {
  const s = createServer(handler); servers.push(s);
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const addr = s.address(); if (!addr || typeof addr === 'string') throw new Error();
  return `http://127.0.0.1:${addr.port}`;
}
function cli(args: string[], input = '', extra: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/cli.js', ...args], { env: { ...process.env, ...extra }, stdio: 'pipe' });
    let stdout = '', stderr = '';
    p.stdout.on('data', x => stdout += x); p.stderr.on('data', x => stderr += x);
    p.once('error', reject); p.once('close', code => resolve({ code, stdout, stderr })); p.stdin.end(input);
  });
}
async function setup() {
  return updateConfig(() => ({ enabled: true, epoch: 'initial', server: 'https://quillatio.example', token: 'user-secret', project: { id: 'p1', slug: 'alpha', name: 'Alpha' } }));
}
async function relay(base: string, agent = 'codex') {
  const config = await loadConfig();
  const creds: Credentials = { projectId: 'p1', projectName: 'Alpha', laminarProjectId: 'l1', laminarApiKey: 'laminar-secret', laminarBaseUrl: base };
  const r = await startRelay(agent, 'fixed-session', config, creds); relays.push(r); return r;
}
async function post(r: Awaited<ReturnType<typeof relay>>, event: unknown, token = r.secret) {
  return fetch(r.url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(event) });
}
const turn = { type: 'agent-turn-complete', 'thread-id': 'thread', 'input-messages': ['hello'], 'last-assistant-message': 'world' };
beforeEach(async () => {
  await mkdir(root, { recursive: true }); dir = await mkdtemp(join(root, 'test-'));
  process.env.QUILLATIO_HOME = dir; process.env.CODEX_HOME = join(dir, 'codex');
});
afterEach(async () => {
  for (const r of relays.splice(0)) await r.close();
  for (const s of servers.splice(0)) await new Promise<void>(r => { s.close(() => r()); s.closeAllConnections(); });
  await rm(dir, { recursive: true, force: true }); delete process.env.QUILLATIO_HOME; delete process.env.CODEX_HOME;
});

describe('real filesystem configuration', () => {
  it('defaults off and persists token privately without exposing it in status', async () => {
    expect((await loadConfig()).enabled).toBe(false); await setup();
    expect((await stat(join(dir, 'config.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const status = await cli(['status']); expect(status.code).toBe(0); expect(status.stdout).toContain('Recording: on'); expect(status.stdout).not.toContain('user-secret');
  });
  it('fails closed on corrupt configuration', async () => {
    await writeFile(join(dir, 'config.json'), '{'); await expect(loadConfig()).rejects.toThrow('disabled');
  });
  it('serializes simultaneous updates', async () => {
    await setup(); await Promise.all([recording(false), updateConfig(c => ({ ...c, project: { id: 'p2', slug: 'beta', name: 'Beta' } }))]);
    const c = await loadConfig(); expect(c.enabled).toBe(false); expect(c.project?.id).toBe('p2');
  });
  it('rejects insecure remote URLs and embedded credentials', () => {
    for (const url of ['http://example.com', 'https://secret@host', 'https://host/?token=x', 'file:///tmp/a']) expect(() => safeUrl(url)).toThrow();
    expect(safeUrl('http://127.0.0.1:1234/')).toBe('http://127.0.0.1:1234');
  });
});

describe('server contract and CLI workflow', () => {
  it('logs in via stdin, lists/selects projects, toggles and configures a server', async () => {
    const calls: string[] = [];
    const base = await http(async (req, res) => {
      expect(req.headers.authorization).toBe('Bearer website-token'); calls.push(req.url!);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url!.endsWith('credentials') ? { projectId: 'p1', projectName: 'Alpha', laminarProjectId: 'l1', laminarApiKey: 'laminar-secret', laminarBaseUrl: 'https://api.lmnr.ai' } : { projects: [{ id: 'p1', name: 'Alpha', slug: 'alpha' }] }));
    });
    const login = await cli(['login', '--server', base, '--token-stdin'], 'website-token\n');
    expect(login.code).toBe(0); expect(login.stdout + login.stderr).not.toContain('website-token');
    expect((await cli(['projects'])).stdout).toContain('alpha');
    expect((await cli(['use', 'alpha'])).code).toBe(0);
    expect((await credentials(await loadConfig())).laminarProjectId).toBe('l1');
    expect((await cli(['install', 'codex'])).code).toBe(0);
    expect((await cli(['install', 'claude-code'])).code).toBe(0);
    expect((await cli(['on'])).code).toBe(0); const epoch = (await loadConfig()).epoch;
    await cli(['on']); expect((await loadConfig()).epoch).toBe(epoch);
    expect((await cli(['off'])).code).toBe(0); expect((await loadConfig()).enabled).toBe(false);
    expect((await cli(['configure', '--server', base])).code).toBe(0); expect((await loadConfig()).token).toBeUndefined();
    expect(calls).toContain('/api/cli/projects/p1/credentials');
  });
  it('does not follow credential redirects or print server error bodies', async () => {
    const base = await http((_req, res) => res.writeHead(401).end('server-secret'));
    const result = await cli(['login', '--server', base, '--token-stdin'], 'website-token');
    expect(result.code).toBe(1); expect(result.stderr).toContain('401'); expect(result.stderr).not.toContain('secret');
    const redirect = await http((_req, res) => res.writeHead(302, { Location: base }).end());
    await expect(projects({ server: redirect, token: 'x', enabled: false, epoch: '' })).rejects.toThrow('Cannot reach');
  });
  it('validates project identity and response shape', async () => {
    const base = await http((_req, res) => res.end(JSON.stringify({ projectId: 'wrong' })));
    await setup(); await expect(credentials({ ...await loadConfig(), server: base })).rejects.toThrow('Invalid project');
  });
});

describe('live local relay and hook executable', () => {
  it('exports real OTLP JSON and pins the destination across project switches', async () => {
    const uploads: { path: string; auth: string; body: any }[] = [];
    const base = await http(async (req, res) => { uploads.push({ path: req.url!, auth: req.headers.authorization!, body: JSON.parse(await readBody(req)) }); res.end('{}'); });
    await setup(); const r = await relay(base);
    expect((await post(r, turn, 'wrong')).status).toBe(403);
    await updateConfig(c => ({ ...c, project: { id: 'p2', name: 'Beta', slug: 'beta' } }));
    expect((await post(r, turn)).status).toBe(204);
    expect(uploads).toHaveLength(1); expect(uploads[0].path).toBe('/v1/traces'); expect(uploads[0].auth).toBe('Bearer laminar-secret');
    const span = uploads[0].body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toMatch(/^[a-f0-9]{32}$/); expect(span.attributes).toContainEqual({ key: 'lmnr.span.input', value: { stringValue: '["hello"]' } });
    expect(JSON.stringify(uploads[0].body)).not.toContain('laminar-secret');
  });
  it('stops active hooks after off and never revives them on reenable', async () => {
    let count = 0; const base = await http((_req, res) => { count++; res.end('{}'); });
    await setup(); const r = await relay(base); await post(r, turn); await recording(false);
    await post(r, turn); await recording(true); await post(r, turn); expect(count).toBe(1);
    const fresh = await relay(base); await post(fresh, turn); expect(count).toBe(2);
  });
  it('off waits for in-flight export completion', async () => {
    let entered!: () => void; const ready = new Promise<void>(r => entered = r);
    let finish!: () => void; const release = new Promise<void>(r => finish = r);
    const base = await http(async (_req, res) => { entered(); await release; res.end('{}'); });
    await setup(); const r = await relay(base); const sending = post(r, turn); await ready;
    let offDone = false; const off = recording(false).then(() => { offDone = true; });
    await new Promise(r => setTimeout(r, 60)); expect(offDone).toBe(false); finish(); await sending; await off; expect(offDone).toBe(true);
  });
  it('runs the built Codex hook and chains an existing notifier', async () => {
    let count = 0; const base = await http((_req, res) => { count++; res.end('{}'); });
    await setup(); const r = await relay(base);
    const received = join(dir, 'notified.json'); const notifier = join(dir, 'notify.cjs');
    await writeFile(notifier, `require('node:fs').writeFileSync(${JSON.stringify(received)}, process.argv[2])`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, ['dist/hook.js', 'codex', JSON.stringify(turn)], { env: { ...process.env, QUILLATIO_RELAY_URL: r.url, QUILLATIO_RELAY_TOKEN: r.secret, QUILLATIO_PREVIOUS_NOTIFY: JSON.stringify([process.execPath, notifier]) } });
      p.once('error', reject); p.once('exit', code => { expect(code).toBe(0); resolve(); });
    });
    expect(count).toBe(1); expect(JSON.parse(await readFile(received, 'utf8'))).toEqual(turn);
  });
  it('executes Claude settings hook with stdin without reading transcripts', async () => {
    let body: any; const base = await http(async (req, res) => { body = JSON.parse(await readBody(req)); res.end('{}'); });
    await setup(); const r = await relay(base, 'claude-code');
    const adapted = await adapterArgs('claude-code', [], dir, resolve('dist/hook.js'));
    const settings = JSON.parse(await readFile(adapted.args[1], 'utf8'));
    await new Promise<void>((resolve, reject) => {
      const p = spawn('/bin/sh', ['-c', settings.hooks.Stop[0].hooks[0].command], { env: { ...process.env, QUILLATIO_RELAY_URL: r.url, QUILLATIO_RELAY_TOKEN: r.secret } });
      p.once('error', reject); p.once('exit', code => { expect(code).toBe(0); resolve(); });
      p.stdin.end(JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'done', transcript_path: '/must/not/read' }));
    });
    expect(JSON.stringify(body)).toContain('done'); expect(JSON.stringify(body)).not.toContain('/must/not/read');
  });
  it('drops invalid events and fails closed on corrupted switch state', async () => {
    let count = 0; const base = await http((_req, res) => { count++; res.end('{}'); });
    await setup(); const r = await relay(base); await post(r, { type: 'other' });
    await writeFile(join(dir, 'config.json'), 'broken'); expect((await post(r, turn)).status).toBe(503); expect(count).toBe(0);
  });
});

describe('non-destructive installation and launch settings', () => {
  it('preserves TOML exactly and chains structured notify arguments', async () => {
    await mkdir(process.env.CODEX_HOME!, { recursive: true });
    const path = join(process.env.CODEX_HOME!, 'config.toml');
    const original = '# preserve comments\nmodel = "existing"\nnotify = ["node", "a b.cjs"]\n'; await writeFile(path, original);
    await installAgent('codex'); const result = await adapterArgs('codex', ['exec', 'hello'], dir, '/a b/hook.js');
    expect(result.previousNotify).toEqual(['node', 'a b.cjs']); expect(result.args.join(' ')).toContain('hooks.PostToolUse='); expect(result.args.join(' ')).toContain('codex-native');
    expect(await readFile(path, 'utf8')).toBe(original);
  });
  it('rejects resuming recording and preserves malformed TOML', async () => {
    await expect(adapterArgs('claude-code', ['--continue'], dir, 'hook')).rejects.toThrow('fresh');
    expect((await adapterArgs('codex', ['resume'], dir, 'hook')).args[0]).toBe('resume');
    await mkdir(process.env.CODEX_HOME!, { recursive: true }); const path = join(process.env.CODEX_HOME!, 'config.toml'); await writeFile(path, 'bad = [');
    await expect(adapterArgs('codex', [], dir, 'hook')).rejects.toThrow('parse'); expect(await readFile(path, 'utf8')).toBe('bad = [');
  });
  it('launches the recording adapter through the CLI, exports and removes ephemeral settings', async () => {
    const uploads: unknown[] = [];
    const laminar = await http(async (req, res) => { uploads.push(JSON.parse(await readBody(req))); res.end('{}'); });
    const api = await http((req, res) => res.end(JSON.stringify({ projectId: 'p1', projectName: 'Alpha', laminarProjectId: 'l1', laminarApiKey: 'launch-key', laminarBaseUrl: laminar })));
    await setup(); await updateConfig(c => ({ ...c, server: api })); await installAgent('claude-code');
    const bin = join(dir, 'bin'); await mkdir(bin);
    const script = `#!/usr/bin/env node
import fs from 'node:fs';
import cp from 'node:child_process';
const settings = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--settings') + 1], 'utf8'));
const hook = cp.spawn('/bin/sh', ['-c', settings.hooks.Stop[0].hooks[0].command], {stdio: ['pipe', 'inherit', 'inherit']});
hook.stdin.end(JSON.stringify({hook_event_name: 'Stop', last_assistant_message: 'launch result'}));
hook.on('exit', code => process.exit(code));
`;
    await writeFile(join(bin, 'claude'), script, { mode: 0o700 });
    const result = await cli(['run', 'claude-code'], '', { PATH: `${bin}:${process.env.PATH}` });
    expect(result.code, result.stderr).toBe(0); expect(uploads).toHaveLength(1);
    expect(JSON.stringify(uploads)).toContain('launch result');
    expect(result.stdout + result.stderr).not.toContain('launch-key');
    expect(await readdir(join(dir, 'sessions'))).toEqual([]);
  });
  it('passes agent arguments and propagates child status without capture while off', async () => {
    const bin = join(dir, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'claude'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2))); console.log(process.env.QUILLATIO_RELAY_TOKEN || "clean"); process.exit(7);', { mode: 0o700 });
    const result = await cli(['run', 'claude-code', '--', '--print', 'hello'], '', { PATH: `${bin}:${process.env.PATH}`, QUILLATIO_RELAY_TOKEN: 'inherited-secret' });
    expect(result.code).toBe(7); expect(result.stdout).toContain('["--print","hello"]'); expect(result.stdout).toContain('clean'); expect(result.stdout).not.toContain('inherited-secret');
  });
});
