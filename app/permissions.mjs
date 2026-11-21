// 许可流是针对“观测记录使用权”的独立时间线：
//   grant  允许使用该条证据（含公开粒度上限）
//   bound  自生效时刻起对同次公开项加严，并可带 embargoUntil 即时公开禁令
//   unbind 停止此前的限制
//   revoke 撤回原记录的公开使用许可（只撤这一条证据）
// 所有判断都以 asOf 时刻为准，历史上已生效、但 asOf 时已解除/撤回的状态不算当前状态。

function asMap(events) {
  const byId = new Map();
  for (const event of events) {
    if (event.id) byId.set(event.id, event);
  }
  return byId;
}

function resolveItem(event, byId) {
  return event.item ?? byId.get(event.ref)?.item ?? null;
}

export function evaluatePermissions(events, item, asOf) {
  const byId = asMap(events);
  const activeGrants = [];
  const activeBounds = [];

  for (const event of events) {
    if (event.from && Date.parse(event.from) > Date.parse(asOf)) continue;
    const effectiveItem = resolveItem(event, byId);
    if (effectiveItem !== item) continue;

    if (event.op === 'grant') {
      activeGrants.push(event);
    }
    else if (event.op === 'bound') {
      activeBounds.push(event);
    }
    else if (event.op === 'unbind') {
      const index = activeBounds.findIndex((b) => b.id === event.ref);
      if (index >= 0) activeBounds.splice(index, 1);
    }
    else if (event.op === 'revoke') {
      // 只撤被引用的那一条 grant；其他记录的许可独立判断。
      const index = activeGrants.findIndex((g) => g.id === event.ref);
      if (index >= 0) activeGrants.splice(index, 1);
    }
  }

  const embargo = activeBounds
    .map((b) => b.embargoUntil)
    .filter((value) => value && Date.parse(value) > Date.parse(asOf))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1) ?? null;

  return { grants: activeGrants, bounds: activeBounds, embargo };
}

// 某条记录在 asOf 时刻能否作为公开证据使用，以及可用的合成粒度。
export function licenseForItem(events, item, asOf) {
  const { grants, bounds, embargo } = evaluatePermissions(events, item, asOf);
  if (grants.length === 0) {
    return { usable: false, reason: 'no-grant', embargo: null, grain: null, grants: [], bounds };
  }
  const grains = [...grants, ...bounds].map((entry) => ({
    gridDigits: entry.gridDigits,
    time: entry.time,
  }));
  const grain = grains.reduce((acc, g) => ({
    gridDigits: Math.min(acc.gridDigits, g.gridDigits),
    time: acc.time === 'day' || g.time === 'day' ? 'day' : 'hour',
  }));
  if (embargo) {
    return { usable: false, reason: 'embargo', embargoUntil: embargo, grain, grants, bounds };
  }
  return { usable: true, reason: 'ok', embargoUntil: null, grain, grants, bounds };
}
