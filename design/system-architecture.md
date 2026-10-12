# AI 직원 시스템 전체 설계

- 문서 상태: 구현 전 설계안(2026-10-08). 이미 실행된 시스템을 설명하는 문서가 아니다.
- 기준 문서: [요구사항 정의서](../request/ai-employee-system-requirements.md). 화면 참고: [프로토타입](../prototype/index.html), [안내서](../prototype/guidebook.html).
- 관련 설계: [메뉴·화면 설계](./menu-design.md), [동작 설계](./action-design.md).
- 우선순위: 요구사항 정의서 > 이 설계 > 프로토타입의 샘플 동작. 충돌 시 임의로 구현하지 않고 차이를 기록해 요구사항을 확인한다.

## 1. 운영 문제·성공 조건·비목표

### 1.1 운영 문제와 사용자

사용자는 관리 AI와 작업 AI를 조직화해 장기 업무를 추적하려 한다. 잘못된 세션에 지시하거나 동일한 외부 변경을 두 번 실행하는 것, 문맥 압축 후 잘못된 완료 판정, 시간 초과 시 요청 누락, 무단 위임, 토큰·비용 낭비, 대화 로그의 비밀정보 유출이 주요 위험이다. 관리 AI의 cron 실행과 허용된 일시 장애 후 재개는 수동 감시를 줄이지만, 사내 정책이 불명확한 자동 재개나 공유 상태 변경까지 전부 자동화하지 않는다.

### 1.2 성공·제약·비목표

| 구분 | 판정 대상 |
|---|---|
| 업무 성공 | 사용자의 WorkOrder부터 Task·WorkLog·Run·결과 보고까지 같은 상관 ID로 추적 |
| 장애 대응 | Web/MCP 연결이 끊긴 뒤 Operation을 조회할 수 있고 같은 키의 재전송으로 업무가 늘어나지 않음 |
| 재개 성공 | 허용된 일시 종료에만 60초 이상 대기하고 같은 작업의 새 실행에서 미완료 부분을 계속함 |
| UI 성공 | 프로토타입의 14개 메뉴 의미, 목록·팝업·권한 분리를 재현 |
| 실행 제약 | TypeScript, Bootstrap 미사용, 세션당 동시 실행 1건, 유한한 실행 예산 |
| 비목표 | 사내 사용 제한 우회, 비공개 추론 복원, 근거 없는 전체 진척도, 승인 없는 운영 변경 |

초기 배포는 단일 단말·단일 운영자를 대상으로 한다. 다중 사용자·다중 호스트·외부 공개는 별도 단계에서 인증·DB·임대 잠금을 다시 설계한다. 현재 프로토타입은 `localStorage` 데모이며 Codex CLI·DB·cron·System MCP·실제 로그·실제 요금과 연결되지 않는다.

## 2. 논리적 구성

```text
Browser / Web UI ── Web API ─────────────┐
관리 AI ── System MCP Gateway ───────────┼─ Application Service ─ Transactional DB
Scheduler ─ WakeEvent ───────────────────┘         │              ├─ Outbox / Inbox
                                                   ├─ Run Queue     ├─ Audit / Approval
                                                   │                └─ Log Index
                                                   ▼
                                                Runner ─ spawn() ─ Codex CLI
                                                   │                 │
                                                   └─ Event Adapter ─┘
Web API ── SSE / cursor ── Browser
Log Reader ── 허용된 대화 원본 ── 정규화 이벤트 ── DB 검색 색인
```

| 경계 | 담당하는 결정 | 담당하지 않는 결정 |
|---|---|---|
| Browser | 입력 보조, 목록, 경고, 승인 의사 표시 | 권한 판정, 실행 가능 여부, 진척도의 기준 원본 |
| Web API / System MCP | 인증 주체 식별, 스키마 검증, Application Service 호출 | CLI 장기 실행이나 결과 추측 |
| Application Service | 권한, 버전, 상태 전이, 멱등성, 예산, 감사 기록 | LLM 문장만을 근거로 한 권한 변경 |
| Scheduler | cron·WorkCycle 기한 판단, WakeEvent 중복 방지 | 작업 완료 추측 |
| Runner | DB 임대 잠금, 하위 프로세스 감시, 이벤트 수집, 종료 분류 | 외부 부작용의 무조건 재실행 |
| 관리 AI | 계획, 허용된 대상에게 위임, 결과 검증·통합 | CallPermission·예산·사내 정책의 자체 변경 |
| 작업 AI | 배정 업무, 검증, 본인의 WorkLog·Checkpoint | 다른 AI 일지 수정, 무단 담당자 변경 |

