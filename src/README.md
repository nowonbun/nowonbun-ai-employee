# AI 직원 시스템 0.1.0

TypeScript·SQLite·Codex CLI·System MCP를 단일 호스트에서 실행하는 초기 구현입니다. 화면은 한국어이며 Bootstrap 대신 자체 CSS를 사용합니다.

## 시스템 구성과 기능 사양

| 구성 | 책임·사양 |
|---|---|
| 웹 운영 화면 | 직원·조직·호출 권한·업무 지시·일정·대화·면담·복구·요금 설정, AI 정책과 MCP 사용 지표 |
| 관리 AI·작업 AI | 관리 AI가 업무를 분해하고 허용된 작업 AI에게 위임합니다. 조직 소속·직속 관계와 호출 권한은 별개입니다. |
| 실행 관리 | Job으로 접수하고 Runner가 Codex CLI를 실행합니다. 실제 실행은 Run으로 기록하며 접수 성공과 업무 완료를 구분합니다. |
| 직원용 MCP | 실행별 직원 토큰으로 허용된 내부 업무 함수만 호출합니다. 외부 관리 도구와 다른 경로·포트·인증을 사용합니다. |
| 외부 AI 관리 MCP | 전용 Bearer 토큰으로 운영 기능을 호출합니다. `usage`·`readme`를 포함한 46개 도구를 제공합니다. |
| 저장·감사 | SQLite에 직원·세션·업무·실행·정책·스킬 버전·관리 요청과 감사 이력을 보존합니다. |

구현 기준: [관리 도구 등록](app/admin-service.ts), [서버 시작·종료](app/main.ts), [정책·사용 지표](app/governance.ts). 외부 관리 MCP의 상세 연결 예시와 제약은 [전용 안내서](ADMIN_MCP.md)에 있습니다.

## 로컬 실행 (Docker 불필요)

Node.js 24 이상과 로컬 Codex CLI가 필요합니다. Codex에 로그인한 것과 **같은 OS 사용자**로 실행하세요.

```powershell
cd D:\work\nowonbun-ai-employee\src
npm ci
# .env가 없을 때만 생성합니다. 기존 파일을 덮어쓰지 마세요.
if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
python .\create_token\generate.py
# 출력된 OPERATOR_TOKEN=... 한 줄을 .env에 입력합니다.
codex login status
# 미인증이면 같은 터미널에서 codex login을 완료하세요.
npm start
```

이미 의존성과 `.env`가 준비됐다면 `npm start`만 실행합니다. 시작 전에 자동 빌드하며 `.env`를 로드합니다. 셸에 이미 지정한 환경 변수가 `.env`보다 우선합니다. `http://127.0.0.1:3000`을 열고 관리자 토큰을 입력하세요. 상태 확인은 `/healthz`, 종료는 `Ctrl+C`입니다. 서버를 외부 인터페이스에 노출하지 않도록 기본 HOST는 `127.0.0.1`입니다.

### 웹·직원 MCP·외부 관리 MCP 포트 분리

```dotenv
PORT=3000
MCP_PORT=3001
ADMIN_MCP_PORT=3002
# 외부 관리 MCP를 사용할 때 서로 다른 전용 비밀 토큰을 지정합니다.
ADMIN_MCP_TOKEN=
HOST=127.0.0.1
```

위 값은 코드 기본값을 보여 주는 예시입니다. 실제 접속 주소는 `.env`의 포트를 사용하세요. 예를 들어 `PORT=9999`, `MCP_PORT=3991`, `ADMIN_MCP_PORT=3992`이면 각각 웹은 `http://127.0.0.1:9999`, 직원 MCP는 `http://127.0.0.1:3991/internal/mcp`, 외부 관리 MCP는 `http://127.0.0.1:3992/mcp`입니다.

