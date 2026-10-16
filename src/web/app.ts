type RecordItem = Record<string, any>;
type Data = Record<string, unknown>;
const mainMenus = [
  ['dashboard', '대시보드'],
  ['employees', 'AI 직원'],
  ['organizations', '조직·직원'],
  ['orders', '업무 지시'],
  ['tasks', 'Task 이력'],
  ['logs', '업무 일지'],
  ['conversations', '세션 대화'],
  ['interviews', '1:1 면담'],
];
const operationMenus = [
  ['schedules', '관리 AI 일정'],
  ['recovery', '복구 센터'],
  ['mcp-metrics', 'MCP 사용 지표'],
  ['ai-policy', 'AI 정책'],
  ['skills', '스킬 등록'],
  ['personas', '페르소나 템플릿'],
  ['settings', '환경 설정'],
  ['guide', '가이드북'],
];
const builtInPersonas = [
  {
    id: 'manager',
    name: '관리 AI 기본',
    content:
      'DB 기록과 검증 결과를 확인하고 호출이 허용된 실무 AI에게만 업무를 위임하는 관리 담당자입니다. 목적·완료 조건·미완료 항목을 기록하고 불명확한 점은 사람에게 확인합니다.',
  },
  {
    id: 'worker',
    name: '실무 AI 기본',
    content:
      '담당 범위 안에서 작업하고 결과와 검증 근거를 기록합니다. 불명확한 점은 확인하고 미검증 결과를 완료로 처리하지 않습니다.',
  },
  {
    id: 'developer',
    name: '개발 담당',
    content:
      '담당 범위 안에서 구현하고 테스트 결과와 변경 근거를 기록하는 개발 담당자입니다. 불명확한 요구사항은 확인하고 미검증 결과를 완료로 처리하지 않습니다.',
  },
  {
    id: 'researcher',
    name: '조사 담당',
    content:
      '출처를 확인하고 사실·추론·미확인 사항을 구분하는 조사 담당자입니다. 비교 기준과 결론의 근거를 명시합니다.',
  },
  {
    id: 'reviewer',
    name: '검토 담당',
    content:
      '변경 위험과 회귀, 부족한 테스트를 검증하는 검토 담당자입니다. 재현 가능한 근거와 대응안을 제시합니다.',
  },
];
const app = document.querySelector<HTMLElement>('#app')!;
const detail = document.querySelector<HTMLDialogElement>('#detail-dialog')!;
const login = document.querySelector<HTMLDialogElement>('#login-dialog')!;
let token = sessionStorage.getItem('operator-token') || '';
let page = 'dashboard';
let employeeEditor: { mode: 'create' | 'edit'; sessionId?: string } | null =
  null;
let employeeFilter = 'all';
let workOrderTab: 'orders' | 'reports' = 'orders';
let taskFilter = 'all';
let taskQuery = '';
let workLogEmployeeFilter = 'all';
let workLogTaskFilter = 'all';
let selectedConversationSession = '';
let conversationEvents: RecordItem[] = [];
let conversationRequest = 0;
let selectedInterviewId = '';
let interviewEvents: RecordItem[] = [];
let interviewRequest = 0;
let skillMode: 'direct' | 'upload' = 'direct';
let skillDraft = { name: '', description: '', body: '' };
let skillUpload: {
  fileName: string;
  content: string;
  name: string;
  description: string;
  body: string;
} | null = null;
let skillError = '';
let skillUploadRequest = 0;
let data: Data = {};
let policyDraft: { skillIds: string[]; revision: number } | null = null;
let policyBusy = false;
let metricsFilter = { days: '7', employeeId: '', tool: '' };
let metricsResult: RecordItem | null = null;
let metricsError = '';
let metricsRequest = 0;
let metricsLoading = false;
let dirty = false;
const pendingKeys = new Map<string, string>();
const values = (name: string): RecordItem[] =>
  Array.isArray(data[name]) ? (data[name] as RecordItem[]) : [];
const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!
  );
const statusLabels: Record<string, string> = {
  ready: '준비됨',
  completed: '완료',
  reported: '보고됨',
  active: '활성',
  failed: '실패',
  needs_attention: '확인 필요',
  execution_unknown: '실행 상태 불명',
  queued: '대기 중',
  paused: '보류',
  running: '실행 중',
  reviewing: '검토 대기',
  cooldown: '재개 대기',
  pending: '대기 중',
  cancelled: '취소됨',
  enabled: '활성',
  disabled: '중지',
  done: '수행 완료',
  missed: '미수행',
  skipped: '건너뜀',
  accepted: '접수됨',
  initializing: '초기화 중',
};
const iconPaths: Record<string, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M20 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  task: 'M9 5h11v16H4V5h2 M9 3h6v4H9z M8 12l2 2 5-5 M8 18h8',
  chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 8.5-8.5h.5a8.5 8.5 0 0 1 8 8v.5z',
  clock: 'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3l-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-3z',
  shield: 'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',
  bolt: 'M13 2L3 14h8l-1 8 11-13h-8z',
  code: 'M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',
  folder: 'M3 7V4h6l2 3h10v13H3z',
  database:
    'M21 5c0 2-4 3-9 3S3 7 3 5s4-3 9-3 9 1 9 3z M3 5v7c0 2 4 3 9 3s9-1 9-3V5 M3 12v7c0 2 4 3 9 3s9-1 9-3v-7',
  building: 'M4 21V3h12v18 M16 10h4v11 M8 7h4 M8 11h4 M8 15h4 M9 21v-3h2v3',
  refresh:
    'M3 11a9 9 0 0 1 15-6l3 3 M21 3v5h-5 M21 13a9 9 0 0 1-15 6l-3-3 M3 21v-5h5',
};
const icon = (name: string) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${iconPaths[name] || iconPaths.grid}"/></svg>`;
const menuIcons: Record<string, string> = {
  'mcp-metrics': 'database',
  'ai-policy': 'shield',
  dashboard: 'grid',
  employees: 'code',
  organizations: 'building',
  orders: 'task',
  tasks: 'database',
  logs: 'folder',
  conversations: 'chat',
  interviews: 'chat',
  schedules: 'clock',
  recovery: 'refresh',
  skills: 'code',
  personas: 'users',
  settings: 'settings',
  guide: 'shield',
};
const badge = (value: unknown) =>
  `<span class="badge ${['ready', 'completed', 'reported', 'active'].includes(String(value)) ? 'ok' : ['failed', 'needs_attention', 'execution_unknown'].includes(String(value)) ? 'fail' : 'warn'}">${escapeHtml(statusLabels[String(value)] || value)}</span>`;
const date = (value: unknown) =>
  value
    ? new Date(Number(value)).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
      })
    : '—';
const short = (value: unknown) => escapeHtml(String(value ?? '').slice(0, 80));
const lookup = (name: string, id: unknown) =>
  values(name).find((row) => row.id === id);
const head = (title: string, subtitle: string, action = '') =>
  `<div class="page-head"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;
const table = (headers: string[], rows: string[]) =>
  rows.length
    ? `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<div class="empty">아직 등록된 항목이 없습니다.</div>';
const fieldLabel = (label: string, required = false) =>
  `<span class="field-label">${escapeHtml(label)}${required ? '<span class="required" aria-label="필수">*</span>' : ''}</span>`;
const field = (
  label: string,
  name: string,
  value = '',
  required = false,
  kind = 'text'
) =>
  `<label>${fieldLabel(label, required)}<input name="${name}" type="${kind}" value="${escapeHtml(value)}" ${required ? 'required' : ''}></label>`;
const options = (
  items: RecordItem[],
  label: (x: RecordItem) => string,
  selected?: string
) =>
  items
    .map(
      (x) =>
        `<option value="${escapeHtml(x.id)}" ${x.id === selected ? 'selected' : ''}>${escapeHtml(label(x))}</option>`
    )
    .join('');
const managerOptions = () =>
  options(
    values('employees').filter(
      (x) => x.role === 'manager' && x.status === 'active'
    ),
    (x) => x.name
  );
