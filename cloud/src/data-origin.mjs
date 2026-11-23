export function label(input) {
  if (input?.demo) return '合成示例数据'
  const rain = input?.precipitation
  if (rain?.sourceKind === 'personal-netcdf') return '非公共库数据 · 个人保存 · ' + rain.name
  if (rain?.sourceKind === 'session-netcdf') return '非公共库数据 · 本次导入 · ' + rain.name
  if (rain?.sourceKind === 'public-cloud' || (!rain?.sourceKind && rain?.name === 'CN05.1')) return '公共库数据 · CN05.1'
  return '非公共库数据 · 用户导入'
}