- 웹 화면·운영자 API: `http://127.0.0.1:3000` (`PORT`).
- 관리 AI·작업 AI의 내부 MCP 브리지: `http://127.0.0.1:3001/internal/mcp` (`MCP_PORT`). 호출 관측도 같은 MCP 전용 포트를 사용합니다.
- MCP 리스너는 `127.0.0.1`로 고정하며 웹 파일·운영자 API를 제공하지 않습니다. 웹 리스너는 내부 MCP 경로를 처리하지 않습니다.
- Runner가 MCP 전용 주소와 실행별 직원 토큰을 주입하므로 AI별 포트 설정은 필요 없습니다. 브리지와 CLI 사이의 stdio 연결은 유지합니다.
- 외부 AI의 운영 관리 MCP: `http://127.0.0.1:3002/mcp` (`ADMIN_MCP_PORT`). `ADMIN_MCP_TOKEN`이 비어 있으면 비활성화합니다. 직원 MCP·웹 토큰을 재사용할 수 없습니다.
- 활성 포트는 1~65535 범위의 서로 다른 정수여야 합니다. 같거나 점유 중이면 시작을 실패시키며, 모든 활성 리스너가 준비되기 전에는 Runner·Scheduler를 시작하지 않습니다. 종료 시 함께 닫습니다.
- 이 변경은 네트워크 리스너·라우트 분리입니다. 프로세스와 DB는 공유하며 별도 프로세스·DB 격리를 의미하지 않습니다.

### 외부 AI로 시스템 운영

Streamable HTTP MCP 클라이언트에 위 `/mcp` 주소와 `Authorization: Bearer <ADMIN_MCP_TOKEN>`을 설정합니다. 토큰은 32~4096자의 URL-safe 문자열이며 `.env` 변경 후 앱을 재시작해야 합니다. 먼저 `readme({})`로 시스템 개요·사양을, `usage({})` 또는 `usage({tool: "employee_create"})`로 도구별 입력 스키마·사용 예·안전 조건을 조회하세요.

