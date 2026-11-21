// 公开出口发布引擎。
// 规则要点：
// - 只按合成许可限定的最细网格/时间粒度发布，同次观察只公开一个粒度下的定位；
// - 同次观察已关联来源存在同时生效的较严限制时，只能用共同允许的粒度；
// - 明确禁止即时公开（embargo）时整条公开观测等待窗口；
// - 单纯撤回一条记录只撤其证据，其他许可按生效时段独立判断；
// - 已对外发布的旧位置不得被当前目录、历史订阅补发或迟到附件再带出，
//   粒度变化或证据撤回一律发撤回通知，新定位以新发布号出现。

import { combineGrains, gridAt, timeBucketAt } from './code.mjs';
import { licenseForItem } from './permissions.mjs';

function evaluateUnit({ key, members, observations, permissions, asOf, cancelled = false }) {
  const licenses = [];
  const memberResults = [];
  let embargoUntil = null;

  for (const member of members) {
    const license = licenseForItem(permissions, member, asOf);
    memberResults.push({ item: member, ...license });
    if (!license.usable) {
      if (license.reason === 'embargo') {
        const until = Date.parse(license.embargoUntil);
        embargoUntil = embargoUntil && Date.parse(embargoUntil) > until
          ? embargoUntil
          : license.embargoUntil;
      }
      else if (license.reason === 'no-grant') {
        // 单成员无许可在下方统一判定；多成员时只是该条证据不可用。
      }
      continue;
    }
    licenses.push(license.grain);
  }

  // 同次观察的定位锚点：在当前仍可用的成员里，优先选带明确更正（revises）的
  // 最新定位，否则取第一个带定位的可用成员。被撤回/禁令覆盖的证据不得提供定位。
  const usableItems = new Set(memberResults.filter((m) => m.usable).map((m) => m.item));
  const usableObservations = members
    .filter((m) => usableItems.has(m))
    .map((m) => observations.get(m))
    .filter((o) => o && o.location);
  const anchorObservation = usableObservations.find((o) => o.locationRevises)
    ?? usableObservations[0]
    ?? observations.get(members[0]);
  const anchor = {
    location: anchorObservation?.location ?? null,
    time: anchorObservation?.time ?? null,
  };

  if (cancelled) {
    return { key, members, status: 'unavailable', reason: 'cancelled', anchor, memberResults };
  }

  // 关联组里某条证据被撤回：撤掉该证据，剩余成员仍可独立判断、独立发布。
  const usableMembers = memberResults.filter((m) => m.usable);
  if (usableMembers.length === 0) {
    if (embargoUntil) {
      return { key, members, status: 'embargoed', embargoUntil, anchor, memberResults };
    }
    return { key, members, status: 'unavailable', reason: 'no-usable-evidence', anchor, memberResults };
  }
  if (embargoUntil) {
    return {
      key,
      members,
      status: 'embargoed',
      embargoUntil,
      anchor,
      memberResults,
      grain: combineGrains(licenses),
    };
  }

  const grain = combineGrains(licenses);
  // 同次观察只公开一个粒度下的定位：锚点定位统一按联合粒度截断。
  if (!anchor.location || !anchor.time) {
    return { key, members, status: 'unavailable', reason: 'missing-location', anchor, memberResults, grain };
  }
  return {
    key,
    members: usableMembers.map((m) => m.item),
    allMembers: members,
    status: 'publishable',
    grain,
    location: anchor.location,
    time: anchor.time,
    anchor,
    memberResults,
  };
}

function publicPayload(unit) {
  return {
    grid: gridAt(unit.location, unit.grain.gridDigits),
    timeBucket: timeBucketAt(unit.time, unit.grain.time),
    gridDigits: unit.grain.gridDigits,
    time: unit.grain.time,
  };
}

function samePayload(a, b) {
  return a.grid === b.grid && a.timeBucket === b.timeBucket
    && a.gridDigits === b.gridDigits && a.time === b.time;
}

