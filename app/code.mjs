// 两机构共同使用的嵌套编码表：
// 网格为六位数字，前两位是片区、前四位是粗格、完整六位是细格；
// 时间桶可取整小时或整天（UTC），天比小时粗。
export const GRID_DIGITS = [2, 4, 6];
export const TIME_LEVELS = ['day', 'hour'];

export function isValidGrid(code) {
  return typeof code === 'string' && /^\d{6}$/.test(code);
}

export function gridAt(code, digits) {
  if (!GRID_DIGITS.includes(digits)) {
    throw new Error(`不支持的网格粒度 ${digits}`);
  }
  if (!isValidGrid(code)) {
    throw new Error(`非法网格代码 ${code}`);
  }
  return code.slice(0, digits);
}

// 位数越少越粗（限制越严），取交集即取最小位数。
export function stricterGridDigits(a, b) {
  return Math.min(a, b);
}

export function dayBucket(iso) {
  return iso.slice(0, 10);
}

export function hourBucket(iso) {
  return `${iso.slice(0, 13)}:00:00Z`;
}

export function timeBucketAt(iso, level) {
  if (level === 'day') return dayBucket(iso);
  if (level === 'hour') return hourBucket(iso);
  throw new Error(`不支持的时间粒度 ${level}`);
}

// 任一方要求按天，联合结果就只能按天。
export function stricterTime(a, b) {
  return a === 'day' || b === 'day' ? 'day' : 'hour';
}

// 合成许可：多条有效许可的交集，网格取最粗位数、时间取最粗粒度。
export function combineGrains(licenses) {
  if (licenses.length === 0) return null;
  return {
    gridDigits: licenses.reduce((m, l) => stricterGridDigits(m, l.gridDigits), 6),
    time: licenses.map((l) => l.time).reduce(stricterTime),
  };
}
