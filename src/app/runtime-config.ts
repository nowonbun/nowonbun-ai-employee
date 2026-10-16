import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

export function runtimePorts(env: NodeJS.ProcessEnv): { port: number; mcpPort: number } {
  const parse = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be an integer between 1 and 65535`);
    return value;
  };
  const port = parse('PORT', 3000), mcpPort = parse('MCP_PORT', 3001);
  if (port === mcpPort) throw new Error('PORT and MCP_PORT must be different');
  return { port, mcpPort };
}

export function adminMcpConfig(env: NodeJS.ProcessEnv, ports = runtimePorts(env)) {
  const token = env.ADMIN_MCP_TOKEN?.trim() || '';
  const port = Number(env.ADMIN_MCP_PORT ?? '3002');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('ADMIN_MCP_PORT must be an integer between 1 and 65535');
  if (token && !/^[A-Za-z0-9._~-]{32,4096}$/.test(token)) throw new Error('ADMIN_MCP_TOKEN must contain 32 to 4096 URL-safe characters');
  if (token && (port === ports.port || port === ports.mcpPort)) throw new Error('ADMIN_MCP_PORT, PORT and MCP_PORT must be different');
  if (token && token === env.OPERATOR_TOKEN) throw new Error('ADMIN_MCP_TOKEN must be distinct from OPERATOR_TOKEN');
  return { enabled: !!token, port, token };
}

export function runtimePaths(env: NodeJS.ProcessEnv, appRoot: string, home = homedir()) {
  const workspaceRoot = env.WORKSPACE_ROOT || join(appRoot, 'workspace');
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const dbPath = env.DB_PATH || join(appRoot, 'data', 'ai-employee.sqlite');
  const logRoot = env.LOG_SOURCE_ROOT || join(codexHome, 'sessions');
  for (const [name, path] of Object.entries({ WORKSPACE_ROOT: workspaceRoot, CODEX_HOME: codexHome, DB_PATH: dbPath, LOG_SOURCE_ROOT: logRoot })) {
    if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  }
  return { workspaceRoot, codexHome, dbPath, logRoot };
}

export function ensureRuntimeDirectories(paths: ReturnType<typeof runtimePaths>, env: NodeJS.ProcessEnv): void {
  // 로컬 기본 작업 폴더만 자동 생성합니다. 명시한 작업 위치는 기존 폴더여야 합니다.
  if (!env.WORKSPACE_ROOT) mkdirSync(paths.workspaceRoot, { recursive: true });
  if (!statSync(paths.workspaceRoot).isDirectory()) throw new Error('WORKSPACE_ROOT must be a directory');
  mkdirSync(dirname(paths.dbPath), { recursive: true });
}

export function resolveCodexBin(requested = 'codex', env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return requested;
  if (/\.(cmd|bat|ps1)$/i.test(requested)) throw new Error('CODEX_BIN에는 셸 shim 대신 codex.exe의 절대 경로를 지정하세요.');
  const file = (path: string) => existsSync(path) && statSync(path).isFile();
  if (isAbsolute(requested)) {
    if (!file(requested)) throw new Error('CODEX_BIN 실행 파일이 없습니다.');
    return realpathSync(requested);
  }
  if (requested !== 'codex' && requested !== 'codex.exe') throw new Error('CODEX_BIN에는 codex.exe의 절대 경로를 지정하세요.');
  const dirs = (env.PATH || env.Path || '').split(';').map(path => path.replace(/^"|"$/g, '')).filter(path => isAbsolute(path));
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  for (const dir of dirs) {
    const native = join(dir, 'codex.exe');
    if (file(native)) return realpathSync(native);
    // PATH 우선순위를 유지하면서 npm 전역 설치의 native 실행 파일을 찾습니다.
    const packageRoot = join(dir, 'node_modules', '@openai', 'codex');
    const manifest = join(packageRoot, 'package.json');
    if (!file(manifest)) continue;
    let vendor = join(packageRoot, 'vendor');
    try {
      const require = createRequire(manifest);
      vendor = join(dirname(require.resolve(`@openai/codex-win32-${process.arch}/package.json`)), 'vendor');
    } catch { /* 이전 CLI 패키지의 vendor 레이아웃을 확인합니다. */ }
    const npmNative = join(vendor, target, 'bin', 'codex.exe');
    if (file(npmNative)) return realpathSync(npmNative);
  }
  throw new Error('Codex CLI를 찾을 수 없습니다. codex.exe를 설치하고 PATH 또는 CODEX_BIN을 설정하세요.');
}

export function runnerEnvironment(source: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.CODEX_HOME = codexHome;
  env.LANG = source.LANG || 'C.UTF-8';
  return env;
}
