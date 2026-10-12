import { createServer as httpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { AppError, type Store } from './store.js';
import { progress, type Criterion } from './domain.js';
import { LogReader } from './log-reader.js';

type Options = { operatorToken: string; publicDir: string; workspaceRoot: string; codexHome?: string; logRoot?: string; logReader?: LogReader; modelChoices?: string[]; runCancel?: (runId: string) => boolean };
type Body = Record<string, unknown>;
const json = (response: ServerResponse, code: number, value: unknown) => {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
};
function auth(actual: string | undefined, expected: string): boolean {
  if (!actual?.startsWith('Bearer ')) return false;
  const a = Buffer.from(actual.slice(7)); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function readBody(request: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65536) throw new AppError('INVALID_INPUT', 'body too large', 413);
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Body;
  } catch { throw new AppError('INVALID_INPUT', 'JSON object required'); }
}
function key(request: IncomingMessage, body: Body): string {
  const value = request.headers['idempotency-key'] ?? body.idempotency_key;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new AppError('INVALID_INPUT', 'idempotency_key');
  return value.trim();
}
function canonicalCwd(rootPath: string, requested: unknown): string {
  if (typeof requested !== 'string') throw new AppError('INVALID_INPUT', 'cwd');
  let root: string; let cwd: string;
  try { root = realpathSync(rootPath); cwd = realpathSync(requested); } catch { throw new AppError('INVALID_INPUT', 'cwd does not exist'); }
  const rel = relative(root, cwd);
  if (rel.startsWith('..') || rel.startsWith('/')) throw new AppError('FORBIDDEN', 'cwd outside workspace root', 403);
  return cwd;
}

