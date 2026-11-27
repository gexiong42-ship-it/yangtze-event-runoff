const { volume: volumeCell, renderMap, renderLandUse } = ResultView
const get = id => document.getElementById(id)
const state = { catalogue: null, runs: [], errors: [], scenarios: null, busy: false, config: null }
const number = value => value == null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
const range = days => `${days[0]} 至 ${days.at(-1)}`
const landNames = { 1: '耕地', 2: '林地', 3: '灌木地', 4: '草地', 5: '水体', 6: '冰雪', 7: '裸地', 8: '不透水面', 9: '湿地' }

function message(text = '', error = false) {
  get('message').textContent = text
  get('message').hidden = !text
  get('message').dataset.error = String(error)
}

function action(callback) {
  return async event => {
    message()
    try { await callback(event) } catch (error) { message(error.message, true) }
  }
}

async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '数据库请求失败。')
  return result
}

async function loadLandUse(row, signal) {
  const response = await fetch('/api/land-use-preview?' + new URLSearchParams(row), { signal })
  if (!response.ok) throw new Error((await response.json()).error || '土地利用图读取失败。')
  return { width: Number(response.headers.get('X-Raster-Width')),
    height: Number(response.headers.get('X-Raster-Height')), pixels: new Uint8Array(await response.arrayBuffer()) }
}

function table(id, headers, rows) {
  const target = get(id)
  target.replaceChildren()
  if (!rows.length) return
  const wrap = document.createElement('div')
  wrap.className = 'table-wrap'
  const node = document.createElement('table')
  const header = node.createTHead().insertRow()
  for (const label of headers) {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.textContent = label
    header.append(cell)
  }
  const body = node.createTBody()
  for (const values of rows) {
    const row = body.insertRow()
    for (const value of values) {
      const cell = row.insertCell()
      if (value instanceof Node) cell.append(value)
      else cell.textContent = value
    }
  }
  wrap.append(node)
  target.append(wrap)
}

function readNumber(id) {
  const input = get(id)
  if (!input.value || !input.validity.valid) throw new Error('请填写有效的数值参数。')
  return input.valueAsNumber
}

function period() {
  const dates = Runoff.dates(get('start').value, get('end').value)
  dates.antecedent = Runoff.dates(get('antecedent-start').value, get('antecedent-end').value).event
  if (dates.antecedent.at(-1) >= dates.event[0]) throw new Error('前期湿润度日期须早于事件。')
  return dates
}

function config() {
  const dates = period()
  const scheme = get('moisture-scheme').value
  const settings = {
    start: dates.event[0], end: dates.event.at(-1),
    antecedentStart: dates.antecedent[0], antecedentEnd: dates.antecedent.at(-1),
    lambda: readNumber('lambda'), moistureScheme: scheme,
    dryBelow: readNumber('dry-below'), wetFrom: readNumber('wet-from'),
    moistureSource: get('moisture-source').value.trim(),
    drainage: get('drainage').value, drainageSource: get('drainage-source').value.trim(),
  }
  if (scheme !== 'custom') {
    const expected = Runoff.dates(settings.start, settings.end).antecedent
    if (JSON.stringify(expected) !== JSON.stringify(dates.antecedent)) {
      throw new Error('传统湿润分级须使用紧邻事件的前五天。其他时段请选择自定义判据。')
    }
  } else if (!settings.moistureSource || settings.wetFrom <= settings.dryBelow) {
    throw new Error('自定义判据须填写有序阈值和出处。')
  }
  if (settings.drainage === 'drained' && !settings.drainageSource) throw new Error('请填写充分排水依据。')
  return settings
}

function selectedRegions() {
  return Array.from(get('regions').querySelectorAll('input:checked'), input => input.value)
}

function availability(basin, settings) {
  const data = state.catalogue
  const year = Number(settings.start.slice(0, 4))
  if (!data.layers.some(layer => layer.year === year && layer.basin === basin)) return `缺少 ${year} 年土地利用`
  if (!data.soilLayers.some(layer => layer.basin === basin)) return '缺少土壤图层'
  const rain = data.precipitation
  if (!rain || settings.antecedentStart < rain.start || settings.end > rain.end) return '降水日期超出本地覆盖'
  return '可计算 · 像元覆盖将在计算时核验'
}

