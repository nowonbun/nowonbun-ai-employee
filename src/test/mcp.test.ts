import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../app/store.ts';
import { createServer } from '../app/server.ts';

test('System MCP는 AI 직원 토큰으로 허용된 대상만 반환하고 Operation 조회 도구를 제공한다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-employee-mcp-'));
  const store = new Store(join(root, 'app.sqlite'));
  const manager = store.employeeCreate('operator', 'm', { name: '관리', responsibility: '총괄', role: 'manager', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: root });
  const worker = store.employeeCreate('operator', 'w', { name: '실무', responsibility: '조사', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: root });
  store.setCallPermissions(manager.employeeId, [worker.employeeId]);
  const secret = store.tokenIssue(manager.employeeId);
  const server = createServer(store, { operatorToken: 'test-token-1234567890', publicDir: root, workspaceRoot: root });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import','tsx',fileURLToPath(new URL('../app/mcp.ts', import.meta.url))], env: { ...inherited, AI_EMPLOYEE_MCP_TOKEN: secret, AI_EMPLOYEE_MCP_URL: `http://127.0.0.1:${address.port}` }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'operation_get'));
    const result = await client.callTool({ name: 'allowed_workers', arguments: {} });
    const content = result.content[0]; assert.ok(content && content.type === 'text');
    const list = JSON.parse(content.text) as { id: string }[];
    assert.deepEqual(list.map(value => value.id), [worker.employeeId]);
  } finally { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); }
});
