import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../app/store.ts';
import { Governance, MCP_TOOLS } from '../app/governance.ts';
import { createServer, createMcpServer } from '../app/server.ts';
import { Runner } from '../app/runner.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('공통 정책은 멱등·원자적으로 버전 관리하며 개별 선택과 스냅샷을 보존한다', () => {
  const store = new Store(':memory:');
  try {
    const service = new Governance(store);
    const skill = store.skillCreate('operator', 'skill', '---\nname: shared\ndescription: 공통 지침\n---\n근거를 확인합니다.\n');
    const initial = service.policy();
    assert.equal(initial.revision, 1);
    const saved = service.savePolicy('operator', 'save', [skill.skillId], 1);
    assert.equal(saved.revision, 2);
    assert.deepEqual(service.savePolicy('operator', 'save', [skill.skillId], 1), saved);
    assert.equal(service.savePolicy('operator', 'noop', [skill.skillId], 2).revision, 2);
    assert.throws(() => service.savePolicy('operator', 'stale', [], 1), /revision/);
    assert.throws(() => service.savePolicy('ai', 'ai', [], 2), /operator/);
    assert.throws(() => service.savePolicy('operator', 'missing', ['missing'], 2), /skill/);
    const session = { revision: 3, skill_ids: JSON.stringify([skill.skillId]) };
    const snapshot = service.resolveSkills(session);
    assert.equal(snapshot.skills.length, 1);
    assert.equal(snapshot.skills[0]?.source, 'common');
    assert.equal(snapshot.individualRevision, 3);
    service.savePolicy('operator', 'clear', [], 2);
    assert.equal(snapshot.policyRevision, 2);
    assert.equal(service.resolveSkills(session).skills[0]?.source, 'individual');
    store.run('UPDATE skills SET content=? WHERE id=?', '손상', skill.skillId);
    assert.throws(() => service.resolveSkills(session), /hash/);
  } finally { store.close(); }
});

test('Run별 스냅샷은 불변이며 면담·업무 프롬프트에 확정 스킬을 주입한다', () => {
  const store = new Store(':memory:');
  try {
    const service = new Governance(store);
    const skill = store.skillCreate('operator', 'skill', '---\nname: shared\ndescription: 공통 지침\n---\n공통 실행 지침\n');
    service.savePolicy('operator', 'policy', [skill.skillId], 1);
    const employee = store.employeeCreate('operator', 'e', { name: 'AI', responsibility: '검토', role: 'worker', model: 'gpt-6.1-sol', persona: '검토 담당', skillIds: [skill.skillId], cwd: process.cwd() });
    const job = store.claimJob()!;
    const session = store.get('sessions', employee.sessionId)!;
    const runId = store.startRun(job, String(session.model));
    const snapshot = service.captureRun(runId, session);
    const runner = new Runner(store, { codexBin: 'unused', workspaceRoot: process.cwd(), codexHome: process.cwd(), mcpUrl: 'http://127.0.0.1', autoResume: false, retryableExitCodes: [], maxRetries: 0 });
    const prompt = (runner as any).prompt(job, session, store.get('employees', employee.employeeId), snapshot) as string;
    assert.equal(prompt.split('공통 실행 지침').length - 1, 1);
    const interviewPrompt = (runner as any).prompt({ ...job, kind: 'interview_init' }, session, store.get('employees', employee.employeeId), snapshot) as string;
    assert.match(interviewPrompt, /업무의 쓰기·위임·외부 부작용을 수행하지 말고/);
    assert.match(interviewPrompt, /공통 실행 지침/);
    service.savePolicy('operator', 'clear', [], 2);
    assert.equal(store.row('SELECT policy_revision FROM run_skill_snapshots WHERE run_id=?', runId)?.policy_revision, 2);
    assert.throws(() => service.captureRun(runId, session), /UNIQUE/);
    assert.equal(service.resolveSkills(session).policyRevision, 3);
  } finally { store.close(); }
});