const modelField = (selected: string) =>
  `<label>${fieldLabel('모델', true)}<select name="model" required>${[...new Set([...(Array.isArray(data.modelChoices) ? (data.modelChoices as string[]) : ['gpt-6.1-sol']), selected])].map((model) => `<option value="${escapeHtml(model)}" ${model === selected ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')}</select></label>`;
const notice = (text: string) => `<div class="notice">${text}</div>`;
function toast(message: string) {
  const el = document.querySelector<HTMLElement>('#toast')!;
  el.textContent = message;
  setTimeout(() => {
    if (el.textContent === message) el.textContent = '';
  }, 6000);
}
async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  idem?: string
): Promise<any> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idem) {
    if (!pendingKeys.has(idem)) pendingKeys.set(idem, crypto.randomUUID());
    headers['idempotency-key'] = pendingKeys.get(idem)!;
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message || result.code || `HTTP ${response.status}`);
  if (idem) pendingKeys.delete(idem);
  return result;
}
async function refresh() {
  data = await api('/api/bootstrap');
  render();
}
function nav() {
  const renderNav = (menus: string[][]) =>
    menus
      .map(
        ([id, label]) =>
          `<button data-nav="${id}" class="${page === id ? 'active' : ''}" aria-current="${page === id ? 'page' : 'false'}">${icon(menuIcons[id] || 'grid')}<span>${label}</span></button>`
      )
      .join('');
  document.querySelector('#main-nav')!.innerHTML = renderNav(mainMenus);
  document.querySelector('#operation-nav')!.innerHTML =
    renderNav(operationMenus);
  document.querySelector('#page-title')!.textContent =
    [...mainMenus, ...operationMenus].find((x) => x[0] === page)?.[1] || '';
}
function dashboard() {
  const employees = values('employees'),
    tasks = values('tasks'),
    jobs = values('jobs'),
    orders = values('workOrders');
  const cards: [string, number, string, string, string][] = [
    ['함께 일하는 AI', employees.length, 'employees', 'users', '명'],
    [
      '진행 중인 Task',
      tasks.filter((x) => !['completed', 'cancelled'].includes(x.status))
        .length,
      'tasks',
      'bolt',
      '건',
    ],
    [
      '확인이 필요한 실행',
      jobs.filter((x) => x.status === 'needs_attention').length,
      'recovery',
      'task',
      '건',
    ],
    ['업무 지시', orders.length, 'orders', 'folder', '건'],
  ];
  const activity = jobs
    .slice(0, 4)
    .map(
      (job) =>
        `<div class="activity-item"><span class="activity-icon">${icon(job.status === 'needs_attention' ? 'shield' : 'bolt')}</span><div><strong>${escapeHtml(lookup('employees', job.employee_id)?.name || 'AI 직원')} · ${escapeHtml(statusLabels[String(job.status)] || job.status)}</strong><p>${escapeHtml(job.kind || '실행')} · 시도 ${escapeHtml(job.attempt ?? 0)}회</p><time>${date(job.created_at || job.updated_at)}</time></div></div>`
    )
    .join('');
  const team = employees
    .slice(0, 6)
    .map(
      (employee) =>
        `<button type="button" class="employee-card" data-nav="employees"><span class="employee-card-top"><span class="employee-avatar">${escapeHtml(String(employee.name || 'AI').slice(0, 1))}</span>${badge(employee.status)}</span><h3>${escapeHtml(employee.name)}</h3><p class="role">${employee.role === 'manager' ? '관리 AI' : '작업 AI'}</p><p class="department">${short(employee.responsibility)}</p><span class="employee-card-foot">직원 목록에서 보기 <span aria-hidden="true">→</span></span></button>`
    )
    .join('');
  return (
    head(
      '대시보드',
      '오늘의 팀 현황을 한눈에. AI 직원의 진행 상황을 확인하고 다음 업무를 준비하세요.'
    ) +
    `<div class="grid stats">${cards.map(([label, count, link, symbol, unit]) => `<button type="button" class="panel metric stat" data-nav="${link}"><span class="stat-top">${label}<span class="stat-icon">${icon(symbol)}</span></span><strong class="stat-value">${count}<small>${unit}</small></strong><span class="stat-foot">목록 보기 <span aria-hidden="true">→</span></span></button>`).join('')}</div><div class="dashboard-grid"><section class="panel dashboard-panel"><div class="panel-head"><div><h2>함께 일하는 AI 팀</h2><p class="panel-sub">등록된 AI 직원의 역할과 담당 업무를 확인하세요.</p></div><button type="button" class="link-btn" data-nav="employees">모두 보기 →</button></div>${team ? `<div class="team-grid">${team}</div>` : '<div class="empty">AI 직원을 등록하면 이곳에 표시됩니다.</div>'}</section><section class="panel dashboard-panel"><div class="panel-head"><h2>작업 공간 활동</h2><span class="panel-meta">실제 실행 기록</span></div>${activity ? `<div class="activity-list">${activity}</div>` : '<div class="empty">아직 실행 기록이 없습니다.</div>'}</section></div><section class="panel dashboard-panel"><div class="panel-head"><h2>최근 Task</h2><button type="button" class="link-btn" data-nav="tasks">모든 Task →</button></div>${table(
      ['작업', '담당 AI', '상태', '갱신'],
      tasks
        .slice(0, 5)
        .map(
          (task) =>
            `<tr><td><button type="button" class="task-name" data-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button></td><td>${escapeHtml(lookup('employees', task.worker_id)?.name || '미배정')}</td><td>${badge(task.status)}</td><td>${date(task.updated_at)}</td></tr>`
        )
    )}</section><section class="panel dashboard-panel"><div class="panel-head"><h2>최근 실행</h2><span class="panel-meta">실제 실행 기록</span></div><div class="panel-body">${table(
      ['직원', '상태', '모델', '시작'],
      values('runs')
        .slice(0, 10)
        .map(
          (x) =>
            `<tr><td>${escapeHtml(lookup('employees', x.employee_id)?.name || x.employee_id)}</td><td>${badge(x.status)}</td><td>${escapeHtml(x.model)}</td><td>${date(x.started_at)}</td></tr>`
        )
    )}</div></section>`
  );
}
function sessionSkillNames(session: RecordItem): string[] {
  try {
    const ids = JSON.parse(String(session.skill_ids || '[]'));
    if (session.is_current === 1) {
      const common = (data.aiPolicy as RecordItem)?.skillIds || [];
      return Array.from(new Set<string>([...common, ...ids])).map(id => `${common.includes(id) ? '공통' : '개별'} · ${lookup('skills', id)?.name || id}`);
    }
    const latestRun = values('runs').find(run => run.session_id === session.id);
    const snapshot = values('runSkillSnapshots').find(snapshot => snapshot.run_id === latestRun?.id);
    if (snapshot) return JSON.parse(snapshot.skills_json).map((skill: RecordItem) => `${skill.source === 'common' ? '공통' : '개별'} · ${skill.name} v${skill.version}`);
    return Array.isArray(ids)
      ? ids.map((id) => lookup('skills', id)?.name || id)
      : [];
  } catch {
    return [];
  }
}
function sessionPolicyNote(session: RecordItem, future = session.is_current === 1): string {
  const run = values('runs').find(run => run.session_id === session.id);
  const snapshot = values('runSkillSnapshots').find(snapshot => snapshot.run_id === run?.id);
  return `<small class="hint">${future ? `다음 Run 공통 정책 v${(data.aiPolicy as RecordItem)?.revision || 1} · ` : ''}${snapshot ? `최근 Run 적용 정책 v${escapeHtml(snapshot.policy_revision)} · 개별 설정 v${escapeHtml(snapshot.individual_revision)}` : '최근 Run 정책 미기록'}${future ? '' : ' · 과거 스냅샷 기준'}</small>`;
}
function employees() {
  if (employeeEditor) return employeeEditorPage();
  const sessions = values('sessions').filter(
    (s) => employeeFilter === 'all' || s.employee_id === employeeFilter
  );
  const current = values('sessions').filter((s) => s.is_current === 1).length;
  const rows = sessions.map((s) => {
    const e = lookup('employees', s.employee_id) || {},
      org = lookup('organizations', e.org_id);
    return `<tr><td><div class="session-table-employee"><span class="employee-avatar">${escapeHtml(String(e.name || 'AI').slice(0, 1))}</span><span><strong>${escapeHtml(e.name || 'AI 직원')}</strong><small>${e.role === 'manager' ? '관리 AI' : '작업 AI'} · ${escapeHtml(org?.name || '조직 미배치')}</small></span></div></td><td class="session-table-session"><strong>${escapeHtml(s.label || '이름 없음')}</strong><code>Codex ID · ${escapeHtml(s.codex_id || '미발급')}</code><span class="badge ${s.is_current === 1 ? 'ok' : 'warn'}">${s.is_current === 1 ? '현재' : '이력'} · 설정 v${escapeHtml(s.revision || 1)}</span></td><td><code>${escapeHtml(s.model)}</code></td><td><p class="session-table-persona">${short(s.persona) || '미설정'}</p></td><td><div class="session-table-skills">${
      sessionSkillNames(s)
        .map((name) => `<span class="schedule-tag">${escapeHtml(name)}</span>`)
        .join('') || '<span class="hint">미설정</span>'
    }</div>${sessionPolicyNote(s)}</td><td><div class="session-table-actions">${s.is_current === 1 ? `<button class="secondary small" data-config="${escapeHtml(s.id)}">설정 편집</button>` : ''}<button class="secondary small" data-session="${escapeHtml(s.id)}">대화 열기</button>${s.is_current === 1 ? `<button class="secondary small" data-add-session="${escapeHtml(e.id)}">세션 추가</button>` : ''}</div></td></tr>`;
  });
  return (
    head(
      'AI 직원',
      '직원 생성 시 모델·페르소나·기본 스킬을 갖춘 현재 세션 하나를 설정합니다.',
      '<button type="button" class="primary" data-employee-create>AI 직원 생성</button>'
    ) +
    `<div class="session-metrics"><div class="panel"><span>등록 직원</span><strong>${values('employees').length}<small>명</small></strong></div><div class="panel"><span>현재 세션</span><strong>${current}<small>건</small></strong></div><div class="panel"><span>저장된 이력</span><strong>${values('sessions').length - current}<small>건</small></strong></div></div><div class="session-list-toolbar"><div><h2>세션 목록</h2><p>현재 세션은 직원마다 하나입니다. 이전 세션과 대화는 이력으로 남깁니다.</p></div><label>AI 직원<select id="employee-filter"><option value="all">모든 직원</option>${values(
      'employees'
    )
      .map(
        (e) =>
          `<option value="${escapeHtml(e.id)}" ${employeeFilter === e.id ? 'selected' : ''}>${escapeHtml(e.name)}</option>`
      )
      .join(
        ''
      )}</select></label></div><section class="panel session-table-panel"><div class="table-wrap"><table class="session-table" aria-label="세션 목록"><thead><tr><th scope="col">AI 직원</th><th scope="col">세션</th><th scope="col">모델</th><th scope="col">기본 페르소나</th><th scope="col">기본 스킬</th><th scope="col">작업</th></tr></thead><tbody>${rows.join('') || `<tr><td class="session-table-empty" colspan="6">${employeeFilter === 'all' ? '아직 AI 직원이 없습니다.' : '이 직원의 세션이 없습니다.'}<div><button type="button" class="primary" data-employee-create>AI 직원 생성</button></div></td></tr>`}</tbody></table></div><div class="session-table-footer"><span>표시 ${sessions.length} / ${values('sessions').length} 건</span><span>이전 설정은 읽기 전용입니다.</span></div></section>`
  );
}
function employeeEditorPage() {
  const editing = employeeEditor?.mode === 'edit';
  const session = editing
    ? lookup('sessions', employeeEditor?.sessionId)
    : undefined;
  if (editing && !session)
    return '<div class="empty">현재 세션을 찾을 수 없습니다.</div>';
  const employee = session
    ? lookup('employees', session.employee_id)
    : undefined;
  const selectedSkills = session ? sessionSkillNames(session) : [];
  const skills = values('skills');
  const form = editing ? 'config' : 'employee';
  const skillIds = editing
    ? (() => {
        try {
          return JSON.parse(String(session?.skill_ids || '[]')) as string[];
        } catch {
          return [];
        }
      })()
    : [];
  return (
    head(
      editing ? '세션 설정 편집' : '새 AI 직원',
      editing
        ? '현재 세션의 모델·페르소나·기본 스킬을 변경합니다.'
        : '이름·담당 업무·직원 유형과 첫 세션을 한 번에 설정합니다.',
      '<button type="button" class="secondary" data-employee-cancel>목록으로 돌아가기</button>'
    ) +
    `<form data-form="${form}" ${editing ? `data-session="${escapeHtml(session?.id)}" data-revision="${escapeHtml(session?.revision)}"` : ''} class="employee-editor-form"><div class="session-create-layout"><div class="session-editor-stack"><section class="panel session-step"><div class="session-step-head"><span class="step-number">01</span><h2>${editing ? '현재 세션 기본 정보' : 'AI 직원과 첫 세션'}</h2><span class="badge">${editing ? '편집' : '새로 만들기'}</span></div><div class="session-step-body">${editing ? `<div class="notice">AI 직원: ${escapeHtml(employee?.name)} · 현재 세션의 설정만 변경합니다.</div><p class="hint">세션 표시명: ${escapeHtml(session?.label)}</p>` : `<div class="form-grid">${field('AI 이름', 'name', '', true)}${field('담당 업무', 'responsibility', '', true)}<label>${fieldLabel('직원 유형', true)}<select name="role" required><option value="worker">작업 AI</option><option value="manager">관리 AI</option></select></label>${field('세션 표시명(선택)', 'label')}${field('작업 위치', 'cwd', String(data.workspaceRoot || ''), true)}</div><p class="hint">담당 업무는 전문 분야·업무 범위(예: 백엔드 개발, QA)입니다. 직원 유형은 관리 AI(업무 분배·결과 검토)와 작업 AI(배정된 작업 수행)를 구분합니다.</p><p class="hint">조직 배치는 저장 후 ‘조직·직원’에서 진행합니다.</p>`}</div></section><section class="panel session-step"><div class="session-step-head"><span class="step-number">02</span><h2>모델 선택</h2></div><div class="session-step-body">${modelField(String(session?.model || 'gpt-6.1-sol'))}<p class="hint">모델 변경은 다음 실행부터 적용됩니다.</p></div></section><section class="panel session-step"><div class="session-step-head"><span class="step-number">03</span><h2>기본 페르소나</h2></div><div class="session-step-body">${editing ? '' : `<label>템플릿<select name="personaTemplate"><option value="">선택하지 않음</option><optgroup label="기본 제공">${builtInPersonas.map((x) => `<option value="builtin:${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('')}</optgroup><optgroup label="등록된 템플릿">${options(values('personas'), (x) => x.name)}</optgroup></select></label>`}<label>${fieldLabel('역할·행동 지침', !editing)}<textarea name="persona" rows="6" ${editing ? '' : 'required'}>${escapeHtml(session?.persona || '')}</textarea></label><div class="session-register-cta"><span>목록에 없다면 페르소나 템플릿을 등록할 수 있습니다.</span><button type="button" class="secondary small" data-nav="personas">템플릿 등록</button></div></div></section><section class="panel session-step"><div class="session-step-head"><span class="step-number">04</span><h2>기본 스킬 선택</h2><span class="badge">${selectedSkills.length}건 선택</span></div><div class="session-step-body"><p class="hint">등록된 스킬에서 선택해 주세요.</p><div class="session-skills-grid">${skills.map((x) => `<label class="session-skill-option"><input type="checkbox" name="skillIds" value="${escapeHtml(x.id)}" ${skillIds.includes(x.id) ? 'checked' : ''}><span><strong>${escapeHtml(x.name)}</strong><small>${short(x.description)}</small></span></label>`).join('') || '<span class="hint">등록된 스킬이 없습니다.</span>'}</div><div class="session-register-cta"><span>목록에 없는 스킬은 ‘스킬 등록’에서 만들 수 있습니다.</span><button type="button" class="secondary small" data-nav="skills">스킬 등록</button></div></div></section></div><aside class="panel session-preview"><div class="session-step-head"><h2>설정 미리보기</h2><span class="badge">실제 운영</span></div><div class="session-step-body" id="employee-preview"></div><div class="session-preview-note">페르소나나 스킬 선택만으로 도구 권한이 늘어나지 않습니다.</div></aside></div><div class="session-save-bar"><div><strong>${editing ? '변경은 현재 세션에만 적용합니다.' : 'AI 직원과 첫 세션을 함께 생성합니다.'}</strong><p>${editing ? '기존 대화와 세션 ID는 유지됩니다.' : '저장하면 실제 세션 준비가 요청됩니다.'}</p></div><div class="session-save-actions"><button type="button" class="secondary" data-employee-cancel>취소</button><button class="primary" type="submit">${editing ? '세션 설정 저장' : 'AI 직원 생성'}</button></div></div></form>`
  );
}
function updateEmployeePreview() {
  const form = document.querySelector<HTMLFormElement>('.employee-editor-form');
  const preview = document.querySelector<HTMLElement>('#employee-preview');
  if (!form || !preview) return;
  const fd = new FormData(form);
  const selected = fd
    .getAll('skillIds')
    .map((id) => lookup('skills', id)?.name || id);
  const session =
    employeeEditor?.mode === 'edit'
      ? lookup('sessions', employeeEditor.sessionId)
      : undefined;
  preview.innerHTML = `<dl><dt>AI 직원</dt><dd>${escapeHtml(fd.get('name') || lookup('employees', session?.employee_id)?.name || '이름 미입력')}</dd><dt>모델</dt><dd>${escapeHtml(fd.get('model') || '미선택')}</dd><dt>페르소나</dt><dd>${short(fd.get('persona') || '미입력')}</dd><dt>기본 스킬</dt><dd>${selected.length ? selected.map((name) => escapeHtml(name)).join(', ') : '미선택'}</dd></dl>`;
  const policy = data.aiPolicy as RecordItem;
  const individual = fd.getAll('skillIds').map(String);
  const common: string[] = policy?.skillIds || [];
  preview.innerHTML += `<h3>다음 Run 적용 스킬 · 공통 정책 v${policy?.revision || 1}</h3><div class="schedule-tags">${policyTags([...new Set([...common, ...individual])], common)}</div><p class="hint">공통 스킬은 이 개별 설정에서 해제할 수 없습니다. ‘AI 정책’에서 변경합니다.</p>`;
}
function organizations() {
  const rows = values('organizations').map((o) => {
    const staff = values('employees').filter((e) => e.org_id === o.id);
    return `<tr><td>${escapeHtml(o.name)}</td><td>${staff.filter((e) => e.role === 'manager').length}</td><td>${staff.filter((e) => e.role === 'worker').length}</td><td>${staff.length}</td><td><button class="secondary small" data-org="${escapeHtml(o.id)}">조직도 보기</button></td></tr>`;
  });
  return (
    head(
      '조직·직원',
      '조직과 호출 권한을 확인하고, AI 세션에서 직원을 배치합니다.',
      '<button class="primary" data-show="org-create">조직 생성</button>'
    ) +
    `<div class="notice org-guide">${icon('users')}<span>조직을 열면 조직도를 볼 수 있습니다. ‘AI 직원 추가’에서는 AI 직원 화면에서 생성한 미배치 AI만 선택합니다. 모델·페르소나·스킬도 ‘AI 직원’에서 관리합니다.</span></div><section class="panel"><h2>조직 목록</h2>${table(['조직 이름', '관리 AI', '작업 AI', '직원 수', '조직도'], rows)}</section>`
  );
}
function orders() {
  const workOrders = values('workOrders');
  const reports = workOrders.filter((order) => Boolean(order.report));
  const pending = workOrders.filter((order) =>
    ['queued', 'paused'].includes(String(order.status))
  ).length;
  const tabs = `<div class="work-order-tabs" role="tablist" aria-label="업무 지시 보기"><button type="button" role="tab" aria-selected="${workOrderTab === 'orders'}" class="${workOrderTab === 'orders' ? 'active' : ''}" data-order-tab="orders">지시 목록</button><button type="button" role="tab" aria-selected="${workOrderTab === 'reports'}" class="${workOrderTab === 'reports' ? 'active' : ''}" data-order-tab="reports">결과 보고서 <span class="badge">${reports.length}</span></button></div>`;
  const rows = workOrders
    .map(
      (order) =>
        `<tr><td><button type="button" class="work-order-title" data-order="${escapeHtml(order.id)}">${escapeHtml(order.title)}</button><p class="task-meta">${escapeHtml(order.id)} · ${date(order.created_at)}</p></td><td>${escapeHtml(lookup('employees', order.manager_id)?.name || '미설정')}</td><td>${badge(order.status)}</td><td>${values('tasks').filter((task) => task.work_order_id === order.id).length}건</td><td>${order.report ? `<button type="button" class="secondary small" data-order="${escapeHtml(order.id)}">보고서 보기</button>` : '<span class="hint">미제출</span>'}</td></tr>`
    )
    .join('');
  const orderList = `<div class="table-wrap"><table aria-label="업무 지시 목록"><thead><tr><th scope="col">업무 지시</th><th scope="col">담당 관리 AI</th><th scope="col">상태</th><th scope="col">관련 Task</th><th scope="col">결과 보고</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty">아직 업무 지시가 없습니다.</td></tr>'}</tbody></table></div>`;
  const reportCards = `<div class="work-order-reports">${reports.map((order) => `<article class="work-order-report"><span class="badge ok">결과 보고 · ${escapeHtml(order.id)}</span><h3>${escapeHtml(order.title)}</h3><p>${escapeHtml(String(order.report).slice(0, 180) + (String(order.report).length > 180 ? '…' : ''))}</p><div class="form-actions"><button type="button" class="secondary small" data-order="${escapeHtml(order.id)}">보고서 열기</button></div></article>`).join('') || '<div class="empty">아직 결과 보고서가 없습니다.</div>'}</div>`;
  return (
    head(
      '업무 지시',
      '관리 AI에게 업무를 지시하고 접수 상태와 결과 보고를 확인합니다.',
      '<button type="button" class="primary" data-order-create>업무 지시 생성</button>'
    ) +
    `<div class="work-order-summary"><div class="panel"><span>업무 지시</span><strong>${workOrders.length}건</strong></div><div class="panel"><span>접수 대기·보류</span><strong>${pending}건</strong></div><div class="panel"><span>결과 보고서</span><strong>${reports.length}건</strong></div></div><section class="panel work-order-panel">${tabs}${workOrderTab === 'reports' ? reportCards : orderList}</section><div class="notice work-order-notice">${icon('shield')} 업무 지시는 관리 AI 수신함에 기록됩니다. Task와 결과 보고는 관리 AI가 별도로 처리합니다.</div>`
  );
}
function taskDisplayStatus(task: RecordItem): string {
  if (['reviewing', 'completed', 'cancelled'].includes(String(task.status)))
    return String(task.status);
  const job = values('jobs')
    .filter((x) => x.kind === 'task' && x.ref_id === task.id)
    .sort((a, b) => Number(b.created_at) - Number(a.created_at))[0];
  return job && ['running', 'cooldown'].includes(String(job.status))
    ? String(job.status)
    : String(task.status);
}
function taskCompletion(
  task: RecordItem
): { checked: number; total: number; percent: number } | null {
  let criteria: RecordItem[];
  try {
    criteria = JSON.parse(String(task.criteria_json || '[]'));
  } catch {
    return null;
  }
  if (
    !Array.isArray(criteria) ||
    !criteria.length ||
    criteria.some(
      (c) => !Number.isFinite(Number(c.weight)) || Number(c.weight) <= 0
    )
  )
    return null;
  const total = criteria.reduce((n, c) => n + Number(c.weight), 0);
  const checked = criteria.filter(
    (c) => c.verified && typeof c.evidence === 'string' && c.evidence.trim()
  ).length;
  const verified = criteria
    .filter(
      (c) => c.verified && typeof c.evidence === 'string' && c.evidence.trim()
    )
    .reduce((n, c) => n + Number(c.weight), 0);
  return {
    checked,
    total: criteria.length,
    percent: Math.round((verified / total) * 100),
  };
}
function tasks() {
  const all = values('tasks');
  const search = taskQuery.trim().toLocaleLowerCase('ko-KR');
  const filtered = all.filter(
    (task) =>
      (taskFilter === 'all' || taskDisplayStatus(task) === taskFilter) &&
      `${task.title} ${task.id} ${lookup('employees', task.worker_id)?.name || ''}`
        .toLocaleLowerCase('ko-KR')
        .includes(search)
  );
  const filters = `<div class="filters">${[
    ['all', '모두'],
    ['running', '진행 중'],
    ['reviewing', '검토 대기'],
    ['cooldown', '재개 대기'],
    ['completed', '완료'],
  ]
    .map(
      ([status, label]) =>
        `<button type="button" class="filter ${taskFilter === status ? 'active' : ''}" data-task-filter="${status}">${label}<span class="filter-count">${all.filter((task) => status === 'all' || taskDisplayStatus(task) === status).length}</span></button>`
    )
    .join(
      ''
    )}<form data-form="task-search" class="filter-search"><label class="sr-only" for="task-query">Task 검색</label><input id="task-query" name="query" type="search" value="${escapeHtml(taskQuery)}" placeholder="Task 이름·ID·담당자로 검색"><button class="secondary small" type="submit">검색</button></form></div>`;
  const processes = values('workProcesses')
    .map((process) => {
      const cycles = values('workCycles').filter(
        (c) => c.process_id === process.id
      );
      const done = cycles.filter((c) => c.outcome === 'done').length,
        missed = cycles.filter((c) => c.outcome === 'missed').length;
      const derivedIds = new Set<string>();
      for (const cycle of cycles) {
        try {
          const ids = JSON.parse(String(cycle.derived_task_ids || '[]'));
          if (Array.isArray(ids))
            ids.forEach((id) => derivedIds.add(String(id)));
        } catch {}
      }
      const unresolved = all.filter(
        (task) =>
          derivedIds.has(String(task.id)) &&
          !['completed', 'cancelled'].includes(String(task.status))
      ).length;
      return `<article class="process-card"><div class="process-card-top"><span class="code">${escapeHtml(process.id)}</span>${badge(process.status)}</div><h3>${escapeHtml(process.title)}</h3><p>${escapeHtml(process.cron)} · ${escapeHtml(process.timezone)}</p><div class="process-metrics"><div><small>기한이 도래한 실행 회차</small><strong>수행 ${done} / ${cycles.length}</strong></div><div><small>미수행</small><strong>${missed}회</strong></div><div><small>파생 업무</small><strong>미해결 Task ${unresolved}건</strong></div></div><div class="process-card-foot"><span>전체 진행률 없음</span><button type="button" class="secondary small" data-process="${escapeHtml(process.id)}">실행 이력과 Task 보기</button></div></article>`;
    })
    .join('');
  const rows = filtered
    .map((task) => {
      const completion = taskCompletion(task),
        status = taskDisplayStatus(task);
      return `<tr><td><button type="button" class="task-name" data-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button><p class="task-meta">${escapeHtml(task.id)} · ${date(task.updated_at)}</p></td><td><span class="table-person"><span class="employee-avatar">${escapeHtml(String(lookup('employees', task.worker_id)?.name || 'AI').slice(0, 1))}</span>${escapeHtml(lookup('employees', task.worker_id)?.name || '미배정')}</span></td><td>${badge(status)}</td><td>${completion ? `<div class="criteria-table-progress"><div class="progress"><span style="width:${completion.percent}%"></span></div><span class="progress-label">${completion.checked}/${completion.total} · ${completion.percent}%</span></div><small class="criteria-source">완료 조건으로 계산</small>` : '<span class="badge warn">기준 미설정</span>'}</td><td><span class="schedule-tag">System MCP</span></td><td><button type="button" class="secondary small" data-task="${escapeHtml(task.id)}" aria-label="${escapeHtml(task.title)} 상세 보기">상세</button></td></tr>`;
    })
    .join('');
  return (
    head(
      'Task 이력',
      'Task와 완료 조건을 확인합니다. 유한 Task는 완료 조건으로, 지속 업무는 실행 회차와 파생 Task로 확인합니다.',
      '<button type="button" class="secondary" data-nav="orders">업무 지시 보기</button>'
    ) +
    `<div class="notice">완료 조건 수치는 확인된 근거와 가중치로 계산합니다. 기준이 없는 Task의 진행률은 표시하지 않습니다.</div><section class="panel process-section"><div class="process-section-head"><div><h2>지속 업무·정기 점검</h2><p class="panel-sub">기한이 도래한 회차·미수행·파생 Task를 확인합니다.</p></div><span class="badge">읽기 전용</span></div><div class="process-grid">${processes || '<p class="empty">정기 점검 기록이 없습니다.</p>'}</div></section>${filters}<section class="panel task-list-panel"><div class="table-wrap"><table aria-label="Task 목록"><thead><tr><th scope="col">Task</th><th scope="col">담당 직원</th><th scope="col">상태</th><th scope="col">완료 조건</th><th scope="col">실행 경로</th><th scope="col">상세</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">조건에 맞는 Task가 없습니다.</td></tr>'}</tbody></table></div><div class="task-list-footer"><span>${filtered.length}건의 Task · 실제 기록</span><span>기준이 없으면 ‘기준 미설정’</span></div></section><div class="notice task-readonly-notice">${icon('database')} 읽기 전용입니다. 사람의 의뢰는 ‘업무 지시’에서 하고 Task 분해와 기록은 관리 AI가 담당합니다.</div>`
  );
}
function logs() {
  const allLogs = values('workLogs');
  const taskIds = [
    ...new Set(
      allLogs
        .filter(
          (l) =>
            workLogEmployeeFilter === 'all' ||
            l.author_id === workLogEmployeeFilter
        )
        .map((l) => String(l.task_id))
    ),
  ];
  const filtered = allLogs
    .filter(
      (l) =>
        (workLogEmployeeFilter === 'all' ||
          l.author_id === workLogEmployeeFilter) &&
        (workLogTaskFilter === 'all' || l.task_id === workLogTaskFilter)
    )
    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
  const filters = `<div class="work-log-filters"><label class="field">기록한 AI<select id="work-log-employee-filter"><option value="all">모든 AI 직원</option>${values(
    'employees'
  )
    .map(
      (e) =>
        `<option value="${escapeHtml(e.id)}" ${workLogEmployeeFilter === e.id ? 'selected' : ''}>${escapeHtml(e.name)} · ${e.role === 'manager' ? '관리 AI' : '실무 AI'}</option>`
    )
    .join(
      ''
    )}</select></label><label class="field">관련 Task<select id="work-log-task-filter"><option value="all">모든 Task</option>${taskIds
    .map((id) => {
      const task = lookup('tasks', id);
      return `<option value="${escapeHtml(id)}" ${workLogTaskFilter === id ? 'selected' : ''}>${escapeHtml(id)} · ${escapeHtml(task?.title || 'Task 미등록')}</option>`;
    })
    .join('')}</select></label></div>`;
  const rows =
    filtered
      .map((l) => {
        const author = lookup('employees', l.author_id),
          task = lookup('tasks', l.task_id);
        return `<tr><td><button type="button" class="work-order-title code" data-log="${escapeHtml(l.id)}">${escapeHtml(l.id)}</button></td><td>${escapeHtml(author?.name || '직원 미등록')}<p class="task-meta">${author?.role === 'manager' ? '관리 AI' : '실무 AI'}</p></td><td>${task ? `<button type="button" class="work-order-title" data-task="${escapeHtml(task.id)}">${escapeHtml(task.id)}</button><p class="task-meta">${escapeHtml(task.title)}</p>` : `<span class="hint">${escapeHtml(l.task_id)} · Task 미등록</span>`}</td><td><button type="button" class="work-log-open" data-log="${escapeHtml(l.id)}" aria-label="${escapeHtml(l.id)}의 업무 메모 전문 보기"><span class="work-log-summary">${escapeHtml(l.summary)}</span><span class="work-log-open-label">메모 전문 보기 →</span></button></td><td class="nowrap">${date(l.created_at)}</td></tr>`;
      })
      .join('') ||
    '<tr><td colspan="5" class="empty">조건에 맞는 업무 일지가 없습니다.</td></tr>';
  return (
    head(
      '업무 일지',
      '각 AI 직원이 문맥 한도에 대비해 자기 Task 진행 상황과 재개 사항을 남기는 기록입니다.',
      ''
    ) +
    `<div class="notice">AI 직원 본인이 작업 중 남기는 업무 메모입니다. 다른 AI에게 넘기는 기록이 아니라 다음 실행에서 같은 직원이 이어서 작업할 때 참고합니다.</div>${filters}<section class="panel work-log-panel"><div class="table-wrap"><table class="work-log-table" aria-label="업무 일지 목록"><thead><tr><th scope="col">기록 ID</th><th scope="col">기록한 AI</th><th scope="col">관련 Task</th><th scope="col">업무 메모</th><th scope="col">기록 시각</th></tr></thead><tbody>${rows}</tbody></table></div><div class="work-log-footer"><span>${filtered.length}건의 업무 일지 · 실제 기록</span><span>읽기 전용</span></div></section><div class="notice work-log-hint">${icon('database')} 사람은 업무 일지를 열람하고 필터링할 수 있습니다. 기록은 AI 직원의 작업 과정에서 저장됩니다.</div>`
  );
}
function conversations() {
  const sessions = [...values('sessions')].sort(
    (a, b) =>
      Number(b.is_current === 1) - Number(a.is_current === 1) ||
      Number(b.created_at) - Number(a.created_at)
  );
  if (!sessions.length)
    return (
      head(
        '세션 대화',
        '먼저 AI 직원을 생성해 주세요.',
        '<button type="button" class="primary" data-nav="employees">AI 직원 보기</button>'
      ) + '<section class="panel empty">아직 세션이 없습니다.</section>'
    );
  if (!sessions.some((s) => s.id === selectedConversationSession))
    selectedConversationSession = String(sessions[0].id);
  const current = lookup('sessions', selectedConversationSession);
  const action =
    current?.is_current === 1
      ? `<button type="button" class="secondary" data-config="${escapeHtml(current.id)}">현재 세션 설정</button>`
      : '<button type="button" class="secondary" data-nav="employees">AI 직원 목록으로</button>';
  const navigation = sessions
    .map((s) => {
      const employee = lookup('employees', s.employee_id);
      return `<button type="button" class="session-item ${s.id === selectedConversationSession ? 'active' : ''}" data-conversation-select="${escapeHtml(s.id)}" aria-current="${s.id === selectedConversationSession ? 'true' : 'false'}"><span class="session-item-avatar">${escapeHtml(String(employee?.name || 'AI').slice(0, 1))}</span><span class="session-item-label"><strong>${escapeHtml(s.label || '이름 없음')}</strong><small>${escapeHtml(employee?.name || '직원 미등록')} · ${escapeHtml(s.model)}${s.is_current === 1 ? '' : ' · 이력'}</small></span></button>`;
    })
    .join('');
  return (
    head(
      '세션 대화',
      '대화가 쌓이는 공간입니다. 현재 세션과 이전 대화 이력을 확인할 수 있습니다.',
      action
    ) +
    `<section class="panel session-layout"><aside class="session-list" aria-label="AI 세션 목록"><div class="session-list-heading">AI 세션 · ${sessions.length}</div>${navigation}</aside><div class="conversation" id="conversation-content"><div class="empty">대화 기록을 불러오는 중입니다.</div></div></section>`
  );
}
async function loadConversation(sessionId: string, cursor = 0) {
  const request = ++conversationRequest;
  try {
    const result = await api(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?cursor=${cursor}`
    );
    if (
      request !== conversationRequest ||
      page !== 'conversations' ||
      selectedConversationSession !== sessionId
    )
      return;
    const session = result.session as RecordItem,
      employee = lookup('employees', session.employee_id),
      events = result.events as RecordItem[];
    conversationEvents = cursor ? conversationEvents.concat(events) : events;
    const archived = session.is_current !== 1;
    const messages =
      conversationEvents
        .map((event) => {
          const kind = String(event.kind),
            isUser = kind === 'user',
            isAssistant = kind === 'assistant',
            label = isUser
              ? '나'
              : isAssistant
                ? employee?.name || 'AI 직원'
                : kind === 'tool'
                  ? '도구 이벤트'
                  : kind === 'usage'
                    ? '사용량'
                    : '실행 이벤트';
          return `<div class="message ${isUser ? 'user' : isAssistant ? '' : 'system'}"><span class="message-avatar">${isUser ? '나' : isAssistant ? escapeHtml(String(employee?.name || 'AI').slice(0, 1)) : '·'}</span><div class="message-body"><div class="message-name">${escapeHtml(label)}<time>${date(event.created_at)}</time></div><div class="bubble">${escapeHtml(event.content)}</div>${event.source && event.source !== 'runner' ? `<small class="message-source">출처: ${escapeHtml(event.source)}</small>` : ''}</div></div>`;
        })
        .join('') ||
      '<div class="empty">수집된 공개 대화 이벤트가 없습니다.</div>';
    const skillNames = sessionSkillNames(session);
    const content = document.querySelector<HTMLElement>(
      '#conversation-content'
    );
    if (!content) return;
    content.innerHTML = `<div class="conversation-header"><span class="session-item-avatar">${escapeHtml(String(employee?.name || 'AI').slice(0, 1))}</span><div class="conversation-identity"><h2>${escapeHtml(employee?.name || '직원 미등록')} <span>/ ${escapeHtml(session.label || '이름 없음')}</span></h2><p class="code">${escapeHtml(session.codex_id || session.id)} · ${escapeHtml(session.model)}</p></div><span class="badge ${archived ? '' : 'ok'}">${archived ? '이력 · 읽기 전용' : '현재 · 읽기 전용'}</span></div><div class="chat-thread" id="chat-thread">${messages}</div><div class="chat-context">${sessionPolicyNote(session)}${icon('database')} 설정 v${escapeHtml(session.revision || 1)} · ${escapeHtml(session.persona || '페르소나 미설정')}${skillNames.length ? `<div class="session-context-skills">${skillNames.map((name) => `<span class="schedule-tag">${escapeHtml(name)}</span>`).join('')}</div>` : ''}</div><div class="conversation-actions"><button type="button" class="secondary small" data-reindex="${escapeHtml(sessionId)}">Codex 로그 재색인</button>${events.length === 100 ? `<button type="button" class="secondary small" data-conversation-next="${escapeHtml(sessionId)}" data-cursor="${events[events.length - 1].id}">다음 기록 더 보기</button>` : ''}</div><div class="conversation-readonly">실제 공개 이벤트만 표시합니다. 비공개 추론과 미수집 대화는 표시되지 않으며, 메시지 입력은 지원하지 않습니다.</div>`;
  } catch (error) {
    if (
      request !== conversationRequest ||
      page !== 'conversations' ||
      selectedConversationSession !== sessionId
    )
      return;
    const content = document.querySelector<HTMLElement>(
      '#conversation-content'
    );
    if (content)
      content.innerHTML = `<div class="empty">대화 기록을 불러오지 못했습니다. ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}
function interviews() {
  const employees = values('employees');
  if (!employees.length)
    return (
      head(
        '1:1 면담',
        '면담을 시작하려면 먼저 AI 직원을 생성해 주세요.',
        '<button type="button" class="primary" data-nav="employees">AI 직원 보기</button>'
      ) + '<section class="panel empty">면담할 AI 직원이 없습니다.</section>'
    );
  const records = [...values('interviews')].sort(
    (a, b) => Number(b.created_at) - Number(a.created_at)
  );
  if (!records.some((i) => i.id === selectedInterviewId))
    selectedInterviewId = records.length ? String(records[0].id) : '';
  const navigation = records
    .map((i) => {
      const employee = lookup('employees', i.employee_id);
      return `<button type="button" class="session-item ${i.id === selectedInterviewId ? 'active' : ''}" data-interview-select="${escapeHtml(i.id)}" aria-current="${i.id === selectedInterviewId ? 'true' : 'false'}"><span class="session-item-avatar">${escapeHtml(String(employee?.name || 'AI').slice(0, 1))}</span><span class="session-item-label"><strong>${escapeHtml(employee?.name || '직원 미등록')}</strong><small>${escapeHtml(i.topic)} · ${date(i.created_at)}</small></span></button>`;
    })
    .join('');
  const actions = `<div class="row-actions"><button type="button" class="primary" data-interview-create>새 면담 시작</button>${selectedInterviewId ? '<button type="button" class="secondary" data-nav="orders">후속 업무 지시로 이동</button>' : ''}</div>`;
  return (
    head(
      '1:1 면담',
      '업무를 넘어 대화로. 관리 AI와 실무 AI 모두와 업무와 별도로 1:1 면담을 할 수 있습니다.',
      actions
    ) +
    `<div class="notice interview-note"><span>면담 내용은 다른 직원에게 자동 공유되지 않습니다. 합의한 업무는 ‘업무 지시’에서 관리 AI에게 의뢰해 주세요.</span><span class="badge">1:1 전용 세션</span></div><section class="panel session-layout"><aside class="session-list" aria-label="면담 목록"><div class="session-list-heading">1:1 면담 · ${records.length}</div>${navigation || '<p class="empty">아직 면담 기록이 없습니다.</p>'}</aside><div class="conversation" id="interview-content"><div class="empty">${selectedInterviewId ? '면담 기록을 불러오는 중입니다.' : '새 면담을 시작해 주세요.'}</div></div></section>`
  );
}
async function loadInterview(interviewId: string, cursor = 0) {
  const request = ++interviewRequest;
  const interview = lookup('interviews', interviewId);
  if (!interview) return;
  try {
    const result = await api(
      `/api/sessions/${encodeURIComponent(interview.session_id)}/events?cursor=${cursor}`
    );
    if (
      request !== interviewRequest ||
      page !== 'interviews' ||
      selectedInterviewId !== interviewId
    )
      return;
    const events = result.events as RecordItem[],
      employee = lookup('employees', interview.employee_id),
      session = result.session as RecordItem;
    interviewEvents = cursor ? interviewEvents.concat(events) : events;
    const messages =
      interviewEvents
        .map((event) => {
          const kind = String(event.kind),
            isUser = kind === 'user',
            isAssistant = kind === 'assistant';
          return `<div class="message ${isUser ? 'user' : isAssistant ? '' : 'system'}"><span class="message-avatar">${isUser ? '나' : isAssistant ? escapeHtml(String(employee?.name || 'AI').slice(0, 1)) : '·'}</span><div class="message-body"><div class="message-name">${escapeHtml(isUser ? '나' : isAssistant ? employee?.name || 'AI 직원' : kind === 'tool' ? '도구 이벤트' : '실행 이벤트')}<time>${date(event.created_at)}</time></div><div class="bubble">${escapeHtml(event.content)}</div></div></div>`;
        })
        .join('') ||
      '<div class="empty">아직 수집된 면담 메시지가 없습니다.</div>';
    const content = document.querySelector<HTMLElement>('#interview-content');
    if (!content) return;
    content.innerHTML = `<div class="conversation-header"><span class="session-item-avatar">${escapeHtml(String(employee?.name || 'AI').slice(0, 1))}</span><div class="conversation-identity"><h2>${escapeHtml(employee?.name || '직원 미등록')} <span>/ 1:1 면담</span></h2><p>${escapeHtml(interview.topic)} · ${escapeHtml(session.codex_id || '세션 초기화 중')} · ${escapeHtml(session.model)}</p></div><span class="badge">비공유</span></div><div class="chat-thread" id="interview-thread">${messages}</div><div class="chat-context">${icon('shield')} 업무 세션과 별도로 저장 · 업무용 MCP 비활성 · 읽기 전용 실행${sessionPolicyNote(session, interview.status === 'open')}${interview.status === 'open' ? `<div class="schedule-tags">${policyTags([...new Set([...(data.aiPolicy as RecordItem).skillIds, ...policySkillIds(session)])], (data.aiPolicy as RecordItem).skillIds)}</div>` : ''}</div>${events.length === 100 ? `<div class="conversation-actions"><button type="button" class="secondary small" data-interview-next="${escapeHtml(interviewId)}" data-cursor="${events[events.length - 1].id}">다음 기록 더 보기</button></div>` : ''}${interview.status === 'open' ? `<div class="chat-compose"><form data-form="interview-message" data-interview="${escapeHtml(interviewId)}"><label class="sr-only" for="interview-message-body">면담 메시지</label><textarea id="interview-message-body" name="body" required maxlength="10000" placeholder="이번 주 목표나 상담할 내용을 입력해 주세요."></textarea><button type="submit" class="primary" aria-label="면담 메시지 보내기">전송</button></form><small>메시지를 보내면 실제 면담 세션에 저장되고 AI 응답이 비동기로 실행됩니다.</small></div>` : '<div class="conversation-readonly">종료된 면담은 읽기 전용입니다.</div>'}`;
  } catch (error) {
    if (
      request !== interviewRequest ||
      page !== 'interviews' ||
      selectedInterviewId !== interviewId
    )
      return;
    const content = document.querySelector<HTMLElement>('#interview-content');
    if (content)
      content.innerHTML = `<div class="empty">면담 기록을 불러오지 못했습니다. ${escapeHtml(error instanceof Error ? error.message : String(error))}</div>`;
  }
}
function schedules() {
  const managers = values('employees').filter((x) => x.role === 'manager');
  const cards = managers
    .map((employee) => {
      const schedule = values('schedules').find(
        (x) => x.manager_id === employee.id
      );
      const session = values('sessions').find(
        (x) => x.employee_id === employee.id && x.is_current === 1
      );
      let skillIds: string[] = [];
      try {
        const parsed = JSON.parse(String(session?.skill_ids || '[]'));
        if (Array.isArray(parsed)) skillIds = parsed;
      } catch {}
      const skillNames = skillIds
        .map((id) => lookup('skills', id)?.name)
        .filter(Boolean);
      return `<section class="panel schedule-card"><div class="schedule-card-body"><div class="schedule-top"><span class="schedule-avatar">${escapeHtml(String(employee.name || 'AI').slice(0, 1))}</span><div class="schedule-person"><strong>${escapeHtml(employee.name)}</strong><p>${employee.role === 'manager' ? '관리 AI' : '작업 AI'} · ${escapeHtml(lookup('organizations', employee.org_id)?.name || '소속 미배정')}</p></div><label class="schedule-switch"><input type="checkbox" data-schedule-toggle="${escapeHtml(employee.id)}" aria-label="${escapeHtml(employee.name)} 일정 활성화" ${schedule?.enabled ? 'checked' : ''} ${schedule ? '' : 'disabled'}><span></span></label></div><div class="schedule-cron"><code>${escapeHtml(schedule?.cron || '일정 미설정')}</code><span class="badge ${schedule?.enabled ? 'ok' : 'warn'}">${schedule ? (schedule.enabled ? '예약 활성' : '일시 중지') : '설정 필요'}</span></div><div class="schedule-meta"><div>시간대<strong>${escapeHtml(schedule?.timezone || '—')}</strong></div><div>최근 설정<strong>${schedule ? date(schedule.updated_at) : '설정 이력 없음'}</strong></div></div><div class="section-label">기본 업무 프롬프트</div><div class="prompt-box">${escapeHtml(schedule?.prompt || '일정을 편집해 기본 업무를 설정하세요.')}</div><div class="section-label">업무 세션의 스킬 · 참고</div><div class="schedule-tags">${skillNames.length ? skillNames.map((name) => `<span class="schedule-tag">${escapeHtml(name)}</span>`).join('') : '<span class="hint">등록된 기본 스킬이 없습니다.</span>'}</div><div class="schedule-actions"><button type="button" class="secondary" data-edit-schedule="${escapeHtml(employee.id)}">${icon('settings')} 일정 편집</button><button type="button" class="primary" data-wake="${escapeHtml(employee.id)}">${icon('bolt')} 지금 실행</button></div></div></section>`;
    })
    .join('');
  const recent = values('jobs')
    .filter((x) => x.kind === 'manager')
    .sort((a, b) => Number(b.created_at) - Number(a.created_at))
    .slice(0, 5);
  return (
    head(
      '관리 AI 일정',
      '정해진 시각에 필요한 일만 실행합니다. 관리 AI의 시작 간격과 기본 업무를 설정하고 실제 실행 이력을 확인할 수 있습니다.'
    ) +
    `<div class="schedule-grid">${cards || '<div class="panel empty">관리 AI를 등록하면 일정 카드가 표시됩니다.</div>'}</div><div class="notice schedule-notice">${icon('clock')} 예약을 활성화하면 서버 스케줄러가 실제로 관리 AI 실행을 요청합니다. ‘지금 실행’도 실제 실행 요청입니다.</div><section class="panel schedule-history"><div class="panel-head"><h2>최근 시작 이력</h2><span class="panel-meta">실제 관리 AI 실행</span></div><div class="audit-list">${recent.map((job) => `<div class="audit-row">${icon('clock')}<div><strong>${escapeHtml(lookup('employees', job.employee_id)?.name || '관리 AI')} · ${escapeHtml(statusLabels[String(job.status)] || job.status)}</strong><p>${escapeHtml(job.kind)} · 시도 ${escapeHtml(job.attempt ?? 0)}회</p></div><time>${date(job.created_at)}</time></div>`).join('') || '<div class="empty">관리 AI 실행 이력이 없습니다.</div>'}</div></section>`
  );
}
function recovery() {
  return (
    head(
      '복구 센터',
      '강제 종료와 상태 불명을 구분합니다. 자동 재개는 .env에서 명시적으로 허용한 종료 코드에만 적용됩니다.'
    ) +
    notice(
      '원인 또는 외부 부작용을 알 수 없는 실행은 재실행하지 않습니다. 이전 프로세스 확인과 운영 판단이 필요합니다.'
    ) +
    `<section class="panel"><h2>Job / Run 상태</h2>${table(
      ['직원', '유형', '상태', '시도', '다음 실행 가능', '작업'],
      values('jobs').map(
        (j) =>
          `<tr><td>${escapeHtml(lookup('employees', j.employee_id)?.name)}</td><td>${escapeHtml(j.kind)}</td><td>${badge(j.status)}</td><td>${escapeHtml(j.attempt)}</td><td>${j.status === 'cooldown' ? date(j.due_at) : '—'}</td><td><button class="secondary small" data-job="${escapeHtml(j.id)}">상세</button></td></tr>`
      )
    )}</section>`
  );
}
function skillContent(name: string, description: string, body: string) {
  return `---\nname: ${name.trim()}\ndescription: ${description.trim()}\n---\n${body.trim()}\n`;
}
function parseSkillContent(raw: string) {
  const content = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (new TextEncoder().encode(content).length > 32768)
    throw new Error('SKILL.md는 32 KiB 이하여야 합니다.');
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match)
    throw new Error('SKILL.md의 name·description frontmatter를 확인하세요.');
  const fields = new Map<string, string>();
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z]+):\s*(.+)$/);
    if (
      !field ||
      !['name', 'description'].includes(field[1]) ||
      fields.has(field[1])
    )
      throw new Error(
        'frontmatter에는 중복 없는 name·description만 사용할 수 있습니다.'
      );
    fields.set(field[1], field[2].trim());
  }
  const name = fields.get('name') || '',
    description = fields.get('description') || '',
    body = match[2].trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name))
    throw new Error(
      'name은 영문 소문자로 시작하는 64자 이내의 영문 소문자·숫자·하이픈이어야 합니다.'
    );
  if (!description || description.length > 500)
    throw new Error('description은 500자 이내로 작성하세요.');
  if (!body) throw new Error('스킬 본문을 작성하세요.');
  return {
    name,
    description,
    body,
    content: skillContent(name, description, body),
  };
}
function skills() {
  const direct = skillMode === 'direct',
    registered = values('skills');
  const fields = direct
    ? `<div class="form-grid"><label class="full">name<input name="name" type="text" maxlength="64" value="${escapeHtml(skillDraft.name)}" placeholder="예: architecture-notes" required><small>영문 소문자·숫자·하이픈, 64자 이내</small></label><label class="full">description<textarea name="description" rows="3" maxlength="500" required placeholder="이 스킬을 사용할 상황과 목적">${escapeHtml(skillDraft.description)}</textarea><small>실제 서버 제한: 500자 이내</small></label><label class="full">스킬 내용<textarea name="body" rows="9" maxlength="4000" required placeholder="실행 절차와 확인 조건을 Markdown으로 작성합니다.">${escapeHtml(skillDraft.body)}</textarea></label></div><div class="skill-preview-label">SKILL.md 미리보기 · 실제 DB에 저장할 형식</div><pre class="skill-file-preview" id="skill-preview"></pre>`
    : `<div class="skill-upload-picker"><label>SKILL.md 파일<input name="file" type="file" accept=".md,.txt,text/markdown,text/plain"><small>UTF-8 .md/.txt 파일, 32 KiB 이하 · name·description frontmatter 필수</small></label></div>${skillUpload ? `<div class="skill-file-meta"><span class="badge ok">불러옴</span><strong>${escapeHtml(skillUpload.fileName)}</strong><span>${new TextEncoder().encode(skillUpload.content).length}바이트</span></div><div class="skill-meta-grid"><div class="skill-meta-card"><small>name</small><strong>${escapeHtml(skillUpload.name)}</strong></div><div class="skill-meta-card"><small>description</small><strong>${escapeHtml(skillUpload.description)}</strong></div></div><div class="skill-preview-label">등록할 SKILL.md 내용</div><pre class="skill-file-preview">${escapeHtml(skillUpload.content.slice(0, 1200))}${skillUpload.content.length > 1200 ? '\n…' : ''}</pre>` : '<div class="notice skill-upload-empty">파일을 선택하면 내용을 확인한 뒤 등록할 수 있습니다.</div>'}`;
  const list =
    registered
      .map(
        (s) =>
          `<details class="skill-registered-item"><summary><strong>${escapeHtml(s.name)}</strong><span class="badge">v${escapeHtml(s.version)}</span></summary><p>${escapeHtml(s.description)}</p><small>등록 ${date(s.created_at)}</small><pre>${escapeHtml(s.content)}</pre></details>`
      )
      .join('') || '<p class="empty">등록된 사용자 스킬이 없습니다.</p>';
  return (
    head(
      '스킬 등록',
      '직접 작성하거나 파일을 불러와 AI 직원이 선택할 수 있는 스킬을 등록합니다.',
      '<button type="button" class="secondary" data-nav="employees">AI 직원 보기</button>'
    ) +
    `<div class="skill-page"><section class="panel skill-panel"><div class="panel-head"><div><h2>등록 방법</h2><p class="panel-sub">작성 방식별 입력 내용을 유지합니다.</p></div><span class="badge">실제 DB 저장</span></div><div class="skill-mode-tabs" aria-label="스킬 등록 방법"><button type="button" data-skill-mode="direct" class="${direct ? 'active' : ''}" aria-pressed="${direct}">직접 작성</button><button type="button" data-skill-mode="upload" class="${direct ? '' : 'active'}" aria-pressed="${!direct}">파일 업로드</button></div><div class="panel-body"><form data-form="skill" data-mode="${skillMode}">${fields}<p class="error skill-form-error" role="alert">${escapeHtml(skillError)}</p><div class="form-actions"><button type="submit" class="primary">${direct ? '스킬 생성' : '불러온 스킬 등록'}</button></div></form></div></section><section class="panel skill-panel"><div class="panel-head"><div><h2>등록된 스킬</h2><p class="panel-sub">등록 후 AI 직원의 새 세션에서 선택할 수 있습니다.</p></div><span class="badge">${registered.length}건</span></div><div class="skill-registered-list">${list}</div></section></div><div class="notice skill-boundary">${icon('shield')} 스킬은 DB에 저장됩니다. 기존 개별 설정과 실행 권한은 자동으로 바뀌지 않습니다. 모든 AI에 적용하려면 <button type="button" class="secondary small" data-nav="ai-policy">AI 정책에서 선택</button>하세요.</div>`
  );
}
function personas() {
  const registered = values('personas');
  const rows =
    registered
      .map(
        (x) =>
          `<details class="persona-template-item"><summary><span>${escapeHtml(x.name)}</span><span class="badge ok">등록됨 · v${escapeHtml(x.version)}</span></summary><pre>${escapeHtml(x.content)}</pre></details>`
      )
      .join('') ||
    '<p class="empty">아직 등록한 페르소나 템플릿이 없습니다.</p>';
  const roleDefaults = `<details class="persona-template-item"><summary><span>직원 유형별 템플릿</span><span class="badge">기본 제공</span></summary><pre>관리 AI: ${escapeHtml(builtInPersonas[0].content)}\n\n실무 AI: ${escapeHtml(builtInPersonas[1].content)}</pre></details>`;
  const standard = builtInPersonas
    .slice(2)
    .map(
      (x) =>
        `<details class="persona-template-item"><summary><span>${escapeHtml(x.name)}</span><span class="badge">기본 제공</span></summary><pre>${escapeHtml(x.content)}</pre></details>`
    )
    .join('');
  return (
    head(
      '페르소나 템플릿',
      'AI 직원의 역할·행동 지침을 재사용할 템플릿으로 등록합니다.',
      '<button type="button" class="secondary" data-employee-create>AI 직원 생성</button>'
    ) +
    `<div class="persona-template-layout"><section class="panel persona-template-panel"><div class="panel-head"><div><h2>새 템플릿</h2><p class="panel-sub">등록 후 AI 직원의 ‘기본 페르소나’에서 선택할 수 있습니다.</p></div><span class="badge">실제 DB 저장</span></div><div class="panel-body"><form data-form="persona"><div class="form-grid"><label class="full">템플릿 이름<input name="name" type="text" maxlength="100" required placeholder="예: API 설계 담당"></label><label class="full">역할·행동 지침<textarea name="content" rows="10" maxlength="10000" required placeholder="담당 범위, 보고 방식, 확인할 조건을 작성합니다."></textarea><small>선택하면 이 내용을 새 AI 직원의 세션 설정으로 복사합니다.</small></label></div><div class="form-actions"><button type="submit" class="primary">템플릿 등록</button></div></form></div></section><section class="panel persona-template-panel"><div class="panel-head"><div><h2>템플릿 목록</h2><p class="panel-sub">기본 제공 템플릿은 읽기 전용입니다.</p></div><span class="badge">등록됨 ${registered.length}건</span></div><div class="persona-template-list">${rows}<div class="persona-template-subhead">기본 제공 템플릿</div>${roleDefaults}${standard}</div></section></div><div class="notice persona-template-boundary">${icon('shield')} 사용자 템플릿은 DB에 저장됩니다. 기본 제공 예시는 화면에 포함된 읽기 전용 문구이며, 기존 세션의 페르소나는 자동으로 바뀌지 않습니다.</div>`
  );
}
function policySkillIds(session: RecordItem): string[] {
  try { return JSON.parse(String(session.skill_ids || '[]')); } catch { return []; }
}
function policyTags(ids: string[], common: string[]) {
  return ids.map(id => `<span class="schedule-tag ${common.includes(id) ? 'policy-common' : ''}">${common.includes(id) ? '공통 · ' : '개별 · '}${escapeHtml(lookup('skills', id)?.name || id)}</span>`).join('') || '<span class="hint">스킬 없음</span>';
}
function policyUpdatedVersions(ids: string[], saved: RecordItem): string[] {
  return ids.filter(id => {
    const pinned = (saved.skills || []).find((skill: RecordItem) => skill.id === id);
    const current = lookup('skills', id);
    return pinned && current && (pinned.version !== current.version || pinned.hash !== current.sha256);
  });
}
function aiPolicyPage() {
  const saved = data.aiPolicy as RecordItem;
  policyDraft ??= { skillIds: [...saved.skillIds], revision: saved.revision };
  const common = policyDraft.skillIds;
  const added = common.filter(id => !saved.skillIds.includes(id));
  const removed = saved.skillIds.filter((id: string) => !common.includes(id));
  const updated = policyUpdatedVersions(common, saved);
  const skills = values('skills').map(skill => `<label class="policy-option"><input type="checkbox" name="policySkill" value="${escapeHtml(skill.id)}" ${common.includes(skill.id) ? 'checked' : ''}><span><strong>${escapeHtml(skill.name)} <small>v${escapeHtml(skill.version)}</small></strong><p>${escapeHtml(skill.description)}</p><details><summary>스킬 내용 보기</summary><pre>${escapeHtml(skill.content)}</pre></details></span></label>`).join('');
  const rows = values('employees').map(employee => {
    const session = values('sessions').find(session => session.employee_id === employee.id && session.is_current === 1);
    const individual = session ? policySkillIds(session) : [];
    const effective = [...new Set([...common, ...individual])];
    const run = values('runs').find(run => run.employee_id === employee.id);
    const snapshot = values('runSkillSnapshots').find(snapshot => snapshot.run_id === run?.id);
    return `<tr><td><strong>${escapeHtml(employee.name)}</strong><small>${employee.role === 'manager' ? '관리 AI' : '작업 AI'}</small></td><td>${escapeHtml(session?.label || '현재 세션 없음')}</td><td>${common.length}</td><td>${individual.length}</td><td><div class="schedule-tags">${policyTags(effective, common)}</div><small>중복 제외 ${effective.length}건 · 다음 Run 미리보기</small></td><td>${snapshot ? `최근 Run 적용 v${escapeHtml(snapshot.policy_revision)}${snapshot.policy_revision !== saved.revision ? ' · 새 정책 적용 대기' : ''}` : '최근 Run 정책 미기록'}</td></tr>`;
  });
  const history = saved.history.map((entry: RecordItem) => `<article class="policy-history"><strong>정책 v${escapeHtml(entry.revision)}</strong><p>${entry.updatedAt ? date(entry.updatedAt) : '초기 빈 정책'} · 공통 ${entry.skills.length}건</p><div class="schedule-tags">${entry.skills.map((skill: RecordItem) => `<span class="schedule-tag policy-common">${escapeHtml(skill.name)} v${escapeHtml(skill.version)}</span>`).join('') || '공통 스킬 없음'}</div><button type="button" class="secondary small" data-policy-restore="${entry.revision}" ${policyBusy ? 'disabled' : ''}>이 선택으로 새 버전 저장 준비</button></article>`).join('');
  return head('AI 정책', '전체 AI의 공통 스킬을 개별 설정과 별도로 관리합니다.', '<button class="secondary" data-nav="skills">스킬 등록</button>') +
    notice('다음 Run 시작·재개부터 적용합니다. 실행 중 Run과 과거 기록은 변경하지 않으며, 스킬은 도구 권한이나 상위 안전 규칙을 변경하지 않습니다. 1:1 면담에도 적용됩니다.') +
    `<div class="policy-layout"><section class="panel"><div class="panel-head"><h2>모든 AI의 공통 스킬</h2><span class="badge">저장된 정책 v${saved.revision}</span></div><div class="panel-body"><form data-form="ai-policy"><div class="policy-options">${skills || '<p class="empty">먼저 스킬을 등록하세요. 빈 정책도 저장할 수 있습니다.</p>'}</div>${policyDraft.revision !== saved.revision ? '<p class="error" role="alert">다른 저장으로 정책이 변경되었습니다. 최신 정책으로 되돌린 뒤 다시 확인하세요.</p>' : ''}<div class="form-actions"><button type="button" class="secondary" data-policy-reset>저장된 선택으로 되돌리기</button><button class="primary" ${policyBusy ? 'disabled' : ''}>공통 정책 저장</button></div></form></div></section><aside class="panel"><div class="panel-head"><h2>적용 범위 미리보기</h2></div><div class="panel-body"><p>기존 AI ${values('employees').length}명과 신규 AI 전체 · 부서·역할 예외 없음</p><p>선택 ${common.length}건 · 추가 ${added.length}건 · 해제 ${removed.length}건 · 버전 갱신 ${updated.length}건</p><div class="schedule-tags">${policyTags(common, common)}</div><p class="hint">면담의 업무 도구 제한은 유지됩니다. 공통에서 해제해도 개별로 선택한 스킬은 남습니다.</p></div></aside></div><section class="panel"><div class="panel-head"><h2>AI별 적용 스킬 미리보기</h2></div>${table(['AI 직원', '현재 세션', '공통', '개별', '적용 스킬', '실제 적용 상태'], rows)}</section><section class="panel"><div class="panel-head"><h2>정책 변경 이력 · 최근 5개 버전</h2></div><div class="panel-body">${history}</div></section>`;
}
async function savePolicy(confirmed = false) {
  if (!policyDraft || policyBusy) return;
  const saved = data.aiPolicy as RecordItem;
  if (saved.revision !== policyDraft.revision) { toast('최신 정책을 다시 조회하고 선택을 확인하세요.'); return; }
  const added = policyDraft.skillIds.filter(id => !saved.skillIds.includes(id));
  const removed = saved.skillIds.filter((id: string) => !policyDraft!.skillIds.includes(id));
  const updated = policyUpdatedVersions(policyDraft.skillIds, saved);
  if (!added.length && !removed.length && !updated.length) { dirty = false; toast('변경 사항이 없습니다.'); return; }
  const names = (ids: string[]) => ids.map(id => lookup('skills', id)?.name || id).join(', ') || '없음';
  if (!confirmed) {
    show('모든 AI의 공통 정책 변경 확인', `<div class="notice">정책 v${saved.revision} → v${saved.revision + 1} · 기존 AI ${values('employees').length}명과 신규 AI 전체에 다음 Run부터 적용합니다.</div><div class="policy-history"><strong>추가 ${added.length}건</strong><p>${escapeHtml(names(added))}</p><strong>해제 ${removed.length}건</strong><p>${escapeHtml(names(removed))}</p><strong>버전 갱신 ${updated.length}건</strong><p>${escapeHtml(names(updated))}</p></div>${policyDraft.skillIds.length ? '' : '<p class="error">공통 스킬을 모두 해제합니다.</p>'}<p class="hint">개별 설정·도구 권한·이전 Run 스냅샷은 보존합니다. 면담에도 적용하지만 업무 도구 권한은 늘어나지 않습니다.</p><div class="form-actions"><button type="button" class="secondary" data-policy-close>계속 편집</button><button type="button" class="primary" data-policy-confirm>전체 AI 정책 저장</button></div>`);
    return;
  }
  detail.close();
  policyBusy = true;
  const payload = { skillIds: [...policyDraft.skillIds], expectedRevision: policyDraft.revision };
  render();
  try {
    await api('/api/ai-policy', 'PUT', payload, `ai-policy:${JSON.stringify(payload)}`);
    policyDraft = null; dirty = false;
    await refresh(); toast('공통 정책을 저장했습니다. 다음 Run부터 적용됩니다.');
  } catch (error) {
    toast(String(error));
    // 초안은 유지하고 최신 revision을 받아 충돌을 표시합니다.
    try { data.aiPolicy = await api('/api/ai-policy'); } catch { /* 원래 오류를 유지합니다. */ }
  } finally { policyBusy = false; if (page === 'ai-policy') render(); }
}
const metricNumber = (value: unknown, suffix = '') => value === null || value === undefined ? '—' : `${Number(value).toFixed(suffix ? 1 : 0)}${suffix}`;
function mcpMetricsPage() {
  const result = metricsResult;
  const filters = `<form data-form="mcp-filter" class="metrics-filters"><label>조회 기간<select name="days">${['1', '7', '30'].map(days => `<option value="${days}" ${metricsFilter.days === days ? 'selected' : ''}>최근 ${days === '1' ? '24시간' : days + '일'}</option>`).join('')}</select></label><label>호출한 AI<select name="employeeId"><option value="">모든 AI</option>${options(values('employees'), employee => employee.name, metricsFilter.employeeId)}</select></label><label>MCP 함수<select name="tool"><option value="">모든 함수</option>${((data.mcpTools || []) as string[]).map(tool => `<option value="${escapeHtml(tool)}" ${metricsFilter.tool === tool ? 'selected' : ''}>${escapeHtml(tool)}</option>`).join('')}</select></label><button class="primary">조회</button><button type="button" class="secondary" data-metrics-reset>필터 초기화</button></form>`;
  const title = head('MCP 사용 지표', '실제 System MCP 통신 시도와 AI 간 위임을 구분합니다.');
  if (!result) return title + filters + `<p role="status">${escapeHtml(metricsError || '지표를 조회하고 있습니다.')}</p>`;
  const name = (id: unknown) => escapeHtml(lookup('employees', id)?.name || id || '미관측');
  const summary = result.summary;
  const cards = [['전체 호출 시도', summary.total], ['사용된 함수', summary.usedTools], ['응답 성공률', metricNumber(summary.successRate, '%')], ['AI 간 위임 시도', summary.delegations]].map(([label, value]) => `<div class="panel stat-card"><span>${label}</span><strong>${value}</strong></div>`).join('');
  const functions = result.functions.map((row: RecordItem) => `<tr><td><button class="secondary small mono" data-metrics-tool="${escapeHtml(row.tool)}">${escapeHtml(row.tool)}</button></td><td>${row.total}</td><td>${metricNumber(row.share, '%')}</td><td>${row.success} / ${row.failed} / ${row.unobserved}</td><td>${metricNumber(row.successRate, '%')}</td><td>${metricNumber(row.averageMs, ' ms')}</td></tr>`);
  const ais = result.ais.map((row: RecordItem) => `<tr><td>${name(row.employee_id)}</td><td>${row.total}</td></tr>`);
  const routes = result.routes.map((row: RecordItem) => `<tr><td>${name(row.employee_id)} → ${name(row.target_id)}</td><td>${row.total}</td><td>${metricNumber(row.share, '%')}</td></tr>`);
  const recent = result.recent.map((row: RecordItem) => `<tr><td><code>${escapeHtml(row.call_id)}</code><small>${new Date(row.occurred_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</small></td><td>${name(row.employee_id)}</td><td>${escapeHtml(row.tool)}</td><td>${row.tool === 'task_delegate' ? name(row.target_id) : '—'}</td><td>${row.status === 'success' ? '응답 성공' : row.status === 'failed' ? '응답 실패' : '대기·미관측'}<small>${escapeHtml(row.error_code || '')}</small></td><td>${metricNumber(row.duration_ms, ' ms')}</td></tr>`);
  return title + filters + notice(`부분 수집 · 수집 시작 ${date(result.collection.startedAt)}. ${escapeHtml(result.collection.scope)}`) + `<div class="metrics-stats">${cards}</div><p class="hint">확인된 성공 ${summary.success} / 실패 ${summary.failed} · 대기·미관측 ${summary.unobserved}건. 응답 성공률 분모는 성공+실패입니다.</p><section class="panel"><div class="panel-head"><h2>함수별 사용 현황</h2></div>${table(['MCP 함수', '호출 시도', '호출 비중', '성공 / 실패 / 미관측', '응답 성공률', '평균 응답 시간'], functions)}</section><div class="policy-layout"><section class="panel"><div class="panel-head"><h2>AI별 MCP 호출</h2></div>${table(['호출한 AI', '호출 시도'], ais)}</section><section class="panel"><div class="panel-head"><h2>AI 간 위임 경로 · task_delegate</h2></div>${table(['위임 경로', '위임 시도', '위임 호출 비중'], routes)}</section></div><section class="panel"><div class="panel-head"><h2>최근 호출 기록 · 한국 시간</h2><span class="badge">${result.recent.length} / ${summary.total}건</span></div>${table(['호출 ID / 시각', '호출한 AI', '함수', '위임 대상 AI', '응답 상태', '응답 시간'], recent)}${result.nextCursor ? '<div class="panel-body"><button class="secondary" data-metrics-next>다음 기록 더 보기</button></div>' : ''}</section>${metricsError ? `<p class="error" role="alert">${escapeHtml(metricsError)}</p>` : ''}` + notice('호출 비중 = 함수 호출 수 ÷ 전체 호출 수. 위임 경로 비중은 task_delegate만 분모로 합니다. 응답 성공은 접수·통신 성공이며 AI 작업 완료율이 아닙니다. 측정된 시간만 평균에 포함하며 토큰·비용·이용 한도는 측정하지 않습니다.') + `<p class="hint">조회 범위: ${date(result.filters.from)} ~ ${date(result.filters.to)} · 집계 ${date(result.aggregatedAt)}. 수집 전 기간의 0건은 미수집입니다.</p>`;
}
async function loadMetrics(next = false) {
  if (next && metricsLoading) return;
  const request = ++metricsRequest;
  const to = next && metricsResult ? metricsResult.filters.to : Date.now();
  const from = to - Number(metricsFilter.days) * 86400000;
  const params = new URLSearchParams({ from: String(from), to: String(to), limit: '50' });
  if (metricsFilter.employeeId) params.set('employeeId', metricsFilter.employeeId);
  if (metricsFilter.tool) params.set('tool', metricsFilter.tool);
  if (next && metricsResult?.nextCursor) params.set('cursor', metricsResult.nextCursor);
  metricsLoading = true;
  metricsError = '';
  if (!next) { metricsResult = null; app.innerHTML = mcpMetricsPage(); }
  try {
    const result = await api(`/api/metrics/mcp?${params}`);
    if (request !== metricsRequest || page !== 'mcp-metrics') return;
    if (next && metricsResult) result.recent = [...metricsResult.recent, ...result.recent];
    metricsResult = result; metricsError = '';
  } catch (error) { if (request !== metricsRequest || page !== 'mcp-metrics') return; metricsError = String(error); }
  metricsLoading = false;
  app.innerHTML = mcpMetricsPage();
}
function settings() {
  const prices = values('prices');
  const models = [
    ...new Set([
      ...(Array.isArray(data.modelChoices)
        ? (data.modelChoices as string[])
        : ['gpt-6.1-sol']),
      ...prices.map((price) => String(price.model)),
    ]),
  ];
  const rows = models
    .map((model, index) => {
      const price = prices.find((item) => item.model === model);
      const formId = `price-form-${index}`;
      const input = (name: string, label: string, value: unknown) =>
        `<td data-label="${label}"><input form="${formId}" name="${name}" type="text" inputmode="decimal" value="${escapeHtml(value ?? '')}" placeholder="미설정" aria-label="${escapeHtml(model)} ${label} 단가 (USD / 100만 토큰)"></td>`;
      return `<tr><td data-label="모델"><form id="${formId}" data-form="price"><input type="hidden" name="model" value="${escapeHtml(model)}"></form><span class="mono">${escapeHtml(model)}</span></td>${input('input', '입력', price?.input_price)}${input('cachedInput', '캐시 입력', price?.cached_input_price)}${input('output', '출력', price?.output_price)}<td data-label="저장"><button form="${formId}" type="submit" class="primary small">저장</button></td></tr>`;
    })
    .join('');
  return (
    head(
      '환경 설정',
      '로그 위치·모델별 수동 요금을 설정하고 실행 제한의 관리 위치를 확인할 수 있습니다.',
      ''
    ) +
    `<div class="settings-grid"><section class="panel settings-panel"><div class="panel-head"><h2>실행·로그 환경</h2><span class="badge">실제 운영</span></div><div class="panel-body"><form data-form="log-source" data-revision="${escapeHtml(data.logSourceRevision ?? 0)}"><div class="form-grid"><label class="settings-field full">Codex 로그 읽기 경로<input name="root" type="text" value="${escapeHtml(data.logSourceRoot ?? '')}" required><small>CODEX_HOME 안에 있는 기존 디렉터리만 지정할 수 있습니다. 변경 후 세션 대화에서 재색인하세요.</small></label><div class="settings-readonly"><span>실행용 CODEX_HOME</span><strong>.env에서 관리</strong><small>실행 환경은 웹에서 변경할 수 없습니다.</small></div><div class="settings-readonly"><span>동시 실행 상한 · 자동 재개 상한</span><strong>.env에서 관리</strong><small>변경 후 서비스를 다시 시작해야 적용됩니다.</small></div></div><div class="notice settings-notice">허용된 작업 위치 루트: <span class="code">${escapeHtml(data.workspaceRoot)}</span>. Codex 인증 정보는 화면에 표시하지 않습니다.</div><div class="form-actions"><button class="primary" type="submit">로그 경로 저장</button></div></form></div></section><div class="settings-side"><section class="panel settings-panel"><div class="panel-head"><h2>모델 후보</h2><span class="badge">설정된 목록</span></div><div class="panel-body">${models.map((model, index) => `<div class="setting-row"><div><h3 class="mono">${escapeHtml(model)}</h3><p>${index === 0 ? '기본 후보 모델' : '모델 변경 UI의 후보'}</p></div>${index === 0 ? '<span class="badge blue">기본</span>' : ''}</div>`).join('')}<p class="hint">후보 목록은 서버 설정을 반영합니다. 계정의 사용 가능 여부는 검증되지 않았습니다.</p></div></section><section class="panel settings-panel"><div class="panel-head"><h2>운영 데이터 관리</h2></div><div class="panel-body"><p class="hint">이 화면은 실제 데이터를 사용합니다. 프로토타입의 샘플 데이터 초기화는 제공하지 않습니다.</p></div></section></div></div><section class="panel settings-panel pricing-panel"><div class="panel-head"><div><h2>모델별 요금</h2><p class="panel-sub">모델별 입력·출력 단가를 수동 등록합니다.</p></div><span class="badge blue">USD / 100만 토큰</span></div><div class="panel-body"><p class="pricing-intro">공식 요금은 자동 수집하지 않습니다. 공란은 미설정, 0은 0 USD로 저장합니다. 캐시 입력 단가는 선택 사항입니다.</p><div class="table-wrap pricing-table-wrap"><table class="pricing-table"><thead><tr><th scope="col">모델</th><th scope="col">입력</th><th scope="col">캐시 입력(선택)</th><th scope="col">출력</th><th scope="col">저장</th></tr></thead><tbody>${rows}</tbody></table></div><div class="notice settings-notice">모델별로 저장합니다. 입력한 단가는 실제 청구액이 아니며, 토큰 사용량 수집·비용 추정·청구 대조는 하지 않습니다.</div></div></section>`
  );
}
function render() {
  nav();
  app.innerHTML = (
    {
      dashboard,
      employees,
      organizations,
      orders,
      tasks,
      logs,
      conversations,
      interviews,
      schedules,
      recovery,
      'ai-policy': aiPolicyPage,
      'mcp-metrics': mcpMetricsPage,
      skills,
      personas,
      settings,
      guide: () =>
        head('가이드북', '별도 안내서 페이지에서 확인하세요.') +
        '<a href="/guidebook.html">가이드북 열기</a>',
    } as Record<string, () => string>
  )[page]();
  if (page === 'skills') updateSkillPreview();
  if (page === 'mcp-metrics') void loadMetrics();
  if (page === 'employees' && employeeEditor) updateEmployeePreview();
  if (page === 'conversations' && selectedConversationSession)
    void loadConversation(selectedConversationSession);
  if (page === 'interviews' && selectedInterviewId)
    void loadInterview(selectedInterviewId);
}
function show(title: string, html: string) {
  document.querySelector('#detail-title')!.textContent = title;
  document.querySelector('#detail-content')!.innerHTML = html;
  detail.showModal();
}
function showOrg(orgId: string) {
  const org = lookup('organizations', orgId);
  if (!org) return;
  const staff = values('employees').filter((e) => e.org_id === orgId);
  const available = values('employees').filter(
    (e) => !e.org_id && e.status === 'active'
  );
  show(
    `${escapeHtml(org.name)} / 조직도`,
    `<div class="org-chart">${staff.map((e) => `<div class="org-card ${e.role === 'worker' ? 'worker' : ''}"><strong>${escapeHtml(e.name)}</strong><small>${e.role === 'manager' ? '관리 AI' : '작업 AI'} / ${escapeHtml(e.responsibility)}</small><small>직속: ${escapeHtml(lookup('employees', e.supervisor_id)?.name || '없음')}</small></div>`).join('') || '<p class="empty">아직 직원이 없습니다.</p>'}</div><div class="expand"><button class="secondary" data-expand="assignment">AI 직원 추가</button><div id="assignment-panel" hidden><form data-form="assignment" data-org="${escapeHtml(orgId)}" class="form-grid"><label>AI Session <span class="required">*</span><select name="employeeId" required>${options(available, (x) => x.name + ' / ' + x.responsibility)}</select></label><label>직속 관리 AI<select name="supervisorId"><option value="">지정하지 않음</option>${options(
      staff.filter((e) => e.role === 'manager'),
      (x) => x.name
    )}</select></label><div class="form-actions full"><button class="primary">조직에 배치</button></div></form></div></div><div class="expand"><h3>관리 AI 호출 권한</h3>${
      staff
        .filter((e) => e.role === 'manager')
        .map(
          (m) =>
            `<form data-form="permission" data-manager="${escapeHtml(m.id)}"><strong>${escapeHtml(m.name)}</strong><div class="checklist">${values(
              'employees'
            )
              .filter((e) => e.role === 'worker' && e.status === 'active')
              .map(
                (w) =>
                  `<label><input type="checkbox" name="workerIds" value="${escapeHtml(w.id)}" ${values('permissions').some((p) => p.manager_id === m.id && p.worker_id === w.id) ? 'checked' : ''}>${escapeHtml(w.name)}</label>`
              )
              .join(
                ''
              )}</div><div class="form-actions"><button class="secondary">권한 저장</button></div></form>`
        )
        .join('') || '<p class="hint">관리 AI가 없습니다.</p>'
    }</div>`
  );
}
async function showSession(sessionId: string, cursor = 0) {
  const result = await api(
    `/api/sessions/${sessionId}/events?cursor=${cursor}`
  );
  const s = result.session;
  const events = result.events as RecordItem[];
  show(
    '세션 대화',
    `<p><strong>${escapeHtml(lookup('employees', s.employee_id)?.name)}</strong> / ${escapeHtml(s.label)} / ${escapeHtml(s.codex_id || '미발급')}</p><p class="hint">수집 범위: ${escapeHtml(result.completeness)}.공개 이벤트만 표시합니다.</p><div class="row-actions"><button class="secondary small" data-reindex="${escapeHtml(sessionId)}">Codex 로그 재색인</button></div><div class="timeline">${events.map((x: RecordItem) => `<article class="${x.kind === 'user' ? 'user' : ''}"><small>${escapeHtml(x.kind)} / ${date(x.created_at)} / ${escapeHtml(x.source)}</small><pre>${escapeHtml(x.content)}</pre></article>`).join('') || '<p class="empty">대화 이벤트가 없습니다.</p>'}</div>${events.length === 100 ? `<button class="secondary" data-session-next="${escapeHtml(sessionId)}" data-cursor="${events[events.length - 1].id}">다음 페이지</button>` : ''}`
  );
}
function updateSkillPreview() {
  const form = document.querySelector<HTMLFormElement>(
    'form[data-form="skill"][data-mode="direct"]'
  );
  if (!form) return;
  const fd = new FormData(form);
  skillDraft = {
    name: String(fd.get('name') || ''),
    description: String(fd.get('description') || ''),
    body: String(fd.get('body') || ''),
  };
  const preview = document.querySelector<HTMLElement>('#skill-preview');
  if (preview)
    preview.textContent = skillContent(
      skillDraft.name,
      skillDraft.description,
      skillDraft.body
    );
}
document.addEventListener('click', async (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLElement>(
    '[data-nav],[data-policy-confirm],[data-policy-close],[data-policy-reset],[data-policy-restore],[data-metrics-reset],[data-metrics-tool],[data-metrics-next],[data-show],[data-org],[data-log],[data-order],[data-order-create],[data-order-cancel],[data-order-tab],[data-task],[data-task-filter],[data-process],[data-session],[data-session-next],[data-conversation-select],[data-conversation-next],[data-reindex],[data-config],[data-add-session],[data-interview-create],[data-interview-select],[data-interview-next],[data-skill-mode],[data-job],[data-cancel-run],[data-wake],[data-edit-schedule],[data-employee-create],[data-employee-cancel],[data-expand]'
  );
  if (!button) return;
  try {
    if (button.hasAttribute('data-policy-confirm')) { await savePolicy(true); return; }
    if (button.hasAttribute('data-policy-close')) { detail.close(); return; }
    if (button.hasAttribute('data-policy-reset')) {
      if (policyBusy) return;
      data.aiPolicy = await api('/api/ai-policy'); policyDraft = null; dirty = false; render(); return;
    }
    if (button.dataset.policyRestore) {
      if (policyBusy) return;
      const saved = data.aiPolicy as RecordItem;
      const history = saved.history.find((entry: RecordItem) => entry.revision === Number(button.dataset.policyRestore));
      if (!history) return;
      policyDraft = { revision: saved.revision, skillIds: history.skills.map((skill: RecordItem) => skill.id) };
      dirty = true; render(); toast('과거 선택을 불러왔습니다. 영향 범위를 확인한 뒤 저장하세요.'); return;
    }
    if (button.hasAttribute('data-metrics-reset') || button.dataset.metricsTool) {
      metricsFilter = button.dataset.metricsTool ? { ...metricsFilter, tool: button.dataset.metricsTool } : { days: '7', employeeId: '', tool: '' };
      await loadMetrics(); return;
    }
    if (button.hasAttribute('data-metrics-next')) { button.setAttribute('disabled', ''); await loadMetrics(true); return; }
    if (button.dataset.nav) {
      if (policyBusy) { toast('정책 저장 중에는 이동할 수 없습니다.'); return; }
      if (dirty && !confirm('작성 중인 입력 내용이 사라집니다. 이동할까요?'))
        return;
      if (button.dataset.nav === 'guide') {
        window.location.assign('/guidebook.html');
        return;
      }
      dirty = false;
      policyDraft = null;
      employeeEditor = null;
      page = button.dataset.nav;
      detail.close();
      document.querySelector('.shell')!.classList.remove('nav-open');
      document
        .querySelector('#menu-toggle')!
        .setAttribute('aria-expanded', 'false');
      render();
      app.focus();
      return;
    }
    if (button.dataset.skillMode) {
      if (
        button.dataset.skillMode === 'direct' ||
        button.dataset.skillMode === 'upload'
      ) {
        skillUploadRequest++;
        skillMode = button.dataset.skillMode;
        skillError = '';
        render();
      }
      return;
    }
    if (button.hasAttribute('data-employee-create')) {
      page = 'employees';
      employeeEditor = { mode: 'create' };
      render();
      app.focus();
      return;
    }
    if (button.hasAttribute('data-employee-cancel')) {
      if (
        dirty &&
        !confirm('작성 중인 입력 내용이 사라집니다. 목록으로 돌아갈까요?')
      )
        return;
      dirty = false;
      employeeEditor = null;
      render();
      app.focus();
      return;
    }
    if (button.dataset.show === 'org-create') {
      show(
        '조직 생성',
        `<form data-form="organization">${field('조직 이름', 'name', '', true)}<div class="form-actions"><button class="primary">생성</button></div></form>`
      );
      return;
    }
    if (button.dataset.org) {
      showOrg(button.dataset.org);
      return;
    }
    if (button.dataset.editSchedule) {
      const employee = lookup('employees', button.dataset.editSchedule);
      if (!employee) return;
      const schedule = values('schedules').find(
        (x) => x.manager_id === employee.id
      );
      show(
        `${escapeHtml(employee.name)}의 일정`,
        `<form data-form="schedule" class="form-grid"><input type="hidden" name="managerId" value="${escapeHtml(employee.id)}">${field('cron 식', 'cron', schedule?.cron || '0 9 * * 1-5', true)}${field('시간대', 'timezone', schedule?.timezone || 'Asia/Seoul', true)}<label>상태<select name="enabled"><option value="true" ${schedule?.enabled ? 'selected' : ''}>예약 활성</option><option value="false" ${!schedule?.enabled ? 'selected' : ''}>일시 중지</option></select></label><label class="full">기본 업무 프롬프트<textarea name="prompt" required>${escapeHtml(schedule?.prompt || '처리되지 않은 업무 지시와 결과를 확인하세요.')}</textarea></label><p class="hint full">저장한 cron 일정은 서버 스케줄러에서 실제로 사용됩니다.</p><div class="form-actions full"><button class="primary">일정 저장</button></div></form>`
      );
      return;
    }
    if (button.dataset.expand) {
      const panel = document.querySelector<HTMLElement>('#assignment-panel')!;
      panel.hidden = !panel.hidden;
      return;
    }
    if (button.dataset.log) {
      const l = lookup('workLogs', button.dataset.log);
      if (!l) return;
      const author = lookup('employees', l.author_id),
        task = lookup('tasks', l.task_id);
      show(
        '업무 일지 상세',
        `<div class="work-log-detail-top"><strong class="code">${escapeHtml(l.id)}</strong><span class="badge">읽기 전용</span></div><div class="work-log-detail-info"><div>기록한 AI<strong>${escapeHtml(author?.name || '직원 미등록')}</strong></div><div>관련 Task<strong>${escapeHtml(l.task_id)}</strong></div><div>기록 시각<strong>${date(l.created_at)}</strong></div><div>Task 개정<strong>${escapeHtml(l.task_revision ?? '—')}</strong></div></div><div class="work-order-detail-section"><h3>업무 요약</h3><div class="prompt-box">${escapeHtml(l.summary)}</div></div><div class="work-order-detail-section"><h3>이번에 완료한 일</h3><div class="prompt-box">${escapeHtml(l.completed || '—')}</div></div><div class="work-order-detail-section"><h3>확인한 근거</h3><div class="prompt-box">${escapeHtml(l.evidence || '—')}</div></div><div class="work-order-detail-section"><h3>미완료·다음 행동</h3><div class="prompt-box">${escapeHtml([l.remaining, l.next_step].filter(Boolean).join('\n') || '—')}</div></div><div class="notice work-log-detail-note">같은 AI 직원이 다음 실행에서 작업을 이어갈 때 참고하는 기록입니다.</div>${task ? `<div class="form-actions"><button type="button" class="secondary small" data-task="${escapeHtml(task.id)}">관련 Task 보기</button></div>` : ''}`
      );
      return;
    }
    if (button.hasAttribute('data-order-create')) {
      const managers = values('employees').filter(
        (e) => e.role === 'manager' && e.status === 'active'
      );
      show(
        '관리 AI에게 업무 지시',
        `<form data-form="order"><div class="form-grid"><label class="full">지시 제목<input name="title" type="text" maxlength="200" required placeholder="예: 화면 사용성 확인"></label><label class="full">담당 관리 AI<select name="managerId" required><option value="">관리 AI 선택</option>${managerOptions()}</select><small class="hint">실무 AI 선택과 Task 분해는 관리 AI가 담당합니다.</small></label><label class="full">의뢰 내용<textarea name="body" rows="6" maxlength="10000" required placeholder="목적, 대상, 지켜야 할 조건을 작성합니다."></textarea></label><label class="full">결과 보고에서 확인할 내용<textarea name="acceptance" rows="4" maxlength="3000" required placeholder="산출물, 검증 근거, 남은 과제 등을 작성합니다."></textarea></label></div>${managers.length ? '' : '<p class="notice warning">활성 상태의 관리 AI가 없습니다. 먼저 AI 직원을 생성해 주세요.</p>'}<div class="form-actions"><button type="button" class="secondary" data-order-cancel>취소</button><button class="primary" type="submit" ${managers.length ? '' : 'disabled'}>업무 지시 저장</button></div></form>`
      );
      return;
    }
    if (button.hasAttribute('data-order-cancel')) {
      detail.close();
      return;
    }
    if (button.dataset.orderTab) {
      if (
        button.dataset.orderTab === 'orders' ||
        button.dataset.orderTab === 'reports'
      ) {
        workOrderTab = button.dataset.orderTab;
        render();
      }
      return;
    }
    if (button.dataset.order) {
      const o = lookup('workOrders', button.dataset.order);
      if (!o) return;
      const linked = values('tasks').filter((t) => t.work_order_id === o.id);
      show(
        '업무 지시와 결과 보고',
        `<div class="work-order-detail-top"><span class="code">${escapeHtml(o.id)}</span>${badge(o.status)}</div><h2 class="work-order-detail-title">${escapeHtml(o.title)}</h2><p class="hint">담당 관리 AI: ${escapeHtml(lookup('employees', o.manager_id)?.name || '미설정')} · ${date(o.created_at)}</p><div class="work-order-detail-section"><h3>의뢰 내용</h3><div class="prompt-box">${escapeHtml(o.body)}</div></div><div class="work-order-detail-section"><h3>결과 보고에서 확인할 내용</h3><div class="prompt-box">${escapeHtml(o.acceptance)}</div></div><div class="work-order-detail-section"><h3>관련 Task · AI 기록</h3><div class="row-actions">${linked.map((t) => `<button type="button" class="secondary small" data-task="${escapeHtml(t.id)}">${escapeHtml(t.title)}</button>`).join('') || '<span class="hint">관련 Task가 없습니다.</span>'}</div></div><div class="work-order-detail-section"><h3>결과 보고서</h3><div class="prompt-box">${escapeHtml(o.report || '미제출 상태입니다.')}</div></div>`
      );
      return;
    }
    if (button.dataset.taskFilter) {
      taskFilter = button.dataset.taskFilter;
      render();
      return;
    }
    if (button.dataset.task) {
      const t = await api(`/api/tasks/${button.dataset.task}`);
      show(
        'Task 상세',
        `<p>${escapeHtml(t.title)} / ${badge(t.status)} / 진척도 ${t.progress === null ? '기준 미설정' : t.progress + '%'}</p><h3>목적</h3><pre>${escapeHtml(t.goal)}</pre><h3>완료 조건</h3>${table(
          ['조건', '가중치', '확인', '근거'],
          t.criteria.map(
            (c: RecordItem) =>
              `<tr><td>${escapeHtml(c.label)}</td><td>${escapeHtml(c.weight)}</td><td>${c.verified ? '확인됨' : '미확인'}</td><td>${escapeHtml(c.evidence || '—')}</td></tr>`
          )
        )}<h3>결과</h3><pre>${escapeHtml(t.result || '미제출')}</pre>`
      );
      return;
    }
    if (button.dataset.process) {
      const p = await api(`/api/work-processes/${button.dataset.process}`);
      show(
        '계속 업무 / 실행 회차',
        `<p>${escapeHtml(p.title)} / ${escapeHtml(p.cron)} / ${escapeHtml(p.timezone)}</p><p>수행 ${p.summary.done} / 기한 도래 ${p.summary.due} / 미수행 ${p.summary.missed} / 사유 있는 일시 중지 ${p.summary.skipped}. 전체 진척도는 없습니다.</p>${table(
          ['예정 시각', '결과', '근거', '파생 작업'],
          p.cycles.map(
            (c: RecordItem) =>
              `<tr><td>${date(c.scheduled_at)}</td><td>${badge(c.outcome)}</td><td>${short(c.evidence)}</td><td>${escapeHtml(c.derived_task_ids)}</td></tr>`
          )
        )}`
      );
      return;
    }
    if (button.dataset.conversationSelect) {
      selectedConversationSession = button.dataset.conversationSelect;
      conversationEvents = [];
      render();
      return;
    }
    if (button.dataset.conversationNext) {
      await loadConversation(
        button.dataset.conversationNext,
        Number(button.dataset.cursor)
      );
      return;
    }
    if (button.dataset.session) {
      await showSession(button.dataset.session);
      return;
    }
    if (button.dataset.sessionNext) {
      await showSession(
        button.dataset.sessionNext,
        Number(button.dataset.cursor)
      );
      return;
    }
    if (button.dataset.reindex) {
      const result = await api(
        `/api/sessions/${button.dataset.reindex}/reindex`,
        'POST',
        {}
      );
      toast(`${result.imported} 건 수집 / ${result.completeness}`);
      if (page === 'conversations')
        await loadConversation(button.dataset.reindex);
      else await showSession(button.dataset.reindex);
      return;
    }
    if (button.dataset.config) {
      const s = lookup('sessions', button.dataset.config);
      if (!s || s.is_current !== 1) {
        toast('현재 세션만 편집할 수 있습니다.');
        return;
      }
      employeeEditor = { mode: 'edit', sessionId: s.id };
      render();
      app.focus();
      return;
    }
    if (button.dataset.addSession) {
      const e = lookup('employees', button.dataset.addSession)!;
      show(
        '새 세션 추가',
        `<form data-form="session-add" data-employee="${escapeHtml(e.id)}" class="form-grid">${field('세션 표시 이름', 'label')}${modelField(e.model)}<label class="full">페르소나<textarea name="persona">${escapeHtml(e.persona)}</textarea></label><div class="full"><label>기본 스킬</label><div class="checklist">${values(
          'skills'
        )
          .map(
            (x) =>
              `<label><input type="checkbox" name="skillIds" value="${escapeHtml(x.id)}" ${JSON.parse(e.skill_ids).includes(x.id) ? 'checked' : ''}>${escapeHtml(x.name)}</label>`
          )
          .join(
            ''
          )}</div></div><div class="form-actions full"><button class="primary">새 세션 준비</button></div></form><p class="hint">실제 ID가 확정되면 현재 세션을 전환합니다. 이전 세션은 이력으로 남습니다.</p>`
      );
      return;
    }
    if (button.hasAttribute('data-interview-create')) {
      show(
        '새 1:1 면담',
        `<form data-form="interview" class="form-grid"><label>면담할 AI 직원<select name="employeeId" required><option value="">AI 직원 선택</option>${options(values('employees'), (x) => x.name + ' / ' + (x.role === 'manager' ? '관리 AI' : '실무 AI'))}</select></label>${field('면담 의제', 'topic', '', true)}<p class="hint full">업무 세션과 별도의 면담 세션을 만들며 업무용 MCP는 비활성화됩니다.</p><div class="form-actions full"><button type="submit" class="primary">면담 시작</button></div></form>`
      );
      return;
    }
    if (button.dataset.interviewSelect) {
      selectedInterviewId = button.dataset.interviewSelect;
      interviewEvents = [];
      render();
      return;
    }
    if (button.dataset.interviewNext) {
      await loadInterview(
        button.dataset.interviewNext,
        Number(button.dataset.cursor)
      );
      return;
    }
    if (button.dataset.job) {
      const j = lookup('jobs', button.dataset.job)!;
      const runs = values('runs').filter((r) => r.job_id === j.id);
      show(
        '복구 상세',
        `<pre>${escapeHtml(JSON.stringify(j, null, 2))}</pre><h3>Run</h3>${runs.map((r) => `<pre>${escapeHtml(JSON.stringify(r, null, 2))}</pre>${r.status === 'running' ? `<button class="danger" data-cancel-run="${escapeHtml(r.id)}">이 실행의 중지 요청</button>` : ''}`).join('')}`
      );
      return;
    }
    if (button.dataset.cancelRun) {
      if (
        !confirm(
          '이 실행의 하위 프로세스를 중지합니다. 외부 변경은 되돌릴 수 없습니다. 계속할까요?'
        )
      )
        return;
      await api(`/api/runs/${button.dataset.cancelRun}/cancel`, 'POST', {});
      detail.close();
      toast('중지 요청을 접수했습니다.');
      await refresh();
      return;
    }
    if (button.dataset.wake) {
      await api(`/api/managers/${button.dataset.wake}/wake`, 'POST', {});
      toast('관리 AI 실행 요청을 접수했습니다.');
      await refresh();
      return;
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
});
document.addEventListener('input', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('.employee-editor-form')) {
    dirty = true;
    updateEmployeePreview();
  }
  if (target.closest('form[data-form="skill"]')) updateSkillPreview();
});
document.addEventListener('change', async (event) => {
  const policyTarget = event.target as HTMLInputElement;
  if (policyTarget.name === 'policySkill' && policyDraft) {
    if (policyBusy) { render(); return; }
    policyDraft.skillIds = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="policySkill"]:checked')).map(input => input.value);
    const saved = data.aiPolicy as RecordItem;
    dirty = JSON.stringify([...policyDraft.skillIds].sort()) !== JSON.stringify([...saved.skillIds].sort());
    const id = policyTarget.value;
    render();
    Array.from(document.querySelectorAll<HTMLInputElement>('input[name="policySkill"]')).find(input => input.value === id)?.focus();
    return;
  }
  const toggle = event.target as HTMLInputElement;
  if (!toggle.dataset.scheduleToggle) return;
  const schedule = values('schedules').find(
    (x) => x.manager_id === toggle.dataset.scheduleToggle
  );
  if (!schedule) {
    toggle.checked = false;
    return;
  }
  toggle.disabled = true;
  try {
    await api(
      `/api/managers/${encodeURIComponent(toggle.dataset.scheduleToggle)}/schedule`,
      'PUT',
      {
        cron: schedule.cron,
        timezone: schedule.timezone,
        enabled: toggle.checked,
        prompt: schedule.prompt,
      }
    );
    await refresh();
    toast(
      toggle.checked ? '일정을 활성화했습니다.' : '일정을 일시 중지했습니다.'
    );
  } catch (error) {
    toggle.checked = !toggle.checked;
    toast(error instanceof Error ? error.message : String(error));
  } finally {
    toggle.disabled = false;
  }
});
document.addEventListener('change', async (event) => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'employee-filter') {
    employeeFilter = target.value;
    render();
    return;
  }
  if (target.id === 'work-log-employee-filter') {
    workLogEmployeeFilter = target.value;
    workLogTaskFilter = 'all';
    render();
    return;
  }
  if (target.id === 'work-log-task-filter') {
    workLogTaskFilter = target.value;
    render();
    return;
  }
  if (target.name === 'personaTemplate') {
    const preset = target.value.startsWith('builtin:')
      ? builtInPersonas.find((x) => x.id === target.value.slice(8))
      : lookup('personas', target.value);
    const area = document.querySelector<HTMLTextAreaElement>(
      'form[data-form="employee"] textarea[name="persona"]'
    );
    if (area && preset) {
      area.value = preset.content;
      dirty = true;
      updateEmployeePreview();
    }
    return;
  }
  if (target.closest('.employee-editor-form')) {
    dirty = true;
    updateEmployeePreview();
  }
  if (target.name === 'file' && target.closest('form[data-form="skill"]')) {
    skillUpload = null;
    const file = target.files?.[0],
      request = ++skillUploadRequest;
    if (!file) return;
    try {
      if (!/\.(md|txt)$/i.test(file.name) || file.size < 1 || file.size > 32768)
        throw new Error('32 KiB 이하의 UTF-8 .md/.txt 파일을 선택하세요.');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(
        await file.arrayBuffer()
      );
      if (
        request !== skillUploadRequest ||
        page !== 'skills' ||
        skillMode !== 'upload'
      )
        return;
      if (content.includes('\0'))
        throw new Error('텍스트 파일만 등록할 수 있습니다.');
      skillUpload = { fileName: file.name, ...parseSkillContent(content) };
      skillError = '';
    } catch (error) {
      if (
        request !== skillUploadRequest ||
        page !== 'skills' ||
        skillMode !== 'upload'
      )
        return;
      skillError = error instanceof Error ? error.message : String(error);
    }
    render();
    return;
  }
});
document.addEventListener('submit', async (event) => {
  const form = event.target as HTMLFormElement;
  if (!form.dataset.form) return;
  event.preventDefault();
  const fd = new FormData(form);
  const get = (name: string) => String(fd.get(name) || '');
  if (form.dataset.form === 'ai-policy') { await savePolicy(); return; }
  if (form.dataset.form === 'mcp-filter') {
    metricsFilter = { days: get('days'), employeeId: get('employeeId'), tool: get('tool') };
    await loadMetrics(); return;
  }
  if (form.dataset.form === 'task-search') {
    taskQuery = get('query').trim();
    render();
    return;
  }
  const idem =
    form.dataset.form +
    ':' +
    (form.dataset.session || form.dataset.org || 'new');
  try {
    let result: any;
    switch (form.dataset.form) {
      case 'employee':
        result = await api(
          '/api/employees',
          'POST',
          {
            name: get('name'),
            responsibility: get('responsibility'),
            role: get('role'),
            model: get('model'),
            label: get('label'),
            cwd: get('cwd'),
            persona: get('persona'),
            skillIds: fd.getAll('skillIds'),
          },
          idem
        );
        dirty = false;
        employeeEditor = null;
        break;
      case 'organization':
        result = await api(
          '/api/organizations',
          'POST',
          { name: get('name') },
          idem
        );
        detail.close();
        break;
      case 'assignment':
        result = await api(
          `/api/organizations/${form.dataset.org}/assignments`,
          'POST',
          {
            employeeId: get('employeeId'),
            supervisorId: get('supervisorId') || null,
          }
        );
        detail.close();
        break;
      case 'permission':
        result = await api(
          `/api/managers/${form.dataset.manager}/call-permissions`,
          'PUT',
          { workerIds: fd.getAll('workerIds') }
        );
        detail.close();
        break;
      case 'order':
        result = await api(
          '/api/work-orders',
          'POST',
          {
            title: get('title'),
            managerId: get('managerId'),
            body: get('body'),
            acceptance: get('acceptance'),
          },
          idem
        );
        workOrderTab = 'orders';
        detail.close();
        break;
      case 'skill': {
        try {
          const parsed =
            form.dataset.mode === 'upload'
              ? skillUpload
                ? parseSkillContent(skillUpload.content)
                : null
              : parseSkillContent(
                  skillContent(get('name'), get('description'), get('body'))
                );
          if (!parsed)
            throw new Error('먼저 유효한 SKILL.md 파일을 불러와 주세요.');
          result = await api(
            '/api/skills',
            'POST',
            { content: parsed.content },
            idem
          );
          if (form.dataset.mode === 'upload') skillUpload = null;
          else skillDraft = { name: '', description: '', body: '' };
          skillError = '';
        } catch (error) {
          skillError = error instanceof Error ? error.message : String(error);
          const message =
            document.querySelector<HTMLElement>('.skill-form-error');
          if (message) message.textContent = skillError;
          return;
        }
        break;
      }
      case 'persona':
        result = await api(
          '/api/personas',
          'POST',
          { name: get('name'), content: get('content') },
          idem
        );
        break;
      case 'schedule':
        result = await api(
          `/api/managers/${get('managerId')}/schedule`,
          'PUT',
          {
            cron: get('cron'),
            timezone: get('timezone'),
            enabled: get('enabled') === 'true',
            prompt: get('prompt'),
          }
        );
        detail.close();
        break;
      case 'log-source':
        result = await api('/api/settings/log-source', 'POST', {
          root: get('root'),
          expectedRevision: Number(form.dataset.revision),
        });
        break;
      case 'price': {
        const number = (name: string) => {
          const raw = get(name).trim();
          if (raw === '') return null;
          const value = Number(raw);
          if (!Number.isFinite(value) || value < 0)
            throw new Error('단가는 0 이상의 숫자 또는 공란으로 입력하세요.');
          return value;
        };
        result = await api(
          `/api/prices/${encodeURIComponent(get('model'))}`,
          'PUT',
          {
            input: number('input'),
            cachedInput: number('cachedInput'),
            output: number('output'),
          }
        );
        break;
      }
      case 'session-add':
        result = await api(
          `/api/employees/${form.dataset.employee}/sessions`,
          'POST',
          {
            label: get('label'),
            model: get('model'),
            persona: get('persona'),
            skillIds: fd.getAll('skillIds'),
          },
          idem
        );
        detail.close();
        break;
      case 'config':
        result = await api(
          `/api/sessions/${form.dataset.session}/config`,
          'PATCH',
          {
            expectedRevision: Number(form.dataset.revision),
            model: get('model'),
            persona: get('persona'),
            skillIds: fd.getAll('skillIds'),
          }
        );
        dirty = false;
        employeeEditor = null;
        detail.close();
        break;
      case 'interview':
        result = await api('/api/interviews', 'POST', {
          employeeId: get('employeeId'),
          topic: get('topic'),
        });
        selectedInterviewId = String(result.id);
        detail.close();
        break;
      case 'interview-message':
        result = await api(
          `/api/interviews/${form.dataset.interview}/messages`,
          'POST',
          { body: get('body') }
        );
        break;
    }
    toast(
      '저장했습니다.' +
        (result?.operationId ? ` Operation: ${result.operationId}` : '')
    );
    await refresh();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  }
});
document
  .querySelector('#detail-close')!
  .addEventListener('click', () => detail.close());
