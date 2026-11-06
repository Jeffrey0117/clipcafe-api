const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')

const { createApp } = require('../src/app')
const { createCache } = require('../src/cache')

function startApp(thumbs) {
  const app = createApp({
    searchUpstream: async () => ({ results: [] }),
    cache: createCache({ ttlMs: 60000 }),
    thumbs
  })
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}`
      resolve({ base, close: () => server.close() })
    })
  })
}

test('a thumbnail file that vanished before sending is not served as a cacheable jpeg', async () => {
  const thumbs = {
    async get() {
      return path.join(os.tmpdir(), 'clipcafe-missing-dir', 'gone-clip.jpg')
    }
  }
  const { base, close } = await startApp(thumbs)
  try {
    const res = await fetch(`${base}/api/thumb/gone-clip`)
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(res.headers.get('content-type'), /application\/json/)
    assert.equal((await res.json()).success, false)
  } finally {
    close()
  }
})

test('an unexpected error is never sent with image or long-cache headers', async () => {
  const thumbs = {
    async get() {
      throw new Error('boom')
    }
  }
  const { base, close } = await startApp(thumbs)
  try {
    const res = await fetch(`${base}/api/thumb/some-clip`)
    assert.equal(res.status, 500)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(res.headers.get('content-type'), /application\/json/)
  } finally {
    close()
  }
})
