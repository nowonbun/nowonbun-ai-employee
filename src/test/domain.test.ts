import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexArgs, parseSkill, progress, retryAt } from '../app/domain.ts';

test('SKILL.md의 frontmatter와 본문을 검증하고 정규화한다', () => {
  const value = parseSkill('---\nname: review\ndescription: 품질 확인\n---\n검증을 수행한다.\n');
  assert.equal(value.name, 'review');
  assert.equal(value.description, '품질 확인');
  assert.equal(value.body, '검증을 수행한다.');
  assert.equal(value.canonical, '---\nname: review\ndescription: 품질 확인\n---\n검증을 수행한다.\n');
  assert.throws(() => parseSkill('---\nname: review\n---\n본문'), /description/);
});

test('유한 Task의 진행률은 근거가 있는 가중치만으로 계산한다', () => {
  assert.equal(progress([]), null);
  assert.equal(progress([
    { id: 'a', label: 'A', weight: 2, verified: true, evidence: 'artifact-1' },
    { id: 'b', label: 'B', weight: 1, verified: true },
    { id: 'c', label: 'C', weight: 1, verified: false }
  ]), 50);
});

test('허용된 일시 종료 후 재개까지 최소 60초를 기다린다', () => {
  assert.equal(retryAt(1_000, null, true), 61_000);
  assert.equal(retryAt(1_000, 181_000, true), 181_000);
  assert.equal(retryAt(1_000, null, false), null);
});

test('Codex는 명시한 Session ID로 재개하며 셸을 거치지 않는 인수를 구성한다', () => {
  assert.deepEqual(buildCodexArgs('gpt-6.1-sol', null, '/workspace'), ['exec', '--json', '--model', 'gpt-6.1-sol', '-C', '/workspace', '-']);
  assert.deepEqual(buildCodexArgs('gpt-6.1-sol', '11111111-1111-4111-8111-111111111111', '/workspace'), ['exec', 'resume', '--json', '--model', 'gpt-6.1-sol', '11111111-1111-4111-8111-111111111111', '-']);
});
