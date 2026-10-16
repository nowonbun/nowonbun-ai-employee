# 외부 AI 관리 MCP

## 개요와 접속

외부 AI가 이 제품의 웹 운영 기능과 관리 CRUD를 호출할 수 있는 별도 **Streamable HTTP MCP**입니다. 직원 간 위임용 `/internal/mcp`와 다른 서버·토큰을 사용합니다. 모델의 답변이 아니라 애플리케이션이 입력·권한·revision·멱등성을 검증합니다.

```dotenv
PORT=9999
MCP_PORT=3991
ADMIN_MCP_PORT=3992
ADMIN_MCP_TOKEN=<별도의_무작위_토큰>
```

- 포트 숫자는 예시입니다. 실제 값은 `src/.env`에서 설정합니다. 활성화한 세 포트는 서로 달라야 합니다.
- 외부 관리 MCP 주소: `http://127.0.0.1:<ADMIN_MCP_PORT>/mcp`.
- 접속 헤더: `Authorization: Bearer <ADMIN_MCP_TOKEN>`.
- 토큰은 32~4096자의 영문·숫자·`.`·`_`·`~`·`-`만 허용하며 웹 운영자·직원 토큰과 달라야 합니다. 32바이트 이상의 무작위 값을 사용하세요.
- `ADMIN_MCP_TOKEN`이 비어 있으면 관리 포트를 열지 않습니다. 토큰·포트 변경 후 서비스를 재시작하세요. 설정 파일이나 토큰을 저장소에 커밋하지 마세요.
- 기본 주소는 loopback입니다. 다른 PC의 AI를 연결하려면 별도로 **TLS 역방향 프록시 또는 보안 터널**을 구성해야 합니다. 이 변경은 방화벽·포트 포워딩·공개 배포를 수행하지 않습니다. 프록시는 원본 서버에 `Host: 127.0.0.1:<ADMIN_MCP_PORT>`를 전달하고, 바깥 구간에서 TLS와 접근 제어를 적용하세요.
- 브라우저 Origin이 있는 요청은 거부합니다. 브라우저 임베딩·CORS·OAuth 서버는 제공하지 않습니다. Bearer 헤더를 지정할 수 있는 MCP 클라이언트를 사용하세요. stateless 모드이므로 GET SSE·DELETE 세션 종료 대신 POST 요청/JSON 응답을 사용합니다.
- 관리 토큰을 가진 AI는 직원 생성·실행 접수·권한·공통 정책 변경까지 할 수 있습니다. 신뢰하는 관리 주체에게만 제공하세요. 직원 Runner 환경에는 이 토큰을 전달하지 않습니다.

## 먼저 호출할 두 함수

### `readme({})`

시스템 개요, Employee·Organization·Session·WorkOrder·Task·WorkProcess·Job·Run·Operation의 관계, 공개 데이터 필드, 업무 흐름, 실행·진척도·복구 사양, 포트, 권한과 이력 보존 경계를 반환합니다. 인증 토큰이나 `.env`의 원문은 반환하지 않습니다.

### `usage({tool?: "함수명"})`

실제 등록된 함수의 이름·설명·JSON 입력 스키마·필수 항목·호출 예시·멱등성·오류 처리 규칙을 반환합니다. 인자를 생략하면 전체 목록, `tool`을 지정하면 해당 함수의 상세 사용법을 반환합니다. 예시의 UUID는 실제 조회한 ID로 바꿔야 합니다.

```json
{"name":"usage","arguments":{"tool":"employee_create"}}
```

## 함수 범위

| 구분 | 함수 |
|---|---|
| 안내·조회 | `readme`, `usage`, `system_snapshot`, `records_list`, `record_get`, `admin_operation_get` |
| 직원 | `employee_create`, `employee_update`, `employee_delete`, `employee_restore` |
| 조직·배치 | `organization_create`, `organization_update`, `organization_delete`, `employee_assign`, `employee_transfer` |
| 호출 권한 | `call_permissions_set` |
| 업무 세션·대화 | `session_add`, `session_config_set`, `session_events`, `session_reindex` |
| 업무 지시·계속 업무 | `work_order_create`, `work_process_get`, 나머지 기록은 `records_list`·`record_get` |
| 스킬 | `skill_create`, `skill_update`, `skill_delete` |
| 페르소나 | `persona_create`, `persona_update`, `persona_delete` |
| 공통 정책 | `ai_policy_get`, `ai_policy_preview`, `ai_policy_set`, `ai_policy_clear`, `ai_policy_restore` |
| 일정·실행·복구 | `schedule_set`, `schedule_delete`, `manager_wake`, `run_cancel`, `job_control` |
| 면담 | `interview_create`, `interview_message`, `interview_close` |
| 요금·로그·관측 | `model_price_set`, `model_price_delete`, `log_source_set`, `mcp_metrics_get` |
| 보관 복원 | `resource_restore` |

`records_list`의 `table`은 스키마에 명시된 허용 목록만 받습니다. `nextCursor`가 null이 될 때까지 조회하면 전체 기록을 볼 수 있습니다. 보관한 조직·스킬·템플릿·일정·요금은 `includeArchived:true`로 조회합니다. 인증 토큰 저장소·임의 SQL·임의 셸 실행·임의 파일 읽기는 제공하지 않습니다.

## 호출 예시

조직 생성:

```json
{"name":"organization_create","arguments":{"name":"개발팀","idempotencyKey":"request-2026-org-001"}}
```

직원 생성 (`cwd`를 생략하면 설정된 workspace 사용):

```json
{"name":"employee_create","arguments":{"name":"개발 관리 AI","responsibility":"업무 분해와 위임","role":"manager","model":"gpt-6.1-sol","persona":"근거를 확인하고 허용된 작업 AI에게 위임합니다.","skillIds":[],"idempotencyKey":"request-2026-employee-001"}}
```

