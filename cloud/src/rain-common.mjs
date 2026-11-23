const DAY = 86400000
export function timeDays(values, units, calendar = 'standard') {
  if (!['standard', 'gregorian', 'proleptic_gregorian'].includes(calendar)) throw new Error('暂不支持该日历：' + calendar)
  const match = String(units).match(/^(days?|hours?|minutes?|seconds?)\s+since\s+(\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::([\d.]+))?)?\s*(?:Z|UTC)?$/i)
  if (!match) throw new Error('时间单位须为 CF days/hours/minutes/seconds since 日期。')
  const [, unit, y, m, d, hh = 0, mm = 0, ss = 0] = match
  const year = +y, month = +m, day = +d
  const leap = calendar === 'proleptic_gregorian' || year >= 1582 ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) : year % 4 === 0
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || +hh > 23 || +mm > 59 || +ss >= 60 ||
      (calendar !== 'proleptic_gregorian' && year === 1582 && month === 10 && day >= 5 && day <= 14)) throw new Error('时间单位中的起算日期无效。')
  const a = Math.floor((14 - month) / 12), yy = year + 4800 - a, mo = month + 12 * a - 3
  const gregorian = calendar === 'proleptic_gregorian' || `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` >= '1582-10-15'
  const jdn = day + Math.floor((153 * mo + 2) / 5) + 365 * yy + Math.floor(yy / 4) +
    (gregorian ? -Math.floor(yy / 100) + Math.floor(yy / 400) - 32045 : -32083)
  const base = (jdn - 2440588) * DAY + (+hh * 3600 + +mm * 60 + +ss) * 1000
  const multiplier = unit.toLowerCase().startsWith('day') ? DAY : unit.toLowerCase().startsWith('hour') ? 3600000 : unit.toLowerCase().startsWith('minute') ? 60000 : 1000
  const days = [], seen = new Set()
  let previous = null
  for (const value of values) {
    const ms = Number(value) * multiplier + base
    if (!Number.isFinite(ms) || (previous !== null && (ms <= previous || Math.abs((ms - previous) / DAY - Math.round((ms - previous) / DAY)) > 1e-6))) {
      throw new Error('需要逐日数据：时间须递增，间隔须为整日；小时数据请先汇总。')
    }
    const dateObject = new Date(ms)
    if (dateObject.getUTCFullYear() < 1 || dateObject.getUTCFullYear() > 9999 || !Number.isFinite(dateObject.getTime())) throw new Error('时间坐标超出可支持的日期范围。')
    const date = dateObject.toISOString().slice(0, 10)
    if (calendar !== 'proleptic_gregorian' && date < '1582-10-15') throw new Error('导入日期须在公历改革之后，起算参考日期可早于该日期。')
    if (seen.has(date)) throw new Error('需要逐日数据，同一天不能有多个时间片。')
    seen.add(date); days.push(date); previous = ms
  }
  if (!days.length) throw new Error('时间坐标为空。')
  return days
}

export function makeAxis(input, kind) {
  const original = Array.from(input, Number)
  if (original.length < 2 || original.some(value => !Number.isFinite(value))) throw new Error('经纬度轴至少需要两个有效格点。')
  const direction = Math.sign(original[1] - original[0])
  if (!direction || original.some((value, index) => index && Math.sign(value - original[index - 1]) !== direction)) throw new Error('经纬度坐标必须严格单调，不能重复。')
  if (kind === 'latitude' && original.some(value => Math.abs(value) > 90)) throw new Error('纬度应在 -90° 至 90°。')
  if (kind === 'longitude' && original.some(value => value < -180 || value > 360)) throw new Error('经度应使用 -180—180° 或 0—360°。')
  const normalized = original.map(value => kind === 'longitude' && value > 180 ? value - 360 : value)
  const step = Math.abs(original[1] - original[0])
  const periodic = kind === 'longitude' && Math.abs(step * original.length - 360) < 1e-6 &&
    original.every((value, index) => !index || Math.abs(Math.abs(value - original[index - 1]) - step) < 1e-6)
  if (kind === 'longitude' && !periodic && normalized.some((value, index) => index && Math.sign(value - normalized[index - 1]) !== direction)) {
    throw new Error('暂不支持跨越 ±180° 的区域经度轴，请先裁剪为不跨日期变更线的区域网格。')
  }
  const pairs = normalized.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const values = pairs.map(pair => pair.value), indices = pairs.map(pair => pair.index)
  if (values.some((value, index) => index && value === values[index - 1])) throw new Error('经度归一化后存在重复格点。')
  const edges = [values[0] - (values[1] - values[0]) / 2,
    ...values.slice(1).map((value, index) => (value + values[index]) / 2),
    values.at(-1) + (values.at(-1) - values.at(-2)) / 2]
  return { values, indices, edges, periodic }
}
export function cellIndex(axis, value) {
  const edges = axis.edges
  if (axis.periodic) { if (value < edges[0]) value += 360; else if (value >= edges.at(-1)) value -= 360 }
  if (value < edges[0] || value >= edges.at(-1)) return -1
  let low = 0, high = edges.length - 1
  while (high - low > 1) { const middle = (low + high) >> 1; if (value < edges[middle]) high = middle; else low = middle }
  return low
}
export function unitFactor(input, cellMethods = '', confirmed = false) {
  const unit = String(input).toLowerCase().replace(/[\s_*^{}]/g, '').replace(/−/g, '-')
  if (['mm', 'mm/day', 'mmd-1', 'mmday-1', 'kgm-2', 'kg/m2', 'kgm-2/day', 'kgm-2d-1'].includes(unit)) return 1
  if (['m', 'm/day', 'md-1', 'mday-1'].includes(unit)) return 1000
  if (['cm', 'cm/day', 'cmd-1'].includes(unit)) return 10
  if (['kgm-2s-1', 'kg/m2/s', 'mm/s', 'mms-1'].includes(unit)) {
    if (!confirmed && !/time\s*:\s*mean/i.test(cellMethods)) throw new Error('通量单位需要确认变量为日平均通量，不能将瞬时通量直接作为日降水。')
    return 86400
  }
  throw new Error('不能自动识别降水单位，请选择并确认单位：' + input)
}
export function rainValue(raw, attrs = {}, factor = 1) {
  const missing = [attrs._FillValue, attrs.missing_value].flatMap(value => value == null ? [] : Array.from(ArrayBuffer.isView(value) || Array.isArray(value) ? value : [value], Number))
  if (!Number.isFinite(Number(raw)) || missing.includes(Number(raw))) return NaN
  const range = attrs.valid_range
  if ((range && (raw < range[0] || raw > range[1])) || (attrs.valid_min != null && raw < attrs.valid_min) || (attrs.valid_max != null && raw > attrs.valid_max)) return NaN
  const value = (Number(raw) * Number(attrs.scale_factor ?? 1) + Number(attrs.add_offset ?? 0)) * factor
  return value >= 0 && Number.isFinite(value) ? value : NaN
}
