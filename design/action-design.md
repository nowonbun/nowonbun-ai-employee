# AI 직원 시스템 동작 설계

- 상태: 구현 전 계약안. 아래 HTTP 경로·도구 이름·상태는 이 제품을 위한 설계이며 기존 Codex API의 보장이 아니다.
- 기준 문서: [요구사항 정의서](../request/ai-employee-system-requirements.md). 화면·책임: [메뉴·화면 설계](./menu-design.md), [전체 설계](./system-architecture.md).
- `A-xx`는 안정적으로 유지할 설계상 동작 ID다. 프로토타입의 `data-action`은 브라우저 데모 조작일 뿐이며, 이름이 같아도 여기의 DB·CLI 처리를 수행하지 않는다.

## 1. 공통 명령 계약

### 1.1 접수·결과·재전송

```json
{
  "request_id": "client-generated-id",
  "idempotency_key": "stable-key-for-the-same-intent",
  "expected_revision": 7,
  "payload": { "target_id": "...", "fields": "..." }
}
```

- 작업 주체(actor)는 인증된 Web 세션 또는 System MCP 연결에서 확인한다. 요청 본문의 `employee_id`를 신원 증명으로 쓰지 않는다. 쓰기 전에는 동작·대상·주체·범위·본문 스키마·`expected_revision`·권한 버전·예산을 검증한다. 신규 생성에는 버전이 필요 없지만 기존 집합을 변경할 때는 필수다.
- 같은 `(actor, action_type, idempotency_key)`와 같은 정규화 본문 해시는 동일한 Operation·관련 ID를 반환한다. 키는 같고 본문이 다르면 `CONFLICT`다. 키는 재전송 가능 기간 이상 유지하며 진행 중인 업무를 기한만으로 삭제하지 않는다.
- 업무 완료를 기다리지 않는 Web 시작 API는 DB 트랜잭션 성공 후 `202 Accepted`와 `request_id`·`operation_id`·`status`·관련 ID·조회 URL을 반환한다. 동기식 설정 저장은 갱신된 버전을 반환할 수 있다. MCP 쓰기 도구도 영속 접수 후 즉시 반환한다.
- 결과를 받지 못한 호출자는 **새 키로 다시 만들지 말고** A-30 또는 `operation_get`을 먼저 조회한다. 이미 접수했다면 상태 추적만 계속한다. DB 기록 실패 시 새 Run·위임·외부 쓰기를 중지한다.
- 공통 오류는 `INVALID_INPUT`·`FORBIDDEN`·`CONFLICT`·`SESSION_BUSY`·`COOLDOWN`·`AUTH_REQUIRED`·`MODEL_UNAVAILABLE`·`EXECUTION_UNKNOWN`·`NOT_FOUND`·`TEMPORARY_UNAVAILABLE`다. `code`·`retryable`·`retry_after_ms`·조회 가능한 ID·민감정보를 가린 사유를 반환한다. HTTP 코드와 업무 상태를 혼동하지 않는다.

### 1.2 시간 초과·배타 실행·감사

| 대상 | 초기안 | 시간 초과·충돌 후 처리 |
|---|---|---|
| Web/MCP 영속 접수 | 호출 기한 10초, 접수 p95 2초는 측정 목표 | 동일 키와 A-30으로 접수를 확인한다. Run 종료를 기다리지 않는다 |
| MCP 재연결 | 1·2·5·10·30초, 최대 5회는 설계안 | 재인증하고 커서로 inbox를 회수한다. 연결 복구와 재실행을 분리 |
| Runner | 세션 임대 잠금과 작업 위치의 배타 제어. 하트비트 10초·기한 45초는 설계안 | 임대 기한만으로 중복 실행하지 않고 프로세스·펜싱 토큰·외부 결과를 대조 |
| 사용 제한 | `next_eligible_at`은 최소 60초 후 | 사내 허용, 이전 Run 중지, 작업 버전·Checkpoint·본인 WorkLog·예산 재확인 |
| 외부 부작용 | 작업 의도와 결과 ID를 별도 기록 | 결과 불명 시 재전송하지 않고 `needs_attention`으로 둔다. 사용자 대조·승인 후 보상 |

