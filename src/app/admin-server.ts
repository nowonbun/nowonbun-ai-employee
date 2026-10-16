import { createServer, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AdminService } from './admin-service.js';
import { AppError, type Store } from './store.js';

type Options = { token: string; service: AdminService; otherTokens?: string[] };
const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const reply = (response: ServerResponse, status: number, code: string) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify({ code }));
};

// 이 포트는 외부 관리 주체 전용이며 직원용 MCP와 웹 토큰을 받지 않습니다.
export function createAdminServer(store: Store, options: Options) {
  if (!/^[A-Za-z0-9._~-]{32,4096}$/.test(options.token)) throw new Error('ADMIN_MCP_TOKEN must contain 32 to 4096 URL-safe characters');
  if (options.otherTokens?.some(token => same(token, options.token)) || store.tokenResolve(options.token)) throw new Error('ADMIN_MCP_TOKEN must be distinct from operator and employee tokens');
  let active = 0;
  const server = createServer(async (request, response) => {
    let protocol: Server | undefined;
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname !== '/mcp' || url.search) { reply(response, 404, 'NOT_FOUND'); return; }
      const port = request.socket.localPort;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      if (!allowedHosts.includes((request.headers.host || '').toLowerCase()) || request.headers.origin !== undefined) { reply(response, 403, 'FORBIDDEN_ORIGIN_OR_HOST'); return; }
      const header = request.headers.authorization || '';
      if (!header.startsWith('Bearer ') || !same(header.slice(7), options.token)) { reply(response, 401, 'AUTH_REQUIRED'); return; }
      if (request.method !== 'POST') { response.setHeader('allow', 'POST'); reply(response, 405, 'METHOD_NOT_ALLOWED'); return; }
      if (active >= 16) { reply(response, 429, 'TOO_MANY_REQUESTS'); return; }
      active++;
      response.once('close', () => { active--; void protocol?.close(); });
      const redact = (value: unknown) => {
        let encoded = JSON.stringify(value);
        for (const token of [options.token, ...(options.otherTokens || [])]) if (token) encoded = encoded.replaceAll(token, '[REDACTED]');
        return encoded.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
      };
      protocol = new Server({ name: 'ai-employee-admin', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: '먼저 readme와 usage를 호출하세요. 관리 쓰기는 idempotencyKey, 제거·권한·정책 변경은 confirm:true가 필요합니다. 직원·작업 이력을 위조하지 마세요.' });
      protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: options.service.tools() }));
      protocol.setRequestHandler(CallToolRequestSchema, async request => {
        try {
          const result = await options.service.execute(request.params.name, request.params.arguments || {});
          const text = redact({ result });
          return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
        } catch (error) {
          const issue = error instanceof AppError ? error : new AppError('TEMPORARY_UNAVAILABLE', '관리 요청을 처리하지 못했습니다. 상태를 조회하고 재시도 여부를 판단하세요.', 503);
          const text = redact({ error: { code: issue.code, message: issue.message } });
          return { isError: true, content: [{ type: 'text', text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
        }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 65536 });
      await protocol.connect(transport);
      response.setHeader('cache-control', 'no-store');
      response.setHeader('x-content-type-options', 'nosniff');
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) reply(response, 500, 'TEMPORARY_UNAVAILABLE');
      else response.end();
      await protocol?.close();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  return server;
}