토큰에 허용되는 문자는 영문·숫자·`.`·`_`·`~`·`-`입니다. 새 토큰이 필요하면 다음 명령으로 32바이트 무작위 값을 생성한 뒤 출력값을 `ADMIN_MCP_TOKEN`에 입력합니다. 기존 토큰을 교체하면 기존 클라이언트 설정도 함께 변경해야 합니다.

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex')+'\n')"
```

직원·조직·스킬·페르소나 생성/수정/제거, 공통 AI 정책, 배치·호출 권한, 세션, 업무 지시, 일정, 실행·복구, 면담, 요금·로그 설정과 조회 기능을 제공합니다. 제거는 이력을 보존하는 비활성화·보관 방식입니다. 감사 기록·완료된 실행 이력의 임의 수정, 직원 사칭, 비밀 설정 변경은 제공하지 않습니다.

모든 관리 쓰기에 `idempotencyKey`가 필요하며 파괴적 변경에는 `confirm:true`가 필요합니다. 다른 PC에서 연결하려면 별도의 인증된 TLS 프록시/터널을 구성하세요. 기본 리스너는 로컬 전용이며 원격 연결 설정은 자동으로 변경하지 않습니다. 전체 도구 목록과 연결 예시는 [외부 관리 MCP 안내](ADMIN_MCP.md)를 참조하세요.

#### 함수 범위와 안내 함수 계약

| 분류 | 도구 |
|---|---|
| 안내·조회 | `usage`, `readme`, `system_snapshot`, `records_list`, `record_get`, `admin_operation_get` |
| 직원 | `employee_create`, `employee_update`, `employee_delete`, `employee_restore` |
| 조직·배치·권한 | `organization_create`, `organization_update`, `organization_delete`, `employee_assign`, `employee_transfer`, `call_permissions_set` |
| 세션·대화 | `session_add`, `session_config_set`, `session_events`, `session_reindex` |
| 업무 | `work_order_create`, `work_process_get` |
| 스킬·페르소나 | `skill_create`, `skill_update`, `skill_delete`, `persona_create`, `persona_update`, `persona_delete` |
| 공통 AI 정책 | `ai_policy_get`, `ai_policy_preview`, `ai_policy_set`, `ai_policy_clear`, `ai_policy_restore` |
| 일정·실행·복구 | `schedule_set`, `schedule_delete`, `manager_wake`, `run_cancel`, `job_control` |
| 면담 | `interview_create`, `interview_message`, `interview_close` |
| 요금·로그·관측·복원 | `model_price_set`, `model_price_delete`, `log_source_set`, `mcp_metrics_get`, `resource_restore` |

- `usage({})`: 실제 등록된 전체 도구의 이름·설명·JSON 입력 스키마·필수 항목·예시와 오류 처리 규칙을 반환합니다. `usage({tool:"skill_update"})`처럼 한 도구만 조회할 수 있습니다. 예시 UUID는 실제 ID로 바꾸세요.
- `readme({})`: 시스템 개요, 데이터 개념과 공개 필드, 운영 순서, 포트, 실행·복구·진척도 사양, 권한과 이력 보존 경계를 반환합니다. 파일 다운로드 함수가 아니며 `.env`나 인증 토큰을 반환하지 않습니다.
- MCP 호출 형식은 `{"name":"organization_create","arguments":{"name":"개발팀","idempotencyKey":"org-request-001"}}`입니다. MCP 클라이언트의 `tools/call`로 전달하며 일반 REST JSON 본문과 구분하세요.
- 관리 쓰기의 `structuredContent.result`에는 `{operationId,status,result}`가 들어갑니다. 이 `completed`는 관리 요청 처리 완료이며 AI 실행 완료는 아닙니다. 반환된 내부 Job·Run·Operation을 따로 조회하세요.
- 동일 도구·동일 키·동일 입력은 같은 결과를 반환하며 같은 키의 다른 입력은 `CONFLICT`입니다. `expectedRevision`이 필요한 도구는 최신 조회값을 사용합니다. 스킬·페르소나·요금은 `version`, 최초 일정·요금은 0을 사용합니다.
- `records_list`는 허용 테이블만 조회하며 페이지당 최대 100건입니다. `nextCursor`가 null이 될 때까지 조회합니다. `system_snapshot`은 목록별 최대 500건이므로 전체 기록 조회와 구분하세요.
- 결과 불명(`unknown`) 또는 재시작 후 남은 `pending`은 상태와 부작용을 확인해야 합니다. 새 키로 자동 재접수하지 말고 `admin_operation_get`으로 조회하세요. MCP `isError:true`와 `structuredContent.error.code`도 확인합니다.
- 인증된 POST/JSON 요청만 지원합니다. 브라우저 Origin 요청·GET SSE·DELETE 세션 종료·OAuth는 지원하지 않습니다. 원격 프록시는 내부 Host를 `127.0.0.1:<ADMIN_MCP_PORT>`로 전달해야 하며 외부 구간 TLS·접근 제어는 별도 구성합니다.

#### 제거·복원과 정책 버전

- 직원 제거는 실행 중 또는 활성 직속 직원이 있으면 거부합니다. 비활성화 시 토큰·호출 권한을 회수하고 일정을 끄며 대기 작업을 취소합니다. 복원해도 권한·일정·작업은 자동 복구하지 않습니다.
- 조직은 활성 직원·활성 하위 조직이 없을 때만 보관합니다. 현재 정책이나 어느 세션에서든 참조 중인 스킬은 제거할 수 없습니다. 보관된 이름의 재등록 대신 `resource_restore`를 사용합니다.
- 스킬·페르소나 수정은 새 버전으로 저장합니다. 과거 Run의 스냅샷과 확정 정책 본문은 소급 변경하지 않습니다. 공통 정책의 같은 스킬을 최신 버전으로 바꾸려면 미리보기 후 정책을 다시 저장하세요.
- `ai_policy_clear`는 빈 정책의 새 버전을 저장하며 이력을 삭제하지 않습니다. `ai_policy_restore`는 과거 선택 ID를 현재 카탈로그 버전으로 재검증해 새 정책을 만듭니다.

### 로컬 경로와 인증

- `WORKSPACE_ROOT`: AI에 작업을 허용할 기존 디렉터리. 기본값은 실행 기준 폴더(`src`) 아래의 `workspace`이며 시작 시 자동 생성합니다.
- `CODEX_HOME`: 기존에 로그인한 Codex home. 기본값은 현재 OS 사용자의 `~/.codex`입니다.
- `DB_PATH`: SQLite 파일의 절대 경로. 기본값은 `src/data/ai-employee.sqlite`이며 부모 폴더를 생성합니다.
- `LOG_SOURCE_ROOT`: 기본값은 선택한 Codex home의 `sessions`입니다. 로그 디렉터리가 아직 없으면 재색인을 제공하지 않습니다.
- `CODEX_BIN`: 기본값은 `codex`. Windows에서는 PATH 또는 npm 설치의 native `codex.exe`를 찾아 셸 없이 실행합니다. 찾지 못하면 실행 파일의 절대 경로를 지정하세요. `.cmd`·`.bat`·`.ps1`은 허용하지 않습니다.

기본 디렉터리 구조 (`npm start` 실행 위치는 `src`):

```text
src/
  workspace/              # AI 작업 파일
  data/ai-employee.sqlite  # 운영 DB
