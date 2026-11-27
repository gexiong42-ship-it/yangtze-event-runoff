// Stable dataset identifiers are retained; labels describe the verified spatial scope.
export const TAIHU_ID = '太湖流域及苏南河网'
export const TAIHU_NAME = '太湖流域（八区外缘试用边界）'
export const TAIHU_NOTE = '边界据太浦河后续（一期）工程环境影响报告书图4.1-1配准并概化描绘，按提供的八区外缘试用边界计算。'
export function name(id) { return id === TAIHU_ID ? TAIHU_NAME : id }
export function note(id) { return id === TAIHU_ID ? TAIHU_NOTE : '' }
export function display(value) {
  if (value === TAIHU_ID) return TAIHU_NAME
  if (typeof value === 'string' && value.startsWith(TAIHU_ID + '-')) return TAIHU_NAME + value.slice(TAIHU_ID.length)
  return value
}
export function annotate(catalogue) {
  return { ...catalogue, displayNames: { ...catalogue.displayNames, [TAIHU_ID]: TAIHU_NAME },
    regionNotes: { ...catalogue.regionNotes, [TAIHU_ID]: TAIHU_NOTE } }
}
