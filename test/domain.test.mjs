import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  combineGrains, gridAt, hourBucket, dayBucket, timeBucketAt,
} from '../app/code.mjs';
import { licenseForItem } from '../app/permissions.mjs';
import { mergeIntervals, subtractIntervals } from '../app/coverage.mjs';
import { ingestEast, ingestNorth, mergeObservation, normalizeWalked } from '../app/ingest.mjs';

const AT = '2026-12-02T12:00:00Z';

test('嵌套编码表：网格截断与时间桶', () => {
  assert.equal(gridAt('410203', 2), '41');
  assert.equal(gridAt('410203', 4), '4102');
  assert.equal(gridAt('410203', 6), '410203');
  assert.equal(dayBucket('2026-12-02T08:11:00Z'), '2026-12-02');
  assert.equal(hourBucket('2026-12-02T08:11:00Z'), '2026-12-02T08:00:00Z');
  assert.equal(timeBucketAt('2026-12-02T08:11:00Z', 'day'), '2026-12-02');
  assert.throws(() => gridAt('41023', 4), /非法网格/);
  // 联合粒度只取共同允许的最粗一档。
  assert.deepEqual(combineGrains([
    { gridDigits: 6, time: 'hour' },
    { gridDigits: 4, time: 'day' },
  ]), { gridDigits: 4, time: 'day' });
  assert.equal(combineGrains([]), null);
});

test('许可时间线：grant/bound/unbind/revoke 按生效时段独立判断', () => {
  const events = [
    { id: 'G1', op: 'grant', item: 'x:1', gridDigits: 6, time: 'hour', from: '2026-12-02T00:00:00Z' },
    { id: 'G2', op: 'grant', item: 'x:2', gridDigits: 6, time: 'hour', from: '2026-12-02T00:00:00Z' },
    { id: 'B1', op: 'bound', item: 'x:1', gridDigits: 2, time: 'day', from: '2026-12-02T15:00:00Z', embargoUntil: '2026-12-03T00:00:00Z' },
    { op: 'revoke', ref: 'G2', from: '2026-12-03T00:00:00Z' },
    { op: 'unbind', ref: 'B1', from: '2026-12-03T12:00:00Z' },
  ];

  // bound 生效前：细格/小时可用。
  assert.deepEqual(licenseForItem(events, 'x:1', '2026-12-02T14:00:00Z').grain, { gridDigits: 6, time: 'hour' });
  // bound 生效且 embargo 未结束：整条等待窗口。
  const embargoed = licenseForItem(events, 'x:1', '2026-12-02T16:00:00Z');
  assert.equal(embargoed.usable, false);
  assert.equal(embargoed.reason, 'embargo');
  assert.equal(embargoed.embargoUntil, '2026-12-03T00:00:00Z');
  // embargo 已过、bound 仍在：可用但粒度被压到片区/天。
  const bounded = licenseForItem(events, 'x:1', '2026-12-03T09:00:00Z');
  assert.equal(bounded.usable, true);
  assert.deepEqual(bounded.grain, { gridDigits: 2, time: 'day' });
  // unbind 后恢复原 grant 粒度。
  assert.deepEqual(licenseForItem(events, 'x:1', '2026-12-03T13:00:00Z').grain, { gridDigits: 6, time: 'hour' });

  // 单纯撤回一条记录：x:2 不可用，但不影响 x:1。
  assert.equal(licenseForItem(events, 'x:2', '2026-12-03T13:00:00Z').usable, false);
  assert.equal(licenseForItem(events, 'x:1', '2026-12-03T13:00:00Z').usable, true);
  // 从未授权的记录。
  assert.equal(licenseForItem(events, 'x:9', '2026-12-03T13:00:00Z').reason, 'no-grant');
});

test('区间运算：半开区间合并与扣除，观测不补足覆盖', () => {
  assert.deepEqual(mergeIntervals([[0, 300], [300, 600], [700, 800]]), [[0, 600], [700, 800]]);
  assert.deepEqual(subtractIntervals([0, 1000], [[0, 600], [900, 1000]]), [[600, 900]]);
  assert.deepEqual(subtractIntervals([600, 1000], [[600, 900]]), [[900, 1000]]);
  assert.deepEqual(subtractIntervals([0, 800], [[0, 800]]), []);
  assert.deepEqual(normalizeWalked([0, 600]), [[0, 600]]);
  assert.deepEqual(normalizeWalked([[600, 900], [900, 1000]]), [[600, 900], [900, 1000]]);
});

