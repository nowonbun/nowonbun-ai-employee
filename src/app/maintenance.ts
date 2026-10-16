import { createHash } from 'node:crypto';
import { AppError, type Store } from './store.js';
import type { Row } from './db.js';
import { parseSkill } from './domain.js';
import { Governance } from './governance.js';

// 호출자의 관리 트랜잭션 안에서 실행하며, 이력은 물리적으로 삭제하지 않습니다.
export class Maintenance {
  constructor(private readonly store: Store) {}
  require(table: string, id: string): Row {
    const row = this.store.get(table, id);
    if (!row) throw new AppError('NOT_FOUND', table, 404);
    return row;
  }
  revision(table: string, id: string, expected: number): Row {
    const row = this.require(table, id);
    const revision = Number(row.revision ?? row.version ?? this.store.row('SELECT revision FROM maintenance_revisions WHERE resource=? AND target_id=?', table, id)?.revision ?? 1);
    if (revision !== expected) throw new AppError('CONFLICT', 'revision', 409);
    return row;
  }
  private bump(table: string, id: string, revision: number) {
    this.store.run('INSERT INTO maintenance_revisions VALUES (?,?,?) ON CONFLICT(resource,target_id) DO UPDATE SET revision=excluded.revision', table, id, revision + 1);
  }
  private idle(employeeId: string) {
    if (this.store.row("SELECT id FROM runs WHERE employee_id=? AND status='running'", employeeId) || this.store.row("SELECT id FROM jobs WHERE employee_id=? AND status='running'", employeeId)) throw new AppError('SESSION_BUSY', '실행 중 Run을 먼저 중지하세요.', 409);
  }
  employeeUpdate(id: string, expected: number, input: { name: string; responsibility: string; cwd: string }) {
    this.revision('employees', id, expected);
    this.idle(id);
    this.store.run('UPDATE employees SET name=?,responsibility=?,cwd=?,revision=revision+1,updated_at=? WHERE id=?', input.name, input.responsibility, input.cwd, Date.now(), id);
    return this.require('employees', id);
  }
  employeeDelete(id: string, expected: number) {
    this.revision('employees', id, expected);
    this.idle(id);
    if (this.store.row("SELECT id FROM employees WHERE supervisor_id=? AND status='active'", id)) throw new AppError('CONFLICT', '직속 작업 AI를 먼저 재배치하세요.', 409);
    this.store.run("UPDATE employees SET status='inactive',revision=revision+1,updated_at=? WHERE id=?", Date.now(), id);
    this.store.run('DELETE FROM mcp_tokens WHERE employee_id=?', id);
    this.store.run('DELETE FROM call_permissions WHERE manager_id=? OR worker_id=?', id, id);
    this.store.run('UPDATE schedules SET enabled=0,revision=revision+1 WHERE manager_id=?', id);
    this.store.run("UPDATE jobs SET status='cancelled',updated_at=? WHERE employee_id=? AND status IN ('queued','cooldown','needs_attention','execution_unknown')", Date.now(), id);
    return { employeeId: id, status: 'inactive', historyPreserved: true };
  }
  employeeRestore(id: string, expected: number) {
    const employee = this.revision('employees', id, expected);
    if (employee.org_id) this.require('organizations', String(employee.org_id));
    if (employee.supervisor_id) {
      const supervisor = this.require('employees', String(employee.supervisor_id));
      if (supervisor.status !== 'active') throw new AppError('CONFLICT', '직속 관리 AI를 먼저 복원하거나 재배치하세요.', 409);
    }
    this.store.run("UPDATE employees SET status='active',revision=revision+1,updated_at=? WHERE id=?", Date.now(), id);
    return { ...this.require('employees', id), note: '호출 권한·일정 활성화·취소된 작업은 자동 복원하지 않습니다.' };
  }
  organizationUpdate(id: string, expected: number, name: string, parentId: string | null) {
    this.revision('organizations', id, expected);
    if (this.store.row('SELECT id FROM organizations WHERE name=? AND id<>?', name, id)) throw new AppError('CONFLICT', 'organization name', 409);
    const visited = new Set([id]);
    let parent = parentId;
    while (parent) {
      if (visited.has(parent)) throw new AppError('INVALID_INPUT', 'organization cycle');
      visited.add(parent);
      parent = this.require('organizations', parent).parent_id as string | null;
    }
    this.store.run('UPDATE organizations SET name=?,parent_id=? WHERE id=?', name, parentId, id);
    this.bump('organizations', id, expected);
    return { ...this.require('organizations', id), revision: expected + 1 };
  }
  organizationDelete(id: string, expected: number) {
    this.revision('organizations', id, expected);
    if (this.store.row("SELECT id FROM employees WHERE org_id=? AND status='active'", id) || this.store.row("SELECT id FROM organizations o WHERE parent_id=? AND NOT EXISTS (SELECT 1 FROM resource_archives a WHERE a.resource='organizations' AND a.target_id=o.id)", id)) throw new AppError('CONFLICT', '비어 있는 조직만 제거할 수 있습니다.', 409);
    return this.archive('organizations', id);
  }
  skillUpdate(id: string, expected: number, content: string) {
    this.revision('skills', id, expected);
    const parsed = parseSkill(content);
    if (this.store.row('SELECT id FROM skills WHERE name=? AND id<>?', parsed.name, id)) throw new AppError('CONFLICT', 'skill name', 409);
    const sha = createHash('sha256').update(parsed.canonical).digest('hex');
    this.store.run('UPDATE skills SET name=?,description=?,content=?,sha256=?,version=version+1 WHERE id=?', parsed.name, parsed.description, parsed.canonical, sha, id);
    this.store.run('INSERT INTO skill_versions SELECT id,version,name,description,content,sha256,? FROM skills WHERE id=?', Date.now(), id);
    return this.require('skills', id);
  }
  skillDelete(id: string, expected: number) {
    this.revision('skills', id, expected);
    if (new Governance(this.store).policy().skillIds.includes(id) || this.store.row('SELECT s.id FROM sessions s,json_each(s.skill_ids) i WHERE i.value=? LIMIT 1', id)) throw new AppError('CONFLICT', '정책·세션에서 참조 중인 스킬은 제거할 수 없습니다.', 409);
    return this.archive('skills', id);
  }
  personaUpdate(id: string, expected: number, name: string, content: string) {
    this.revision('personas', id, expected);
    if (this.store.row('SELECT id FROM personas WHERE name=? AND id<>?', name, id)) throw new AppError('CONFLICT', 'persona name', 409);
    this.store.run('UPDATE personas SET name=?,content=?,version=version+1 WHERE id=?', name, content, id);
    this.store.run('INSERT INTO persona_versions SELECT id,version,name,content,? FROM personas WHERE id=?', Date.now(), id);
    return this.require('personas', id);
  }
  personaDelete(id: string, expected: number) {
    this.revision('personas', id, expected);
    return this.archive('personas', id);
  }
  private archive(resource: string, id: string) {
    this.store.run('INSERT INTO resource_archives VALUES (?,?,?)', resource, id, Date.now());
    return { id, resource, status: 'archived', historyPreserved: true };
  }
  restore(resource: 'organizations' | 'skills' | 'personas' | 'schedules' | 'model_prices', id: string) {
    const archive = this.store.row('SELECT * FROM resource_archives WHERE resource=? AND target_id=?', resource, id);
    if (!archive) throw new AppError('NOT_FOUND', 'archive', 404);
    if (resource === 'organizations') {
      const org = this.store.row('SELECT * FROM organizations WHERE id=?', id)!;
      if (org.parent_id) this.require('organizations', String(org.parent_id));
    }
    this.store.run('DELETE FROM resource_archives WHERE resource=? AND target_id=?', resource, id);
    return this.require(resource, id);
  }
  scheduleDelete(id: string, expected: number) {
    this.revision('schedules', id, expected);
    this.store.run('UPDATE schedules SET enabled=0,revision=revision+1 WHERE manager_id=?', id);
    return this.archive('schedules', id);
  }
  priceDelete(model: string, expected: number) {
    this.revision('model_prices', model, expected);
    return this.archive('model_prices', model);
  }
  jobControl(id: string, expectedStatus: string, action: 'resume' | 'cancel', reason: string) {
    const job = this.require('jobs', id);
    if (job.status !== expectedStatus) throw new AppError('CONFLICT', 'job status', 409);
    if (!['cooldown', 'needs_attention', 'execution_unknown', 'queued'].includes(String(job.status))) throw new AppError('CONFLICT', '작업 상태가 재개·취소 대상이 아닙니다.', 409);
    const employee = this.require('employees', String(job.employee_id));
    if (employee.status !== 'active') throw new AppError('CONFLICT', 'employee inactive', 409);
    const session = this.require('sessions', String(job.session_id));
    if (action === 'resume' && (!session.codex_id || session.is_current !== 1)) throw new AppError('CONFLICT', '현재 Codex 세션만 재개할 수 있습니다.', 409);
    const previousRun = this.store.row('SELECT * FROM runs WHERE job_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1', id);
    if (action === 'resume' && (job.status === 'execution_unknown' || (previousRun && this.store.row("SELECT id FROM events WHERE run_id=? AND kind='tool' LIMIT 1", String(previousRun.id))))) throw new AppError('CONFLICT', '실행 결과 불명·도구 실행 이력이 있는 작업은 자동 재접수하지 않습니다. 원본과 외부 부작용을 먼저 확인하세요.', 409);
    this.idle(String(job.employee_id));
    const dueAt = action === 'resume' ? Math.max(Date.now(), Number(job.due_at), previousRun?.ended_at ? Number(previousRun.ended_at) + 60000 : 0) : Number(job.due_at);
    this.store.run('UPDATE jobs SET status=?,due_at=?,updated_at=? WHERE id=?', action === 'resume' ? 'queued' : 'cancelled', dueAt, Date.now(), id);
    this.store.audit('external-admin', 'job.control', id, { action, reason });
    return this.require('jobs', id);
  }
}