// 依据本轮账本重新核对全部公开单元，生成发布流的增量条目。
export function reconcileReleases({
  ledger, groups, permissions, asOf, sequenceStart,
}) {
  const observations = ledger.observations;
  const memberEvent = new Map();
  for (const group of groups.values()) {
    for (const member of group.members) memberEvent.set(member, group.event);
  }

  const units = [];
  const seen = new Set();
  for (const group of groups.values()) {
    units.push({ key: `event:${group.event}`, members: [...group.members], event: group.event });
    group.members.forEach((m) => seen.add(m));
  }
  // 取消的观测也要作为单元参与评估，这样此前已发布的内容才会被撤回。
  for (const item of observations.keys()) {
    if (seen.has(item)) continue;
    const observation = observations.get(item);
    units.push({
      key: `item:${item}`,
      members: [item],
      cancelled: observation.cancelled === true,
    });
  }

  const evaluations = units.map((unit) => evaluateUnit({
    key: unit.key,
    members: unit.members,
    observations,
    permissions,
    asOf,
    cancelled: unit.cancelled === true,
  }));

  const entries = [];
  const current = new Map();
  let sequence = sequenceStart;

  for (const unit of evaluations) {
    const prior = [...ledger.releases]
      .reverse()
      .find((r) => r.kind === 'release' && r.key === unit.key && r.state === 'published');

    if (unit.status !== 'publishable') {
      if (prior && prior.state === 'published') {
        sequence += 1;
        entries.push(withdrawal(sequence, prior, unit.status === 'embargoed' ? 'embargo' : unit.reason, asOf));
      }
      continue;
    }

    const payload = publicPayload(unit);
    if (prior && prior.state === 'published' && samePayload(prior.publicPayload, payload)) {
      current.set(unit.key, prior);
      continue;
    }

    if (prior && prior.state === 'published') {
      // 粒度变细/变粗或定位更正：先撤回旧发布，旧定位绝不能留在目录或补发里。
      sequence += 1;
      entries.push(withdrawal(sequence, prior, 'superseded', asOf));
    }
    sequence += 1;
    const release = {
      kind: 'release',
      sequence,
      key: unit.key,
      event: unit.key.startsWith('event:') ? unit.key.slice(6) : null,
      members: unit.members,
      state: 'published',
      publicPayload: payload,
      // 细格与原始时间只留在内部账本，公开序列化时不输出。
      internal: { location: unit.location, time: unit.time, asOf },
      reason: prior ? 'replacement' : 'new',
      at: asOf,
    };
    entries.push(release);
    current.set(unit.key, release);
  }

  // 已消失的单元（如观测被取消、或被核对关联并入同次观察）也要撤回。
  const liveKeys = new Set(evaluations.map((u) => u.key));
  for (const prior of ledger.releases.filter((r) => r.kind === 'release' && r.state === 'published')) {
    if (!liveKeys.has(prior.key) && !entries.some((e) => e.kind === 'withdrawal' && e.ref === prior.sequence)) {
      const merged = prior.key.startsWith('item:')
        && memberEvent.has(prior.key.slice(5));
      sequence += 1;
      entries.push(withdrawal(sequence, prior, merged ? 'merged' : 'cancelled', asOf));
    }
  }

  return { entries, evaluations, current, nextSequence: sequence };
}

function withdrawal(sequence, prior, reason, asOf) {
  // 旧发布一旦撤回，其历史条目载荷同步清除：历史订阅补发不得带出旧定位。
  prior.publicPayload = null;
  prior.state = 'withdrawn';
  prior.withdrawnBy = sequence;
  return {
    kind: 'withdrawal',
    sequence,
    ref: prior.sequence,
    key: prior.key,
    event: prior.event,
    state: 'withdrawn',
    reason,
    // 撤回消息本身不得携带任何能关联出更细格的线索。
    publicPayload: null,
    at: asOf,
  };
}

// 公开目录：只含当前仍发布的条目，且只有合成粒度下的网格与时间桶。
export function publicCatalog(releases) {
  const byKey = new Map();
  for (const entry of releases) {
    if (entry.kind === 'withdrawal') byKey.delete(entry.key);
    else if (entry.kind === 'release') byKey.set(entry.key, entry);
  }
  return [...byKey.values()].map((entry) => ({
    release: entry.sequence,
    event: entry.event,
    ...entry.publicPayload,
  }));
}

// 公开订阅流：撤回只给发布号与原因，历史条目不复活、不带旧定位。
export function publicFeed(releases, fromSequence = 0) {
  return releases
    .filter((entry) => entry.sequence > fromSequence)
    .map((entry) => {
      if (entry.kind === 'withdrawal') {
        return { sequence: entry.sequence, kind: 'withdrawal', ref: entry.ref, reason: entry.reason };
      }
      if (entry.state === 'withdrawn' || !entry.publicPayload) {
        return { sequence: entry.sequence, kind: 'redacted', ref: entry.sequence };
      }
      return { sequence: entry.sequence, kind: 'release', event: entry.event, ...entry.publicPayload };
    });
}
