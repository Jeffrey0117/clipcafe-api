const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createSlugRegistry } = require('../src/slug-registry')

test('remembers slugs that were added', () => {
  const registry = createSlugRegistry()
  registry.add('some-clip')
  assert.equal(registry.has('some-clip'), true)
  assert.equal(registry.has('other-clip'), false)
})

test('ignores values that are not usable slugs', () => {
  const registry = createSlugRegistry()
  for (const bad of [undefined, null, 42, '', '../etc/passwd', 'UPPER', 'a b']) {
    registry.add(bad)
    assert.equal(registry.has(bad), false)
  }
})

test('forgets the oldest slugs once it is full', () => {
  const registry = createSlugRegistry({ max: 2 })
  registry.add('clip-1')
  registry.add('clip-2')
  registry.add('clip-3')
  assert.equal(registry.has('clip-1'), false)
  assert.equal(registry.has('clip-2'), true)
  assert.equal(registry.has('clip-3'), true)
})

test('re-adding a slug keeps it fresh', () => {
  const registry = createSlugRegistry({ max: 2 })
  registry.add('clip-1')
  registry.add('clip-2')
  registry.add('clip-1')
  registry.add('clip-3')
  assert.equal(registry.has('clip-1'), true)
  assert.equal(registry.has('clip-2'), false)
})
