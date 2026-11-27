import { openClassic } from './classic-nc.mjs'
import { inspectDataset, h5Adapter } from './rain-dataset.mjs'
import { nativeWeights } from './rain-spatial.mjs'
import { assembleEvent, eventPeriod } from './event-input.mjs'
import { name as regionName } from './region-scope.mjs'
import { fromArrayBuffer } from 'geotiff'

let dataset = null, file = null
const weights = new Map()
async function json(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('云端资料读取失败：' + response.status)
  return response.json()
}
async function bytes(url) {
  const response = await fetch(url)
  if (!response.ok) { let reason = ''; try { reason = (await response.json()).error } catch {} throw new Error(reason || '栅格读取失败。') }
  return response.arrayBuffer()
}
async function open(fileInput) {
  dataset?.reader.close()
  dataset = null; weights.clear(); file = fileInput
  const magic = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  let reader
  if (magic[0] === 67 && magic[1] === 68 && magic[2] === 70) reader = await openClassic(file)
  else if (magic[0] === 137 && magic[1] === 72 && magic[2] === 68 && magic[3] === 70) {
    if (!self.h5wasm) importScripts('/vendor/h5wasm.js')
    const h5 = self.h5wasm
    const { FS } = await h5.ready
    try { FS.mkdir('/rain-input') } catch {}
    FS.mount(FS.filesystems.WORKERFS, { files: [new File([file], 'rain.nc')] }, '/rain-input')
    try {
      const handle = new h5.File('/rain-input/rain.nc', 'r')
      reader = h5Adapter(handle)
      reader.close = () => { handle.close(); FS.unmount('/rain-input') }
    } catch (error) { FS.unmount('/rain-input'); throw error }
  } else throw new Error('文件不是支持的 NetCDF classic 或 NetCDF4/HDF5 格式。')
  try { dataset = await inspectDataset(reader, file.name) } catch (error) { reader.close(); throw error }
  return dataset.description
}
self.addEventListener('message', async event => {
  const { id, type, payload } = event.data
  const progress = text => self.postMessage({ id, progress: text })
  try {
    let result
    if (type === 'land-use-preview') {
      const { basin, year } = payload
      const query = new URLSearchParams({ basin, year: String(year), kind: 'land' })
      const raster = await (await fromArrayBuffer(await bytes('/api/raster?' + query))).getImage()
      const scale = Math.min(1, 960 / Math.max(raster.getWidth(), raster.getHeight()))
      const width = Math.max(1, Math.round(raster.getWidth() * scale))
      const height = Math.max(1, Math.round(raster.getHeight() * scale))
      const samples = await raster.readRasters({ width, height, samples: [0], interleave: true, resampleMethod: 'nearest' })
      const noData = raster.getGDALNoData()
      const pixels = Uint8Array.from(samples, code => code !== noData && code >= 1 && code <= 9 ? code : 0)
      self.postMessage({ id, result: { width, height, pixels } }, [pixels.buffer])
      return
    } else if (type === 'open') result = await open(payload.file)
    else if (type === 'calculate') {
      if (!dataset) throw new Error('请先选择 NetCDF 文件。')
      const { config, catalogue, variable, unitOverride } = payload
      dataset.validate(variable, unitOverride)
      const { dates } = eventPeriod(config)
      for (const day of [...dates.antecedent, ...dates.event]) {
        if (!dataset.days.includes(day)) throw new Error('导入文件缺少日期 ' + day + '，事件及前期湿润度日期都须覆盖。')
      }
      const year = Number(config.start.slice(0, 4)), basin = config.basin
      const key = year + '/' + basin
      const land = catalogue.layers.find(row => row.basin === basin && row.year === year)
      const soil = catalogue.soilLayers.find(row => row.basin === basin)
      if (!land || !soil) throw new Error('该年份或区域缺少土地利用、土壤图层。')
      if (!weights.has(key)) {
        progress('正在下载 ' + regionName(basin) + ' 的云端地类与土组栅格…')
        const base = '/api/raster?' + new URLSearchParams({ basin, year: String(year) })
        const [landBytes, soilBytes] = await Promise.all([bytes(base + '&kind=land'), bytes(base + '&kind=soil')])
        progress('正在匹配原生像元与新降水网格，可取消…')
        const area = await nativeWeights({ landBytes, soilBytes, metadata: { land, soil },
          lat: dataset.lat, lon: dataset.lon, basin, year,
          progress: ({ completed, total }) => progress(regionName(basin) + ' 空间匹配 ' + Math.round(completed / total * 100) + '%（原生像元面积统计）') })
        if (weights.size >= 5) weights.delete(weights.keys().next().value)
        weights.set(key, area)
      }
      progress('正在读取事件及前期逐日降水，匹配 CN…')
      result = await assembleEvent(config, {
        getJSON: path => path === 'catalogue.json' ? Promise.resolve(catalogue) : json('/api/import-reference?' + new URLSearchParams({ kind: path })),
        getWeights: async () => weights.get(key),
        readRain: async (days, wanted) => {
          const value = await dataset.readRain(days, wanted, variable, unitOverride)
          Object.assign(value.info, { sourceKind: 'session-netcdf', fileBytes: file.size, fileLastModified: file.lastModified,
            unitOverride: unitOverride || null, grid: { latitudes: dataset.lat.values, longitudes: dataset.lon.values } })
          return value
        },
      })
    } else throw new Error('未知导入任务。')
    self.postMessage({ id, result })
  } catch (error) { self.postMessage({ id, error: error.message || '导入计算失败。' }) }
})