각 쓰기마다 AuditEvent를 남기고 `request_id`·`operation_id`·`work_order_id`·`task_id`·`work_log_id`·`run_id`·`session_id`·`event_id`를 연결한다. 감사 정정은 새 이벤트로 추가한다. 정상 정기 점검은 과도하게 알리지 않고 금지·불명·한도 초과·dead-letter를 알린다.

### 1.3 동작 분류

| 제어 | 동작 |
|---|---|
| 운영자 전용 | A-04~A-09, A-18, A-19, A-24~A-29, A-31. 고위험 A-29는 승인자를 별도로 기록 |
| 사용자 업무 진입 | A-10, A-11, A-22, A-23. 사용자는 AI 기록인 A-12~A-17을 직접 만들지 않는다 |
| 관리·작업 AI | 관리 AI는 A-12·A-16·A-17, 작업 AI는 배정 범위의 A-13~A-15. A-14는 작성한 본인만 가능 |
| Scheduler·Runner | A-20은 허용된 자동 재개, A-18은 cron 실행, outbox 전달. 예산·권한 우회 금지 |
| 중지·조회 | A-21은 운영자 또는 명시적으로 허용된 관리 AI 범위만. A-30은 조회와 영속 반영 후 ACK, A-32는 인가된 읽기. 안내서 열기는 정적 화면 이동 |

## 2. 사용자·AI 직원·조직 동작

### A-01 AI 직원과 첫 세션 생성
- 시작·주체: M-02의 운영자, `POST /api/employees`.
- 입력: 이름, 담당 업무, `manager | worker`, 선택적 세션 표시 이름, 모델, 페르소나 본문·템플릿 버전, 스킬 ID·버전, 검증된 cwd, `idempotency_key`.
- 전제: 이용 가능한 모델·스킬 출처·작업 공간 루트·실행 예산 검증. 표시 이름은 실제 Codex ID가 아니다.
- 결과: Employee·EmployeeConfigVersion·초기화 대기 Session·Operation·AuditEvent를 트랜잭션으로 저장. 조직 미배정·CallPermission 없음이 기본값. Runner가 실제 CLI ID를 확인했을 때만 기록한다. 실패 시 `initialization_failed`와 조회 가능한 Operation을 남기며, ID 없는 세션은 재개할 수 없다. 중복 키는 같은 직원·세션을 반환한다. AT-02·AT-23.

### A-02 기존 직원에 세션 추가
- 시작·주체: M-02 운영자, `POST /api/employees/{employee_id}/sessions`.
- 입력: 직원 ID, 용도, 선택적 표시 이름, 모델, 설정 버전, 이전 세션과의 관계, 생성 사유.
- 전제·결과: 직원이 유효해야 하며 현재 세션 처리 방식을 사용자가 고른다. 과거 대화는 유지한다. 새 세션 초기화 Operation을 만들고 실제 ID 확보·기존 실행의 안전한 중지 후 트랜잭션으로 현재 세션을 전환한다. 직원당 현재 세션은 최대 1개이며 이전 세션을 임의로 삭제하지 않는다.

### A-03 세션 모델·페르소나·스킬 변경
- 시작·주체: M-02 운영자, `PATCH /api/sessions/{session_id}/config`.
- 입력: `expected_revision`, 모델, 페르소나 버전·본문, `skill_set_version`, 변경 사유와 적용 대상.
- 전제·결과: 현재 세션만 수정한다. 실행 중인 Run·기존 대기열 설정을 말없이 바꾸지 않는다. 새 EmployeeConfigVersion을 저장해 다음 Run부터 적용하고 요청 모델·실제 모델을 별도 기록한다. 모델 사용 불가 시 무단 대체하지 않는다. 동일 실제 세션에서 모델 전환이 PoC로 불가능하면 사용자 동의를 받아 A-02와 ContextSnapshot으로 새 세션에 옮긴다.

