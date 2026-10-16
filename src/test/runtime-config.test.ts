import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runtimePaths, resolveCodexBin, runnerEnvironment, ensureRuntimeDirectories } from '../app/runtime-config.ts';
import { Runner } from '../app/runner.ts';
import { Store } from '../app/store.ts';

test('실행 폴더의 workspace와 data를 기본값으로 쓰고 폐기한 HOST 설정은 무시한다', () => {
  const base = process.cwd();
  const defaults = runtimePaths({}, base, join(base, 'home'));
  assert.equal(defaults.workspaceRoot, join(base, 'workspace'));
  assert.equal(defaults.codexHome, join(base, 'home', '.codex'));
  assert.equal(defaults.dbPath, join(base, 'data', 'ai-employee.sqlite'));
  const legacy = runtimePaths({ WORKSPACE_HOST_PATH: base, CODEX_HOME_HOST: join(base, 'auth'), DATA_HOST_PATH: join(base, 'db'), LOG_SOURCE_ROOT: '/codex-home/sessions' }, base, base);
  assert.equal(legacy.workspaceRoot, join(base, 'workspace'));
  assert.equal(legacy.codexHome, join(base, '.codex'));
  assert.equal(legacy.dbPath, join(base, 'data', 'ai-employee.sqlite'));
  const explicit = runtimePaths({ WORKSPACE_ROOT: base, CODEX_HOME: base, DB_PATH: join(base, 'db.sqlite'), WORKSPACE_HOST_PATH: 'ignored' }, base, base);
  assert.equal(explicit.workspaceRoot, base);
  assert.equal(explicit.dbPath, join(base, 'db.sqlite'));
});

