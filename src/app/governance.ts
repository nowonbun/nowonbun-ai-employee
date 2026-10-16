import { createHash } from 'node:crypto';
import { AppError, type Store } from './store.js';
import type { Row } from './db.js';
import { parseSkill } from './domain.js';

export const MCP_TOOLS = ['operation_get', 'allowed_workers', 'inbox_list', 'inbox_ack', 'work_order_get', 'task_get', 'work_process_list', 'work_process_create', 'work_cycle_record', 'task_delegate', 'task_checkpoint', 'work_log_append', 'task_result_submit', 'work_order_report_submit'];
type SkillSnapshot = { id: string; version: number; hash: string; name: string; content: string; source: 'common' | 'individual' };
export type RunSkills = { policyRevision: number; individualRevision: number; skills: SkillSnapshot[] };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export class Governance {
  constructor(private readonly store: Store) {}
  private checkedSkill(id: string, source: SkillSnapshot['source'], version?: number): SkillSnapshot {
    const current = this.store.get('skills', id);
    if (!current) throw new AppError('INVALID_INPUT', 'skill reference missing');
    const row = version === undefined || version === current.version ? current : this.store.row('SELECT * FROM skill_versions WHERE skill_id=? AND version=?', id, version);
    if (!row) throw new AppError('INVALID_INPUT', 'skill version missing');
    const content = String(row.content);
    if (hash(content) !== row.sha256) throw new AppError('INVALID_INPUT', 'skill hash mismatch');
    if (parseSkill(content).canonical !== content) throw new AppError('INVALID_INPUT', 'skill content invalid');
    return { id, version: Number(row.version), hash: String(row.sha256), name: String(row.name), content, source };
  }
  policy() {
    const row = this.store.row('SELECT * FROM ai_policy_versions ORDER BY revision DESC LIMIT 1')!;
    const skills = JSON.parse(String(row.skills_json)) as SkillSnapshot[];
    return { revision: Number(row.revision), skillIds: skills.map(s => s.id), skills, updatedAt: Number(row.created_at) };
  }
  policyView() {
    return { ...this.policy(), history: this.store.rows('SELECT * FROM ai_policy_versions ORDER BY revision DESC LIMIT 5').map(row => ({ revision: Number(row.revision), updatedAt: Number(row.created_at), skills: JSON.parse(String(row.skills_json)) })) };
  }
  previewPolicy(skillIds: string[]) {
    const current = this.policy();
    const common = [...new Set(skillIds)].map(id => this.checkedSkill(id, 'common'));
    const employees = this.store.rows('SELECT * FROM employees ORDER BY created_at');
    return { expectedRevision: current.revision, scope: '모든 기존·신규 AI와 면담의 다음 Run', commonSkills: common.map(({ content: _content, ...skill }) => skill), added: common.filter(skill => !current.skillIds.includes(skill.id)).map(skill => skill.id), removed: current.skillIds.filter(id => !skillIds.includes(id)), updatedVersions: common.filter(skill => current.skills.some(saved => saved.id === skill.id && (saved.version !== skill.version || saved.hash !== skill.hash))).map(skill => skill.id), employees: employees.map(employee => {
      const session = this.store.row('SELECT * FROM sessions WHERE employee_id=? AND is_current=1', String(employee.id));
      const effective = [...common];
      if (session) for (const id of JSON.parse(String(session.skill_ids)) as string[]) if (!effective.some(skill => skill.id === id)) effective.push(this.checkedSkill(id, 'individual'));
      return { employeeId: employee.id, status: employee.status, sessionId: session?.id ?? null, individualRevision: session?.revision ?? null, effectiveSkills: effective.map(({ content: _content, ...skill }) => skill) };
    }) };
  }
  savePolicy(actor: string, key: string, ids: unknown, revision: unknown) {
    if (actor !== 'operator') throw new AppError('FORBIDDEN', 'operator only', 403);
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || !Number.isSafeInteger(revision) || Number(revision) < 1)
      throw new AppError('INVALID_INPUT', 'policy input');
    const unique = [...new Set(ids as string[])].sort();
    return this.store.mutate(actor, 'ai-policy.save', key, { ids: unique, revision }, () => {
      const current = this.policy();
      if (current.revision !== revision) throw new AppError('CONFLICT', 'policy revision conflict; 최신 정책을 조회하고 다시 확인하세요.', 409);
      const skills = unique.map(id => this.checkedSkill(id, 'common'));
      if (JSON.stringify(skills) === JSON.stringify(current.skills)) return current;
      const next = current.revision + 1;
      this.store.run('INSERT INTO ai_policy_versions VALUES (?,?,?)', next, JSON.stringify(skills), Date.now());
      this.store.audit(actor, 'ai-policy.save', String(next), { skillIds: unique, previousRevision: current.revision });
      return this.policy();
    });
  }
  resolveSkills(session: Row): RunSkills {
    const policy = this.policy();
    const skills = policy.skills.map(saved => {
      const checked = this.checkedSkill(saved.id, 'common', saved.version);
      if (checked.hash !== saved.hash || checked.version !== saved.version) throw new AppError('INVALID_INPUT', 'common skill version/hash changed');
      return checked;
    });
    const individual: unknown = JSON.parse(String(session.skill_ids));
    if (!Array.isArray(individual) || individual.some(id => typeof id !== 'string')) throw new AppError('INVALID_INPUT', 'individual skills');
    for (const id of new Set(individual as string[])) {
      if (!skills.some(skill => skill.id === id)) skills.push(this.checkedSkill(id, 'individual'));
    }
    return { policyRevision: policy.revision, individualRevision: Number(session.revision), skills };
  }
  captureRun(runId: string, session: Row): RunSkills {
    return this.store.tx(() => {
      const snapshot = this.resolveSkills(session);
      this.store.run('INSERT INTO run_skill_snapshots VALUES (?,?,?,?)', runId, snapshot.policyRevision, snapshot.individualRevision, JSON.stringify(snapshot.skills));
      return snapshot;
    });
  }
  beginCall(callId: string, employee: string, tool: string, target: string | null, at = Date.now()) {
    if (!MCP_TOOLS.includes(tool)) throw new AppError('INVALID_INPUT', 'tool');
    const prior = this.store.row('SELECT * FROM mcp_calls WHERE call_id=?', callId);
    const targetId = tool === 'task_delegate' ? target : null;
    if (prior && (prior.employee_id !== employee || prior.tool !== tool || prior.target_id !== targetId)) throw new AppError('CONFLICT', 'callId metadata conflict', 409);
    this.store.run('INSERT OR IGNORE INTO mcp_calls (call_id,employee_id,tool,target_id,occurred_at,status) VALUES (?,?,?,?,?,?)', callId, employee, tool, tool === 'task_delegate' ? target : null, at, 'unobserved');
  }
  endCall(callId: string, status: 'success' | 'failed', duration: number | null, code: string | null) {
    this.store.run('UPDATE mcp_calls SET status=?,duration_ms=?,error_code=? WHERE call_id=?', status, duration, code, callId);
  }
  metrics(input: { from: number; to: number; employeeId?: string; tool?: string; cursor?: number; limit?: number }) {
    const { from, to, employeeId, tool, cursor = 0, limit = 50 } = input;
    if (![from, to, cursor, limit].every(Number.isSafeInteger) || from < 0 || to < from || cursor < 0 || limit < 1 || limit > 100) throw new AppError('INVALID_INPUT', 'metrics range/cursor/limit');
    if (tool && !MCP_TOOLS.includes(tool)) throw new AppError('INVALID_INPUT', 'tool');
    if (employeeId && !this.store.get('employees', employeeId)) throw new AppError('INVALID_INPUT', 'employeeId');
    return this.store.tx(() => {
      const clauses = ['occurred_at>=?', 'occurred_at<=?'];
      const args: (string | number)[] = [from, to];
      if (employeeId) { clauses.push('employee_id=?'); args.push(employeeId); }
      if (tool) { clauses.push('tool=?'); args.push(tool); }
      const where = clauses.join(' AND ');
      const summaryOf = (condition: string, params: (string | number)[] = []) => {
        const row = this.store.row(`SELECT COUNT(*) AS total, SUM(status='success') AS success, SUM(status='failed') AS failed, SUM(status='unobserved') AS unobserved, AVG(duration_ms) AS averageMs FROM mcp_calls WHERE ${where}${condition}`, ...args, ...params)!;
        const total = Number(row.total), success = Number(row.success), failed = Number(row.failed);
        return { total, success, failed, unobserved: Number(row.unobserved), successRate: success + failed ? 100 * success / (success + failed) : null, averageMs: row.averageMs === null ? null : Number(row.averageMs) };
      };
      const summary = summaryOf('');
      const functions = MCP_TOOLS.map(name => ({ tool: name, ...summaryOf(' AND tool=?', [name]) })).map(row => ({ ...row, share: summary.total ? 100 * row.total / summary.total : null }));
      const ais = this.store.rows(`SELECT employee_id,COUNT(*) AS total FROM mcp_calls WHERE ${where} GROUP BY employee_id ORDER BY total DESC`, ...args);
      const routes = this.store.rows(`SELECT employee_id,target_id,COUNT(*) AS total FROM mcp_calls WHERE ${where} AND tool='task_delegate' GROUP BY employee_id,target_id ORDER BY total DESC`, ...args);
      const delegations = functions.find(row => row.tool === 'task_delegate')!.total;
      const recent = this.store.rows(`SELECT sequence,call_id,employee_id,tool,target_id,occurred_at,status,duration_ms,error_code FROM mcp_calls WHERE ${where}${cursor ? ' AND sequence<?' : ''} ORDER BY sequence DESC LIMIT ?`, ...args, ...(cursor ? [cursor] : []), limit + 1);
      const hasMore = recent.length > limit;
      if (hasMore) recent.pop();
      const startedAt = Number(this.store.row("SELECT started_at FROM observability_meta WHERE key='mcp'")!.started_at);
      return { filters: { from, to, employeeId: employeeId ?? null, tool: tool ?? null }, aggregatedAt: Date.now(), collection: { status: 'partial', startedAt, scope: '이 제품의 System MCP만 수집합니다. 브리지는 응답·통신 실패·시간 초과와 왕복 시간을 기록합니다. 직접 HTTP 요청은 응답 시간을 측정하지 않습니다. 외부 MCP와 관측 서버 장애 중 시도는 미수집이며, 종료 관측이 없으면 대기·미관측입니다.' }, summary: { ...summary, usedTools: functions.filter(row => row.total > 0).length, delegations }, functions, ais, routes: routes.map(row => ({ ...row, share: delegations ? 100 * Number(row.total) / delegations : null })), recent, nextCursor: hasMore ? Number(recent.at(-1)!.sequence) : null };
    });
  }
}
