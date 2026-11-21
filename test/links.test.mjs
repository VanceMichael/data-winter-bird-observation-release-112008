import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVerifiedGroups, findManualCandidates, memberToEvent } from '../app/links.mjs';

const observations = [
  { item: 'north:O7', org: 'north', location: '410203', time: '2026-12-02T08:11:00Z' },
  { item: 'east:Y9', org: 'east', location: '410209', time: '2026-12-02T08:13:00Z' },
  { item: 'east:Z3', org: 'east', location: '410504', time: '2026-12-02T10:00:00Z' },
  { item: 'north:Q1', org: 'north', location: '410277', time: '2026-12-02T11:30:00Z' },
];

test('只有 verified 登记进入同次观察组', () => {
  const groups = buildVerifiedGroups([
    { event: 'G11', members: ['north:O7', 'east:Y9'], status: 'verified' },
    { event: 'G99', members: ['north:Q1'], status: 'pending' },
  ]);
  assert.deepEqual([...groups.keys()], ['G11']);
  assert.deepEqual(memberToEvent(groups).get('east:Y9'), 'G11');
  assert.equal(memberToEvent(groups).get('north:Q1'), undefined);
});

test('未核对的时间地点近似只提示人工，跨粗格或超时不提示', () => {
  const candidates = findManualCandidates(observations, buildVerifiedGroups([]));
  assert.deepEqual(candidates.map((c) => c.members), [['east:Y9', 'north:O7']]);
  assert.equal(candidates[0].reason, 'unverified-approximate');
  assert.equal(candidates[0].gridPrefix, '4102');
  assert.equal(candidates[0].minutesApart, 2);
  // 同组织不配对；粗格不同（4105 vs 4102）不配对；相差超过 30 分钟不配对。
  assert.ok(!candidates.some((c) => c.members.includes('east:Z3')));
  assert.ok(!candidates.some((c) => c.members.includes('north:Q1')));
});

test('核对关联建立后，近似候选不再提示（不重复合并）', () => {
  const groups = buildVerifiedGroups([
    { event: 'G11', members: ['north:O7', 'east:Y9'], status: 'verified' },
  ]);
  assert.deepEqual(findManualCandidates(observations, groups), []);
});
