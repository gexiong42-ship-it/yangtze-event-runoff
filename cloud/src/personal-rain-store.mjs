const DB = 'yangtze-personal-rain-v1'
async function open() {
  if (!globalThis.indexedDB) throw new Error('当前浏览器不能保存个人文件，请使用仅本次导入。')
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('metadata', { keyPath: 'id' })
      request.result.createObjectStore('files', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function transaction(mode, stores, operation) {
  const database = await open()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(stores, mode)
    let value, failure
    tx.oncomplete = () => { database.close(); resolve(value) }
    tx.onabort = () => { database.close(); reject(failure || (tx.error?.name === 'QuotaExceededError'
      ? new Error('浏览器存储空间不足，文件未保存；可切换为仅本次使用。') : tx.error || new Error('个人文件操作未完成。'))) }
    try { operation(tx, result => { value = result }) } catch (error) { failure = error; tx.abort() }
  })
}
export async function save(file, metadata, settings) {
  const estimate = await globalThis.navigator?.storage?.estimate?.()
  if (estimate?.quota && file.size > estimate.quota - (estimate.usage || 0)) throw new Error('浏览器剩余存储不足，文件未保存；可切换为仅本次使用。')
  const record = { id: crypto.randomUUID(), name: file.name, bytes: file.size, lastModified: file.lastModified,
    metadata, settings, savedAt: new Date().toISOString() }
  return transaction('readwrite', ['metadata', 'files'], (tx, done) => {
    tx.objectStore('files').put({ id: record.id, blob: file })
    tx.objectStore('metadata').put(record)
    done(record)
  })
}
export function list() {
  return transaction('readonly', ['metadata'], (tx, done) => {
    tx.objectStore('metadata').getAll().onsuccess = event => done(event.target.result.sort((a, b) => b.savedAt.localeCompare(a.savedAt)))
  })
}
export async function load(id) {
  const result = await transaction('readonly', ['metadata', 'files'], (tx, done) => {
    const value = {}; done(value)
    tx.objectStore('metadata').get(id).onsuccess = event => { value.record = event.target.result }
    tx.objectStore('files').get(id).onsuccess = event => { value.file = event.target.result }
  })
  return result.record && result.file ? { ...result.record, blob: result.file.blob } : null
}
export function updateSettings(id, settings) {
  return transaction('readwrite', ['metadata'], (tx, done) => {
    const store = tx.objectStore('metadata')
    store.get(id).onsuccess = event => {
      if (!event.target.result) { tx.abort(); return }
      const record = { ...event.target.result, settings }
      store.put(record); done(record)
    }
  })
}
export function remove(id) {
  return transaction('readwrite', ['metadata', 'files'], (tx, done) => {
    tx.objectStore('metadata').delete(id); tx.objectStore('files').delete(id); done(true)
  })
}
