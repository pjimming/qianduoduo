import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const techMap = JSON.parse(
  readFileSync(new URL('../src/data/techmap.json', import.meta.url), 'utf8'),
)

test('tech map keeps the published snapshot shape', () => {
  const subs = techMap.groups.flatMap((group) => group.subs)
  const leaves = subs.flatMap((sub) => sub.leaves)
  const companies = new Set(leaves.flatMap((leaf) => leaf.cos.map((company) => company.c)))

  assert.equal(techMap.date, '2026-09-16')
  assert.equal(techMap.groups.length, 8)
  assert.equal(subs.length, 40)
  assert.equal(leaves.length, 156)
  assert.equal(companies.size, 750)
})

test('tech map companies keep a name and six-digit A-share code', () => {
  for (const group of techMap.groups) {
    assert.ok(group.id)
    assert.ok(group.name)
    assert.ok(group.desc)
    assert.ok(techMap.colors[group.id])

    for (const sub of group.subs) {
      assert.ok(sub.name)
      assert.ok(sub.leaves.length > 0)

      for (const leaf of sub.leaves) {
        assert.ok(leaf.name)
        assert.ok(leaf.cos.length > 0)
        for (const company of leaf.cos) {
          assert.ok(company.n)
          assert.match(company.c, /^\d{6}$/)
        }
      }
    }
  }
})

test('tech map leaf names are unique for stable Vue keys', () => {
  const names = techMap.groups
    .flatMap((group) => group.subs)
    .flatMap((sub) => sub.leaves.map((leaf) => leaf.name))

  assert.equal(new Set(names).size, names.length)
})