test('정책 API는 운영자 전용이며 MCP 관측은 안전한 메타데이터만 집계한다', async () => {
  const store = new Store(':memory:');
  const operatorToken = 'operator-test-token-12345';
  const server = createServer(store, { operatorToken, publicDir: process.cwd(), workspaceRoot: process.cwd() });
  const mcpServer = createMcpServer(store);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => mcpServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const mcpAddress = mcpServer.address();
    assert.ok(mcpAddress && typeof mcpAddress !== 'string');
    const mcpBase = `http://127.0.0.1:${mcpAddress.port}`;
    const headers = { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/api/ai-policy`)).status, 401);
    const employee = store.employeeCreate('operator', 'e', { name: 'AI', responsibility: '검토', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: process.cwd() });
    const token = store.tokenIssue(employee.employeeId);
    const aiHeaders = { ...headers, authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${base}/api/ai-policy`, { method: 'PUT', headers: aiHeaders, body: JSON.stringify({ skillIds: [], expectedRevision: 1, idempotencyKey: 'no' }) })).status, 401);
    const skill = store.skillCreate('operator', 'skill', '---\nname: shared\ndescription: 지침\n---\n본문\n');
    const save = { skillIds: [skill.skillId], expectedRevision: 1, idempotencyKey: 'save' };
    assert.equal((await fetch(`${base}/api/ai-policy`, { method: 'PUT', headers, body: JSON.stringify(save) })).status, 200);
    assert.equal((await fetch(`${base}/api/ai-policy`, { method: 'PUT', headers, body: JSON.stringify(save) })).status, 200);
    assert.equal((await fetch(`${base}/api/ai-policy`, { method: 'PUT', headers, body: JSON.stringify({ ...save, skillIds: [], idempotencyKey: 'stale' }) })).status, 409);
    const callId = randomUUID();
    const observe = (body: unknown) => fetch(`${mcpBase}/internal/mcp-observation`, { method: 'POST', headers: aiHeaders, body: JSON.stringify(body) });
    assert.equal((await observe({ callId, phase: 'start', tool: 'inbox_list' })).status, 200);
    assert.equal((await observe({ callId, phase: 'start', tool: 'inbox_list' })).status, 200);
    assert.equal((await fetch(`${mcpBase}/internal/mcp`, { method: 'POST', headers: aiHeaders, body: JSON.stringify({ callId, tool: 'inbox_list', args: { secret: 'DO-NOT-DISPLAY' } }) })).status, 200);
    assert.equal((await observe({ callId, phase: 'end', status: 'success', durationMs: 20 })).status, 200);
    const timeoutId = randomUUID();
    await observe({ callId: timeoutId, phase: 'start', tool: 'task_delegate', targetId: employee.employeeId });
    await observe({ callId: timeoutId, phase: 'end', status: 'failed', durationMs: 8000, errorCode: 'TIMEOUT' });
    assert.equal((await observe({ callId: timeoutId, phase: 'end', status: 'failed', durationMs: -1 })).status, 400);
    const response = await fetch(`${base}/api/metrics/mcp?from=0&to=${Date.now()}`, { headers });
    assert.equal(response.status, 200);
    const metrics = await response.json() as any;
    assert.equal(metrics.summary.total, 2);
    assert.equal(metrics.summary.successRate, 50);
    assert.equal(metrics.summary.delegations, 1);
    assert.ok(!JSON.stringify(metrics).includes('DO-NOT-DISPLAY'));
    assert.ok(!JSON.stringify(metrics).includes(token));
    assert.equal((await fetch(`${base}/api/metrics/mcp?from=0&to=1`, { headers: aiHeaders })).status, 401);
    assert.equal((await fetch(`${base}/api/metrics/mcp?from=10&to=1`, { headers })).status, 400);
    const bootstrap = await (await fetch(`${base}/api/bootstrap`, { headers })).json() as any;
    assert.equal(bootstrap.aiPolicy.revision, 2);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => mcpServer.close(() => resolve()));
    store.close();
  }
});

test('MCP 지표는 호출 ID 중복 제외·닫힌 기간·미관측 분모·위임만 구분한다', () => {
  const store = new Store(':memory:');
  try {
    const service = new Governance(store);
    service.beginCall('one', 'ai', 'task_delegate', 'worker', 100);
    service.beginCall('one', 'ai', 'task_delegate', 'worker', 100);
    assert.throws(() => service.beginCall('one', 'other', 'task_delegate', 'worker', 100), /metadata/);
    service.endCall('one', 'success', 20, null);
    service.beginCall('two', 'ai', 'task_get', null, 200);
    service.endCall('two', 'failed', 40, 'FORBIDDEN');
    service.beginCall('three', 'ai', 'task_get', null, 300);
    const result = service.metrics({ from: 100, to: 300, limit: 2 });
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.successRate, 50);
    assert.equal(result.summary.unobserved, 1);
    assert.equal(result.functions.length, MCP_TOOLS.length);
    assert.equal(result.routes.length, 1);
    assert.equal(result.recent.length, 2);
    assert.ok(result.nextCursor);
    assert.equal(service.metrics({ from: 100, to: 300, cursor: result.nextCursor! }).recent.length, 1);
    assert.equal(service.metrics({ from: 300, to: 300 }).summary.successRate, null);
    assert.equal(service.metrics({ from: 400, to: 500 }).summary.averageMs, null);
    assert.throws(() => service.metrics({ from: 300, to: 100 }), /range/);
    assert.throws(() => service.metrics({ from: 100, to: 300, tool: 'unknown' }), /tool/);
    assert.ok(!JSON.stringify(result).includes('idempotency_key'));
  } finally { store.close(); }
});

