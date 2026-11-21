import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../app/state.mjs';
import { reconcileReleases, publicCatalog, publicFeed } from '../app/release.mjs';
import { buildVerifiedGroups } from '../app/links.mjs';

const AS_OF = '2026-12-03T13:00:00Z';

function ledgerWith(observations, releases = []) {
  const ledger = new Ledger();
  for (const observation of observations) ledger.observations.set(observation.item, observation);
  ledger.releases = releases;
  return ledger;
}

const permissions = [
  { id: 'G7', op: 'grant', item: 'north:O7', gridDigits: 6, time: 'hour', from: '2026-12-02T00:00:00Z' },
  { id: 'G9', op: 'grant', item: 'east:Y9', gridDigits: 4, time: 'day', from: '2026-12-02T00:00:00Z' },
  { id: 'G8', op: 'grant', item: 'north:O8', gridDigits: 4, time: 'day', from: '2026-12-02T00:00:00Z' },
];

const obs = [
  { item: 'north:O7', org: 'north', id: 'O7', location: '410203', time: '2026-12-02T08:11:00Z', cancelled: false, versions: [] },
  { item: 'east:Y9', org: 'east', id: 'Y9', location: '410209', locationRevises: '410206', time: '2026-12-02T08:13:00Z', cancelled: false, versions: [] },
  { item: 'north:O8', org: 'north', id: 'O8', location: '410504', time: '2026-12-02T10:00:00Z', cancelled: false, versions: [] },
];

test('同次观察联合发布只使用共同允许的一个粒度', () => {
  const ledger = ledgerWith(obs);
  const groups = buildVerifiedGroups([{ event: 'G11', members: ['north:O7', 'east:Y9'], status: 'verified' }]);
  const result = reconcileReleases({
    ledger, groups, permissions, asOf: AS_OF, sequenceStart: 0,
  });
  const release = result.entries.find((e) => e.kind === 'release' && e.event === 'G11');
  assert.deepEqual(release.members, ['north:O7', 'east:Y9']);
  assert.equal(release.publicPayload.gridDigits, 4);
  assert.equal(release.publicPayload.grid, '4102');
  assert.equal(release.publicPayload.time, 'day');
  assert.equal(release.publicPayload.timeBucket, '2026-12-02');
  // 锚点来自当前可用成员 Y9；内部保留其细格，公开序列化不含细格。
  assert.equal(release.internal.location, '410209');
  assert.equal(release.location, undefined);
  const feedText = JSON.stringify(publicFeed(ledger.releases.concat(result.entries)));
  assert.ok(!feedText.includes('410203') && !feedText.includes('410209'));
});

test('某项明确禁止即时公开时整条同次观察等待窗口', () => {
  const ledger = ledgerWith(obs);
  const groups = buildVerifiedGroups([{ event: 'G11', members: ['north:O7', 'east:Y9'], status: 'verified' }]);
  const withEmbargo = permissions.concat([{
    id: 'B1', op: 'bound', item: 'east:Y9', gridDigits: 2, time: 'day',
    from: '2026-12-02T15:00:00Z', embargoUntil: '2026-12-04T00:00:00Z',
  }]);
  const result = reconcileReleases({
    ledger, groups, permissions: withEmbargo, asOf: AS_OF, sequenceStart: 0,
  });
  assert.ok(!result.entries.some((e) => e.kind === 'release' && e.event === 'G11'));
  const evaluation = result.evaluations.find((e) => e.key === 'event:G11');
  assert.equal(evaluation.status, 'embargoed');
  assert.equal(evaluation.embargoUntil, '2026-12-04T00:00:00Z');
  // 未关联的 O8 不受影响。
  assert.ok(result.entries.some((e) => e.key === 'item:north:O8' && e.kind === 'release'));
});

test('撤回一条证据只撤其使用权，同次观察可由其余成员继续发布', () => {
  const ledger = ledgerWith(obs);
  const groups = buildVerifiedGroups([{ event: 'G11', members: ['north:O7', 'east:Y9'], status: 'verified' }]);
  const revoked = permissions.concat([{ op: 'revoke', ref: 'G7', from: '2026-12-03T00:00:00Z' }]);
  const result = reconcileReleases({
    ledger, groups, permissions: revoked, asOf: AS_OF, sequenceStart: 0,
  });
  const release = result.entries.find((e) => e.kind === 'release' && e.event === 'G11');
  assert.deepEqual(release.members, ['east:Y9']);
  assert.equal(release.publicPayload.gridDigits, 4);
  const evaluation = result.evaluations.find((e) => e.key === 'event:G11');
  assert.equal(evaluation.memberResults.find((m) => m.item === 'north:O7').usable, false);
  assert.equal(evaluation.memberResults.find((m) => m.item === 'east:Y9').usable, true);
});

test('已发布定位被更严粒度替代时先撤回，旧位置不进目录与补发', () => {
  const prior = [{
    kind: 'release', sequence: 1, key: 'item:north:O8', event: null, state: 'published',
    publicPayload: { grid: '410504', timeBucket: '2026-12-02T10:00:00Z', gridDigits: 6, time: 'hour' },
    internal: { location: '410504', time: '2026-12-02T10:00:00Z' }, at: AS_OF,
  }];
  const ledger = ledgerWith(obs, prior);
  const stricter = permissions.map((p) => (p.id === 'G8' ? { ...p, gridDigits: 2, time: 'day' } : p));
  const result = reconcileReleases({
    ledger, groups: buildVerifiedGroups([]), permissions: stricter, asOf: AS_OF, sequenceStart: 1,
  });
  const o8Entries = result.entries.filter((e) => e.key === 'item:north:O8');
  assert.equal(o8Entries[0].kind, 'withdrawal');
  assert.equal(o8Entries[0].ref, 1);
  assert.equal(o8Entries[1].kind, 'release');
  assert.equal(o8Entries[1].publicPayload.grid, '41');

  const all = ledger.releases.concat(result.entries);
  const catalog = publicCatalog(all);
  const o8Catalog = catalog.filter((e) => e.grid === '41');
  assert.deepEqual(o8Catalog.map((e) => e.release), [5]);
  const feed = publicFeed(all, 0);
  // 旧发布在流里变成 redacted，撤回通知与新条目都不含细格。
  assert.ok(!JSON.stringify(feed).includes('410504'));
  assert.deepEqual(feed.map((e) => e.kind), ['redacted', 'release', 'release', 'withdrawal', 'release']);
});

test('取消的观测不再产生发布单元，已发布的要撤回', () => {
  const prior = [{
    kind: 'release', sequence: 1, key: 'item:north:O8', event: null, state: 'published',
    publicPayload: { grid: '4105', timeBucket: '2026-12-02', gridDigits: 4, time: 'day' },
    internal: { location: '410504', time: '2026-12-02T10:00:00Z' }, at: AS_OF,
  }];
  const cancelled = obs.map((o) => (o.item === 'north:O8' ? { ...o, cancelled: true } : o));
  const ledger = ledgerWith(cancelled, prior);
  const result = reconcileReleases({
    ledger, groups: buildVerifiedGroups([]), permissions, asOf: AS_OF, sequenceStart: 1,
  });
  const o8Entries = result.entries.filter((e) => e.key === 'item:north:O8');
  assert.deepEqual(o8Entries.map((e) => [e.kind, e.reason]), [['withdrawal', 'cancelled']]);
  assert.deepEqual(publicCatalog(ledger.releases.concat(result.entries))
    .map((e) => e.event ?? e.grid), ['410203', '4102']);
});
