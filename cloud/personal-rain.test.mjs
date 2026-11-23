import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import * as store from './src/personal-rain-store.mjs'
import { label } from './src/data-origin.mjs'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('personal file persists, lists without Blob, and reopens with its settings', async () => {
  const file = new File(['netcdf fixture'], 'my-rain.nc', { lastModified: 12345 })
  const record = await store.save(file, { start: '2021-01-01', end: '2021-01-08', rows: 3, cols: 3 }, { variable: 'pre', unitOverride: 'mm' })
  const list = await store.list()
  assert.equal(list.find(row => row.id === record.id).name, 'my-rain.nc')
  assert.ok(!('blob' in list[0]))
  const restored = await store.load(record.id)
  assert.equal(await restored.blob.text(), 'netcdf fixture')
  assert.equal(restored.lastModified, 12345)
  assert.equal(restored.settings.variable, 'pre')
  await store.updateSettings(record.id, { variable: 'rain', unitOverride: 'm' })
  assert.equal((await store.load(record.id)).settings.unitOverride, 'm')
  await store.remove(record.id)
  assert.equal(await store.load(record.id), null)
})
test('a Blob clone failure cannot leave an entry that claims the file was saved', async () => {
  const before = (await store.list()).length
  await assert.rejects(() => store.save({ name: 'bad.nc', size: 1, lastModified: 0, uncloneable() {} }, {}, {}))
  assert.equal((await store.list()).length, before)
})
test('imported files named CN05.1 are always marked non-public', () => {
  assert.match(label({ precipitation: { name: 'CN05.1', sourceKind: 'personal-netcdf' } }), /^非公共库数据/)
  assert.match(label({ precipitation: { name: 'CN05.1', sourceKind: 'session-netcdf' } }), /^非公共库数据/)
  assert.match(label({ precipitation: { name: 'CN05.1', sourceKind: 'public-cloud' } }), /^公共库数据/)
})
test('insufficient estimated quota rejects before creating a saved entry', async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'storage')
  Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ quota: 1, usage: 0 }) } })
  const count = (await store.list()).length
  try {
    await assert.rejects(() => store.save(new File(['too large'], 'large.nc'), {}, {}), /存储不足/)
    assert.equal((await store.list()).length, count)
  } finally {
    if (original) Object.defineProperty(navigator, 'storage', original)
    else delete navigator.storage
  }
})
test('failed selection of saved B cannot leave saved A active for calculation', async () => {
  const elements = new Map()
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: id === 'rain-source' ? 'personal' : '', textContent: '',
      replaceChildren() { this.value = '' }, add() {} })
    return elements.get(id)
  }
  class Worker {
    postMessage({ id, payload }) { queueMicrotask(() => this.onmessage({ data: { id, result: { filename: payload.file.name,
      format: 'CDF2', rows: 2, cols: 2, longitude: [118, 119], latitude: [31, 32], start: '2021-01-01', end: '2021-01-08',
      days: 8, missingDays: 0, selected: 'pre', variables: [{ name: 'pre', units: 'mm' }] } } })) }
    terminate() {}
  }
  const record = { id: 'a', name: 'A.nc', savedAt: '2026-01-01', bytes: 1, metadata: { start: '', end: '' } }
  const context = { window: {}, document: { getElementById: element }, Worker, File,
    Option: class { constructor(text, value) { this.value = value } }, navigator: {},
    PersonalRainStore: { save: async () => record, list: async () => [record], load: async () => { throw new Error('read failed') } } }
  vm.runInNewContext(await readFile(new URL('./public/rain-import.js', import.meta.url), 'utf8'), context)
  const api = context.window.RainImport
  await api.load(new File(['a'], 'A.nc')); await api.savePersonal()
  assert.equal(api.saved, true)
  await assert.rejects(() => api.loadPersonal('b'), /read failed/)
  assert.equal(api.metadata, null)
  assert.equal(api.saved, false)
  await assert.rejects(() => api.calculate({}, {}), /先导入/)
})
