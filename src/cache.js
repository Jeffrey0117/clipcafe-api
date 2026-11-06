function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
  }
  return value
}

function createCache({ ttlMs, maxEntries = 500, now = Date.now } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error(`ttlMs must be a non-negative finite number, got ${ttlMs}`)
  }

  const entries = new Map()

  function get(key) {
    const entry = entries.get(key)
    if (!entry) return undefined
    if (now() - entry.storedAt > ttlMs) {
      entries.delete(key)
      return undefined
    }
    entries.delete(key)
    entries.set(key, entry)
    return entry.value
  }

  function set(key, value) {
    if (entries.size >= maxEntries && !entries.has(key)) {
      const leastRecentKey = entries.keys().next().value
      entries.delete(leastRecentKey)
    }
    entries.set(key, { value: deepFreeze(value), storedAt: now() })
  }

  return { get, set }
}

module.exports = { createCache }