Web·System MCP·Scheduler는 동일한 Application Service를 사용한다. 브라우저 연결 종료나 MCP 도구 응답 시간 초과는 실행 취소가 아니다. System MCP는 직원 관리·위임 전용이다. AI가 외부 서비스를 조작하는 별도 MCP와 인증·권한을 섞지 않는다.

### 2.1 TypeScript 구성안

| 패키지안 | 책임 |
|---|---|
| `apps/web` | 한국어 UI·표·대화상자·SSE 재연결. 자체 CSS 토큰을 사용하고 Bootstrap은 제외 |
| `apps/api` | HTTP/SSE, 세션·운영자 인증, 조회 모델, 명령 접수 |
| `apps/system-mcp` | MCP 도구 스키마, 호출자 검증, 위임 경계, Operation 조회 |
| `apps/worker` | Scheduler, 실행 대기열, Runner, outbox 전달, 로그 수집 |
| `packages/domain` | 상태 열거형, 업무 불변조건, 진척도 계산, 권한 판정 |
| `packages/contracts` | 실행 시점 스키마, Web/MCP 입출력형, 오류 코드 |
| `packages/persistence` | DB 트랜잭션, 저장소, 마이그레이션, 감사 |
| `packages/codex-adapter` | CLI 인수, JSONL 파서, 명시적 세션 ID, 로그 형식 어댑터 |

웹 프레임워크·DB 제품·MCP 전송 방식·cron 파서는 미결정이다. MVP 후보는 TypeScript UI, Node.js 서비스, 단일 호스트의 트랜잭션 지원 DB다. SQLite를 선택하더라도 임대 잠금·부분 유일 제약·장애 복구를 PoC로 검증하기 전에는 확정하지 않는다. 다중 호스트는 별도 설계다.

## 3. 결정 경계와 승인

| 방식 | 예 | 집행 지점 |
|---|---|---|
| 자율 | 허용 범위 읽기, 기존 작업에 본인의 WorkLog 기록, 근거 제출 | 서비스의 actor·scope·revision 검증 |
| 예약 | 활성화된 관리 AI cron, 기한이 도래한 WorkCycle 알림 | Scheduler와 DB 유일 키 |
| 명시적 승인 | 새 쓰기 범위, 외부 전송, 운영 작업, 부작용 불명 작업의 재실행 | 대상·작업·기한·버전을 고정한 Approval |
| 운영자 전용 | 조직·CallPermission·모델 요금·비밀정보·실행 한도 변경, 물리 삭제 | Web 운영자 권한. AI용 MCP에는 공개하지 않음 |
| 금지 | 제한 우회, 감사 무력화, 인증 정보 표시, 미승인 파괴적 작업 | API·Runner·샌드박스의 여러 계층에서 거부 |

스킬·페르소나·대화 로그의 문장은 권한의 근거가 아니다. 조직도의 직속 관계와 CallPermission은 별개이고 기본값은 거부다. 인사이동 시 이전 권한을 폐기하며 새 상사에게 자동으로 부여하지 않는다. 프로토타입 조직 상세에 남은 이름·담당 업무 편집란은 실제 설계에서 ‘AI 직원’ 화면의 책임으로 옮긴다(FR-08).

## 4. AI 업무 처리 흐름

