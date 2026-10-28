import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig, locked, type Config } from './config.js';
import type { Credentials } from './api.js';
import { CODEX_EVENTS, CodexTranscript, describeCodexRow, type AuditEvent } from './codex.js';

export async function readBody(req: AsyncIterable<Buffer | string>, max = 1024 * 1024): Promise<string> {
  const parts: Buffer[] = []; let length = 0;
  for await (const chunk of req) { const b = Buffer.from(chunk); length += b.length; if (length > max) throw new Error('Payload too large'); parts.push(b); }
  return Buffer.concat(parts).toString('utf8');
}
export function spanBody(agent: string, session: string, event: Record<string, unknown>) {
  const codex = agent === 'codex';
  const name = String(event.hook_event_name || (codex ? 'Turn' : 'Event'));
  const row = event.rollout_row as AuditEvent | undefined;
  const description = row ? describeCodexRow(row) : undefined;
  const input = description?.input ?? event['input-messages'] ?? event.prompt ?? event.tool_input;
  const output = description?.output ?? event['last-assistant-message'] ?? event.last_assistant_message ?? event.tool_response ?? event.transcript_text;
  const fields: Record<string, string> = {
    'lmnr.span.type': description?.type ?? (['PostToolUse', 'PreToolUse'].includes(name) ? 'TOOL' : name === 'PostModelRequest' ? 'LLM' : 'DEFAULT'),
    'lmnr.association.properties.session_id': session,
    'lmnr.association.properties.metadata.source': agent,
  };
  if (codex) fields['quillatio.audit.event'] = JSON.stringify(event);
  for (const key of ['session_id', 'turn_id', 'tool_use_id', 'model', 'byte_offset', 'byte_end']) {
    if (event[key] !== undefined) fields[`quillatio.${key}`] = String(event[key]);
  }
  if (event.model) fields['gen_ai.request.model'] = String(event.model);
  if (event.token_usage && typeof event.token_usage === 'object') {
    for (const [key, value] of Object.entries(event.token_usage)) fields[`gen_ai.usage.${key}`] = String(value);
  }
  if (input !== undefined) fields['lmnr.span.input'] = JSON.stringify(input);
  if (output !== undefined) fields['lmnr.span.output'] = JSON.stringify(output);
  if (event.tool_name) fields['quillatio.tool.name'] = String(event.tool_name);
  const now = (BigInt(Date.now()) * 1000000n).toString();
  return { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'quillatio' } }] }, scopeSpans: [{ scope: { name: 'quillatio' }, spans: [{ traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), name: `${agent} ${description?.name || name}`, kind: 1, startTimeUnixNano: now, endTimeUnixNano: now, attributes: Object.entries(fields).map(([key, stringValue]) => ({ key, value: { stringValue } })), status: { code: 1 } }] }] }] };
}
function authorized(req: IncomingMessage, secret: string) {
  const a = Buffer.from(req.headers.authorization || ''); const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function startRelay(agent: string, session: string, snapshot: Config, creds: Credentials, codexRoot?: string) {
  const secret = randomBytes(32).toString('hex');
  const controllers = new Set<AbortController>();
  const traceId = randomBytes(16).toString('hex');
  let stopped = false;
  async function send(event: AuditEvent | AuditEvent[]) {
    const bodies = (Array.isArray(event) ? event : [event]).map(e => spanBody(agent, session, e));
    for (const b of bodies) for (const span of b.resourceSpans[0].scopeSpans[0].spans) span.traceId = traceId;
    const body = bodies[0];
    for (const next of bodies.slice(1)) body.resourceSpans[0].scopeSpans[0].spans.push(...next.resourceSpans[0].scopeSpans[0].spans);
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`${creds.laminarBaseUrl}/v1/traces`, { method: 'POST', headers: { Authorization: `Bearer ${creds.laminarApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new Error();
      const result = await response.json().catch(() => ({}));
      if (result.partialSuccess?.rejectedSpans) throw new Error();
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  let rowBuffer = '';
  const transcript = agent === 'codex' && codexRoot ? new CodexTranscript(codexRoot, async event => {
    // Raw chunks retain every appended byte even for unknown or oversized rows.
    const events = [event];
    rowBuffer += String(event.transcript_text);
    let newline: number;
    while ((newline = rowBuffer.indexOf('\n')) >= 0) {
      const line = rowBuffer.slice(0, newline); rowBuffer = rowBuffer.slice(newline + 1);
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object' && line.length <= 128 * 1024) events.push({ hook_event_name: 'RolloutRow', session_id: event.session_id, rollout_row: row });
      } catch { /* Raw audit chunks remain available for incomplete/unknown rows. */ }
    }
    if (rowBuffer.length > 1024 * 1024) rowBuffer = '';
    await send(events);
  }) : undefined;
  async function allowed() {
    const c = await loadConfig();
    return !stopped && c.enabled && c.epoch === snapshot.epoch;
  }
  let polling = false;
  const poll = async () => {
    if (!transcript || polling || stopped) return;
    polling = true;
    try { await locked(async () => { if (await allowed()) await transcript.drain(); }); }
    catch { process.stderr.write('Quillatio: transcript capture failed; audit may be incomplete.\n'); }
    finally { polling = false; }
  };
  const timer = setInterval(() => { void poll(); }, 500);
  timer.unref();
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/capture' || !authorized(req, secret)) { res.writeHead(403).end(); return; }
    try {
      const event = JSON.parse(await readBody(req));
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error();
      await locked(async () => {
        if (!(await allowed())) return;
        if (agent === 'codex' && event.type !== 'agent-turn-complete' && !CODEX_EVENTS.includes(event.hook_event_name)) return;
        if (agent === 'claude-code' && !['UserPromptSubmit', 'PostToolUse', 'Stop'].includes(event.hook_event_name)) return;
        if (agent === 'codex') {
          try { await transcript?.attach(event); await transcript?.drain(); }
          catch { process.stderr.write('Quillatio: transcript capture failed; native hook capture remains active.\n'); }
        }
        await send(event);
      });
      res.writeHead(204).end();
    } catch { process.stderr.write('Quillatio: capture failed; event dropped.\n'); res.writeHead(503).end(); }
  });
  server.requestTimeout = 8000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Relay unavailable.');
  return { url: `http://127.0.0.1:${address.port}/capture`, secret, close: async () => {
    clearInterval(timer);
    while (polling) await new Promise(r => setTimeout(r, 10));
    if (transcript) {
      let pending: boolean | undefined;
      do {
        pending = false;
        try { await locked(async () => { if (await allowed()) pending = await transcript.drain(); }); }
        catch { process.stderr.write('Quillatio: final transcript flush failed; audit may be incomplete.\n'); }
      } while (pending);
    }
    stopped = true; for (const controller of controllers) controller.abort();
    await new Promise<void>(r => { server.close(() => r()); server.closeIdleConnections(); });
  } };
}
