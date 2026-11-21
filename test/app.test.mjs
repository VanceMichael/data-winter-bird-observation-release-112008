import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { createApp } from '../app/server.mjs';
import { Ledger } from '../app/state.mjs';
import { STAGE_AS_OF } from '../app/sync.mjs';

async function startPair() {
  const source = createSource();
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceBase = `http://127.0.0.1:${source.address().port}`;

  const ledger = new Ledger();
  const app = createApp(ledger, sourceBase);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const appBase = `http://127.0.0.1:${app.address().port}`;

  return {
    sourceBase,
    appBase,
    close: async () => {
      await new Promise((resolve) => app.close(resolve));
      await new Promise((resolve) => source.close(resolve));
    },
  };
}

async function putClock(sourceBase, step) {
  const response = await fetch(`${sourceBase}/_source_clock?step=${step}`, { method: 'PUT' });
  assert.equal(response.status, 200);
}

async function sync(appBase, stage) {
  const response = await fetch(`${appBase}/internal/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, url);
  return response.json();
}

test('五阶段演练：批次事实、巡线覆盖、关联许可与公开撤回', async (context) => {
  const pair = await startPair();
  context.after(pair.close);
  const { sourceBase, appBase } = pair;

  // ---- walk：附件未到，东批缺附件事实；两段都已在，R-A 区间完整 ----
  await putClock(sourceBase, 'walk');
  const walk = await sync(appBase, 'walk');
  assert.equal(walk.round, 1);

  const walkCoverage = await getJson(`${appBase}/internal/coverage`);
  const ra = walkCoverage.find((r) => r.route === 'R-A');
  assert.equal(ra.complete, true);
  assert.deepEqual(ra.segments.find((s) => s.area === 'A1').gaps, []);
  assert.deepEqual(ra.segments.find((s) => s.area === 'A2').gaps, []);
  const rb = walkCoverage.find((r) => r.route === 'R-B');
  assert.equal(rb.complete, true);

  const walkFacts = await getJson(`${appBase}/internal/facts`);
  assert.ok(walkFacts.some((f) => f.kind === 'missing-attachment' && f.item === 'east:Y9' && f.status === 'open'));
  assert.ok(walkFacts.some((f) => f.kind === 'explicit-zero' && f.patrolId === 'N2'));
  assert.ok(walkFacts.some((f) => f.kind === 'explicit-zero' && f.segment === '/east/E9/2'));

  // 未核对的近似记录只提示人工：walk 时 Y9 还没定位，不产生候选。
  const walkLinks = await getJson(`${appBase}/internal/links`);
  assert.deepEqual(walkLinks.verified, []);
  assert.deepEqual(walkLinks.manualCandidates, []);

  let catalog = await getJson(`${appBase}/public/catalog`);
  const walkReleases = catalog.map((e) => e.release).sort();
  assert.deepEqual(walkReleases, [1, 2]); // O7 细格/小时，O8 粗格/天
  const o7Entry = catalog.find((e) => e.event === null && e.gridDigits === 6);
  assert.equal(o7Entry.grid, '410203');
  assert.equal(o7Entry.timeBucket, '2026-12-02T08:00:00Z');
  const o8Entry = catalog.find((e) => e.gridDigits === 4);
  assert.equal(o8Entry.grid, '4105');
  assert.equal(o8Entry.timeBucket, '2026-12-02');
  // 缺定位附件的 Y9 不能发布。
  assert.ok(!catalog.some((e) => e.grid.startsWith('410206')));

  // ---- partial：第 2 段 202，清单缺页事实打开，[900,1000) 重新成为缺口 ----
  await putClock(sourceBase, 'partial');
  await sync(appBase, 'partial');
  const partialFacts = await getJson(`${appBase}/internal/facts`);
  assert.ok(partialFacts.some((f) => f.kind === 'missing-part' && f.batch === 'E9' && f.status === 'open'));
  assert.ok(partialFacts.some((f) => f.kind === 'missing-attachment' && f.status === 'open'));
  const partialCoverage = await getJson(`${appBase}/internal/coverage`);
  const partialRa = partialCoverage.find((r) => r.route === 'R-A');
  assert.equal(partialRa.complete, false);
  assert.deepEqual(partialRa.segments.find((s) => s.area === 'A2').gaps, [[900, 1000]]);
  assert.ok(partialRa.segments.find((s) => s.area === 'A2').reasons
    .some((reason) => reason.kind === 'missing-part'));
  // 没有新的可发布内容，发布号不增长。
  catalog = await getJson(`${appBase}/public/catalog`);
  assert.deepEqual(catalog.map((e) => e.release).sort(), [1, 2]);

  // ---- attach：分段与附件齐了，缺页/缺附件事实关闭，A2 补齐 ----
  await putClock(sourceBase, 'attach');
  await sync(appBase, 'attach');
  const attachFacts = await getJson(`${appBase}/internal/facts`);
  assert.ok(!attachFacts.some((f) => (f.kind === 'missing-part' || f.kind === 'missing-attachment') && f.status === 'open'));
  assert.ok(attachFacts.some((f) => f.kind === 'missing-part' && f.status === 'resolved'));
  const attachCoverage = await getJson(`${appBase}/internal/coverage`);
  assert.equal(attachCoverage.find((r) => r.route === 'R-A').complete, true);
  assert.deepEqual(attachCoverage.find((r) => r.route === 'R-A').walked, [[0, 1000]]);
  // 上传批与实际巡线分别可识别。
  const eastWalker = attachCoverage
    .find((r) => r.route === 'R-A')
    .walkers.find((w) => w.org === 'east');
  assert.equal(eastWalker.patrolId, 'E1');
  assert.deepEqual(eastWalker.walked, [[600, 1000]]);

  // 迟到附件按原观测号补上定位，Y9 按自身许可（4 位/天）发布。
  catalog = await getJson(`${appBase}/public/catalog`);
  assert.deepEqual(catalog.map((e) => e.release).sort(), [1, 2, 3]);
  const y9 = catalog.find((e) => e.release === 3);
  assert.equal(y9.grid, '4102');
  assert.equal(y9.timeBucket, '2026-12-02');

  // 核对前先出现人工近似提示，不主动合并。
  const attachLinks = await getJson(`${appBase}/internal/links`);
  assert.deepEqual(attachLinks.verified, []);
  assert.deepEqual(attachLinks.manualCandidates.map((c) => c.members), [['east:Y9', 'north:O7']]);

  // ---- reconcile：核对关联 + 定位更正 + 加严 bound/embargo ----
  await putClock(sourceBase, 'reconcile');
  const reconcile = await sync(appBase, 'reconcile');
  const reconcileSequences = reconcile.newEntries.map((e) => e.sequence);
  assert.deepEqual(reconcileSequences, [4, 5]);
  // embargo 窗口内不产生新发布，只撤回旧的 O7、Y9（避免细格线索继续流出）。
  const kinds = Object.fromEntries(reconcile.newEntries.map((e) => [e.sequence, e.kind]));
  assert.equal(kinds[4], 'withdrawal');
  assert.equal(kinds[5], 'withdrawal');

  const reconcileLinks = await getJson(`${appBase}/internal/links`);
  assert.equal(reconcileLinks.verified[0].event, 'G11');
  assert.deepEqual(reconcileLinks.manualCandidates, []); // 已核对，人工提示清除

  // 内部明细仍可见合作方数据，且能看到定位更正。
  const y9Internal = await getJson(`${appBase}/internal/observations/east%3AY9`);
  assert.equal(y9Internal.location, '410209');
  assert.equal(y9Internal.locationRevises, '410206');
  assert.equal(y9Internal.publicUse.reason, 'embargo');
  assert.equal(y9Internal.publicUse.embargoUntil, '2026-12-03T00:00:00Z');
  const o7Internal = await getJson(`${appBase}/internal/observations/north%3AO7`);
  assert.equal(o7Internal.event, 'G11');

  catalog = await getJson(`${appBase}/public/catalog`);
  // embargo 窗口内整条同次观察不发布，目录只剩 O8。
  assert.deepEqual(catalog.map((e) => e.release), [2]);

  // 旧细格定位不得留在任何公开出口（目录、订阅补发、撤回消息）。
  const feed = await getJson(`${appBase}/public/feed?from=0`);
  const publicText = JSON.stringify(feed) + JSON.stringify(catalog)
    + JSON.stringify(await getJson(`${appBase}/public/withdrawals`));
  for (const secret of ['410203', '410206', '410209']) {
    assert.ok(!publicText.includes(secret), `公开出口泄露细格 ${secret}`);
  }
  // 撤回通知只有发布号与原因。
  const withdrawals = await getJson(`${appBase}/public/withdrawals`);
  assert.deepEqual(withdrawals, [
    { sequence: 4, ref: 1, reason: 'merged' },
    { sequence: 5, ref: 3, reason: 'merged' },
  ]);

  // 值守视角：校内终端只确认到 1，两条撤回都未送达。
  const duty = await getJson(`${appBase}/internal/duty/withdrawals`);
  assert.deepEqual(duty, [{
    subscriber: '校内阅览终端',
    ackThrough: 1,
    undelivered: [
      { sequence: 4, ref: 1, reason: 'merged' },
      { sequence: 5, ref: 3, reason: 'merged' },
    ],
  }]);

  // 巡护员可回看历轮派出时用的证据：第 2 轮（partial）A2 曾待补。
  const round2 = await getJson(`${appBase}/internal/rounds/2`);
  assert.equal(round2.round, 2);
  assert.deepEqual(round2.coverage.find((r) => r.route === 'R-A').missingAreas, ['A2']);
  const round1 = await getJson(`${appBase}/internal/rounds/1`);
  assert.equal(round1.round, 1);
  assert.deepEqual(round1.coverage.find((r) => r.route === 'R-A').missingAreas, []);

  // ---- expire：revoke O7 使用权，unbind 解除 bound，G11 仅靠 Y9 重新发布 ----
  await putClock(sourceBase, 'expire');
  const expire = await sync(appBase, 'expire');
  assert.deepEqual(expire.newEntries.map((e) => e.sequence), [6]);
  assert.equal(expire.newEntries[0].kind, 'release');

  catalog = await getJson(`${appBase}/public/catalog`);
  assert.deepEqual(catalog.map((e) => e.release).sort(), [2, 6]);
  const g11 = catalog.find((e) => e.release === 6);
  assert.equal(g11.event, 'G11');
  assert.equal(g11.gridDigits, 4);
  assert.equal(g11.grid, '4102');
  assert.equal(g11.time, 'day');
  assert.equal(g11.timeBucket, '2026-12-02');

  // O7 的 grant 被撤回：内部明细标记不可公开，但巡护明细仍在。
  const o7Expire = await getJson(`${appBase}/internal/observations/north%3AO7`);
  assert.equal(o7Expire.publicUse.usable, false);
  assert.equal(o7Expire.publicUse.reason, 'no-grant');
  assert.equal(o7Expire.location, '410203'); // 内部合作方明细仍可见
  // 内部凭据走公开出口也无法恢复已撤定位。
  const expirePublicText = JSON.stringify(await getJson(`${appBase}/public/feed?from=0`))
    + JSON.stringify(await getJson(`${appBase}/public/catalog`));
  for (const secret of ['410203', '410206', '410209']) {
    assert.ok(!expirePublicText.includes(secret), `撤回后公开出口仍带细格 ${secret}`);
  }

  // 市级交换确认到 3：撤回 4、5 未送达，发布 6 也未送达；校内仍停在 1。
  const dutyExpire = await getJson(`${appBase}/internal/duty/withdrawals`);
  assert.deepEqual(dutyExpire.map((d) => d.subscriber), ['校内阅览终端', '市级数据交换']);
  assert.deepEqual(dutyExpire.find((d) => d.subscriber === '市级数据交换').undelivered, [
    { sequence: 4, ref: 1, reason: 'merged' },
    { sequence: 5, ref: 3, reason: 'merged' },
  ]);

  // 续取游标：订阅方按发布号续取，含撤回通知且不含旧载荷。
  const resume = await getJson(`${appBase}/public/feed?from=3`);
  assert.equal(resume.next, 6);
  assert.deepEqual(resume.entries.map((e) => e.sequence), [4, 5, 6]);
  assert.ok(resume.entries.filter((e) => e.kind === 'withdrawal')
    .every((e) => e.grid === undefined && e.timeBucket === undefined));

  // 历史轮次证据完整保留。
  const rounds = await getJson(`${appBase}/internal/rounds`);
  assert.equal(rounds.length, 5);
  assert.equal(STAGE_AS_OF.expire, '2026-12-03T13:00:00Z');
});