document
  .querySelector('#refresh')!
  .addEventListener(
    'click',
    () => void refresh().catch((error) => toast(String(error)))
  );
document.querySelector('#menu-toggle')!.addEventListener('click', () => {
  const open = document.querySelector('.shell')!.classList.toggle('nav-open');
  document
    .querySelector('#menu-toggle')!
    .setAttribute('aria-expanded', String(open));
});
document.querySelector('#sidebar-overlay')!.addEventListener('click', () => {
  document.querySelector('.shell')!.classList.remove('nav-open');
  document
    .querySelector('#menu-toggle')!
    .setAttribute('aria-expanded', 'false');
});
document.querySelector('#logout')!.addEventListener('click', () => {
  sessionStorage.removeItem('operator-token');
  token = '';
  login.showModal();
});
document
  .querySelector('#login-form')!
  .addEventListener('submit', async (event) => {
    event.preventDefault();
    token = (document.querySelector('#operator-token') as HTMLInputElement)
      .value;
    try {
      await refresh();
      sessionStorage.setItem('operator-token', token);
      login.close();
    } catch {
      document.querySelector('#login-error')!.textContent =
        '인증에 실패했습니다. 토큰을 확인하세요.';
      token = '';
    }
  });
window.addEventListener('beforeunload', (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
if (token)
  refresh().catch(() => {
    sessionStorage.removeItem('operator-token');
    token = '';
    login.showModal();
  });
else login.showModal();
