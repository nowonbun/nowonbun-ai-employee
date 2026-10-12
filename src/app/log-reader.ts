import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { AppError, type Store } from './store.js';

function redacted(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}

export class LogReader {
  private readonly root: string;
  constructor(private readonly store: Store, root: string) { this.root = realpathSync(root); }
  async importSession(sessionId: string): Promise<{ imported: number; completeness: string }> {
    const session = this.store.get('sessions', sessionId);
    if (!session) throw new AppError('NOT_FOUND', 'session', 404);
    if (!session.codex_id) return { imported: 0, completeness: 'missing_session_id' };
    const codexId = String(session.codex_id);
    const pending = [this.root]; const files: string[] = []; let partial = false;
    while (pending.length) {
      const dir = pending.pop()!;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && basename(path).startsWith('rollout-') && path.endsWith('.jsonl')) files.push(path);
        if (files.length + pending.length > 10000) { partial = true; pending.length = 0; break; }
      }
    }
    let imported = 0; let matched = false;
    for (const file of files) {
      const info = await stat(file);
      if (info.size > 50 * 1024 * 1024) { partial = true; continue; }
      const reader = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      let lineNo = 0; let fileMatches = false;
      for await (const line of reader) {
        lineNo++;
        if (line.length > 100000) { partial = true; continue; }
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { partial = true; continue; }
        if (event.type === 'session_meta') { const payload = event.payload as Record<string, unknown> | undefined; fileMatches = payload?.id === codexId; if (fileMatches) matched = true; continue; }
        if (!fileMatches || event.type !== 'event_msg') continue;
        const payload = event.payload as Record<string, unknown> | undefined;
        if (payload?.type !== 'user_message' && payload?.type !== 'agent_message') continue;
        if (typeof payload.message !== 'string') { partial = true; continue; }
        const kind = payload.type === 'user_message' ? 'user' : 'assistant';
        const sourceKey = createHash('sha256').update(`${file}:${lineNo}`).digest('hex');
        if (this.store.importLogEvent(sessionId, sourceKey, kind, redacted(payload.message))) imported++;
      }
    }
    return { imported, completeness: !matched ? 'missing' : partial ? 'partial' : 'complete_for_source' };
  }
}