test('공통 스킬 해시가 손상되면 실제 프로세스 시작 전에 Run을 차단한다', async () => {
  const store = new Store(':memory:');
  try {
    const service = new Governance(store);
    const skill = store.skillCreate('operator', 'skill', '---\nname: shared\ndescription: 공통 지침\n---\n본문\n');
    service.savePolicy('operator', 'policy', [skill.skillId], 1);
    store.employeeCreate('operator', 'e', { name: 'AI', responsibility: '검토', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: process.cwd() });
    store.run('UPDATE skills SET content=? WHERE id=?', '손상', skill.skillId);
    const runner = new Runner(store, { codexBin: '프로세스가-실행되면-안됨', workspaceRoot: process.cwd(), codexHome: process.cwd(), mcpUrl: 'http://127.0.0.1', autoResume: false, retryableExitCodes: [], maxRetries: 0 });
    await runner.runOne();
    assert.equal(store.list('runs')[0]?.status, 'needs_attention');
    assert.match(String(store.list('runs')[0]?.reason), /skill hash/);
    assert.equal(store.rows('SELECT * FROM mcp_tokens').length, 0);
    assert.equal(store.rows('SELECT * FROM run_skill_snapshots').length, 0);
  } finally { store.close(); }
});

test('공통 정책 DB 저장 실패는 정책·감사·멱등 기록을 함께 롤백한다', () => {
  const store = new Store(':memory:');
  try {
    const service = new Governance(store);
    const skill = store.skillCreate('operator', 'skill', '---\nname: shared\ndescription: 지침\n---\n본문\n');
    store.db.exec("CREATE TRIGGER reject_policy_audit BEFORE INSERT ON audit_events WHEN NEW.action='ai-policy.save' BEGIN SELECT RAISE(ABORT,'simulated failure'); END;");
    assert.throws(() => service.savePolicy('operator', 'failed-save', [skill.skillId], 1), /simulated failure/);
    assert.equal(service.policy().revision, 1);
    assert.equal(store.rows("SELECT * FROM operations WHERE action='ai-policy.save'").length, 0);
    assert.equal(store.rows("SELECT * FROM audit_events WHERE action='ai-policy.save'").length, 0);
    store.db.exec('DROP TRIGGER reject_policy_audit');
    assert.equal(service.savePolicy('operator', 'failed-save', [skill.skillId], 1).revision, 2);
  } finally { store.close(); }
});

test('실제 자식 프로세스는 시작 당시 정책을 사용하고 다음 면담 Run은 새 정책을 사용한다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-policy-run-')));
  // Node를 가짜 Codex로 사용합니다. CLI의 첫 인자 exec를 JS fixture로 처리합니다.
  writeFileSync(join(root, 'exec'), `let input='';process.stdin.on('data', c=>input+=c);process.stdin.on('end',()=>setTimeout(()=>{console.log(JSON.stringify({type:'thread.started',thread_id:input.includes('1:1 면담')?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:input}}));},200));`, 'utf8');
  const store = new Store(':memory:');
  try {
    const service = new Governance(store);
    const skill = store.skillCreate('operator', 'skill', '---\nname: shared\ndescription: 공통 지침\n---\n실행 확인용 공통 본문\n');
    service.savePolicy('operator', 'policy', [skill.skillId], 1);
    const employee = store.employeeCreate('operator', 'e', { name: 'AI', responsibility: '검토', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: root });
    const runner = new Runner(store, { codexBin: process.execPath, workspaceRoot: root, codexHome: root, mcpUrl: 'http://127.0.0.1', autoResume: false, retryableExitCodes: [], maxRetries: 0 });
    const pending = runner.runOne();
    service.savePolicy('operator', 'clear', [], 2);
    await pending;
    assert.equal(store.list('runs')[0]?.status, 'completed');
    assert.match(String(store.eventsForSession(employee.sessionId).find(event => event.kind === 'assistant')?.content), /실행 확인용 공통 본문/);
    assert.equal(store.rows('SELECT * FROM run_skill_snapshots')[0]?.policy_revision, 2);
    const interview = store.interviewCreate(employee.employeeId, '정책 확인');
    await runner.runOne();
    const interviewText = String(store.eventsForSession(String(interview.session_id)).find(event => event.kind === 'assistant')?.content);
    assert.match(interviewText, /공통 정책 v3/);
    assert.ok(!interviewText.includes('실행 확인용 공통 본문'));
    service.savePolicy('operator', 'restore', [skill.skillId], 3);
    store.interviewMessage(String(interview.id), 'operator', '새 정책 확인');
    await runner.runOne();
    const latest = store.eventsForSession(String(interview.session_id)).filter(event => event.kind === 'assistant').at(-1)!;
    assert.match(String(latest.content), /공통 정책 v4/);
    assert.match(String(latest.content), /실행 확인용 공통 본문/);
    assert.equal(store.rows('SELECT * FROM mcp_tokens').length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
