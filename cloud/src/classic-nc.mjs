const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 }
function number(view, offset, type) {
  if (type === 1) return view.getInt8(offset)
  if (type === 2) return view.getUint8(offset)
  if (type === 3) return view.getInt16(offset)
  if (type === 4) return view.getInt32(offset)
  if (type === 5) return view.getFloat32(offset)
  if (type === 6) return view.getFloat64(offset)
  throw new Error('不支持该 NetCDF 数值类型。')
}
export async function openClassic(file) {
  const buffer = await file.slice(0, Math.min(file.size, 16 * 1024 * 1024)).arrayBuffer()
  const view = new DataView(buffer)
  const version = view.getUint8(3)
  if (view.getUint8(0) !== 67 || view.getUint8(1) !== 68 || view.getUint8(2) !== 70 || ![1, 2].includes(version)) throw new Error('经典 NetCDF 仅支持 CDF1/CDF2；CDF5 请转为 NetCDF4。')
  let position = 4
  const uint = () => { const value = view.getUint32(position); position += 4; return value }
  const text = () => {
    const length = uint(); if (length > 1024 * 1024 || position + length > buffer.byteLength) throw new Error('NetCDF 文件头无效或过大。')
    const value = new TextDecoder().decode(new Uint8Array(buffer, position, length)); position += Math.ceil(length / 4) * 4; return value
  }
  const list = (tag, parse) => {
    const type = uint(), length = uint()
    if (!type && !length) return []
    if (type !== tag || length > 100000) throw new Error('NetCDF 文件头列表无效。')
    return Array.from({ length }, parse)
  }
  const attributes = () => Object.fromEntries(list(12, () => {
    const name = text(), type = uint(), length = uint(), size = sizes[type]
    if (!size || length * size > buffer.byteLength - position) throw new Error('NetCDF 属性无效。')
    let value
    if (type === 2) value = new TextDecoder().decode(new Uint8Array(buffer, position, length)).replace(/\0+$/, '')
    else { value = Array.from({ length }, (_, index) => number(view, position + index * size, type)); if (length === 1) value = value[0] }
    position += Math.ceil(length * size / 4) * 4
    return [name, value]
  }))
  const records = uint()
  if (records === 0xffffffff) throw new Error('不支持尚未写完的流式 NetCDF。')
  const dimensions = list(10, () => ({ name: text(), length: uint() }))
  const attrs = attributes()
  const variables = list(11, () => {
    const name = text(), count = uint()
    if (count > 16) throw new Error('变量维度过多。')
    const ids = Array.from({ length: count }, uint), attrs = attributes(), type = uint(), vsize = uint()
    let begin = uint()
    if (version === 2) begin = begin * 4294967296 + uint()
    const dims = ids.map(id => dimensions[id])
    if (dims.some(dim => !dim) || !sizes[type] || !Number.isSafeInteger(begin)) throw new Error('NetCDF 变量描述无效。')
    if (attrs._FillValue == null && type !== 2) attrs._FillValue = { 1: -127, 3: -32767, 4: -2147483647, 5: 9.969209968386869e36, 6: 9.969209968386869e36 }[type]
    return { name, dims: dims.map(dim => dim.name), shape: dims.map(dim => dim.length || records), attrs, type, vsize, begin,
      record: Boolean(dims.length && dims[0].length === 0) }
  })
  const recordVars = variables.filter(variable => variable.record)
  const recordSize = recordVars.reduce((sum, variable) => sum + Math.ceil(variable.shape.slice(1).reduce((a, b) => a * b, sizes[variable.type]) / 4) * 4, 0)
  async function read(variable, starts = variable.shape.map(() => 0), counts = variable.shape) {
    const size = sizes[variable.type], strides = variable.shape.map((_, axis) => variable.shape.slice(axis + 1).reduce((a, b) => a * b, 1))
    if (variable.record) strides[0] = (recordVars.length === 1 ? variable.shape.slice(1).reduce((a, b) => a * b, size) : recordSize) / size
    const total = counts.reduce((a, b) => a * b, 1)
    if (total > 20000000) throw new Error('单个时间片过大，请先裁剪至研究区附近。')
    const output = new Float64Array(total)
    let suffix = counts.length - 1, block = counts.at(-1) ?? 1
    while (suffix > 0 && starts[suffix] === 0 && counts[suffix] === variable.shape[suffix] &&
      strides[suffix - 1] === strides[suffix] * variable.shape[suffix]) { suffix--; block *= counts[suffix] }
    if (!strides.length) suffix = 0
    if (strides.length && strides.at(-1) !== 1) block = 1
    const groups = total / block
    if (groups > 100000) throw new Error('该维度顺序读取过于分散，请把时间维放在经纬度维之前。')
    for (let first = 0; first < groups; first += 32) {
      await Promise.all(Array.from({ length: Math.min(32, groups - first) }, async (_, i) => {
        const group = first + i
        let rest = group * block, offset = 0
        for (let axis = counts.length - 1; axis >= 0; axis--) { const index = rest % counts[axis]; rest = Math.floor(rest / counts[axis]); offset += (starts[axis] + index) * strides[axis] }
        const start = variable.begin + offset * size, bytes = await file.slice(start, start + block * size).arrayBuffer()
        if (bytes.byteLength !== block * size) throw new Error('NetCDF 数据截断。')
        const values = new DataView(bytes)
        for (let j = 0; j < block; j++) output[group * block + j] = number(values, j * size, variable.type)
      }))
    }
    return output
  }
  return { format: `NetCDF classic CDF${version}`, variables, attrs, read, close() {} }
}