### A-04 조직 생성
- 시작·주체: M-03 오른쪽 위 운영자, `POST /api/organizations`.
- 입력: 조직 이름, 선택적 상위 조직 ID, `idempotency_key`.
- 전제·결과: 정규화한 이름의 중복·순환 관계·권한을 검사한다. 직원 없는 Organization과 감사를 저장하며 직원·세션·호출 권한은 자동 생성하지 않는다.

### A-05 미배정 AI를 조직에 배치
- 시작·주체: M-03 조직도 대화상자 하단의 운영자, `POST /api/organizations/{organization_id}/assignments`.
- 입력: 현재 세션 ID, 해당 `employee_id`, 작업 AI의 선택적 직속 관리 AI ID, `expected_revision`.
- 전제·결과: 세션은 유효한 현재 세션, 직원은 미배정, 관리 AI는 해당 조직에서 유효해야 한다. DB가 동시 유효 소속 1개를 강제한다. OrgAssignment와 감사를 추가하고 이름·담당 업무·세션 설정은 재입력하거나 변경하지 않는다. 호출 권한은 부여하지 않는다. 다른 화면의 선배치 시 `CONFLICT`와 최신 조직도를 반환한다. AT-30.

### A-06 직속 관리 AI 변경
- 시작·주체: M-03 직원 상세의 운영자, `PATCH /api/employees/{employee_id}/supervisor`.
- 입력: 새 관리 AI ID 또는 미설정, 사유, `expected_revision`.
- 전제·결과: 작업 AI에만 적용한다. 순환·무효 직원·실행 상태를 확인하고 소속·보고 대상 이력을 갱신한다. 대상 작업 AI에 대한 기존 호출 권한을 폐기하며 새 관리 AI에게 자동 허용하지 않는다. 진행 중 Run은 안전한 경계에서 반영한다.

### A-07 관리 AI의 CallPermission 변경
- 시작·주체: M-03 호출 권한 탭의 운영자, `PUT /api/managers/{manager_id}/call-permissions`.
- 입력: 허용할 유효 작업 AI ID 집합, 사유, `expected_revision`.
- 전제·결과: 운영자만 변경한다. 직속·소속을 권한 대신 쓰지 않는다. 타 조직 허용은 명시적 선택과 범위 심사가 필요하다. 추가·폐기를 유효 기간과 함께 기록하고 권한 버전을 올린다. 새 위임은 즉시 새 버전으로 심사한다. 기존 Task·Run에는 안전 중지 정책을 적용하고 과거 이력은 유지한다. 허용 없는 A-12는 `FORBIDDEN`. AT-20·AT-30.

### A-08 인사이동 예약·적용
- 시작·주체: M-03 직원 상세의 운영자, `POST /api/employees/{employee_id}/transfers`.
- 입력: 이동할 조직, 직속 관리 AI, 사유, `effective_at`, 미완료 작업 방침(본인 계속/다른 직원에게 이관/보류), `expected_revision`.
- 전제·결과: 이동 대상·순환·권한·실행 중 Run을 확인한다. 실행 중이면 새 접수를 보류하고 안전한 Run 경계에서 반영한다. 동일 `employee_id`를 유지하며 OrgAssignment·TaskAssignmentEvent를 추가한다. 이전 CallPermission·예약·승인을 재평가하고 대화·면담 읽기 권한을 새 소속에 자동 확대하지 않는다. 긴급 권한 폐기 시 A-21로 실행 중지를 요청한다. AT-10.

### A-09 AI 직원 보관
- 시작·주체: M-03/M-02 운영자, `POST /api/employees/{employee_id}/archive`.
- 전제·결과: 유효 Run·예약·미완료 작업을 열거하고 중지 또는 이관 결정을 요구한다. 물리 삭제가 아니다. 새 실행·위임·허가를 폐기하고 세션·작업·일지·면담·모델 이력을 읽기 권한과 함께 남긴다.

## 3. 업무·MCP·면담 동작

