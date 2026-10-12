import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.ts';
import { createServer } from '../app/server.ts';

test('HTTP API는 인증을 요구하고 AI 직원 생성을 영속 접수로 반환한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-employee-http-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const server = createServer(store, { operatorToken: 'test-token-1234567890', publicDir: dir, workspaceRoot: dir });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/list/employees`)).status, 401);
    const response = await fetch(`${base}/api/employees`, { method: 'POST', headers: { authorization: 'Bearer test-token-1234567890', 'content-type': 'application/json', 'idempotency-key': 'create-1' }, body: JSON.stringify({ name: '관리', responsibility: '총괄', role: 'manager', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: dir }) });
    assert.equal(response.status, 202);
    const created = await response.json() as { employeeId: string };
    assert.ok(created.employeeId);
    const list = await fetch(`${base}/api/list/employees`, { headers: { authorization: 'Bearer test-token-1234567890' } });
    assert.equal((await list.json() as unknown[]).length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('로그 참조 위치는 Codex home 외부를 거부한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-employee-logs-http-'));
  const logs = join(dir, 'sessions'); mkdirSync(logs);
  const store = new Store(join(dir, 'db.sqlite'));
  const server = createServer(store, { operatorToken: 'test-token-1234567890', publicDir: dir, workspaceRoot: dir, codexHome: dir });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/settings/log-source`;
    const headers = { authorization: 'Bearer test-token-1234567890', 'content-type': 'application/json' };
    const denied = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ root: tmpdir(), expectedRevision: 0 }) });
    assert.equal(denied.status, 403);
    const saved = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ root: logs, expectedRevision: 0 }) });
    assert.equal(saved.status, 200);
    assert.equal(store.settingGet('log_source_root')?.value, realpathSync(logs));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
