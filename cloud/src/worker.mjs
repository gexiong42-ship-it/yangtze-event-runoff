import { assembleEvent } from './event-input.mjs'
import { prepareUnits } from './prepare.mjs'
import { annotate } from './region-scope.mjs'

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } })
}

async function objectJSON(bucket, key) {
  const object = await bucket.get(key === 'catalogue.json' ? 'taihu-eight-v1/catalogue.json' : key)
  if (!object) throw new Error('云端资料尚未就绪 ' + key)
  const data = await object.json()
  return key === 'catalogue.json' ? annotate(data) : data
}

function checkedKey(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.split('/').includes('..') || value.length > 1000) {
    throw new Error('资料对象名称无效。')
  }
  return value
}

async function readCloudRain(bucket, days, wanted) {
  const [info, index] = await Promise.all([objectJSON(bucket, 'rain/meta.json'), objectJSON(bucket, 'rain/index.json')])
  const fields = new Map()
  const uniqueDays = [...new Set(days)]
  for (let start = 0; start < uniqueDays.length; start += 4) {
    await Promise.all(uniqueDays.slice(start, start + 4).map(async day => {
      const record = index[day]
      if (!record) throw new Error('降水数据库缺少日期 ' + day)
      const object = await bucket.get(record.key, { range: { offset: record.offset, length: record.length } })
      if (!object) throw new Error('云端降水分块缺失。')
      const bytes = await new Response(object.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer()
      const values = new Float32Array(bytes)
      const gridCount = info.latitudes.length * info.longitudes.length
      if (values.length !== gridCount) throw new Error('降水分块长度校验失败。')
      fields.set(day, new Map(wanted.map(grid => [grid, values[grid]])))
    }))
  }
  return { info, fields }
}

async function storageRequest(request, env, url) {
  const bucket = env.BUCKET
  const route = url.pathname
  if (route === '/api/storage/status') {
    const ready = await bucket.get('ready.json')
    return jsonResponse(ready ? await ready.json() : { ready: false })
  }
  if (route === '/api/storage/object' && request.method === 'GET') {
    const object = await bucket.head(checkedKey(url.searchParams.get('key')))
    return jsonResponse(object ? { size: object.size, sha256: object.customMetadata?.sha256, etag: object.etag } : { missing: true })
  }
  if (route === '/api/storage/put' && request.method === 'PUT') {
    const key = checkedKey(url.searchParams.get('key'))
    const bytes = await request.arrayBuffer()
    if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('请使用分块上传。')
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== request.headers.get('X-Content-SHA256')) throw new Error('上传数据校验失败。')
    const object = await bucket.put(key, bytes, { customMetadata: { sha256: hash } })
    return jsonResponse({ size: object.size, sha256: hash })
  }
  if (route === '/api/storage/begin' && request.method === 'POST') {
    const data = await request.json()
    if (!/^[a-f0-9]{64}$/.test(data.sha256)) throw new Error('文件校验码无效。')
    const upload = await bucket.createMultipartUpload(checkedKey(data.key), { customMetadata: { sha256: data.sha256 } })
    return jsonResponse({ uploadId: upload.uploadId, key: upload.key })
  }
  if (route === '/api/storage/part' && request.method === 'PUT') {
    const key = checkedKey(url.searchParams.get('key'))
    const number = Number(url.searchParams.get('part'))
    const id = url.searchParams.get('uploadId')
    if (!id || !Number.isInteger(number) || number < 1 || number > 10000) throw new Error('上传分块信息无效。')
    const bytes = await request.arrayBuffer()
    if (bytes.byteLength > 16 * 1024 * 1024) throw new Error('分块过大。')
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
    if (hash !== request.headers.get('X-Content-SHA256')) throw new Error('分块校验失败。')
    const part = await bucket.resumeMultipartUpload(key, id).uploadPart(number, bytes)
    return jsonResponse(part)
  }
  if (route === '/api/storage/complete' && request.method === 'POST') {
    const data = await request.json()
    const key = checkedKey(data.key)
    const object = await bucket.resumeMultipartUpload(key, data.uploadId).complete(data.parts)
    if (object.size !== data.size) throw new Error('文件长度校验失败。')
    return jsonResponse({ size: object.size, sha256: object.customMetadata?.sha256 })
  }
  if (route === '/api/storage/abort' && request.method === 'POST') {
    const data = await request.json()
    await bucket.resumeMultipartUpload(checkedKey(data.key), data.uploadId).abort()
    return jsonResponse({ aborted: true })
  }
  if (route === '/api/storage/commit' && request.method === 'POST') {
    const data = await request.json()
    if (!Array.isArray(data.files) || !data.files.length) throw new Error('资料清单无效。')
    for (let start = 0; start < data.files.length; start += 4) {
      await Promise.all(data.files.slice(start, start + 4).map(async item => {
        const object = await bucket.head(checkedKey(item.key))
        if (!object || object.size !== item.bytes || object.customMetadata?.sha256 !== item.sha256) {
          throw new Error('云端资料未完成校验 ' + item.key)
        }
      }))
    }
    const ready = { ready: true, fileCount: data.files.length,
      totalBytes: data.files.reduce((sum, item) => sum + item.bytes, 0), completedAt: new Date().toISOString() }
    await bucket.put('uploaded-manifest.json', JSON.stringify(data))
    await bucket.put('ready.json', JSON.stringify(ready))
    return jsonResponse(ready)
  }
  return jsonResponse({ error: '未找到接口。' }, 404)
}

