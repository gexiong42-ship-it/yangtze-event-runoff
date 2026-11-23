import { makeAxis, timeDays, unitFactor, rainValue } from './rain-common.mjs'
const scalar = value => ArrayBuffer.isView(value) || Array.isArray(value) ? value[0] : value
const attrText = value => String(scalar(value) ?? '')

export function h5Adapter(file) {
  const variables = []
  for (const name of file.keys()) {
    const dataset = file.get(name)
    if (!Array.isArray(dataset.shape)) continue
    const attrs = {}
    for (const [key, attribute] of Object.entries(dataset.attrs)) {
      if (['DIMENSION_LIST', 'REFERENCE_LIST'].includes(key)) continue
      try { attrs[key] = attribute.value } catch {}
    }
    if (attrs._FillValue == null) {
      const info = dataset.metadata
      if (info.type === 1) attrs._FillValue = 9.969209968386869e36
      else if (info.type === 0) attrs._FillValue = info.signed
        ? { 1: -127, 2: -32767, 4: -2147483647, 8: -9223372036854775806n }[info.size]
        : { 1: 255, 2: 65535, 4: 4294967295, 8: 18446744073709551614n }[info.size]
    }
    const dims = dataset.shape.map((length, index) => {
      const scales = dataset.get_attached_scales(index)
      return scales[0]?.replace(/^\//, '') ?? (dataset.shape.length === 1 ? name : dataset.get_dimension_labels()[index] ?? `dimension-${index}-${length}`)
    })
    variables.push({ name, dims, shape: dataset.shape, attrs, dataset })
  }
  return { format: 'NetCDF4 / HDF5', variables,
    read: async (variable, starts, counts) => starts ? variable.dataset.slice(starts.map((start, index) => [start, start + counts[index]])) : variable.dataset.value,
    close: () => file.close() }
}

export async function inspectDataset(reader, filename) {
  function coordinate(kind) {
    const standards = { latitude: ['latitude'], longitude: ['longitude'], time: ['time'] }[kind]
    const names = { latitude: ['lat', 'latitude'], longitude: ['lon', 'longitude'], time: ['time', 'date'] }[kind]
    const candidates = reader.variables.filter(variable => standards.includes(attrText(variable.attrs.standard_name).toLowerCase()) || names.includes(variable.name.toLowerCase()) ||
      attrText(variable.attrs.axis).toUpperCase() === { latitude: 'Y', longitude: 'X', time: 'T' }[kind])
    if (candidates.length !== 1 || candidates[0].shape.length !== 1) throw new Error(`无法唯一识别一维 ${kind} 坐标；需要 CF 经度、纬度和时间轴，不支持二维曲线或投影网格。`)
    return candidates[0]
  }
  const latitude = coordinate('latitude'), longitude = coordinate('longitude'), time = coordinate('time')
  if ([latitude, longitude].some(variable => {
    const unit = attrText(variable.attrs.units)
    return unit && !/^degrees?(?:[_ ](?:north|east|n|e))?$/i.test(unit)
  })) throw new Error('需要以度为单位的 WGS84 经纬度坐标，不能使用弧度或投影米坐标。')
  const [latRaw, lonRaw, timeRaw] = await Promise.all([reader.read(latitude), reader.read(longitude), reader.read(time)])
  const lat = makeAxis(Array.from(latRaw, value => rainCoordinate(value, latitude.attrs)), 'latitude')
  const lon = makeAxis(Array.from(lonRaw, value => rainCoordinate(value, longitude.attrs)), 'longitude')
  const days = timeDays(Array.from(timeRaw, value => rainCoordinate(value, time.attrs)), attrText(time.attrs.units), attrText(time.attrs.calendar) || 'standard')
  if (lat.values.length * lon.values.length > 20000000) throw new Error('格点数超过 2000 万，请先裁剪研究区域附近数据。')
  const candidates = reader.variables.filter(variable => [latitude, longitude, time].every(axis => variable.dims.includes(axis.dims[0])) &&
    variable.dims.every((dim, index) => [latitude.dims[0], longitude.dims[0], time.dims[0]].includes(dim) || variable.shape[index] === 1))
  if (!candidates.length) throw new Error('没有识别到包含时间、纬度、经度的降水变量。')
  const preferred = candidates.filter(variable => /^(pre|pr|precip|precipitation|rain|rainfall|tp)$/i.test(variable.name) || /precipitation/i.test(attrText(variable.attrs.standard_name)))
  const selected = preferred.length === 1 ? preferred[0].name : candidates.length === 1 ? candidates[0].name : ''
  const description = { filename, format: reader.format, start: days[0], end: days.at(-1), days: days.length,
    missingDays: Math.round((Date.parse(days.at(-1)) - Date.parse(days[0])) / 86400000) + 1 - days.length,
    latitude: [lat.values[0], lat.values.at(-1)], longitude: [lon.values[0], lon.values.at(-1)],
    rows: lat.values.length, cols: lon.values.length, calendar: attrText(time.attrs.calendar) || 'standard',
    variables: candidates.map(variable => ({ name: variable.name, units: variableUnits(variable), longName: attrText(variable.attrs.long_name) })), selected }
  function selection(variableName, unitOverride = '') {
    const variable = candidates.find(row => row.name === variableName)
    if (!variable) throw new Error('请选择降水变量。')
    if (String(variable.attrs._Unsigned).toLowerCase() === 'true') throw new Error('该变量使用 _Unsigned 打包，请先转为有符号或浮点日降水变量。')
    const actualUnits = unitOverride || variableUnits(variable)
    const factor = unitFactor(actualUnits, attrText(variable.attrs.cell_methods), Boolean(unitOverride))
    return { variable, actualUnits, factor }
  }
  async function readRain(requested, wanted, variableName, unitOverride = '') {
    const { variable, actualUnits, factor } = selection(variableName, unitOverride)
    const timeAxis = variable.dims.indexOf(time.dims[0]), latAxis = variable.dims.indexOf(latitude.dims[0]), lonAxis = variable.dims.indexOf(longitude.dims[0])
    const counts = variable.shape.map((length, index) => [latAxis, lonAxis].includes(index) ? length : 1)
    const strides = counts.map((_, axis) => counts.slice(axis + 1).reduce((a, b) => a * b, 1))
    const fields = new Map()
    for (const day of [...new Set(requested)]) {
      const position = days.indexOf(day)
      if (position < 0) throw new Error('导入文件缺少日期 ' + day + '，事件及前期湿润度日期都须覆盖。')
      const starts = variable.shape.map(() => 0); starts[timeAxis] = position
      const raw = starts.some((start, index) => start >= variable.shape[index]) || counts.some(count => count === 0)
        ? null : await reader.read(variable, starts, counts)
      const field = new Map()
      for (const grid of wanted) {
        const row = Math.floor(grid / lon.values.length), col = grid % lon.values.length
        const originalRow = lat.indices[row], originalCol = lon.indices[col]
        const index = originalRow * strides[latAxis] + originalCol * strides[lonAxis]
        field.set(grid, !raw || originalRow >= variable.shape[latAxis] || originalCol >= variable.shape[lonAxis]
          ? NaN : rainValue(raw[index], variable.attrs, factor))
      }
      fields.set(day, field)
    }
    return { fields, info: { name: filename, variable: variableName, units: 'mm/day', originalUnits: actualUnits,
      start: days[0], end: days.at(-1), dayBoundary: '沿用导入文件的原始逐日日期标签',
      latitudes: lat.values, longitudes: lon.values } }
  }
  return { description, lat, lon, days, readRain, reader, validate: selection }
}
function rainCoordinate(value, attrs) { return Number(value) * Number(scalar(attrs.scale_factor) ?? 1) + Number(scalar(attrs.add_offset) ?? 0) }
function variableUnits(variable) {
  const declared = attrText(variable.attrs.units)
  if (declared) return declared
  return attrText(variable.attrs.long_name).match(/\b(mm\s*\/\s*day|m\s*\/\s*day|mm)\b/i)?.[1] ?? ''
}
