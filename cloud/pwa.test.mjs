import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('public install entry serves manifest, valid PNG icons and contact address', async () => {
  const code = await readFile(new URL('./dist/server/index.js', import.meta.url), 'utf8')
  const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  const get = path => worker.fetch(new Request('https://example.com' + path), {})
  const page = await get('/download')
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /id="admin-email"[^>]*value=""/)
  assert.ok(!html.includes('mailto:'))
  assert.match(html, /id="open-install" href="\/download"/)
  const response = await get('/manifest.webmanifest')
  assert.match(response.headers.get('Content-Type'), /application\/manifest\+json/)
  const manifest = await response.json()
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.scope, '/')
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(icon => icon.sizes === `${size}x${size}`)
    const response = await get(icon.src)
    assert.equal(response.headers.get('Content-Type'), 'image/png')
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    assert.equal(bytes.readUInt32BE(16), size)
    assert.equal(bytes.readUInt32BE(20), size)
  }
  const sw = await (await get('/sw.js')).text()
  assert.ok(!sw.includes('__BUILD_VERSION__'))
})

function serviceWorker(overrides = {}) {
  const listeners = {}
  const context = { URL, Response, fetch: async () => { throw new Error('offline') },
    self: { location: { origin: 'https://example.com' }, addEventListener: (type, listener) => { listeners[type] = listener } },
    caches: { open: async () => ({ match: async key => key === '/' ? new Response('cached shell') : null }) }, ...overrides }
  return { listeners, context }
}
const sw = await readFile(new URL('./public/sw.js', import.meta.url), 'utf8')
test('cloud API, POST and external requests never enter the offline cache', () => {
  const { listeners, context } = serviceWorker()
  vm.runInNewContext(sw, context)
  for (const [url, method] of [['https://example.com/api/landuse', 'GET'],
    ['https://example.com/api/event-input', 'POST'], ['https://external.com/app.js', 'GET']]) {
    listeners.fetch({ request: { url, method, mode: 'navigate' }, respondWith: () => assert.fail('must stay network-only') })
  }
})
test('offline installed launch uses only the cached application shell', async () => {
  const { listeners, context } = serviceWorker()
  vm.runInNewContext(sw, context)
  let result
  listeners.fetch({ request: { url: 'https://example.com/?source=pwa', method: 'GET', mode: 'navigate' },
    respondWith: value => { result = value } })
  assert.equal(await (await result).text(), 'cached shell')
})
test('activation clears only old caches belonging to this application', async () => {
  const deleted = []
  const { listeners, context } = serviceWorker({ caches: {
    keys: async () => ['yangtze-runoff-shell-old', 'unrelated-app-cache'],
    delete: async key => { deleted.push(key) },
  } })
  context.self.clients = { claim: async () => {} }
  vm.runInNewContext(sw, context)
  let completion
  listeners.activate({ waitUntil: value => { completion = value } })
  await completion
  assert.deepEqual(deleted, ['yangtze-runoff-shell-old'])
})
