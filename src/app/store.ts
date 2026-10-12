import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CronExpressionParser } from 'cron-parser';
import { openDatabase, type Row } from './db.js';
import { parseSkill, progress, type Criterion } from './domain.js';

export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(`${code}: ${message}`); }
}
const id = () => randomUUID();
const timestamp = () => Date.now();
const encode = (value: unknown) => JSON.stringify(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function need(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError('INVALID_INPUT', field);
  return value.trim();
}
function optional(value: unknown, max = 4000): string {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new AppError('INVALID_INPUT', 'text');
  return value.trim();
}
const tables = new Set(['employees','sessions','organizations','call_permissions','operations','work_orders','tasks','work_logs','work_processes','work_cycles','jobs','runs','events','inbox','schedules','wake_events','skills','personas','model_prices','settings','audit_events','interviews','interview_messages']);

export class Store {
  readonly db: DatabaseSync;
  constructor(file: string) { this.db = openDatabase(file); }
  close(): void { this.db.close(); }
  row(sql: string, ...args: (string | number | null)[]): Row | undefined { return this.db.prepare(sql).get(...args) as Row | undefined; }
  rows(sql: string, ...args: (string | number | null)[]): Row[] { return this.db.prepare(sql).all(...args) as Row[]; }
  run(sql: string, ...args: (string | number | null)[]): void { this.db.prepare(sql).run(...args); }
  tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  audit(actor: string, action: string, target: string, detail: unknown = {}): void { this.run('INSERT INTO audit_events VALUES (?,?,?,?,?,?)', id(), actor, action, target, encode(detail), timestamp()); }
  mutate<T>(actor: string, action: string, key: string, payload: unknown, fn: (operationId: string) => T): T {
    need(actor, 'actor'); need(key, 'idempotency_key', 200);
    const payloadHash = digest(encode(payload));
    return this.tx(() => {
      const prior = this.row('SELECT * FROM operations WHERE actor=? AND action=? AND idem_key=?', actor, action, key);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError('CONFLICT', 'idempotency payload', 409);
        return JSON.parse(String(prior.result_json)) as T;
      }
      const operationId = id(); const at = timestamp();
      this.run('INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,?,?)', operationId, actor, action, key, payloadHash, 'accepted', null, null, at, at);
      const result = fn(operationId);
      this.run('UPDATE operations SET result_json=?,updated_at=? WHERE id=?', encode(result), timestamp(), operationId);
      return result;
    });
  }
  list(table: string): Row[] {
    if (!tables.has(table)) throw new AppError('FORBIDDEN', 'table', 403);
    return this.rows(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 500`);
  }
  get(table: string, key: string): Row | undefined {
    if (!tables.has(table)) throw new AppError('FORBIDDEN', 'table', 403);
    const column = table === 'model_prices' ? 'model' : table === 'schedules' ? 'manager_id' : 'id';
    return this.row(`SELECT * FROM ${table} WHERE ${column}=?`, key);
  }
  enqueue(employeeId: string, sessionId: string, kind: string, refId: string | null, prompt: string, operationId: string | null, dueAt = timestamp()): string {
    const jobId = id(); const at = timestamp();
    this.run('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', jobId, employeeId, sessionId, kind, refId, prompt, 'queued', 0, dueAt, operationId, at, at);
    return jobId;
  }
  employeeCreate(actor: string, key: string, input: { name: string; responsibility: string; role: string; model: string; persona: string; skillIds: string[]; cwd: string; label?: string }): { operationId: string; employeeId: string; sessionId: string; status: string } {
    const name = need(input?.name, 'name', 100); const responsibility = need(input?.responsibility, 'responsibility', 500);
    if (input.role !== 'manager' && input.role !== 'worker') throw new AppError('INVALID_INPUT', 'role');
    const model = need(input.model, 'model', 80); const persona = optional(input.persona, 10000); const cwd = need(input.cwd, 'cwd', 1000);
    if (!Array.isArray(input.skillIds) || input.skillIds.some(x => typeof x !== 'string')) throw new AppError('INVALID_INPUT', 'skillIds');
    const label = optional(input.label, 100) || `${name} - 初回 Session`;
    return this.mutate(actor, 'employee.create', key, input, operationId => {
      for (const skillId of input.skillIds) if (!this.get('skills', skillId)) throw new AppError('INVALID_INPUT', 'skillIds');
      const employeeId = id(); const sessionId = id(); const at = timestamp();
      this.run('INSERT INTO employees VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', employeeId, name, responsibility, input.role, 'active', null, null, model, persona, encode(input.skillIds), cwd, 1, at, at);
      this.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)', sessionId, employeeId, label, null, 'pending', 1, model, persona, encode(input.skillIds), 1, at);
      this.enqueue(employeeId, sessionId, 'initialize', null, '세션을 초기화하세요. 응답은 간결하게 작성하세요.', operationId);
      this.audit(actor, 'employee.create', employeeId, { sessionId });
      return { operationId, employeeId, sessionId, status: 'accepted' };
    });
  }
  employeeConfig(actor: string, sessionId: string, expectedRevision: number, input: { model: string; persona: string; skillIds: string[] }): Row {
    return this.tx(() => {
      const session = this.row('SELECT * FROM sessions WHERE id=? AND is_current=1', sessionId);
      if (!session) throw new AppError('NOT_FOUND', 'session', 404);
      if (session.revision !== expectedRevision) throw new AppError('CONFLICT', 'revision', 409);
      const model = need(input.model, 'model', 80); const persona = optional(input.persona, 10000);
      if (!Array.isArray(input.skillIds)) throw new AppError('INVALID_INPUT', 'skillIds');
      for (const skillId of input.skillIds) if (!this.get('skills', skillId)) throw new AppError('INVALID_INPUT', 'skillIds');
      this.run('UPDATE sessions SET model=?,persona=?,skill_ids=?,revision=revision+1 WHERE id=?', model, persona, encode(input.skillIds), sessionId);
      this.run('UPDATE employees SET model=?,persona=?,skill_ids=?,revision=revision+1,updated_at=? WHERE id=?', model, persona, encode(input.skillIds), timestamp(), String(session.employee_id));
      this.audit(actor, 'session.config', sessionId, { model }); return this.get('sessions', sessionId)!;
    });
  }
  employeeSessionAdd(actor: string, key: string, employeeId: string, input: { label?: string; model: string; persona: string; skillIds: string[] }): { sessionId: string; operationId: string } {
    const model = need(input.model, 'model', 80); const persona = optional(input.persona, 10000);
    if (!Array.isArray(input.skillIds)) throw new AppError('INVALID_INPUT', 'skillIds');
    return this.mutate(actor, 'employee.session.add', key, { employeeId, ...input }, operationId => {
      const employee = this.get('employees', employeeId);
      if (!employee || employee.status !== 'active') throw new AppError('NOT_FOUND', 'employee', 404);
      if (this.row("SELECT id FROM jobs WHERE employee_id=? AND status='running'", employeeId)) throw new AppError('SESSION_BUSY', 'running', 409);
      if (this.row("SELECT id FROM sessions WHERE employee_id=? AND status='pending_replacement'", employeeId)) throw new AppError('CONFLICT', 'replacement pending', 409);
      for (const skillId of input.skillIds) if (!this.get('skills', skillId)) throw new AppError('INVALID_INPUT', 'skillIds');
      const sessionId = id(); const label = optional(input.label, 100) || `${employee.name} - 新 Session`;
      this.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)', sessionId, employeeId, label, null, 'pending_replacement', 0, model, persona, encode(input.skillIds), 1, timestamp());
      this.enqueue(employeeId, sessionId, 'initialize', null, '새 업무 세션을 초기화하세요.', operationId);
      this.audit(actor, 'employee.session.add', sessionId, { employeeId }); return { sessionId, operationId };
    });
  }
  organizationCreate(actor: string, key: string, input: { name: string; parentId?: string | null }): { operationId: string; organizationId: string } {
    const name = need(input?.name, 'name', 100);
    return this.mutate(actor, 'organization.create', key, input, operationId => {
      if (input.parentId && !this.get('organizations', input.parentId)) throw new AppError('NOT_FOUND', 'parent', 404);
      if (this.row('SELECT id FROM organizations WHERE name=?', name)) throw new AppError('CONFLICT', 'name', 409);
      const organizationId = id(); this.run('INSERT INTO organizations VALUES (?,?,?,?)', organizationId, name, input.parentId ?? null, timestamp());
      this.audit(actor, 'organization.create', organizationId); return { operationId, organizationId };
    });
  }
  assignEmployee(organizationId: string, employeeId: string, supervisorId: string | null): Row {
    return this.tx(() => {
      if (!this.get('organizations', organizationId)) throw new AppError('NOT_FOUND', 'organization', 404);
      const employee = this.get('employees', employeeId);
      if (!employee || employee.status !== 'active') throw new AppError('NOT_FOUND', 'employee', 404);
      if (employee.org_id !== null) throw new AppError('CONFLICT', 'already assigned', 409);
      this.checkSupervisor(employee, organizationId, supervisorId);
      this.run('UPDATE employees SET org_id=?,supervisor_id=?,revision=revision+1,updated_at=? WHERE id=?', organizationId, supervisorId, timestamp(), employeeId);
      this.audit('operator', 'employee.assign', employeeId, { organizationId, supervisorId }); return this.get('employees', employeeId)!;
    });
  }
  private checkSupervisor(employee: Row, organizationId: string, supervisorId: string | null): void {
    if (!supervisorId) return;
    const supervisor = this.get('employees', supervisorId);
    if (!supervisor || supervisor.role !== 'manager' || supervisor.status !== 'active' || supervisor.org_id !== organizationId || employee.role !== 'worker') throw new AppError('INVALID_INPUT', 'supervisor');
  }
  transferEmployee(employeeId: string, organizationId: string, supervisorId: string | null, reason: string): Row {
    need(reason, 'reason', 500);
    return this.tx(() => {
      const employee = this.get('employees', employeeId);
      if (!employee || !this.get('organizations', organizationId)) throw new AppError('NOT_FOUND', 'employee or organization', 404);
      if (this.row("SELECT id FROM runs WHERE employee_id=? AND status='running'", employeeId)) throw new AppError('SESSION_BUSY', 'running', 409);
      this.checkSupervisor(employee, organizationId, supervisorId);
      this.run('DELETE FROM call_permissions WHERE worker_id=? OR manager_id=?', employeeId, employeeId);
      this.run('UPDATE employees SET org_id=?,supervisor_id=?,revision=revision+1,updated_at=? WHERE id=?', organizationId, supervisorId, timestamp(), employeeId);
      this.audit('operator', 'employee.transfer', employeeId, { from: employee.org_id, to: organizationId, reason }); return this.get('employees', employeeId)!;
    });
  }
  setCallPermissions(managerId: string, workerIds: string[]): { managerId: string; workerIds: string[] } {
    if (!Array.isArray(workerIds) || new Set(workerIds).size !== workerIds.length) throw new AppError('INVALID_INPUT', 'workerIds');
    return this.tx(() => {
      const manager = this.get('employees', managerId);
      if (!manager || manager.role !== 'manager' || manager.status !== 'active') throw new AppError('NOT_FOUND', 'manager', 404);
      for (const workerId of workerIds) { const worker = this.get('employees', workerId); if (!worker || worker.role !== 'worker' || worker.status !== 'active') throw new AppError('INVALID_INPUT', 'workerId'); }
      this.run('DELETE FROM call_permissions WHERE manager_id=?', managerId);
      for (const workerId of workerIds) this.run('INSERT INTO call_permissions VALUES (?,?,?)', managerId, workerId, timestamp());
      this.audit('operator', 'call_permission.replace', managerId, { workerIds }); return { managerId, workerIds };
    });
  }
  workOrderCreate(actor: string, key: string, input: { title: string; body: string; acceptance: string; managerId: string; interviewId?: string }): { operationId: string; workOrderId: string; status: string } {
    const title = need(input?.title, 'title', 200); const body = need(input?.body, 'body', 10000); const acceptance = need(input?.acceptance, 'acceptance', 3000);
    return this.mutate(actor, 'work_order.create', key, input, operationId => {
      const manager = this.get('employees', input.managerId);
      if (!manager || manager.role !== 'manager' || manager.status !== 'active') throw new AppError('INVALID_INPUT', 'managerId');
      const workOrderId = id(); const at = timestamp();
      this.run('INSERT INTO work_orders VALUES (?,?,?,?,?,?,?,?,?,?,?)', workOrderId, input.managerId, title, body, acceptance, 'queued', null, 1, input.interviewId ?? null, at, at);
      this.run('INSERT INTO inbox VALUES (?,?,?,?,?,?)', id(), input.managerId, 'work_order', workOrderId, null, at);
      this.audit(actor, 'work_order.create', workOrderId); return { operationId, workOrderId, status: 'queued' };
    });
  }
  taskDelegate(managerId: string, key: string, input: { workOrderId?: string; parentTaskId?: string; workerId: string; title: string; goal: string; criteria: Criterion[] }): { operationId: string; taskId: string; jobId: string } {
    const title = need(input?.title, 'title', 200); const goal = need(input?.goal, 'goal', 5000);
    if (!Array.isArray(input.criteria) || !input.criteria.length || input.criteria.some(c => !c.id || !c.label || !Number.isFinite(c.weight) || c.weight <= 0) || new Set(input.criteria.map(c => c.id)).size !== input.criteria.length) throw new AppError('INVALID_INPUT', 'criteria');
    if (Boolean(input.workOrderId) === Boolean(input.parentTaskId)) throw new AppError('INVALID_INPUT', 'parent reference');
    return this.mutate(managerId, 'task.delegate', key, input, operationId => {
      const manager = this.get('employees', managerId); const worker = this.get('employees', input.workerId);
      if (!manager || manager.role !== 'manager' || !worker || worker.role !== 'worker' || !this.row('SELECT * FROM call_permissions WHERE manager_id=? AND worker_id=?', managerId, input.workerId)) throw new AppError('FORBIDDEN', 'call permission', 403);
      if (input.workOrderId) { const order = this.get('work_orders', input.workOrderId); if (!order || order.manager_id !== managerId || order.status === 'paused') throw new AppError('FORBIDDEN', 'work order', 403); }
      if (input.parentTaskId) { const parent = this.get('tasks', input.parentTaskId); if (!parent || parent.manager_id !== managerId) throw new AppError('FORBIDDEN', 'parent task', 403); }
      const session = this.row('SELECT * FROM sessions WHERE employee_id=? AND is_current=1', input.workerId);
      if (!session) throw new AppError('NOT_FOUND', 'worker session', 404);
      const taskId = id(); const at = timestamp();
      const criteria = input.criteria.map(c => ({ id: c.id, label: c.label, weight: c.weight, verified: false, evidence: null }));
      this.run('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', taskId, input.workOrderId ?? null, input.parentTaskId ?? null, managerId, input.workerId, title, goal, encode(criteria), 'queued', null, 1, at, at);
      const jobId = this.enqueue(input.workerId, String(session.id), 'task', taskId, `Task: ${title}\n목적: ${goal}`, operationId);
      this.audit(managerId, 'task.delegate', taskId, { workerId: input.workerId }); return { operationId, taskId, jobId };
    });
  }
  workLogAppend(actorId: string, key: string, input: { taskId: string; summary: string; completed?: string; evidence?: string; remaining?: string; nextStep?: string }): { workLogId: string; taskId: string } {
    const summary = need(input?.summary, 'summary', 3000);
    return this.mutate(actorId, 'work_log.append', key, input, () => {
      const task = this.get('tasks', input.taskId);
      if (!task || task.worker_id !== actorId) throw new AppError('FORBIDDEN', 'work log author', 403);
      const workLogId = id();
      this.run('INSERT INTO work_logs VALUES (?,?,?,?,?,?,?,?,?,?)', workLogId, input.taskId, actorId, summary, optional(input.completed), optional(input.evidence), optional(input.remaining), optional(input.nextStep), Number(task.revision), timestamp());
      this.audit(actorId, 'work_log.append', workLogId, { taskId: input.taskId }); return { workLogId, taskId: input.taskId };
    });
  }
  taskCheckpoint(actorId: string, key: string, input: { taskId: string; expectedRevision: number; criterionId: string; evidence: string }): { taskId: string; revision: number; progress: number | null } {
    const evidence = need(input?.evidence, 'evidence', 3000);
    return this.mutate(actorId, 'task.checkpoint', key, input, () => {
      const task = this.get('tasks', input.taskId);
      if (!task || task.worker_id !== actorId) throw new AppError('FORBIDDEN', 'task assignment', 403);
      if (task.revision !== input.expectedRevision) throw new AppError('CONFLICT', 'task revision', 409);
      const criteria = JSON.parse(String(task.criteria_json)) as Criterion[];
      const item = criteria.find(c => c.id === input.criterionId);
      if (!item) throw new AppError('INVALID_INPUT', 'criterionId');
      item.verified = true; item.evidence = evidence;
      this.run('UPDATE tasks SET criteria_json=?,revision=revision+1,updated_at=? WHERE id=?', encode(criteria), timestamp(), input.taskId);
      this.audit(actorId, 'task.checkpoint', input.taskId, { criterionId: input.criterionId, evidence });
      return { taskId: input.taskId, revision: Number(task.revision) + 1, progress: progress(criteria) };
    });
  }
  taskResultSubmit(actorId: string, key: string, input: { taskId: string; expectedRevision: number; result: string; evidence: string }): { taskId: string; status: string } {
    const result = need(input?.result, 'result', 10000); const evidence = need(input?.evidence, 'evidence', 3000);
    return this.mutate(actorId, 'task.result', key, input, () => {
      const task = this.get('tasks', input.taskId);
      if (!task || task.worker_id !== actorId) throw new AppError('FORBIDDEN', 'task assignment', 403);
      if (task.revision !== input.expectedRevision) throw new AppError('CONFLICT', 'task revision', 409);
      this.run("UPDATE tasks SET status='reviewing',result=?,revision=revision+1,updated_at=? WHERE id=?", result, timestamp(), input.taskId);
      this.run('INSERT INTO inbox VALUES (?,?,?,?,?,?)', id(), String(task.manager_id), 'task_result', input.taskId, null, timestamp());
      this.audit(actorId, 'task.result', input.taskId, { evidence }); return { taskId: input.taskId, status: 'reviewing' };
    });
  }
  workOrderReportSubmit(actorId: string, key: string, input: { workOrderId: string; expectedRevision: number; report: string; evidence: string }): { workOrderId: string; status: string } {
    const report = need(input?.report, 'report', 20000); const evidence = need(input?.evidence, 'evidence', 5000);
    return this.mutate(actorId, 'work_order.report', key, input, () => {
      const order = this.get('work_orders', input.workOrderId);
      if (!order || order.manager_id !== actorId) throw new AppError('FORBIDDEN', 'work order', 403);
      if (order.revision !== input.expectedRevision) throw new AppError('CONFLICT', 'work order revision', 409);
      const tasks = this.rows('SELECT * FROM tasks WHERE work_order_id=?', input.workOrderId);
      const unverified = tasks.some(task => !['reviewing','completed'].includes(String(task.status)) || (JSON.parse(String(task.criteria_json)) as Criterion[]).some(c => !c.verified || !c.evidence?.trim()));
      const openCycles = this.row("SELECT c.id FROM work_cycles c JOIN work_processes p ON p.id=c.process_id WHERE p.work_order_id=? AND c.outcome IN ('due','missed') LIMIT 1", input.workOrderId);
      const status = unverified || openCycles ? 'needs_attention' : 'reported';
      this.run('UPDATE work_orders SET status=?,report=?,revision=revision+1,updated_at=? WHERE id=?', status, report, timestamp(), input.workOrderId);
      this.audit(actorId, 'work_order.report', input.workOrderId, { evidence, status }); return { workOrderId: input.workOrderId, status };
    });
  }
  processCreate(managerId: string, key: string, input: { workOrderId: string; title: string; cron: string; timezone: string; deadlineMinutes: number }): { processId: string } {
    const title = need(input?.title, 'title', 200); const cron = need(input?.cron, 'cron', 100); const timezone = need(input?.timezone, 'timezone', 100);
    if (cron.split(/\s+/).length !== 5 || !Number.isInteger(input.deadlineMinutes) || input.deadlineMinutes < 1 || input.deadlineMinutes > 10080) throw new AppError('INVALID_INPUT', 'cadence or deadline');
    try { CronExpressionParser.parse(cron, { tz: timezone }).next(); } catch { throw new AppError('INVALID_INPUT', 'cadence'); }
    return this.mutate(managerId, 'work_process.create', key, input, () => {
      const order = this.get('work_orders', input.workOrderId);
      if (!order || order.manager_id !== managerId) throw new AppError('FORBIDDEN', 'work order', 403);
      const processId = id(); const at = timestamp();
      this.run('INSERT INTO work_processes VALUES (?,?,?,?,?,?,?,?,?,?)', processId, input.workOrderId, managerId, title, cron, timezone, input.deadlineMinutes, 'active', at, at);
      this.audit(managerId, 'work_process.create', processId); return { processId };
    });
  }
  cycleEnsure(processId: string, scheduledAt: number, observedAt: number): { cycleId: string; outcome: string } {
    return this.tx(() => {
      const process = this.get('work_processes', processId);
      if (!process || process.status !== 'active') throw new AppError('NOT_FOUND', 'work process', 404);
      if (!Number.isSafeInteger(scheduledAt) || !Number.isSafeInteger(observedAt) || observedAt < scheduledAt) throw new AppError('INVALID_INPUT', 'scheduled time');
      const actual = CronExpressionParser.parse(String(process.cron), { tz: String(process.timezone), currentDate: new Date(scheduledAt + 1000) }).prev().getTime();
      if (actual !== scheduledAt) throw new AppError('INVALID_INPUT', 'not a scheduled occurrence');
      const existing = this.row('SELECT * FROM work_cycles WHERE process_id=? AND scheduled_at=?', processId, scheduledAt);
      const expired = observedAt > scheduledAt + Number(process.deadline_minutes) * 60000;
      if (existing) {
        if (existing.outcome === 'due' && expired) this.run("UPDATE work_cycles SET outcome='missed',updated_at=? WHERE id=?", observedAt, String(existing.id));
        const current = this.get('work_cycles', String(existing.id))!; return { cycleId: String(current.id), outcome: String(current.outcome) };
      }
      const cycleId = id(); const outcome = expired ? 'missed' : 'due';
      this.run('INSERT INTO work_cycles VALUES (?,?,?,?,?,?,?,?)', cycleId, processId, scheduledAt, outcome, '', '[]', observedAt, observedAt);
      this.audit('scheduler', 'work_cycle.ensure', cycleId, { outcome }); return { cycleId, outcome };
    });
  }
  cycleRecord(managerId: string, key: string, input: { processId: string; scheduledAt: number; outcome: 'done' | 'skipped_with_reason'; evidence: string; derivedTaskIds: string[] }): { cycleId: string; outcome: string } {
    const evidence = need(input?.evidence, 'evidence or reason', 5000);
    if (!['done','skipped_with_reason'].includes(input.outcome) || !Array.isArray(input.derivedTaskIds)) throw new AppError('INVALID_INPUT', 'outcome or tasks');
    return this.mutate(managerId, 'work_cycle.record', key, input, () => {
      const process = this.get('work_processes', input.processId);
      if (!process || process.manager_id !== managerId) throw new AppError('FORBIDDEN', 'work process', 403);
      const cycle = this.row('SELECT * FROM work_cycles WHERE process_id=? AND scheduled_at=?', input.processId, input.scheduledAt);
      if (!cycle) throw new AppError('NOT_FOUND', 'scheduled cycle', 404);
      for (const taskId of input.derivedTaskIds) { const task = this.get('tasks', taskId); if (!task || task.work_order_id !== process.work_order_id) throw new AppError('INVALID_INPUT', 'derived task'); }
      this.run('UPDATE work_cycles SET outcome=?,evidence=?,derived_task_ids=?,updated_at=? WHERE id=?', input.outcome, evidence, encode(input.derivedTaskIds), timestamp(), String(cycle.id));
      this.audit(managerId, 'work_cycle.record', String(cycle.id), { from: cycle.outcome, to: input.outcome });
      return { cycleId: String(cycle.id), outcome: input.outcome };
    });
  }
  processSummary(processId: string): { due: number; done: number; missed: number; skipped: number; progress: null } {
    if (!this.get('work_processes', processId)) throw new AppError('NOT_FOUND', 'work process', 404);
    const cycles = this.rows('SELECT outcome FROM work_cycles WHERE process_id=?', processId);
    return { due: cycles.length, done: cycles.filter(c => c.outcome === 'done').length, missed: cycles.filter(c => c.outcome === 'missed').length, skipped: cycles.filter(c => c.outcome === 'skipped_with_reason').length, progress: null };
  }
  skillCreate(actor: string, key: string, content: string): { skillId: string; name: string } {
    const parsed = parseSkill(content);
    return this.mutate(actor, 'skill.create', key, parsed.canonical, () => {
      if (this.row('SELECT id FROM skills WHERE name=?', parsed.name)) throw new AppError('CONFLICT', 'skill name', 409);
      const skillId = id(); this.run('INSERT INTO skills VALUES (?,?,?,?,?,?,?)', skillId, parsed.name, parsed.description, parsed.canonical, digest(parsed.canonical), 1, timestamp());
      this.audit(actor, 'skill.create', skillId); return { skillId, name: parsed.name };
    });
  }
  personaCreate(actor: string, key: string, input: { name: string; content: string }): { personaId: string } {
    const name = need(input?.name, 'name', 100); const content = need(input?.content, 'content', 10000);
    return this.mutate(actor, 'persona.create', key, input, () => {
      if (this.row('SELECT id FROM personas WHERE name=?', name)) throw new AppError('CONFLICT', 'persona name', 409);
      const personaId = id(); this.run('INSERT INTO personas VALUES (?,?,?,?,?)', personaId, name, content, 1, timestamp());
      this.audit(actor, 'persona.create', personaId); return { personaId };
    });
  }
  putPrice(model: string, input: { input: number | null; cachedInput: number | null; output: number | null }): { model: string; input: number | null; cachedInput: number | null; output: number | null; unit: string } {
    need(model, 'model', 80);
    for (const value of [input.input, input.cachedInput, input.output]) if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new AppError('INVALID_INPUT', 'price');
    return this.tx(() => {
      this.run('INSERT INTO model_prices VALUES (?,?,?,?,?,?) ON CONFLICT(model) DO UPDATE SET input_price=excluded.input_price,cached_input_price=excluded.cached_input_price,output_price=excluded.output_price,version=model_prices.version+1,updated_at=excluded.updated_at', model, input.input, input.cachedInput, input.output, 1, timestamp());
      this.audit('operator', 'model_price.put', model); return this.getPrice(model)!;
    });
  }
  settingPut(key: 'log_source_root', value: string, expectedRevision: number): Row {
    need(value, 'log_source_root', 1000);
    return this.tx(() => {
      const prior = this.settingGet(key);
      if ((prior?.revision ?? 0) !== expectedRevision) throw new AppError('CONFLICT', 'settings revision', 409);
      this.run('INSERT INTO settings VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,revision=settings.revision+1,updated_at=excluded.updated_at', key, value, 1, timestamp());
      this.audit('operator', 'settings.log_source_root', key, { value });
      return this.settingGet(key)!;
    });
  }
  settingGet(key: 'log_source_root'): Row | null { return this.row('SELECT * FROM settings WHERE key=?', key) ?? null; }
  getPrice(model: string): { model: string; input: number | null; cachedInput: number | null; output: number | null; unit: string } | null {
    const price = this.get('model_prices', model);
    return price ? { model, input: price.input_price as number | null, cachedInput: price.cached_input_price as number | null, output: price.output_price as number | null, unit: 'USD/1M' } : null;
  }
  schedulePut(managerId: string, input: { cron: string; timezone: string; enabled: boolean; prompt: string }): Row {
    const expression = need(input?.cron, 'cron', 100); const timezone = need(input?.timezone, 'timezone', 100); const prompt = need(input?.prompt, 'prompt', 5000);
    if (expression.split(/\s+/).length !== 5) throw new AppError('INVALID_INPUT', 'five-field cron');
    try { new Intl.DateTimeFormat('ko-KR', { timeZone: timezone }); } catch { throw new AppError('INVALID_INPUT', 'timezone'); }
    try { CronExpressionParser.parse(expression, { tz: timezone }).next(); } catch { throw new AppError('INVALID_INPUT', 'cron'); }
    return this.tx(() => {
      const manager = this.get('employees', managerId);
      if (!manager || manager.role !== 'manager') throw new AppError('INVALID_INPUT', 'manager');
      this.run('INSERT INTO schedules VALUES (?,?,?,?,?,?,?) ON CONFLICT(manager_id) DO UPDATE SET cron=excluded.cron,timezone=excluded.timezone,enabled=excluded.enabled,prompt=excluded.prompt,revision=schedules.revision+1,updated_at=excluded.updated_at', managerId, expression, timezone, input.enabled ? 1 : 0, prompt, 1, timestamp());
      this.audit('operator', 'schedule.put', managerId); return this.get('schedules', managerId)!;
    });
  }
  wake(managerId: string, at: number, reason = 'cron'): { wakeEventId: string; jobId: string | null } {
    return this.tx(() => {
      const prior = this.row('SELECT * FROM wake_events WHERE manager_id=? AND scheduled_at=? AND reason=?', managerId, at, reason);
      if (prior) return { wakeEventId: String(prior.id), jobId: String(this.row("SELECT id FROM jobs WHERE kind='manager' AND ref_id=?", String(prior.id))?.id ?? '') || null };
      const manager = this.get('employees', managerId); const session = this.row('SELECT * FROM sessions WHERE employee_id=? AND is_current=1', managerId);
      if (!manager || manager.role !== 'manager' || !session) throw new AppError('NOT_FOUND', 'manager session', 404);
      const wakeEventId = id(); this.run('INSERT INTO wake_events VALUES (?,?,?,?,?)', wakeEventId, managerId, at, reason, timestamp());
      const schedule = this.get('schedules', managerId); const prompt = schedule ? String(schedule.prompt) : '보류 중인 업무 지시와 결과를 확인하세요.';
      const jobId = this.enqueue(managerId, String(session.id), 'manager', wakeEventId, prompt, null);
      this.audit('scheduler', 'manager.wake', wakeEventId, { managerId, reason }); return { wakeEventId, jobId };
    });
  }
  claimJob(): Row | null {
    return this.tx(() => {
      const job = this.row("SELECT * FROM jobs j WHERE j.status IN ('queued','cooldown') AND j.due_at<=? AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.session_id=j.session_id AND r.status='running') ORDER BY j.created_at LIMIT 1", timestamp());
      if (!job) return null;
      this.run("UPDATE jobs SET status='running',attempt=attempt+1,updated_at=? WHERE id=?", timestamp(), String(job.id));
      return this.get('jobs', String(job.id))!;
    });
  }
  recoverInterrupted(): number {
    const jobs = this.rows("SELECT * FROM jobs WHERE status='running'");
    this.tx(() => {
      this.run('DELETE FROM mcp_tokens');
      for (const job of jobs) {
        this.run("UPDATE jobs SET status='needs_attention',updated_at=? WHERE id=?", timestamp(), String(job.id));
        this.run("UPDATE runs SET status='execution_unknown',reason='runner_restart',ended_at=? WHERE job_id=? AND status='running'", timestamp(), String(job.id));
      }
    });
    return jobs.length;
  }
  startRun(job: Row, model: string): string {
    const runId = id(); this.run('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)', runId, String(job.id), String(job.session_id), String(job.employee_id), 'running', model, null, null, timestamp(), null);
    return runId;
  }
  finishRun(runId: string, jobId: string, status: string, exitCode: number | null, reason: string, retryDueAt: number | null): void {
    this.tx(() => {
      this.run('UPDATE runs SET status=?,exit_code=?,reason=?,ended_at=? WHERE id=?', status, exitCode, reason, timestamp(), runId);
      this.run('UPDATE jobs SET status=?,due_at=?,updated_at=? WHERE id=?', retryDueAt === null ? status : 'cooldown', retryDueAt ?? timestamp(), timestamp(), jobId);
      const job = this.get('jobs', jobId);
      if (job?.operation_id) this.run('UPDATE operations SET status=?,error=?,updated_at=? WHERE id=?', status, reason || null, timestamp(), String(job.operation_id));
    });
  }
  bindCodexSession(sessionId: string, codexId: string): void {
    if (!/^[0-9a-f-]{36}$/i.test(codexId)) throw new AppError('INVALID_INPUT', 'Codex session ID');
    this.tx(() => {
      const session = this.get('sessions', sessionId);
      if (!session) throw new AppError('NOT_FOUND', 'session', 404);
      if (session.codex_id && session.codex_id !== codexId) throw new AppError('CONFLICT', 'Codex session ID changed', 409);
      if (session.status === 'pending_replacement') this.run('UPDATE sessions SET is_current=0 WHERE employee_id=? AND is_current=1', String(session.employee_id));
      this.run("UPDATE sessions SET codex_id=?,status='ready',is_current=? WHERE id=?", codexId, session.status === 'pending_replacement' ? 1 : Number(session.is_current), sessionId);
    });
  }
  appendEvent(sessionId: string, runId: string | null, kind: string, content: string, source = 'runner'): void {
    this.run('INSERT INTO events(session_id,run_id,kind,content,source,created_at) VALUES (?,?,?,?,?,?)', sessionId, runId, kind, content.slice(0, 50000), source, timestamp());
  }
  importLogEvent(sessionId: string, sourceKey: string, kind: string, content: string): boolean {
    return this.tx(() => {
      if (this.row('SELECT source_key FROM log_imports WHERE source_key=?', sourceKey)) return false;
      this.run('INSERT INTO log_imports VALUES (?,?,?)', sourceKey, sessionId, timestamp());
      this.appendEvent(sessionId, null, kind, content, 'codex-log');
      return true;
    });
  }
  eventsForSession(sessionId: string, cursor = 0, limit = 100): Row[] {
    return this.rows('SELECT * FROM events WHERE session_id=? AND id>? ORDER BY id LIMIT ?', sessionId, cursor, Math.min(Math.max(limit, 1), 200));
  }
  inboxFor(employeeId: string): Row[] { return this.rows('SELECT * FROM inbox WHERE recipient_id=? AND consumed_at IS NULL ORDER BY created_at LIMIT 100', employeeId); }
  inboxAck(employeeId: string, inboxId: string): void { this.run('UPDATE inbox SET consumed_at=? WHERE id=? AND recipient_id=?', timestamp(), inboxId, employeeId); }
  tokenIssue(employeeId: string, ttlMs = 3600000): string {
    const token = `${id()}${id()}`; this.run('INSERT INTO mcp_tokens VALUES (?,?,?)', digest(token), employeeId, timestamp() + ttlMs); return token;
  }
  tokenResolve(token: string): string | null {
    const row = this.row('SELECT employee_id FROM mcp_tokens WHERE token_hash=? AND expires_at>?', digest(token), timestamp());
    return row ? String(row.employee_id) : null;
  }
  tokenRevoke(token: string): void { this.run('DELETE FROM mcp_tokens WHERE token_hash=?', digest(token)); }
  interviewCreate(employeeId: string, topic: string): Row {
    need(topic, 'topic', 500);
    return this.tx(() => {
      const employee = this.get('employees', employeeId);
      if (!employee) throw new AppError('NOT_FOUND', 'employee', 404);
      const interviewId = id(); const sessionId = id(); const at = timestamp();
      this.run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)', sessionId, employeeId, `1on1 / ${topic}`, null, 'pending_interview', 0, String(employee.model), String(employee.persona), String(employee.skill_ids), 1, at);
      this.run('INSERT INTO interviews VALUES (?,?,?,?,?,?)', interviewId, employeeId, sessionId, topic, 'open', at);
      this.enqueue(employeeId, sessionId, 'interview_init', interviewId, `1:1 면담 의제: ${topic}。사용자의 발언을 기다리세요。`, null);
      this.audit('operator', 'interview.create', interviewId); return this.get('interviews', interviewId)!;
    });
  }
  interviewMessage(interviewId: string, actor: string, body: string): Row {
    need(body, 'body', 10000);
    return this.tx(() => {
      const interview = this.get('interviews', interviewId);
      if (!interview || interview.status !== 'open') throw new AppError('NOT_FOUND', 'interview', 404);
      const messageId = id(); this.run('INSERT INTO interview_messages VALUES (?,?,?,?,?)', messageId, interviewId, actor, body, timestamp());
      this.appendEvent(String(interview.session_id), null, 'user', body, 'interview');
      this.enqueue(String(interview.employee_id), String(interview.session_id), 'interview_message', interviewId, body, null);
      return this.get('interview_messages', messageId)!;
    });
  }
}
