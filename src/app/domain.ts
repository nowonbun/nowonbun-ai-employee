export type Criterion = { id: string; label: string; weight: number; evidence?: string | null; verified?: boolean };

export function parseSkill(input: string): { name: string; description: string; body: string; canonical: string } {
  if (Buffer.byteLength(input, 'utf8') > 32768) throw new Error('skill size exceeds 32 KiB');
  const match = input.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md frontmatter is required');
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    const field = line.match(/^([a-z]+):\s*(.+)$/);
    if (!field) throw new Error('invalid frontmatter');
    if (fields.has(field[1]!)) throw new Error(`duplicate ${field[1]}`);
    fields.set(field[1]!, field[2]!.trim());
  }
  const name = fields.get('name');
  const description = fields.get('description');
  const body = (match[2] ?? '').trim();
  if (!name || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('invalid name');
  if (!description || description.length > 500) throw new Error('invalid description');
  if (!body) throw new Error('empty skill body');
  if ([...fields.keys()].some(key => key !== 'name' && key !== 'description')) throw new Error('unsupported frontmatter');
  return { name, description, body, canonical: `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n` };
}

export function progress(criteria: Criterion[]): number | null {
  if (criteria.length === 0) return null;
  if (criteria.some(item => !Number.isFinite(item.weight) || item.weight <= 0)) throw new Error('invalid criterion weight');
  const total = criteria.reduce((sum, item) => sum + item.weight, 0);
  const verified = criteria.reduce((sum, item) => sum + (item.verified && item.evidence?.trim() ? item.weight : 0), 0);
  return Math.round((10000 * verified) / total) / 100;
}

export function retryAt(endedAt: number, retryAfterAt: number | null, allowed: boolean): number | null {
  if (!allowed) return null;
  return Math.max(endedAt + 60_000, retryAfterAt ?? 0);
}

export function buildCodexArgs(model: string, sessionId: string | null, cwd: string): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(model)) throw new Error('invalid model');
  if (sessionId !== null && !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('invalid session id');
  return sessionId === null
    ? ['exec', '--json', '--model', model, '-C', cwd, '-']
    : ['exec', 'resume', '--json', '--model', model, sessionId, '-'];
}