### A-10 사용자 WorkOrder 등록
- 시작·주체: M-04 사용자, `POST /api/work-orders`.
- 입력: 제목, 현재 세션이 있는 관리 AI, 요청 내용, 결과 보고 확인 항목, 선택적 Interview ID, `idempotency_key`.
- 결과: `queued` WorkOrder·감사·관리 AI inbox 접수 알림을 트랜잭션으로 저장한다. 접수만으로 Task·WorkLog·Run을 만들지 않는다. `work_order_id`와 Operation을 반환하며 관리 AI 실행은 Scheduler·대기열이 별도로 판단한다. AT-24.

### A-11 WorkOrder 보류·재개
- 시작·주체: M-04 운영자, `POST /api/work-orders/{id}/pause` 또는 `/resume`.
- 입력: 사유, `expected_revision`, `idempotency_key`.
- 전제·결과: 현재 상태와 관련 Run·Task를 조회한다. 보류는 새 실행·위임을 막지만 이미 성공한 외부 변경을 되돌리지 않는다. WorkOrderEvent·감사를 남기고 재개 시 권한·예산·대기 시간을 재심사한다.

### A-12 관리 AI의 Task 위임
- 시작·주체: 인증된 관리 AI의 System MCP `task_delegate`.
- 입력: `parent_task_id` 또는 `work_order_id` 중 하나, worker_id, 목적, 완료 조건과 양수 가중치, 범위, `expected_revision`, `idempotency_key`.
- 전제·결과: 호출자가 배정된 관리 AI이고 작업 AI가 유효하며 명시적 CallPermission·상위 업무·범위·예산·재개 대기가 적합해야 한다. Task·TaskAssignmentEvent·Operation·Run 예약·outbox·감사를 트랜잭션으로 저장해 즉시 반환한다. 작업 AI의 완료를 기다리지 않는다. 응답 불명 시 `operation_get` 또는 같은 키로 재전송하고, 새 키로 무작정 위임하지 않는다. AT-14·AT-30.

### A-13 Task Checkpoint 기록
- 시작·주체: 배정된 AI의 System MCP `task_checkpoint`.
- 입력: task_id, `expected_revision`, verified_work, next_step, evidence_refs, `idempotency_key`.
- 전제·결과: 근거 참조가 허용 범위에 있고 Task가 미완료여야 한다. AI의 문장만으로 완료 조건을 확인 처리하지 않는다. 버전이 붙은 Checkpoint·TaskEvent를 추가하고 오래된 버전에는 `CONFLICT`와 최신 ID를 반환한다.

### A-14 AI 본인의 WorkLog 추가
- 시작·주체: 기록하는 관리·작업 AI 자신의 System MCP `work_log_append`.
- 입력: task_id 또는 work_process_id+cycle_id, summary, completed, evidence_refs, remaining, next_step, `expected_revision`, `idempotency_key`.
- 전제·결과: 주체는 인증된 AI 본인이며 관련 Task·WorkCycle 읽기·쓰기 권한이 있어야 한다. `author_employee_id`를 외부 입력으로 받지 않는다. 추가 기록형 WorkLog ID·시각·Run ID·참조 버전을 저장한다. 사용자·다른 AI의 편집을 거부한다. 다음 실행에서 같은 AI의 최신 WorkLog를 Task 원본과 대조한다. AT-04·AT-24.

### A-15 Task 결과 제출
- 시작·주체: 담당 작업 AI의 System MCP `task_result_submit`.
- 입력: task_id, `expected_revision`, result, evidence_refs, `idempotency_key`.
- 결과: 제출 결과와 관리 AI 대상 outbox를 함께 저장하고 Task를 `reviewing`으로 둔다. 제출만으로 `completed`가 되지 않는다. 관리 AI가 오프라인이거나 재개 대기 중이어도 inbox에 남기고 반영 뒤 event_id로 ACK한다. 중복 전달은 같은 결과로 수렴한다. AT-15.