function renderAvailability() {
  if (!state.catalogue) return
  const dates = period()
  const settings = { start: dates.event[0], end: dates.event.at(-1), antecedentStart: dates.antecedent[0] }
  const year = Number(settings.start.slice(0, 4))
  const regions = selectedRegions()
  get('landuse-match').textContent = `土地利用匹配 ${year} 年 · 前期 ${range(dates.antecedent)} · 已选 ${regions.length} 个区域`
  get('region-notes').textContent = regions.filter(basin => state.catalogue.regionNotes?.[basin])
    .map(basin => (state.catalogue.displayNames?.[basin] ?? basin) + ' — ' + state.catalogue.regionNotes[basin]).join(' ')
  table('availability', ['研究区域', '资料检查'], regions.map(basin => [basin, availability(basin, settings)]))
  table('database-preview', ['年份', '流域', '栅格尺寸'],
    state.catalogue.layers.filter(layer => layer.year === year).map(layer => [year, layer.basin, `${layer.width} × ${layer.height}`]))
  get('run').disabled = state.busy || !regions.length
}

function renderCatalogue() {
  const data = state.catalogue
  const rain = data.precipitation
  get('source').textContent = rain
    ? `降水 ${rain.start} 至 ${rain.end}，共 ${rain.days} 日。土地利用 ${data.years.length} 个年份，土壤 ${data.soilLayers.length} 幅。`
    : '尚未导入降水数据库。'
  table('soil-database-preview', ['流域', '数据集', '坐标系'], data.soilLayers.map(layer => [layer.basin, 'HYSOGs250m', layer.crs]))
  table('cn-parameters-preview', ['地类', '土组', '参考 CN', '适用条件及初值假设', '出处'],
    data.cnParameters.map(row => [landNames[row.land_code], row.soil, row.cn, row.conditions, row.source]))
  table('tr55-preview', ['TR-55 表号', '地表类型', '处理方式', '水文条件', 'A', 'B', 'C', 'D'],
    data.tr55References.map(row => [row.table, row.cover, row.treatment, row.condition,
      ...['A', 'B', 'C', 'D'].map(soil => number(row.cn[soil]))]))
  renderAvailability()
}

function updateMoistureInputs() {
  const scheme = get('moisture-scheme').value
  const custom = scheme === 'custom'
  for (const id of ['dry-below', 'wet-from', 'moisture-source']) get(id).disabled = state.busy || !custom
  if (!custom) {
    get('dry-below').value = scheme === 'growing' ? '36' : '13'
    get('wet-from').value = scheme === 'growing' ? '53' : '28'
  }
}

function setBusy(busy) {
  state.busy = busy
  for (const input of document.querySelectorAll('input,select,button')) input.disabled = busy
  updateMoistureInputs()
  get('csv').disabled = busy || !state.runs.length
  get('json').disabled = busy || !state.runs.length
  get('scenarios').disabled = busy || !state.runs.length
  get('run').disabled = busy || !state.catalogue || !selectedRegions().length
}

function clearResults() {
  state.runs = []
  state.errors = []
  state.scenarios = null
  for (const id of ['results', 'daily-preview', 'quality-preview', 'cn-preview', 'scenario-results']) get(id).replaceChildren()
  for (const id of ['csv', 'json', 'scenarios']) get(id).disabled = true
  renderMap([])
  renderLandUse([], [], loadLandUse)
  get('result-state').textContent = '输入已更新，执行计算以生成结果。'
}

function qualityOf(input, basin) {
  const units = input.units.filter(unit => unit.basin === basin)
  const area = units.reduce((sum, unit) => sum + unit.areaKm2, 0)
  return { totalAreaKm2: area, landAreaKm2: area, waterAreaKm2: 0, waterVolumeM3: 0, excludedAreaKm2: 0, excluded: {} }
}

function addRun(input, dates, quality, waterUnits = []) {
  const result = Runoff.calculate(input, dates, state.config.lambda, { quality })
  state.runs.push({ input, dates, result, quality, waterUnits })
}

