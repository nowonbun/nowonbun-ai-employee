import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../app/store.ts';
import { createMcpServer } from '../app/server.ts';

test('System MCP는 AI 직원 토큰으로 허용된 대상만 반환하고 Operation 조회 도구를 제공한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-mcp-'));
  const store = new Store(join(root, 'app.sqlite'));
  const manager = store.employeeCreate('operator', 'm', {
    name: '관리',
    responsibility: '총괄',
    role: 'manager',
    model: 'gpt-6.1-sol',
    persona: '',
    skillIds: [],
    cwd: root,
  });
  const worker = store.employeeCreate('operator', 'w', {
    name: '실무',
    responsibility: '조사',
    role: 'worker',
    model: 'gpt-6.1-sol',
    persona: '',
    skillIds: [],
    cwd: root,
  });
  store.setCallPermissions(manager.employeeId, [worker.employeeId]);
  const secret = store.tokenIssue(manager.employeeId);
  const server = createMcpServer(store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      'tsx',
      fileURLToPath(new URL('../app/mcp.ts', import.meta.url)),
    ],
    env: {
      ...inherited,
      AI_EMPLOYEE_MCP_TOKEN: secret,
      AI_EMPLOYEE_MCP_URL: `http://127.0.0.1:${address.port}`,
    },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'operation_get'));
    const result = await client.callTool({
      name: 'allowed_workers',
      arguments: {},
    });
    const content = result.content[0];
    assert.ok(content && content.type === 'text');
    const list = JSON.parse(content.text) as { id: string }[];
    assert.deepEqual(
      list.map((value) => value.id),
      [worker.employeeId]
    );
    const order = store.workOrderCreate('operator', 'order', { managerId: manager.employeeId, title: '분리 포트 위임', body: '확인', acceptance: '근거' });
    const args = { idempotency_key: 'delegate-once', work_order_id: order.workOrderId, worker_id: worker.employeeId, title: '포트 분리 확인', goal: '위임 접수 확인', criteria: [{ id: 'one', label: '근거', weight: 1 }] };
    const delegated = await client.callTool({ name: 'task_delegate', arguments: args });
    assert.ok(!delegated.isError);
    const repeated = await client.callTool({ name: 'task_delegate', arguments: args });
    assert.deepEqual(repeated.content, delegated.content);
    assert.equal(store.list('tasks').length, 1);
    assert.equal(store.list('tasks')[0]?.worker_id, worker.employeeId);
    assert.equal(store.list('jobs').filter(job => job.kind === 'task').length, 1);
    assert.equal(store.rows("SELECT * FROM mcp_calls WHERE tool='task_delegate' AND status='success'").length, 2);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
