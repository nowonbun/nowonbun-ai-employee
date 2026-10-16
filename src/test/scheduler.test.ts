import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.ts';
import { Scheduler } from '../app/scheduler.ts';

test('Scheduler는 중지 중 도래한 실행을 상한 내에서 기록하고 중복 실행으로 늘리지 않는다', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-schedule-'));
  const store = new Store(join(root, 'app.sqlite'));
  try {
    const manager = store.employeeCreate('operator', 'm', {
      name: '관리',
      responsibility: '확인',
      role: 'manager',
      model: 'gpt-6.1-sol',
      persona: '',
      skillIds: [],
      cwd: root,
    });
    const order = store.workOrderCreate('operator', 'o', {
      title: '확인',
      body: '매일',
      acceptance: '결과',
      managerId: manager.employeeId,
    });
    const process = store.processCreate(manager.employeeId, 'p', {
      workOrderId: order.workOrderId,
      title: '일일',
      cron: '0 0 * * *',
      timezone: 'UTC',
      deadlineMinutes: 60,
    });
    const scheduler = new Scheduler(store);
    scheduler.tick(new Date(Date.now() + 4 * 86400000));
    const first = store.processSummary(process.processId).due;
    assert.ok(first >= 3 && first <= 4);
    scheduler.tick(new Date(Date.now() + 4 * 86400000));
    assert.equal(store.processSummary(process.processId).due, first);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
