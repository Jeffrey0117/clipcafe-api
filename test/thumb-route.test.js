const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createApp } = require('../src/app')
const { createCache } = require('../src/cache')

const raw = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'phrasefind.json'), 'utf8')
)
const KNOWN_SLUG = raw.results[0].slug

function thumbError(code) {
  return Object.assign(new Error(code), { code })
}

// 假的縮圖服務:真的寫一個小檔讓 sendFile 有東西可送
function fakeThumbs({ failWith } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipcafe-route-'))
  const calls = []
  return {
    calls,
    async get(slug, { generate }) {
      calls.push({ slug, generate })
      if (failWith) throw thumbError(failWith)
      if (!generate) throw thumbError('not_found')
      const file = path.join(dir, `${slug}.jpg`)
      fs.writeFileSync(file, 'jpeg-bytes')
      return file
    }
  }
}

function startApp({ thumbs } = {}) {
  const app = createApp({
    searchUpstream: async () => raw,
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

test('GET /api/thumb/:slug rejects an invalid slug', async () => {
  const thumbs = fakeThumbs()
  const { base, close } = await startApp({ thumbs })
  try {
    const res = await fetch(`${base}/api/thumb/Bad_Slug!`)
    assert.equal(res.status, 400)
    assert.equal(thumbs.calls.length, 0)
  } finally {
    close()
  }
})

test('GET /api/thumb/:slug returns 503 when thumbnails are not available', async () => {
  const { base, close } = await startApp()
  try {
    const res = await fetch(`${base}/api/thumb/${KNOWN_SLUG}`)
    assert.equal(res.status, 503)
    assert.equal((await res.json()).success, false)
  } finally {
    close()
  }
})

test('a slug that never appeared in search results is not generated', async () => {
  const thumbs = fakeThumbs()
  const { base, close } = await startApp({ thumbs })
  try {
    const res = await fetch(`${base}/api/thumb/never-seen-clip`)
    assert.equal(res.status, 404)
    assert.deepEqual(thumbs.calls, [{ slug: 'never-seen-clip', generate: false }])
  } finally {
    close()
  }
})

test('a slug returned by a search gets a cacheable jpeg', async () => {
  const thumbs = fakeThumbs()
  const { base, close } = await startApp({ thumbs })
  try {
    await fetch(`${base}/api/search?q=get+a+life`)
    const res = await fetch(`${base}/api/thumb/${KNOWN_SLUG}`)

    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/jpeg')
    assert.match(res.headers.get('cache-control'), /immutable/)
    assert.equal(await res.text(), 'jpeg-bytes')
    assert.deepEqual(thumbs.calls, [{ slug: KNOWN_SLUG, generate: true }])
  } finally {
    close()
  }
})

test('search results served from the cache still count as known slugs', async () => {
  const thumbs = fakeThumbs()
  const { base, close } = await startApp({ thumbs })
  try {
    await fetch(`${base}/api/search?q=get+a+life`)
    await fetch(`${base}/api/search?q=get+a+life`)
    const res = await fetch(`${base}/api/thumb/${KNOWN_SLUG}`)
    assert.equal(res.status, 200)
  } finally {
    close()
  }
})

test('a busy thumbnail queue returns 503 with Retry-After and is not cached', async () => {
  const thumbs = fakeThumbs({ failWith: 'busy' })
  const { base, close } = await startApp({ thumbs })
  try {
    const res = await fetch(`${base}/api/thumb/${KNOWN_SLUG}`)
    assert.equal(res.status, 503)
    assert.ok(res.headers.get('retry-after'))
    assert.equal(res.headers.get('cache-control'), 'no-store')
  } finally {
    close()
  }
})

test('a failed extraction returns 502 and is not cached', async () => {
  const thumbs = fakeThumbs({ failWith: 'failed' })
  const { base, close } = await startApp({ thumbs })
  try {
    const res = await fetch(`${base}/api/thumb/${KNOWN_SLUG}`)
    assert.equal(res.status, 502)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  } finally {
    close()
  }
})

test('an unexpected thumbnail error returns 500 without leaking details', async () => {
  const thumbs = {
    async get() {
      throw new Error('C:\\secret\\path exploded')
    }
  }
  const { base, close } = await startApp({ thumbs })
  try {
    const res = await fetch(`${base}/api/thumb/${KNOWN_SLUG}`)
    assert.equal(res.status, 500)
    assert.ok(!(await res.text()).includes('secret'))
  } finally {
    close()
  }
})
