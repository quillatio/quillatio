import { spawn } from 'node:child_process';
import { readBody } from './capture.js';

async function main() {
  const agent = process.argv[2];
  const raw = agent === 'codex' ? process.argv[3] : await readBody(process.stdin);
  if (!raw || Buffer.byteLength(raw) > 1024 * 1024) return;
  try {
    const url = new URL(process.env.QUILLATIO_RELAY_URL || '');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/capture') return;
    await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.QUILLATIO_RELAY_TOKEN || ''}`, 'Content-Type': 'application/json' }, body: raw, signal: AbortSignal.timeout(8000), redirect: 'error' });
  } catch { /* Recording must never block the agent on export failure. */ }
  if (agent === 'codex') {
    const previous = JSON.parse(process.env.QUILLATIO_PREVIOUS_NOTIFY || '[]');
    if (Array.isArray(previous) && previous.length && previous.every(v => typeof v === 'string')) {
      await new Promise<void>(resolve => {
        const child = spawn(previous[0], [...previous.slice(1), raw], { stdio: 'ignore', timeout: 5000 });
        child.once('error', () => resolve()); child.once('exit', () => resolve());
      });
    }
  }
}
main().catch(() => {}).finally(() => { process.exitCode = 0; });