test('北组织同号再来：补照片不覆盖定位，revises 才更正，cancelled 取消观测', () => {
  const first = ingestNorth({
    patrols: [{
      id: 'N1', route: 'R-A', walked: [0, 600],
      observations: [{ id: 'O7', location: '410203', time: '2026-12-02T08:00:00Z' }],
    }],
  }, AT);
  const again = ingestNorth({
    patrols: [{
      id: 'N1', route: 'R-A', walked: [0, 600],
      observations: [{ id: 'O7', location: '410299', time: '2026-12-02T08:00:00Z' }],
    }],
  }, AT);
  // 第二次没有 revises：视为补件，经账本合并后保留原定位。
  const merged = mergeObservation(first.observations.get('north:O7'), again.observations.get('north:O7'));
  assert.equal(merged.location, '410203');

  const correction = ingestNorth({
    patrols: [{
      id: 'N1', route: 'R-A', walked: [0, 600],
      observations: [{ id: 'O7', location: '410209', revises: '410203', time: '2026-12-02T08:00:00Z' }],
    }],
  }, AT);
  assert.equal(correction.observations.get('north:O7').location, '410209');
  assert.equal(correction.observations.get('north:O7').locationRevises, '410203');

  const cancelled = ingestNorth({
    patrols: [{
      id: 'N1', route: 'R-A', walked: [0, 600],
      observations: [{ id: 'O7', cancelled: true, time: '2026-12-02T08:00:00Z' }],
    }],
  }, AT);
  assert.equal(cancelled.observations.get('north:O7').cancelled, true);

  // 明确零只产生事实，空巡线不产生观测。
  const zero = ingestNorth({ patrols: [{ id: 'N2', route: 'R-B', walked: [0, 800], observations: [] }] }, AT);
  assert.equal(zero.observations.size, 0);
  assert.deepEqual(zero.facts.map((f) => f.kind), ['explicit-zero']);
});

test('东组织：缺页与缺附件分别成事实，迟到附件按原观测号补定位', () => {
  const snapshot = {
    sets: [{ batch: 'E9', declaredParts: 3, segments: ['/east/E9/1', '/east/E9/2', '/east/E9/3'] }],
    segments: {
      '/east/E9/1': {
        patrol: 'E1', route: 'R-A', walked: [600, 900],
        observations: [{ id: 'Y9', time: '2026-12-02T08:13:00Z', attachment: '/east/media/L9' }],
      },
      '/east/E9/2': { state: 'pending' },
    },
    media: { '/east/media/L9': { state: 'pending' } },
  };
  const result = ingestEast(snapshot, AT);
  assert.deepEqual(result.facts.filter((f) => f.kind === 'missing-part').map((f) => f.part), [2, 3]);
  assert.ok(result.facts.some((f) => f.kind === 'missing-attachment' && f.item === 'east:Y9'));
  // 未就绪分段不贡献巡线区间，缺定位的观测不发布定位。
  assert.deepEqual(result.patrols[0].walked, [[600, 900]]);
  assert.equal(result.observations.get('east:Y9').location, null);
  assert.equal(result.observations.get('east:Y9').attachmentPending, '/east/media/L9');

  const arrived = ingestEast({
    ...snapshot,
    media: { '/east/media/L9': { observation: 'Y9', location: '410206', recordedAt: AT } },
  }, AT);
  assert.equal(arrived.observations.get('east:Y9').location, '410206');

  // 迟到附件再次到达且未声明 revises：只是补件，不能推翻已采用的定位。
  const previous = arrived.observations.get('east:Y9');
  const supplement = ingestEast({
    ...snapshot,
    media: { '/east/media/L9': { observation: 'Y9', location: '410288', recordedAt: AT } },
  }, AT).observations.get('east:Y9');
  assert.equal(mergeObservation(previous, supplement).location, '410206');

  // 明确带 revises 的迟到附件才是定位更正。
  const correction = ingestEast({
    ...snapshot,
    media: { '/east/media/L9': { observation: 'Y9', location: '410209', revises: '410206' } },
  }, AT).observations.get('east:Y9');
  assert.equal(mergeObservation(previous, correction).location, '410209');
});
