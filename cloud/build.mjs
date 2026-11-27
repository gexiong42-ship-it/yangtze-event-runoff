import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'

const root = dirname(fileURLToPath(import.meta.url))
const assets = {}
for (const [name, type] of [['index.html', 'text/html; charset=utf-8'], ['app.js', 'text/javascript; charset=utf-8'],
  ['runoff.js', 'text/javascript; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'],
  ['result-view.js', 'text/javascript; charset=utf-8'], ['pwa.js', 'text/javascript; charset=utf-8'], ['rain-import.js', 'text/javascript; charset=utf-8'],
  ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']]) {
  let body = await readFile(resolve(root, 'public', name), 'utf8')
  if (name === 'index.html') body = body.replaceAll('本地资料库', '云端资料库').replace('本地数据库与 CN 参数', '云端数据库与 CN 参数')
  if (name === 'app.js') {
    body = body.replace("降水 \u0024{rain.start}", "云端降水 \u0024{rain.start}")
      .replace("请通过“启动软件.cmd”启动，并访问本地服务页面。", "请通过已部署的云端网址访问软件。")
      .replace('首次使用该年份会建立空间面积权重缓存。', '正在读取云端降水与空间面积权重。')
  }
  assets['/' + name] = { body, type }
}
const rainBundle = await build({ entryPoints: [resolve(root, 'src/rain-worker.mjs')], bundle: true,
  platform: 'browser', format: 'iife', target: 'es2022', write: false })
assets['/rain-worker.js'] = { body: rainBundle.outputFiles[0].text, type: 'text/javascript; charset=utf-8' }
const originBundle = await build({ entryPoints: [resolve(root, 'src/data-origin.mjs')], bundle: true,
  platform: 'browser', format: 'iife', globalName: 'RainSource', target: 'es2022', write: false })
assets['/data-origin.js'] = { body: originBundle.outputFiles[0].text, type: 'text/javascript; charset=utf-8' }
const scopeBundle = await build({ entryPoints: [resolve(root, 'src/region-scope.mjs')], bundle: true,
  platform: 'browser', format: 'iife', globalName: 'RegionScope', target: 'es2022', write: false })
assets['/region-scope.js'] = { body: scopeBundle.outputFiles[0].text, type: 'text/javascript; charset=utf-8' }
const personalBundle = await build({ entryPoints: [resolve(root, 'src/personal-rain-store.mjs')], bundle: true,
  platform: 'browser', format: 'iife', globalName: 'PersonalRainStore', target: 'es2022', write: false })
assets['/personal-rain-store.js'] = { body: personalBundle.outputFiles[0].text, type: 'text/javascript; charset=utf-8' }
assets['/vendor/h5wasm.js'] = { body: await readFile(resolve(root, 'node_modules/h5wasm/dist/iife/h5wasm.js'), 'utf8'), type: 'text/javascript; charset=utf-8' }
assets['/vendor/h5wasm-LICENSE.txt'] = { body: await readFile(resolve(root, 'node_modules/h5wasm/LICENSE.txt'), 'utf8'), type: 'text/plain; charset=utf-8' }
for (const size of [192, 512]) {
  const name = `/icons/icon-${size}.png`
  assets[name] = { base64: (await readFile(resolve(root, 'public', name.slice(1)))).toString('base64'), type: 'image/png' }
}
const version = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 16)
assets['/sw.js'] = { body: (await readFile(resolve(root, 'public/sw.js'), 'utf8')).replace('__BUILD_VERSION__', version),
  type: 'text/javascript; charset=utf-8' }
const worker = await readFile(resolve(root, 'src/worker.mjs'), 'utf8')
await mkdir(resolve(root, 'dist/server'), { recursive: true })
await mkdir(resolve(root, 'dist/.openai'), { recursive: true })
await build({ stdin: { contents: 'const ASSETS = ' + JSON.stringify(assets) + '\n' + worker,
  resolveDir: resolve(root, 'src'), sourcefile: 'worker.mjs', loader: 'js' },
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', outfile: resolve(root, 'dist/server/index.js') })
const hostingConfig = await readFile(resolve(root, '.openai/hosting.json')).catch(error => {
  if (error.code !== 'ENOENT') throw error
  return null
})
if (hostingConfig) await writeFile(resolve(root, 'dist/.openai/hosting.json'), hostingConfig)
const code = await readFile(resolve(root, 'dist/server/index.js'), 'utf8')
const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
if (typeof module.default?.fetch !== 'function') throw new Error('云端构建未导出 fetch。')
console.log('Cloud Worker built and validated')
