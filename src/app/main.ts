import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { Scheduler } from './scheduler.js';
import { LogReader } from './log-reader.js';
import { createServer } from './server.js';

function integer(name: string, fallback: string, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
const port = integer('PORT', '3000', 1, 65535);
const operatorToken = process.env.OPERATOR_TOKEN ?? '';
if (operatorToken.length < 16) throw new Error('OPERATOR_TOKEN must have at least 16 characters');
const workspaceRoot = realpathSync(process.env.WORKSPACE_ROOT ?? '/workspace');
const codexHome = realpathSync(process.env.CODEX_HOME ?? '/codex-home');
const dataPath = process.env.DB_PATH ?? '/data/ai-employee.sqlite';
if (!isAbsolute(dataPath)) throw new Error('DB_PATH must be absolute');
const maxConcurrent = integer('MAX_CONCURRENT_RUNS', '2', 1, 16);
const maxRetries = integer('MAX_RETRIES', '3', 0, 20);
const maxRunHours = integer('MAX_RUN_HOURS', '4', 1, 24);
const autoResume = process.env.AUTO_RESUME_ENABLED === 'true';
const retryableExitCodes = (process.env.RETRYABLE_EXIT_CODES ?? '').split(',').filter(Boolean).map(Number);
if (retryableExitCodes.some(value => !Number.isSafeInteger(value) || value < 0 || value > 255)) throw new Error('RETRYABLE_EXIT_CODES must contain exit codes from 0 to 255');
if (autoResume && retryableExitCodes.length === 0) throw new Error('AUTO_RESUME_ENABLED requires explicit RETRYABLE_EXIT_CODES');
mkdirSync(dirname(dataPath), { recursive: true });
const store = new Store(dataPath);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const logRoot = String(store.settingGet('log_source_root')?.value || process.env.LOG_SOURCE_ROOT || join(codexHome, 'sessions'));
const logPath = existsSync(logRoot) ? realpathSync(logRoot) : null;
const logRelative = logPath ? relative(codexHome, logPath) : null;
const logReader = logPath && logRelative !== null && !logRelative.startsWith('..') && !logRelative.startsWith('/') ? new LogReader(store, logPath) : undefined;
const modelChoices = (process.env.MODEL_CHOICES ?? 'gpt-6.1-sol').split(',').map(value => value.trim()).filter(Boolean);
const runner = new Runner(store, {
  codexBin: process.env.CODEX_BIN ?? 'codex', workspaceRoot, codexHome,
  mcpUrl: `http://127.0.0.1:${port}`,
  autoResume, retryableExitCodes, maxRetries, maxConcurrent, maxRunMs: maxRunHours * 3600000
});
const server = createServer(store, { operatorToken, publicDir, workspaceRoot, codexHome, logRoot: logReader ? logPath! : undefined, logReader, modelChoices, runCancel: runId => runner.cancelRun(runId) });
const scheduler = new Scheduler(store);
server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  runner.start(); scheduler.start();
  process.stdout.write(`AI employee service listening on ${port}\n`);
});
process.on('SIGTERM', () => { runner.stop(); scheduler.stop(); server.close(() => { store.close(); process.exit(0); }); });