test('기본 workspace·data만 생성하고 인증 폴더나 기존 DB는 변경하지 않는다', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-directories-')));
  try {
    const paths = runtimePaths({}, root, join(root, 'home'));
    ensureRuntimeDirectories(paths, {});
    assert.ok(existsSync(join(root, 'workspace')));
    assert.ok(existsSync(join(root, 'data')));
    assert.equal(existsSync(paths.codexHome), false);
    assert.equal(existsSync(paths.dbPath), false);
    const custom = runtimePaths({ WORKSPACE_ROOT: join(root, 'missing') }, root, root);
    assert.throws(() => ensureRuntimeDirectories(custom, { WORKSPACE_ROOT: custom.workspaceRoot }));
    assert.equal(existsSync(custom.workspaceRoot), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows에서는 셸 shim 대신 native Codex 실행 파일을 선택한다', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-codex-')));
  try {
    const shimDir = join(root, 'shim'), nativeDir = join(root, 'native');
    mkdirSync(shimDir); mkdirSync(nativeDir);
    writeFileSync(join(shimDir, 'codex.cmd'), '@echo off');
    writeFileSync(join(nativeDir, 'codex.exe'), 'fixture');
    assert.equal(resolveCodexBin('codex', { PATH: `${shimDir};${nativeDir}` }, 'win32'), realpathSync(join(nativeDir, 'codex.exe')));
    assert.throws(() => resolveCodexBin(join(shimDir, 'codex.cmd'), {}, 'win32'), /CODEX_BIN/);
    assert.throws(() => resolveCodexBin('codex', { PATH: shimDir }, 'win32'), /CODEX_BIN/);
    const vendor = join(shimDir, 'node_modules', '@openai', 'codex', 'vendor', process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', 'bin');
    mkdirSync(vendor, { recursive: true });
    writeFileSync(join(shimDir, 'node_modules', '@openai', 'codex', 'package.json'), '{"name":"@openai/codex"}');
    writeFileSync(join(vendor, 'codex.exe'), 'fixture');
    assert.equal(resolveCodexBin('codex', { PATH: `${shimDir};${nativeDir}` }, 'win32'), realpathSync(join(vendor, 'codex.exe')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('로컬 종료는 실행 중인 자식을 중지하고 Run과 토큰 정리를 기다린다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-runner-stop-')));
  const store = new Store(':memory:');
  writeFileSync(join(root, 'exec'), 'process.stdin.resume(); setInterval(()=>{},1000);', 'utf8');
  const runner = new Runner(store, { codexBin: process.execPath, workspaceRoot: root, codexHome: root, mcpUrl: 'http://127.0.0.1', autoResume: false, retryableExitCodes: [], maxRetries: 0 });
  try {
    store.employeeCreate('operator', 'e', { name: 'AI', responsibility: '종료 확인', role: 'worker', model: 'gpt-6.1-sol', persona: '', skillIds: [], cwd: root });
    const pending = runner.runOne();
    await runner.shutdown();
    await pending;
    assert.equal(store.list('runs')[0]?.status, 'cancelled');
    assert.equal(store.rows('SELECT * FROM mcp_tokens').length, 0);
  } finally { await runner.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Runner는 사용자·OS 환경만 전달하고 운영자 토큰과 임의 비밀은 전달하지 않는다', () => {
  const env = runnerEnvironment({ PATH: 'bin', USERPROFILE: 'user', APPDATA: 'app', LOCALAPPDATA: 'local', SystemRoot: 'windows', TEMP: 'temp', OPERATOR_TOKEN: 'secret', ADMIN_MCP_TOKEN: 'admin-secret', OPENAI_API_KEY: 'secret', NODE_OPTIONS: 'untrusted' }, 'codex-home');
  assert.equal(env.USERPROFILE, 'user');
  assert.equal(env.SystemRoot, 'windows');
  assert.equal(env.CODEX_HOME, 'codex-home');
  assert.equal(env.OPERATOR_TOKEN, undefined);
  assert.equal(env.ADMIN_MCP_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test('로컬 start의 env 파일 로딩으로 HTTP 서비스를 시작하고 종료한다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'npm-local-start-')));
  const appRoot = fileURLToPath(new URL('../', import.meta.url));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const mcpProbe = createServer();
  await new Promise<void>(resolve => mcpProbe.listen(0, '127.0.0.1', resolve));
  const mcpAddress = mcpProbe.address();
  assert.ok(mcpAddress && typeof mcpAddress !== 'string');
  const mcpPort = mcpAddress.port;
  const adminProbe = createServer();
  await new Promise<void>(resolve => adminProbe.listen(0, '127.0.0.1', resolve));
  const adminAddress = adminProbe.address();
  assert.ok(adminAddress && typeof adminAddress !== 'string');
  const adminPort = adminAddress.port;
  const adminToken = 'local-admin-test-token-12345678901234567890';
  await new Promise<void>(resolve => probe.close(() => resolve()));
  await new Promise<void>(resolve => mcpProbe.close(() => resolve()));
  await new Promise<void>(resolve => adminProbe.close(() => resolve()));
  const envFile = join(root, 'test.env');
  writeFileSync(envFile, Object.entries({ OPERATOR_TOKEN: 'local-start-test-token', WORKSPACE_ROOT: root, CODEX_HOME: root, DB_PATH: join(root, 'app.sqlite'), LOG_SOURCE_ROOT: join(root, 'sessions'), CODEX_BIN: process.execPath, HOST: '127.0.0.1', PORT: String(port), MCP_PORT: String(mcpPort), ADMIN_MCP_PORT: String(adminPort), ADMIN_MCP_TOKEN: adminToken, AUTO_RESUME_ENABLED: 'false' }).map(([key, value]) => `${key}=${JSON.stringify(value.replaceAll('\\', '/'))}`).join('\n'), 'utf8');
  const env = { ...process.env };
  for (const key of ['OPERATOR_TOKEN', 'WORKSPACE_ROOT', 'CODEX_HOME', 'DB_PATH', 'LOG_SOURCE_ROOT', 'CODEX_BIN', 'HOST', 'PORT', 'MCP_PORT', 'ADMIN_MCP_PORT', 'ADMIN_MCP_TOKEN', 'AUTO_RESUME_ENABLED']) delete env[key];
  const child = spawn(process.execPath, [`--env-file=${envFile}`, '--import', 'tsx', 'app/main.ts'], { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += String(chunk));
  child.stderr.on('data', chunk => output += String(chunk));
  const exited = once(child, 'exit');
  try {
    let healthy = false;
    for (let count = 0; count < 60; count++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        healthy = response.ok;
      } catch { /* 시작 준비 중에는 연결이 아직 열리지 않습니다. */ }
      if (healthy) break;
      await delay(100);
    }
    assert.ok(healthy, output);
    const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`, { headers: { authorization: 'Bearer local-start-test-token' } });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { workspaceRoot: string }).workspaceRoot, root);
    assert.equal((await fetch(`http://127.0.0.1:${port}/internal/mcp`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${mcpPort}/api/bootstrap`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${mcpPort}/internal/mcp`)).status, 401);
    assert.match(output, new RegExp(`MCP server: http://127.0.0.1:${mcpPort}/internal/mcp`));
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/mcp`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/mcp`, { headers: { authorization: `Bearer ${adminToken}` } })).status, 405);
    assert.match(output, new RegExp(`Admin MCP: http://127.0.0.1:${adminPort}/mcp`));
    assert.ok(!output.includes(adminToken));
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