| 단계 | 진입 조건·입력 | 출력 계약 | 실패 시 |
|---|---|---|---|
| 1. 입력 수집 | 인증된 Web 지시, cron, MCP, 결과 알림 | `request_id`, WorkOrder/WakeEvent/Operation | 스키마가 잘못되면 접수 전에 거부 |
| 2. 의도 해석 | 목적, 대상, 업무 범위, 결과 확인 항목 | 유한 작업·계속 업무·면담의 구분 | 대상이 모호하거나 위험한 범위면 사용자에게 확인 |
| 3. 문맥 검색 | 주체의 읽기 권한 | Task, 본인 WorkLog, Checkpoint, Decision, 설정 버전을 포함한 ContextSnapshot | 누락·오래된 버전이면 중지 또는 재조회 |
| 4. 계획 생성 | 완료 조건, 예산, 허용 대상 | 구조화된 작업·담당 후보·검증 방법 | 순환·권한·예산 위반 거부 |
| 5. 도구 실행 | Approval, CallPermission, 임대 잠금, 재개 대기를 재확인 | 비동기 Operation·Run, 외부 작업 의도 | 시간 초과는 Operation 조회. 부작용 불명은 중지 |
| 6. 결과 검증 | 산출물과 근거 | 조건별 확인, 미해결 항목, 실제 모델·사용량 | 근거 없으면 미확인 유지 |
| 7. 응답 생성 | 검증 결과 확정 | 관리 AI 보고서, 남은 작업, 출처 | 부분 성공을 완료로 표시하지 않음 |
| 8. 로그·관측 | 전 단계의 상관 ID | AuditEvent, WorkLog, 측정값, 알림 | DB 기록 불가 시 새 쓰기 중지 |

LLM 호출은 모호성 해소·계획·결과 통합에 한정한다. 상태 전이와 권한 판정은 코드로 수행한다.

| 호출 | 입력 | 스키마 출력 | 거부·검증 조건 |
|---|---|---|---|
| 관리 AI 계획 | WorkOrder, ContextSnapshot, 허용 후보, 예산, 미처리 inbox | 작업안·의존성·완료 조건·담당 후보·승인 필요 항목 | 대상·권한·예산이 불명확하면 중지. 후보는 서비스가 재검증 |
| 작업 AI 실행 | 배정된 Task, 본인의 최신 WorkLog, Checkpoint, 허용 도구, 작업 위치 | 산출물·근거·미완료·다음 행동·추가 확인 | 권한 부족·외부 결과 불명 시 중지. 근거 참조와 버전 대조 |
| 관리 AI 결과 통합 | WorkOrder 보고 조건, 검증된 작업 결과, 미해결·출처 | 결론·조건별 판정·결과 보고서·남은 작업 | 미확인 결과를 완료 처리하지 않음. 잘못된 스키마는 `needs_attention` |

모든 호출은 필수 입력 누락·권한 부족·위험한 범위 변경에 대해 거부를 출력할 수 있다. 잘못된 스키마를 업무 기준 원본에 저장하지 않고 민감정보를 가린 진단 기록으로 격리한다.

## 5. 주요 작업 흐름과 제어

### 5.1 AI 직원 생성부터 실제 세션 등록까지

1. 사용자가 한 양식에 이름, 담당 업무, 관리/작업 종류, 모델, 페르소나, 스킬, 선택적 세션 표시 이름을 입력한다. 저장하지 않고 이탈하면 경고한다.
2. 서비스가 Employee·설정 버전·초기화 대기 세션·Operation을 한 트랜잭션으로 저장한다. 초기 상태는 조직 미배정·호출 불허다.
3. Runner가 허용된 cwd·home·인증 상태·예산을 확인하고 셸 확장 없이 `spawn()`으로 CLI를 시작한다. 첫 이벤트에서 실제 `codex_session_id`를 확보한 경우에만 세션에 연결한다.
4. 실제 ID 수집 전 실패는 `initialization_failed`로 기록해 같은 Operation을 조회하고 안전하게 재시도하게 한다. 임시 ID를 재개 가능한 것으로 표시하지 않는다. 추가 세션은 기존 Employee를 지정하는 별도 작업이다.

CLI 시작 형태·이벤트 형식·동일 세션의 모델 전환·스킬 주입은 요구사항 자료의 설계안이며 이 환경의 결합 동작은 검증되지 않았다. 명시적 ID로 resume하고 `--last`에 의존하지 않는다.