function renderResults() {
  renderMap(state.runs)
  renderLandUse(state.runs, state.catalogue?.layers ?? [], loadLandUse)
  table('results', ['研究区域', '土地利用年份', 'CLCD分类面积 km²', '分类范围覆盖 %', '陆地面积 km²', '前期雨量 mm',
    '陆地事件雨量 mm', '陆地产流深 mm', '陆地产流 m³', '水面降水输入 m³', '径流系数'],
    state.runs.flatMap(run => run.result.basins.map(row => {
      const q = run.quality[row.basin]
      return [q.displayBasin ?? row.basin, run.input.layer.year, number(q.totalAreaKm2),
        number(100 * (q.landAreaKm2 + q.waterAreaKm2) / q.totalAreaKm2), number(row.areaKm2),
        number(row.antecedentMm), number(row.rainMm), number(row.runoffMm),
        volumeCell(row.volumeM3), volumeCell(q.waterVolumeM3 * row.volumeScale), number(row.coefficient)]
    })))
  const coverage = state.runs.flatMap(run => Object.entries(run.quality).map(([basin, q]) => [
    q.displayBasin ?? basin, number(q.totalAreaKm2), number(q.landAreaKm2), number(q.waterAreaKm2), number(q.excludedAreaKm2),
    [Object.entries(q.excluded).map(([reason, area]) => `${reason} ${number(area)} km²`).join('；') || '完整',
      q.soilIndependentImperviousKm2 ? `不透水面 ${number(q.soilIndependentImperviousKm2)} km² 采用四土组一致 CN，无需补土组` : '',
      q.CLCDNoDataInsideBoundaryKm2 > .01 ? `边界内 CLCD 未分类 ${number(q.CLCDNoDataInsideBoundaryKm2)} km²，未纳入分类面积分母` : '',
      q.regionNote].filter(Boolean).join('；'),
  ]))
  coverage.push(...state.errors.map(row => [row.basin, '—', '—', '—', '—', row.error]))
  table('quality-preview', ['研究区域', 'CLCD分类面积 km²', '有效陆地 km²', '有效水面 km²', '排除面积 km²', '质量说明'], coverage)
  table('cn-preview', ['流域', '单元', '面积 km²', '地类', '原始土组', '采用土组', '前期雨量 mm', '湿润条件', '参考 CN', '调整后 CN'],
    state.runs.flatMap(run => run.result.units.map(unit => [unit.basin, unit.id, number(unit.areaKm2), unit.landUse,
      unit.soilOriginal ?? unit.soil, unit.soil, number(unit.antecedentMm), unit.moisture, number(unit.referenceCN), number(unit.adjustedCN)])))
  table('daily-preview', ['流域', '日期', '陆地雨量 mm', '陆地产流增量 mm', '陆地产流增量 m³', '水面降水输入 m³'],
    state.runs.flatMap(run => run.result.basins.flatMap(basin => run.dates.event.map((day, index) => {
      const units = run.result.units.filter(unit => unit.basin === basin.basin)
      const rain = units.reduce((sum, unit) => sum + unit.areaKm2 * unit.rain[day], 0) / basin.areaKm2
      const volume = units.reduce((sum, unit) => sum + 1000 * unit.areaKm2 * unit.dailyRunoff[index], 0)
      const water = run.waterUnits.reduce((sum, unit) => sum + 1000 * unit.areaKm2 * unit.rain[day], 0)
      return [basin.basin, day, number(rain), number(volume / (1000 * basin.areaKm2)), volumeCell(volume * basin.volumeScale), volumeCell(water * basin.volumeScale)]
    }))))
  const partial = state.runs.flatMap(run => Object.values(run.quality)).filter(q => q.excludedAreaKm2 > 0).length
  get('result-state').textContent = `已完成 ${state.runs.reduce((sum, run) => sum + run.result.basins.length, 0)} 个区域，${partial} 个存在部分面积缺项，${state.errors.length} 个未能计算。`
  if (state.errors.length || partial) get('quality-details').open = true
}

async function runDatabase(event) {
  event.preventDefault()
  const settings = config()
  const regions = selectedRegions()
  if (!regions.length) throw new Error('请至少选择一个研究区域。')
  clearResults()
  state.config = settings
  setBusy(true)
  try {
    for (const [index, basin] of regions.entries()) {
      message(`正在处理 ${basin}（${index + 1}/${regions.length}）。首次使用该年份会建立空间面积权重缓存。`)
      try {
        const status = availability(basin, settings)
        if (!status.startsWith('可计算')) throw new Error(status)
        const prepared = await api('/api/event-input', { ...settings, basin })
        addRun(prepared.input, prepared.dates, { [basin]: prepared.quality }, prepared.waterUnits)
      } catch (error) { state.errors.push({ basin, error: error.message }) }
      renderResults()
    }
    const partial = state.runs.some(run => Object.values(run.quality).some(q => q.excludedAreaKm2 > 0))
    message(state.errors.length || partial ? '已完成有效覆盖区域计算。缺少资料的区域和面积请查看质量说明。' : '所选区域计算完成。', !state.runs.length)
  } finally { setBusy(false) }
}

