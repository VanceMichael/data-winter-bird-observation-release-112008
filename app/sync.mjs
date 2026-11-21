// 同步编排：每轮把两个来源、许可流和订阅确认汇入账本，
// 重新核对路线片区覆盖与公开发布，并保存本轮派出所用证据。

import { coverageByRoute } from './coverage.mjs';
import { buildVerifiedGroups, findManualCandidates } from './links.mjs';
import { ingestEast, ingestNorth, mergeIntoLedger } from './ingest.mjs';
import { reconcileReleases } from './release.mjs';
import {
  fetchAcks, fetchAreas, fetchEast, fetchNorth, fetchRegistry,
} from './source-client.mjs';

// 演练阶段对应的“当前时刻”，用于许可生效时段判断；可被 asOf 覆盖。
export const STAGE_AS_OF = {
  walk: '2026-12-02T09:00:00Z',
  partial: '2026-12-02T12:00:00Z',
  attach: '2026-12-02T14:00:00Z',
  reconcile: '2026-12-02T16:00:00Z',
  expire: '2026-12-03T13:00:00Z',
};

function openGapReasons(route, facts) {
  return facts
    .filter((fact) => fact.status === 'open' && fact.route === route)
    .map((fact) => ({ kind: fact.kind, detail: fact.detail, key: fact.key }));
}

function enrichCoverage(coverage, facts) {
  return coverage.map((route) => ({
    ...route,
    reasons: openGapReasons(route.route, facts),
    segments: route.segments.map((segment) => ({
      ...segment,
      reasons: segment.covered
        ? []
        : openGapReasons(route.route, facts),
    })),
  }));
}

export async function syncOnce(ledger, baseUrl, options = {}) {
  const round = ledger.nextRoundInput();
  const asOf = options.asOf ?? STAGE_AS_OF[options.stage] ?? new Date().toISOString();

  const [areas, northSnapshot, eastSnapshot, registry, acks] = await Promise.all([
    fetchAreas(baseUrl),
    fetchNorth(baseUrl),
    fetchEast(baseUrl),
    fetchRegistry(baseUrl),
    fetchAcks(baseUrl),
  ]);

  const north = ingestNorth(northSnapshot, asOf);
  const east = ingestEast(eastSnapshot, asOf);
  mergeIntoLedger(ledger, north, east, round);

  ledger.groups = buildVerifiedGroups(registry.links);
  ledger.manualCandidates = findManualCandidates([...ledger.observations.values()], ledger.groups);
  ledger.permissions = registry.permissions;
  ledger.acks = acks;

  const coverage = enrichCoverage(
    coverageByRoute(areas, [...ledger.patrols.values()]),
    ledger.facts,
  );
  ledger.coverage = coverage;

  const result = reconcileReleases({
    ledger,
    groups: ledger.groups,
    permissions: ledger.permissions,
    asOf,
    sequenceStart: ledger.sequence,
  });
  ledger.releases.push(...result.entries);
  ledger.sequence = result.nextSequence;

  // 本轮巡护派出时用的证据快照（内部可见，公开出口不读取）。
  const evidence = {
    round,
    at: asOf,
    stage: options.stage ?? null,
    coverage: coverage.map((route) => ({
      route: route.route,
      complete: route.complete,
      walkers: route.walkers,
      missingAreas: route.segments.filter((s) => !s.covered).map((s) => s.area),
    })),
    observations: [...ledger.observations.values()].map((o) => ({
      item: o.item,
      time: o.time,
      location: o.location,
      cancelled: o.cancelled,
      attachmentPending: o.attachmentPending,
    })),
    facts: ledger.facts.map((fact) => ({ ...fact })),
  };
  ledger.rounds.push(evidence);

  return {
    round,
    asOf,
    coverage,
    evaluations: result.evaluations,
    entries: result.entries,
    evidence,
  };
}