### 5.2 사용자 업무 지시부터 보고까지

```text
사용자 ─ WorkOrder ─ 관리 AI Run ─ System MCP task_delegate ─ Task ─ 작업 AI Run
  ▲                                                               │
  └──── WorkOrderReport ─ 관리 AI 검증 ◀─ Inbox ◀─ result + WorkLog ┘
```

- WorkOrder는 사용자의 요청을 접수하는 기준 원본이다. 저장만으로 Task·Run을 만들지 않는다. 관리 AI가 목적·보고 확인 항목을 해석해 허용된 작업 AI에 System MCP로 위임한다.
- 위임 트랜잭션은 Operation·Task·TaskAssignmentEvent·outbox를 일관되게 저장한다. 결과 알림은 inbox에 남아 관리 AI가 중지된 동안에도 사라지지 않는다.
- Task·WorkLog는 사용자 화면에서 읽기 전용이다. WorkLog는 작성한 AI 본인의 다음 재개용 메모이며 다른 AI로 책임을 넘기는 기록이 아니다. 실제 담당 변경은 TaskAssignmentEvent로만 추적한다.
- 관리 AI는 결과·근거를 검증해 WorkOrderReport를 제출한다. 보고서 없는 `reported` 상태는 금지한다.

### 5.3 관리 AI cron과 계속 업무

- cron은 관리 AI를 깨우는 계기이고 WorkProcess는 종료 시점이 없는 확인 대상 업무다. cron 발화만으로 WorkCycle을 `done`으로 만들지 않는다.
- Scheduler는 `schedule_id + scheduled_at`을 유일하게 해 WakeEvent를 저장한다. 중복 발화는 아무 작업도 하지 않는다. 중지 기간의 모든 회차를 재생하지 않고 최근의 미처리 점검을 한도 안에서 합친다. 개별 WorkOrder나 결과 알림은 합쳐서 지우지 않는다.
- WorkProcess는 주기와 대상 기간에 따라 기한 도래 WorkCycle을 가진다. 기한이 도래한 예정 회차를 분모로 `done`·`missed`·`skipped_with_reason`을 구분한다. 파생 Task 수는 분모에 영향을 주지 않는다.
- 종료 시점 없는 WorkProcess에는 전체 백분율을 표시하지 않는다. 유한 Task에만 `100 × 근거가 확인된 조건의 가중치 합 / 전체 조건 가중치 합`을 표시한다. 기준 없는 기존 작업은 ‘기준 미설정’이다.

### 5.4 일시 종료·재개·취소

- 종료 원인을 분류하기 전에는 자동 재개하지 않는다. 사내 정책에서 허용한 일시 제한에만 `next_eligible_at = max(종료 시각 + 60초, Retry-After, policy_not_before)`를 DB에 저장한다. 조직·계정 단위 제한은 공유 대기로 처리한다.
- 기한 후에도 이전 프로세스 중지, DB 임대 잠금, 권한, Task 버전, 본인 WorkLog, Checkpoint, 외부 부작용을 대조한다. 이전 Run은 종료 상태로 두고 새 Run과 `resume_of_run_id`를 만든다.
- 인증 만료·금지·원인 불명·외부 부작용 불명·시도 한도 초과는 `needs_attention`으로 중지한다. 통신 재연결이나 동일 키 재전송은 업무 재실행과 다르다.
- 사용자의 취소는 예약·새 접수를 막는 요청이지 이미 수행된 외부 변경을 되돌리는 작업이 아니다. 보상 작업은 대상·외부 상태·승인을 확인해 별도 작업으로 수행한다.

## 6. 영속 데이터와 불변조건

