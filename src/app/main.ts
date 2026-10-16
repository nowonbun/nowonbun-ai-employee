import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { Scheduler } from './scheduler.js';
import { LogReader } from './log-reader.js';
import { createServer, createMcpServer } from './server.js';
import { runtimePaths, resolveCodexBin, ensureRuntimeDirectories, runtimePorts, adminMcpConfig } from './runtime-config.js';
import type { Server } from 'node:http';
import { AdminService } from './admin-service.js';
import { createAdminServer } from './admin-server.js';

function integer(
  name: string,
  fallback: string,
  min: number,
  max: number
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
const { port, mcpPort } = runtimePorts(process.env);
const adminConfig = adminMcpConfig(process.env, { port, mcpPort });
const operatorToken = process.env.OPERATOR_TOKEN ?? '';
if (operatorToken.length < 16)
  throw new Error('OPERATOR_TOKEN must have at least 16 characters');
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const paths = runtimePaths(process.env, appRoot);
const codexHome = realpathSync(paths.codexHome);
const dataPath = paths.dbPath;
const codexBin = resolveCodexBin(process.env.CODEX_BIN || 'codex');
const maxConcurrent = integer('MAX_CONCURRENT_RUNS', '2', 1, 16);
const maxRetries = integer('MAX_RETRIES', '3', 0, 20);
const maxRunHours = integer('MAX_RUN_HOURS', '4', 1, 24);
const autoResume = process.env.AUTO_RESUME_ENABLED === 'true';
const retryableExitCodes = (process.env.RETRYABLE_EXIT_CODES ?? '')
  .split(',')
  .filter(Boolean)
  .map(Number);
if (
  retryableExitCodes.some(
    (value) => !Number.isSafeInteger(value) || value < 0 || value > 255
  )
)
  throw new Error('RETRYABLE_EXIT_CODES must contain exit codes from 0 to 255');
if (autoResume && retryableExitCodes.length === 0)
  throw new Error('AUTO_RESUME_ENABLED requires explicit RETRYABLE_EXIT_CODES');
ensureRuntimeDirectories(paths, process.env);
const workspaceRoot = realpathSync(paths.workspaceRoot);
const store = new Store(dataPath);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const logRoot = String(
  store.settingGet('log_source_root')?.value ||
    paths.logRoot
);
const logPath = existsSync(logRoot) ? realpathSync(logRoot) : null;
const logRelative = logPath ? relative(codexHome, logPath) : null;
const logReader =
  logPath &&
  logRelative !== null &&
  !logRelative.startsWith('..') &&
  !logRelative.startsWith('/')
    ? new LogReader(store, logPath)
    : undefined;
const modelChoices = (process.env.MODEL_CHOICES ?? 'gpt-6.1-sol')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const runner = new Runner(store, {
  codexBin,
  workspaceRoot,
  codexHome,
  mcpUrl: `http://127.0.0.1:${mcpPort}`,
  autoResume,
  retryableExitCodes,
  maxRetries,
  maxConcurrent,
  maxRunMs: maxRunHours * 3600000,
});
const sharedOptions = {
  operatorToken,
  publicDir,
  workspaceRoot,
  codexHome,
  logRoot: logReader ? logPath! : undefined,
  logReader,
  modelChoices,
  runCancel: (runId: string) => runner.cancelRun(runId),
  ports: { web: port, internalMcp: mcpPort, adminMcp: adminConfig.port },
};
const server = createServer(store, sharedOptions);
const adminServer = adminConfig.enabled ? createAdminServer(store, { token: adminConfig.token, otherTokens: [operatorToken], service: new AdminService(store, sharedOptions) }) : undefined;
const scheduler = new Scheduler(store);
const mcpServer = createMcpServer(store);
let stopping = false;
async function shutdown(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  runner.stop();
  scheduler.stop();
  const close = (listener: Server) => new Promise<void>(resolve => {
    if (!listener.listening) { resolve(); return; }
    listener.close(() => resolve());
    listener.closeIdleConnections();
  });
  await Promise.all([runner.shutdown(), close(server), close(mcpServer), ...(adminServer ? [close(adminServer)] : [])]);
  store.close();
  process.exitCode = exitCode;
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
const listen = (listener: Server, port: number, host: string) => new Promise<void>((resolve, reject) => {
  listener.once('error', reject);
  listener.listen(port, host, () => { listener.off('error', reject); resolve(); });
});
try {
  // 활성화된 모든 포트의 바인딩이 성공한 뒤에만 작업 처리를 시작합니다.
  if (adminServer) await listen(adminServer, adminConfig.port, '127.0.0.1');
  await listen(mcpServer, mcpPort, '127.0.0.1');
  await listen(server, port, process.env.HOST || '127.0.0.1');
  if (!stopping) {
    runner.start();
    scheduler.start();
    process.stdout.write(`Web server: http://${process.env.HOST || '127.0.0.1'}:${port}\nMCP server: http://127.0.0.1:${mcpPort}/internal/mcp\n`);
    process.stdout.write(adminServer ? `Admin MCP: http://127.0.0.1:${adminConfig.port}/mcp\n` : 'Admin MCP: disabled (ADMIN_MCP_TOKEN is empty)\n');
  }
} catch (error) {
  process.stderr.write(`서버 시작 실패: ${error instanceof Error ? error.message : String(error)}\n`);
  await shutdown(1);
}
