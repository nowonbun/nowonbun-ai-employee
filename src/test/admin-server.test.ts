import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../app/store.ts';
import { AdminService } from '../app/admin-service.ts';
import { createAdminServer } from '../app/admin-server.ts';
import { createServer, createMcpServer } from '../app/server.ts';
import { adminMcpConfig } from '../app/runtime-config.ts';
import { request as httpRequest } from 'node:http';

test('외부 관리 포트·토큰은 분리되며 토큰 누락 시 비활성화한다', () => {
  assert.equal(adminMcpConfig({}).enabled, false);
  const token = 'a'.repeat(64);
  assert.equal(adminMcpConfig({ ADMIN_MCP_TOKEN: token, ADMIN_MCP_PORT: '3992' }).port, 3992);
  assert.throws(() => adminMcpConfig({ ADMIN_MCP_TOKEN: 'short' }), /ADMIN_MCP_TOKEN/);
  assert.throws(() => adminMcpConfig({ ADMIN_MCP_TOKEN: token, ADMIN_MCP_PORT: '3001' }), /different/);
  assert.throws(() => adminMcpConfig({ ADMIN_MCP_TOKEN: token, OPERATOR_TOKEN: token }), /distinct/);
  assert.throws(() => adminMcpConfig({ ADMIN_MCP_PORT: '65536' }), /ADMIN_MCP_PORT/);
});

test('Streamable HTTP 클라이언트는 전용 토큰으로만 관리 도구·usage·readme를 사용한다', async () => {
  const store = new Store(':memory:');
  const token = 'external-management-token-12345678901234567890';
  const operatorToken = 'operator-token-1234567890';
  const service = new AdminService(store, { workspaceRoot: process.cwd(), codexHome: process.cwd(), modelChoices: ['gpt-6.1-sol'], ports: { web: 3000, internalMcp: 3001, adminMcp: 3002 } });
  const admin = createAdminServer(store, { token, service, otherTokens: [operatorToken] });
  const web = createServer(store, { operatorToken, publicDir: process.cwd(), workspaceRoot: process.cwd() });
  const internal = createMcpServer(store);
  const client = new Client({ name: 'external-admin-test', version: '1.0.0' });
  try {
    for (const server of [admin, web, internal]) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = admin.address(), webAddress = web.address(), internalAddress = internal.address();
    assert.ok(address && typeof address !== 'string' && webAddress && typeof webAddress !== 'string' && internalAddress && typeof internalAddress !== 'string');
    const url = `http://127.0.0.1:${address.port}/mcp`;
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${operatorToken}` } })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://untrusted.example' } })).status, 403);
    const hostileHostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, host: 'untrusted.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/bootstrap`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${webAddress.port}/api/bootstrap`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${internalAddress.port}/internal/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status, 401);
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status, 405);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'usage'));
    assert.ok(tools.tools.some(tool => tool.name === 'readme'));
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as { type: string; text: string }[];
      assert.ok(!JSON.stringify(result).includes(token));
      return { response: result, value: JSON.parse(content[0]!.text) };
    };
    assert.equal((await call('readme', {})).value.result.name, 'AI 직원 시스템');
    const usage = await call('usage', { tool: 'organization_create' });
    assert.equal(usage.value.result.tools[0].name, 'organization_create');
    const input = { name: '외부에서 생성', idempotencyKey: 'org' };
    const created = await call('organization_create', input);
    assert.ok(!created.response.isError);
    assert.deepEqual((await call('organization_create', input)).value, created.value);
    const organizationId = created.value.result.result.organizationId;
    assert.equal(store.get('organizations', organizationId)?.name, '외부에서 생성');
    const employee = await call('employee_create', { name: '외부 생성 AI', responsibility: '검토', role: 'worker', model: 'gpt-6.1-sol', idempotencyKey: 'employee' });
    assert.ok(!employee.response.isError);
    const employeeId = employee.value.result.result.employeeId;
    const aiToken = store.tokenIssue(employeeId);
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${aiToken}` } })).status, 401);
    assert.ok((await call('records_list', { table: 'mcp_tokens' })).response.isError);
    assert.ok((await call('organization_delete', { organizationId, expectedRevision: 1, idempotencyKey: 'missing-confirm' })).response.isError);
    const removed = await call('organization_delete', { organizationId, expectedRevision: 1, confirm: true, idempotencyKey: 'remove' });
    assert.ok(!removed.response.isError);
    assert.equal(store.get('organizations', organizationId), undefined);
    assert.ok(store.row("SELECT * FROM audit_events WHERE actor='external-admin' AND action='admin.organization_delete'"));
  } finally {
    await client.close();
    await Promise.all([admin, web, internal].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    store.close();
  }
});
