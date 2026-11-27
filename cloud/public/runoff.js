const Runoff = (() => {
  const dayMs = 86400000
  const iso = time => new Date(time).toISOString().slice(0, 10)
  const sum = values => values.reduce((total, value) => total + value, 0)

  function dates(start, end) {
    const first = Date.parse(start)
    const last = Date.parse(end)
    if (![first, last].every(Number.isFinite) || iso(first) !== start || iso(last) !== end || last < first) {
      throw new Error('请输入有效的事件起止日期，结束日须晚于或等于开始日。')
    }
    return {
      antecedent: Array.from({ length: 5 }, (_, i) => iso(first - (5 - i) * dayMs)),
      event: Array.from({ length: (last - first) / dayMs + 1 }, (_, i) => iso(first + i * dayMs)),
    }
  }

  function runoff(rainMm, cn, lambda) {
    const retention = 25400 / cn - 254
    const excess = rainMm - lambda * retention
    return excess > 0 ? excess ** 2 / (excess + retention) : 0
  }

  function validate(input, period) {
    const { units, moisture, layer } = input ?? {}
    if (input?.rainUnit !== 'mm' || !units?.length || !Array.isArray(units)
        || !layer?.version || !Number.isInteger(layer.year) || !layer?.cnSource
        || !moisture?.source || !moisture?.season
        || ![moisture.dryBelow, moisture.wetFrom].every(Number.isFinite)
        || moisture.dryBelow < 0 || moisture.wetFrom <= moisture.dryBelow) {
      throw new Error('请检查降水单位（mm）、相交单元、地表版本、CN 来源及湿润判据。')
    }
    const ids = new Set()
    for (const unit of units) {
      if (!unit?.id || ids.has(unit.id) || !unit.basin || !unit.landUse || !unit.soil
          || !Number.isFinite(unit.areaKm2) || unit.areaKm2 <= 0
          || !Number.isFinite(unit.referenceCN) || unit.referenceCN <= 0 || unit.referenceCN > 100) {
        throw new Error('相交单元须包含唯一编号、流域、地类、土组、正面积及有效参考 CN。')
      }
      ids.add(unit.id)
      for (const day of [...period.antecedent, ...period.event]) {
        const rain = unit.rain?.[day]
        if (!Number.isFinite(rain) || rain < 0) throw new Error(`${unit.id} 在 ${day} 的降水缺测或无效。`)
      }
    }
  }

  function volumeScale(basin, input, quality) {
    const trialRaster = Array.isArray(input.layer?.rasters) && input.layer.rasters.some(path =>
      typeof path === 'string' && path.split(/[\\/]/).includes('taihu_trial'))
    if (basin === '太湖流域及苏南河网' && quality?.[basin]?.spatialMethod && trialRaster) {
      return 36895 / 37910.3697
    }
    return 1
  }

  function calculate(input, period, lambda, { cnDelta = 0, moistureOverride = null, quality } = {}) {
    validate(input, period)
    if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1 || !Number.isFinite(cnDelta)
        || ![null, '偏干', '适中', '偏湿'].includes(moistureOverride)) throw new Error('计算参数无效。')
    const units = input.units.map(unit => {
      const antecedentMm = sum(period.antecedent.map(day => unit.rain[day]))
      const { dryBelow, wetFrom } = input.moisture
      let moisture = '适中'
      if (antecedentMm < dryBelow) moisture = '偏干'
      if (input.moisture.wetInclusive === false ? antecedentMm > wetFrom : antecedentMm >= wetFrom) moisture = '偏湿'
      moisture = moistureOverride ?? moisture
      const referenceCN = Math.max(1, Math.min(100, unit.referenceCN + cnDelta))
      let adjustedCN = referenceCN
      if (referenceCN < 100 && moisture === '偏干') adjustedCN = referenceCN / (2.281 - 0.01281 * referenceCN)
      if (referenceCN < 100 && moisture === '偏湿') adjustedCN = referenceCN / (0.427 + 0.00573 * referenceCN)
      let rainMm = 0
      let runoffMm = 0
      const dailyRunoff = period.event.map(day => {
        rainMm += unit.rain[day]
        const next = runoff(rainMm, adjustedCN, lambda)
        const increment = next - runoffMm
        runoffMm = next
        return increment
      })
      return { ...unit, moisture, adjustedCN, antecedentMm, rainMm, runoffMm, dailyRunoff,
        volumeM3: 1000 * unit.areaKm2 * runoffMm }
    })
    const groups = new Map()
    for (const unit of units) {
      if (!groups.has(unit.basin)) groups.set(unit.basin, [])
      groups.get(unit.basin).push(unit)
    }
    const basins = Array.from(groups, ([basin, group]) => {
      const areaKm2 = sum(group.map(unit => unit.areaKm2))
      const scale = volumeScale(basin, input, quality)
      const average = key => sum(group.map(unit => unit[key] * unit.areaKm2)) / areaKm2
      const rainMm = average('rainMm')
      const runoffMm = average('runoffMm')
      return { basin, areaKm2, antecedentMm: average('antecedentMm'), rainMm, runoffMm,
        volumeScale: scale, volumeM3: sum(group.map(unit => unit.volumeM3)) * scale, coefficient: rainMm ? runoffMm / rainMm : null }
    })
    return { units, basins }
  }

  function sample(period) {
    const rows = [
      ['U01', '示例上游', '林地', 'B', 120, 58],
      ['U02', '示例上游', '耕地', 'C', 80, 79],
      ['U03', '示例下游', '耕地', 'C', 95, 79],
      ['U04', '示例下游', '建设用地', 'D', 45, 88],
    ]
    const units = rows.map(([id, basin, landUse, soil, areaKm2, referenceCN], index) => {
      const rain = Object.fromEntries([
        ...period.antecedent.map((day, i) => [day, (i + 1) * index]),
        ...period.event.map((day, i) => [day, [24, 53, 18][i % 3] + index * 4]),
      ])
      return { id, basin, landUse, soil, areaKm2, referenceCN, rain }
    })
    return { demo: true, rainUnit: 'mm', layer: { year: 2025, version: '演示地表 v1', cnSource: '合成示例 CN' },
      moisture: { dryBelow: 15, wetFrom: 40, season: '演示季节', source: '示例阈值' }, units }
  }

  return { dates, runoff, validate, calculate, sample }
})()

if (typeof module !== 'undefined') module.exports = Runoff
