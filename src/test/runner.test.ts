import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.ts';
import { Runner } from '../app/runner.ts';

test('가짜 CLI를 비동기로 실행해 실제 Session ID와 대화 이벤트를 DB에 남긴다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-runner-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const fake = join(root, 'fake-codex');
  writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end",()=>{ setTimeout(()=>{ console.log(JSON.stringify({type:"thread.started",thread_id:"11111111-1111-4111-8111-111111111111"})); console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"준비 완료"}})); process.exit(0); },100); });\n', { mode: 0o755 });
  const store = new Store(join(root, 'app.sqlite'));
  try {
    const created = store.employeeCreate('operator', 'one', { name: '실무', responsibility: '조사', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: workspace });
    const runner = new Runner(store, { codexBin: fake, workspaceRoot: workspace, codexHome: root, mcpUrl: 'http://127.0.0.1:9999', autoResume: false, retryableExitCodes: [], maxRetries: 2 });
    const started = Date.now(); const pending = runner.runOne();
    assert.ok(Date.now() - started < 50);
    assert.equal(await pending, true);
    assert.equal(store.get('sessions', created.sessionId)?.codex_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(store.eventsForSession(created.sessionId).some(event => event.content === '준비 완료'), true);
    assert.equal(store.list('runs')[0]?.status, 'completed');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('1on1은 독립 Session에서 응답하고 업무용 MCP를 전달하지 않는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-interview-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const fake = join(root, 'fake-codex');
  writeFileSync(fake, `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{let id=input.includes('1on1')?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111';console.log(JSON.stringify({type:'thread.started',thread_id:id}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:process.env.AI_EMPLOYEE_MCP_TOKEN?'MCP 있음':'면담 응답'}}));});\n`, { mode: 0o755 });
  const store = new Store(join(root, 'app.sqlite'));
  try {
    const employee = store.employeeCreate('operator', 'one', { name: 'AI', responsibility: '조사', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: workspace });
    const runner = new Runner(store, { codexBin: fake, workspaceRoot: workspace, codexHome: root, mcpUrl: 'http://127.0.0.1:9999', autoResume: false, retryableExitCodes: [], maxRetries: 2 });
    assert.equal(await runner.runOne(), true);
    const interview = store.interviewCreate(employee.employeeId, '1on1 상담');
    assert.equal(await runner.runOne(), true);
    store.interviewMessage(String(interview.id), 'operator', '1on1 이어서');
    assert.equal(await runner.runOne(), true);
    assert.equal(store.get('sessions', String(interview.session_id))?.codex_id, '22222222-2222-4222-8222-222222222222');
    assert.equal(store.eventsForSession(String(interview.session_id)).filter(event => event.content === '면담 응답').length, 2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('관리 AI가 장시간 실행 중이어도 다른 Session의 작업 AI를 실행한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-concurrent-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const fake = join(root, 'fake-codex');
  writeFileSync(fake, `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{let manager=input.includes('관리 AI');let id=manager?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222';setTimeout(()=>{console.log(JSON.stringify({type:'thread.started',thread_id:id}));},input.includes('장시간')?3500:50);});\n`, { mode: 0o755 });
  const store = new Store(join(root, 'app.sqlite'));
  const runner = new Runner(store, { codexBin: fake, workspaceRoot: workspace, codexHome: root, mcpUrl: 'http://127.0.0.1:9999', autoResume: false, retryableExitCodes: [], maxRetries: 2 });
  try {
    const manager = store.employeeCreate('operator', 'm', { name: '관리', responsibility: '총괄', role: 'manager', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: workspace });
    const worker = store.employeeCreate('operator', 'w', { name: '실무', responsibility: '조사', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: workspace });
    await runner.runOne(); await runner.runOne();
    const wake = store.wake(manager.employeeId, Date.now(), 'manual');
    assert.ok(wake.jobId);
    store.run('UPDATE jobs SET prompt=? WHERE id=?', '장시간 관리 AI 작업', wake.jobId);
    store.setCallPermissions(manager.employeeId, [worker.employeeId]);
    const order = store.workOrderCreate('operator', 'order', { title: '짧은 작업', body: '확인', acceptance: '결과', managerId: manager.employeeId });
    const workerJob = store.taskDelegate(manager.employeeId, 'delegate', { workOrderId: order.workOrderId, workerId: worker.employeeId, title: '짧은 작업', goal: '확인', criteria: [{ id: 'a', label: '근거', weight: 1 }] }).jobId;
    runner.start();
    await new Promise(resolve => setTimeout(resolve, 2400));
    assert.equal(store.get('jobs', workerJob)?.status, 'completed');
  } finally { runner.stop(); await new Promise(resolve => setTimeout(resolve, 2300)); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('운영자의 중지 요청은 실행 중인 자식 프로세스를 종료하고 취소 상태를 남긴다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-cancel-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const fake = join(root, 'fake-codex');
  writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>{},5000));\n', { mode: 0o755 });
  const store = new Store(join(root, 'app.sqlite'));
  try {
    store.employeeCreate('operator', 'one', { name: 'AI', responsibility: '조사', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: workspace });
    const runner = new Runner(store, { codexBin: fake, workspaceRoot: workspace, codexHome: root, mcpUrl: 'http://127.0.0.1:9999', autoResume: false, retryableExitCodes: [], maxRetries: 2 });
    const pending = runner.runOne();
    await new Promise(resolve => setTimeout(resolve, 150));
    const runId = String(store.list('runs')[0]?.id);
    assert.equal(runner.cancelRun(runId), true);
    await pending;
    assert.equal(store.get('runs', runId)?.status, 'cancelled');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('위임 후 호출 권한이 만료된 Task는 실행하지 않는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-permission-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const fake = join(root, 'fake-codex');
  writeFileSync(fake, `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:input.includes('관리 AI')?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222'}));});\n`, { mode: 0o755 });
  const store = new Store(join(root, 'app.sqlite'));
  try {
    const manager = store.employeeCreate('operator', 'm', { name: '관리', responsibility: '총괄', role: 'manager', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: workspace });
    const worker = store.employeeCreate('operator', 'w', { name: '실무', responsibility: '조사', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: workspace });
    const runner = new Runner(store, { codexBin: fake, workspaceRoot: workspace, codexHome: root, mcpUrl: 'http://127.0.0.1:9999', autoResume: false, retryableExitCodes: [], maxRetries: 2 });
    await runner.runOne(); await runner.runOne();
    store.setCallPermissions(manager.employeeId, [worker.employeeId]);
    const order = store.workOrderCreate('operator', 'order', { title: '조사', body: '조사', acceptance: '결과', managerId: manager.employeeId });
    const task = store.taskDelegate(manager.employeeId, 'delegate', { workOrderId: order.workOrderId, workerId: worker.employeeId, title: '조사', goal: '확인', criteria: [{ id: 'a', label: '근거', weight: 1 }] });
    store.setCallPermissions(manager.employeeId, []);
    await runner.runOne();
    assert.equal(store.get('jobs', task.jobId)?.status, 'needs_attention');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('허용된 일시 종료는 60초 이후 같은 Session에서 새 Run으로 재개한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-cooldown-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const fake = join(root, 'fake-codex');
  writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));process.exit(process.argv.includes('resume')?0:75);});\n`, { mode: 0o755 });
  const store = new Store(join(root, 'app.sqlite'));
  try {
    const employee = store.employeeCreate('operator', 'a', { name: 'AI', responsibility: '확인', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: workspace });
    const runner = new Runner(store, { codexBin: fake, workspaceRoot: workspace, codexHome: root, mcpUrl: 'http://127.0.0.1:9999', autoResume: true, retryableExitCodes: [75], maxRetries: 2 });
    await runner.runOne();
    const job = store.list('jobs')[0]!;
    assert.equal(job.status, 'cooldown');
    assert.ok(Number(job.due_at) >= Date.now() + 59000);
    store.run('UPDATE jobs SET due_at=0 WHERE id=?', String(job.id));
    await runner.runOne();
    assert.equal(store.get('jobs', String(job.id))?.status, 'completed');
    assert.equal(store.get('sessions', employee.sessionId)?.codex_id, '11111111-1111-4111-8111-111111111111');
    assert.equal(store.list('runs').length, 2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Retry-After가 180초이면 60초보다 오래 기다린다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-retry-after-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const fake = join(root, 'fake-codex');
  writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));console.log(JSON.stringify({type:'error',retry_after_ms:180000}));process.exit(75);});\n`, { mode: 0o755 });
  const store = new Store(join(root, 'app.sqlite'));
  try {
    store.employeeCreate('operator', 'a', { name: 'AI', responsibility: '확인', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: workspace });
    const runner = new Runner(store, { codexBin: fake, workspaceRoot: workspace, codexHome: root, mcpUrl: 'http://127.0.0.1:9999', autoResume: true, retryableExitCodes: [75], maxRetries: 2 });
    await runner.runOne();
    const job = store.list('jobs')[0]!;
    assert.equal(job.status, 'cooldown');
    assert.ok(Number(job.due_at) >= Date.now() + 179000);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