async function runImported(input) {
  state.config = config()
  clearResults()
  setBusy(true)
  try {
    if (!input.demo) input = await api('/api/prepare', { input, year: Number(state.config.start.slice(0, 4)),
      drainage: state.config.drainage, drainageSource: state.config.drainageSource })
    const quality = Object.fromEntries([...new Set(input.units.map(unit => unit.basin))].map(basin => [basin, qualityOf(input, basin)]))
    addRun(input, period(), quality)
    renderResults()
    message(input.demo ? '已计算合成示例。' : '导入单元计算完成。')
  } finally { setBusy(false) }
}

function restoreRun(data) {
  if (!data.config || !Array.isArray(data.runs) || !data.runs.length) throw new Error('复算文件缺少配置或计算输入。')
  const fields = {
    start: 'start', end: 'end', antecedentStart: 'antecedent-start', antecedentEnd: 'antecedent-end',
    lambda: 'lambda', moistureScheme: 'moisture-scheme', dryBelow: 'dry-below', wetFrom: 'wet-from',
    moistureSource: 'moisture-source', drainage: 'drainage', drainageSource: 'drainage-source',
  }
  for (const [key, id] of Object.entries(fields)) {
    if (data.config[key] != null) get(id).value = String(data.config[key])
  }
  updateMoistureInputs()
  const settings = config()
  clearResults()
  state.config = settings
  const dates = period()
  for (const saved of data.runs) {
    Runoff.validate(saved.input, dates)
    const quality = saved.quality ?? Object.fromEntries([...new Set(saved.input.units.map(unit => unit.basin))]
      .map(basin => [basin, qualityOf(saved.input, basin)]))
    addRun(saved.input, dates, quality, saved.waterUnits ?? [])
  }
  renderAvailability()
  renderResults()
  setBusy(false)
  message('已按复算文件中的单元雨量、CN 和参数重新计算。')
}

function scenarios() {
  const delta = readNumber('delta')
  const lambdaDelta = readNumber('lambda-delta')
  const source = get('scenario-source').value.trim()
  const lambda = state.config.lambda
  if (!source) throw new Error('请填写扰动依据。')
  if (lambda - lambdaDelta < 0 || lambda + lambdaDelta > 1) throw new Error('扰动后的初损系数须在 0 至 1 之间。')
  const choices = [
    { name: 'CN 下调', lambda, cnDelta: -delta }, { name: 'CN 上调', lambda, cnDelta: delta },
    { name: '初损系数下调', lambda: lambda - lambdaDelta }, { name: '初损系数上调', lambda: lambda + lambdaDelta },
    { name: '指定湿润条件', lambda, moistureOverride: get('wetness').value },
  ]
  const runs = choices.map(choice => ({ ...choice,
    basins: state.runs.flatMap(run => Runoff.calculate(run.input, run.dates, choice.lambda, { ...choice, quality: run.quality }).basins) }))
  const summary = state.runs.flatMap(run => run.result.basins).map((row, index) => {
    const values = [row.volumeM3, ...runs.map(run => run.basins[index].volumeM3)]
    return { basin: row.basin, baselineM3: row.volumeM3, lowM3: Math.min(...values), highM3: Math.max(...values) }
  })
  state.scenarios = { source, runs, summary }
  table('scenario-results', ['流域', '基准 m³', ...choices.map(choice => choice.name + ' m³'), '范围 m³'],
    summary.map((row, index) => [row.basin, volumeCell(row.baselineM3),
      ...runs.map(run => volumeCell(run.basins[index].volumeM3)), volumeCell(row.lowM3, row.highM3)]))
}

