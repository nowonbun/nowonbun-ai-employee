# AI 직원 시스템 0.1.0

TypeScript·SQLite·Codex CLI·System MCP를 단일 호스트에서 실행하는 초기 구현입니다. 화면은 한국어이며 Bootstrap 대신 자체 CSS를 사용합니다.

## 실행

1. `.env.example`을 `.env`로 복사하고 `OPERATOR_TOKEN`, `WORKSPACE_HOST_PATH`, `CODEX_HOME_HOST`, `DATA_HOST_PATH`를 설정합니다. `WORKSPACE_HOST_PATH`는 AI에 허용할 작업 디렉터리이고, `CODEX_HOME_HOST`는 인증을 마친 Codex home의 기존 경로입니다. `DATA_HOST_PATH`는 SQLite 파일을 저장할 호스트 폴더입니다.
2. `docker compose up --build -d`를 실행합니다.
3. `http://127.0.0.1:3000`을 열고 `OPERATOR_TOKEN`을 입력합니다.
4. `docker compose logs -f ai-employee`와 `http://127.0.0.1:3000/healthz`로 상태를 확인합니다.

### 관리자 토큰 생성

Windows PowerShell에서 `src` 디렉터리로 이동한 뒤 다음 명령을 실행합니다.

```powershell
python .\create_token\generate.py
```

출력되는 `OPERATOR_TOKEN=...` 한 줄을 현재 `src` 디렉터리의 `.env` 파일에 넣으세요. 실행할 때마다 새 64자리 토큰이 생성되며, 스크립트가 `.env`를 직접 수정하지는 않습니다. 토큰은 비밀번호처럼 보관하고 문서나 저장소에 기록하지 마세요.

### Windows 폴더 경로 예시

Docker Desktop에서 Windows 폴더를 연결할 때는 `src/.env`에 호스트의 절대 경로를 지정할 수 있습니다.

```dotenv
WORKSPACE_HOST_PATH=D:/work/nowonbun-ai-employee
CODEX_HOME_HOST=C:/Users/<Windows사용자명>/.codex
DATA_HOST_PATH=D:/work/ai-employee-data
```

`CODEX_HOME_HOST` 값은 예시입니다. `<Windows사용자명>`을 그대로 사용하지 말고, 이 PC에서 실제로 존재하며 인증을 마친 Codex home 경로로 바꾸세요. `WORKSPACE_HOST_PATH`는 컨테이너의 `/workspace`에 읽기·쓰기 가능하게 연결되므로 AI에게 수정을 허용할 폴더만 지정하세요. `DATA_HOST_PATH`는 작업 공간 밖의 별도 폴더를 지정하고, 첫 실행 전에 해당 폴더를 만들어 두세요. 컨테이너 내부 경로인 `/workspace`, `/codex-home`, `/data`는 Windows 경로로 바꾸지 않습니다. [Docker Desktop의 bind mount 안내](https://docs.docker.com/engine/storage/bind-mounts/)

SQLite 파일은 `DATA_HOST_PATH/ai-employee.sqlite`에 저장됩니다. 위 예시에서는 `D:/work/ai-employee-data/ai-employee.sqlite`입니다. 기존 `ai_employee_data` Docker 볼륨의 데이터는 설정 변경만으로 자동 이전되지 않습니다. 기존 DB가 있다면 앱을 중지하고 백업·이전한 뒤 새 설정으로 실행하세요. 이전이 확인될 때까지 기존 볼륨을 삭제하거나 `docker compose down -v`를 실행하지 마세요.

## 사용 순서

1. 스킬과 페르소나를 등록합니다.
2. 「AI 직원」에서 직원과 첫 세션을 함께 만듭니다. 첫 Codex 실행이 성공하면 실제 세션 ID가 기록됩니다.
3. 조직을 만들고 조직도를 보면서 미배정 직원을 배치합니다. 직속 관계와 호출 권한은 별개입니다.
4. 관리 AI의 호출 권한을 설정하고 업무 지시를 등록합니다. 수동 실행 또는 cron으로 관리 AI를 실행합니다.
5. 작업, 업무 일지, 결과 보고서, 대화, 복구 센터를 확인합니다.

Codex 로그 위치는 `.env`의 `LOG_SOURCE_ROOT`로 초기 설정하고, 「환경 설정」에서 CODEX_HOME 내의 기존 디렉터리로 변경할 수 있습니다. 변경할 때는 설정 버전이 일치해야 합니다. 대화 화면의 「재색인」으로 공개 메시지를 가져옵니다.

## 운영 경계

- API는 관리자 토큰으로, System MCP는 실행마다 발급되는 직원 전용 토큰으로 보호합니다. 공개 포트는 호스트의 loopback에만 연결됩니다. 신뢰할 수 있는 로컬 환경에서 사용하세요.
- Codex CLI는 `child_process.spawn()`으로 시작하며 HTTP 응답은 실행 완료를 기다리지 않습니다. 동일 세션의 병렬 실행을 막고, 다른 세션은 `MAX_CONCURRENT_RUNS` 한도에서 병렬 실행합니다. `MAX_RUN_HOURS`를 넘긴 실행은 중지하고 확인 필요 상태로 둡니다.
- `AUTO_RESUME_ENABLED=false`가 기본값입니다. 사내 정책에서 허용한 종료 코드를 `RETRYABLE_EXIT_CODES`에 설정한 경우에만 60초 이상의 대기 후 재개 후보가 됩니다. 원인 불명, 실제 세션 ID 없음, 도구 실행이 관찰된 경우에는 자동 재개하지 않습니다.
- 브라우저나 MCP 응답이 끊기면 새 `idempotency_key`로 다시 만들지 말고 같은 키 또는 Operation ID로 조회하세요.
- 실제 Codex CLI, 모델 전환, 사내 제한 판단, Docker 내 인증된 home의 결합 동작은 이 환경에서 검증되지 않았습니다. 가짜 CLI를 이용한 로컬 시험과 실제 환경의 적합성 시험은 별개입니다.
- 1:1 면담은 업무용과 별도 세션에서 실행하며 System MCP를 전달하지 않습니다. 계속 업무는 WorkProcess와 기한별 실행 회차로 기록하고 전체 진척도는 표시하지 않습니다. 현재 미구현 항목: 예약 인사이동, 승인 기반 외부 쓰기, 다중 사용자 인증, 실제 요금 계산. 화면과 안내서에서도 구분합니다.

## 개발·검증

```sh
npm ci
npm test
npm run typecheck
npm run build
```

로컬 실행 시 `OPERATOR_TOKEN`, `WORKSPACE_ROOT`, `CODEX_HOME`, `DB_PATH`를 환경 변수로 설정하고 `node dist/main.js`를 실행합니다. `WORKSPACE_ROOT`와 `CODEX_HOME`은 실제 존재하는 정규 경로여야 합니다.
