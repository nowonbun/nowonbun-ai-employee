import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexArgs, retryAt } from './domain.js';
import type { Row } from './db.js';
import { AppError, type Store } from './store.js';

export type RunnerOptions = { codexBin: string; workspaceRoot: string; codexHome: string; mcpUrl: string; autoResume: boolean; retryableExitCodes: number[]; maxRetries: number; maxConcurrent?: number; maxRunMs?: number };

function mask(value: string, token: string | null): string {
  const withoutToken = token ? value.replaceAll(token, '[REDACTED]') : value;
  return withoutToken.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}

export class Runner {
  private timer: NodeJS.Timeout | null = null;
  private active = 0;
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  private cancelled = new Set<string>();
  constructor(private readonly store: Store, private readonly options: RunnerOptions) {}
  start(): void {
    if (this.timer) return;
    this.store.recoverInterrupted();
    this.timer = setInterval(() => {
      if (this.active >= (this.options.maxConcurrent ?? 2)) return;
      this.active++;
      void this.runOne().catch(error => process.stderr.write(`runner error: ${String(error)}\n`)).finally(() => { this.active--; });
    }, 1000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  cancelRun(runId: string): boolean {
    const child = this.children.get(runId);
    if (!child) return false;
    this.cancelled.add(runId);
    this.store.audit('operator', 'run.cancel.request', runId);
    child.kill('SIGTERM');
    return true;
  }
  private cwdFor(employee: Row): string {
    const root = realpathSync(this.options.workspaceRoot);
    const cwd = realpathSync(String(employee.cwd));
    const rel = relative(root, cwd);
    if (rel.startsWith('..') || rel.startsWith('/') || rel === '..') throw new AppError('FORBIDDEN', 'cwd outside workspace root', 403);
    return cwd;
  }
  private prompt(job: Row, session: Row, employee: Row): string {
    if (String(job.kind).startsWith('interview_')) return [
      '당신은 사용자와 1:1 면담을 진행하는 AI 직원입니다. 일반 업무의 쓰기·위임·외부 부작용을 수행하지 말고 상담에 대한 응답만 반환하세요.',
      `담당 업무: ${employee.responsibility}`,
      `페르소나:\n${session.persona}`,
      `면담 발언:\n${job.prompt}`
    ].join('\n\n');
    const parts = [
      '당신은 AI 직원입니다. DB의 작업·업무 지시·업무 일지를 기준 원본으로 삼고 추측으로 완료 처리하지 마세요.',
      `역할: ${employee.role === 'manager' ? '관리 AI' : '작업 AI'}`,
      `담당 업무: ${employee.responsibility}`,
      `페르소나:\n${session.persona}`,
      `현재 요청:\n${job.prompt}`
    ];
    const skillIds = JSON.parse(String(session.skill_ids)) as string[];
    for (const skillId of skillIds) { const skill = this.store.get('skills', skillId); if (skill) parts.push(`기본 스킬:\n${skill.content}`); }
    if (job.kind === 'task' && job.ref_id) {
      const task = this.store.get('tasks', String(job.ref_id));
      if (task) {
        parts.push(`Task 正本: ${JSON.stringify(task)}`);
        const logs = this.store.rows('SELECT * FROM work_logs WHERE task_id=? AND author_id=? ORDER BY created_at DESC LIMIT 3', String(job.ref_id), String(employee.id));
        if (logs.length) parts.push(`본인의 업무 일지: ${JSON.stringify(logs)}`);
      }
    }
    if (employee.role === 'manager') {
      parts.push('직원 위임, 작업 생성, 보고에는 ai_employee System MCP에서 허용된 도구를 사용하세요. 도구 응답이 끊기면 같은 idempotency_key로 operation_get을 조회하세요.');
      const inbox = this.store.inboxFor(String(employee.id));
      if (inbox.length) parts.push(`未処理 inbox: ${JSON.stringify(inbox)}`);
      const orders = this.store.rows("SELECT * FROM work_orders WHERE manager_id=? AND status IN ('queued','active') ORDER BY created_at LIMIT 20", String(employee.id));
      if (orders.length) parts.push(`업무 지시: ${JSON.stringify(orders)}`);
      const cycles = this.store.rows("SELECT c.* FROM work_cycles c JOIN work_processes p ON p.id=c.process_id WHERE p.manager_id=? AND c.outcome IN ('due','missed') ORDER BY c.scheduled_at DESC LIMIT 20", String(employee.id));
      if (cycles.length) parts.push(`계속 업무의 미완료 실행 회차: ${JSON.stringify(cycles)}`);
    }
    return parts.join('\n\n');
  }
  async runOne(): Promise<boolean> {
    const job = this.store.claimJob();
    if (!job) return false;
    const session = this.store.get('sessions', String(job.session_id));
    const employee = this.store.get('employees', String(job.employee_id));
    if (!session || !employee) throw new Error('database reference missing');
    const runId = this.store.startRun(job, String(session.model));
    let token: string | null = null;
    try {
      if (employee.status !== 'active') throw new AppError('FORBIDDEN', 'employee inactive', 403);
      if (job.kind === 'task') {
        const task = job.ref_id ? this.store.get('tasks', String(job.ref_id)) : null;
        if (!task || task.worker_id !== employee.id || !['queued','active'].includes(String(task.status))) throw new AppError('FORBIDDEN', 'task no longer runnable', 403);
        if (!this.store.row('SELECT * FROM call_permissions WHERE manager_id=? AND worker_id=?', String(task.manager_id), String(employee.id))) throw new AppError('FORBIDDEN', 'call permission revoked', 403);
        if (task.work_order_id) {
          const order = this.store.get('work_orders', String(task.work_order_id));
          if (!order || order.status === 'paused') throw new AppError('FORBIDDEN', 'work order paused', 403);
        }
      }
      const interview = String(job.kind).startsWith('interview_');
      const initializing = job.kind === 'initialize' || job.kind === 'interview_init';
      if (!initializing && !session.codex_id) throw new AppError('EXECUTION_UNKNOWN', 'real Codex session ID missing', 409);
      const cwd = this.cwdFor(employee);
      if (!interview) token = this.store.tokenIssue(String(employee.id));
      const args = buildCodexArgs(String(session.model), session.codex_id ? String(session.codex_id) : null, cwd);
      const mcpScript = join(dirname(fileURLToPath(import.meta.url)), 'mcp.js');
      const configs = [
        '--ignore-user-config',
        '-c', 'mcp_servers={}',
        '-c', `sandbox_mode=${JSON.stringify(interview ? 'read-only' : 'workspace-write')}`,
        '-c', `mcp_servers.ai_employee.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.ai_employee.args=${JSON.stringify([mcpScript])}`,
        '-c', 'mcp_servers.ai_employee.env_vars=["AI_EMPLOYEE_MCP_TOKEN","AI_EMPLOYEE_MCP_URL"]'
      ];
      args.splice(args.length - 1, 0, ...(interview ? configs.slice(0, 5) : configs));
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: this.options.codexHome,
        LANG: process.env.LANG || 'C.UTF-8'
      };
      if (token) { env.AI_EMPLOYEE_MCP_TOKEN = token; env.AI_EMPLOYEE_MCP_URL = this.options.mcpUrl; }
      const child = spawn(this.options.codexBin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      this.children.set(runId, child);
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, this.options.maxRunMs ?? 4 * 3600000);
      deadline.unref();
      const prompt = this.prompt(job, session, employee);
      child.stdin.end(prompt);
      let stdout = ''; let stderr = ''; let toolSeen = false; let startedId: string | null = null; let fatal: Error | null = null; let retryAfterAt: number | null = null;
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
        while (stdout.includes('\n')) {
          const index = stdout.indexOf('\n'); const line = stdout.slice(0, index); stdout = stdout.slice(index + 1);
          if (line.length > 100000) continue;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; }
          catch { this.store.appendEvent(String(session.id), runId, 'parser_error', '잘못된 JSONL 행을 격리했습니다.'); continue; }
          try {
            if (typeof event.retry_after_ms === 'number' && Number.isFinite(event.retry_after_ms) && event.retry_after_ms >= 0) retryAfterAt = Math.max(retryAfterAt ?? 0, Date.now() + event.retry_after_ms);
            if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
              startedId = event.thread_id;
              this.store.bindCodexSession(String(session.id), startedId);
            }
            if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
              const item = event.item as Record<string, unknown>;
              if (item.type === 'agent_message' && typeof item.text === 'string') this.store.appendEvent(String(session.id), runId, 'assistant', mask(item.text, token));
              if (item.type === 'command_execution' || item.type === 'mcp_tool_call') {
                toolSeen = true;
                const content = typeof item.aggregated_output === 'string' ? item.aggregated_output : typeof item.result === 'string' ? item.result : '';
                this.store.appendEvent(String(session.id), runId, 'tool', mask(content, token).slice(0, 10000));
              }
            }
            if (event.type === 'turn.completed') this.store.appendEvent(String(session.id), runId, 'usage', mask(JSON.stringify(event.usage ?? {}), token));
          } catch (error) { fatal = error instanceof Error ? error : new Error('event processing failed'); child.kill('SIGTERM'); }
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      const exitCode = await new Promise<number | null>(resolve => {
        child.once('error', error => { stderr = String(error); resolve(null); });
        child.once('close', code => resolve(code));
      });
      clearTimeout(deadline);
      if (fatal) throw fatal;
      if (this.cancelled.has(runId)) {
        this.store.finishRun(runId, String(job.id), 'cancelled', exitCode, 'operator_cancelled', null);
      } else if (timedOut) {
        this.store.finishRun(runId, String(job.id), 'needs_attention', exitCode, 'run_timeout', null);
      } else if (exitCode === 0 && (!initializing || startedId || this.store.get('sessions', String(session.id))?.codex_id)) {
        this.store.finishRun(runId, String(job.id), 'completed', 0, '', null);
      } else {
        const resumable = this.options.autoResume && exitCode !== null && this.options.retryableExitCodes.includes(exitCode) && Number(job.attempt) <= this.options.maxRetries && Boolean(this.store.get('sessions', String(session.id))?.codex_id) && !toolSeen;
        const retryHeader = stderr.match(/Retry-After:\s*(\d+)/i);
        if (retryHeader) retryAfterAt = Math.max(retryAfterAt ?? 0, Date.now() + Number(retryHeader[1]) * 1000);
        const due = retryAt(Date.now(), retryAfterAt, resumable);
        const reason = exitCode === 0 ? 'session_id_missing' : `exit_${exitCode ?? 'unknown'}: ${mask(stderr, token).slice(0, 500)}`;
        this.store.finishRun(runId, String(job.id), due === null ? 'needs_attention' : 'cooldown', exitCode, reason, due);
      }
    } catch (error) {
      this.store.finishRun(runId, String(job.id), 'needs_attention', null, error instanceof Error ? error.message.slice(0, 500) : 'unknown', null);
    } finally { this.children.delete(runId); this.cancelled.delete(runId); if (token) this.store.tokenRevoke(token); }
    return true;
  }
}
