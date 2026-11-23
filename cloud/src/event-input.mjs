import { name as regionName, note as regionNote } from './region-scope.mjs'
const SOIL_GROUPS = { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 11: 'A/D', 12: 'B/D', 13: 'C/D', 14: 'D/D' }
const LAND_NAMES = { 1: '耕地', 2: '林地', 3: '灌木地', 4: '草地', 5: '水体', 6: '冰雪', 7: '裸地', 8: '不透水面', 9: '湿地' }
const MOISTURE_SOURCE = 'https://www.in.gov/dot/div/contracts/standards/dm-Archived/10Metric/Part4/Ch29/figures/Fig29-10G.pdf'

export function dayRange(start, end) {
  const first = Date.parse(start)
  const last = Date.parse(end)
  if (![start, end].every(day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) ||
      ![first, last].every(Number.isFinite) || new Date(first).toISOString().slice(0, 10) !== start ||
      new Date(last).toISOString().slice(0, 10) !== end || last < first) throw new Error('请输入有效且有序的日期。')
  return Array.from({ length: (last - first) / 86400000 + 1 }, (_, index) =>
    new Date(first + index * 86400000).toISOString().slice(0, 10))
}

export function eventPeriod(config) {
  const event = dayRange(config.start, config.end)
  const previous = offset => new Date(Date.parse(config.start) - offset * 86400000).toISOString().slice(0, 10)
  const antecedent = dayRange(config.antecedentStart ?? previous(5), config.antecedentEnd ?? previous(1))
  if (antecedent.at(-1) >= event[0]) throw new Error('湿润度计算日期须早于事件开始日期。')
  const scheme = config.moistureScheme ?? 'growing'
  let moisture
  if (['growing', 'dormant'].includes(scheme)) {
    if (antecedent.length !== 5 || antecedent.at(-1) !== previous(1)) {
      throw new Error('传统前期湿润分级要求事件前连续五天。其他时段请选择自定义判据。')
    }
    moisture = { dryBelow: scheme === 'growing' ? 36 : 13, wetFrom: scheme === 'growing' ? 53 : 28,
      wetInclusive: false, season: scheme === 'growing' ? '生长期' : '休眠期',
      source: '传统五日前期降水分级；' + MOISTURE_SOURCE }
  } else if (scheme === 'custom') {
    if (!Number.isFinite(config.dryBelow) || !Number.isFinite(config.wetFrom) ||
        config.dryBelow < 0 || config.wetFrom <= config.dryBelow ||
        typeof config.moistureSource !== 'string' || !config.moistureSource.trim()) {
      throw new Error('自定义湿润判据须提供有效阈值和出处。')
    }
    moisture = { dryBelow: config.dryBelow, wetFrom: config.wetFrom, wetInclusive: false,
      season: '自定义前期时段', source: config.moistureSource }
  } else throw new Error('湿润判据无效。')
  return { dates: { event, antecedent }, moisture }
}