### A-16 관리 AI의 결과 보고서 제출
- 시작·주체: 배정된 관리 AI의 System MCP `work_order_report_submit`.
- 입력: work_order_id, `expected_revision`, 보고 본문, 완료 조건별 검증, evidence_refs, 미해결 항목, `idempotency_key`.
- 전제·결과: 관련 Task 결과를 WorkOrder의 보고 확인 항목과 대조한다. 근거 부족을 완료 처리하지 않는다. WorkOrderReport를 저장하고 WorkOrder를 `reported`로 바꾼 뒤 Web에 알린다. 사용자 확인 전에도 보고서를 읽을 수 있다. AT-24.

### A-17 계속 업무 실행 회차 기록
- 시작·주체: 담당 관리 AI의 System MCP `work_cycle_record` 및 기한 초과를 판단하는 Scheduler.
- 입력: work_process_id, scheduled_at, outcome, evidence_refs, 파생 task_ids, `idempotency_key`.
- 전제·결과: `(work_process_id, scheduled_at)`은 유일하다. AI는 기한 도래한 본인 회차에 `done` 또는 사유 있는 `skipped_with_reason`을 기록하며 `missed`는 판정 기한 후 Scheduler가 기록한다. WorkCycle과 파생 Task를 연결한다. 이후 Task가 늘어도 기한 도래 회차 수를 바꾸지 않고 전체 백분율도 계산하지 않는다. AT-26.

### A-18 관리 AI 일정 저장·활성화
- 시작·주체: M-09 운영자, `PUT /api/managers/{id}/schedule`.
- 입력: 5필드 cron, 시간대, 활성 플래그, 기본 프롬프트, `skill_set_version`, `expected_revision`.
- 전제·결과: 구문을 검증해 다음 실행 시각 미리보기를 반환한다. 대상은 현재 세션이 있고 예산·사내 정책에 맞는 관리 AI다. ScheduleVersion 저장 후 Scheduler가 `(schedule_id, scheduled_at)`의 WakeEvent를 유일하게 만든다. 중지 기간의 모든 회차를 연속 실행하지 않는다. AT-01.

### A-19 관리 AI 수동 실행
- 시작·주체: M-09 운영자, `POST /api/managers/{id}/wake`.
- 입력: 사유, `idempotency_key`.
- 전제·결과: 일정 활성 여부와 별도로 직원·세션·예산·재개 대기·임대 잠금을 검증한다. `reason=manual` WakeEvent와 Operation을 저장하고 실행 가능하면 Run을 대기열에 넣는다. 실행 요청만으로 Task·WorkCycle을 완료 처리하지 않는다.

### A-20 허용된 대기 상태에서 재개
- 시작·주체: Runner의 종료 분류 후 Scheduler. M-10에는 상태·판단 표시.
- 입력: 이전 run_id, 종료 원인 근거, Retry-After, 사내 허용 정책, Task·세션 ID.
- 전제: 재시도가 허용된 일시 종료만 대상. `next_eligible_at = max(terminated_at + 60초, retry_after_at, policy_not_before)`를 영속 저장한다. 기한 전·금지·원인 불명·인증 만료·한도 초과는 재개하지 않는다.
- 재개 전: 이전 프로세스 중지, 임대 잠금, 최신 Task·본인 WorkLog·Checkpoint·외부 부작용·권한·예산을 대조한다. 명시적 세션 ID로 새 Run을 만들어 resume한다. ID·외부 결과 불명은 `needs_attention`. 모델·계정 전환으로 제한을 우회하지 않는다. AT-08·AT-09·AT-13.

### A-21 Run 중지 요청
- 시작·주체: M-10 운영자 또는 위임 범위에 명시적으로 허용된 관리 AI의 System MCP `run_cancel`.
- 입력: run_id, 사유, `idempotency_key`.
- 결과: Run을 `cancelling`으로 바꾸고 새 예약을 중지한 뒤 Runner에 중지를 요청한다. 프로세스 종료·부작용 대조 후 최종 상태를 확정한다. `cancelled`는 외부 작업을 되돌리지 않는다. 보상은 A-29 승인 및 별도 작업이다.