```

Codex 인증은 이 두 폴더에 복사하거나 새로 만들지 않습니다. 기존 사용자 홈의 `.codex`를 사용합니다.

경로를 직접 지정하는 예시:

```dotenv
WORKSPACE_ROOT=D:/ai_work
CODEX_HOME=C:/Users/<사용자명>/.codex
DB_PATH=D:/ai_work_data/ai-employee.sqlite
```

`<사용자명>`은 실제 계정명으로 바꾸세요. 인증 파일을 저장소나 컨테이너에 복사하지 않습니다. Codex 자격 증명은 파일 또는 OS 보안 저장소에 보관될 수 있으므로, 같은 사용자와 같은 Codex home을 사용합니다. 앱 로그인만으로 CLI 인증이 유효하다고 가정하지 말고 `codex login status`로 확인하세요. [OpenAI 공식 인증 문서](https://developers.openai.com/codex/auth)

관리자 토큰은 기존 값을 보존하세요. 토큰 생성기는 실행할 때마다 새 값을 출력하지만 `.env`를 직접 수정하지 않습니다. 인증 파일·토큰은 문서나 저장소에 기록하지 마세요.

### 기존 Docker 설정에서 전환

- `WORKSPACE_HOST_PATH`, `CODEX_HOME_HOST`, `DATA_HOST_PATH`는 로컬 실행에서 폐기했습니다. 기존 `.env`에서 삭제하세요. 작업 위치는 `src/workspace`, DB는 `src/data/ai-employee.sqlite`를 사용하며 두 디렉터리는 시작 시 자동 생성합니다. `CODEX_HOME`을 비워 두면 기존 사용자 홈의 `.codex`를 계속 사용합니다.
- `LOG_SOURCE_ROOT`는 비워 두세요. 기존 `/codex-home/sessions` 같은 컨테이너 내부 경로는 로컬에서 사용할 수 없습니다.
- 이전 `.env`의 `HOST=0.0.0.0`은 로컬 전용 실행을 위해 `127.0.0.1`로 변경하세요.
- **먼저 기존 Docker 서비스를 중지한 후** 로컬 앱을 시작하세요. 같은 포트나 같은 DB를 Docker와 로컬 앱에서 동시에 사용하지 마세요. 이 변경은 컨테이너를 자동 중지하거나 DB를 이전하지 않습니다.
- 기본 DB 위치가 `src/data/ai-employee.sqlite`로 변경됩니다. 기존 데이터는 자동 복사·이동하지 않으므로 기존 DB를 계속 사용하려면 `DB_PATH`를 기존 호스트 파일로 지정하거나, 앱이 중지된 상태에서 백업 후 별도로 이전하세요. Docker named volume의 DB는 자동으로 이전되지 않습니다. 백업과 이전을 확인할 때까지 볼륨을 삭제하거나 `docker compose down -v`를 실행하지 마세요.
- 기존 DB에 저장된 직원 작업 위치가 `/workspace` 같은 컨테이너 경로라면 Windows에서 사용할 수 없습니다. 기존 설정을 백업한 뒤 별도 경로 전환이 필요합니다. 이 변경은 직원·세션·DB 내용을 자동 수정하지 않습니다.
- Docker 설정 파일은 선택적 배포용으로 남겨 둡니다. Docker를 계속 사용할 때는 별도 env 파일에 `WORKSPACE_HOST_PATH`, `CODEX_HOME_HOST`, `DATA_HOST_PATH`를 지정하세요. 컨테이너용 경로와 로컬 경로를 섞지 마세요.

## 사용 순서

1. 스킬과 페르소나를 등록합니다.
2. 「AI 직원」에서 직원과 첫 세션을 함께 만듭니다. 첫 Codex 실행이 성공하면 실제 세션 ID가 기록됩니다.
3. 조직을 만들고 조직도를 보면서 미배정 직원을 배치합니다. 직속 관계와 호출 권한은 별개입니다.
4. 관리 AI의 호출 권한을 설정하고 업무 지시를 등록합니다. 수동 실행 또는 cron으로 관리 AI를 실행합니다.
5. 작업, 업무 일지, 결과 보고서, 대화, 복구 센터를 확인합니다.

Codex 로그 위치는 `.env`의 `LOG_SOURCE_ROOT`로 초기 설정하고, 「환경 설정」에서 CODEX_HOME 내의 기존 디렉터리로 변경할 수 있습니다. 변경할 때는 설정 버전이 일치해야 합니다. 대화 화면의 「재색인」으로 공개 메시지를 가져옵니다.

## AI 정책과 MCP 사용 지표

- 「AI 정책」은 전체 AI에 적용할 공통 스킬을 설정합니다. 개별 세션 스킬과 합쳐 ID 중복을 제거하며 공통 정책의 확정 버전이 우선합니다. 정책 변경은 다음 Run부터 적용하고 실행 중인 Run은 시작 당시 스냅샷을 유지합니다. 공통 정책은 직원의 도구 권한을 확대하지 않습니다.
- 「MCP 사용 지표」는 같은 조회 기간의 함수별·직원별 호출과 위임 경로·최근 호출을 표시합니다. 성공률은 `성공 / (성공 + 실패)`이며 결과 미관측 호출은 분모에서 제외합니다. 관측된 성공·실패가 없으면 성공률은 null입니다.
- 지표는 내부 직원 MCP 기준입니다. 외부 관리 MCP의 감사·요청 기록과 구분하며 MCP 호출 성공을 업무 완료율로 해석하지 않습니다. 구현은 [정책·관측 모듈](app/governance.ts)을 기준으로 합니다.

## 운영 경계

- 웹 API는 `OPERATOR_TOKEN`, 직원 MCP는 실행별 직원 토큰, 외부 관리 MCP는 `ADMIN_MCP_TOKEN`으로 보호합니다. 두 MCP 리스너는 loopback으로 고정하며 웹도 기본 HOST가 loopback입니다. `HOST` 변경으로 외부 관리 MCP가 공개되지는 않습니다.
- Codex CLI는 `child_process.spawn()`으로 시작하며 HTTP 응답은 실행 완료를 기다리지 않습니다. 동일 세션의 병렬 실행을 막고, 다른 세션은 `MAX_CONCURRENT_RUNS` 한도에서 병렬 실행합니다. `MAX_RUN_HOURS`를 넘긴 실행은 중지하고 확인 필요 상태로 둡니다.
- `AUTO_RESUME_ENABLED=false`가 기본값입니다. 사내 정책에서 허용한 종료 코드를 `RETRYABLE_EXIT_CODES`에 설정한 경우에만 60초 이상의 대기 후 재개 후보가 됩니다. 원인 불명, 실제 세션 ID 없음, 도구 실행이 관찰된 경우에는 자동 재개하지 않습니다.
- 브라우저나 MCP 응답이 끊기면 새 키로 다시 만들지 말고 같은 키 또는 Operation ID로 조회하세요. 외부 관리 MCP의 필드는 `idempotencyKey`이며 직원 MCP의 `idempotency_key`와 구분합니다.
- 실제 Codex CLI, 모델 전환, 사내 제한 판단, 로컬 OS 보안 저장소와 인증된 home의 결합 동작은 이 환경에서 검증되지 않았습니다. 가짜 CLI를 이용한 로컬 시험과 실제 환경의 적합성 시험은 별개입니다.
- 1:1 면담은 업무용과 별도 세션에서 실행하며 System MCP를 전달하지 않습니다. 계속 업무는 WorkProcess와 기한별 실행 회차로 기록하고 전체 진척도는 표시하지 않습니다. 현재 미구현 항목: 예약 인사이동, 승인 기반 외부 쓰기, 다중 사용자 인증, 실제 요금 계산. 화면과 안내서에서도 구분합니다.

## 개발·검증

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`npm start`는 빌드와 `.env` 로딩을 포함합니다. 빌드 결과만 직접 실행할 때는 `node --env-file-if-exists=.env dist/main.js`를 사용합니다. `WORKSPACE_ROOT`와 `CODEX_HOME`은 실제 존재하는 정규 경로여야 합니다.