| 집합·테이블안 | 주키·관계·필수 제약 |
|---|---|
| `organizations`, `org_assignments` | 직원의 동시 유효 소속은 1개. 이동 전후·사유·적용 시각 기록 |
| `employees`, `employee_config_versions` | `employee_id` 불변. 이름·담당 업무·관리/작업 종류와 설정 버전 분리 |
| `call_permissions` | `(manager_id, worker_id, valid_from)`. 유효한 명시적 허용이 있어야 위임 가능. 인사이동 시 이전 허용 폐기 |
| `sessions` | `session_id`와 `(host, home, codex_session_id)` 구분. 직원당 현재 세션은 최대 1개 |
| `skills`, `skill_set_versions`, `persona_templates` | `SKILL.md`의 이름·설명·본문, 해시, 출처, 승인, 적용 버전 |
| `schedules`, `wake_events` | `(schedule_id, scheduled_at)` 유일. 시간대·버전·처리 결과 |
| `work_orders`, `work_order_reports` | 사용자 요청, 관리 AI, 보고 조건, 작업 연결, 보고 본문·근거 |
| `work_processes`, `work_cycles` | `(work_process_id, scheduled_at)` 유일. 예정·수행·미수행·파생 Task |
| `tasks`, `completion_criteria`, `criterion_verifications` | Task 버전과 조건 버전, 양수 가중치, 근거·확인자·시각, 과거값 유지 |
| `task_assignment_events`, `task_events` | 위임·인사이동·상태 전이를 추가 기록형으로 감사. 오래된 버전으로 갱신 금지 |
| `work_logs`, `checkpoints`, `decisions` | WorkLog 작성자는 인증된 AI. 본인의 재개용이며 추가 기록·참조 버전 유지 |
| `operations`, `runs`, `leases` | 호출자+작업+키의 멱등성. 시도마다 새 Run ID, 세션 임대 잠금은 단독 |
| `inbox_events`, `outbox_events` | event_id 유일, 전달 시도·커서·ACK. 최소 1회 전달 |
| `conversation_events`, `log_checkpoints` | 출처 세대+이벤트 ID 또는 오프셋으로 중복 방지. 원본은 변경하지 않음 |
| `interviews`, `approvals`, `audit_events` | 전용 세션, 공유 범위, 승인 대상 버전, 작업자·사유 |
| `model_price_versions` | 모델·USD/100만 토큰·입력/캐시 입력/출력 단가·적용 시작 시각·버전 |

DB 제품이 결정되기 전에는 구체적인 SQL 자료형과 색인 구현을 확정하지 않는다. 업무 기준 원본은 DB, 대화 원본은 허용된 Codex 로그다. 검색 색인·화면 캐시는 재생성 가능한 파생 데이터다. 큰 산출물은 보호 저장소에 두고 DB에는 ID·해시·위치를 기록한다. 외부 작업의 의도와 결과는 별도로 기록하며 의도만 남으면 `unknown`으로 대조한다.

## 7. 세션·대화 로그·모델 요금

- 세션 표시 이름은 앱의 선택적 라벨이며 실제 Codex ID가 아니다. 새 세션의 실제 ID를 확보하지 못하면 resume을 허용하지 않는다. 모델·페르소나·스킬 변경은 다음 실행 경계부터 적용하며 요청 모델과 확인된 실제 모델을 구분해 기록한다.
- `log_source_roots`는 읽기 위치, `execution_codex_home`은 실행 환경이며 독립적으로 설정한다. 정규 경로·허용 루트·심볼릭 링크·비밀 파일 제외를 검증한다. 수집 상태는 `complete_for_source`·`partial`·`unsupported`·`missing`으로 표시한다.
- 작성 중·손상·순환된 로그는 출처 세대와 오프셋으로 안전하게 수집한다. 본문이 같다는 이유만으로 정상적인 중복 발언을 삭제하지 않는다. 로그나 산출물의 명령을 설정 변경으로 받아들이지 않는다. 비공개 추론이나 저장되지 않은 대화는 ‘전문’에 넣지 않는다.
- 모델별 요금은 관리자가 수동으로 입력하며 빈칸과 명시적 `0`을 구분한다. 사용량을 관측하지 못한 실행의 비용은 불명이다. 추정액과 실제 청구액을 동일시하지 않는다.

## 8. 시간 초과·관측·운영

