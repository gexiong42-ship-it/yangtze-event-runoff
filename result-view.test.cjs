const { test } = require('node:test')
const assert = require('node:assert/strict')
const { compactVolume, cnSummary } = require('./result-view.js')

test('volume labels use Chinese units at the thresholds', () => {
  assert.equal(compactVolume(9999), '9,999')
  assert.equal(compactVolume(12345.67), '1.23 万')
  assert.equal(compactVolume(123456789), '1.23 亿')
  assert.equal(compactVolume(0), '0')
})

test('CN averages are area-weighted by basin and geographic grid cell', () => {
  const units = [
    { basin: 'A', grid: 0, areaKm2: 1, referenceCN: 60, adjustedCN: 50 },
    { basin: 'A', grid: 0, areaKm2: 3, referenceCN: 80, adjustedCN: 70 },
    { basin: 'A', grid: 1, areaKm2: 2, referenceCN: 90, adjustedCN: 80 },
    { basin: 'B', grid: 0, areaKm2: 10, referenceCN: 30, adjustedCN: 20 },
  ]
  const [first, second] = cnSummary([{ result: { units }, input: { layer: { year: 2021 } } }])
  assert.equal(first.year, 2021)
  assert.equal(first.referenceCN, 80)
  assert.equal(first.adjustedCN, 70)
  assert.equal(first.cells.get(0).adjustedCN, 65)
  assert.equal(second.adjustedCN, 20)
})

test('land use maps use the computed CLCD year and skip synthetic results', () => {
  const { landUseRows } = require('./result-view.js')
  const run = (year, demo = false) => ({
    input: { layer: { year }, demo },
    result: { basins: [{ basin: 'A' }, { basin: 'B' }] },
  })
  const layers = [{ basin: 'A', year: 2021 }, { basin: 'B', year: 2022 }]
  assert.deepEqual(landUseRows([run(2021), run(2021), run(2022, true)], layers),
    [{ basin: 'A', year: 2021 }])
})
