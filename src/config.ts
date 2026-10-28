import { mkdir, readFile, writeFile, rename, chmod, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface Project { id: string; name: string; slug: string }
export interface Config { server?: string; token?: string; project?: Project; enabled: boolean; epoch: string }
export const home = () => resolve(process.env.QUILLATIO_HOME || join(homedir(), '.quillatio'));
export async function privateDir(dir: string) { await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700); }
export async function saveJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export async function loadConfig(): Promise<Config> {
  try {
    const c = JSON.parse(await readFile(join(home(), 'config.json'), 'utf8'));
    if (typeof c.enabled !== 'boolean' || typeof c.epoch !== 'string') throw new Error();
    return c;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: false, epoch: '' };
    throw new Error('Cannot read Quillatio configuration; recording is disabled.');
  }
}
// Uploads and switch changes share a lock: off returns only after prior uploads finish.
export async function locked<T>(fn: () => Promise<T>): Promise<T> {
  await privateDir(home());
  const path = join(home(), 'switch.lock');
  const deadline = Date.now() + 15000;
  while (true) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (Date.now() > deadline) throw new Error('Recording lock is busy. Retry; if a process crashed, remove switch.lock after stopping Quillatio processes.');
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try { return await fn(); } finally { await rm(path, { recursive: true, force: true }); }
}
export async function updateConfig(fn: (c: Config) => Config) {
  return locked(async () => { const c = fn(await loadConfig()); await saveJson(join(home(), 'config.json'), c); return c; });
}
export async function recording(enabled: boolean) {
  return updateConfig(c => ({ ...c, enabled, epoch: randomUUID() }));
}
export function safeUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('Invalid server URL.'); }
  if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))))
    throw new Error('Use HTTPS (HTTP allowed only on loopback), without URL credentials, query or fragment.');
  return u.toString().replace(/\/$/, '');
}
