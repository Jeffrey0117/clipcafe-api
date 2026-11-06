const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createCache } = require('../src/cache')

test('returns stored value before ttl expires', () => {
  let clock = 1000
  const cache = createCache({ ttlMs: 500, now: () => clock })
  cache.set('k', { a: 1 })
  clock = 1499
  assert.deepEqual(cache.get('k'), { a: 1 })
})

test('returns undefined after ttl expires', () => {
  let clock = 1000
  const cache = createCache({ ttlMs: 500, now: () => clock })
  cache.set('k', { a: 1 })
  clock = 1501
  assert.equal(cache.get('k'), undefined)
})

test('returns undefined for unknown key', () => {
  const cache = createCache({ ttlMs: 500 })
  assert.equal(cache.get('nope'), undefined)
})

test('get refreshes recency so hot keys survive eviction', () => {
  let clock = 1000
  const cache = createCache({ ttlMs: 500, maxEntries: 2, now: () => clock })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.get('a')
  cache.set('c', 3)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('b'), undefined)
})

test('stored values are deep-frozen', () => {
  const cache = createCache({ ttlMs: 500 })
  cache.set('k', { results: [{ slug: 'x' }] })
  const value = cache.get('k')
  assert.ok(Object.isFrozen(value))
  assert.ok(Object.isFrozen(value.results))
  assert.ok(Object.isFrozen(value.results[0]))
})

test('createCache rejects non-finite ttlMs', () => {
  assert.throws(() => createCache({ ttlMs: Number.NaN }))
  assert.throws(() => createCache({}))
})

test('evicts oldest entry beyond maxEntries', () => {
  let clock = 1000
  const cache = createCache({ ttlMs: 500, maxEntries: 2, now: () => clock })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.set('c', 3)
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('b'), 2)
  assert.equal(cache.get('c'), 3)
})
