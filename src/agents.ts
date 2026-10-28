import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import TOML from '@iarna/toml';
import { home, loadConfig, privateDir, saveJson } from './config.js';
import { credentials } from './api.js';
import { startRelay } from './capture.js';
import { CODEX_EVENTS } from './codex.js';

export type Agent = 'codex' | 'claude-code';
export function agentName(value: string): Agent {
  if (value !== 'codex' && value !== 'claude-code') throw new Error('Agent must be codex or claude-code.');
  return value;
}
export async function installAgent(agent: Agent) {
  await privateDir(home());
  await saveJson(join(home(), `${agent}.json`), { version: 1, agent, mode: 'launch-scoped' });
}
export function quote(value: string) { return `'${value.replace(/'/g, `'"'"'`)}'`; }
export async function adapterArgs(agent: Agent, args: string[], dir: string, hookPath: string): Promise<{ args: string[]; previousNotify?: string[] }> {
  if (agent === 'claude-code' && args.some(a => /^(--resume|--continue|--fork-session|--session-id|-r)(=|$)/.test(a) || /^-[cr]/.test(a))) throw new Error('Recording requires a fresh session. Resume/fork is not supported.');
  if (agent === 'codex') {
    const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
    let config: TOML.JsonMap = {};
    try { config = TOML.parse(await readFile(configPath, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot parse existing Codex configuration.'); }
    const notify = config.notify;
    if (notify !== undefined && (!Array.isArray(notify) || !notify.every(v => typeof v === 'string'))) throw new Error('Existing Codex notify must be an array of strings.');
    const command = [process.execPath, hookPath, 'codex-native'].map(quote).join(' ');
    const trust: TOML.JsonMap = { ...((config.hooks as TOML.JsonMap | undefined)?.state as TOML.JsonMap | undefined) };
    const native = CODEX_EVENTS.flatMap(event => {
      const existing = (config.hooks as TOML.JsonMap | undefined)?.[event];
      if (existing !== undefined && !Array.isArray(existing)) throw new Error('Invalid existing Codex hooks.');
      const timeout = ['SessionEnd', 'Interrupt'].includes(event) ? 3 : 10;
      const handler = { type: 'command', command, timeout, async: false };
      // Codex discovers each config layer independently; copying user groups would run them twice.
      const groups = [{ hooks: [handler] }];
      const value = TOML.stringify.value(groups as TOML.JsonMap[]);
      const label = event.replace(/[A-Z]/g, (c, index) => `${index ? '_' : ''}${c.toLowerCase()}`);
      // Codex hashes sorted normalized JSON; trust only our session-flags handler.
      const normalized = { event_name: label, hooks: [{ async: false, command, timeout, type: 'command' }] };
      const hash = `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
      const key = `/<session-flags>/config.toml:${label}:${groups.length - 1}:0`;
      trust[key] = { trusted_hash: hash };
      return ['-c', `hooks.${event}=${value}`];
    });
    return { args: [...args, ...native, '-c', `hooks.state=${TOML.stringify.value(trust)}`], previousNotify: notify as string[] | undefined };
  }
  const command = [process.execPath, hookPath, 'claude-code'].map(quote).join(' ');
  const hooks = Object.fromEntries(['UserPromptSubmit', 'PostToolUse', 'Stop'].map(event => [event, [{ hooks: [{ type: 'command', command, timeout: 10 }] }]]));
  const path = join(dir, 'settings.json');
  await saveJson(path, { hooks });
  return { args: [...args, '--settings', path] };
}
export function execute(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const listeners = signals.map(signal => { const listener = () => child.kill(signal); process.on(signal, listener); return listener; });
    const clean = () => signals.forEach((signal, i) => process.off(signal, listeners[i]));
    child.once('error', () => { clean(); reject(new Error(`Cannot launch ${command}. Install it and ensure it is on PATH.`)); });
    child.once('exit', (code, signal) => { clean(); resolve(code ?? (signal === 'SIGINT' ? 130 : 143)); });
  });
}
export async function runAgent(agent: Agent, args: string[]) {
  const binary = agent === 'codex' ? 'codex' : 'claude';
  const config = await loadConfig();
  const env = { ...process.env };
  for (const key of ['QUILLATIO_RELAY_URL', 'QUILLATIO_RELAY_TOKEN', 'QUILLATIO_PREVIOUS_NOTIFY']) delete env[key];
  if (!config.enabled) return execute(binary, args, env);
  if (process.platform === 'win32') throw new Error('Recording currently requires macOS or Linux.');
  try { await readFile(join(home(), `${agent}.json`)); } catch { throw new Error(`Run quillatio install ${agent} first.`); }
  const creds = await credentials(config);
  await privateDir(join(home(), 'sessions'));
  const dir = await mkdtemp(join(home(), 'sessions', 'launch-'));
  let relay: Awaited<ReturnType<typeof startRelay>> | undefined;
  try {
    const adapted = await adapterArgs(agent, args, dir, join(dirname(fileURLToPath(import.meta.url)), 'hook.js'));
    relay = await startRelay(agent, randomUUID(), config, creds, process.env.CODEX_HOME || join(homedir(), '.codex'));
    process.stderr.write(`Quillatio: recording ${agent}; project pinned for this launch.\n`);
    return await execute(binary, adapted.args, { ...env, QUILLATIO_RELAY_URL: relay.url, QUILLATIO_RELAY_TOKEN: relay.secret, QUILLATIO_PREVIOUS_NOTIFY: JSON.stringify(adapted.previousNotify || []) });
  } finally { await relay?.close(); await rm(dir, { recursive: true, force: true }); }
}