export async function assembleEvent(config, store) {
  const { dates, moisture } = eventPeriod(config)
  const catalogue = await store.getJSON('catalogue.json')
  const basin = config.basin
  const year = Number(config.start.slice(0, 4))
  const basinId = catalogue.basinIds[basin]
  if (!basinId || !catalogue.layers.some(row => row.basin === basin && row.year === year)) {
    throw new Error('缺少所选区域 ' + year + ' 年土地利用。')
  }
  const drainage = config.drainage ?? 'undrained'
  const drainageSource = config.drainageSource ?? ''
  if (!['undrained', 'drained'].includes(drainage)) throw new Error('排水情景无效。')
  if (drainage === 'drained' && (typeof drainageSource !== 'string' || !drainageSource.trim())) throw new Error('请填写充分排水依据。')
  const area = store.getWeights ? await store.getWeights(basin, year) : await store.getJSON('weights/' + year + '/' + basinId + '.json')
  const allDays = [...dates.antecedent, ...dates.event]
  const wanted = [...new Set(area.groups.map(group => group.grid).filter(grid => grid >= 0))]
  const { info, fields } = await store.readRain(allDays, wanted)
  const parameters = new Map(catalogue.cnParameters.map(row => [row.land_code + '/' + row.soil, row]))
  const pavedRows = [...'ABCD'].map(soil => parameters.get('8/' + soil))
  let pavedParameter = null
  if (pavedRows.every(Boolean) && new Set(pavedRows.map(row => row.cn)).size === 1) {
    pavedParameter = { cn: pavedRows[0].cn,
      source: [...new Set(pavedRows.map(row => row.source))].sort().join('；'),
      conditions: [...new Set(pavedRows.map(row => row.conditions))].sort().join('；') + '；A/B/C/D 四土组 CN 一致，不透水面无需土组判定' }
  }
  const units = []
  const water = []
  const excluded = {}
  const exclude = (reason, km2) => { excluded[reason] = (excluded[reason] ?? 0) + km2 }
  let totalRain = 0
  let rainArea = 0
  let waterArea = 0
  let independentArea = 0
  for (const [index, group] of area.groups.entries()) {
    const { grid, landCode: code, soilCode, areaKm2: km2 } = group
    const neededDays = code === 5 ? dates.event : allDays
    if (grid < 0 || neededDays.some(day => !Number.isFinite(fields.get(day).get(grid)))) {
      exclude('降水缺测', km2)
      continue
    }
    const rain = Object.fromEntries(neededDays.map(day => [day, fields.get(day).get(grid)]))
    const eventMm = dates.event.reduce((sum, day) => sum + rain[day], 0)
    totalRain += km2 * eventMm
    rainArea += km2
    if (code === 5) {
      waterArea += km2
      water.push({ grid, areaKm2: km2, rain, volumeM3: km2 * eventMm * 1000 })
      continue
    }
    const original = SOIL_GROUPS[soilCode]
    let soil
    let parameter
    if (!original) {
      if (code !== 8 || !pavedParameter) { exclude('土组缺测', km2); continue }
      soil = '不适用'
      parameter = pavedParameter
      independentArea += km2
    } else {
      soil = drainage === 'drained' ? original.split('/')[0] : original.split('/').at(-1)
      parameter = parameters.get(code + '/' + soil)
    }
    if (!parameter) { exclude(LAND_NAMES[code] + ' / ' + soil + ' 缺少 CN', km2); continue }
    units.push({ id: basin + '-' + index, basin, grid, landCode: code, landUse: LAND_NAMES[code],
      soilCode, soilOriginal: original ?? '原始 NoData', soil, areaKm2: km2, rain,
      referenceCN: parameter.cn, cnSource: parameter.source, cnConditions: parameter.conditions })
  }
  if (!units.length) throw new Error('所选区域没有同时具备降水、土组与 CN 的有效陆地单元。')
  const quality = { basin, totalAreaKm2: area.totalAreaKm2,
    landAreaKm2: units.reduce((sum, unit) => sum + unit.areaKm2, 0), waterAreaKm2: waterArea,
    waterVolumeM3: water.reduce((sum, unit) => sum + unit.volumeM3, 0), excluded,
    excludedAreaKm2: Object.values(excluded).reduce((sum, km2) => sum + km2, 0),
    rainMm: rainArea ? totalRain / rainArea : null, spatialMethod: area.method, spatialSignature: area.signature,
    displayBasin: regionName(basin), regionNote: regionNote(basin) || catalogue.regionNotes?.[basin] || '', soilIndependentImperviousKm2: independentArea }
  if (year === 2021) {
    const audit = await store.getJSON('audit.json')
    if (audit[basin]) quality.CLCDNoDataInsideBoundaryKm2 = audit[basin].CLCDNoDataInsideBoundaryKm2
  }
  const precipitation = Object.fromEntries(['name', 'variable', 'units', 'start', 'end', 'dayBoundary'].map(key => [key, info[key]]))
  precipitation.sourceKind = info.sourceKind || 'public-cloud'
  if (info.sourceKind === 'session-netcdf') Object.assign(precipitation, {
    sourceKind: info.sourceKind, originalUnits: info.originalUnits, grid: info.grid,
    fileBytes: info.fileBytes, fileLastModified: info.fileLastModified, unitOverride: info.unitOverride,
  })
  return { input: { rainUnit: 'mm', layer: { year, version: 'CLCD ' + year + ' 核心研究区',
      cnSource: 'TR-55 初值及本地自定义参数，逐单元保留出处', rasters: [area.landRaster] },
    soilLayer: { version: 'HYSOGs250m', rasters: [area.soilRaster], source: 'https://doi.org/10.1038/sdata.2018.91',
      drainage, drainageSource }, precipitation, moisture, units }, dates, quality, waterUnits: water }
}