### A-22 1:1 면담 시작·계속
- 시작·주체: M-08 사용자, `POST /api/interviews`와 `POST /api/interviews/{id}/messages`.
- 입력: 관리·작업 AI 대상, 의제, 메시지, 공유 범위, `idempotency_key`.
- 전제·결과: 업무용과 별도의 Interview Session을 사용하며 일반 업무 쓰기 도구는 기본 비활성화다. 대화·합의·후속 항목을 Interview에 저장한다. 다른 직원·상사에게 전문을 자동 공유하지 않고 발언을 Task·WorkOrder로 자동 전환하지 않는다. AT-11.

### A-23 면담 합의를 WorkOrder로 채택
- 시작·주체: M-08 사용자, `POST /api/interviews/{id}/work-orders`.
- 입력: 합의 항목 ID, 담당 관리 AI, 지시 제목·내용·결과 확인 항목, `idempotency_key`.
- 전제·결과: 사용자가 채택 대상을 명시적으로 고르고 면담의 공유 범위를 확인한다. A-10의 WorkOrder 접수를 재사용해 Interview에 연결한다. Task를 직접 만들지 않는다.

## 4. 운영 설정·로그·읽기 동작

### A-24 스킬 직접 생성·업로드
- 시작·주체: M-11 운영자, `POST /api/skills`.
- 입력: 직접 작성한 `name`·`description`·본문 또는 UTF-8 파일. 업로드 시 스킬 ID·표시 이름을 따로 요구하지 않는다.
- 검증·결과: frontmatter의 `---`·`name`·`description`·종료 `---`, 빈 본문, 중복 이름, 출처 허용, 크기 한도를 확인한다. 32 KiB는 프로토타입을 따른 후보값이며 구현 전에 확정한다. 표준 `SKILL.md`·내부 ID·해시·버전·감사를 저장한다. 등록만으로 실행 권한은 증가하지 않고 직원 적용은 A-03 설정 버전으로 한다. AT-27.

### A-25 페르소나 템플릿 등록
- 시작·주체: M-12 운영자, `POST /api/persona-templates`.
- 입력: 템플릿 이름, 역할·행동 지침 본문, `idempotency_key`.
- 결과: 버전이 붙은 템플릿. M-02에서 선택할 때 초안으로 복사한다. 기존 세션과 실행 중 Run을 알리지 않고 변경하지 않는다.

### A-26 실행·로그 환경 변경
- 시작·주체: M-13 운영자, `PATCH /api/settings/environment`.
- 입력: CLI 경로, `log_source_roots`, `execution_codex_home`, 작업 공간 루트, 동시 Run 한도, 자동 재개 한도, `expected_revision`.
- 전제·결과: 정규 경로·허용 루트·심볼릭 링크·접근 권한·지원 파서를 진단한다. 인증값이나 파일 본문을 브라우저에 반환하지 않는다. 설정 버전과 감사를 남긴다. 로그 읽기 위치와 실행 home은 별개다. 실행 중 세션의 home 변경은 안전 중지와 명시적 확인이 필요하다. AT-20.

### A-27 모델별 요금 저장
- 시작·주체: M-13 운영자, `PUT /api/settings/model-prices`.
- 입력: model_id, 입력·선택적 캐시 입력·출력의 음수가 아닌 십진 문자열, `USD / 100만 토큰`, 적용 시작 시각, `expected_revision`.
- 결과: ModelPriceVersion 추가. 빈칸은 미설정, `0`은 0 단가다. Run에 적용 버전을 연결한다. 사용량을 모르면 비용도 불명으로 표시하고 수동 가격을 공식 수집값이나 실제 청구액이라고 부르지 않는다. AT-28.

### A-28 대화 로그 재색인
- 시작·주체: M-13 운영자, `POST /api/log-sources/reindex`.
- 입력: 허용된 로그 루트 ID, 선택적 세션 ID, 파서 버전, `idempotency_key`.
- 전제·결과: URL·요청 본문의 임의 경로를 바로 읽지 않는다. 출처 루트를 정규 경로로 재확인하고 인증 정보·금지 영역은 제외한다. 비동기 Operation을 만들고 출처 이벤트 ID 또는 세대+오프셋으로 중복을 막는다. 부분 행·손상·로그 순환을 상태로 남기고 원본은 변경하지 않는다. AT-05·AT-18.

