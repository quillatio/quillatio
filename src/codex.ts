import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreModelRequest', 'PostModelRequest', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Interrupt', 'SessionEnd'];
export type AuditEvent = Record<string, unknown>;

// Only a hook-provided session path is opened; no sessions directory discovery.
export class CodexTranscript {
  private path?: string;
  private offset = 0;
  private identity = '';
  private decoder = new StringDecoder('utf8');
  private session?: string;
  private disabled = false;
  constructor(private root: string, private emit: (event: AuditEvent) => Promise<void>) {}

  async attach(event: AuditEvent) {
    if (this.disabled || this.path || event.hook_event_name !== 'SessionStart' || typeof event.session_id !== 'string' || typeof event.transcript_path !== 'string') return;
    const root = await realpath(this.root);
    const path = await realpath(event.transcript_path);
    if (!path.startsWith(root + sep)) throw new Error('Transcript is outside Codex home.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Invalid transcript.');
      this.path = path; this.session = event.session_id;
      this.identity = `${info.dev}:${info.ino}`;
      // Existing bytes (including resumed history) never leave the machine.
      this.offset = info.size;
    } finally { await file.close(); }
  }

  async drain() {
    if (!this.path || this.disabled) return;
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (`${info.dev}:${info.ino}` !== this.identity || info.size < this.offset) { this.disabled = true; throw new Error('Transcript replaced or truncated.'); }
      const end = Math.min(info.size, this.offset + 128 * 1024);
      while (this.offset < end) {
        const start = this.offset;
        const buffer = Buffer.alloc(Math.min(128 * 1024, end - start));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const text = this.decoder.write(buffer.subarray(0, bytesRead));
        if (text) await this.emit({ hook_event_name: 'TranscriptAppend', session_id: this.session, byte_offset: start, byte_end: this.offset, transcript_text: text });
      }
      return this.offset < info.size;
    } finally { await file.close(); }
  }
}

// Shapes are verified against lmnr-ai/lmnr-codex-plugin/src/codex-events.ts.
export function describeCodexRow(row: AuditEvent): { name: string; type: string; input?: unknown; output?: unknown } {
  const p = row.payload as AuditEvent | undefined;
  if (!p || typeof p !== 'object') return { name: String(row.type || 'rollout'), type: 'DEFAULT', output: row };
  const type = String(p.type || row.type);
  if (['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'].includes(type)) {
    let input = p.arguments ?? p.input ?? p.action;
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* Custom tools may use non-JSON arguments. */ } }
    return { name: String(p.name || type), type: 'TOOL', input };
  }
  if (['function_call_output', 'custom_tool_call_output'].includes(type)) return { name: `${type} ${p.call_id || ''}`, type: 'TOOL', output: p.output };
  if (type === 'message' || type === 'reasoning') return { name: String(p.role || type), type: 'LLM', output: p.content ?? p.summary };
  return { name: type, type: 'DEFAULT', output: p };
}
