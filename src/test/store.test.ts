import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-employee-test-'));
  const db = new Store(join(dir, 'test.sqlite'));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('AI 직원과 첫 Session은 함께 생성되고 같은 key는 같은 결과로 수렴한다', () => {
  const { db, cleanup } = fixture();
  try {
    const input = { name: '관리 A', responsibility: '관리', role: 'manager', model: 'gpt-6.1-sol', persona: '신중하게 확인한다', skillIds: [], cwd: '/workspace', label: '' };
    const first = db.employeeCreate('operator', 'create-a', input) as { employeeId: string; sessionId: string };
    const second = db.employeeCreate('operator', 'create-a', input) as typeof first;
    assert.deepEqual(second, first);
    assert.equal(db.list('employees').length, 1);
    assert.equal(db.list('sessions').length, 1);
    assert.throws(() => db.employeeCreate('operator', 'create-a', { ...input, name: '다른 이름' }), /CONFLICT/);
  } finally { cleanup(); }
});

test('소속과 호출 권한은 독립적이며 위임을 중복하지 않는다', () => {
  const { db, cleanup } = fixture();
  try {
    const base = { model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: '/workspace', label: '' };
    const manager = db.employeeCreate('operator', 'm', { ...base, name: '관리', responsibility: '총괄', role: 'manager' }) as { employeeId: string };
    const worker = db.employeeCreate('operator', 'w', { ...base, name: '실무', responsibility: '조사', role: 'worker' }) as { employeeId: string };
    const org = db.organizationCreate('operator', 'o', { name: '개발부' }) as { organizationId: string };
    db.assignEmployee(org.organizationId, manager.employeeId, null);
    db.assignEmployee(org.organizationId, worker.employeeId, manager.employeeId);
    assert.throws(() => db.assignEmployee(org.organizationId, worker.employeeId, manager.employeeId), /CONFLICT/);
    const order = db.workOrderCreate('operator', 'order', { title: '조사', body: '확인한다', acceptance: '보고', managerId: manager.employeeId }) as { workOrderId: string };
    assert.equal(db.list('tasks').length, 0);
    const task = { workOrderId: order.workOrderId, workerId: worker.employeeId, title: '조사 Task', goal: '확인', criteria: [{ id: 'a', label: '조사', weight: 2 }, { id: 'b', label: '보고', weight: 2 }] };
    assert.throws(() => db.taskDelegate(manager.employeeId, 'delegate', task), /FORBIDDEN/);
    db.setCallPermissions(manager.employeeId, [worker.employeeId]);
    const first = db.taskDelegate(manager.employeeId, 'delegate', task);
    assert.deepEqual(db.taskDelegate(manager.employeeId, 'delegate', task), first);
    assert.equal(db.list('tasks').length, 1);
    assert.throws(() => db.workLogAppend(manager.employeeId, 'log-bad', { taskId: (first as { taskId: string }).taskId, summary: '다른 사람', completed: '', evidence: '', remaining: '', nextStep: '' }), /FORBIDDEN/);
    const taskId = (first as { taskId: string }).taskId;
    db.workLogAppend(worker.employeeId, 'log', { taskId, summary: '진행 중', completed: '', evidence: '', remaining: '보고', nextStep: '기록' });
    const after = db.taskCheckpoint(worker.employeeId, 'checkpoint', { taskId, expectedRevision: 1, criterionId: 'a', evidence: 'artifact-1' }) as { progress: number };
    assert.equal(after.progress, 50);
    assert.throws(() => db.taskCheckpoint(worker.employeeId, 'old', { taskId, expectedRevision: 1, criterionId: 'b', evidence: 'artifact-2' }), /CONFLICT/);
  } finally { cleanup(); }
});

test('가격 미설정과 명시적 0을 구별하고 cron wake를 중복하지 않는다', () => {
  const { db, cleanup } = fixture();
  try {
    const manager = db.employeeCreate('operator', 'm', { name: '관리', responsibility: '총괄', role: 'manager', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: '/workspace', label: '' }) as { employeeId: string };
    db.putPrice('gpt-6.1-sol', { input: 0, cachedInput: null, output: 2 });
    assert.deepEqual(db.getPrice('gpt-6.1-sol'), { model: 'gpt-6.1-sol', input: 0, cachedInput: null, output: 2, unit: 'USD/1M' });
    assert.throws(() => db.putPrice('gpt-6.1-sol', { input: -1, cachedInput: null, output: 2 }), /INVALID_INPUT/);
    db.schedulePut(manager.employeeId, { cron: '*/5 * * * *', timezone: 'Asia/Seoul', enabled: true, prompt: '점검한다' });
    const one = db.wake(manager.employeeId, 1_000);
    assert.deepEqual(db.wake(manager.employeeId, 1_000), one);
    assert.equal(db.list('wake_events').length, 1);
  } finally { cleanup(); }
});

test('잘못된 cron 식은 저장 전에 거부한다', () => {
  const { db, cleanup } = fixture();
  try {
    const manager = db.employeeCreate('operator', 'm', { name: '관리', responsibility: '총괄', role: 'manager', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: '/workspace', label: '' }) as { employeeId: string };
    assert.throws(() => db.schedulePut(manager.employeeId, { cron: 'bad * * * *', timezone: 'Asia/Seoul', enabled: true, prompt: '점검' }), /INVALID_INPUT/);
  } finally { cleanup(); }
});

