import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../app/store.ts';
import { AdminService } from '../app/admin-service.ts';
import { Governance } from '../app/governance.ts';

const service = (store: Store) => new AdminService(store, { workspaceRoot: process.cwd(), codexHome: process.cwd(), modelChoices: ['gpt-6.1-sol'], ports: { web: 3000, internalMcp: 3001, adminMcp: 3002 } });
const skillText = (body: string) => `---\nname: shared\ndescription: 공통 지침\n---\n${body}\n`;

test('직원 제거는 이력을 남기고 토큰·작업을 회수하며 조직 순환·비어 있지 않은 조직 제거를 막는다', async () => {
  const store = new Store(':memory:');
  try {
    const api = service(store);
    const call = async (name: string, args: object) => (await api.execute(name, args) as any).result;
    const org = await call('organization_create', { name: '상위', idempotencyKey: 'parent' });
    const child = await call('organization_create', { name: '하위', parentId: org.organizationId, idempotencyKey: 'child' });
    await assert.rejects(api.execute('organization_update', { organizationId: org.organizationId, parentId: child.organizationId, name: '상위', expectedRevision: 1, idempotencyKey: 'cycle' }), /INVALID_INPUT/);
    const employee = await call('employee_create', { name: '검증 AI', responsibility: '테스트', role: 'worker', model: 'gpt-6.1-sol', idempotencyKey: 'employee' });
    await call('employee_assign', { employeeId: employee.employeeId, organizationId: child.organizationId, idempotencyKey: 'assign' });
    await assert.rejects(api.execute('organization_delete', { organizationId: child.organizationId, expectedRevision: 1, confirm: true, idempotencyKey: 'nonempty' }), /CONFLICT/);
    store.tokenIssue(employee.employeeId);
    const before = store.get('employees', employee.employeeId)!;
    await call('employee_delete', { employeeId: employee.employeeId, expectedRevision: before.revision, confirm: true, idempotencyKey: 'deactivate' });
    assert.equal(store.get('employees', employee.employeeId)!.status, 'inactive');
    assert.equal(store.rows('SELECT * FROM mcp_tokens').length, 0);
    assert.ok(store.rows('SELECT * FROM sessions WHERE employee_id=?', employee.employeeId).length);
    assert.equal(store.row('SELECT status FROM jobs WHERE employee_id=?', employee.employeeId)!.status, 'cancelled');
    await call('organization_delete', { organizationId: child.organizationId, expectedRevision: 1, confirm: true, idempotencyKey: 'archive-org' });
    await assert.rejects(api.execute('employee_restore', { employeeId: employee.employeeId, expectedRevision: Number(before.revision) + 1, idempotencyKey: 'restore-too-early' }), /NOT_FOUND/);
    await call('resource_restore', { resource: 'organizations', id: child.organizationId, idempotencyKey: 'restore-org' });
    await call('employee_restore', { employeeId: employee.employeeId, expectedRevision: Number(before.revision) + 1, idempotencyKey: 'restore' });
    assert.equal(store.get('employees', employee.employeeId)!.status, 'active');
    assert.equal(store.rows('SELECT * FROM mcp_tokens').length, 0);
  } finally { store.close(); }
});

test('페르소나 버전·보관·복원과 커서 조회는 원본 이력을 유지한다', async () => {
  const store = new Store(':memory:');
  try {
    const api = service(store);
    const created = await api.execute('persona_create', { name: '검토자', content: '첫 지침', idempotencyKey: 'p' }) as any;
    const id = created.result.personaId;
    await api.execute('persona_update', { personaId: id, expectedRevision: 1, name: '검토자', content: '새 지침', idempotencyKey: 'edit' });
    await api.execute('persona_delete', { personaId: id, expectedRevision: 2, confirm: true, idempotencyKey: 'archive' });
    assert.equal(store.list('personas').length, 0);
    const page = await api.execute('records_list', { table: 'persona_versions', limit: 1 }) as any;
    assert.equal(page.records.length, 1);
    assert.ok(page.nextCursor);
    const next = await api.execute('records_list', { table: 'persona_versions', limit: 1, cursor: page.nextCursor }) as any;
    assert.equal(next.records.length, 1);
    assert.equal(next.nextCursor, null);
    await api.execute('resource_restore', { resource: 'personas', id, idempotencyKey: 'restore' });
    assert.equal(store.get('personas', id)!.content, '새 지침');
  } finally { store.close(); }
});

test('외부 부작용의 결과가 불명이면 같은 키 재전송으로 실행하지 않는다', async () => {
  const store = new Store(':memory:');
  try {
    const api = service(store);
    const input = { sessionId: '11111111-1111-4111-8111-111111111111', idempotencyKey: 'unknown' };
    await assert.rejects(api.execute('session_reindex', input), /결과 재조회/);
    const row = store.row('SELECT * FROM admin_operations WHERE idem_key=?', 'unknown')!;
    assert.equal(row.status, 'unknown');
    await assert.rejects(api.execute('session_reindex', input), /CONFLICT/);
    assert.equal(store.rows('SELECT * FROM admin_operations WHERE idem_key=?', 'unknown').length, 1);
    const operation = await api.execute('admin_operation_get', { operationId: row.id }) as any;
    assert.equal(operation.status, 'unknown');
  } finally { store.close(); }
});