export function createServer(store: Store, options: Options): Server {
  if (!options.operatorToken || options.operatorToken.length < 16) throw new Error('OPERATOR_TOKEN must have at least 16 characters');
  return httpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (request.method === 'GET' && path === '/healthz') { json(response, 200, { status: 'ok' }); return; }
      const staticFile = path === '/' ? 'index.html' : path === '/app.js' ? 'app.js' : path === '/style.css' ? 'style.css' : path === '/guidebook.css' ? 'guidebook.css' : path === '/guidebook.html' ? 'guidebook.html' : path === '/favicon.ico' ? 'favicon.ico' : null;
      if (staticFile && request.method === 'GET') {
        const data = await readFile(join(options.publicDir, staticFile));
        const type = staticFile.endsWith('.js') ? 'text/javascript' : staticFile.endsWith('.css') ? 'text/css' : staticFile.endsWith('.ico') ? 'image/x-icon' : 'text/html';
        response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'" }); response.end(data); return;
      }
      const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
      const internal = path === '/internal/mcp';
      const employeeId = internal ? store.tokenResolve(token) : null;
      if (internal ? !employeeId : !auth(request.headers.authorization, options.operatorToken)) { json(response, 401, { code: 'AUTH_REQUIRED' }); return; }
      if (internal) {
        if (request.method !== 'POST') throw new AppError('NOT_FOUND', 'route', 404);
        const body = await readBody(request);
        json(response, 200, mcpCall(store, employeeId!, body)); return;
      }
      if (!path.startsWith('/api/')) throw new AppError('NOT_FOUND', 'route', 404);
      if (request.method === 'GET' && path === '/api/bootstrap') {
        json(response, 200, { employees: store.list('employees'), sessions: store.list('sessions'), organizations: store.list('organizations'), permissions: store.list('call_permissions'), workOrders: store.list('work_orders'), tasks: store.list('tasks'), workProcesses: store.list('work_processes'), workCycles: store.list('work_cycles'), workLogs: store.list('work_logs'), runs: store.list('runs'), jobs: store.list('jobs'), skills: store.list('skills'), personas: store.list('personas'), schedules: store.list('schedules'), prices: store.list('model_prices'), interviews: store.list('interviews'), workspaceRoot: realpathSync(options.workspaceRoot), logSourceRoot: options.logRoot ?? null, logSourceRevision: store.settingGet('log_source_root')?.revision ?? 0, modelChoices: options.modelChoices ?? ['gpt-6.1-sol'] }); return;
      }
      const list = path.match(/^\/api\/list\/([a-z_]+)$/);
      if (request.method === 'GET' && list) { json(response, 200, store.list(list[1]!)); return; }
      const operation = path.match(/^\/api\/operations\/([0-9a-f-]+)$/);
      if (request.method === 'GET' && operation) { const value = store.get('operations', operation[1]!); if (!value) throw new AppError('NOT_FOUND', 'operation', 404); json(response, 200, value); return; }
      const events = path.match(/^\/api\/sessions\/([0-9a-f-]+)\/events$/);
      if (request.method === 'GET' && events) { const session = store.get('sessions', events[1]!); if (!session) throw new AppError('NOT_FOUND', 'session', 404); const cursor = Number(url.searchParams.get('cursor') ?? '0'); if (!Number.isSafeInteger(cursor) || cursor < 0) throw new AppError('INVALID_INPUT', 'cursor'); json(response, 200, { session, completeness: 'captured_by_runner_only', events: store.eventsForSession(events[1]!, cursor) }); return; }
      const reindex = path.match(/^\/api\/sessions\/([0-9a-f-]+)\/reindex$/);
      if (request.method === 'POST' && reindex) { if (!options.logReader) throw new AppError('TEMPORARY_UNAVAILABLE', 'log source not configured', 503); json(response, 200, await options.logReader.importSession(reindex[1]!)); return; }
      const cancel = path.match(/^\/api\/runs\/([0-9a-f-]+)\/cancel$/);
      if (request.method === 'POST' && cancel) { if (!options.runCancel?.(cancel[1]!)) throw new AppError('NOT_FOUND', 'running process', 404); json(response, 202, { runId: cancel[1], status: 'cancelling' }); return; }
      if (request.method === 'POST' && path === '/api/settings/log-source') {
        if (!options.codexHome) throw new AppError('TEMPORARY_UNAVAILABLE', 'Codex home not configured', 503);
        const body = await readBody(request);
        if (typeof body.root !== 'string' || !Number.isSafeInteger(body.expectedRevision)) throw new AppError('INVALID_INPUT', 'root or revision');
        let root: string;
        try { root = realpathSync(body.root); } catch { throw new AppError('INVALID_INPUT', 'log root does not exist'); }
        const rel = relative(realpathSync(options.codexHome), root);
        if (rel.startsWith('..') || rel.startsWith('/')) throw new AppError('FORBIDDEN', 'log root outside Codex home', 403);
        const reader = new LogReader(store, root);
        const saved = store.settingPut('log_source_root', root, body.expectedRevision as number);
        options.logRoot = root; options.logReader = reader;
        json(response, 200, saved); return;
      }
      const task = path.match(/^\/api\/tasks\/([0-9a-f-]+)$/);
      if (request.method === 'GET' && task) { const value = store.get('tasks', task[1]!); if (!value) throw new AppError('NOT_FOUND', 'task', 404); const criteria = JSON.parse(String(value.criteria_json)) as Criterion[]; json(response, 200, { ...value, criteria, progress: progress(criteria) }); return; }
      const process = path.match(/^\/api\/work-processes\/([0-9a-f-]+)$/);
      if (request.method === 'GET' && process) { const value = store.get('work_processes', process[1]!); if (!value) throw new AppError('NOT_FOUND', 'work process', 404); json(response, 200, { ...value, summary: store.processSummary(process[1]!), cycles: store.rows('SELECT * FROM work_cycles WHERE process_id=? ORDER BY scheduled_at DESC LIMIT 200', process[1]!) }); return; }
      if (request.method !== 'POST' && request.method !== 'PUT' && request.method !== 'PATCH') throw new AppError('NOT_FOUND', 'route', 404);
      const body = await readBody(request);
      let result: unknown; let status = 200;
      if (path === '/api/employees' && request.method === 'POST') {
        result = store.employeeCreate('operator', key(request, body), { name: body.name as string, responsibility: body.responsibility as string, role: body.role as string, model: body.model as string, persona: body.persona as string, skillIds: body.skillIds as string[], cwd: canonicalCwd(options.workspaceRoot, body.cwd), label: body.label as string | undefined }); status = 202;
      } else if (path === '/api/organizations' && request.method === 'POST') { result = store.organizationCreate('operator', key(request, body), body as { name: string; parentId?: string }); status = 202;
      } else if (path === '/api/work-orders' && request.method === 'POST') { result = store.workOrderCreate('operator', key(request, body), body as { title: string; body: string; acceptance: string; managerId: string }); status = 202;
      } else if (path === '/api/skills' && request.method === 'POST') { result = store.skillCreate('operator', key(request, body), body.content as string); status = 202;
      } else if (path === '/api/personas' && request.method === 'POST') { result = store.personaCreate('operator', key(request, body), body as { name: string; content: string }); status = 202;
      } else if (path === '/api/interviews' && request.method === 'POST') { result = store.interviewCreate(body.employeeId as string, body.topic as string);
      } else if (/^\/api\/interviews\/[0-9a-f-]+\/messages$/.test(path) && request.method === 'POST') { result = store.interviewMessage(path.split('/')[3]!, 'operator', body.body as string);
      } else {
        const assignment = path.match(/^\/api\/organizations\/([0-9a-f-]+)\/assignments$/);
        const addSession = path.match(/^\/api\/employees\/([0-9a-f-]+)\/sessions$/);
        const transfer = path.match(/^\/api\/employees\/([0-9a-f-]+)\/transfers$/);
        const permission = path.match(/^\/api\/managers\/([0-9a-f-]+)\/call-permissions$/);
        const wake = path.match(/^\/api\/managers\/([0-9a-f-]+)\/wake$/);
        const schedule = path.match(/^\/api\/managers\/([0-9a-f-]+)\/schedule$/);
        const config = path.match(/^\/api\/sessions\/([0-9a-f-]+)\/config$/);
        const price = path.match(/^\/api\/prices\/([a-zA-Z0-9._-]+)$/);
        if (addSession) { result = store.employeeSessionAdd('operator', key(request, body), addSession[1]!, body as { label?: string; model: string; persona: string; skillIds: string[] }); status = 202; }
        else if (assignment) result = store.assignEmployee(assignment[1]!, body.employeeId as string, (body.supervisorId as string | null) ?? null);
        else if (transfer) result = store.transferEmployee(transfer[1]!, body.organizationId as string, (body.supervisorId as string | null) ?? null, body.reason as string);
        else if (permission) result = store.setCallPermissions(permission[1]!, body.workerIds as string[]);
        else if (wake) { result = store.wake(wake[1]!, Date.now(), 'manual'); status = 202; }
        else if (schedule) result = store.schedulePut(schedule[1]!, body as { cron: string; timezone: string; enabled: boolean; prompt: string });
        else if (config) result = store.employeeConfig('operator', config[1]!, body.expectedRevision as number, body as { model: string; persona: string; skillIds: string[] });
        else if (price) result = store.putPrice(price[1]!, body as { input: number | null; cachedInput: number | null; output: number | null });
        else throw new AppError('NOT_FOUND', 'route', 404);
      }
      json(response, status, result);
    } catch (error) {
      const issue = error instanceof AppError ? error : new AppError('TEMPORARY_UNAVAILABLE', error instanceof Error ? error.message : 'unknown', 500);
      json(response, issue.status, { code: issue.code, message: issue.message });
    }
  });
}

