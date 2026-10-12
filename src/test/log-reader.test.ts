import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.ts';
import { LogReader } from '../app/log-reader.ts';

test('Codex JSONL은 Session ID를 대조하고 공개 메시지만 중복 없이 가져온다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-log-'));
  const store = new Store(join(root, 'db.sqlite'));
  try {
    const employee = store.employeeCreate('operator', 'a', { name: 'AI', responsibility: '조사', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: root });
    const codexId = '11111111-1111-4111-8111-111111111111';
    store.bindCodexSession(employee.sessionId, codexId);
    writeFileSync(join(root, `rollout-${codexId}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id: codexId } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '안녕하세요' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '알겠습니다' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_reasoning', message: '비공개' } })
    ].join('\n'));
    const reader = new LogReader(store, root);
    assert.equal((await reader.importSession(employee.sessionId)).imported, 2);
    assert.equal((await reader.importSession(employee.sessionId)).imported, 0);
    assert.equal(store.eventsForSession(employee.sessionId).some(event => event.content === '비공개'), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
