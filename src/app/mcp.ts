import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

const endpoint = process.env.AI_EMPLOYEE_MCP_URL;
const token = process.env.AI_EMPLOYEE_MCP_TOKEN;
if (!endpoint || !token) throw new Error('MCP connection is not configured');
const url = new URL('/internal/mcp', endpoint);
if (
  url.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(url.hostname)
)
  throw new Error('MCP endpoint must be loopback HTTP');

async function call(
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const callId = randomUUID();
  const observe = async (body: Record<string, unknown>) => {
    try {
      const response = await fetch(new URL('/internal/mcp-observation', url), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ callId, ...body }), signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) process.stderr.write('MCP 지표 부분 수집: 관측 저장 실패\n');
    } catch { process.stderr.write('MCP 지표 부분 수집: 관측 서버 접근 실패\n'); }
  };
  await observe({ phase: 'start', tool, targetId: tool === 'task_delegate' ? args.worker_id : null });
  const started = performance.now();
  let status = 'failed', errorCode: string | null = null;
  try {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ callId, tool, args }),
    signal: AbortSignal.timeout(8000),
  });
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    errorCode = 'MCP_RESPONSE_ERROR';
    throw new Error(
      `MCP ${tool}: ${JSON.stringify(value)}。응답 상태가 불분명하면 같은 idempotency_key로 조회·재전송하세요.`
    );
  }
  status = 'success';
  return value;
  } catch (error) {
    errorCode ??= error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR';
    throw error;
  } finally {
    await observe({ phase: 'end', status, durationMs: performance.now() - started, errorCode });
  }
}
const output = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});
const server = new McpServer({ name: 'ai-employee-system', version: '0.1.0' });

server.registerTool(
  'operation_get',
  {
    description: '본인이 접수한 비동기 Operation 상태를 가져옵니다.',
    inputSchema: { operation_id: z.string().uuid() },
  },
  async ({ operation_id }) =>
    output(await call('operation_get', { operation_id }))
);
server.registerTool(
  'allowed_workers',
  {
    description: '명시적으로 호출이 허용된 작업 AI를 가져옵니다.',
    inputSchema: {},
  },
  async () => output(await call('allowed_workers', {}))
);
server.registerTool(
  'inbox_list',
  { description: '본인에게 온 미처리 알림을 가져옵니다.', inputSchema: {} },
  async () => output(await call('inbox_list', {}))
);
server.registerTool(
  'inbox_ack',
  {
    description: '처리한 알림을 ACK 처리합니다.',
    inputSchema: { inbox_id: z.string().uuid() },
  },
  async ({ inbox_id }) => output(await call('inbox_ack', { inbox_id }))
);
server.registerTool(
  'work_order_get',
  {
    description: '담당하는 사용자의 업무 지시를 가져옵니다.',
    inputSchema: { work_order_id: z.string().uuid() },
  },
  async ({ work_order_id }) =>
    output(await call('work_order_get', { work_order_id }))
);
server.registerTool(
  'task_get',
  {
    description: '담당 작업의 현재 버전과 완료 조건을 가져옵니다.',
    inputSchema: { task_id: z.string().uuid() },
  },
  async ({ task_id }) => output(await call('task_get', { task_id }))
);
server.registerTool(
  'work_process_list',
  { description: '담당하는 계속 업무를 가져옵니다.', inputSchema: {} },
  async () => output(await call('work_process_list', {}))
);
server.registerTool(
  'work_process_create',
  {
    description: '사용자의 업무 지시에 연결된 계속 업무를 등록합니다.',
    inputSchema: {
      idempotency_key: z.string().min(1),
      work_order_id: z.string().uuid(),
      title: z.string().min(1),
      cron: z.string().min(1),
      timezone: z.string().min(1),
      deadline_minutes: z.number().int().positive(),
    },
  },
  async (args) => output(await call('work_process_create', args))
);
server.registerTool(
  'work_cycle_record',
  {
    description: '기한이 도래한 계속 업무 실행 회차에 결과·근거를 기록합니다.',
    inputSchema: {
      idempotency_key: z.string().min(1),
      process_id: z.string().uuid(),
      scheduled_at: z.number().int(),
      outcome: z.enum(['done', 'skipped_with_reason']),
      evidence: z.string().min(1),
      derived_task_ids: z.array(z.string().uuid()).default([]),
    },
  },
  async (args) => output(await call('work_cycle_record', args))
);
server.registerTool(
  'task_delegate',
  {
    description:
      '관리 AI가 허용된 작업 AI에게 작업을 비동기로 위임합니다. 응답 시간 초과 시 같은 키를 재사용하세요.',
    inputSchema: {
      idempotency_key: z.string().min(1),
      work_order_id: z.string().uuid().optional(),
      parent_task_id: z.string().uuid().optional(),
      worker_id: z.string().uuid(),
      title: z.string().min(1),
      goal: z.string().min(1),
      criteria: z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            weight: z.number().positive(),
          })
        )
        .min(1),
    },
  },
  async (args) => output(await call('task_delegate', args))
);
server.registerTool(
  'task_checkpoint',
  {
    description: '담당 작업의 완료 조건에 근거를 붙여 기록합니다.',
    inputSchema: {
      idempotency_key: z.string().min(1),
      task_id: z.string().uuid(),
      expected_revision: z.number().int().positive(),
      criterion_id: z.string().min(1),
      evidence: z.string().min(1),
    },
  },
  async (args) => output(await call('task_checkpoint', args))
);
server.registerTool(
  'work_log_append',
  {
    description: '본인의 다음 재개를 위한 업무 일지를 추가합니다.',
    inputSchema: {
      idempotency_key: z.string().min(1),
      task_id: z.string().uuid(),
      summary: z.string().min(1),
      completed: z.string().default(''),
      evidence: z.string().default(''),
      remaining: z.string().default(''),
      next_step: z.string().default(''),
    },
  },
  async (args) => output(await call('work_log_append', args))
);
server.registerTool(
  'task_result_submit',
  {
    description: '작업 AI가 작업 결과를 관리 AI의 받은 편지함에 제출합니다.',
    inputSchema: {
      idempotency_key: z.string().min(1),
      task_id: z.string().uuid(),
      expected_revision: z.number().int().positive(),
      result: z.string().min(1),
      evidence: z.string().min(1),
    },
  },
  async (args) => output(await call('task_result_submit', args))
);
server.registerTool(
  'work_order_report_submit',
  {
    description: '관리 AI가 사용자에게 결과 보고서를 제출합니다.',
    inputSchema: {
      idempotency_key: z.string().min(1),
      work_order_id: z.string().uuid(),
      expected_revision: z.number().int().positive(),
      report: z.string().min(1),
      evidence: z.string().min(1),
    },
  },
  async (args) => output(await call('work_order_report_submit', args))
);

await server.connect(new StdioServerTransport());
