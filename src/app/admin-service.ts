import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, type Store } from './store.js';
import { Governance, MCP_TOOLS } from './governance.js';
import { Maintenance } from './maintenance.js';
import { canonicalCwd, updateLogSource } from './server.js';
import { progress, type Criterion } from './domain.js';
import type { LogReader } from './log-reader.js';
import type { Row } from './db.js';

export type AdminOptions = {
  workspaceRoot: string;
  codexHome: string;
  modelChoices?: string[];
  logRoot?: string;
  logReader?: LogReader;
  runCancel?: (runId: string) => boolean;
  ports: { web: number; internalMcp: number; adminMcp: number };
};
type Flags = { write?: boolean; destructive?: boolean; asynchronous?: boolean };
type Spec = Flags & { name: string; description: string; schema: z.ZodObject<z.ZodRawShape>; invoke: (args: unknown, operationId: string) => unknown };
const TABLES = ['employees', 'organizations', 'sessions', 'call_permissions', 'work_orders', 'tasks', 'work_logs', 'work_processes', 'work_cycles', 'jobs', 'runs', 'events', 'operations', 'inbox', 'schedules', 'wake_events', 'skills', 'skill_versions', 'personas', 'persona_versions', 'model_prices', 'settings', 'audit_events', 'interviews', 'interview_messages', 'run_skill_snapshots', 'ai_policy_versions', 'mcp_calls', 'admin_operations'] as const;
const ARCHIVABLE = ['organizations', 'skills', 'personas', 'schedules', 'model_prices'] as const;
const uuid = z.string().uuid();
const revision = z.number().int().positive();
const text = (max = 4000) => z.string().trim().min(1).max(max);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class AdminService {
  private readonly catalog = new Map<string, Spec>();
  private readonly governance: Governance;
  private readonly maintenance: Maintenance;
  constructor(private readonly store: Store, readonly options: AdminOptions) {
    this.governance = new Governance(store);
    this.maintenance = new Maintenance(store);
    const add = <S extends z.ZodRawShape>(name: string, description: string, shape: S, invoke: (args: z.infer<z.ZodObject<S>>, operationId: string) => unknown, flags: Flags = {}) => {
      const schema = z.object({ ...shape, ...(flags.write ? { idempotencyKey: text(200).describe('이 도구의 같은 요청을 재전송할 때 유지하는 고유 키') } : {}), ...(flags.destructive ? { confirm: z.literal(true).describe('영향 범위와 보관·비활성화 의미를 확인한 경우만 true') } : {}) }).strict();
      this.catalog.set(name, { name, description, schema: schema as z.ZodObject<z.ZodRawShape>, invoke: (args, operationId) => invoke(args as z.infer<z.ZodObject<S>>, operationId), ...flags });
    };
    const write = { write: true }, destructive = { write: true, destructive: true };
    const config = { model: text(80), persona: z.string().max(10000).default(''), skillIds: z.array(uuid).max(500).default([]) };
    add('usage', '실제 관리 함수들의 입력 스키마·예시·멱등성·오류 처리 방법을 설명합니다.', { tool: text(100).optional() }, a => this.usage(a.tool));
    add('readme', '이 시스템의 개요·구성·사양·운영 순서·권한과 이력 보존 경계를 설명합니다.', {}, () => this.readme());
    add('system_snapshot', '웹 대시보드·직원·조직·업무·설정에 대응하는 운영 스냅샷을 조회합니다. 목록별 최대 500건입니다.', {}, () => this.snapshot());
    add('records_list', '운영 기록을 rowid 커서로 조회합니다. 인증 토큰 저장소·임의 SQL은 제공하지 않습니다.', { table: z.enum(TABLES), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50), includeArchived: z.boolean().default(false) }, a => {
      const key = a.table === 'schedules' ? 'manager_id' : a.table === 'model_prices' ? 'model' : 'id';
      const archived = !a.includeArchived && (ARCHIVABLE as readonly string[]).includes(a.table) ? ` AND NOT EXISTS (SELECT 1 FROM resource_archives a WHERE a.resource='${a.table}' AND a.target_id=t.${key})` : '';
      const rows = store.rows(`SELECT t.rowid AS _cursor,t.* FROM ${a.table} t WHERE t.rowid>?${archived} ORDER BY t.rowid LIMIT ?`, a.cursor, a.limit + 1);
      const hasMore = rows.length > a.limit;
      if (hasMore) rows.pop();
      return { records: rows.map(row => this.annotate(a.table, row)), nextCursor: hasMore ? Number(rows.at(-1)!._cursor) : null };
    });
    add('record_get', 'ID로 직원·조직·세션·작업·일지·업무 지시·실행·면담·스킬 등을 조회합니다.', { table: z.enum(['employees', 'organizations', 'sessions', 'tasks', 'work_orders', 'work_logs', 'work_processes', 'work_cycles', 'jobs', 'runs', 'interviews', 'skills', 'personas', 'schedules', 'model_prices', 'operations']), id: text(100) }, a => {
      const row = this.maintenance.require(a.table, a.id);
      return this.annotate(a.table, row);
    });
    add('admin_operation_get', '외부 관리 요청의 접수·완료·결과 불명 상태를 조회합니다.', { operationId: uuid }, a => {
      const row = store.row('SELECT * FROM admin_operations WHERE id=?', a.operationId);
      if (!row) throw new AppError('NOT_FOUND', 'admin operation', 404);
      return { operationId: row.id, tool: row.tool, status: row.status, result: row.result_json ? JSON.parse(String(row.result_json)) : null, updatedAt: row.updated_at };
    });
    add('employee_create', 'AI 직원과 첫 세션을 만들고 실제 초기화 작업을 대기열에 접수합니다.', { name: text(100), responsibility: text(500), role: z.enum(['manager', 'worker']), ...config, cwd: text(1000).optional(), label: z.string().max(100).optional() }, (a, key) => store.employeeCreate('external-admin', key, { ...a, cwd: canonicalCwd(options.workspaceRoot, a.cwd || options.workspaceRoot) }), write);
    add('employee_update', '직원의 이름·담당 업무·작업 위치를 변경합니다. 역할·조직·세션 설정은 별도 도구로 관리합니다.', { employeeId: uuid, expectedRevision: revision, name: text(100), responsibility: text(500), cwd: text(1000) }, a => this.maintenance.employeeUpdate(a.employeeId, a.expectedRevision, { ...a, cwd: canonicalCwd(options.workspaceRoot, a.cwd) }), write);
    add('employee_delete', '직원을 비활성화하고 토큰·호출 권한을 회수합니다. 대기 작업은 취소하고 세션·업무 이력은 보존합니다. 실행 중에는 거부합니다.', { employeeId: uuid, expectedRevision: revision }, a => this.maintenance.employeeDelete(a.employeeId, a.expectedRevision), destructive);
    add('employee_restore', '비활성 직원을 다시 활성화합니다. 이전 권한·일정·작업은 자동 복원하지 않습니다.', { employeeId: uuid, expectedRevision: revision }, a => this.maintenance.employeeRestore(a.employeeId, a.expectedRevision), write);
    add('organization_create', '조직을 생성합니다. 상위 조직은 활성 조직이어야 합니다.', { name: text(100), parentId: uuid.nullable().optional() }, (a, key) => ({ ...store.organizationCreate('external-admin', key, a), revision: 1 }), write);
    add('organization_update', '조직 이름과 상위 조직을 변경합니다. 조직 순환과 이름 충돌은 거부합니다.', { organizationId: uuid, expectedRevision: revision, name: text(100), parentId: uuid.nullable() }, a => this.maintenance.organizationUpdate(a.organizationId, a.expectedRevision, a.name, a.parentId), write);
    add('organization_delete', '활성 직원·하위 조직이 없는 조직을 보관합니다. 과거 관계는 물리 삭제하지 않습니다.', { organizationId: uuid, expectedRevision: revision }, a => this.maintenance.organizationDelete(a.organizationId, a.expectedRevision), destructive);
    add('employee_assign', '미배치 직원을 조직에 배치하고 선택적으로 직속 관리 AI를 지정합니다.', { organizationId: uuid, employeeId: uuid, supervisorId: uuid.nullable().default(null) }, a => store.assignEmployee(a.organizationId, a.employeeId, a.supervisorId), write);
    add('employee_transfer', '직원을 다른 조직으로 전환합니다. 사유를 남기고 이전 호출 권한은 해제합니다.', { employeeId: uuid, organizationId: uuid, supervisorId: uuid.nullable().default(null), reason: text(500) }, a => store.transferEmployee(a.employeeId, a.organizationId, a.supervisorId, a.reason), write);
    add('call_permissions_set', '관리 AI가 호출할 작업 AI 목록을 전체 교체합니다. 빈 목록은 전체 해제입니다.', { managerId: uuid, workerIds: z.array(uuid).max(500) }, a => store.setCallPermissions(a.managerId, a.workerIds), destructive);
    add('session_add', '직원에게 새 업무 세션을 준비합니다. 실제 CLI ID 확정 후 현재 세션으로 전환합니다.', { employeeId: uuid, label: z.string().max(100).optional(), ...config }, (a, key) => store.employeeSessionAdd('external-admin', key, a.employeeId, a), write);
    add('session_config_set', '현재 업무 세션의 모델·페르소나·개별 스킬을 다음 실행 기준으로 변경합니다.', { sessionId: uuid, expectedRevision: revision, ...config }, a => store.employeeConfig('external-admin', a.sessionId, a.expectedRevision, a), write);
    add('session_events', '업무·면담 세션에서 수집된 공개 이벤트를 조회합니다. 비공개 추론은 제공하지 않습니다.', { sessionId: uuid, cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(100) }, a => {
      this.maintenance.require('sessions', a.sessionId);
      const events = store.eventsForSession(a.sessionId, a.cursor, a.limit);
      return { events, nextCursor: events.length === a.limit ? events.at(-1)!.id : null, completeness: 'captured_public_events_only' };
    });
    add('session_reindex', '설정된 Codex 로그에서 세션의 공개 이벤트를 중복 없이 재색인합니다.', { sessionId: uuid }, a => {
      if (!options.logReader) throw new AppError('TEMPORARY_UNAVAILABLE', 'log source not configured', 503);
      return options.logReader.importSession(a.sessionId);
    }, { write: true, asynchronous: true });
    add('work_order_create', '사람 또는 외부 관리 AI의 업무 지시를 관리 AI에게 접수합니다. Task 직접 생성은 관리 AI 업무 흐름에 맡깁니다.', { managerId: uuid, title: text(200), body: text(10000), acceptance: text(3000) }, (a, key) => store.workOrderCreate('external-admin', key, a), write);
    add('work_process_get', '계속 업무의 기간별 실행 회차·근거·파생 작업을 조회합니다.', { processId: uuid }, a => ({ ...this.maintenance.require('work_processes', a.processId), summary: store.processSummary(a.processId), cycles: store.rows('SELECT * FROM work_cycles WHERE process_id=? ORDER BY scheduled_at DESC LIMIT 200', a.processId) }));
    add('skill_create', 'UTF-8 SKILL.md의 name·description·본문을 검증해 스킬 카탈로그에 등록합니다.', { content: text(32768) }, (a, key) => store.skillCreate('external-admin', key, a.content), write);
    add('skill_update', '스킬의 새 버전을 저장합니다. 이전 공통 정책과 Run에 확정된 버전·본문은 유지합니다.', { skillId: uuid, expectedRevision: revision, content: text(32768) }, a => this.maintenance.skillUpdate(a.skillId, a.expectedRevision, a.content), write);
    add('skill_delete', '현재 공통 정책·세션에서 사용하지 않는 스킬을 보관합니다. 버전 이력은 보존합니다.', { skillId: uuid, expectedRevision: revision }, a => this.maintenance.skillDelete(a.skillId, a.expectedRevision), destructive);
    add('persona_create', '페르소나 템플릿을 등록합니다. 기존 세션에는 자동 적용하지 않습니다.', { name: text(100), content: text(10000) }, (a, key) => store.personaCreate('external-admin', key, a), write);
    add('persona_update', '페르소나 템플릿의 새 버전을 저장하고 이전 템플릿 내용을 보존합니다.', { personaId: uuid, expectedRevision: revision, name: text(100), content: text(10000) }, a => this.maintenance.personaUpdate(a.personaId, a.expectedRevision, a.name, a.content), write);
    add('persona_delete', '페르소나 템플릿을 보관합니다. 이미 복사된 세션 페르소나는 변경하지 않습니다.', { personaId: uuid, expectedRevision: revision }, a => this.maintenance.personaDelete(a.personaId, a.expectedRevision), destructive);
    add('resource_restore', '보관한 조직·스킬·템플릿·일정·요금을 복원합니다. 직원 비활성화는 employee_restore를 사용합니다.', { resource: z.enum(ARCHIVABLE), id: text(100) }, a => this.maintenance.restore(a.resource, a.id), write);
    add('ai_policy_get', '현재 공통 스킬 정책과 최근 5개 버전의 변경 이력을 조회합니다.', {}, () => this.governance.policyView());
    add('ai_policy_preview', '공통 스킬 추가·해제·버전 변경과 직원별 중복 제거 적용 범위를 저장 없이 미리 봅니다.', { skillIds: z.array(uuid).max(500) }, a => this.governance.previewPolicy(a.skillIds));
    add('ai_policy_set', '전체 AI에 적용할 공통 스킬을 확정합니다. 중복 제외·revision 검사 후 다음 Run부터 적용하며 개별 설정은 보존합니다.', { skillIds: z.array(uuid).max(500), expectedRevision: revision }, (a, key) => this.governance.savePolicy('operator', key, a.skillIds, a.expectedRevision), destructive);
    add('ai_policy_clear', '공통 스킬을 전부 해제하는 새 정책 버전을 저장합니다. 개별 스킬·과거 정책·Run은 삭제하지 않습니다.', { expectedRevision: revision }, (a, key) => this.governance.savePolicy('operator', key, [], a.expectedRevision), destructive);
    add('ai_policy_restore', '과거 정책의 스킬 선택을 현재 카탈로그로 재검증해 새 버전으로 저장합니다. 과거 버전을 덮어쓰지 않습니다.', { sourceRevision: revision, expectedRevision: revision }, (a, key) => {
      const row = store.row('SELECT * FROM ai_policy_versions WHERE revision=?', a.sourceRevision);
      if (!row) throw new AppError('NOT_FOUND', 'policy version', 404);
      const skills = JSON.parse(String(row.skills_json)) as { id: string }[];
      return this.governance.savePolicy('operator', key, skills.map(skill => skill.id), a.expectedRevision);
    }, destructive);
    add('schedule_set', '관리 AI의 cron·시간대·기본 프롬프트·활성 상태를 설정합니다.', { managerId: uuid, cron: text(100), timezone: text(100), enabled: z.boolean(), prompt: text(5000), expectedRevision: z.number().int().nonnegative() }, a => {
      if (this.maintenance.require('employees', a.managerId).status !== 'active') throw new AppError('CONFLICT', 'employee inactive', 409);
      this.expect('schedules', a.managerId, a.expectedRevision);
      return store.schedulePut(a.managerId, a);
    }, write);
    add('schedule_delete', '관리 AI 일정을 비활성화하고 보관합니다. 기존 실행 회차는 유지합니다.', { managerId: uuid, expectedRevision: revision }, a => this.maintenance.scheduleDelete(a.managerId, a.expectedRevision), destructive);
    add('manager_wake', '관리 AI를 수동 실행 대기열에 접수합니다. 동일 요청 키는 한 번만 접수합니다.', { managerId: uuid }, a => {
      const employee = this.maintenance.require('employees', a.managerId);
      if (employee.status !== 'active') throw new AppError('CONFLICT', 'employee inactive', 409);
      return store.wake(a.managerId, Date.now(), 'external-admin');
    }, write);
    add('run_cancel', 'Runner가 보유한 실제 실행 프로세스에 중지 요청을 보냅니다. 종료 상태는 runs를 다시 조회하세요.', { runId: uuid }, a => {
      this.maintenance.require('runs', a.runId);
      if (!options.runCancel?.(a.runId)) throw new AppError('NOT_FOUND', 'running process', 404);
      return { runId: a.runId, status: 'cancelling' };
    }, { ...destructive, asynchronous: true });
    add('job_control', '대기·복구 대상 작업을 취소하거나 사유와 함께 명시적으로 재개합니다. 결과 불명·도구 실행 후 재개는 거부하고 기존 대기 기한을 준수합니다. 실행 중은 run_cancel을 사용합니다.', { jobId: uuid, expectedStatus: z.enum(['queued', 'cooldown', 'needs_attention', 'execution_unknown']), action: z.enum(['resume', 'cancel']), reason: text(500) }, a => this.maintenance.jobControl(a.jobId, a.expectedStatus, a.action, a.reason), destructive);
    add('interview_create', '업무와 분리된 1:1 면담 세션을 생성하고 초기화를 접수합니다.', { employeeId: uuid, topic: text(500) }, a => { const e = this.maintenance.require('employees', a.employeeId); if (e.status !== 'active') throw new AppError('CONFLICT', 'employee inactive', 409); return store.interviewCreate(a.employeeId, a.topic); }, write);
    add('interview_message', '외부 관리 주체의 면담 발언을 저장하고 AI 응답을 비동기로 요청합니다.', { interviewId: uuid, body: text(10000) }, a => store.interviewMessage(a.interviewId, 'external-admin', a.body), write);
    add('interview_close', '면담을 종료하고 대기 중인 면담 응답을 취소합니다. 이미 실행 중이면 먼저 Run을 중지하세요.', { interviewId: uuid }, a => {
      const interview = this.maintenance.require('interviews', a.interviewId);
      if (store.row("SELECT id FROM jobs WHERE session_id=? AND status='running'", String(interview.session_id))) throw new AppError('SESSION_BUSY', 'interview running', 409);
      store.run("UPDATE interviews SET status='closed' WHERE id=?", a.interviewId);
      store.run("UPDATE jobs SET status='cancelled',updated_at=? WHERE session_id=? AND status IN ('queued','cooldown')", Date.now(), String(interview.session_id));
      return { interviewId: a.interviewId, status: 'closed', historyPreserved: true };
    }, destructive);
    add('model_price_set', '모델별 USD/100만 토큰 수동 요금을 설정합니다. null은 미설정, 0은 명시적 0입니다.', { model: text(80), input: z.number().nonnegative().nullable(), cachedInput: z.number().nonnegative().nullable(), output: z.number().nonnegative().nullable(), expectedRevision: z.number().int().nonnegative() }, a => { this.expect('model_prices', a.model, a.expectedRevision); return store.putPrice(a.model, a); }, write);
    add('model_price_delete', '모델 요금을 보관하고 현재 요금은 미설정으로 표시합니다.', { model: text(80), expectedRevision: revision }, a => this.maintenance.priceDelete(a.model, a.expectedRevision), destructive);
    add('log_source_set', 'Codex home 내부의 기존 로그 디렉터리를 설정합니다. 인증 파일·임의 외부 경로는 읽지 않습니다.', { root: text(1000), expectedRevision: z.number().int().nonnegative() }, a => updateLogSource(store, options, a), { write: true, asynchronous: true });
    add('mcp_metrics_get', '내부 직원 MCP의 함수·AI·위임 경로·최근 호출을 동일 기간으로 집계합니다. 외부 관리 도구 감사와 별개입니다.', { from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), employeeId: uuid.optional(), tool: z.enum(MCP_TOOLS as [string, ...string[]]).optional(), cursor: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }, a => this.governance.metrics(a));
  }
  private expect(table: string, id: string, expected: number) {
    const row = this.store.get(table, id);
    if (Number(row?.revision ?? row?.version ?? 0) !== expected) throw new AppError('CONFLICT', 'revision', 409);
  }
  private annotate(table: string, row: Row): Record<string, unknown> {
    const key = table === 'schedules' ? row.manager_id : table === 'model_prices' ? row.model : row.id;
    const archive = (ARCHIVABLE as readonly string[]).includes(table) ? { archived: !!this.store.row('SELECT * FROM resource_archives WHERE resource=? AND target_id=?', table, String(key)) } : {};
    if (table === 'tasks') { const criteria = JSON.parse(String(row.criteria_json)) as Criterion[]; return { ...row, criteria, progress: progress(criteria) }; }
    if (table === 'organizations') return { ...row, ...archive, revision: Number(this.store.row('SELECT revision FROM maintenance_revisions WHERE resource=? AND target_id=?', table, String(row.id))?.revision ?? 1) };
    return { ...row, ...archive };
  }
  tools() {
    return [...this.catalog.values()].map(spec => ({ name: spec.name, description: spec.description, inputSchema: { ...z.toJSONSchema(spec.schema), type: 'object' as const }, annotations: { readOnlyHint: !spec.write, destructiveHint: !!spec.destructive, idempotentHint: true, openWorldHint: !!spec.write } }));
  }
  private usage(tool?: string) {
    const tools = this.tools().filter(item => !tool || item.name === tool);
    if (!tools.length) throw new AppError('NOT_FOUND', 'tool', 404);
    return { workflow: ['readme', 'usage', 'system_snapshot 또는 records_list', '변경 대상·revision·영향 확인', '고유 idempotencyKey로 변경', '접수 결과와 실제 Run 결과를 별도로 조회'], rules: ['모든 쓰기는 idempotencyKey가 필수입니다. 같은 키·같은 입력은 같은 결과를 반환하며 다른 입력은 CONFLICT입니다.', 'confirm:true가 필요한 함수는 영향 확인 후에만 호출하세요.', 'expectedRevision은 조회한 revision, 스킬·템플릿·요금은 version입니다. 최초 일정·요금 생성은 0입니다.', '비동기 외부 효과가 시작된 뒤 통신·저장 오류가 나면 pending/unknown Operation을 조회하고 자동으로 새 키를 발급하지 마세요.', 'records_list는 nextCursor가 null이 될 때까지 같은 조건으로 조회합니다.'], tools: tools.map(item => ({ ...item, example: this.example(item.inputSchema as Record<string, unknown>) })), errors: ['INVALID_INPUT', 'AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'SESSION_BUSY', 'TEMPORARY_UNAVAILABLE'] };
  }
  private example(schema: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    for (const key of (schema.required || []) as string[]) {
      const p = properties[key]!;
      if (p.const !== undefined) out[key] = p.const;
      else if (p.default !== undefined) out[key] = p.default;
      else if (Array.isArray(p.enum)) out[key] = p.enum[0];
      else if (p.format === 'uuid') out[key] = '11111111-1111-4111-8111-111111111111';
      else if (p.type === 'array') out[key] = [];
      else if (p.type === 'number' || p.type === 'integer') out[key] = typeof p.exclusiveMinimum === 'number' ? p.exclusiveMinimum + 1 : Math.max(Number(p.minimum) || 0, 0);
      else if (p.type === 'boolean') out[key] = false;
      else if (p.anyOf) out[key] = null;
      else out[key] = key === 'idempotencyKey' ? '사용자-요청별-고유키' : key === 'content' ? '---\nname: example-skill\ndescription: 사용 조건\n---\n실행 지침\n' : key === 'cwd' ? this.options.workspaceRoot : key === 'root' ? this.options.codexHome : key === 'model' ? this.options.modelChoices?.[0] || 'gpt-6.1-sol' : key === 'cron' ? '0 * * * *' : key === 'timezone' ? 'Asia/Seoul' : key === 'id' ? '11111111-1111-4111-8111-111111111111' : '예시';
    }
    return out;
  }
  private readme() {
    return { name: 'AI 직원 시스템', version: '0.1.0', overview: '관리 AI가 업무 지시를 분해하고 허용된 작업 AI에게 위임하며, 세션·Run·근거·업무 일지를 SQLite에 보존하는 단일 호스트 운영 시스템입니다.', transport: '외부 관리 MCP는 /mcp의 Streamable HTTP(JSON 응답, stateless)이며 전용 Bearer 토큰을 요구합니다.', ports: this.options.ports, concepts: { Employee: '관리/작업 AI와 역할·작업 위치·상태', Organization: '조직·직속 관계와 별도로 명시적 호출 권한을 관리', Session: '현재 업무 세션과 별도 면담 세션. CLI 실제 ID는 실행 후 확정', WorkOrder: '사용자·외부 관리 AI의 업무 의뢰', Task: '관리 AI가 위임하는 완료 조건 기반 유한 작업', WorkProcess: '기한별 회차로 관리하는 계속 업무', Job: '영속 실행 대기열', Run: '실제 CLI 실행과 확정 정책·스킬 스냅샷', Operation: '멱등 접수 결과. 업무 완료와 다름' }, workflows: ['스킬·페르소나 등록 → 공통 AI 정책 확정', '조직·직원 생성 → 초기화 Operation·Run 확인 → 직원 배치·호출 권한 설정', '업무 지시 또는 관리 AI 일정·수동 실행 → 내부 task_delegate → 작업 AI 실행 → 근거·보고 확인', '대화·면담·업무 일지·복구 상태·MCP 지표 확인'], invariants: ['호출 권한과 조직 소속은 별개입니다.', '공통 정책+개별 스킬은 ID 중복을 제거하며 공통 정책의 확정 버전을 우선합니다. 변경은 다음 Run부터 적용합니다.', '스킬 수정은 새 버전입니다. 실행 중·과거 Run과 과거 정책 본문은 소급 변경하지 않습니다.', '제거는 비활성화·보관입니다. 정책 해제도 새 버전이며 감사·정책·Run·대화·작업 이력을 물리 삭제하지 않습니다.', '직원 토큰·웹 운영자 토큰·외부 관리 토큰은 서로 다른 접속 경계입니다. 외부 관리 도구는 본 시스템 직원에게 자동 제공하지 않습니다.', '작업 이력·업무 일지·AI 제출 근거를 외부 관리자가 직원인 것처럼 조작하는 도구는 제공하지 않습니다.', '면담은 업무 MCP 없이 실행합니다. 공통 정책은 도구 권한을 확대하지 않습니다.', '포트·인증·자동 재개 허용 등 배포 설정은 .env와 재시작으로 관리하며 원격 토큰·자격 증명 변경 API는 제공하지 않습니다.'], limits: ['단일 호스트·공유 SQLite DB이며 포트 분리가 프로세스·DB 격리를 의미하지 않습니다.', '기본 리스너는 loopback입니다. 원격 컴퓨터 접속은 별도의 TLS 역방향 프록시 또는 보안 터널을 구성해야 합니다.', '로그 재색인은 설정된 Codex home 내부 공개 이벤트만 대상입니다.', '가격은 USD/100만 토큰 수동 설정이며 실제 청구액은 아닙니다. MCP 응답 성공도 AI 작업 완료를 뜻하지 않습니다.', 'CLI 계정의 모델 사용 가능 여부·인증 유효성은 실제 환경에서 별도 확인해야 합니다.'], specifications: { progress: '유한 Task 진척도 = 근거가 있고 확인된 조건의 가중치 합 / 양의 조건 가중치 합 × 100. 계속 업무는 전체 백분율 대신 기한별 회차를 사용합니다.', execution: '동일 세션 병렬 실행 금지, 다른 세션은 설정된 동시 실행 상한 적용. 접수와 실제 실행 완료는 분리합니다.', recovery: '자동 재개는 기본 비활성화. 명시한 종료 코드·상한·대기시간 정책을 통과한 경우만 허용합니다.' }, entityFields: Object.fromEntries(TABLES.map(table => [table, this.store.rows(`PRAGMA table_info(${table})`).map(column => ({ name: column.name, type: column.type, required: column.notnull === 1 }))])), toolCount: this.catalog.size };
  }
  private snapshot() {
    return this.store.tx(() => ({ employees: this.store.list('employees'), organizations: this.store.list('organizations').map(row => this.annotate('organizations', row)), sessions: this.store.list('sessions'), permissions: this.store.list('call_permissions'), workOrders: this.store.list('work_orders'), tasks: this.store.list('tasks').map(row => this.annotate('tasks', row)), workLogs: this.store.list('work_logs'), workProcesses: this.store.list('work_processes'), workCycles: this.store.list('work_cycles'), runs: this.store.list('runs'), jobs: this.store.list('jobs'), skills: this.store.list('skills'), personas: this.store.list('personas'), schedules: this.store.list('schedules'), prices: this.store.list('model_prices'), interviews: this.store.list('interviews'), aiPolicy: this.governance.policyView(), modelChoices: this.options.modelChoices || [], workspaceRoot: this.options.workspaceRoot, logSourceRoot: this.options.logRoot || null, logSourceRevision: this.store.settingGet('log_source_root')?.revision || 0, collection: '각 목록 최대 500건. 전체 조회는 records_list의 커서를 사용하세요.' }));
  }
  async execute(name: string, input: unknown): Promise<unknown> {
    const spec = this.catalog.get(name);
    if (!spec) throw new AppError('NOT_FOUND', 'tool', 404);
    const parsed = spec.schema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_INPUT', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.code}`).join('; '));
    const args = parsed.data;
    if (!spec.write) return spec.invoke(args, '');
    const key = String(args.idempotencyKey), payloadHash = hash(JSON.stringify(args));
    const reserve = () => {
      const previous = this.store.row('SELECT * FROM admin_operations WHERE tool=? AND idem_key=?', name, key);
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new AppError('CONFLICT', 'idempotency payload', 409);
        if (previous.status !== 'completed') throw new AppError('CONFLICT', `operation ${previous.id} ${previous.status}; 상태 조회 후 확인이 필요합니다.`, 409);
        return { cached: true as const, operationId: String(previous.id), value: JSON.parse(String(previous.result_json)) as unknown };
      }
      const operationId = randomUUID();
      this.store.run('INSERT INTO admin_operations VALUES (?,?,?,?,?,?,?,?)', operationId, name, key, payloadHash, 'pending', null, Date.now(), Date.now());
      return { cached: false as const, operationId };
    };
    const complete = (operationId: string, result: unknown) => {
      const value = { operationId, status: 'completed', result: result ?? null };
      this.store.audit('external-admin', `admin.${name}`, operationId, { tool: name });
      this.store.run("UPDATE admin_operations SET status='completed',result_json=?,updated_at=? WHERE id=?", JSON.stringify(value), Date.now(), operationId);
      return value;
    };
    if (!spec.asynchronous) return this.store.tx(() => {
      const reserved = reserve();
      if (reserved.cached) return reserved.value;
      return complete(reserved.operationId, spec.invoke(args, reserved.operationId));
    });
    const reserved = this.store.tx(reserve);
    if (reserved.cached) return reserved.value;
    try {
      const result = await spec.invoke(args, reserved.operationId);
      return this.store.tx(() => complete(reserved.operationId, result));
    } catch (error) {
      this.store.run("UPDATE admin_operations SET status='unknown',updated_at=? WHERE id=?", Date.now(), reserved.operationId);
      throw new AppError(error instanceof AppError ? error.code : 'TEMPORARY_UNAVAILABLE', `operation ${reserved.operationId}: 결과 재조회가 필요합니다.`, error instanceof AppError ? error.status : 503);
    }
  }
}