test('추가 Session은 실제 ID 확정 후 현재 Session으로 전환하고 이전 Session을 보존한다', () => {
  const { db, cleanup } = fixture();
  try {
    const employee = db.employeeCreate('operator', 'initial', { name: 'AI', responsibility: '조사', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: '/workspace', label: '' });
    const next = db.employeeSessionAdd('operator', 'next', employee.employeeId, { label: '새 Session', model: 'gpt-6.1-sol', persona: '', skillIds: [] });
    assert.equal(db.get('sessions', employee.sessionId)?.is_current, 1);
    assert.equal(db.get('sessions', next.sessionId)?.is_current, 0);
    db.bindCodexSession(next.sessionId, '22222222-2222-4222-8222-222222222222');
    assert.equal(db.get('sessions', employee.sessionId)?.is_current, 0);
    assert.equal(db.get('sessions', next.sessionId)?.is_current, 1);
    assert.equal(db.list('sessions').length, 2);
  } finally { cleanup(); }
});

test('1on1은 업무 Session과 별도 Session을 만들고 발언을 저장한다', () => {
  const { db, cleanup } = fixture();
  try {
    const employee = db.employeeCreate('operator', 'initial', { name: 'AI', responsibility: '조사', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: '/workspace', label: '' });
    const interview = db.interviewCreate(employee.employeeId, '상담');
    assert.notEqual(interview.session_id, employee.sessionId);
    assert.equal(db.list('sessions').length, 2);
    db.interviewMessage(String(interview.id), 'operator', '최근 상황은 어떤가요?');
    assert.equal(db.list('interview_messages').length, 1);
    assert.equal(db.list('jobs').some(job => job.kind === 'interview_message'), true);
  } finally { cleanup(); }
});

test('지속 업무는 기한이 도래한 회차로 실적을 세고 전체 진행률은 표시하지 않는다', () => {
  const { db, cleanup } = fixture();
  try {
    const manager = db.employeeCreate('operator', 'manager', { name: '관리', responsibility: '정기 점검', role: 'manager', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: '/workspace' });
    const order = db.workOrderCreate('operator', 'order', { title: '일일 점검', body: '매일 확인', acceptance: '결과 보고', managerId: manager.employeeId });
    const process = db.processCreate(manager.employeeId, 'process', { workOrderId: order.workOrderId, title: '일일 점검', cron: '0 9 * * *', timezone: 'Asia/Seoul', deadlineMinutes: 60 });
    const start = Date.UTC(2026, 0, 1, 0, 0);
    for (let i = 0; i < 3; i++) db.cycleEnsure(process.processId, start + i * 86400000, start + i * 86400000 + 61000 * 60);
    db.cycleRecord(manager.employeeId, 'cycle-1', { processId: process.processId, scheduledAt: start, outcome: 'done', evidence: 'check-1', derivedTaskIds: [] });
    db.cycleRecord(manager.employeeId, 'cycle-2', { processId: process.processId, scheduledAt: start + 86400000, outcome: 'done', evidence: 'check-2', derivedTaskIds: [] });
    assert.deepEqual(db.processSummary(process.processId), { due: 3, done: 2, missed: 1, skipped: 0, progress: null });
  } finally { cleanup(); }
});

test('근거가 부족한 Task가 남은 업무 지시는 보고 완료로 처리하지 않는다', () => {
  const { db, cleanup } = fixture();
  try {
    const base = { model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: '/workspace' };
    const manager = db.employeeCreate('operator', 'm', { ...base, name: '관리', responsibility: '총괄', role: 'manager' });
    const worker = db.employeeCreate('operator', 'w', { ...base, name: '실무', responsibility: '조사', role: 'worker' });
    db.setCallPermissions(manager.employeeId, [worker.employeeId]);
    const order = db.workOrderCreate('operator', 'o', { title: '조사', body: '조사한다', acceptance: '성과 확인', managerId: manager.employeeId });
    db.taskDelegate(manager.employeeId, 't', { workOrderId: order.workOrderId, workerId: worker.employeeId, title: '조사', goal: '조사', criteria: [{ id: 'a', label: '근거', weight: 1 }] });
    const result = db.workOrderReportSubmit(manager.employeeId, 'r', { workOrderId: order.workOrderId, expectedRevision: 1, report: '미해결 사항 있음', evidence: '현황 확인' });
    assert.equal(result.status, 'needs_attention');
    assert.equal(db.get('work_orders', order.workOrderId)?.status, 'needs_attention');
  } finally { cleanup(); }
});

test('로그 참조 위치는 버전을 확인해 저장하고 오래된 갱신은 거부한다', () => {
  const { db, cleanup } = fixture();
  try {
    assert.equal(db.settingGet('log_source_root'), null);
    const first = db.settingPut('log_source_root', '/codex-home/sessions', 0);
    assert.equal(first.revision, 1);
    assert.equal(db.settingGet('log_source_root')?.value, '/codex-home/sessions');
    assert.throws(() => db.settingPut('log_source_root', '/codex-home/other', 0), /CONFLICT/);
  } finally { cleanup(); }
});
