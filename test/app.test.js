const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { createApp } = require('../src/app')
const { createCache } = require('../src/cache')

const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'phrasefind.json'), 'utf8')
)

function startApp(overrides = {}) {
  const calls = []
  const app = createApp({
    searchUpstream: async (params) => {
      calls.push(params)
      return raw
    },
    cache: createCache({ ttlMs: 60000 }),
    ...overrides
  })
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}`
      resolve({ base, calls, close: () => server.close() })
    })
  })
}

test('GET /api/search returns normalized payload', async () => {
  const { base, close } = await startApp()
  try {
    const res = await fetch(`${base}/api/search?q=get+a+life`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.success, true)
    assert.equal(body.data.total, 10780)
    assert.equal(body.data.results[0].slug, 'you-said-get-a-life')
    assert.equal(
      body.data.results[0].mp4,
      'https://clip.cafe/videos/you-said-get-a-life.mp4'
    )
  } finally {
    close()
  }
})

test('GET /api/search without q returns 400', async () => {
  const { base, close } = await startApp()
  try {
    const res = await fetch(`${base}/api/search`)
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.success, false)
    assert.ok(body.error)
  } finally {
    close()
  }
})

test('GET /api/search passes sanitized paging params upstream', async () => {
  const { base, calls, close } = await startApp()
  try {
    await fetch(`${base}/api/search?q=hello&from=30&size=9999&slop=2`)
    assert.deepEqual(calls[0], { q: 'hello', from: 30, size: 90, slop: 2 })
  } finally {
    close()
  }
})

test('GET /api/search serves repeat query from cache', async () => {
  const { base, calls, close } = await startApp()
  try {
    await fetch(`${base}/api/search?q=hello`)
    await fetch(`${base}/api/search?q=hello`)
    assert.equal(calls.length, 1)
  } finally {
    close()
  }
})

test('GET /api/search returns 502 when upstream fails', async () => {
  const { base, close } = await startApp({
    searchUpstream: async () => {
      throw new Error('boom')
    }
  })
  try {
    const res = await fetch(`${base}/api/search?q=hello`)
    assert.equal(res.status, 502)
    const body = await res.json()
    assert.equal(body.success, false)
  } finally {
    close()
  }
})

test('GET /api/video/:slug redirects to clip.cafe mp4', async () => {
  const { base, close } = await startApp()
  try {
    const res = await fetch(`${base}/api/video/i-have-to-get-a-life`, {
      redirect: 'manual'
    })
    assert.equal(res.status, 302)
    assert.equal(
      res.headers.get('location'),
      'https://clip.cafe/videos/i-have-to-get-a-life.mp4'
    )
  } finally {
    close()
  }
})

test('GET /api/video/:slug rejects invalid slug', async () => {
  const { base, close } = await startApp()
  try {
    const res = await fetch(`${base}/api/video/..%5Cetc`, {
      redirect: 'manual'
    })
    assert.equal(res.status, 400)
  } finally {
    close()
  }
})

test('GET /api/video/:slug rejects uppercase slug', async () => {
  const { base, close } = await startApp()
  try {
    const res = await fetch(`${base}/api/video/ABC-def`, {
      redirect: 'manual'
    })
    assert.equal(res.status, 400)
  } finally {
    close()
  }
})

test('GET /api/search with duplicate q params uses the first value', async () => {
  const { base, calls, close } = await startApp()
  try {
    const res = await fetch(`${base}/api/search?q=alpha&q=beta`)
    assert.equal(res.status, 200)
    assert.equal(calls[0].q, 'alpha')
  } finally {
    close()
  }
})

test('GET /api/search clamps from to upstream pagination limit', async () => {
  const { base, calls, close } = await startApp()
  try {
    await fetch(`${base}/api/search?q=hello&from=99999999999999`)
    assert.equal(calls[0].from, 9910)
  } finally {
    close()
  }
})

test('unknown route returns JSON 404', async () => {
  const { base, close } = await startApp()
  try {
    const res = await fetch(`${base}/api/nope`)
    assert.equal(res.status, 404)
    assert.match(res.headers.get('content-type'), /application\/json/)
    const body = await res.json()
    assert.equal(body.success, false)
  } finally {
    close()
  }
})

test('upstream timeout returns 504', async () => {
  const { base, close } = await startApp({
    searchUpstream: async () => {
      const err = new Error('timed out')
      err.name = 'TimeoutError'
      throw err
    }
  })
  try {
    const res = await fetch(`${base}/api/search?q=hello`)
    assert.equal(res.status, 504)
  } finally {
    close()
  }
})

test('concurrent identical queries hit upstream once', async () => {
  const calls = []
  const { base, close } = await startApp({
    searchUpstream: async (params) => {
      calls.push(params)
      await new Promise((resolve) => setTimeout(resolve, 50))
      return raw
    }
  })
  try {
    await Promise.all([
      fetch(`${base}/api/search?q=hello`),
      fetch(`${base}/api/search?q=hello`)
    ])
    assert.equal(calls.length, 1)
  } finally {
    close()
  }
})

test('responses do not expose x-powered-by', async () => {
  const { base, close } = await startApp()
  try {
    const res = await fetch(`${base}/api/search?q=hello`)
    assert.equal(res.headers.get('x-powered-by'), null)
  } finally {
    close()
  }
})
