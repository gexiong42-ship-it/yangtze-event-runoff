const test = require('node:test')
const assert = require('node:assert/strict')
const { dates, runoff, calculate, sample } = require('./runoff.js')

test('前五日跨年且与事件紧邻', () => {
  assert.deepEqual(dates('2026-01-02', '2026-01-03').antecedent,
    ['2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01'])
  assert.throws(() => dates('2026-02-30', '2026-03-03'))
})

test('初损作用于事件累计雨量', () => {
  assert.equal(runoff(10, 80, 0.2), 0)
  const period = dates('2026-08-10', '2026-08-12')
  const input = sample(period)
  const result = calculate(input, period, 0.2)
  for (const unit of result.units) {
    assert.ok(Math.abs(unit.dailyRunoff.reduce((sum, value) => sum + value, 0) - unit.runoffMm) < 1e-9)
    assert.equal(unit.runoffMm, runoff(unit.rainMm, unit.adjustedCN, 0.2))
  }
})

test('1 平方公里产生 1 毫米径流对应 1000 立方米', () => {
  const period = dates('2026-08-10', '2026-08-10')
  const input = sample(period)
  input.units = [{ ...input.units[0], areaKm2: 1, referenceCN: 100,
    rain: Object.fromEntries([...period.antecedent, ...period.event].map(day => [day, Number(day === period.event[0])])) }]
  assert.equal(calculate(input, period, 0.2).basins[0].volumeM3, 1000)
})

test('缺测阻断计算，零降水仍为有效记录', () => {
  const period = dates('2026-08-10', '2026-08-10')
  const input = sample(period)
  input.units[0].rain[period.antecedent[0]] = 0
  assert.ok(calculate(input, period, 0.2).units.length)
  input.units[0].rain[period.antecedent[0]] = null
  assert.throws(() => calculate(input, period, 0.2), /缺测/)
})

test('传统湿润判据在上限值时仍保持适中', () => {
  const period = dates('2021-07-01', '2021-07-03')
  const input = sample(period)
  input.moisture = { dryBelow: 36, wetFrom: 53, wetInclusive: false, season: '生长期', source: 'test' }
  for (const day of period.antecedent) input.units[0].rain[day] = 0
  input.units[0].rain[period.antecedent[0]] = 53
  assert.equal(calculate(input, period, 0.2).units[0].moisture, '适中')
  input.units[0].rain[period.antecedent[0]] = 53.01
  assert.equal(calculate(input, period, 0.2).units[0].moisture, '偏湿')
})
