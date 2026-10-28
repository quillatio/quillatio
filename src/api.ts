import { type Config, type Project, safeUrl } from './config.js';
export interface Credentials { projectId: string; projectName: string; laminarProjectId: string; laminarApiKey: string; laminarBaseUrl: string }
async function get(c: Config, path: string): Promise<unknown> {
  if (!c.server || !c.token) throw new Error('Run quillatio login first.');
  let res: Response;
  try { res = await fetch(`${safeUrl(c.server)}${path}`, { headers: { Authorization: `Bearer ${c.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000) }); }
  catch { throw new Error('Cannot reach the Quillatio server.'); }
  if (!res.ok) throw new Error(`Quillatio server returned HTTP ${res.status}.`);
  try { return await res.json(); } catch { throw new Error('Invalid server response.'); }
}
export async function projects(c: Config): Promise<Project[]> {
  const body = await get(c, '/api/cli/projects') as { projects?: Project[] };
  if (!Array.isArray(body?.projects) || !body.projects.every(p => p && ['id','name','slug'].every(k => typeof p[k as keyof Project] === 'string'))) throw new Error('Invalid projects response.');
  return body.projects;
}
export async function credentials(c: Config): Promise<Credentials> {
  if (!c.project) throw new Error('Select a project with quillatio use <slug>.');
  const v = await get(c, `/api/cli/projects/${encodeURIComponent(c.project.id)}/credentials`) as Credentials;
  if (!v || v.projectId !== c.project.id || !['projectName','laminarProjectId','laminarApiKey','laminarBaseUrl'].every(k => typeof v[k as keyof Credentials] === 'string' && v[k as keyof Credentials])) throw new Error('Invalid project credentials response.');
  v.laminarBaseUrl = safeUrl(v.laminarBaseUrl);
  return v;
}
