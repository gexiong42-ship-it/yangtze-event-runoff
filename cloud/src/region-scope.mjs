// Stable dataset identifiers are retained; labels describe the verified spatial scope.
export const RECTANGLE_ID = '太湖流域及苏南河网'
export const RECTANGLE_NAME = '太湖周边及部分苏南沿江区域'
export const RECTANGLE_NOTE = '该选项采用约 119.1333—121.9167°E、30.0833—32.1333°N 的经纬度矩形范围，尚未按经核实的太湖流域或沿江排水分区边界裁剪。结果仅代表矩形内 CLCD 有效分类区域的降雨产流估算，不代表完整太湖流域产流，也不能直接等同于入江排水量。面积与覆盖率以 CLCD 有效分类范围为基准。'
export function name(id) { return id === RECTANGLE_ID ? RECTANGLE_NAME : id }
export function note(id) { return id === RECTANGLE_ID ? RECTANGLE_NOTE : '' }
export function display(value) {
  if (value === RECTANGLE_ID) return RECTANGLE_NAME
  if (typeof value === 'string' && value.startsWith(RECTANGLE_ID + '-')) return RECTANGLE_NAME + value.slice(RECTANGLE_ID.length)
  return value
}
export function annotate(catalogue) {
  return { ...catalogue, displayNames: { ...catalogue.displayNames, [RECTANGLE_ID]: RECTANGLE_NAME },
    regionNotes: { ...catalogue.regionNotes, [RECTANGLE_ID]: RECTANGLE_NOTE } }
}
