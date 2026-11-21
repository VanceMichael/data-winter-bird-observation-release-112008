// 摄入两个合作组织的原始资料，产出三类事实：
//   observations  以“组织:观测号”为身份的观测记录（含补件/更正/取消的版本史）
//   patrols       实际走完的巡线（区别于上传批）
//   facts         清单缺页、缺附件、明确零只等各自独立的事实
// 同号再来的记录：补照片不覆盖原定位；带 revises/cancelled 才是更正或取消。

const openFacts = new Set(['missing-part', 'missing-attachment']);

// 来源里 walked 表示为 [start, end] 端点对；多个分段则是 [[s,e],[s,e]]。
export function normalizeWalked(walked) {
  if (!Array.isArray(walked) || walked.length === 0) return [];
  if (typeof walked[0] === 'number') return [[walked[0], walked[1]]];
  return walked.map(([start, end]) => [start, end]);
}

function nowIso() {
  return new Date().toISOString();
}

function baseObservation(org, id) {
  return {
    item: `${org}:${id}`,
    org,
    id,
    time: null,
    location: null,
    cancelled: false,
    versions: [],
    attachmentPending: null,
  };
}

// 同号记录再次到达：按内容判断是补件、更正还是取消，绝不静默覆盖。
function applyObservationUpdate(observation, update, at) {
  const version = { at, ...update };
  observation.versions.push(version);
  if (update.time) observation.time = update.time;
  if (update.cancelled === true) observation.cancelled = true;
  if (update.location) {
    if (update.revises) {
      // 明确更正地点：旧定位进入版本史，当前定位改为新值。
      observation.location = update.location;
      observation.locationRevises = update.revises;
    }
    else if (!observation.location) {
      observation.location = update.location;
    }
    // 已有定位且未声明 revises：视为补照片之类的补件，保留原定位。
  }
  return observation;
}

export function ingestNorth(snapshot, at = nowIso()) {
  const observations = new Map();
  const patrols = [];
  const facts = [];

  for (const patrol of snapshot.patrols ?? []) {
    patrols.push({
      patrolId: patrol.id,
      org: 'north',
      route: patrol.route,
      walked: normalizeWalked(patrol.walked),
      status: patrol.status ?? null,
    });
    if (!patrol.observations || patrol.observations.length === 0) {
      facts.push({
        kind: 'explicit-zero',
        org: 'north',
        patrolId: patrol.id,
        route: patrol.route,
        at,
        detail: '巡线提交明确记录到零只',
      });
    }
    for (const raw of patrol.observations ?? []) {
      const item = `north:${raw.id}`;
      const observation = applyObservationUpdate(
        baseObservation('north', raw.id),
        {
          time: raw.time,
          location: raw.location,
          cancelled: raw.cancelled === true,
          revises: raw.revises ?? null,
          source: 'patrol',
        },
        at,
      );
      observations.set(item, observation);
    }
  }

  return { observations, patrols, facts };
}

function attachmentState(media) {
  if (media === null) return { pending: true, media: null };
  if (media && (media.state === 'pending' || media.retryAfter)) {
    return { pending: true, media };
  }
  return { pending: false, media };
}