function download(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportCsv() {
  const rows = [['研究区域', '范围说明', '事件日期', '前期日期', '土地利用年份', 'CLCD分类面积km²', '有效陆地km²', '有效水面km²',
    '覆盖率', '排除面积km²', '前期雨量mm', '陆地事件雨量mm', '陆地产流深mm', '陆地产流m³', '水面降水输入m³',
    '径流系数', '初损系数', '湿润判据出处', 'CN出处', '情景下限m³', '情景上限m³', '边界内CLCD未分类km²（不计入分类面积）',
    '产流体积换算陆地面积km²', '水面降水体积换算面积km²', '面积折算系数']]
  for (const run of state.runs) {
    for (const row of run.result.basins) {
      const q = run.quality[row.basin]
      const scenario = state.scenarios?.summary.find(item => item.basin === row.basin)
      rows.push([q.displayBasin ?? row.basin, q.regionNote || '', range(run.dates.event), range(run.dates.antecedent), run.input.layer.year, q.totalAreaKm2,
        row.areaKm2, q.waterAreaKm2, (q.landAreaKm2 + q.waterAreaKm2) / q.totalAreaKm2, q.excludedAreaKm2,
        row.antecedentMm, row.rainMm, row.runoffMm, row.volumeM3, q.waterVolumeM3 * row.volumeScale, row.coefficient,
        state.config.lambda, run.input.moisture.source, run.input.layer.cnSource, scenario?.lowM3, scenario?.highM3, q.CLCDNoDataInsideBoundaryKm2,
        row.areaKm2 * row.volumeScale, q.waterAreaKm2 * row.volumeScale, row.volumeScale])
    }
  }
  const quote = value => {
    let text = String(value ?? '')
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text
    return '"' + text.replaceAll('"', '""') + '"'
  }
  download('分流域事件产流.csv', '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n'), 'text/csv;charset=utf-8')
}

get('analysis-form').addEventListener('submit', action(runDatabase))
get('select-all').addEventListener('click', action(() => {
  const boxes = Array.from(get('regions').querySelectorAll('input'))
  const checked = !boxes.every(box => box.checked)
  boxes.forEach(box => { box.checked = checked })
  clearResults()
  renderAvailability()
}))
get('regions').addEventListener('change', action(() => { clearResults(); renderAvailability() }))
get('start').addEventListener('change', action(() => {
  const dates = Runoff.dates(get('start').value, get('start').value)
  get('antecedent-start').value = dates.antecedent[0]
  get('antecedent-end').value = dates.antecedent.at(-1)
  clearResults()
  renderAvailability()
}))
for (const id of ['start', 'end', 'antecedent-start', 'antecedent-end', 'lambda', 'moisture-scheme',
  'dry-below', 'wet-from', 'moisture-source', 'drainage', 'drainage-source']) {
  get(id).addEventListener('input', action(() => { clearResults(); updateMoistureInputs(); renderAvailability() }))
}
for (const id of ['delta', 'lambda-delta', 'wetness', 'scenario-source']) {
  get(id).addEventListener('input', () => { state.scenarios = null; get('scenario-results').replaceChildren() })
}
get('demo').addEventListener('click', action(() => runImported(Runoff.sample(period()))))
get('file').addEventListener('change', action(async event => {
  const file = event.target.files[0]
  if (!file) return
  const data = JSON.parse(await file.text())
  if (data.version === 2 && data.runs) restoreRun(data)
  else await runImported(data.input ?? data)
}))
get('cn-file').addEventListener('change', action(async event => {
  const file = event.target.files[0]
  if (!file) return
  const result = await api('/api/cn', JSON.parse(await file.text()))
  clearResults()
  state.catalogue = await api('/api/landuse')
  renderCatalogue()
  message(`已保存 ${result.saved} 条 CN 参数。`)
}))
get('scenarios').addEventListener('click', action(scenarios))
get('csv').addEventListener('click', action(exportCsv))
get('json').addEventListener('click', action(() => {
  download('分流域事件复算.json', JSON.stringify({ version: 2, config: state.config, runs: state.runs,
    sensitivity: state.scenarios, errors: state.errors }, null, 2), 'application/json')
}))
action(async () => {
  if (location.protocol === 'file:') throw new Error('请通过“启动软件.cmd”启动，并访问本地服务页面。')
  state.catalogue = await api('/api/landuse')
  for (const basin of [...new Set(state.catalogue.layers.map(layer => layer.basin))].sort()) {
    const label = document.createElement('label')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.value = basin
    checkbox.checked = true
    label.append(checkbox, document.createTextNode(state.catalogue.displayNames?.[basin] ?? basin))
    get('regions').append(label)
  }
  renderCatalogue()
})()