function mcpCall(store: Store, actorId: string, body: Body): unknown {
  const tool = body.tool; const args = (body.args ?? {}) as Body;
  if (typeof tool !== 'string' || typeof args !== 'object' || Array.isArray(args)) throw new AppError('INVALID_INPUT', 'tool');
  const idem = args.idempotency_key as string;
  switch (tool) {
    case 'operation_get': {
      const operation = store.get('operations', args.operation_id as string);
      if (!operation || operation.actor !== actorId) throw new AppError('NOT_FOUND', 'operation', 404);
      return operation;
    }
    case 'inbox_list': return store.inboxFor(actorId);
    case 'inbox_ack': store.inboxAck(actorId, args.inbox_id as string); return { status: 'acknowledged' };
    case 'allowed_workers': return store.rows('SELECT e.id,e.name,e.responsibility FROM employees e JOIN call_permissions p ON p.worker_id=e.id WHERE p.manager_id=? AND e.status=\'active\'', actorId);
    case 'work_order_get': {
      const order = store.get('work_orders', args.work_order_id as string);
      if (!order || order.manager_id !== actorId) throw new AppError('FORBIDDEN', 'work order', 403);
      return order;
    }
    case 'task_get': {
      const task = store.get('tasks', args.task_id as string);
      if (!task || (task.manager_id !== actorId && task.worker_id !== actorId)) throw new AppError('FORBIDDEN', 'task', 403);
      return task;
    }
    case 'work_process_list': return store.rows('SELECT * FROM work_processes WHERE manager_id=? ORDER BY created_at DESC LIMIT 100', actorId);
    case 'work_process_create': return store.processCreate(actorId, idem, { workOrderId: args.work_order_id as string, title: args.title as string, cron: args.cron as string, timezone: args.timezone as string, deadlineMinutes: args.deadline_minutes as number });
    case 'work_cycle_record': return store.cycleRecord(actorId, idem, { processId: args.process_id as string, scheduledAt: args.scheduled_at as number, outcome: args.outcome as 'done' | 'skipped_with_reason', evidence: args.evidence as string, derivedTaskIds: args.derived_task_ids as string[] });
    case 'task_delegate': return store.taskDelegate(actorId, idem, { workOrderId: args.work_order_id as string | undefined, parentTaskId: args.parent_task_id as string | undefined, workerId: args.worker_id as string, title: args.title as string, goal: args.goal as string, criteria: args.criteria as Criterion[] });
    case 'task_checkpoint': return store.taskCheckpoint(actorId, idem, { taskId: args.task_id as string, expectedRevision: args.expected_revision as number, criterionId: args.criterion_id as string, evidence: args.evidence as string });
    case 'work_log_append': return store.workLogAppend(actorId, idem, { taskId: args.task_id as string, summary: args.summary as string, completed: args.completed as string, evidence: args.evidence as string, remaining: args.remaining as string, nextStep: args.next_step as string });
    case 'task_result_submit': return store.taskResultSubmit(actorId, idem, { taskId: args.task_id as string, expectedRevision: args.expected_revision as number, result: args.result as string, evidence: args.evidence as string });
    case 'work_order_report_submit': return store.workOrderReportSubmit(actorId, idem, { workOrderId: args.work_order_id as string, expectedRevision: args.expected_revision as number, report: args.report as string, evidence: args.evidence as string });
    default: throw new AppError('NOT_FOUND', 'tool', 404);
  }
}