async function saveCloudParameters(bucket, rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('参数表应为非空数组。')
  const seen = new Set()
  for (const row of rows) {
    const key = row.landCode + '/' + row.soil
    if (!Number.isInteger(row.landCode) || row.landCode < 1 || row.landCode > 9 ||
        !['A', 'B', 'C', 'D'].includes(row.soil) || !Number.isFinite(row.cn) || row.cn <= 0 || row.cn > 100 ||
        typeof row.source !== 'string' || !row.source.trim() || typeof row.conditions !== 'string' || !row.conditions.trim() ||
        seen.has(key)) throw new Error('参数表包含无效或重复记录。')
    seen.add(key)
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const snapshot = await bucket.get('catalogue.json')
    if (!snapshot) throw new Error('云端参数库尚未就绪。')
    const catalogue = await snapshot.json()
    const parameters = new Map(catalogue.cnParameters.map(row => [row.land_code + '/' + row.soil, row]))
    for (const row of rows) parameters.set(row.landCode + '/' + row.soil, {
      land_code: row.landCode, soil: row.soil, cn: row.cn, source: row.source.trim(), conditions: row.conditions.trim(),
    })
    catalogue.cnParameters = [...parameters.values()].sort((a, b) => a.land_code - b.land_code || a.soil.localeCompare(b.soil))
    catalogue.cnParameterCount = catalogue.cnParameters.length
    const saved = await bucket.put('catalogue.json', JSON.stringify(catalogue), { onlyIf: { etagMatches: snapshot.etag } })
    if (saved) return { saved: rows.length }
  }
  throw new Error('参数正在被其他会话更新，请重试。')
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      const sharedWrite = url.pathname === '/api/cn' ||
        (url.pathname.startsWith('/api/storage/') && !['GET', 'HEAD'].includes(request.method))
      if (sharedWrite && (!env.ADMIN_WRITE_TOKEN || request.headers.get('X-Admin-Token') !== env.ADMIN_WRITE_TOKEN)) {
        return jsonResponse({ error: '公共网站仅开放计算；共享资料与参数须由管理员维护。' }, 403)
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const origin = request.headers.get('Origin')
        if (origin && origin !== url.origin) return jsonResponse({ error: '请求来源无效。' }, 403)
      }
      if (url.pathname.startsWith('/api/storage/')) return await storageRequest(request, env, url)
      if (url.pathname === '/api/landuse') {
        const catalogue = await objectJSON(env.BUCKET, 'catalogue.json')
        const status = await env.BUCKET.get('ready.json')
        catalogue.cloudStorage = status ? await status.json() : { ready: false }
        catalogue.sharedReadOnly = true
        return jsonResponse(catalogue)
      }
      if (url.pathname === '/api/raster' && ['GET', 'HEAD'].includes(request.method)) {
        const catalogue = await objectJSON(env.BUCKET, 'catalogue.json')
        const basin = url.searchParams.get('basin'), year = Number(url.searchParams.get('year'))
        const kind = url.searchParams.get('kind')
        const land = catalogue.layers.find(row => row.basin === basin && row.year === year)
        const soil = catalogue.soilLayers.find(row => row.basin === basin)
        if (!land || !soil || !['land', 'soil'].includes(kind)) return jsonResponse({ error: '所选区域、年份或图层无效。' }, 400)
        const layer = kind === 'land' ? land : soil
        const key = catalogue.rasterKeys?.[layer.path]
        if (!key) return jsonResponse({ error: '栅格索引缺失。' }, 404)
        const object = await env.BUCKET.get(key)
        if (!object) return jsonResponse({ error: '云端栅格缺失。' }, 404)
        return new Response(request.method === 'HEAD' ? null : object.body, { headers: {
          'Content-Type': 'image/tiff', 'Content-Length': String(object.size), 'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        } })
      }
      if (url.pathname === '/api/import-reference' && request.method === 'GET') {
        if (url.searchParams.get('kind') !== 'audit.json') return jsonResponse({ error: '资料名称无效。' }, 400)
        return jsonResponse(await objectJSON(env.BUCKET, 'audit.json'))
      }
      if (url.pathname === '/api/event-input' && request.method === 'POST') {
        const config = await request.json()
        return jsonResponse(await assembleEvent(config, {
          getJSON: key => objectJSON(env.BUCKET, key),
          readRain: (days, wanted) => readCloudRain(env.BUCKET, days, wanted),
        }))
      }
      if (url.pathname === '/api/cn' && request.method === 'POST') {
        return jsonResponse(await saveCloudParameters(env.BUCKET, await request.json()))
      }
      if (url.pathname === '/api/prepare' && request.method === 'POST') {
        return jsonResponse(await prepareUnits(await request.json(), env.BUCKET, await objectJSON(env.BUCKET, 'catalogue.json')))
      }
      const asset = ASSETS[['/', '/download'].includes(url.pathname) ? '/index.html' : url.pathname]
      if (asset) return new Response(request.method === 'HEAD' ? null :
        asset.base64 ? Uint8Array.from(atob(asset.base64), char => char.charCodeAt(0)) : asset.body, {
        headers: { 'Content-Type': asset.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
      })
      return jsonResponse({ error: '未找到页面。' }, 404)
    } catch (error) {
      return jsonResponse({ error: error.message || '云端请求失败。' }, 400)
    }
  },
}
