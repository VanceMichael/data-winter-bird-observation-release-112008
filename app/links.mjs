// 同次观察关联：只接受合作方登记且 status=verified 的关联；
// 未核对的时间地点近似记录只提示人工，绝不主动合并。

export function buildVerifiedGroups(links) {
  const groups = new Map();
  for (const link of links) {
    if (link.status !== 'verified') continue;
    groups.set(link.event, { event: link.event, members: [...link.members], status: 'verified' });
  }
  return groups;
}

export function memberToEvent(groups) {
  const map = new Map();
  for (const group of groups.values()) {
    for (const member of group.members) map.set(member, group.event);
  }
  return map;
}

const APPROX_MINUTES = 30;

// 近似规则仅用于人工提示：不同组织、粗格（前四位）相同、时间相差不超过半小时。
export function findManualCandidates(observations, groups) {
  const linked = memberToEvent(groups);
  const list = observations.filter((o) => !linked.has(o.item) && o.time);
  const candidates = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      if (a.org === b.org) continue;
      if (!a.location || !b.location) continue;
      if (a.location.slice(0, 4) !== b.location.slice(0, 4)) continue;
      const deltaMin = Math.abs(Date.parse(a.time) - Date.parse(b.time)) / 60000;
      if (deltaMin > APPROX_MINUTES) continue;
      candidates.push({
        members: [a.item, b.item].sort(),
        reason: 'unverified-approximate',
        gridPrefix: a.location.slice(0, 4),
        minutesApart: Math.round(deltaMin),
      });
    }
  }
  return candidates;
}
