// 巡护片区是半开区间 [start, end)，单位米。
// 覆盖只认实际走完的 walked 区间；旧记录缺定位时不能为另一个片区补足覆盖，
// 因此观测（即使带定位）一律不参与覆盖计算。

export function mergeIntervals(intervals) {
  const sorted = intervals
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    }
    else {
      merged.push([start, end]);
    }
  }
  return merged;
}

// 从一个半开区间里减去若干已走区间，返回剩余缺口。
export function subtractIntervals([areaStart, areaEnd], walked) {
  const remaining = [];
  let cursor = areaStart;
  for (const [start, end] of mergeIntervals(walked)) {
    if (end <= cursor) continue;
    if (start >= areaEnd) break;
    if (start > cursor) remaining.push([cursor, Math.min(start, areaEnd)]);
    cursor = Math.max(cursor, Math.min(end, areaEnd));
    if (cursor >= areaEnd) break;
  }
  if (cursor < areaEnd) remaining.push([cursor, areaEnd]);
  return remaining;
}

// 合并或纠错后重新核对：按路线汇总各巡护员实际走完区间，与片区要求比对。
export function coverageByRoute(areas, patrols) {
  const walkedByRoute = new Map();
  for (const patrol of patrols) {
    if (!walkedByRoute.has(patrol.route)) walkedByRoute.set(patrol.route, []);
    walkedByRoute.get(patrol.route).push({
      patrolId: patrol.patrolId,
      org: patrol.org,
      walked: mergeIntervals(patrol.walked.map(([s, e]) => [s, e])),
    });
  }

  return areas.map((definition) => {
    const walkers = walkedByRoute.get(definition.route) ?? [];
    const allWalked = mergeIntervals(walkers.flatMap((w) => w.walked));
    const segments = definition.segments.map((segment) => {
      const gaps = subtractIntervals([segment.start, segment.end], allWalked);
      return {
        area: segment.area,
        start: segment.start,
        end: segment.end,
        covered: gaps.length === 0,
        gaps,
        // 缺口原因由摄入侧事实表（缺页/缺附件）回填，这里只给区间事实。
      };
    });
    return {
      route: definition.route,
      walkers: walkers.map(({ patrolId, org, walked }) => ({ patrolId, org, walked })),
      walked: allWalked,
      complete: segments.every((s) => s.covered),
      segments,
    };
  });
}
