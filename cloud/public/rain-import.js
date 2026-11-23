(() => {
  let worker = null, file = null, metadata = null, sequence = 0, cancelled = false, savedRecord = null, generation = 0
  const pending = new Map()
  function spawn() {
    worker = new Worker('/rain-worker.js', { name: 'NetCDF 日降水解析与空间匹配' })
    worker.onmessage = event => {
      const { id, progress, error, result } = event.data, task = pending.get(id)
      if (!task) return
      if (progress) { task.progress?.(progress); return }
      pending.delete(id)
      error ? task.reject(new Error(error)) : task.resolve(result)
    }
    worker.onerror = () => {
      for (const task of pending.values()) task.reject(new Error('导入处理器未能运行，请检查网络；大文件可先裁剪到研究区域附近。'))
      pending.clear(); worker?.terminate(); worker = null
    }
  }
  function request(type, payload, progress) {
    if (!worker) spawn()
    return new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject, progress }); worker.postMessage({ id, type, payload }) })
  }
  function cancel() {
    generation++
    cancelled = true; worker?.terminate(); worker = null
    for (const task of pending.values()) task.reject(new Error('已取消 NetCDF 导入或空间匹配。'))
    pending.clear()
  }
  function render() {
    const preview = document.getElementById('nc-preview')
    if (!metadata) { preview.textContent = '请选择逐日 NetCDF 文件；支持 classic CDF1/CDF2 和 NetCDF4/HDF5 的一维经纬度网格。'; return }
    preview.textContent = `${metadata.filename} · ${metadata.format} · ${metadata.cols} × ${metadata.rows} 格点 · 经度 ${metadata.longitude.join(' 至 ')}°，纬度 ${metadata.latitude.join(' 至 ')}° · ${metadata.start} 至 ${metadata.end}（${metadata.days} 日，时段内缺 ${metadata.missingDays} 日）。`
  }
  const settings = () => ({ variable: document.getElementById('nc-variable').value, unitOverride: document.getElementById('nc-units').value })
  async function refreshLibrary(selected = savedRecord?.id || document.getElementById('personal-rain-list').value) {
    const records = await PersonalRainStore.list()
    const picker = document.getElementById('personal-rain-list')
    picker.replaceChildren(new Option('请选择已保存文件，或下方选择新文件', ''))
    for (const record of records) picker.add(new Option(`${record.name} · ${(record.bytes / 1048576).toFixed(2)} MB · ${record.metadata.start} 至 ${record.metadata.end}`, record.id))
    picker.value = records.some(record => record.id === selected) ? selected : ''
    return records
  }
  window.RainImport = {
    get metadata() { return metadata },
    get cancelled() { return cancelled },
    get active() { return ['netcdf', 'personal'].includes(document.getElementById('rain-source').value) },
    get saved() { return Boolean(savedRecord) },
    refreshLibrary,
    async load(input) {
      cancel(); cancelled = false; file = input; metadata = null; savedRecord = null
      document.getElementById('personal-rain-list').value = ''; render()
      document.getElementById('nc-preview').textContent = '正在读取文件头、经纬度与时间坐标…（文件不会上传）'
      metadata = await request('open', { file })
      const select = document.getElementById('nc-variable')
      select.replaceChildren(new Option('请选择降水变量', ''))
      for (const variable of metadata.variables) select.add(new Option(`${variable.name} · ${variable.units || '单位未识别'}${variable.longName ? ' · ' + variable.longName.trim() : ''}`, variable.name))
      select.value = metadata.selected
      document.getElementById('nc-units').value = ''
      render(); return metadata
    },
    async savePersonal() {
      if (!file || !metadata) throw new Error('请先选择并解析有效 NetCDF 文件。')
      savedRecord = savedRecord ? await PersonalRainStore.updateSettings(savedRecord.id, settings())
        : await PersonalRainStore.save(file, metadata, settings())
      let listMessage = ''
      try { await refreshLibrary(savedRecord.id) } catch { listMessage = ' 列表刷新失败，可重新打开页面查看。' }
      document.getElementById('personal-rain-status').textContent = `已保存 ${savedRecord.name}，下次可在本浏览器的个人文件列表选择使用。` + listMessage
      try { navigator.storage?.persist?.().catch(() => false) } catch {}
      return savedRecord
    },
    async loadPersonal(id) {
      this.clear()
      const loadingGeneration = generation
      const record = await PersonalRainStore.load(id)
      if (loadingGeneration !== generation || cancelled) throw new Error('已取消载入个人文件。')
      if (!record) { await refreshLibrary(''); throw new Error('该个人文件已被移除，请重新导入。') }
      await this.load(new File([record.blob], record.name, { lastModified: record.lastModified, type: 'application/x-netcdf' }))
      savedRecord = { ...record }; delete savedRecord.blob
      const selection = record.settings || {}
      if (metadata.variables.some(variable => variable.name === selection.variable)) document.getElementById('nc-variable').value = selection.variable
      document.getElementById('nc-units').value = selection.unitOverride || ''
      document.getElementById('personal-rain-list').value = record.id
      document.getElementById('personal-rain-status').textContent = `已载入个人文件 ${record.name}（非公共库数据）。`
    },
    async removePersonal(id) {
      await PersonalRainStore.remove(id)
      if (savedRecord?.id === id) this.clear()
      await refreshLibrary('')
      document.getElementById('personal-rain-status').textContent = '已删除本浏览器中的该个人文件，公共库未改变。'
    },
    beginRun() { cancelled = false },
    async calculate(config, catalogue, progress) {
      if (!file || !metadata) throw new Error('请先导入有效 NetCDF 文件。')
      if (!worker) await request('open', { file })
      const personal = document.getElementById('rain-source').value === 'personal' && savedRecord
      if (personal) savedRecord = await PersonalRainStore.updateSettings(savedRecord.id, settings())
      const result = await request('calculate', { config, catalogue, ...settings() }, progress)
      if (personal) Object.assign(result.input.precipitation, {
        sourceKind: 'personal-netcdf', personalStorage: 'current-browser', personalRecordId: savedRecord.id, savedAt: savedRecord.savedAt,
      })
      return result
    },
    cancel,
    clear() {
      cancel(); cancelled = false; file = null; metadata = null; savedRecord = null
      document.getElementById('personal-rain-list').value = ''
      document.getElementById('personal-rain-status').textContent = ''
      document.getElementById('nc-file').value = ''
      document.getElementById('nc-variable').replaceChildren(new Option('请先选择文件', ''))
      document.getElementById('nc-units').value = ''; render()
    },
  }
  render()
})()
