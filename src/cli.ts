#!/usr/bin/env node
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { loadConfig, recording, safeUrl, updateConfig } from './config.js';
import { projects } from './api.js';
import { agentName, installAgent, runAgent } from './agents.js';
import { readBody } from './capture.js';

async function prompt(label: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Interactive login needs a terminal; use --token-stdin and --server.');
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, next) { if (!muted) process.stderr.write(chunk); next(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = rl.question(label); muted = secret;
    const value = await answer; if (secret) process.stderr.write('\n'); return value.trim();
  } finally { muted = false; rl.close(); }
}
const program = new Command().enablePositionalOptions().name('quillatio').description('Opt-in coding agent recording to managed Laminar').version('0.1.0');
program.command('login').description('Configure server and website CLI token').option('--server <url>').option('--token-stdin', 'Read token from stdin instead of a hidden prompt').action(async options => {
  const server = safeUrl(options.server || await prompt('Quillatio server URL: '));
  const token = options.tokenStdin ? (await readBody(process.stdin, 16384)).trim() : await prompt('CLI token (hidden): ', true);
  if (!token || /\s/.test(token)) throw new Error('Token must be nonempty without whitespace.');
  await projects({ server, token, enabled: false, epoch: '' });
  await updateConfig(() => ({ server, token, enabled: false, epoch: randomUUID() }));
  console.log('Logged in. Recording is off. Select a project with quillatio use <slug>.');
});
program.command('configure').description('Change server; clears login and disables active recording').requiredOption('--server <url>').action(async options => {
  const server = safeUrl(options.server);
  await updateConfig(() => ({ server, enabled: false, epoch: randomUUID() }));
  console.log('Server configured. Run quillatio login.');
});
program.command('projects').alias('list').action(async () => {
  const c = await loadConfig();
  for (const p of await projects(c)) console.log(`${p.id === c.project?.id ? '*' : ' '} ${JSON.stringify(p.slug)}\t${JSON.stringify(p.name)}`);
});
program.command('use <slug>').action(async slug => {
  const snapshot = await loadConfig();
  const found = (await projects(snapshot)).filter(p => p.slug === slug || p.id === slug);
  if (found.length !== 1) throw new Error('Project not found or ambiguous; use its exact ID.');
  await updateConfig(c => {
    if (c.server !== snapshot.server || c.token !== snapshot.token) throw new Error('Login changed; retry project selection.');
    return { ...c, project: found[0] };
  });
  console.log(`Selected ${JSON.stringify(found[0].slug)}. Existing launches stay pinned to their original project.`);
});
program.command('on').action(async () => {
  await updateConfig(c => {
    if (!c.token || !c.project) throw new Error('Login and select a project first.');
    return c.enabled ? c : { ...c, enabled: true, epoch: randomUUID() };
  });
  console.log('Recording on for new quillatio run launches.');
});
program.command('off').action(async () => { await recording(false); console.log('Recording off, including active Quillatio hooks. Start a new launch after turning on again.'); });
program.command('status').action(async () => {
  const c = await loadConfig();
  console.log(`Recording: ${c.enabled ? 'on' : 'off'}\nServer: ${c.server ? JSON.stringify(c.server) : 'not configured'}\nProject: ${c.project ? JSON.stringify(c.project.slug) : 'not selected'}\nScope: Quillatio-launched sessions only`);
});
program.command('install <agent>').description('Enable the launch-scoped Quillatio adapter (does not install the agent binary)').action(async value => {
  const agent = agentName(value); await installAgent(agent); console.log(`Installed ${agent} adapter. No global agent configuration changed. Use quillatio run ${agent} -- <args>.`);
});
program.command('run <agent> [args...]').description('Launch an installed agent; pass its arguments after --').allowUnknownOption().passThroughOptions().action(async (value, args) => { process.exitCode = await runAgent(agentName(value), args[0] === '--' ? args.slice(1) : args); });
program.parseAsync().catch((error: unknown) => { console.error(error instanceof Error ? `Quillatio: ${error.message}` : 'Quillatio: operation failed.'); process.exitCode = 1; });
