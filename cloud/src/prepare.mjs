import { fromArrayBuffer } from 'geotiff'
import proj4 from 'proj4'

const names = { 1: '耕地', 2: '林地', 3: '灌木地', 4: '草地', 5: '水体', 6: '冰雪', 7: '裸地', 8: '不透水面', 9: '湿地' }
const groups = { 1: 'A', 2: 'B', 3: 'C', 4: 'D', 11: 'A/D', 12: 'B/D', 13: 'C/D', 14: 'D/D' }

export async function prepareUnits(data, bucket, catalogue) {
  const { year, drainage = 'undrained', drainageSource = '' } = data
  const result = structuredClone(data.input)
  if (!result?.units?.length) throw new Error('缺少相交单元。')
  if (!['undrained', 'drained'].includes(drainage)) throw new Error('双重土组处理选项无效。')
  if (drainage === 'drained' && !drainageSource.trim()) throw new Error('请填写充分排水依据。')
  const images = new Map()
  async function sample(layer, lon, lat) {
    const key = catalogue.rasterKeys?.[layer.path]
    if (!key) throw new Error('云端缺少栅格索引 ' + layer.path)
    if (!images.has(key)) {
      const object = await bucket.get(key)
      if (!object) throw new Error('云端缺少栅格 ' + layer.path)
      const tiff = await fromArrayBuffer(await object.arrayBuffer())
      images.set(key, await tiff.getImage())
    }
    const image = images.get(key)
    const point = layer.crs === 'EPSG:4326' ? [lon, lat] : proj4('EPSG:4326', layer.crs, [lon, lat])
    const origin = image.getOrigin(), resolution = image.getResolution()
    const col = Math.floor((point[0] - origin[0]) / resolution[0])
    const row = Math.floor((point[1] - origin[1]) / resolution[1])
    if (col < 0 || row < 0 || col >= image.getWidth() || row >= image.getHeight()) throw new Error('单元超出图层范围。')
    const values = await image.readRasters({ window: [col, row, col + 1, row + 1], samples: [0], interleave: true })
    return Number(values[0])
  }
  const sources = new Set(), landPaths = new Set(), soilPaths = new Set()
  for (const unit of result.units) {
    const layer = catalogue.layers.find(row => row.year === year && row.basin === unit.basin)
    const soilLayer = catalogue.soilLayers.find(row => row.basin === unit.basin)
    if (!layer || !soilLayer) throw new Error('缺少所选年份和区域的土地利用或土壤图层。')
    const { longitude: lon, latitude: lat } = unit
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new Error('单元缺少有效 WGS84 经度、纬度。')
    const landCode = await sample(layer, lon, lat)
    if (!names[landCode]) throw new Error('单元位于土地利用缺测或未分类像元。')
    const soilCode = await sample(soilLayer, lon, lat)
    const soilOriginal = groups[soilCode]
    if (!soilOriginal) throw new Error('单元位于土壤缺测或未知编码像元。')
    const soil = soilCode >= 11 ? (drainage === 'drained' ? soilOriginal.split('/')[0] : 'D') : soilOriginal
    const parameter = catalogue.cnParameters.find(row => row.land_code === landCode && row.soil === soil)
    if (!parameter) throw new Error('单元地类 / 土组缺少有出处的 CN 参数。')
    Object.assign(unit, { soil, soilCode, soilOriginal, soilRasterPath: soilLayer.path, soilSource: soilLayer.source,
      landUse: names[landCode], landCode, referenceCN: parameter.cn, cnSource: parameter.source,
      cnConditions: parameter.conditions, landuseYear: year, rasterPath: layer.path })
    sources.add(parameter.source); landPaths.add(layer.path); soilPaths.add(soilLayer.path)
  }
  result.layer = { year, version: `CLCD ${year} 核心研究区`, cnSource: [...sources].sort().join('；'),
    rasters: [...landPaths].sort(), lookup: 'WGS84 单元代表点像元取值' }
  result.soilLayer = { version: 'HYSOGs250m 核心研究区', rasters: [...soilPaths].sort(),
    source: catalogue.soilLayers[0].source, drainage,
    drainageSource: drainage === 'drained' ? drainageSource : '未充分排水情景，双重土组采用 D', lookup: 'WGS84 单元代表点像元取值' }
  result.missingCN = []
  return result
}