### A-29 고위험 작업 승인·거부
- 시작·주체: 인증된 사용자 운영자, `POST /api/approvals/{id}/decision`.
- 입력: 대상 ID·버전·동작·범위·만료 시각·승인/거부·사유·`idempotency_key`.
- 전제·결과: 대상이 바뀌지 않았고 승인자가 작업 출처 AI가 아님을 검증한다. Approval과 감사를 남긴다. 만료되거나 버전이 바뀐 승인은 무효다. 외부 부작용 불명 작업의 재전송·보상은 외부 최신 상태를 확인하고 별도 Operation으로 한다. AT-17·AT-21.

### A-30 Operation·Inbox·진척 조회
- 시작·주체: Web, 인증된 관리 AI. `GET /api/operations/{id}`, `GET /api/events?cursor=...`, System MCP `operation_get`·`inbox_read`·`inbox_ack`.
- 읽기: 동일 호출자의 Operation과 인가된 이벤트만 반환한다. SSE 연결 끊김 후 `Last-Event-ID` 또는 커서에서 다시 가져온다.
- ACK: 관리 AI가 결과를 영속 업무 상태에 반영한 뒤 event_id·적용 버전·`idempotency_key`로 `inbox_ack`한다. 재전달은 event_id로 중복 제거한다. 시간 초과 시 연결만 복구하고 Task·Run은 다시 만들지 않는다. AT-14~AT-16.

### A-31 Task 기록 정정
- 시작·주체: 감사 권한이 있는 운영자, `POST /api/tasks/{id}/corrections`.
- 입력: 대상 이벤트·조건 버전, 정정 사유·근거·`expected_revision`·승인 참조.
- 결과: 원래 이벤트를 덮어쓰지 않고 정정 이벤트·새 버전을 추가한다. 과거 표시 진척도는 과거 조건 버전으로 유지하고 현재값과의 차이를 보여 준다. 일반 작업 이력·업무 일지 화면에는 자유 편집 양식을 두지 않는다.

### A-32 목록·검색·대화 읽기
- 시작·주체: M-01~M-08의 인가된 사용자 및 System MCP `employee_list`·`task_get`.
- 입력: 검색어, 필터, 커서, 제한, 범위. 출력에 출처·갱신 시각·누락 상태·버전을 포함한다.
- 경계: 직원·대화·면담·작업 읽기 권한을 매번 확인한다. 모든 페이지를 읽을 커서를 제공하고 원본에 없는 대화를 생성하지 않는다. 검색어를 셸·SQL에 직접 결합하지 않는다.

## 5. MCP 도구와 동작의 대응

| System MCP 도구 | 대응 | 주체와 주요 실패 처리 |
|---|---|---|
| `employee_list` | A-32 | 관리 AI의 명시적 CallPermission 범위만 반환 |
| `work_order_get` | A-10/A-32 | 배정된 관리 AI만. 오래된 버전은 재조회 |
| `task_delegate` | A-12 | 관리 AI만. DB 접수 뒤 시간 초과는 같은 키로 조회 |
| `task_get` | A-32 | 담당·관리 권한 범위만 |
| `task_checkpoint` | A-13 | 담당 AI만. 근거 누락은 거부 |
| `work_log_append` | A-14 | 인증된 AI 본인만. 다른 AI 작성자 지정 불가 |
| `work_cycle_record` | A-17 | 담당 관리 AI의 기한 도래 회차만. `missed`는 Scheduler 판단 |
| `task_result_submit` | A-15 | 담당 AI만. 결과와 outbox를 함께 저장 |
| `work_order_report_submit` | A-16 | 배정 관리 AI만. 근거 부족은 `needs_attention` |
| `operation_get` | A-30 | 동일 호출자의 접수 상태 반환 |
| `inbox_read`/`inbox_ack` | A-30 | 영속 커서와 반영 후 ACK. 중복 이벤트는 무효 작업 |
| `run_cancel` | A-21 | 인가된 대상만 중지 요청. 부작용은 별도로 대조 |

