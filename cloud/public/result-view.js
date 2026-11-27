const ResultView = (() => {
  const rounded = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
  const exact = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 21 })

  function compactVolume(value) {
    const magnitude = Math.abs(value)
    if (magnitude >= 1e8) return rounded.format(value / 1e8) + ' 亿'
    if (magnitude >= 1e4) return rounded.format(value / 1e4) + ' 万'
    return rounded.format(value)
  }

  function volume(value, upper) {
    if (!Number.isFinite(value)) return '—'
    const format = (formatter) => upper === undefined ? formatter(value) : formatter(value) + ' 至 ' + formatter(upper)
    const details = document.createElement('details')
    details.className = 'volume-detail'
    const summary = document.createElement('summary')
    summary.textContent = format(compactVolume)
    summary.title = '查看完整体积'
    const full = document.createElement('div')
    full.textContent = format(value => exact.format(value) + ' m³')
    details.append(summary, full)
    return details
  }

  function cnSummary(runs) {
    const rows = []
    const stats = () => ({ area: 0, referenceCN: 0, adjustedCN: 0 })
    const add = (target, unit) => {
      target.area += unit.areaKm2
      target.referenceCN += unit.referenceCN * unit.areaKm2
      target.adjustedCN += unit.adjustedCN * unit.areaKm2
    }
    const average = target => {
      target.referenceCN /= target.area
      target.adjustedCN /= target.area
    }
    for (const { input, dates, result } of runs) {
      const basins = new Map()
      for (const unit of result.units) {
        if (!basins.has(unit.basin)) basins.set(unit.basin, {
          ...stats(), basin: unit.basin, year: input.layer?.year ?? dates?.event[0]?.slice(0, 4),
          grid: input.precipitation?.grid, cells: new Map(),
        })
        const row = basins.get(unit.basin)
        add(row, unit)
        if (Number.isInteger(unit.grid) && unit.grid >= 0) {
          if (!row.cells.has(unit.grid)) row.cells.set(unit.grid, stats())
          add(row.cells.get(unit.grid), unit)
        }
      }
      for (const row of basins.values()) {
        average(row)
        row.cells.forEach(average)
        rows.push(row)
      }
    }
    return rows
  }

  function gridCells({ grid, cells }) {
    const latitudes = grid?.latitudes
    const longitudes = grid?.longitudes
    if (!(latitudes?.length >= 2 && longitudes?.length >= 2)) return []
    const edges = (axis, i) => {
      const center = axis[i]
      const previous = axis[i - 1] ?? 2 * center - axis[i + 1]
      const next = axis[i + 1] ?? 2 * center - axis[i - 1]
      return [(center + previous) / 2, (center + next) / 2].sort((a, b) => a - b)
    }
    return Array.from(cells, ([index, cell]) => {
      const [west, east] = edges(longitudes, index % longitudes.length)
      const [south, north] = edges(latitudes, Math.floor(index / longitudes.length))
      return { west, east, south, north, cn: cell.adjustedCN }
    }).filter(cell => [cell.west, cell.east, cell.south, cell.north].every(Number.isFinite))
  }

  function drawMap(canvas, cells) {
    const bounds = cells.reduce((box, cell) => ({
      west: Math.min(box.west, cell.west), east: Math.max(box.east, cell.east),
      south: Math.min(box.south, cell.south), north: Math.max(box.north, cell.north),
    }), { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity })
    const aspect = Math.cos((bounds.south + bounds.north) * Math.PI / 360)
    const width = (bounds.east - bounds.west) * aspect
    const height = bounds.north - bounds.south
    const scale = Math.min(580 / width, 350 / height)
    const x = lon => 24 + (lon - bounds.west) * aspect * scale
    const y = lat => 24 + (bounds.north - lat) * scale
    canvas.width = Math.ceil(width * scale + 48)
    canvas.height = Math.ceil(height * scale + 48)
    const ctx = canvas.getContext('2d')
    for (const cell of cells) {
      ctx.fillStyle = 'hsl(166, 66%, ' + (90 - 64 * cell.cn / 100) + '%)'
      ctx.fillRect(x(cell.west), y(cell.north), x(cell.east) - x(cell.west), y(cell.south) - y(cell.north))
    }
    ctx.fillStyle = '#174d45'
    ctx.font = '14px sans-serif'
    ctx.fillText('北 ↑', 8, 17)
    ctx.fillText(rounded.format(bounds.west) + '°E', 8, canvas.height - 7)
    ctx.textAlign = 'right'
    ctx.fillText(rounded.format(bounds.east) + '°E', canvas.width - 8, canvas.height - 7)
  }

  function renderMap(runs, display = value => value) {
    const button = document.getElementById('open-cn-map')
    const dialog = document.getElementById('cn-map')
    const select = document.getElementById('cn-map-basin')
    const rows = cnSummary(runs)
    button.hidden = !rows.length
    if (!rows.length && dialog.open) dialog.close()
    select.replaceChildren(...rows.map((row, i) => new Option(display(row.basin) + ' · ' + row.year + ' 年', i)))
    const update = () => {
      const row = rows[Number(select.value)]
      if (!row) return
      document.getElementById('cn-map-values').textContent =
        '参考 CN ' + rounded.format(row.referenceCN) + ' · 调整后 CN ' + rounded.format(row.adjustedCN)
      const cells = gridCells(row)
      const canvas = document.getElementById('cn-map-canvas')
      canvas.hidden = !cells.length
      document.getElementById('cn-map-legend').hidden = !cells.length
      document.getElementById('cn-map-status').textContent = cells.length
        ? '按有效陆地面积加权。图中颜色表示降水网格内的调整后 CN，网格覆盖示意流域参与计算的范围。'
        : '该结果缺少可定位的降水网格。可在上方查看流域面积加权 CN。'
      if (cells.length) drawMap(canvas, cells)
    }
    select.onchange = update
    button.onclick = () => {
      update()
      dialog.showModal()
    }
    if (dialog.open) update()
  }

  const landClasses = [
    ['未分类 / 无数据', 231, 235, 239],
    ['耕地', 239, 206, 104], ['林地', 34, 112, 67], ['灌木地', 138, 98, 46],
    ['草地', 146, 193, 91], ['水体', 54, 119, 205], ['冰雪', 239, 249, 255],
    ['裸地', 202, 161, 138], ['不透水面', 203, 72, 74], ['湿地', 44, 169, 167],
  ]

  function landUseRows(runs, layers) {
    const rows = new Map()
    for (const { input, result } of runs) {
      const year = input.layer?.year
      if (input.demo) continue
      for (const { basin } of result.basins) {
        if (layers.some(layer => layer.basin === basin && layer.year === year)) {
          rows.set(JSON.stringify([basin, year]), { basin, year })
        }
      }
    }
    return [...rows.values()]
  }

  function renderLandUse(runs, layers, load, display = value => value) {
    const button = document.getElementById('open-land-map')
    const dialog = document.getElementById('land-map')
    const select = document.getElementById('land-map-basin')
    const canvas = document.getElementById('land-map-canvas')
    const legend = document.getElementById('land-map-legend')
    const status = document.getElementById('land-map-status')
    const rows = landUseRows(runs, layers)
    dialog.cancelPreview?.()
    button.hidden = !rows.length
    if (!rows.length && dialog.open) dialog.close()
    select.replaceChildren(...rows.map(({ basin, year }, i) => new Option(display(basin) + ' · ' + year + ' 年', i)))

    async function update() {
      dialog.cancelPreview?.()
      const row = rows[Number(select.value)]
      if (!row) return
      const controller = new AbortController()
      dialog.cancelPreview = () => controller.abort()
      canvas.hidden = legend.hidden = true
      status.textContent = '正在读取土地利用图…'
      try {
        const { width, height, pixels } = await load(row, controller.signal)
        if (controller.signal.aborted) return
        if (!(width > 0 && height > 0 && pixels.length === width * height)) throw new Error('土地利用图尺寸无效。')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        const image = ctx.createImageData(width, height)
        const shown = new Set()
        for (let i = 0; i < pixels.length; i++) {
          const code = landClasses[pixels[i]] ? pixels[i] : 0
          const [, r, g, b] = landClasses[code]
          image.data.set([r, g, b, 255], i * 4)
          shown.add(code)
        }
        ctx.putImageData(image, 0, 0)
        legend.replaceChildren(...[...shown].sort((a, b) => a - b).map(code => {
          const [name, r, g, b] = landClasses[code]
          const item = document.createElement('li')
          const swatch = document.createElement('span')
          swatch.style.backgroundColor = 'rgb(' + [r, g, b].join(',') + ')'
          swatch.setAttribute('aria-hidden', 'true')
          item.append(swatch, name)
          return item
        }))
        canvas.hidden = legend.hidden = false
        status.textContent = '来源为 ' + row.year + ' 年 CLCD 裁剪栅格。地图预览采用最近邻抽样。'
      } catch (error) {
        if (!controller.signal.aborted) status.textContent = error.message || '土地利用图读取失败。'
      }
    }
    dialog.onclose = () => dialog.cancelPreview?.()
    select.onchange = update
    button.onclick = () => { dialog.showModal(); update() }
    if (dialog.open) update()
  }

  return { compactVolume, cnSummary, gridCells, landUseRows, renderMap, renderLandUse, volume }
})()

if (typeof module !== 'undefined') module.exports = ResultView