| 대상 | 초기안·검증 항목 | 복구·경고 |
|---|---|---|
| Web/MCP 접수 | 장기 업무를 기다리지 않고 `202 Accepted` 또는 Operation ID 반환. 접수 p95 2초·기한 10초는 측정 전 설계안 | 응답 소실 시 같은 키로 Operation 조회 |
| MCP 재연결 | 1·2·5·10·30초 단계 대기는 설계안 | 인증 재확인 후 영속 커서에서 inbox 회수 |
| Runner 임대 잠금 | 하트비트 10초·기한 45초는 설계안 | 기한만으로 재시작하지 않고 프로세스·부작용 대조 |
| CLI 무출력 | 일률적인 사망 판정 금지 | 생존·하트비트·진척 정체를 별도로 감시 |
| 사용 제한 | 60초 이상과 사내 지정값 중 긴 쪽 | 명시적으로 허용된 경우에만 재개, 한도 도달 시 알림 |

관측 ID는 `request_id`·`operation_id`·`work_order_id`·`work_process_id`·`task_id`·`work_log_id`·`run_id`·`session_id`·`event_id`다. 접수 시간, 대기열 시간, 실행 시간, 모델·도구 사용량, 스키마 실패, 중복 방지, 재개 횟수, 수동 개입, 로그 지연을 측정한다. 비밀정보를 응답·감사·검색 색인에 저장하지 않는다. 보존 기간·DB 백업 및 복구 훈련·알림 기준은 운영 전 결정한다.

인증값은 환경 변수나 보호된 비밀 관리에 보관하고 일반 설정 파일·소스 관리·프롬프트에 넣지 않는다. 운영자 설정 변경·비활성화는 M-13, cron은 M-09, 재개는 M-10에서 수행하고 영향 범위를 감사한다.

## 9. 검증과 구현 순서

| 구현 단계 | 입증할 인수 조건 |
|---|---|
| TypeScript 기반·CLI 어댑터·세션/로그 PoC | FR-04, FR-05, FR-06, FR-10, FR-13 / AT-05, AT-06, AT-07, AT-12, AT-18, AT-23 |
| DB·직원·조직·설정 버전·스킬/페르소나 | FR-02, FR-08, FR-16 / AT-02, AT-04, AT-10, AT-27, AT-30 |
| WorkOrder·Task·WorkLog·WorkProcess·1:1 면담 | FR-03, FR-09, FR-14, FR-15 / AT-03, AT-11, AT-17, AT-24, AT-25, AT-26 |
| Scheduler·MCP·Runner·재개 | FR-01, FR-07, FR-11 / AT-01, AT-08, AT-09, AT-13, AT-14, AT-15, AT-16 |
| UI·요금·안내서·안전·성능 | FR-12, FR-17, FR-18 / AT-19, AT-20, AT-21, AT-22, AT-28, AT-29 |

성공 경로뿐 아니라 접수 직후 응답 소실, 부분적인 외부 성공, 승인 대기, 인사이동 시 권한 폐기, 재개 대기 중 재시작, 취소·보상을 가짜 CLI·가상 시계·DB 장애 주입으로 검증한다. 실제 CLI와 사내 정책에 대한 적합성 시험은 미수행이며 조건 확인 전까지 자동 재개를 비활성화한다.

## 10. 구현 전 확정할 항목

1. DB 제품과 단일/다중 호스트의 경계, 트랜잭션·임대 잠금·백업 방침.
2. Codex CLI의 실제 세션 ID·resume·동일 세션의 모델 전환·스킬 적용·로그 파서의 지원 버전.
3. 사내 사용 제한의 감지 조건·단위·재개 허용과 총예산. 원인 불명 종료는 자동 재개하지 않는다.
4. WorkProcess의 집계 기간, 미수행 판정 기한, WorkOrder 보고서의 사용자 확정 절차.
5. 인증·승인·비밀 관리·보존 기간·초기 배포에서 허용할 외부 쓰기 범위.

이 항목이 미결정이어도 UI·DB 설계는 진행할 수 있지만 해당 운영 작업을 활성화하지 않는다.