모든 도구는 실행 시점 스키마, 접수 기한, 동일 키 재전송, `retryable`, 오류 격리를 공통 계약으로 삼는다. 관리 AI에게 개별 CLI 시작 권한이나 다른 직원의 인증 정보를 공개하지 않는다.

## 6. 상태 전이·사후 검증·복구

| 집합 | 정상 전이 | 금지·사후 확인 |
|---|---|---|
| Operation | `accepted → queued → running → succeeded / failed / blocked / cancelled` | 응답 시간 초과를 실패 확정으로 보지 않는다. A-30으로 DB를 조회 |
| WorkOrder | `queued → accepted → running → reported`, 중간에 `paused / needs_attention / cancelled` | 보고서 없는 `reported` 금지. 관련 Task 결과와 대조 |
| WorkCycle | `scheduled → due → done / missed / skipped_with_reason` | WakeEvent만으로 `done` 금지. 파생 Task는 별도 집계 |
| Task | `draft → ready → queued → running → reviewing → completed`, 중간에 `awaiting_approval / waiting_assignment / cooldown / needs_attention / cancelled` | 근거·산출물·최종 검토 없는 완료 금지 |
| Run | `queued → starting → running → succeeded / failed / terminated / cancelled / unknown` | 같은 Run ID를 재시도에 재사용하지 않는다. 새 Run에 `resume_of_run_id` 기록 |

자동화는 실행 계기 → 입력 수집 → 사전 검증 → 주요 실행 → 사후 검증 → 보고 순서다. Scheduler/Runner 작업은 자동 또는 예약, 권한·설정은 운영자 전용, 결과 불명인 외부 작업의 재전송은 승인이 필요하다. 외부 변경의 사후 검증을 생략하지 않는다.

## 7. 프로토타입 전용 작업

프로토타입의 `advance-cooldown`·`resume-demo`·`reset-demo`·샘플 `chat-form` 응답·진단 예시는 브라우저 내 시뮬레이션이다. 실제 구현에서 같은 버튼을 CLI·DB에 바로 연결하지 않는다. M-10의 가상 시계는 표시용 fixture로만 두고 운영 `next_eligible_at`은 서버 시각과 DB 기준 원본으로 판정한다. 샘플 데이터 초기화를 운영 데이터의 물리 삭제로 구현하지 않는다.

## 8. 동작 검증 매트릭스

| 사례 | 자극 | 합격 조건 |
|---|---|---|
| 정상 | A-10 → A-12 → A-14/A-15 → A-16 | WorkOrder·Task·본인 WorkLog·보고서가 상관 ID로 연결(AT-24) |
| 중복·시간 초과 | A-12의 DB 접수 직후 응답을 버리고 동일 키 재전송 | 같은 Operation·Task만 남고 A-30으로 진척 회복(AT-14·AT-16) |
| 권한 | A-07 미허용 또는 인사이동 후 A-12 시도 | `FORBIDDEN`. 새 상사에게 자동 허용하지 않음(AT-20·AT-30) |
| 재개 | 일시 제한에 59초·60초·긴 Retry-After·금지 주입 | 허용된 경우에만 기한 후 새 Run. 금지·불명은 중지(AT-08·AT-09) |
| 진척도 | 근거 확인 가중치 2/4, 기준 없는 기존 Task, 기한 도래 WorkCycle 2/3 | 각각 50%, ‘기준 미설정’, 수행 2/3·미수행 1이며 계속 업무 전체 백분율 없음(AT-25·AT-26) |
| 승인·보상 | 외부 부작용 불명, 승인 만료, 대상 버전 변경 | 자동 재전송 없이 사용자의 새 결정을 요구하고 감사 기록(AT-17·AT-21) |
| 설정·로그 | 잘못된 스킬, 음수 모델 요금, 손상 로그 | 거부·격리·누락 표시. 비밀정보 노출 금지(AT-18·AT-27·AT-28) |

이 문서는 계약을 기술한 것이지 실제 CLI·DB·MCP 결합 시험 결과가 아니다.
