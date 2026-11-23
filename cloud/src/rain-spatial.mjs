import { fromArrayBuffer } from 'geotiff'
import proj4 from 'proj4'
import { cellIndex } from './rain-common.mjs'

export async function nativeWeights({ landBytes, soilBytes, metadata, lat, lon, basin, year, progress = () => {} }) {
  const land = await (await fromArrayBuffer(landBytes)).getImage()
  const soil = await (await fromArrayBuffer(soilBytes)).getImage()
  const soilValues = await soil.readRasters({ samples: [0], interleave: true })
  const origin = land.getOrigin(), res = land.getResolution(), soilOrigin = soil.getOrigin(), soilRes = soil.getResolution()
  const width = land.getWidth(), height = land.getHeight(), soilWidth = soil.getWidth(), soilHeight = soil.getHeight()
  if (!/Albers|\+proj=aea/i.test(metadata.land.crs)) throw new Error('面积统计需要现有 CLCD Albers 等积米制图层。')
  const toWgs = proj4(metadata.land.crs, 'EPSG:4326')
  const toSoil = metadata.soil.crs === 'EPSG:4326' ? null : proj4('EPSG:4326', metadata.soil.crs)
  const pixelArea = Math.abs(res[0] * res[1]) / 1e6
  const counts = new Map(), soilCodes = new Set([1, 2, 3, 4, 11, 12, 13, 14])
  const tile = 256, total = Math.ceil(width / tile) * Math.ceil(height / tile)
  let completed = 0, validPixels = 0
  for (let row = 0; row < height; row += tile) {
    for (let col = 0; col < width; col += tile) {
      const right = Math.min(col + tile, width), bottom = Math.min(row + tile, height)
      const classes = await land.readRasters({ window: [col, row, right, bottom], samples: [0], interleave: true })
      const tileWidth = right - col
      for (let r = row; r < bottom; r++) {
        const y = origin[1] + (r + .5) * res[1]
        for (let c = col; c < right; c++) {
          const code = Number(classes[(r - row) * tileWidth + c - col])
          if (!(code >= 1 && code <= 9)) continue
          const x = origin[0] + (c + .5) * res[0]
          const [longitude, latitude] = toWgs.forward([x, y])
          const gi = cellIndex(lat, latitude), gj = cellIndex(lon, longitude)
          const grid = gi < 0 || gj < 0 ? -1 : gi * lon.values.length + gj
          const point = toSoil ? toSoil.forward([longitude, latitude]) : [longitude, latitude]
          const si = Math.floor((point[1] - soilOrigin[1]) / soilRes[1]), sj = Math.floor((point[0] - soilOrigin[0]) / soilRes[0])
          let soilCode = si >= 0 && sj >= 0 && si < soilHeight && sj < soilWidth ? Number(soilValues[si * soilWidth + sj]) : 255
          if (!soilCodes.has(soilCode)) soilCode = 255
          const key = grid * 10000 + code * 1000 + soilCode
          counts.set(key, (counts.get(key) ?? 0) + 1)
          validPixels++
        }
      }
      if (counts.size > 500000) throw new Error('空间相交组合超过 50 万，请先降低分辨率或缩小区域。')
      completed++
      if (completed % 16 === 0 || completed === total) progress({ completed, total, basin })
    }
  }
  const groups = [...counts].sort((a, b) => a[0] - b[0]).map(([key, pixels]) => {
    const grid = Math.floor(key / 10000), rest = key - grid * 10000
    return { grid, landCode: Math.floor(rest / 1000), soilCode: rest % 1000, pixels, areaKm2: pixels * pixelArea }
  })
  const signature = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
    year, basin, lat: lat.values, lon: lon.values, land: metadata.land.path, soil: metadata.soil.path,
  })))), value => value.toString(16).padStart(2, '0')).join('')
  return { basin, year, groups, totalAreaKm2: validPixels * pixelArea, pixelAreaKm2: pixelArea, signature,
    landRaster: metadata.land.path, soilRaster: metadata.soil.path,
    method: '原生 CLCD 像元中心匹配导入 NetCDF 经度/纬度网格及最近邻 HYSOGs 土组，按等积像元面积统计' }
}