공통 정책은 `ai_policy_get`·`ai_policy_preview`로 영향과 revision을 확인한 뒤 저장합니다:

```json
{"name":"ai_policy_set","arguments":{"skillIds":["<조회한 스킬 UUID>"],"expectedRevision":1,"confirm":true,"idempotencyKey":"request-2026-policy-001"}}
```

실제 MCP TypeScript 클라이언트 연결 예시:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'external-admin', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${process.env.ADMIN_MCP_PORT}/mcp`),
  { requestInit: { headers: { authorization: `Bearer ${process.env.ADMIN_MCP_TOKEN}` } } }
));
const overview = await client.callTool({ name: 'readme', arguments: {} });
const usage = await client.callTool({ name: 'usage', arguments: { tool: 'employee_create' } });
await client.close();
```

클라이언트의 환경 변수는 해당 클라이언트에서 별도로 로드해야 합니다. 예시는 자동으로 `.env`를 읽지 않습니다. 사용하는 클라이언트의 설정 파일 형식은 제품마다 다를 수 있습니다.

## 쓰기·삭제·오류 규칙

- 모든 쓰기에는 `idempotencyKey`가 필요합니다. 동일 도구·동일 키·동일 입력은 같은 결과를 반환합니다. 입력이 다르면 `CONFLICT`입니다. 생성 직후 통신이 끊겨도 새 키로 다시 만들지 마세요.
- 쓰기 응답은 `result: {operationId, status, result}`입니다. 바깥 Operation의 `completed`는 관리 요청 처리가 끝났다는 뜻입니다. 직원 초기화·AI 업무 실행은 내부 Job·Run을 따로 확인해야 합니다.
- `expectedRevision`은 방금 조회한 값을 사용합니다. 스킬·페르소나·요금은 `version`을 넣고, 처음 만드는 일정·요금은 0을 넣습니다. 충돌 시 최신값과 영향을 다시 확인하세요.
- 정책·권한 전체 교체, 비활성화·보관·중지 등은 `confirm:true`가 필수입니다. 값이 없거나 false면 실행하지 않습니다.
- 직원 제거는 비활성화입니다. 실행 중이면 먼저 중지해야 하며 직속 작업 AI가 남아 있어도 거부합니다. 토큰·호출 권한은 회수하고 대기 작업을 취소하지만 세션·업무·감사는 남깁니다. 복원해도 권한·일정·취소 작업은 자동 복구하지 않습니다.
- 조직은 비어 있을 때만 보관합니다. 스킬은 현재 공통 정책이나 어떤 세션에서도 참조하지 않을 때만 보관합니다. 먼저 정책·세션의 선택을 정리하세요. 등록 이름은 보관 후에도 유일성을 유지하므로 같은 이름 재등록 대신 복원을 사용하세요.
- 스킬 수정은 새 버전입니다. 기존 공통 정책은 확정 버전을 계속 사용합니다. 같은 ID의 최신 버전을 공통 적용하려면 미리보기 후 정책을 다시 저장하세요. 개별 스킬은 다음 Run에서 현재 버전을 평가합니다. 과거 Run의 스냅샷은 불변입니다.
- 정책 제거는 `ai_policy_clear`로 빈 정책의 새 버전을 저장하는 것입니다. 과거 정책 이력을 삭제하지 않습니다. `ai_policy_restore`는 과거의 선택 ID를 **현재 카탈로그 버전으로 재검증**해 새 정책을 저장합니다.
- 작업 이력·업무 일지·AI 제출 근거를 직원 명의로 위조하는 도구는 없습니다. 외부 주체는 WorkOrder를 접수하고 실제 관리 AI가 Task 위임·결과 보고 흐름을 수행하게 해야 합니다. 기록의 임의 수정·영구 삭제는 범위에 포함하지 않습니다.
- 로그 재색인·실행 중지·로그 경로 변경은 별도 효과가 이미 발생할 수 있습니다. 실패하면 Operation이 `unknown`으로 남을 수 있으므로 `admin_operation_get`과 실제 상태를 조회하세요. 자동으로 새 키로 재시도하지 마세요. 프로세스 재시작 후 남은 `pending`도 결과 불명으로 취급합니다.
- 복구 요청은 기존 재개 기한을 앞당기지 않습니다. 실행 결과 불명이나 도구 실행 이력이 있는 작업의 재개는 거부합니다. 실행 중 작업은 `run_cancel`로 중지하고 종료 결과를 확인하세요.
- 배포 환경·포트·인증 토큰을 원격 도구로 변경하지 않습니다. `.env`를 운영자가 직접 수정하고 재시작합니다.
- MCP 응답의 `isError:true`와 `structuredContent.error.code`를 확인하세요. 대표 오류는 `INVALID_INPUT`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `SESSION_BUSY`, `TEMPORARY_UNAVAILABLE`입니다. HTTP의 401은 토큰 오류, 403은 Origin/Host 오류, 405는 POST 이외의 메서드, 429는 동시 요청 상한입니다.

## 관측·운영 한계

외부 관리 변경은 `external-admin` 행위자와 `admin_operations`·감사 이벤트로 추적합니다. 직원용 MCP 사용 지표는 내부 도구 호출을 집계하며 외부 관리 감사와 분리합니다. 프롬프트·토큰을 지표 인자로 기록하지 않습니다.

세 리스너는 같은 프로세스·SQLite를 사용합니다. 네트워크 경로와 인증 경계는 분리하지만 별도 프로세스나 DB로 격리하는 것은 아닙니다. 실제 계정 인증·모델 사용 가능 여부·다른 컴퓨터의 TLS 접속은 사용 환경에서 별도 검증해야 합니다.
