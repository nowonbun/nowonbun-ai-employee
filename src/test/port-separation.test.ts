import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createMcpServer } from '../app/server.ts';
import { Store } from '../app/store.ts';
import { runtimePorts } from '../app/runtime-config.ts';
import { createServer as netServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('웹·MCP 포트 기본값은 다르고 동일·범위 밖 설정을 거부한다', () => {
  assert.deepEqual(runtimePorts({}), { port: 3000, mcpPort: 3001 });
  assert.deepEqual(runtimePorts({ PORT: '4000', MCP_PORT: '4001' }), { port: 4000, mcpPort: 4001 });
  assert.throws(() => runtimePorts({ PORT: '3000', MCP_PORT: '3000' }), /different/);
  for (const value of ['0', '65536', 'abc', '2.5']) assert.throws(() => runtimePorts({ MCP_PORT: value }), /MCP_PORT/);
});

test('웹 또는 MCP 포트 점유 시 시작을 실패시키고 나머지 리스너를 닫는다', async () => {
  for (const occupied of ['web', 'mcp', 'admin']) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-port-conflict-')));
    const busy = netServer(), spare = netServer(), third = netServer();
    await new Promise<void>(resolve => busy.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => spare.listen(0, '127.0.0.1', resolve));
    const busyAddress = busy.address(), spareAddress = spare.address();
    assert.ok(busyAddress && typeof busyAddress !== 'string' && spareAddress && typeof spareAddress !== 'string');
    const freePort = spareAddress.port;
    await new Promise<void>(resolve => third.listen(0, '127.0.0.1', resolve));
    const thirdAddress = third.address();
    assert.ok(thirdAddress && typeof thirdAddress !== 'string');
    const thirdPort = thirdAddress.port;
    await new Promise<void>(resolve => third.close(() => resolve()));
    await new Promise<void>(resolve => spare.close(() => resolve()));
    const env = { ...process.env, OPERATOR_TOKEN: 'test-conflict-operator', WORKSPACE_ROOT: root, CODEX_HOME: root, DB_PATH: join(root, 'app.sqlite'), LOG_SOURCE_ROOT: join(root, 'sessions'), CODEX_BIN: process.execPath, PORT: String(occupied === 'web' ? busyAddress.port : freePort), MCP_PORT: String(occupied === 'mcp' ? busyAddress.port : occupied === 'web' ? freePort : thirdPort), ADMIN_MCP_PORT: String(occupied === 'admin' ? busyAddress.port : thirdPort), ADMIN_MCP_TOKEN: 'test-admin-conflict-token-12345678901234567890', HOST: '127.0.0.1', AUTO_RESUME_ENABLED: 'false' };
    const child = spawn(process.execPath, ['--import', 'tsx', 'app/main.ts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => output += String(chunk));
    child.stderr.on('data', chunk => output += String(chunk));
    const exited = once(child, 'exit');
    const deadline = setTimeout(() => child.kill('SIGTERM'), 8000);
    try {
      const [code] = await exited;
      assert.equal(code, 1, output);
      assert.match(output, /EADDRINUSE/);
      await new Promise<void>((resolve, reject) => {
        spare.once('error', reject);
        spare.listen(freePort, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve, reject) => { third.once('error', reject); third.listen(thirdPort, '127.0.0.1', resolve); });
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
      await Promise.all([busy, spare, third].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('웹과 MCP 리스너는 라우트·인증을 교차 허용하지 않는다', async () => {
  const store = new Store(':memory:');
  const operatorToken = 'separation-operator-token';
  const web = createServer(store, { operatorToken, publicDir: process.cwd(), workspaceRoot: process.cwd() });
  const mcp = createMcpServer(store);
  try {
    await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve));
    await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve));
    const wa = web.address(), ma = mcp.address();
    assert.ok(wa && typeof wa !== 'string' && ma && typeof ma !== 'string');
    assert.notEqual(wa.port, ma.port);
    const webUrl = `http://127.0.0.1:${wa.port}`, mcpUrl = `http://127.0.0.1:${ma.port}`;
    const employee = store.employeeCreate('operator', 'one', { name: 'AI', responsibility: '분리 확인', role: 'manager', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: process.cwd() });
    const aiToken = store.tokenIssue(employee.employeeId);
    const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
    const body = JSON.stringify({ tool: 'allowed_workers', args: {} });
    for (const path of ['/internal/mcp', '/internal/mcp-observation']) assert.equal((await fetch(webUrl + path, { method: 'POST', headers: headers(aiToken), body })).status, 404);
    for (const path of ['/', '/healthz', '/app.js', '/api/bootstrap', '/api/ai-policy']) assert.equal((await fetch(mcpUrl + path, { headers: headers(operatorToken) })).status, 404);
    assert.equal((await fetch(`${mcpUrl}/internal/mcp`, { method: 'POST', headers: headers(operatorToken), body })).status, 401);
    assert.equal((await fetch(`${webUrl}/api/bootstrap`, { headers: headers(aiToken) })).status, 401);
    const result = await fetch(`${mcpUrl}/internal/mcp`, { method: 'POST', headers: headers(aiToken), body });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), []);
    assert.equal((await fetch(`${webUrl}/api/bootstrap`, { headers: headers(operatorToken) })).status, 200);
  } finally {
    await Promise.all([web, mcp].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    store.close();
  }
});