// 东组织按终端上传批分段：批与实际巡线分开识别，declaredParts 对不上就是缺页。
export function ingestEast(snapshot, at = nowIso()) {
  const observations = new Map();
  const patrols = new Map();
  const facts = [];

  for (const batch of snapshot.sets ?? []) {
    const declared = batch.declaredParts ?? batch.segments.length;
    // pending 分段没有正文，路线从同批已就绪分段推断。
    const knownRoute = batch.segments
      .map((path) => snapshot.segments?.[path])
      .find((segment) => segment && segment.state !== 'pending' && segment.route)?.route ?? null;
    for (let index = 0; index < declared; index += 1) {
      const path = batch.segments[index];
      const segment = path ? snapshot.segments?.[path] : undefined;
      if (!path || !segment || segment.state === 'pending') {
        facts.push({
          kind: 'missing-part',
          org: 'east',
          batch: batch.batch,
          part: index + 1,
          route: segment?.route ?? knownRoute,
          at,
          detail: `上传批 ${batch.batch} 清单第 ${index + 1} 段未就绪（缺页）`,
        });
      }
    }

    for (const path of batch.segments ?? []) {
      const segment = snapshot.segments?.[path];
      if (!segment || segment.state === 'pending') continue; // 缺页事实已在上面登记
      const walked = normalizeWalked(segment.walked);
      if (walked.length === 0) continue; // 未就绪分段不能贡献任何巡线区间

      if (!patrols.has(segment.patrol)) {
        patrols.set(segment.patrol, {
          patrolId: segment.patrol,
          org: 'east',
          route: segment.route,
          walked: [],
          batches: [batch.batch],
        });
      }
      const patrol = patrols.get(segment.patrol);
      if (!patrol.batches.includes(batch.batch)) patrol.batches.push(batch.batch);
      patrol.walked.push(...normalizeWalked(segment.walked));

      if (!segment.observations || segment.observations.length === 0) {
        facts.push({
          kind: 'explicit-zero',
          org: 'east',
          patrolId: segment.patrol,
          route: segment.route,
          batch: batch.batch,
          segment: path,
          at,
          detail: `分段 ${path} 明确记录到零只`,
        });
      }

      for (const raw of segment.observations ?? []) {
        const item = `east:${raw.id}`;
        const { pending, media } = attachmentState(raw.attachment ? snapshot.media?.[raw.attachment] : null);
        const observation = observations.get(item) ?? baseObservation('east', raw.id);
        applyObservationUpdate(observation, {
          time: raw.time,
          location: media && !pending ? media.location : null,
          revises: media && !pending ? media.revises ?? null : null,
          attachment: raw.attachment ?? null,
          source: 'segment',
        }, at);

        if (raw.attachment && pending) {
          observation.attachmentPending = raw.attachment;
          facts.push({
            kind: 'missing-attachment',
            org: 'east',
            batch: batch.batch,
            route: patrol.route,
            item,
            attachment: raw.attachment,
            at,
            detail: `观测 ${raw.id} 的定位附件 ${raw.attachment} 尚未到达`,
          });
        }
        observations.set(item, observation);
      }
    }
  }

  return {
    observations,
    patrols: [...patrols.values()].map((p) => ({ ...p, walked: p.walked })),
    facts,
  };
}

// 每轮同步把两侧事实合并进账本；缺页/缺附件事实按键保持或重新打开，其余事实追加。
export function mergeIntoLedger(ledger, north, east, round) {
  for (const [item, observation] of north.observations) {
    ledger.observations.set(item, mergeObservation(ledger.observations.get(item), observation));
  }
  for (const [item, observation] of east.observations) {
    ledger.observations.set(item, mergeObservation(ledger.observations.get(item), observation));
  }
  for (const patrol of [...north.patrols, ...east.patrols]) {
    const key = `${patrol.org}:${patrol.patrolId}`;
    ledger.patrols.set(key, { ...patrol, key });
  }

  const incoming = [...north.facts, ...east.facts];
  for (const fact of incoming) {
    const key = factKey(fact);
    const existing = ledger.facts.find((f) => factKey(f) === key);
    if (existing) {
      existing.lastRound = round;
      existing.at = fact.at;
      existing.status = openFacts.has(fact.kind) ? 'open' : existing.status;
    }
    else {
      ledger.facts.push({
        ...fact,
        key,
        firstRound: round,
        lastRound: round,
        status: openFacts.has(fact.kind) ? 'open' : 'recorded',
      });
    }
  }
  // 本轮不再出现的缺页/缺附件，说明资料已补齐，关闭对应事实。
  const incomingKeys = new Set(incoming.map(factKey));
  for (const fact of ledger.facts) {
    if (openFacts.has(fact.kind) && !incomingKeys.has(fact.key)) {
      fact.status = 'resolved';
      fact.resolvedRound = round;
    }
  }
}

export function mergeObservation(previous, incoming) {
  if (!previous) return incoming;
  // 补件带来的定位（未声明 revises）不能覆盖已有定位；只有明确更正才替换。
  const incomingVersion = incoming.versions.at(-1);
  const keepsLocation = incoming.location
    && previous.location
    && incomingVersion?.revises == null
    && incoming.location !== previous.location;
  const merged = {
    ...previous,
    time: incoming.time ?? previous.time,
    location: keepsLocation ? previous.location : (incoming.location ?? previous.location),
    cancelled: previous.cancelled || incoming.cancelled,
    attachmentPending: incoming.attachmentPending !== undefined
      ? incoming.attachmentPending
      : previous.attachmentPending,
    locationRevises: incoming.locationRevises ?? previous.locationRevises ?? null,
    versions: [...previous.versions, ...incoming.versions],
  };
  return merged;
}

export function factKey(fact) {
  return [
    fact.kind,
    fact.org,
    fact.batch ?? '',
    fact.part ?? '',
    fact.item ?? '',
    fact.attachment ?? '',
    fact.patrolId ?? '',
    fact.segment ?? '',
  ].join('|');
}