test('관리 도구의 usage·readme는 실제 카탈로그·파라미터와 시스템 경계를 설명한다', async () => {
  const store = new Store(':memory:');
  try {
    const api = service(store);
    const names = api.tools().map(tool => tool.name);
    for (const name of ['usage', 'readme', 'employee_create', 'employee_update', 'employee_delete', 'organization_create', 'organization_update', 'organization_delete', 'skill_create', 'skill_update', 'skill_delete', 'ai_policy_get', 'ai_policy_set', 'ai_policy_clear']) assert.ok(names.includes(name), name);
    const usage = await api.execute('usage', { tool: 'employee_create' }) as any;
    assert.equal(usage.tools[0].name, 'employee_create');
    assert.ok(usage.tools[0].inputSchema.properties.idempotencyKey);
    assert.ok(JSON.stringify(await api.execute('readme', {})).includes('이력'));
    await assert.rejects(api.execute('unknown', {}), /NOT_FOUND/);
    await assert.rejects(api.execute('records_list', { table: 'mcp_tokens' }), /INVALID_INPUT/);
  } finally { store.close(); }
});

test('스킬 수정은 버전을 보존하고 공통 정책의 이전 확정 버전을 소급 변경하지 않는다', async () => {
  const store = new Store(':memory:');
  try {
    const api = service(store);
    const created = await api.execute('skill_create', { content: skillText('첫 지침'), idempotencyKey: 'skill' }) as any;
    const id = created.result.skillId;
    await api.execute('ai_policy_set', { skillIds: [id], expectedRevision: 1, confirm: true, idempotencyKey: 'policy' });
    await api.execute('skill_update', { skillId: id, content: skillText('둘째 지침'), expectedRevision: 1, idempotencyKey: 'edit' });
    const snapshot = new Governance(store).resolveSkills({ revision: 1, skill_ids: '[]' });
    assert.equal(snapshot.skills[0]?.version, 1);
    assert.match(snapshot.skills[0]!.content, /첫 지침/);
    const preview = await api.execute('ai_policy_preview', { skillIds: [id] }) as any;
    assert.deepEqual(preview.updatedVersions, [id]);
    assert.equal(preview.commonSkills[0].version, 2);
    assert.equal(new Governance(store).policy().revision, 2);
    await assert.rejects(api.execute('skill_delete', { skillId: id, expectedRevision: 2, confirm: true, idempotencyKey: 'delete-referenced' }), /CONFLICT/);
    await api.execute('ai_policy_clear', { expectedRevision: 2, confirm: true, idempotencyKey: 'clear' });
    await api.execute('skill_delete', { skillId: id, expectedRevision: 2, confirm: true, idempotencyKey: 'delete' });
    assert.equal(store.get('skills', id), undefined);
    assert.equal(store.rows('SELECT * FROM skill_versions WHERE skill_id=?', id).length, 2);
    assert.equal(new Governance(store).policyView().history.length, 3);
  } finally { store.close(); }
});

test('관리 쓰기는 멱등·감사·revision·경로 경계를 적용하고 실패 시 원자적으로 롤백한다', async () => {
  const store = new Store(':memory:');
  try {
    const api = service(store);
    const input = { name: '조직', idempotencyKey: 'org' };
    const created = await api.execute('organization_create', input) as any;
    assert.deepEqual(await api.execute('organization_create', input), created);
    await assert.rejects(api.execute('organization_create', { ...input, name: '다른 조직' }), /CONFLICT/);
    const id = created.result.organizationId;
    await api.execute('organization_update', { organizationId: id, name: '변경', parentId: null, expectedRevision: 1, idempotencyKey: 'edit' });
    await assert.rejects(api.execute('organization_update', { organizationId: id, name: '오래된 편집', parentId: null, expectedRevision: 1, idempotencyKey: 'stale' }), /CONFLICT/);
    await assert.rejects(api.execute('employee_create', { name: 'AI', responsibility: '검토', role: 'worker', model: 'gpt-6.1-sol', cwd: 'C:/', idempotencyKey: 'outside' }), /FORBIDDEN|INVALID_INPUT/);
    store.db.exec("CREATE TRIGGER reject_admin_audit BEFORE INSERT ON audit_events WHEN NEW.actor='external-admin' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END;");
    await assert.rejects(api.execute('organization_create', { name: '롤백', idempotencyKey: 'rollback' }));
    assert.equal(store.row('SELECT id FROM organizations WHERE name=?', '롤백'), undefined);
    assert.equal(store.row('SELECT id FROM admin_operations WHERE idem_key=?', 'rollback'), undefined);
  } finally { store.close(); }
});
